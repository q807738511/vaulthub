#!/usr/bin/env python3
"""v0.8.4 media settings, split bookshelf, and movie-detail contracts."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
index = (ROOT / "index.html").read_text()
media = (ROOT / "web/js/02-media.js").read_text()
home = (ROOT / "web/js/05-home.js").read_text()
backend = (ROOT / "media-go/main.go").read_text()
# v0.8.7：部署配置拆成 docker-compose.yml（常用项）+ vaulthub.env（固定项）。
compose = (ROOT / "docker-compose.yml").read_text() + "\n" + (ROOT / "vaulthub.env").read_text()
env_example = (ROOT / ".env.example").read_text()
css = "\n".join(p.read_text() for p in (ROOT / "web/css").glob("*.css"))

# Runtime settings: environment values are defaults; session-authenticated API persists overrides.
for marker in ["MEDIA_RUNTIME_CONFIG", '"/api/media/settings"', "loadRuntimeConfig", "saveRuntimeConfig"]:
    assert marker in backend, f"missing runtime media setting marker: {marker}"
for marker in ["TMDB_API_KEY", "TMDB_API_BASE", "TMDB_IMAGE_BASE", "MEDIA_SCRAPER_MODE",
               "MEDIA_CACHE_DIR", "MEDIA_CACHE_MAX_BYTES", "MEDIA_CACHE_MAX_AGE_HOURS",
               "MEDIA_CACHE_CLEANUP_INTERVAL_HOURS"]:
    assert marker in index, f"settings UI missing {marker}"
    assert marker in (compose + env_example + index), f"deployment config missing {marker}"
assert "loadMediaRuntimeSettings" in media and "saveMediaRuntimeSettings" in media
assert "tmdb_api_key_masked" in backend and 'json:"tmdb_api_key,omitempty"' in backend

# Sidebar must change the selected library even when book and comic share the same view.
assert "openHomeLibrary" in home and "selectLocalLibrary(group, libId)" in home
assert "setBookTypeView" not in media
assert "comicShelfView ===" in media and "返回未读" in media and "已读收藏" in media
assert "📄 电子书</button>" not in media and "📚 漫画</button>" not in media

# Poster opens details; details own playback/share/favorite/rating/cast/recommendations/metadata.
for marker in ["openMovieDetails", "renderMovieDetails", "movie-detail-page", "电影介绍", "播放", "分享", "收藏", "评分", "演职人员", "视频推荐", "视频元数据"]:
    assert marker in media or marker in css, f"movie details missing: {marker}"
assert "data-movie-settings" in media, "poster settings button missing"
assert "toggleMovieReadState" in media
assert 'onclick="openLocalMediaButton(this)"' not in media.split("function renderMoviePoster", 1)[1].split("function ", 1)[0]

# Player shell: no broken settings/download actions; info panel includes probed metadata.
movie_shell = media.split('else if (MEDIA_FORMATS.movie.includes(ext)) body =', 1)[1].split(';\n', 1)[0]
assert "系统设置" not in movie_shell and "download" not in movie_shell
assert "video-info-button" in movie_shell
assert "formatVideoMetadata" in media and "videoMetadata" in media
assert '"video_metadata"' in backend
streams_callback = media.split('fetch(`/api/media/streams?',1)[1].split('}); });',1)[0]
assert "videoRoot.dataset.videoMetadata=formatVideoMetadata(info)" not in streams_callback
assert "context.WithTimeout" in backend and "CheckRedirect" in backend
assert "media-video-body" in css and ("object-fit:contain" in css.replace(" ", "") or "object-fit: contain" in css)

assert "v0.9.13" in index
print("PASS: v0.9.13 runtime settings, split bookshelf, and movie details contracts")
