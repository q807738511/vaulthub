#!/usr/bin/env python3
import json, os, pathlib, signal, subprocess, tempfile, time, urllib.error, urllib.request, urllib.parse

ROOT = pathlib.Path(__file__).resolve().parents[1]
BIN = ROOT / "media-api-movie-test"
subprocess.run(["gcc", "-O2", "-Wall", "-Wextra", "-Werror", "-pthread", "-o", str(BIN), str(ROOT / "media-api.c")], check=True)

def request(method, path, body=None, raw=False, headers=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request("http://127.0.0.1:9100" + path, data=data, method=method)
    if data: req.add_header("Content-Type", "application/json")
    for k, v in (headers or {}).items(): req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=5) as res:
            content = res.read()
            return res.status, dict(res.headers), (content if raw else json.loads(content or b"{}"))
    except urllib.error.HTTPError as err:
        content = err.read()
        return err.code, dict(err.headers), (content if raw else json.loads(content or b"{}"))

with tempfile.TemporaryDirectory(prefix="vaulthub-movie-test-", dir="/opt/data") as td:
    root = pathlib.Path(td)
    library = root / "movies"
    library.mkdir()
    video = library / "流浪地球.2019.mkv"
    video.write_bytes(b"0123456789abcdef")
    (library / "电影海报.jpg").write_bytes(b"not-a-video-but-scanned")
    env = os.environ | {
        "MEDIA_CONFIG": str(root / "libraries.json"),
        "MEDIA_INDEX_DIR": str(root / "indexes"),
        "MEDIA_SCAN_SLEEP_MS": "0",
    }
    env.pop("TMDB_API_KEY", None)
    proc = subprocess.Popen([str(BIN)], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    try:
        for _ in range(50):
            try:
                if request("GET", "/healthz")[0] == 200: break
            except Exception: time.sleep(.05)
        status, _, payload = request("POST", "/api/media/libraries", {"id":"movies", "name":"Movies", "type":"movie", "path":str(library)})
        assert status == 201, (status, payload)
        deadline = time.time() + 8
        page = None
        while time.time() < deadline:
            status, _, page = request("GET", "/api/media/files?id=movies&offset=0&limit=50")
            if status == 200 and page.get("total") == 2: break
            time.sleep(.1)
        assert status == 200 and page["total"] == 2, (status, page)
        encoded = urllib.parse.quote(video.name, safe="")
        status, hdrs, payload = request("GET", f"/api/media/file?id=movies&path={encoded}", raw=True, headers={"Range":"bytes=0-3"})
        assert status == 206, (status, hdrs, payload)
        assert payload == b"0123", payload
        assert hdrs.get("Content-Type") == "video/x-matroska", hdrs
        status, _, scrapers = request("GET", "/api/media/scrapers")
        assert status == 200 and scrapers["default"] == "douban" and scrapers["tmdb_enabled"] is False, scrapers
        status, _, err = request("GET", "/api/media/tmdb?query=%E6%B5%8B%E8%AF%95")
        assert status == 400 and "TMDB_API_KEY" in err["error"], err
        print("PASS: movie library type, video serving, range requests, and scraper gating work")
    finally:
        proc.send_signal(signal.SIGTERM)
        try: proc.wait(timeout=2)
        except subprocess.TimeoutExpired: proc.kill()
        BIN.unlink(missing_ok=True)
