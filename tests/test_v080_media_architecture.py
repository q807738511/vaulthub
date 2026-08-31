#!/usr/bin/env python3
"""VaultHub v0.8.0 contracts: content-first media pages, session-only writes,
and a real self-hosted three-engine video fallback.
"""
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
index = (ROOT / "index.html").read_text(encoding="utf-8")
media = (ROOT / "web/js/02-media.js").read_text(encoding="utf-8")
home = (ROOT / "web/js/05-home.js").read_text(encoding="utf-8")
features = (ROOT / "web/js/03-features.js").read_text(encoding="utf-8")
state = (ROOT / "web/js/01-state.js").read_text(encoding="utf-8")
css = (ROOT / "web/css/main.css").read_text(encoding="utf-8")
backend = (ROOT / "media-go/main.go").read_text(encoding="utf-8")
# v0.8.7：部署配置拆成 docker-compose.yml（常用项）+ vaulthub.env（固定项）。
compose = ((ROOT / "docker-compose.yml").read_text(encoding="utf-8") + "\n"
           + (ROOT / "vaulthub.env").read_text(encoding="utf-8"))
dockerfile = (ROOT / "Dockerfile").read_text(encoding="utf-8")
env_example = (ROOT / ".env.example").read_text(encoding="utf-8")
install = (ROOT / "scripts/install.sh").read_text(encoding="utf-8")
upgrade = (ROOT / "scripts/upgrade.sh").read_text(encoding="utf-8")

# Content pages must no longer expose source/config/admin controls.
for marker in ["function mediaModeBar(", "dwu_media_mode_", "showMediaLibraryConfig('${esc(group)}')"]:
    assert marker not in media, f"content page still exposes configuration/source UI: {marker}"
assert 'id="mediaAdminToken"' not in index
assert "dwu_media_admin_token" not in media + home + features
assert "X-VaultHub-Token" not in media + home + features
assert "function mediaAdminHeaders(" not in media

# Content pages are graphic-first and configuration/scraping actions stay in settings.
assert "renderMoviePoster(" in media and "media-poster-grid" in media
assert "renderBookCard(" in media and "book-grid" in media
assert "renderAudioAlbums(" in media and "audio-album-grid" in media
assert "我的媒体库" in media and "最新音乐" in media
assert "已读收藏" in media and "返回未读" in media
assert "selectLocalLibrary" in media
assert "setBookTypeView" not in media and "电子书" in media and "漫画" in media
# Scrape buttons/config text must not be emitted by content renderers.
for fn in ["renderMovieLibraryContent", "renderAudioLibraryContent"]:
    start = media.index(f"function {fn}(")
    end = media.index("\n}", start) + 2
    body = media[start:end]
    assert "重新刮削" not in body and "TMDB" not in body, f"{fn} still contains scraper configuration"

# Audio remains editable/favouritable, and the centered player has a favourite button.
for marker in ["openAudioMetadata(", "toggleAudioFavorite(", 'id="audioFavoriteButton"']:
    assert marker in media + index
assert ".audio-player" in css and re.search(r"\.audio-player\s*\{[^}]*left:\s*50%", css, re.S)
assert "MEDIA_CACHE_DIR" in backend
assert "MEDIA_CACHE_MAX_BYTES" in backend and "MEDIA_CACHE_MAX_AGE_HOURS" in backend
assert "cacheJanitor" in backend and "cleanCache" in backend
assert "/data/transcode-cache" in compose and "MEDIA_CACHE_CLEANUP_INTERVAL_HOURS" in compose
assert "removeAttribute(\"src\")" in media and "activeAudio=null" in media
assert "setComicShelfView" in media

# Session cookie is the sole write authority. Token compatibility is removed end-to-end.
for text in [backend, compose, dockerfile, env_example, install, upgrade]:
    assert "ADMIN_TOKEN" not in text
assert "X-VaultHub-Token" not in backend
assert "func auth(" not in backend
assert "func writeAuth(" in backend and "return managerSessionOK(r)" in backend
for request in re.findall(r"fetch\([^;]+", media + home + features):
    if 'method: "POST"' in request or 'method: "DELETE"' in request:
        assert 'credentials: "same-origin"' in request

# Three real engines: native media, server FFmpeg compatibility, and self-hosted WASM SIMD.
for marker in ["VIDEO_ENGINE_NATIVE", "VIDEO_ENGINE_COMPAT", "VIDEO_ENGINE_WASM",
               "detectWasmSimd", "startWasmVideoFallback", "advanceVideoEngine"]:
    assert marker in media, f"missing player architecture marker: {marker}"
assert "/api/media/compat" in media
assert "new Worker(" in media and "/web/vendor/ffmpeg/worker.js" in media
assert "WebAssembly" in media and "SIMD" in media
assert "data-video-engine" in media and "三层播放" in media
for asset in [
    "web/vendor/ffmpeg/worker.js",
    "web/vendor/ffmpeg/ffmpeg-core.js",
    "web/vendor/ffmpeg/ffmpeg-core.wasm",
]:
    p = ROOT / asset
    assert p.is_file() and p.stat().st_size > 100, f"missing self-hosted WASM asset: {asset}"
# Worker must execute the WASM FFmpeg core, not merely report feature detection.
worker = (ROOT / "web/vendor/ffmpeg/worker.js").read_text(encoding="utf-8")
assert "importScripts" in worker and "ffmpeg-core.js" in worker
assert "FS.writeFile" in worker and "core.exec" in worker and "FS.readFile" in worker
core_js = (ROOT / "web/vendor/ffmpeg/ffmpeg-core.js").read_text(encoding="utf-8")
assert 'Module["exec"]=exec' in core_js
assert "terminateWasmVideo(root)" in media
assert 'querySelectorAll(".media-video-body").forEach(root =>' in features
assert 'r.Method != http.MethodPost' in backend and 'writeAuth(r)' in backend

print("PASS: v0.8.0 content-first pages, session-only auth, and real three-engine player contracts")
