#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v0.9.85 顶栏导航布局 + 电子书刊展示页的静态契约。

覆盖三块：
  A. 顶栏导航壳（品牌 / 一级导航 / 媒体库标签 / 全局搜索 / 头像菜单 / 布局切换）
  B. 电子书刊展示页（页头 / 工具栏 / 书架标签 / 喜欢 / 网格密度 / 分页 / 完整展开保证）
  C. 布局令牌回归守卫 —— v0.9.84 重写令牌块时曾弄丢 --topbar-h / --sidebar-w /
     --ebook-font-size，顶栏高度与侧栏宽度当场退化成 auto（顶栏只剩 32px、
     侧栏按静态位置浮在正文上）。这里把三个令牌钉死，防止再次被重写吞掉。
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HTML = (ROOT / "index.html").read_text(encoding="utf-8")
CSS = (ROOT / "web/css/main.css").read_text(encoding="utf-8")
STATE = (ROOT / "web/js/01-state.js").read_text(encoding="utf-8")
MEDIA = (ROOT / "web/js/02-media.js").read_text(encoding="utf-8")
FEATURES = (ROOT / "web/js/03-features.js").read_text(encoding="utf-8")
BOOT = (ROOT / "web/js/04-boot.js").read_text(encoding="utf-8")
HOME = (ROOT / "web/js/05-home.js").read_text(encoding="utf-8")
TOPNAV = (ROOT / "web/js/07-topnav.js").read_text(encoding="utf-8")
NOTES = (ROOT / ".github/RELEASE_NOTES_0.9.90.md").read_text(encoding="utf-8")
LOG = (ROOT / "Update Log.md").read_text(encoding="utf-8")

checks: list[tuple[str, bool, str]] = []


def check(name, cond, detail=""):
    checks.append((name, bool(cond), detail))


HEADER = HTML[HTML.index('<header class="topbar">'):HTML.index("</header>")]

# ---------------------------------------------------------------- A. 顶栏导航
check("A1 顶栏有媒体库标签容器", 'id="topLibTabs"' in HEADER and 'role="tablist"' in HEADER)
# v0.9.94（需求2）：顶栏搜索框缩成放大镜图标，点击弹出搜索弹窗；
# 旧的内联输入框与 kbd 快捷键提示元素都已移除（输入框只存在于弹窗里）。
check("A2 顶栏搜索入口 = 放大镜图标按钮（点击弹窗，旧内联框已移除）",
      'id="tnSearchButton"' in HEADER and "toggleMediaSearchModal()" in HEADER
      and 'id="topSearch"' not in HEADER and 'id="topSearchKbd"' not in HEADER)
# v0.9.93：侧栏移除后「媒体搜索」回到顶栏一级导航。
# v0.9.97（需求2）：顶栏右侧已有放大镜按钮，左侧那个导航项属于重复入口，已移除；
# 搜索入口归一为 #tnSearchButton（A2 已断言），旧书签落点 #view-search 仍会自动弹窗。
check("A3 顶栏一级导航（首页 / PT），媒体搜索入口归一到右侧放大镜",
      all(f'data-topnav="{k}"' in HEADER for k in ["home", "pt"])
      and 'data-topnav="search"' not in HEADER
      and 'id="tnSearchButton"' in HEADER)
check("A4 右上角头像菜单入口", 'id="topUserButton"' in HEADER and 'id="topUserMenu"' in HEADER
      and 'aria-expanded="false"' in HEADER and 'aria-controls="topUserMenu"' in HEADER)
_TOP_MENU = HEADER[HEADER.index('id="topUserMenu"'):]
# v0.9.93：侧栏移除后自定义模块入口回到头像菜单（同时顶层标签也渲染自定义模块）。
check("A5 头像菜单含系统设置/外观主题/自定义模块/账户/退出",
      all(f"topUserMenuGo('{t}')" in _TOP_MENU for t in ["library", "look", "account"])
      and "topUserMenuModules()" in _TOP_MENU
      and "自定义模块" in _TOP_MENU
      and "topUserMenuLogout()" in _TOP_MENU
      and 'id="setLibCustomModule"' in HTML and 'onclick="openModuleModal()"' in HTML)
check("A6 品牌与信息区仍在（旧契约不破）",
      'id="accountWrap"' in HEADER and 'id="topScanStat"' in HEADER
      and HEADER.index('id="accountWrap"') < HEADER.index('class="tb-info"'))
