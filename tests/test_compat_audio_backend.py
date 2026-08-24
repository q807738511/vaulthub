import json
import os
import socket
import subprocess
import tempfile
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
    raise RuntimeError(f"port {port} did not open")


def read_url(url, timeout=30):
    with urlopen(url, timeout=timeout) as r:
        return r.status, dict(r.headers), r.read(512)

with tempfile.TemporaryDirectory() as tmp:
    tmp = Path(tmp)
    media = tmp / "media"
    media.mkdir()
    video = media / "Demo.AC3.mkv"
    subprocess.check_call([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "testsrc=size=640x360:rate=24",
        "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000",
        "-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "ac3", str(video),
    ])
    config = tmp / "libraries.json"
    config.write_text(json.dumps([{"id": "movies", "name": "Movies", "type": "movie", "path": str(media)}]), encoding="utf-8")
    env = os.environ.copy()
    env.update({"MEDIA_CONFIG": str(config), "MEDIA_INDEX_DIR": str(tmp / "index"), "MEDIA_SCAN_SLEEP_MS": "0"})
    subprocess.check_call(["gcc", "-O2", "-pthread", str(ROOT / "media-api.c"), "-o", str(tmp / "media-api")])
    proc = subprocess.Popen([str(tmp / "media-api")], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        wait_port(9100)
        status, headers, body = read_url("http://127.0.0.1:9100/api/media/probe?id=movies&path=Demo.AC3.mkv")
        assert status == 200, status
        probe = json.loads(body.decode("utf-8"))
        assert probe["audio_codec"] == "ac3", probe
        assert probe["compat_recommended"] is True, probe

        status, headers, body = read_url("http://127.0.0.1:9100/api/media/compat?id=movies&path=Demo.AC3.mkv", timeout=45)
        assert status == 200, status
        assert headers.get("Content-Type") == "video/mp4", headers
        assert headers.get("X-VaultHub-Compat") == "audio-aac", headers
        assert body.startswith(b"\x00\x00\x00") and b"ftyp" in body[:32], body[:64]
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=2)
        except subprocess.TimeoutExpired:
            proc.kill()

print("PASS: media compat probe detects AC3 and serves H.264/AAC MP4 compatibility stream")
