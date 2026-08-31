#!/usr/bin/env python3
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[1]
manager = (ROOT / "manager" / "main.go").read_text()
import sys as _sys, os as _os
_sys.path.insert(0, _os.path.dirname(__file__))
from _frontend import frontend_source as _fs
html = _fs()
# v0.8.7：部署配置拆成 docker-compose.yml（常用项）+ vaulthub.env（固定项），
# 按两个文件合起来校验。
compose = (ROOT / "docker-compose.yml").read_text() + "\n" + (ROOT / "vaulthub.env").read_text()
dockerfile = (ROOT / "Dockerfile").read_text()

assert "sessionIdleTimeout = 30 * time.Minute" in manager
assert "m.sessions[c.Value] = time.Now().Add(sessionIdleTimeout)" in manager
assert "MaxAge: 1800" in manager
assert "handle /api/logout" in manager
assert "handle /api/logout" in (ROOT / "Caddyfile").read_text()
assert "vaultHubAuthenticated" in html
assert "VAULTHUB_IDLE_TIMEOUT_MS = 30 * 60 * 1000" in html
assert "markVaultHubActivity" in html
assert "openCaddyModal()" in html
assert "handleProtectedResponse" in html

# v0.7.0: the subtype <select> is populated from mediaTypesForGroup() inside
# 系统设置 → 媒体库, so check every subtype is reachable through that mapping and
# has a translated label, instead of matching hardcoded <option value=...> markup.
assert 'group === "comic" ? ["comic","book"]' in html
assert 'group === "movie" ? ["movie","series"]' in html
assert '["audio","musicvideo"]' in html
assert "mediaTypesForGroup" in html
# The per-group library modal was replaced by one table listing every library.
assert 'function renderHomeLibTable(' in html, "library table renderer missing"
assert 'id="homeLibBody"' in html, "library table body missing from 系统设置"
assert "TMDB_API_BASE" in compose
assert "TMDB_IMAGE_BASE" in compose

media_go = (ROOT / "media-go" / "main.go").read_text()
for marker in [
    'archive/zip', 'http.ServeContent',
    'exec.CommandContext', 'ffprobe', 'ffmpeg', 'TMDB_API_KEY',
    'search/movie', 'search/tv', 'context.WithCancel',
]:
    assert marker in media_go, f"missing Go media API marker: {marker}"
assert "http.ServeContent" in media_go
assert "transcode-cache" in media_go
assert 'mux.HandleFunc("/api/media/file/", a.serveLegacy)' in media_go
assert "tasks/cancel" in media_go
assert '"-f", "mp4"' in media_go
assert "media-api.c" not in dockerfile
assert "COPY media-go/go.mod" in dockerfile and "COPY media-go/*.go" in dockerfile

print("PASS: idle auth, scoped media libraries, ZIP comics, TMDB and Go media API are wired")
