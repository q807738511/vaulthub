#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v0.9.66 补丁契约测试：遮罩左缘对齐、放大态归一化、无障碍关闭位、z-index 独立取值。"""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HTML = (ROOT / "index.html").read_text(encoding="utf-8")
STATE = (ROOT / "web/js/01-state.js").read_text(encoding="utf-8")
ZOOM = (ROOT / "web/js/03-audio-zoom.js").read_text(encoding="utf-8")
CSS = (ROOT / "web/css/main.css").read_text(encoding="utf-8")
NOTES = (ROOT / ".github/RELEASE_NOTES_0.9.69.md").read_text(encoding="utf-8")
LOG = (ROOT / "Update Log.md").read_text(encoding="utf-8")
# v0.9.66 的返回路径文案属于该版本的历史说明（当前 notes 已前移到 v0.9.67）。
NOTES_0966 = (ROOT / ".github/RELEASE_NOTES_0.9.66.md").read_text(encoding="utf-8")

checks = {
    # A. v0.9.93：侧栏已移除 —— 遮罩左缘恒为 0（--sidebar-w 已是 0），不再有折叠图标轨。
    "跟随占位令牌": "left:var(--sidebar-w);" in CSS,
    "占位令牌归零": "--sidebar-w: 0px;" in CSS,
    "折叠图标轨已删除": "body.sidebar-hidden .sidebar { width: 62px !important; }" not in CSS
        and "body.sidebar-hidden .main { margin-left: 62px; }" not in CSS
        and "body.sidebar-hidden" not in CSS,

    # B. z-index 独立取值（不再与视频停靠栏同为 650）
    "遮罩独立层级": "z-index:660" in CSS and CSS.count("z-index:650") == 1,

    # C. 无障碍：语义 + 可聚焦隐藏关闭位 + 焦点管理
    "遮罩对话框语义": 'role="dialog"' in HTML and 'aria-modal="true"' in HTML
        and 'aria-label="专辑海报预览"' in HTML,
    "隐藏关闭位": 'class="audio-fullscreen-close-sr"' in HTML
        and "closeAudioCoverZoom()" in HTML and 'aria-label="返回音乐界面"' in HTML,
    "关闭位样式": ".audio-fullscreen-close-sr" in CSS and "clip-path:inset(50%)" in CSS
        and ":focus-visible" in CSS,
    "打开后聚焦关闭位": 'document.querySelector(".audio-fullscreen-close-sr")?.focus' in ZOOM,
    "关闭后归还焦点": 'zoomBtn.focus({ preventScroll: true })' in ZOOM
        and "zoomBtn.offsetParent" in ZOOM,
    # v0.9.66：按钮必须键盘可达（display:none 会让 Tab/读屏触达不到放大入口）
    "放大按钮键盘可达": "pointer-events:none" in CSS and ":focus-within" in CSS
        and ".audio-cover-zoom-btn:focus-visible" in CSS,
    "注释无版本笔误": "v0.9.66/v0.9.66" not in CSS,

    # D. 离开音乐视图归一化关闭放大态
    "视图切换归一化": 'if (v !== "audio" && typeof closeAudioCoverZoom === "function") closeAudioCoverZoom();' in STATE,

    # E. 移动端封面尺寸约束在容器上（img 已是 100%）
    "移动端封面约束容器": ".audio-player-cover-wrap { width:42px; height:42px; flex-basis:42px; }" in CSS,

    # F. 文案准确（放大后放大按钮不可点）
    "注释说明返回路径": "放大按钮此时被遮住不可点" in ZOOM,
    "发布说明文案澄清": "点击遮罩任意位置或按 Esc" in NOTES_0966
        and "遮罩 z-index 高于播放器" in NOTES_0966
        and "放大按钮此时被遮住不可点" in NOTES_0966,
    "更新日志记载": "v0.9.69" in LOG,

    # 版本
    "HTML版本": 'VAULTHUB_ASSET_VERSION = "1.0.8"' in HTML and HTML.count("?v=1.0.8") >= 7,
    "脚本版本": 'VAULTHUB_SCRIPT_VERSION = "1.0.8"' in STATE,
}

failed = [name for name, ok in checks.items() if not ok]
for name, ok in checks.items():
    print(("PASS" if ok else "FAIL") + ": " + name)
if failed:
    raise SystemExit(f"FAIL: v0.9.66 契约 {len(failed)} 项未通过")
print("PASS: v0.9.66 遮罩左缘对齐图标轨、z-index 独立、无障碍关闭位与放大态归一化契约通过")
