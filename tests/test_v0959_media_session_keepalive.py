#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v0.9.59 音乐播放会话保活 + 海报放大按钮契约测试。"""
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HTML = (ROOT / "index.html").read_text(encoding="utf-8")
STATE = (ROOT / "web/js/01-state.js").read_text(encoding="utf-8")
MEDIA = (ROOT / "web/js/02-media.js").read_text(encoding="utf-8")
FEATURES = (ROOT / "web/js/03-features.js").read_text(encoding="utf-8")
ZOOM = (ROOT / "web/js/03-audio-zoom.js").read_text(encoding="utf-8")
CSS = (ROOT / "web/css/main.css").read_text(encoding="utf-8")
NOTES = (ROOT / ".github/RELEASE_NOTES_0.9.59.md").read_text(encoding="utf-8")
LOG = (ROOT / "Update Log.md").read_text(encoding="utf-8")

checks = {
    "版本资源": 'VAULTHUB_ASSET_VERSION = "0.9.59"' in HTML,
    "脚本版本": 'VAULTHUB_SCRIPT_VERSION = "0.9.59"' in STATE,
    "静态缓存串": HTML.count("?v=0.9.59") >= 7,
    "五分钟保活周期": "MEDIA_KEEPALIVE_MS = 5 * 60 * 1000" in STATE,
    "具名幂等 source": "const mediaKeepAliveSources = new Set()" in STATE,
    "保活刷新前端 idle": "markVaultHubActivity();" in STATE,
    "保活滑动服务端会话": "fetch('/api/system/runtime'" in STATE and "credentials: 'same-origin'" in STATE,
    "保活响应鉴权处理": "await handleProtectedResponse(res)" in STATE,
    "音频播放启动": 'addEventListener("play", startAudioSessionKeepAlive)' in MEDIA,
    "音频停止与错误释放": "stopAudioSessionKeepAlive();" in MEDIA and 'addEventListener("error", stopAudioSessionKeepAlive)' in MEDIA,
    "音频切歌幂等": 'mediaKeepAliveStart("audio")' in MEDIA and 'mediaKeepAliveStop("audio")' in MEDIA,
    "视频实际播放启动": 'addEventListener("playing", () => mediaKeepAliveStart("video"))' in MEDIA,
    "视频结束错误释放": 'addEventListener("ended", () => mediaKeepAliveStop("video"))' in MEDIA and 'addEventListener("error", () => mediaKeepAliveStop("video"))' in MEDIA,
    "视频关闭释放": 'function stopVideoPlaybackSession(root) {\n  mediaKeepAliveStop("video");' in MEDIA,
    "关闭播放器调用停止会话": "stopVideoPlaybackSession(root)" in FEATURES,
    # 新增海报放大契约
    "封面容器包装": ".audio-player-cover-wrap" in CSS and "position:relative" in CSS,
    "hover 显示放大按钮": ".audio-cover-zoom-btn" in CSS and ".audio-player-cover-wrap:hover .audio-cover-zoom-btn" in CSS,
    "封面放大按钮 HTML": 'class="audio-cover-zoom-btn"' in HTML and 'onclick="toggleAudioCoverZoom()"' in HTML,
    "全屏海报叠加层": ".audio-fullscreen-overlay" in CSS and "position:fixed" in CSS and "z-index:280" in CSS,
    "全屏海报元素": 'id="audioFullscreenOverlay"' in HTML and 'class="audio-fullscreen-overlay"' in HTML,
    "全屏返回按钮": 'class="audio-fullscreen-back"' in HTML and 'onclick="toggleAudioCoverZoom()"' in HTML,
    "全屏海报图片": 'id="audioFullscreenImg"' in HTML and 'id="audioFullscreenFallback"' in HTML,
    "toggleAudioCoverZoom 函数": "function toggleAudioCoverZoom()" in ZOOM and "audioCoverZoomed" in ZOOM,
    "切换遮罩显示": 'overlay.classList.toggle("show", audioCoverZoomed)' in ZOOM,
    "更新海报与回退": "audioFullscreenImg" in ZOOM and "audioFullscreenFallback" in ZOOM,
    "加载 zoom 脚本": '<script src="/web/js/03-audio-zoom.js?v=0.9.59"></script>' in HTML,
    "发布说明": "VaultHub v0.9.59" in NOTES and "媒体播放期间会话保活" in NOTES,
    "更新日志": "VaultHub 蜀鼠之家 v0.9.59" in LOG and "长时间播放" in LOG,
}
failed = [name for name, ok in checks.items() if not ok]
for name, ok in checks.items():
    print(("PASS" if ok else "FAIL") + ": " + name)
if failed:
    raise SystemExit(f"FAIL: v0.9.59 契约 {len(failed)} 项未通过")
print("PASS: v0.9.59 音频/视频媒体播放会话保活 + 海报放大按钮契约通过")