check("A7 独立脚本 07-topnav.js 已挂载且在主题引擎之后",
      "/web/js/07-topnav.js?v=0.9.98" in HTML
      and HTML.index("06-theme.js") < HTML.index("07-topnav.js") < HTML.index("03-audio-zoom.js"))
check("A8 顶栏渲染器读真实媒体库并保序渲染",
      "function renderTopLibTabs()" in TOPNAV and "localMediaLibraries" in TOPNAV
      and "externalServices" in TOPNAV)
check("A9 标签用 data-nav-key 区分同组媒体库",
      'data-nav-key="${esc(group + ":" + lib.id)}"' in TOPNAV
      and "tab.dataset.navKey === key" in TOPNAV)
check("A10 标签点击复用既有打开函数",
      "openHomeLibrary('${esc(group)}',${jsAttrArg(lib.id)})" in TOPNAV
      and "openExternalService(${jsAttrArg(svc.id)})" in TOPNAV)
check("A11 scrollIntoView 有 typeof 守卫", "typeof tab.scrollIntoView === \"function\"" in TOPNAV)
# v0.9.95（安全审查 N-3）：随旧顶栏搜索框一起失效的「输入即过滤当前视图」链路已整体删除
# （过滤词只由被删掉的内联处理器赋值 → 恒为空串），搜索改由弹窗的服务端检索承担。
check("A12 全局搜索走弹窗：输入框指向弹窗、过滤链路已删除",
      'id="mediaSearchInput"' in HTML
      and "function topNavSearchBox() { return document.getElementById(\"mediaSearchInput\"); }" in TOPNAV
      and "function applyTopSearchFilter(" not in TOPNAV and "tn-search-hidden" not in TOPNAV
      and "function runTopSearchGo(" not in TOPNAV and "function onTopSearchInput(" not in TOPNAV
      and "function onTopSearchKey(" not in TOPNAV and "topNavSearchQuery" not in TOPNAV)
check("A12b 弹窗检索链仍在（打开/关闭/输入即搜/回车）",
      "function openMediaSearchModal(" in TOPNAV and "function closeMediaSearchModal(" in TOPNAV
      and "function toggleMediaSearchModal(" in TOPNAV
      and 'oninput="scheduleMediaSearch()"' in HTML
      and "runMediaSearch()}else if(event.key==='Escape'){closeMediaSearchModal()}" in HTML)
check("A13 ⌘K / Ctrl+K 聚焦搜索框", 'String(event.key).toLowerCase() === "k"' in TOPNAV and "event.metaKey" in TOPNAV)
# v0.9.93：侧栏已彻底移除 —— 布局收敛为顶栏一种（不再有可切回的侧边导航）。
check("A14 布局只剩顶栏一种",
      "function currentLayoutMode() { return \"topnav\"; }" in TOPNAV
      and 'document.body.classList.add("layout-topnav");' in TOPNAV
      and "function setLayoutMode(mode)" not in TOPNAV and "renderLayoutChips" not in TOPNAV)
# v0.9.93：settings.layout 不再被读取（本地保存的旧偏好自然失效）。
check("A15 settings 里不再有 layout 字段（旧偏好不再被读取）",
      'layout: "topnav"' not in STATE and 'settings.layout' not in STATE
      and 's.layout ===' not in STATE)
check("A16 switchView 同步顶栏高亮与一级导航",
      "if (typeof syncTopLibTabs === \"function\") syncTopLibTabs(navKey);" in STATE
      and "if (typeof syncTopNavView === \"function\") syncTopNavView(\"view-\" + v);" in STATE)
check("A17 媒体库导航刷新时重建顶栏标签",
      "if (typeof renderTopLibTabs === \"function\") renderTopLibTabs();" in HOME
      and "function renderLibraryNav()" in HOME)
check("A18 启动时初始化顶栏（typeof 守卫）", "if (typeof initTopNav === \"function\") initTopNav();" in BOOT)
check("A19 模块开关作用于顶栏一级导航",
      'document.querySelectorAll(".tn-item[data-module]").forEach(item => {' in FEATURES)
check("A20 语言切换重绘顶栏标签与自定义模块标签",
      "if (typeof renderLayoutChips === \"function\") renderLayoutChips();" not in FEATURES
      and "if (typeof renderTopLibTabs === \"function\") renderTopLibTabs();" in FEATURES)
