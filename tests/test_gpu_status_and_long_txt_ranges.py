import json
import os
import socket
import subprocess
import tempfile
import time
from pathlib import Path
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
    raise RuntimeError(f"port {port} did not open")


def read_url(url, headers=None, timeout=30):
    with urlopen(Request(url, headers=headers or {}), timeout=timeout) as response:
        return response.status, dict(response.headers), response.read()


with tempfile.TemporaryDirectory() as tmp_name:
    tmp = Path(tmp_name)
    media = tmp / "media"
    media.mkdir()
    # More than three 1 MiB chunks; unique trailer proves the last chunk is delivered.
    trailer = b"\nEND-OF-VAULTHUB-LONG-TEXT\n"
    text = media / "long.txt"
    text.write_bytes((b"0123456789abcdef" * 230_000) + trailer)
    config = tmp / "libraries.json"
    config.write_text(json.dumps([{"id": "books", "name": "Books", "type": "book", "path": str(media)}]), encoding="utf-8")
    binary = tmp / "media-api"
    subprocess.check_call(["gcc", "-O2", "-pthread", str(ROOT / "tests" / "fixtures" / "media-api_legacy.c"), "-o", str(binary)])
    env = os.environ.copy()
    env.update({
        "MEDIA_CONFIG": str(config),
        "MEDIA_INDEX_DIR": str(tmp / "index"),
        "MEDIA_SCAN_SLEEP_MS": "0",
        "FFMPEG_HWACCEL": "auto",
        "VAAPI_DEVICE": str(tmp / "missing-render-device"),
        "NVIDIA_VISIBLE_DEVICES": "none",
    })
    proc = subprocess.Popen([str(binary)], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        wait_port(9100)
        status, _, body = read_url("http://127.0.0.1:9100/api/media/hardware?hw=auto")
        data = json.loads(body)
        assert status == 200
        assert data["configured"] == "auto", data
        assert data["selected"] == "cpu", data
        assert data["available"]["cpu"] is True, data

        status, headers, first = read_url(
            "http://127.0.0.1:9100/api/media/file?id=books&path=long.txt",
            {"Range": "bytes=0-1048575"},
        )
        assert status == 206, status
        assert headers.get("Content-Range", "").startswith("bytes 0-1048575/"), headers
        total = int(headers["Content-Range"].split("/")[-1])
        chunks = [first]
        offset = len(first)
        while offset < total:
            end = min(total - 1, offset + 1048576 - 1)
            status, _, body = read_url(
                "http://127.0.0.1:9100/api/media/file?id=books&path=long.txt",
                {"Range": f"bytes={offset}-{end}"},
            )
            assert status == 206
            chunks.append(body)
            offset += len(body)
        combined = b"".join(chunks)
        assert len(combined) == text.stat().st_size
        assert combined.endswith(trailer)
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=2)
        except subprocess.TimeoutExpired:
            proc.kill()

print("PASS: hardware status safely falls back to CPU and long TXT ranges reconstruct the complete file")
