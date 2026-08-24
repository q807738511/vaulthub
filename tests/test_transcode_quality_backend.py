import json
import os
import socket
import subprocess
import tempfile
import time
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]


def wait_port(port, timeout=5):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.2):
                return
        except OSError:
            time.sleep(0.05)
    raise RuntimeError("server did not start")


def read_url(url, headers=None, timeout=30):
    req = Request(url, headers=headers or {})
    with urlopen(req, timeout=timeout) as r:
        data = r.read(512)
        return r.status, dict(r.headers), data


with tempfile.TemporaryDirectory() as tmp:
    tmp = Path(tmp)
    media = tmp / "media"
    media.mkdir()
    video = media / "Demo.2024.mp4"
    subprocess.check_call([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "testsrc=size=1280x720:rate=24",
        "-f", "lavfi", "-i", "sine=frequency=1000:sample_rate=48000",
        "-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", str(video),
    ])
    config = tmp / "libraries.json"
    config.write_text(json.dumps([{"id": "movies", "name": "Movies", "type": "movie", "path": str(media)}]), encoding="utf-8")
    index = tmp / "index"
    cache = tmp / "transcode-cache"
    env = os.environ.copy()
    env.update({"MEDIA_CONFIG": str(config), "MEDIA_INDEX_DIR": str(index), "TRANSCODE_CACHE_DIR": str(cache), "MEDIA_SCAN_SLEEP_MS": "0"})
    subprocess.check_call(["gcc", "-O2", "-pthread", str(ROOT / "media-api.c"), "-o", str(tmp / "media-api")])
    proc = subprocess.Popen([str(tmp / "media-api")], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        wait_port(9100)
        bad = "http://127.0.0.1:9100/api/media/transcode?id=movies&path=Demo.2024.mp4&quality=4k"
        try:
            urlopen(bad, timeout=3).read()
            raise AssertionError("invalid quality should fail")
        except HTTPError as e:
            assert e.code == 400, e.code
            assert "invalid quality" in e.read().decode("utf-8")

        status, headers, data = read_url("http://127.0.0.1:9100/api/media/file?id=movies&path=Demo.2024.mp4", {"Range": "bytes=0-4095"})
        assert status == 206, status
        assert headers.get("Content-Type") == "video/mp4"
        assert data.startswith(b"\x00\x00\x00")

        status, headers, data = read_url("http://127.0.0.1:9100/api/media/transcode?id=movies&path=Demo.2024.mp4&quality=720p")
        assert status == 200, status
        assert headers.get("Content-Type") == "video/mp4"
        assert headers.get("X-VaultHub-Transcode-Cache") == "MISS", headers
        assert "Content-Length" not in headers, headers
        assert data.startswith(b"\x00\x00\x00")

        status, headers, data = read_url("http://127.0.0.1:9100/api/media/transcode?id=movies&path=Demo.2024.mp4&quality=480p")
        assert status == 200, status
        assert headers.get("Content-Type") == "video/mp4"
        assert data.startswith(b"\x00\x00\x00")

        status, headers, data = read_url("http://127.0.0.1:9100/api/media/transcode?id=movies&path=Demo.2024.mp4&quality=720p", {"Range": "bytes=0-4095"})
        assert status == 206, status
        assert headers.get("Content-Range", "").startswith("bytes 0-4095/"), headers
        assert data.startswith(b"\x00\x00\x00")
        assert len(list(cache.glob("*.mp4"))) >= 2, list(cache.glob("*"))
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=2)
        except subprocess.TimeoutExpired:
            proc.kill()

print("PASS: transcode quality validation, real 720p/480p playback streams, range, and cache files work")
