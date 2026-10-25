#!/usr/bin/env python3
"""v1.0.12 契约测试 —— 10 项修正的落点检查。

覆盖：
  1. TV 操作模式：鼠标 / 遥控 / 键盘规则 + 焦点保护 + CSS 定位
  2. 术语归位：界面规格 = Apple/Emby/Plex；操作模式 = 自动/Phone/TV/PC
  3. 界面规格真实换肤（图标包 + 顶栏形态）
  4. 操作模式交互增强（卡片 + 当前生效说明）
  5. 操作模式固化（localStorage + cookie，刷新不重置）
  6. 服务器监控自适应栅格
  7. 刷新保留当前页面
  8. 大库反复刷新修复（在飞请求复用 + 代次号）
  9. 已建库可加媒体路径（重扫左侧 ✎）
 10. 配置页提示文案清理
 11. 版本纪律与禁用字面量
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HTML = (ROOT / "index.html").read_text(encoding="utf-8")
CSS = (ROOT / "web/css/main.css").read_text(encoding="utf-8")
STATE = (ROOT / "web/js/01-state.js").read_text(encoding="utf-8")
THEME = (ROOT / "web/js/06-theme.js").read_text(encoding="utf-8")
MEDIA = (ROOT / "web/js/02-media.js").read_text(encoding="utf-8")
HOME = (ROOT / "web/js/05-home.js").read_text(encoding="utf-8")
BOOT = (ROOT / "web/js/04-boot.js").read_text(encoding="utf-8")
TOPPANEL = (ROOT / "web/js/07-topnav.js").read_text(encoding="utf-8")
FEATURES = (ROOT / "web/js/03-features.js").read_text(encoding="utf-8")
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


print("1. TV 操作模式：鼠标 / 遥控 / 键盘规则（需求1）")
check("1a 焦点层脚本存在且带版本串", (ROOT / "web/js/08-focus.js").exists() and "/web/js/08-focus.js?v=1.0.12" in HTML)
check("1b 焦点层排在业务脚本之后、启动脚本之前",
      HTML.index("/web/js/08-focus.js") < HTML.index("/web/js/04-boot.js")
      and HTML.index("/web/js/08-focus.js") > HTML.index("/web/js/02-media.js"))
check("1c 方向键空间导航（按几何位置，不是 DOM 顺序）",
      all(k in FOCUS for k in ("function nextInDirection", "ArrowLeft", "ArrowRight", "getBoundingClientRect")))
check("1d 遥控返回键（Escape / Backspace / 461 / 10009）",
      'BACK_KEYS = ["Escape", "BrowserBack", "GoBack"]' in FOCUS and "461" in FOCUS and "10009" in FOCUS)
check("1e 焦点保护：MutationObserver + 焦点指纹回填",
      "new MutationObserver" in FOCUS and "function fingerprint" in FOCUS and "function restoreFocus" in FOCUS)
check("1f 只在 TV 档接管方向键，输入框/播放器让行",
      "if (!tvMode()) return;" in FOCUS and "function typingTarget" in FOCUS and "function ownsKeys" in FOCUS)
check("1g 鼠标移上即聚焦（与遥控同一焦点模型）",
      'document.addEventListener("pointerover"' in FOCUS and "focusEl(target, { preventScroll: true, scroll: false })" in FOCUS)
check("1h 覆盖层内循环焦点（不跳到被遮住的按钮）",
      "function activeScope" in FOCUS and ".modal-mask.show" in FOCUS)
check("1i CSS 定位：scroll-padding / scroll-margin / 常显 :focus 环",
      'html[data-uimode="tv"] { scroll-padding-block' in CSS
      and 'html[data-uimode="tv"] * { scroll-margin-block' in CSS
      and 'html[data-uimode="tv"] :focus,' in CSS)
check("1j 触屏/遥控不保留 hover 抬升残留", "@media (hover: none)" in CSS)
check("1k 可见性判定覆盖隐藏祖先（getClientRects）",
      "el.getClientRects().length === 0" in FOCUS)
check("1l 关掉覆盖层后焦点回收（不停在隐藏输入框）",
      "function recoverFocusAfterClose" in FOCUS and "isVisible(document.activeElement)" in FOCUS)
check("1m 观察 class/style 变化（弹窗开关只改 class）",
      'attributeFilter: ["class", "style", "hidden"]' in FOCUS)

print("2. 术语归位（需求2）")
check("2a 面板顺序：界面规格（Apple/Emby/Plex）在上，操作模式（自动/Phone/TV/PC）在下",
      HTML.index('data-i18n="uiSpecLbl"') < HTML.index('data-i18n="opModeLbl"'))
check("2b 界面规格档位 = apple / emby / plex", 'const OP_MODES = ["apple", "emby", "plex"];' in THEME)
check("2c 操作模式档位 = auto / phone / tv / pc", 'const UI_MODES = ["auto", "phone", "tv", "pc"];' in THEME)
check("2d 两档标签文案正确",
      'uiSpecLbl: "界面规格"' in STATE and 'opModeLbl: "操作模式"' in STATE
      and STATE.count('uiSpecLbl:') >= 3 and STATE.count('opModeLbl:') >= 3)
check("2e 界面规格段落挂的是 opModeSeg，操作模式段落挂的是 uiModeSeg",
      re.search(r'data-i18n="uiSpecLbl"[\s\S]{0,260}id="opModeSeg"', HTML) is not None
      and re.search(r'data-i18n="opModeLbl"[\s\S]{0,260}id="uiModeSeg"', HTML) is not None)
check("2f 两档独立，互不覆盖（各自只写自己的字段）",
      "settings.opMode = OP_MODES.includes" in THEME and "settings.uiMode = UI_MODES.includes" in THEME
      and "settings.opMode = " not in THEME.split("function setUIMode")[1].split("function")[0])

print("3. 界面规格真实换肤（需求3）")
ICON_NAMES = ["home", "pt", "play", "pause", "prev", "next", "heart", "search", "bell",
              "settings", "palette", "star", "user", "logout", "movie", "music", "book",
              "external", "folder", "more"]
PACK = THEME.split("const OP_ICON_PACK = {")[1]
for mode in ("apple", "emby", "plex"):
    block = PACK.split(f"  {mode}: {{")[1].split("\n  },")[0] if f"  {mode}: {{" in PACK else ""
    missing = [n for n in ICON_NAMES if f"{n}:" not in block]
    check(f"3a {mode} 图标包完整（{len(ICON_NAMES)} 个语义图标）", not missing, f"缺 {missing}")
check("3b 媒体库标签图标随规格替换", "OP_LIB_ICON" in THEME and 'document.querySelectorAll("#topLibTabs .libtab")' in THEME)
check("3c 顶栏标签带 data-lib-kind，重建后重套图标",
      'data-lib-kind="${esc(group)}"' in TOPPANEL and 'data-lib-kind="external"' in TOPPANEL
      and "applyOpModeIcons()" in TOPPANEL)
check("3d 三档顶栏形态各自不同（胶囊 / 方角指示条 / 大写琥珀）",
      'html[data-opmode="apple"] .tn-item, html[data-opmode="apple"] .libtab { border-radius:999px; }' in CSS
      and 'html[data-opmode="emby"] .tn-item.active::after' in CSS
      and 'html[data-opmode="plex"] .tn-item .nl' in CSS)
check("3e data-spec 与 data-opmode 同值落点",
      'root.setAttribute("data-spec", mode)' in THEME and 'root.setAttribute("data-opmode", mode)' in THEME)

print("4. 操作模式交互增强（需求4）")
check("4a 规格与模式都用卡片渲染", 'class="spec-card"' in THEME and 'class="mode-card"' in THEME)
check("4b 卡片带设备图标与一句效果说明", "UI_MODE_ICON" in THEME and "UI_MODE_TAG" in THEME and "OP_MODE_TAG" in THEME)
check("4c 面板有「当前生效」行", 'id="opModeCurrent"' in HTML and 'id="uiModeCurrent"' in HTML
      and 'uiSpecNow' in THEME and 'opModeNow' in THEME)
check("4d 切换后同步选中态与 aria-checked",
      'el.setAttribute("aria-checked", on ? "true" : "false")' in THEME)
check("4e 切换后焦点留在被点卡片（遥控不丢焦点）",
      'card.focus({ preventScroll: true })' in THEME)
check("4f 切换有动效脉冲", "themeTransitionPulse()" in THEME.split("function setUIMode")[1][:900])

print("5. 操作模式固化（需求5）")
check("5a 设置写入带 cookie 镜像", 'vhWriteCookie("vh_mode"' in STATE and 'vhWriteCookie("vh_spec"' in STATE)
check("5b 配额失败先清可重建缓存再重试", "VAULTHUB_EVICTABLE_PATTERNS" in STATE
      and "localStorage.removeItem(key)" in STATE)
check("5c 读取时 cookie 兜底", 'vhReadCookie("vh_mode")' in STATE and 'vhReadCookie("vh_spec")' in STATE)
check("5d 首帧脚本在 <head> 里落 uimode / opmode",
      'root.dataset.uimode = resolvedMode' in HTML and 'root.dataset.opmode = spec' in HTML
      and HTML.index("root.dataset.uimode") < HTML.index("</head>"))
check("5e 首帧脚本带 cookie 兜底", 'vhCookie("vh_mode")' in HTML and 'vhCookie("vh_spec")' in HTML)
check("5f auto 档才按设备识别，手动档不被覆盖",
      'return choice !== "auto" ? choice : detectUIMode();' in THEME)

print("6. 服务器监控自适应栅格（需求6）")
check("6a 监控区改用 monitor-grid",
      'class="grid monitor-grid"' in HTML
      # g-4 仍用于 PT 管理页的统计卡（与监控无关），这里只要求监控区不再是 g-4
      and re.search(r'服务器监控[\s\S]{0,220}class="grid monitor-grid"', HTML) is not None
      and re.search(r'服务器监控[\s\S]{0,220}class="grid g-4"', HTML) is None)
check("6b auto-fit 自适应列（三张一排 / 两列 / 一列）",
      ".grid.monitor-grid { grid-template-columns: repeat(auto-fit" in CSS)
check("6c 旧四列约束不再作用于监控区", ".g-4 { grid-template-columns: repeat(4" in CSS)

print("7. 刷新保留当前页面（需求7）")
check("7a 路由键与持久化函数齐备", 'const VH_ROUTE_KEY = "vaulthub_route";' in STATE
      and "function persistVaultHubRoute" in STATE and "function savedVaultHubRoute" in STATE)
check("7b switchView 里记录当前视图与媒体库 id",
      re.search(r"window\.vaultHubActiveNavKey = navKey;[\s\S]{0,300}persistVaultHubRoute\(", STATE) is not None)
check("7c 启动后恢复上次页面", "function restoreVaultHubRoute" in HOME and "restoreVaultHubRoute()" in BOOT)
check("7d 恢复时带上 libId（同组多库不串页）",
      "libs.find(l => l.id === route.libId)" in HOME)
check("7e 设置页按 tab 恢复", 'openSettingsPage(route.tab || "library")' in HOME)

print("8. 大库反复刷新修复（需求8）")
check("8a 在飞请求复用（同库同页 + 同一宿主节点只跑一条链）",
      "const localFilesInflight = new Map();" in MEDIA
      and "if (running && running.host === host) return running.promise;" in MEDIA)
check("8b 代次号：过期结果丢弃",
      "const localFilesToken" in MEDIA and "token !== localFilesToken[group]" in MEDIA)
check("8c 点回同一个库不重绘整库索引",
      re.search(r"if \(prev === id && host && host\.childElementCount[\s\S]{0,60}return;", MEDIA) is not None)
check("8d 缓存释放行为保留在实现体开头", "releaseMediaHeavyCaches(lib.id)" in MEDIA.split("async function loadLocalFilesInner")[1][:600])

print("9. 已建库可加媒体路径（需求9）")
check("9a 弹窗结构齐备", 'id="libPathModal"' in HTML and 'id="libPathMain"' in HTML and 'id="libPathExtra"' in HTML)
_row = HOME.split('class="row-acts"')[1][:900]
check("9b 入口在「重新扫描」按钮左侧",
      "openLibraryPathEditor" in _row and "rebuildOneLibrary" in _row
      and _row.index("openLibraryPathEditor") < _row.index("rebuildOneLibrary"))
check("9c 主路径只读、附加路径可编辑", 'id="libPathMain" type="text" readonly' in HTML)
check("9d 保存走既有接口（同 id 同 name/type/path + paths）",
      'fetch("/api/media/libraries"' in FEATURES and "paths })" in FEATURES
      and 'method: "POST"' in FEATURES)
check("9e 保存后持久化并重新扫描", "refreshMediaLibraries(false)" in FEATURES and "loadLocalFiles(group, lib, 0)" in FEATURES)
check("9f 三语文案齐备", STATE.count("libPathEdit:") == 3)

print("10. 配置页提示文案清理（需求10）")
GONE_KEYS = ["settingsLead", "setLibExistingHint", "setLibAddHint", "libPathHint",
             "setLibCustomModuleHint", "setLibCustomModuleTip", "opModeDesc", "themeNote",
             "bgHint", "themeAccentHint", "scrapeRegionHint", "scrapeMinMatchHint"]
left = [k for k in GONE_KEYS if f"{k}:" in STATE]
check("10a 语言包里对应键已删干净", not left, f"残留 {left}")
GONE_TEXT = ["系统设置现在是独立配置页", "顶栏只展示这里创建时填写的库名称",
             "先选来源：本地媒体库使用容器内已挂载的绝对路径",
             "路径必须是容器内已挂载且存在的绝对目录",
             "自定义模块用于添加媒体库", "模块的显示 / 隐藏与删除",
             "Apple / Emby / Plex：分别按对应开源客户端的操作手感",
             "自动按设备识别，可手动指定 Phone / TV / PC 布局",
             "提示：图片仅保存在本浏览器 localStorage",
             "主题 = 调色板 × 明暗 × 强调色 三层叠加",
             "环境变量作为首次启动默认值",
             "并发测试固定白名单中的 TMDB",
             "多季剧集按 Plex 命名口径逐季刮削",
             "内置插件生态：<b>Metashark</b>",
             "清晰度与色彩一起调"]
stale = [t for t in GONE_TEXT if t in HTML]
check("10b 入口页里的说明段落已删干净", not stale, f"残留 {stale}")
check("10c 强调色副标题不再渲染", 'swatch-label">${esc(t("themeAccentHint"))}' not in THEME)

print("11. 版本纪律")
check("11a 资源串 ?v=1.0.12 ≥ 12 处", HTML.count("?v=1.0.12") >= 12, HTML.count("?v=1.0.12"))
check("11b 资源版本 / 脚本版本 = 1.0.12",
      'window.VAULTHUB_ASSET_VERSION = "1.0.12";' in HTML and 'const VAULTHUB_SCRIPT_VERSION = "1.0.12";' in STATE)
check("11c 三处标语整串一致",
      HTML.count("v1.0.12 · NFO 补全 · 音乐随点随开 · 大库不卡") == 3)
check("11d 安装/升级脚本版本", 'VERSION="v1.0.12"' in (ROOT / "scripts/install.sh").read_text(encoding="utf-8")
      and 'VERSION="v1.0.12"' in (ROOT / "scripts/upgrade.sh").read_text(encoding="utf-8"))
check("11e 字幕 API UA 升版", "VaultHub-Subtitle/1.0.12" in (ROOT / "subtitle-api/main.go").read_text(encoding="utf-8"))
check("11f Update Log 首行是本版", LOG.splitlines()[0].strip() == "# VaultHub 蜀鼠之家 v1.0.12", LOG.splitlines()[0])
check("11g Release Notes 存在", (ROOT / ".github/RELEASE_NOTES_1.0.4.md").exists())

print("12. 禁用字面量")
SOURCES = [HTML, CSS, STATE, THEME, MEDIA, HOME, BOOT, TOPPANEL, FEATURES, FOCUS]
bad = [pat for pat in (r"enged\.top", r"192\.168\.", r"/vol[1-4]") if any(re.search(pat, s) for s in SOURCES)]
check("12a 源码不含真实域名 / 内网 IP / 宿主卷路径", not bad, f"命中 {bad}")

print(f"\nSUMMARY {count - len(fails)}/{count} PASS")
if fails:
    print("FAIL:", len(fails), "项")
    for f in fails:
        print("  -", f)
    sys.exit(1)
print("v1.0.12 契约测试全部通过")
