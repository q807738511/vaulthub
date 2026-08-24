import json
import os
import socket
import subprocess
import tempfile
import time
from pathlib import Path
from urllib.error import HTTPError
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
    # 文件不需要是真视频；invalid quality 在真正 ffmpeg 前就会返回 400。
    (media / "Demo.2024.mkv").write_bytes(b"not-a-real-video")
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
        # 新增库重复 POST 可触发索引，这里直接手动写入索引避免等待扫描线程。
        index.mkdir(exist_ok=True)
        (index / "movies.idx").write_text("Demo.2024.mkv\t16\t1\n", encoding="utf-8")
        bad = "http://127.0.0.1:9100/api/media/transcode?id=movies&path=Demo.2024.mkv&quality=4k"
        try:
            urlopen(bad, timeout=3).read()
            raise AssertionError("invalid quality should fail")
        except HTTPError as e:
            assert e.code == 400, e.code
            body = e.read().decode("utf-8")
            assert "invalid quality" in body
        # HEAD 方法应被路由接受；伪视频会进入 ffmpeg 并失败，而不是 method not allowed。
        req = __import__("urllib.request").request.Request("http://127.0.0.1:9100/api/media/transcode?id=movies&path=Demo.2024.mkv&quality=720p", method="HEAD")
        try:
            urlopen(req, timeout=5).read()
        except HTTPError as e:
            assert e.code == 500, e.code
            assert cache.exists(), "cache dir should be created before ffmpeg runs"
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=2)
        except subprocess.TimeoutExpired:
            proc.kill()

print("PASS: transcode quality validation and cache directory behavior work")