# v0.9.93：系统设置里的「UI 设置」（布局 / 侧栏两节）已按要求移除。
check("A21 设置页不再有布局切换入口",
      'id="layoutModeChips"' not in HTML and 'data-layout="sidebar"' not in HTML
      and 'data-i18n="setLayout"' not in HTML and 'data-i18n="setSidebar"' not in HTML)
check("A22 顶栏样式齐备",
      all(sel in CSS for sel in [".tn-wrap {", ".tn-nav {", ".libtab {", '.libtab[aria-current="true"] {',
                                 # v0.9.94：搜索框样式换成图标按钮样式（过滤态类名保留）。
                                 ".tn-icon-btn {", ".tn-icon-btn:hover {", ".tn-avatar {", ".tn-pop {",
                                 ".tn-popitem {", ".tn-search-hidden {"])
      and ".tn-search {" not in CSS)
check("A23 侧栏占位恒为 0（含遮罩左边界）",
      "--sidebar-w: 0px;" in CSS and "body.layout-topnav" not in CSS
      and "body.sidebar-hidden" not in CSS and ".sidebar {" not in CSS)

# ---------------------------------------------------------------- B. 书刊展示页
check("B1 三个书架标签（书架/喜欢/历史阅读）—— v0.9.84 未读改名书架、移除全部",
      all(f'id: "{i}"' in MEDIA for i in ["shelf", "like", "completed"])
      and 'label: "书架"' in MEDIA and 'label: "🕘 历史阅读"' in MEDIA and 'label: "喜欢"' in MEDIA
      and '{ id: "all", label: "全部" }' not in MEDIA)
check("B2 页头：库名 + 本视图/全库 + 路径 + 扫描时间",
      "<h1>${esc(lib.name)}</h1>" in MEDIA and "本视图 <b>${Number(total) || 0}</b>" in MEDIA
      and "全库 <b>${Number((counts && counts.all) || 0)}</b>" in MEDIA
      and "function bookScanLabel(lib)" in MEDIA and 'class="pn-head"' in MEDIA)
check("B3 工具栏：分段标签 + 排序 + 密度 + 视图设置",
      'class="pn-toolbar"' in MEDIA and 'class="seg" role="tablist"' in MEDIA
      and "function cycleBookSort()" in MEDIA and "function cycleBookDensity()" in MEDIA
      and "function toggleBookViewSettings(event)" in MEDIA)
check("B4 视图设置含分页浏览 / 网格密度 / 封面收藏按钮",
      "分页浏览" in MEDIA and "网格密度" in MEDIA and "封面收藏按钮" in MEDIA
      and "function setBookPageSize(size)" in MEDIA and "function setBookCols(cols)" in MEDIA)
check("B5 默认完整展开（v0.9.70 保证不被分页吞掉）",
      "paged: false" in MEDIA and "function bookShelfWindowSlice" in MEDIA
      and 'return { pageFiles: list, more: "" };' in MEDIA
      and "继续加载（已显示" in MEDIA and "已展开全部" in MEDIA)
check("B6 分页为本地切片，翻页不重新请求",
      "function gotoBookShelfPage(page)" in MEDIA and "function renderBookShelfPage()" in MEDIA
      and "bookShelfVisibleCache" in MEDIA)
check("B7 整库索引缓存（含 60 秒新鲜度与媒体库变化失效）",
      # v0.9.90：索引缓存的写入已随渲染逻辑搬进 renderComicShelf()。
        "bookShelfIndexCache[lib.id] = { at: Date.now(), files }" in MEDIA
      and "(Date.now() - Number(cached.at || 0)) > 60000" in MEDIA
      and "bookShelfIndexCache = {};" in MEDIA and "bookShelfCountsCache = {};" in MEDIA)
check("B8 分页器带页码直跳与统计",
      'class="pg" type="button" aria-current=' in MEDIA and 'class="pg nav"' in MEDIA
      and "每页 ${size} · 共 ${count} ${unit}" in MEDIA)
check("B9 卡片封面带喜欢按钮、元信息带阅读入口",
      "const favBtn = prefs.showFav" in MEDIA and "${releaseBtn}${favBtn}" in MEDIA
      and 'class="book-card-fav ' in MEDIA and "toggleBookFavorite(" in MEDIA
      and 'class="book-card-open"' in MEDIA and "继续读 ›" in MEDIA)
check("B10 喜欢写入本浏览器并要求按钮状态即时更新",
      'BOOK_FAVORITES_KEY = "vaultHubBookFavorites"' in MEDIA and "function readBookFavorites()" in MEDIA
      and "btn.classList.toggle(\"on\", !wasOn)" in MEDIA)
