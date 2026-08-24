from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
html = (ROOT / "index.html").read_text(encoding="utf-8")
c = (ROOT / "media-api.c").read_text(encoding="utf-8")
dockerfile = (ROOT / "Dockerfile").read_text(encoding="utf-8")
compose = (ROOT / "docker-compose.yml").read_text(encoding="utf-8")
caddyfile = (ROOT / "Caddyfile").read_text(encoding="utf-8")


def assert_contains(text, needle):
    assert needle in text, f"missing marker: {needle}"


# 漫画、电子书、影视应有独立的列表/海报视图切换。
for marker in [
    "mediaViewModeCache",
    "function mediaViewMode(type)",
    "function setMediaViewMode(type, mode)",
    "function viewToggle(type)",
    "viewToggle(viewType)",
    "viewToggle(\"movie\")",
    "renderMovieCard",
    "movie-poster-grid",
    "book-grid",
    "media-file-list",
    "▦ 海报",
    "☰ 列表",
]:
    assert_contains(html, marker)

# 阅读/播放窗口必须避开左侧侧边栏，移动端再恢复全屏。
for marker in [
    ".media-reader-overlay { position:fixed; top:0; right:0; bottom:0; left:var(--sidebar-w);",
    "max-width:calc(100vw - var(--sidebar-w))",
    "left:0; z-index:300; min-height:100vh; max-width:100vw",
]:
    assert_contains(html, marker)

# 默认 720P 转码播放；只有原画走直连；画质控件内置播放器右下角。
for marker in [
    "function moviePlaybackUrl(lib, path, quality = \"720p\")",
    "quality === \"original\" ? mediaFileUrl(lib, path) : mediaTranscodeUrl(lib, path, quality)",
    "mediaTranscodeUrl(lib, path, quality = \"original\")",
    "function switchMovieQuality(select)",
    "movie-quality-floating",
    "id=\"movieQualitySelect\"",
    "<option value=\"original\">原画</option>",
    "<option value=\"1080p\">1080P</option>",
    "<option value=\"720p\" selected>720P</option>",
    "<option value=\"480p\">480P</option>",
    "<option value=\"360p\">360P</option>",
    "默认 720P 转码播放",
    "缓存转码",
]:
    assert_contains(html, marker)

# 旧的兼容/外部按钮必须移除。
assert "兼容转码播放</button>" not in html
assert "外部打开原片" not in html

# 后端转码缓存和画质参数。
for marker in [
    "transcode_cache_dir",
    "TRANSCODE_CACHE_DIR",
    "fnv1a64",
    "transcode_quality_height",
    "1080p",
    "720p",
    "480p",
    "360p",
    "X-VaultHub-Transcode-Cache: HIT",
    "serve_cached_video",
    "quality",
    "scale=-2:min(%d\\\\,ih)",
    "-f mp4",
    "-movflags frag_keyframe+empty_moov+default_base_moof",
]:
    assert_contains(c, marker)

assert "ffmpeg" in dockerfile
assert "TRANSCODE_CACHE_DIR=/data/transcode-cache" in dockerfile
assert "TRANSCODE_CACHE_DIR" in compose
assert "flush_interval -1" in caddyfile

print("PASS: media view switches, sidebar-safe viewer, default 720p player, quality selector, and transcode cache markers are present")
