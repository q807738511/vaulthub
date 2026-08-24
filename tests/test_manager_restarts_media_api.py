import os
import socket
import subprocess
import tempfile
import time
from pathlib import Path
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]


def wait_http(url, timeout=5):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        try:
            with urlopen(url, timeout=0.4) as r:
                return r.status, r.read()
        except Exception as e:
            last = e
            time.sleep(0.05)
    raise RuntimeError(f"{url} did not become ready: {last}")


with tempfile.TemporaryDirectory() as tmp:
    tmp = Path(tmp)
    subprocess.check_call(["gcc", "-O2", "-pthread", str(ROOT / "media-api.c"), "-o", str(tmp / "real-media-api")])
    subprocess.check_call(["gcc", "-O2", "-pthread", str(ROOT / "vaulthub-manager.c"), "-o", str(tmp / "manager")])

    media_wrapper = tmp / "media-wrapper.sh"
    marker = tmp / "first-run-done"
    media_wrapper.write_text(f"""#!/bin/sh
if [ ! -f {marker} ]; then
  touch {marker}
  exit 17
fi
exec {tmp / 'real-media-api'}
""", encoding="utf-8")
    media_wrapper.chmod(0o755)

    caddy_fake = tmp / "caddy-fake.sh"
    caddy_fake.write_text("""#!/bin/sh
if [ "$1" = "validate" ] || [ "$1" = "reload" ]; then exit 0; fi
while :; do sleep 1; done
""", encoding="utf-8")
    caddy_fake.chmod(0o755)

    data = tmp / "data"
    data.mkdir()
    (data / "Caddyfile").write_text(":8088 {\n\thandle /api/admin/* {\n\t\treverse_proxy http://127.0.0.1:9099\n\t}\n}\n", encoding="utf-8")
    config = tmp / "libraries.json"
    config.write_text("[]\n", encoding="utf-8")

    env = os.environ.copy()
    env.update({
        "MEDIA_API_BIN": str(media_wrapper),
        "CADDY_BIN": str(caddy_fake),
        "CADDY_DATA_CONFIG": str(data / "Caddyfile"),
        "CADDY_DEFAULT_CONFIG": str(data / "Caddyfile"),
        "MEDIA_CONFIG": str(config),
        "MEDIA_INDEX_DIR": str(tmp / "index"),
        "TRANSCODE_CACHE_DIR": str(tmp / "cache"),
    })
    proc = subprocess.Popen([str(tmp / "manager")], cwd=str(tmp), env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        status, body = wait_http("http://127.0.0.1:9100/healthz", timeout=5)
        assert status == 200, status
        assert body == b"ok"
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=2)
        except subprocess.TimeoutExpired:
            proc.kill()

print("PASS: manager restarts media-api after child exit so 9100 returns")
