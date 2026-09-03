from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
import sys as _sys, os as _os
_sys.path.insert(0, _os.path.dirname(__file__))
from _frontend import frontend_source as _fs
html = _fs()
media = (ROOT / "tests" / "fixtures" / "media-api_legacy.c").read_text(encoding="utf-8")

for forbidden in [
    "/api/media/transcode",
    "mediaTranscodeUrl",
    "transcode_cache_dir",
    "TRANSCODE_CACHE_DIR",
    "quality=720p",
    "default 720p",
]:
    assert forbidden not in html, f"frontend still contains removed transcode marker: {forbidden}"
    assert forbidden not in media, f"backend still contains removed transcode marker: {forbidden}"

assert 'mediaFileUrl(lib, path)' in html, "video/audio resources should use direct media file URLs"
assert 'class="media-viewer-body media-video-body"' in html, "video reader does not use full-window video body"
# v0.9.41：原生 controls 被自定义悬浮控制栏取代（左上折叠 / 右上全屏 / 中部传输键 /
# 右下功能键 / 顶部进度条），保留 controls 会出现两条控制条并互相遮挡。
assert '<video data-movie-player playsinline preload="metadata"' in html, "video element should be user-started direct playback"
assert '<video data-movie-player controls' not in html, "自定义悬浮控制栏不能与浏览器原生 controls 并存"
assert 'class="video-chrome"' in html and 'data-video-chrome' in html, "缺少 v0.9.41 悬浮控制栏容器"
assert 'autoplay preload="metadata" style="width:100%;max-height:72vh' not in html, "old constrained autoplay video remains"
assert 'onloadedmetadata="this.muted=false;this.volume=1"' in html, "video audio initialization is missing"
assert 'mediaCompatUrl(lib, path)' in html, "audio-compatible playback URL is missing"
assert 'mediaProbeUrl(lib, path)' in html, "automatic compatibility probe URL is missing"
assert 'movieExtensionNeedsCompat(path)' in html, "extension-based automatic compatibility rule is missing"
assert 'requestPlaybackPlan(lib, path' in html and '/api/media/playback/plan' in html, "server playback-plan rule is missing"
assert 'left:var(--sidebar-w)' in html, "desktop reader overlay still covers the left sidebar"
assert '豆瓣刮削/文件名展示' not in html, "video playback still shows the old hint under the page"
assert '.media-video-body video { width:100%; height:100%;' in html, "video does not fill the reader window"
# v0.8.7：overlay 从顶栏下方开始（top:var(--topbar-h)），正文高度必须同时扣掉
# 顶栏和阅读器顶栏，否则底部会被裁掉。原断言写死 calc(100vh - 51px)。
assert '.media-reader-body { flex:1; min-height:0; height:calc(100vh - var(--topbar-h) - 51px);' in html, "reader body height is not viewport-bound"
assert '.media-viewer-body { padding: 12px; max-height: none;' in html, "generic media viewer still has 72vh limit"
assert '.media-reader-body iframe { width:100%; height:100%; min-height:0;' in html, "PDF/ebook iframe still has fixed viewport min-height"

print("PASS: direct playback removes transcode, restores audio initialization, and expands reader/video windows")
