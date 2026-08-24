#!/usr/bin/env python3
import json, os, pathlib, signal, subprocess, tempfile, time, urllib.error, urllib.request, urllib.parse

ROOT = pathlib.Path(__file__).resolve().parents[1]
BIN = ROOT / "media-api-subtitle-test"
subprocess.run(["gcc", "-O2", "-Wall", "-Wextra", "-Werror", "-pthread", "-o", str(BIN), str(ROOT / "media-api.c")], check=True)

def request(method, path, body=None, raw=False):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request("http://127.0.0.1:9100" + path, data=data, method=method)
    if data: req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=5) as res:
            content = res.read()
            return res.status, dict(res.headers), (content if raw else json.loads(content or b"{}"))
    except urllib.error.HTTPError as err:
        content = err.read()
        return err.code, dict(err.headers), (content if raw else json.loads(content or b"{}"))

with tempfile.TemporaryDirectory(prefix="vaulthub-subtitle-test-", dir="/opt/data") as td:
    root = pathlib.Path(td)
    library = root / "movies"
    library.mkdir()
    video = library / "Movie.Name.2024.mkv"
    video.write_bytes(b"fake-video")
    sub = library / "Movie.Name.2024.zh.srt"
    sub.write_text("1\n00:00:01,000 --> 00:00:03,000\n你好 VaultHub\n", encoding="utf-8")
    other = library / "Other.zh.srt"
    other.write_text("1\n00:00:01,000 --> 00:00:02,000\nwrong\n", encoding="utf-8")
    env = os.environ | {"MEDIA_CONFIG": str(root / "libraries.json"), "MEDIA_INDEX_DIR": str(root / "indexes"), "MEDIA_SCAN_SLEEP_MS": "0"}
    proc = subprocess.Popen([str(BIN)], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    try:
        for _ in range(50):
            try:
                if request("GET", "/healthz")[0] == 200: break
            except Exception: time.sleep(.05)
        status, _, payload = request("POST", "/api/media/libraries", {"id":"movies", "name":"Movies", "type":"movie", "path":str(library)})
        assert status == 201, (status, payload)
        encoded_video = urllib.parse.quote(video.name, safe="")
        status, _, listing = request("GET", f"/api/media/subtitles?id=movies&path={encoded_video}")
        assert status == 200, (status, listing)
        names = [item["name"] for item in listing["subtitles"]]
        assert names == ["Movie.Name.2024.zh.srt"], names
        encoded_sub = urllib.parse.quote(sub.name, safe="")
        status, headers, payload = request("GET", f"/api/media/subtitle?id=movies&path={encoded_sub}", raw=True)
        assert status == 200, (status, payload)
        assert headers.get("Content-Type", "").startswith("text/vtt"), headers
        text = payload.decode("utf-8")
        assert text.startswith("WEBVTT"), text
        assert "00:00:01.000 --> 00:00:03.000" in text, text
        status, _, err = request("GET", f"/api/media/subtitle?id=movies&path={encoded_video}")
        assert status == 400 and "unsupported subtitle" in err["error"], err
        print("PASS: subtitle discovery and SRT-to-VTT serving work")
    finally:
        proc.send_signal(signal.SIGTERM)
        try: proc.wait(timeout=2)
        except subprocess.TimeoutExpired: proc.kill()
        BIN.unlink(missing_ok=True)
