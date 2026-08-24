import json
import os
import socket
import subprocess
import tempfile
import threading
import time
from pathlib import Path
from urllib.request import urlopen

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


with tempfile.TemporaryDirectory() as tmp:
    tmp = Path(tmp)
    media = tmp / "media"
    media.mkdir()
    index = tmp / "index"
    cache = tmp / "cache"
    index.mkdir()
    cache.mkdir()
    video = media / "Long.2024.mp4"
    subprocess.check_call([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "testsrc=size=1920x1080:rate=24",
        "-f", "lavfi", "-i", "sine=frequency=1000:sample_rate=48000",
        "-t", "8", "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", str(video),
    ])
    config = tmp / "libraries.json"
    config.write_text(json.dumps([{"id": "movies", "name": "Movies", "type": "movie", "path": str(media)}]), encoding="utf-8")
    subprocess.check_call(["gcc", "-O2", "-pthread", str(ROOT / "media-api.c"), "-o", str(tmp / "media-api")])
    env = os.environ.copy()
    env.update({
        "MEDIA_CONFIG": str(config),
        "MEDIA_INDEX_DIR": str(index),
        "TRANSCODE_CACHE_DIR": str(cache),
        "MEDIA_SCAN_SLEEP_MS": "0",
        "SYSTEM_MONITOR_FILESYSTEMS": "",
    })
    proc = subprocess.Popen([str(tmp / "media-api")], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        wait_port(9100)
        result = {}

        def transcode():
            start = time.time()
            with urlopen("http://127.0.0.1:9100/api/media/transcode?id=movies&path=Long.2024.mp4&quality=720p", timeout=60) as r:
                head = r.read(64)
                result.update(status=r.status, ctype=r.headers.get("Content-Type"), head=head, sec=time.time() - start)

        worker = threading.Thread(target=transcode)
        worker.start()
        time.sleep(0.2)
        quick_times = []
        for url in ["http://127.0.0.1:9100/api/system/metrics", "http://127.0.0.1:9100/api/media/libraries"] * 5:
            start = time.time()
            with urlopen(url, timeout=2) as r:
                assert r.status == 200
                r.read(80)
            quick_times.append(time.time() - start)
        worker.join(timeout=60)
        assert result.get("status") == 200, result
        assert result.get("ctype") == "video/mp4", result
        assert result.get("head", b"").startswith(b"\x00\x00\x00"), result
        assert max(quick_times) < 2.0, quick_times
        deadline = time.time() + 60
        while time.time() < deadline and not list(cache.glob("*.mp4")):
            time.sleep(0.1)
        assert list(cache.glob("*.mp4")), "transcode cache file should be created"
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=2)
        except subprocess.TimeoutExpired:
            proc.kill()

print("PASS: media-api serves metrics/libraries while a first-time transcode is running")