check("B11 喜欢视图里取消收藏立刻移出列表",
      'if (bookShelfTab === "like") refreshBookShelf();' in MEDIA)
check("B12 旧入口 setComicShelfView 委托到标签（历史阅读语义保留）",
      'function setComicShelfView(view) {' in MEDIA and 'setBookShelfTab(view === "completed" ? "completed" : "shelf");' in MEDIA)
check("B13 标签过滤仍按阅读进度阈值",
      'if (bookShelfTab === "completed") return progress >= COMPLETED_PROGRESS;' in MEDIA
      and "return progress < COMPLETED_PROGRESS;" in MEDIA)
check("B14 排序支持名称 / 添加时间 / 文件大小（真实字段）",
      'id: "mtime", label: "按添加时间"' in MEDIA and 'id: "size", label: "按文件大小"' in MEDIA
      and "Number(b.mtime || 0) - Number(a.mtime || 0)" in MEDIA
      and "Number(b.size || 0) - Number(a.size || 0)" in MEDIA)
check("B15 网格密度写内联变量并重渲染",
      'style="--cols:${Number(prefs.cols) || 5}"' in MEDIA
      and 'grid.style.setProperty("--cols", String(n));' in MEDIA)
check("B16 书刊页样式齐备",
      all(sel in CSS for sel in [".pn-head {", ".pn-meta {", ".pn-toolbar {", ".seg {", ".tbtn {",
                                 ".viewset {", '.viewset.open {', ".chips {", ".book-grid {",
                                 ".pager .pg {", '.pager .pg[aria-current="page"] {', ".book-card-fav {"]))
check("B17 历史阅读释放按钮仍在卡片上",
      'class="book-card-release"' in MEDIA and "releaseBookFromHistory(" in MEDIA)

# ---------------------------------------------------------------- C. 令牌回归守卫
# v0.9.93：侧栏移除后 --sidebar-w 恒为 0（仍必须是显式定义的令牌，不能丢）。
for token, value in [("--topbar-h", "52px"), ("--sidebar-w", "0px"), ("--ebook-font-size", "17px")]:
    check(f"C 布局令牌 {token} 已定义（{value}）",
          f"{token}: {value};" in CSS,
          f"v0.9.84 曾漏掉 {token}，顶栏/侧栏会当场塌掉")
check("C CSS 花括号平衡", CSS.count("{") == CSS.count("}"), f"{CSS.count('{')} vs {CSS.count('}')}")
# 切回侧栏时顶栏不该把媒体库/主导航再铺一遍（侧栏已经提供了同样的入口）
# v0.9.93：只剩顶栏一种布局，不可能再出现「侧栏 + 顶栏两套入口」；
# 原先为侧栏模式写的条件隐藏规则也随之一并删除。
check("C 不再有「非顶栏模式隐藏顶栏导航」的条件规则",
      "body:not(.layout-topnav)" not in CSS and ".sidebar" not in CSS,
      "侧栏移除后这些规则属于死代码")

# ---------------------------------------------------------------- D. 文档与版本
check("D1 发布说明存在且包含本版修正（发布说明随版本推进）",
      # v0.9.90：大库响应修复（三条链路）+ 转码提示移入获取信息 + 刮削命名跟随语言。
      ("184,693" in NOTES or "18.4 万" in NOTES or "37 万" in NOTES)
      and "获取信息" in NOTES and "转码" in NOTES
      and "show_title" in NOTES and "语言" in NOTES)
check("D2 Update Log 有对应条目", "持续登录" in LOG and "通知喇叭" in LOG and "硬盘和网络" in LOG and "v0.9.98" in LOG)
check("D3 版本号为 0.9.90",
      'VAULTHUB_ASSET_VERSION = "0.9.98"' in HTML and 'VAULTHUB_SCRIPT_VERSION = "0.9.98"' in STATE
      and "?v=0.9.98" in HTML and "?v=0.9.78" not in HTML)

fails = [(n, d) for n, ok, d in checks if not ok]
for n, ok, d in checks:
    print(("PASS: " if ok else "FAIL: ") + n + (f" | {d}" if d and not ok else ""))
print(f"\nSUMMARY {len(checks) - len(fails)}/{len(checks)} PASS")
if fails:
    raise SystemExit("v0.9.85 契约测试未通过")
print("v0.9.85 顶栏导航 + 书刊展示页契约测试通过")
