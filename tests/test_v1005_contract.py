#!/usr/bin/env python3
"""v1.0.9 契约测试 —— 三项修正的落点检查。

覆盖：
  1. 虚无焦点：可见性四道闸（pointer-events / 定位祖先透明 / 自身透明 / 命中测试）
  2. 方向键漂移：轴锁定三段式（投影重叠优先 / 跨区域兜底 / 无候选不动）
  3. 卡片本体可聚焦、卡片内角标降级为 -1
  4. 顶栏浮层可遥控（打开进第一项 / 返回键关闭并还原焦点）
  5. 三档真实手感（TV / Phone / PC 的栅格、行高、触达、动效）
  6. 焦点抬升与入场动画的冲突已修（animation:none）
  7. 版本纪律（1.0.9 全站同步 + Update Log + Release Notes）
  8. 禁用字面量（不得出现内网地址 / 主机路径）
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HTML = (ROOT / "index.html").read_text(encoding="utf-8")
CSS = (ROOT / "web/css/main.css").read_text(encoding="utf-8")
STATE = (ROOT / "web/js/01-state.js").read_text(encoding="utf-8")
FOCUS = (ROOT / "web/js/08-focus.js").read_text(encoding="utf-8")
LOG = (ROOT / "Update Log.md").read_text(encoding="utf-8")

fails = []
count = 0


def check(name, cond, detail=""):
    global count
    count += 1
    if cond:
        print(f"  ✓ {name}")
    else:
        print(f"  ✗ {name} {detail}")
        fails.append(name)


print("1. 虚无焦点：可见性四道闸（需求1）")
check("1a pointer-events 继承判定（收起浮层整块不可交互）",
      'if (cs.pointerEvents === "none") return false;' in FOCUS)
check("1b 定位祖先整体透明 → 视为未打开（只查 fixed/absolute，避开视图入场动画）",
      "function positionedTransparent" in FOCUS
      and '(pos === "fixed" || pos === "absolute")' in FOCUS
      and "parseFloat(cs.opacity" in FOCUS)
check("1c 元素自身 opacity≈0 剔除（悬浮角标）",
      'parseFloat(cs.opacity || "1") < 0.05' in FOCUS)
check("1d 视口内命中测试（elementFromPoint）",
      "document.elementFromPoint" in FOCUS and "function hitTest" in FOCUS)
check("1e 完全跑到画布左右的元素剔除（横向滚动容器内除外）",
      "function inHorizontalScroller" in FOCUS and "r.right <= 1 || r.left >= vw - 1" in FOCUS)
check("1f 聚焦落点自检：不可见就退回上一个焦点",
      "if (!isVisible(el)) {" in FOCUS and "prev.focus({ preventScroll: true })" in FOCUS)
check("1g 可见性缓存按结构性变化失效（不是每次时钟跳秒都全量重算）",
      'rec.type === "attributes"' in FOCUS and "> 3) { hard = true; break; }" in FOCUS)

print("2. 方向键漂移：轴锁定三段式（需求2）")
check("2a 旧的非对称权重已移除（注释里记录根因不算）",
      "cross * 0.42" not in FOCUS and "score = primary + cross" not in FOCUS)
check("2b 投影重叠判定（同一行/同一列优先）",
      "function overlapLen" in FOCUS and "if (ov > 0) {" in FOCUS)
check("2c 同排/同列只比主轴间距（横向错位权重 0.05）",
      "var s1 = gap + perp * 0.05;" in FOCUS)
check("2d 跨区域兜底：错位上限一个身位 + 代价 1.2",
      "perp <= Math.max(f.width, r.width) * 0.9" in FOCUS
      and "var s2 = gap + perp * 1.2;" in FOCUS)
check("2e 无候选就不动（返回 null，不跳虚空）",
      "return band || near || null;" in FOCUS)
check("2f 方向键先 preventDefault 再算下一项（不让页面单独滚动）",
      re.search(r"if \(dirs\.indexOf\(event\.key\) >= 0\) \{\s*\n\s*event\.preventDefault\(\);", FOCUS) is not None)
check("2g 同一卡片内部元素不参与方向导航（Enter 才进入）",
      "if (el.contains(current) || current.contains(el)) continue;" in FOCUS)

print("3. 卡片本体成为焦点目标（需求2 附带）")
check("3a 卡片选择器覆盖全部卡片类型",
      all(k in FOCUS for k in (".media-poster-card", ".hp", ".book-card", ".audio-album-card", ".movie-rec-card")))
check("3b 卡片补 tabindex=0", 'setAttribute("tabindex", "0")' in FOCUS)
check("3c 卡片内角标降为 tabindex=-1", 'setAttribute("tabindex", "-1")' in FOCUS)
check("3d 过滤阶段再挡一次（button 选择器会无视 tabindex=-1）",
      "if (el.matches && el.matches(CARD_INNER)) return false;" in FOCUS)

print("4. 顶栏浮层可遥控（需求1 附带）")
check("4a 打开浮层后焦点进第一项", "function focusOpenedPopup" in FOCUS and ".tn-popitem, button, a[href]" in FOCUS)
check("4b 头像/通知按钮触发", 'closest("#topUserButton, .tn-bell")' in FOCUS)
check("4c 返回键先关浮层并把焦点交回触发按钮",
      'var pop = document.querySelector(".tn-pop.open");' in FOCUS and "focusEl(trigger" in FOCUS)

print("5. 三档真实手感（需求3）")
check("5a0 顶栏高度覆盖调色板块的令牌（:root 抬特异性）",
      'html[data-uimode="tv"]:root {' in CSS and "--topbar-h: 64px;" in CSS
      and "否则 52px 一直赢" in CSS)
check("5a TV 顶栏 64px、标签 44px",
      "--topbar-h: 64px;" in CSS and 'html[data-uimode="tv"] .tn-item,' in CSS and "height: 44px;" in CSS)
check("5b TV 海报卡最小 300px（1920 上 5 列而不是 10 列）",
      'html[data-uimode="tv"] .media-poster-grid { grid-template-columns: repeat(auto-fill, minmax(300px, 1fr))' in CSS)
check("5c TV 列表行 68px / 操作按钮 44px",
      'html[data-uimode="tv"] .media-file-row { min-height: 68px' in CSS
      and 'html[data-uimode="tv"] .row-acts .btn { min-height: 44px; min-width: 44px; }' in CSS)
check("5d TV 焦点 4px 环 + scale 抬升",
      'outline: 4px solid var(--accent);' in CSS and "transform: scale(1.045);" in CSS)
check("5e Phone 档 2 列海报 + 48px 触达 + 安全区",
      'html[data-uimode="phone"] .media-poster-grid { grid-template-columns: repeat(2, minmax(0, 1fr));' in CSS
      and "min-height: 48px;" in CSS and "env(safe-area-inset-bottom" in CSS)
check("5f PC 档高密度 150px", 'html[data-uimode="pc"] .media-poster-grid { grid-template-columns: repeat(auto-fill, minmax(150px, 1fr))' in CSS)
check("5g 横向库标签滚动吸附", 'html[data-uimode="tv"] .tn-libs { scroll-snap-type: x proximity; }' in CSS)
check("5h TV 入场动画收敛到 160ms", 'html[data-uimode="tv"] .view { animation-duration: .16s; }' in CSS)

print("6. 焦点抬升与入场动画冲突已修")
check("6a 聚焦时先摘动画再抬升（opAppleIn 带 fill:both 会压住 transform）",
      "animation: none;\n  transform: scale(1.045);" in CSS)
check("6b CSS 里写明根因，避免以后又被加回来",
      "fill:both" in CSS and "焦点抬升在 Apple 规格下其实是死的" in CSS)

print("7. 版本纪律")
check("7a index.html 资源串 12 处 1.0.9", HTML.count("?v=1.0.9") == 12)
check("7b 首帧资源版本常量", 'window.VAULTHUB_ASSET_VERSION = "1.0.9";' in HTML)
check("7c 脚本版本常量", 'const VAULTHUB_SCRIPT_VERSION = "1.0.9";' in STATE)
check("7d 安装/升级脚本版本",
      'VERSION="v1.0.9"' in (ROOT / "scripts/install.sh").read_text(encoding="utf-8")
      and 'VERSION="v1.0.9"' in (ROOT / "scripts/upgrade.sh").read_text(encoding="utf-8"))
check("7e 字幕服务 UA", '"VaultHub-Subtitle/1.0.9"' in (ROOT / "subtitle-api/main.go").read_text(encoding="utf-8"))
SLOGAN = "v1.0.9 · NFO 补全 · 音乐随点随开 · 大库不卡"
check("7f 标语三处一致", HTML.count(SLOGAN) == 3, f"实际 {HTML.count(SLOGAN)} 处")
check("7g Update Log 顶部是 v1.0.9", LOG.splitlines()[0] == "# VaultHub 蜀鼠之家 v1.0.9")
check("7h Release Notes 存在且覆盖三项",
      (ROOT / ".github/RELEASE_NOTES_1.0.5.md").exists()
      and "虚无焦点" in (ROOT / ".github/RELEASE_NOTES_1.0.5.md").read_text(encoding="utf-8"))
check("7i 历史版本段落仍在（v1.0.9 段完整）",
      "# VaultHub 蜀鼠之家 v1.0.9" in LOG and "术语归位（需求2）" in LOG)

print("8. 禁用字面量")
BANNED = re.compile(r"enged\.top|192\.168\.|/vol[1-4]")
offenders = []
for path in list(ROOT.rglob("*.py")) + list(ROOT.rglob("*.js")) + list(ROOT.rglob("*.css")) + \
        list(ROOT.rglob("*.html")) + list(ROOT.rglob("*.go")):
    if "node_modules" in str(path) or "vendor" in str(path):
        continue
    text = path.read_text(encoding="utf-8", errors="ignore")
    for m in BANNED.finditer(text):
        line = text[:m.start()].count("\n") + 1
        offenders.append(f"{path.relative_to(ROOT)}:{line}:{m.group(0)}")
check("8a 源码内无内网地址 / 主机路径", not offenders, str(offenders[:3]))

print()
print(f"================ v1.0.9 契约：{count - len(fails)}/{count} PASS ================")
if fails:
    print("FAILED:", ", ".join(fails))
    sys.exit(1)
