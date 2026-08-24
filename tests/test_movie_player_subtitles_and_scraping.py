#!/usr/bin/env python3
from pathlib import Path

root = Path(__file__).resolve().parents[1]
html = (root / "index.html").read_text()
source = (root / "media-api.c").read_text()
dockerfile = (root / "Dockerfile").read_text()

frontend_markers = [
    "buildMoviePlayer",
    "moviePlayerError",
    "mediaTranscodeUrl",
    "mediaSnapshotUrl",
    "mediaSubtitlesUrl",
    "mediaSubtitleUrl",
    "兼容转码播放",
    "字幕",
    "默认开启",
    "switchMovieSubtitle",
    "movieScraperProvider",
    "setMovieScraperProvider",
    "豆瓣",
    "TMDB",
    "片段截图",
    "poster=",
    "<track kind=\"subtitles\"",
]
for marker in frontend_markers:
    assert marker in html, f"missing movie player/scraper frontend marker: {marker}"

backend_markers = [
    "list_subtitles",
    "serve_subtitle_vtt",
    "snapshot_image",
    "transcode_video",
    "/api/media/subtitles",
    "/api/media/subtitle",
    "/api/media/snapshot",
    "/api/media/transcode",
    "ffmpeg -hide_banner",
    "libx264",
    "aac",
]
for marker in backend_markers:
    assert marker in source, f"missing movie backend marker: {marker}"

assert "apk add --no-cache ca-certificates curl ffmpeg" in dockerfile, "runtime image must include ffmpeg for screenshots/transcoding"
assert "onerror=\"moviePlayerError(this)\"" in html, "native video errors must switch to compatible transcode stream"
assert "textTracks[0].mode=\"showing\"" in html, "first subtitle track is not enabled by default"
assert "TMDB_API_KEY" in source, "TMDB must remain gated by environment variable"

print("PASS: movie subtitles, transcode fallback, screenshot fallback, and scraper controls are present")
