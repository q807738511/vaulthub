#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v0.9.66 媒体播放器整体修复契约测试。"""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HTML = (ROOT / "index.html").read_text(encoding="utf-8")
STATE = (ROOT / "web/js/01-state.js").read_text(encoding="utf-8")
MEDIA = (ROOT / "web/js/02-media.js").read_text(encoding="utf-8")
ZOOM = (ROOT / "web/js/03-audio-zoom.js").read_text(encoding="utf-8")
CSS = (ROOT / "web/css/main.css").read_text(encoding="utf-8")
NOTES = ROOT / ".github/RELEASE_NOTES_0.9.66.md"

checks = {
    # 1. 音乐播放器封面 hover 放大 + 清晰画中画/外部磨砂
    # v0.9.66：放大按钮由左上角改为封面内自适应居中。
    "封面 hover 居中按钮": ".audio-player-cover-wrap:hover .audio-cover-zoom-btn" in CSS
        and "top:50%; left:50%" in CSS and "translate(-50%,-50%)" in CSS,
    "播放器原位且独立遮罩": 'id="audioFullscreenOverlay"' in HTML
        and 'onclick="toggleAudioCoverZoom()"' in HTML
        and 'overlay.classList.toggle("show", audioCoverZoomed)' in ZOOM,
    "清晰画中画海报": ".audio-fullscreen-poster" in CSS
        and "object-fit:contain" in CSS
        and "--poster-blur-bg" in CSS,
    "画外九成磨砂": ".audio-fullscreen-overlay::before" in CSS
        and "opacity:.9" in CSS
        and "backdrop-filter:blur(" in CSS,
    # v0.9.66：右上角返回按钮移除，取消全屏改为点击遮罩或 Esc。
    "无返回按钮且可点击退出": "audio-fullscreen-back" not in HTML
        and "cursor:zoom-out" in CSS and "closeAudioCoverZoom" in ZOOM,

    # 2. 详情页背景必须取当前查看项，不复用当前播放媒体背景
    "详情背景独立函数": "function detailArtworkUrl(" in MEDIA
        and "function detailBackdropStyle(" in MEDIA,
    "影视详情绑定当前条目背景": "media-detail-backdrop" in MEDIA
        and "detailBackdropStyle(meta)" in MEDIA,
    "歌曲详情绑定当前歌曲背景": "audio-detail-backdrop" in MEDIA
        and "detailBackdropStyle(meta)" in MEDIA,
    "详情背景九成五清晰度": ".media-detail-backdrop::before" in CSS
        and "opacity:.95" in CSS,
    "歌曲详情不调用播放背景": "function showAudioDetails()" in MEDIA
        and "detailBackdropStyle(meta)" in MEDIA,

    "详情背景URL单次清洗": "return art ? `--detail-backdrop:url('${art}')`" in MEDIA
        and 'style="${esc(detailBackdropStyle(meta))}"' in MEDIA,
    "互斥暂停不销毁视频会话": 'mediaKeepAliveStop("video"); clearTimeout(root.__videoProgressTimer);' in MEDIA
        and 'if (root) stopVideoPlaybackSession(root);' not in MEDIA.split("function claimExclusivePlayback", 1)[1].split("}", 4)[0],
    "移动端停靠不裁切": "height:180px; overflow:auto" in CSS,

    # 3. 音视频播放唯一性
    "统一互斥协调器": "function claimExclusivePlayback(" in MEDIA,
    "音乐播放前停止视频": 'claimExclusivePlayback("audio")' in MEDIA,
    "视频播放前停止音乐": 'claimExclusivePlayback("video"' in MEDIA,
    "视频切换播放也互斥": "function videoTogglePlay(" in MEDIA
        and 'claimExclusivePlayback("video"' in MEDIA,

    # 4. 视频缩放到控制器最下面一排，控制器常驻，视频在左下角
    "最小化控制器停靠底排": "video-controller-docked" in CSS
        and "bottom:" in CSS,
    "视频缩到控制器左下角": ".video-controller-docked video" in CSS
        and "left:" in CSS and "bottom:" in CSS,
    "最小化控制器常驻": ".video-controller-docked .video-chrome" in CSS
        and "opacity:1" in CSS and "pointer-events:auto" in CSS,
    "最小化逻辑新状态": 'overlay.classList.add("video-minimized", "video-controller-docked")' in MEDIA
        and 'root.dataset.videoChromeCollapsed = "false"' in MEDIA,
    "还原清理新状态": 'overlay.classList.remove("video-minimized", "video-controller-docked")' in MEDIA,

    # 版本与发布资料
    "HTML版本": 'VAULTHUB_ASSET_VERSION = "0.9.66"' in HTML and HTML.count("?v=0.9.66") >= 7,
    "脚本版本": 'VAULTHUB_SCRIPT_VERSION = "0.9.66"' in STATE,
    "发布说明": NOTES.exists(),
}

failed = [name for name, ok in checks.items() if not ok]
for name, ok in checks.items():
    print(("PASS" if ok else "FAIL") + ": " + name)
if failed:
    raise SystemExit(f"FAIL: v0.9.66 契约 {len(failed)} 项未通过")
print("PASS: v0.9.66 音乐海报、详情背景、音视频互斥、视频控制器停靠契约通过")
