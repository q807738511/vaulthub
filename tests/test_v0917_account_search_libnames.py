#!/usr/bin/env python3
"""v0.9.30 契约测试

1. 顶栏左上角 logo 的登录状态 / 关于 / 退出登录迁移到 系统设置 → 账户与登录
2. Caddy 配置入口迁移到 账户与登录（不再有独立 Caddy 标签页）
3. 外观与主题中移除模块设置入口
4. 主导航「媒体搜索」直接搜索媒体库，不再打开系统设置
5. 媒体库标题使用媒体库添加时填写的库名称，不使用预设大类名
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HTML = (ROOT / "index.html").read_text(encoding="utf-8")
STATE = (ROOT / "web/js/01-state.js").read_text(encoding="utf-8")
JS = (ROOT / "web/js/02-media.js").read_text(encoding="utf-8")
FEATURES = (ROOT / "web/js/03-features.js").read_text(encoding="utf-8")
CSS = (ROOT / "web/css/main.css").read_text(encoding="utf-8")
GO = (ROOT / "media-go/main.go").read_text(encoding="utf-8")
COMPOSE = (ROOT / "docker-compose.yml").read_text(encoding="utf-8")

HEADER = HTML[HTML.index('<header class="topbar">'):HTML.index("</header>")]
ACCOUNT = HTML[HTML.index('id="setpanel-account"'):HTML.index('id="customViews"')]
LOOK = HTML[HTML.index('id="setpanel-look"'):HTML.index('id="setpanel-scrape"')]
SIDEBAR = HTML[HTML.index('<aside class="sidebar"'):HTML.index("</aside>")]

# ---------------------------------------------------------------- 1. 顶栏账户菜单迁移
assert 'id="accountMenu"' not in HTML, "顶栏账户下拉菜单必须删除"
assert "toggleAccountMenu" not in HTML and "toggleAccountMenu" not in STATE, "logo 菜单开关必须删除"
assert "closeAccountMenu" not in STATE and "openAccountMenuItem" not in STATE, "账户菜单辅助函数必须删除"
assert "logoutVaultHub()" not in HEADER, "退出登录不能留在顶栏"
assert "aboutModal" not in HEADER, "关于不能留在顶栏"
assert 'class="logo account"' not in HEADER, "顶栏 logo 不再是账户菜单容器"

# 登录状态 / 关于 / 退出登录都在账户与登录页
assert 'id="accountName"' in ACCOUNT and 'id="accountState"' in ACCOUNT, "账户与登录页必须展示登录状态"
assert 'id="sessionStatusBadge"' in ACCOUNT, "账户与登录页必须保留会话徽标"
assert "openModal('aboutModal')" in ACCOUNT, "账户与登录页必须提供关于入口"
assert "logoutVaultHub()" in ACCOUNT, "账户与登录页必须提供退出登录"
assert "getElementById('accountState')" in STATE, "登录状态必须由 renderSessionStatus 渲染"
assert "function openAccountSettings()" in STATE, "需要直接打开账户与登录页的入口函数"

# ---------------------------------------------------------------- 2. Caddy 迁移
assert 'id="setpanel-caddy"' not in HTML, "独立的 Caddy 设置面板必须删除"
assert 'data-settab="caddy"' not in HTML, "Caddy 标签页必须删除"
assert "switchSetTab('caddy')" not in STATE and 'switchSetTab("caddy")' not in STATE, "不能再切换到 caddy 标签"
assert "openCaddyPage()" in ACCOUNT, "Caddy 配置入口必须在账户与登录页"
assert 'id="caddyRouteCount"' in ACCOUNT, "Caddy 路由计数徽标必须随入口迁移"
assert 'id="caddyPage"' in HTML and 'id="caddyFile"' in HTML, "Caddyfile 独立整页编辑器必须保留"
assert 'if (key === "account") { refreshSessionStatus(false); loadCaddyConfig(); }' in STATE, \
    "进入账户与登录页必须同时刷新会话状态与 Caddyfile"
assert "openSettingsPage('account')" in STATE, "openCaddyModal 必须打开账户与登录页"

# ---------------------------------------------------------------- 3. 外观与主题移除模块设置
assert "openModuleModal" not in LOOK, "外观与主题不能再包含模块设置入口"
assert "boardTitle" not in LOOK and "setModuleOpen" not in LOOK, "外观与主题不能残留模块设置文案"
assert 'onclick="openModuleModal()"' in SIDEBAR, "模块设置改由侧栏自定义分组进入"
assert 'id="boardModal"' in HTML, "模块设置弹窗本身必须保留"
assert 'customHeader.style.display = ""' in FEATURES, "自定义分组标题必须常显，模块设置才有入口"

# ---------------------------------------------------------------- 4. 媒体搜索真正搜索媒体库
assert "openMediaSearchSettings" not in STATE and "openMediaSearchSettings" not in HTML, \
    "点击媒体搜索不能再直接进入系统设置"
assert 'id="view-search"' in HTML, "需要独立的媒体搜索视图"
assert 'id="mediaSearchInput"' in HTML and 'id="mediaSearchResults"' in HTML, "媒体搜索需要输入框与结果区"
assert 'onclick="openMediaSearch()"' in SIDEBAR, "侧栏媒体搜索必须调用 openMediaSearch"
assert 'data-view="search"' in SIDEBAR, "侧栏媒体搜索必须指向 search 视图"
for fn in ["function openMediaSearch()", "function runMediaSearch()", "function clearMediaSearch()",
           "function scheduleMediaSearch()", "function openMediaSearchHit("]:
    assert fn in JS, f"媒体搜索缺少 {fn}"
assert 'switchView("search")' in JS, "媒体搜索必须切到搜索视图"
assert "/api/media/files?id=${encodeURIComponent(lib.id)}&q=${encodeURIComponent(query)}" in JS, \
    "媒体搜索必须走后端 q 参数查询索引"
assert "jsAttrArg(group)" in JS and "jsAttrArg(path)" in JS, "搜索结果内联参数必须转义"
for key in ["searchTitle", "searchRun", "searchClear", "searchRunning", "searchEmpty", "searchHits", "navMediaSearch"]:
    assert key in STATE, f"媒体搜索文案缺少 i18n key: {key}"

# 后端：q 走参数化 LIKE，并对 LIKE 通配符转义
assert 'q := strings.TrimSpace(r.URL.Query().Get("q"))' in GO, "后端必须支持 q 查询参数"
assert "func sqliteLikeEscape(s string) string" in GO, "LIKE 查询必须转义通配符"
assert "lower(path) LIKE ? ESCAPE" in GO, "LIKE 查询必须参数化并声明 ESCAPE"
assert 'strings.ToLower(sqliteLikeEscape(q))' in GO, "查询词必须先转义再小写"

# ---------------------------------------------------------------- 5. 媒体库标题使用库名称
assert "function mediaLibraryHeading(lib" in JS, "需要统一的媒体库标题渲染函数"
assert "String(lib?.name" in JS, "标题必须取媒体库名称"
assert "mediaLibraryHeading(lib" in JS, "各媒体库渲染必须使用该标题函数"
assert JS.count("mediaLibraryHeading(lib") >= 5, "电影/剧集/书刊/音乐都要使用库名称标题"
for preset in ["<h3>电影</h3>", "<h3>电视剧集</h3>", "<h3>音乐与 MV</h3>"]:
    assert preset not in JS, f"标题不能写死预设大类名: {preset}"
assert '"电子书" : "漫画"' not in JS, "书刊标题不能按预设大类渲染"

# ---------------------------------------------------------------- 版本与发布引用
assert "v0.9.53" in HTML and HTML.count("v0.9.53") >= 2, "关于与侧栏版本必须是 v0.9.53"
assert 'VAULTHUB_ASSET_VERSION = "0.9.53"' in HTML, "资源版本必须是 0.9.53"
assert 'VAULTHUB_SCRIPT_VERSION = "0.9.53"' in STATE, "脚本版本必须是 0.9.53"
assert "ghcr.io/q807738511/vaulthub:latest" in COMPOSE, "v0.9.53 起 Compose 跟随 latest"
assert (ROOT / ".github/RELEASE_NOTES_0.9.53.md").exists(), "缺少 v0.9.53 release notes"

# 历史契约不能回退
assert 'if (group === "movie" && data.has_more)' in JS, "影视库全量加载不能回退"
assert "function enterMovieDetailSidebarMode()" in STATE, "详情页侧栏收起不能回退"
assert "MEDIA_FORMATS.book" in JS and "MEDIA_FORMATS.comic" in JS, "书刊格式识别不能回退"
assert ".audio-player { position:fixed" in CSS and "transform:translateX(-50%)" in CSS, "播放器居中不能回退"
assert 'id="audioFavoriteButton"' in HTML, "播放器喜欢按钮不能回退"

print("PASS: v0.9.30 账户与登录聚合、Caddy 迁移、模块设置移出外观、媒体搜索直查、媒体库名称标题")
