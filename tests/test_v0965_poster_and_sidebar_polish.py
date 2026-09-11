#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v0.9.66 海报标签编辑按钮清理 · 播放器海报自适应 · 移动端侧栏滚动 · 磨砂清晰度契约测试。"""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HTML = (ROOT / "index.html").read_text(encoding="utf-8")
STATE = (ROOT / "web/js/01-state.js").read_text(encoding="utf-8")
MEDIA = (ROOT / "web/js/02-media.js").read_text(encoding="utf-8")
ZOOM = (ROOT / "web/js/03-audio-zoom.js").read_text(encoding="utf-8")
CSS = (ROOT / "web/css/main.css").read_text(encoding="utf-8")
NOTES = ROOT / ".github/RELEASE_NOTES_0.9.66.md"

checks = {
    # 1. 专辑 / 歌手海报标签上的编辑按钮移除，编辑入口合并到曲目列表
    "卡片移除专辑编辑按钮": 'title="编辑专辑"' not in MEDIA,
    "卡片移除歌手编辑按钮": 'title="编辑歌手"' not in MEDIA,
    "曲目列表保留专辑编辑入口": "openAudioGroupEdit(" in MEDIA
        and MEDIA.count("openAudioGroupEdit(") >= 2,
    "编辑入口按分组类型切换": 'back === "artists" ? "artist" : "album"' in MEDIA,

    # 2. 最大化按钮自适应居中 + 左侧海报尺寸自适应 + 移除右上角返回按钮
    "移除海报返回按钮": "audio-fullscreen-back" not in HTML and ".audio-fullscreen-back" not in CSS,
    "遮罩点击返回": 'audioFullscreenOverlay")?.addEventListener("click"' in ZOOM
        and "function closeAudioCoverZoom()" in ZOOM,
    "Esc 返回": '"Escape"' in ZOOM and "audioCoverZoomed" in ZOOM,
    "放大按钮自适应居中": "top:50%; left:50%" in CSS and "translate(-50%,-50%)" in CSS
        and ".audio-cover-zoom-btn" in CSS
        and "translate(-50%,-50%) scale(1.1)" in CSS,
    "左侧封面尺寸自适应": ".audio-player-cover-wrap { position:relative; width:clamp(" in CSS,

    # 3. 遮罩覆盖侧栏折叠后的空缺
    "遮罩跟随侧栏折叠": "body.sidebar-hidden .audio-fullscreen-overlay" in CSS,
    # v0.9.66 修正：桌面折叠态是 62px 图标轨（.main 同样 margin-left:62px），
    # 遮罩必须从 62px 起；仅窄屏侧栏 0 宽时才回到 0。
    "折叠后左缘贴合图标轨": "body.sidebar-hidden .audio-fullscreen-overlay { left:62px; }" in CSS
        and ".audio-fullscreen-overlay, body.sidebar-hidden .audio-fullscreen-overlay { left:0; }" in CSS,

    # 4. 移动端侧栏可横向滚出全部页面项
    "移动端库项容器不成为 flex 项": "#libNavAll" in CSS and "display:contents" in CSS,
    "移动端导航可横向滚动": ".sidebar .nav {" in CSS and "overflow-x: auto" in CSS
        and "-webkit-overflow-scrolling: touch" in CSS,

    # 5. 四周磨砂清晰度 85%
    "磨砂清晰度变量": "--poster-frost-clarity:85%" in CSS,
    "磨砂使用清晰度变量": "opacity:var(--poster-frost-clarity" in CSS,
    "磨砂模糊半径降低": "blur(14px) saturate(1.1) brightness(.66)" in CSS,

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
print("PASS: v0.9.66 编辑入口合并、海报自适应与居中、遮罩跟随侧栏、移动端侧栏滚动、85% 磨砂契约通过")
