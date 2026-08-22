#!/usr/bin/env python3
import json, os, pathlib, signal, subprocess, tempfile, time, urllib.error, urllib.request, urllib.parse

ROOT = pathlib.Path(__file__).resolve().parents[1]
BIN = ROOT / "media-api-test"
subprocess.run(["gcc", "-O2", "-Wall", "-Wextra", "-Werror", "-pthread", "-o", str(BIN), str(ROOT / "media-api.c")], check=True)

def request(method, path, body=None, raw=False):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request("http://127.0.0.1:9100" + path, data=data, method=method)
    if data: req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=5) as res:
            content = res.read()
            return res.status, (content if raw else json.loads(content or b"{}"))
    except urllib.error.HTTPError as err:
        content = err.read()
        return err.code, (content if raw else json.loads(content or b"{}"))

with tempfile.TemporaryDirectory(prefix="vaulthub-media-test-", dir="/opt/data") as td:
    root = pathlib.Path(td)
    library = root / "mapped-books"
    library.mkdir()
    for i in range(250):
        (library / f"book-{i:03}.txt").write_text(f"book {i}\n", encoding="utf-8")
    special = library / "《白妇谱》（未删节全本）#特别?版.epub"
    special.write_bytes(b"special-ebook-content")
    env = os.environ | {
        "MEDIA_CONFIG": str(root / "libraries.json"),
        "MEDIA_INDEX_DIR": str(root / "indexes"),
        "MEDIA_SCAN_SLEEP_MS": "0",
    }
    proc = subprocess.Popen([str(BIN)], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    try:
        for _ in range(50):
            try:
                if request("GET", "/healthz")[0] == 200: break
            except Exception: time.sleep(.05)
        status, _ = request("POST", "/api/media/libraries", {
            "id": "books", "name": "Books", "type": "book", "path": str(library)
        })
        assert status == 201, status
        status, listing = request("GET", "/api/media/libraries")
        assert status == 200
        assert "files" not in listing["libraries"][0], "library config endpoint must not recursively enumerate files"
        deadline = time.time() + 8
        page = None
        while time.time() < deadline:
            status, page = request("GET", "/api/media/files?id=books&offset=0&limit=100")
            if status == 200 and page.get("total") == 251: break
            time.sleep(.1)
        assert status == 200, (status, page)
        assert page["total"] == 251, page
        assert len(page["files"]) == 100, len(page["files"])
        assert page["has_more"] is True
        status, page2 = request("GET", "/api/media/files?id=books&offset=200&limit=100")
        assert status == 200
        assert len(page2["files"]) == 51
        assert page2["has_more"] is False
        encoded = urllib.parse.quote(str(special.name), safe="")
        status, payload = request("GET", f"/api/media/file?id=books&path={encoded}", raw=True)
        assert status == 200, (status, payload)
        assert payload == b"special-ebook-content", payload
        print("PASS: unrestricted mapped path, async index, config-only list, paginated files, special ebook URL")
    finally:
        proc.send_signal(signal.SIGTERM)
        try: proc.wait(timeout=2)
        except subprocess.TimeoutExpired: proc.kill()
        BIN.unlink(missing_ok=True)
