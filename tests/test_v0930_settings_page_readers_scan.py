#!/usr/bin/env python3
"""v0.9.30 契约测试

1. 系统设置改为独立配置页（不再是 <dialog> 弹窗）
2. 媒体库添加：子类型 / 媒体路径 / 库名称 / 添加按钮都在大类卡片里，去掉底部额外配置表单
3. 媒体库扫描深度加深：穿透符号链接目录，可配置递归上限
4. 漫画（ZIP/CBZ）阅读铺满阅读区且进度可保存 / 恢复
5. 电子书阅读区内容驱动高度且进度可保存 / 恢复
6. 媒体库操作按钮文案：刮削 → 扫描
7. 电子书阅读主题：亮色 / 自定义主题下整页跟随主题
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HTML = (ROOT / "index.html").read_text(encoding="utf-8")
STATE = (ROOT / "web/js/01-state.js").read_text(encoding="utf-8")
JS = (ROOT / "web/js/02-media.js").read_text(encoding="utf-8")
FEATURES = (ROOT / "web/js/03-features.js").read_text(encoding="utf-8")
HOME = (ROOT / "web/js/05-home.js").read_text(encoding="utf-8")
CSS = (ROOT / "web/css/main.css").read_text(encoding="utf-8")
GO = (ROOT / "media-go/main.go").read_text(encoding="utf-8")
WALK = (ROOT / "media-go/scan_walk.go").read_text(encoding="utf-8")
PROGRESS = (ROOT / "media-go/reading_progress.go").read_text(encoding="utf-8")
COMPOSE = (ROOT / "docker-compose.yml").read_text(encoding="utf-8")
ENVFILE = (ROOT / "vaulthub.env").read_text(encoding="utf-8")

SETTINGS = HTML[HTML.index('id="view-settings"'):HTML.index('id="customViews"')]
LIBRARY = HTML[HTML.index('id="setpanel-library"'):HTML.index('id="setpanel-look"')]

# ---------------------------------------------------------------- 1. 独立配置页
assert '<section class="view settings-view" id="view-settings">' in HTML, "系统设置必须是独立配置页 section"
assert "<dialog" not in HTML and "</dialog>" not in HTML, "系统设置不能再使用 dialog 弹窗"
assert 'id="settingsModal"' not in HTML, "settingsModal 容器必须删除"
assert "#settingsModal" not in CSS, "settingsModal 相关样式必须删除"
assert "function openSettingsPage(" in STATE and "function closeSettingsPage(" in STATE, "缺少配置页开关函数"
assert 'switchView("settings")' in STATE, "打开系统设置必须切到 settings 视图"
assert "function openSettingsModalFromSidebar() { openSettingsPage(); }" in STATE, "侧栏设置按钮必须打开配置页"
assert "openSettingsPage(\"account\")" in STATE, "账户入口必须直达账户与登录页"
assert 'onclick="closeSettingsPage()"' in SETTINGS, "配置页必须有返回入口"
assert "settingsReturnView" in STATE, "关闭配置页要回到进入前的视图"
assert ".settings-view .setpanel" in CSS, "配置页面板需要独立样式"
assert 'closeModal(\'settingsModal\')' not in STATE and 'closeModal("settingsModal")' not in JS, "不能再关闭已删除的设置弹窗"
for tab in ("library", "look", "scrape", "account"):
    assert f'id="setpanel-{tab}"' in HTML, f"配置页缺少 {tab} 面板"

# ---------------------------------------------------------------- 2. 媒体库添加逻辑
for group in ("comic", "movie", "audio"):
    assert f'id="homeLibType-{group}"' in LIBRARY, f"{group} 卡片缺少子类型下拉"
    assert f'id="homeLibPath-{group}"' in LIBRARY, f"{group} 卡片缺少媒体路径输入"
    assert f'id="homeLibName-{group}"' in LIBRARY, f"{group} 卡片缺少库名称输入"
    assert f"addHomeMediaLibrary('{group}')" in LIBRARY, f"{group} 卡片缺少添加按钮"
assert 'id="homeLibGroup"' not in HTML, "公共「媒体大类」下拉必须删除"
assert 'id="homeLibType"' not in HTML and 'id="homeLibPath"' not in HTML and 'id="homeLibName"' not in HTML, \
    "卡片下方的额外配置表单必须删除"
local_src = LIBRARY[LIBRARY.index('id="libSrc-local"'):LIBRARY.index('id="libSrc-external"')]
assert 'class="lib-form"' not in local_src, "本地来源不能再保留底部公共表单"
assert 'class="lib-kind-form"' in local_src and local_src.count('class="lib-kind-form"') == 3, \
    "三个大类卡片都要内置自己的表单"
assert "function syncHomeLibTypes(group)" in HOME, "子类型同步必须按大类"
assert "function activeLibKindGroup(" in HOME, "需要解析当前选中的大类卡片"
assert 'document.getElementById("homeLibType-" + g)' in HOME, "添加逻辑必须读卡片内的子类型"
assert '.lib-kind-form' in CSS, "卡片内表单需要样式"
assert 'event.target.closest(".lib-kind-form")' in HOME, "点击卡片内控件不能被当成切换大类"

# ---------------------------------------------------------------- 3. 扫描深度
assert "func walkLibraryFiles(" in WALK, "缺少深度扫描 walker"
assert "walkMultiLibraryFiles(ctx, scanPaths, scanMaxDepth()" in GO, "扫描必须走多路径 walker（v0.9.52）"
assert "return walkLibraryFiles(ctx, roots[0], maxDepth, emit)" in WALK, "单路径库必须退化为无前缀扫描"
assert "filepath.Walk(l.Path" not in GO, "不能再使用 lstat 语义的 filepath.Walk"
assert "os.Stat(full)" in WALK, "必须用 Stat 穿透符号链接"
assert "filepath.EvalSymlinks(full)" in WALK, "链接必须解析成真实路径"
assert "func allowedRealPath(" in WALK, "需要统一的路径边界判定"
assert "allowedRealPath(realRoot, real)" in WALK, "扫描必须校验解析后的路径边界"
assert "allowedRealPath(rootReal, resolved)" in GO, "safeFile 必须使用同一套边界判定"
assert "func mediaRootBoundary(" in WALK and 'mediaRootPath = env("MEDIA_ROOT"' in GO, \
    "符号链接边界必须来自 MEDIA_ROOT 挂载点"
assert 'raw == "" || raw == "/"' in WALK, "空或根路径不能成为边界"
assert "ancestors[real]" in WALK, "必须按递归路径去重以防符号链接成环"
assert "MEDIA_SCAN_MAX_DEPTH" in WALK and "MEDIA_SCAN_MAX_DEPTH" in ENVFILE, "递归上限必须可配置"
assert "defaultScanMaxDepth = 32" in WALK, "默认递归上限为 32"

# ---------------------------------------------------------------- 4/5. 阅读器铺满 + 进度
assert ".comic-archive-pages {" in CSS and "flex-direction:column" in CSS, "漫画页容器必须整页竖排"
assert ".comic-archive-pages img" in CSS and "max-height:none" in CSS, "漫画页不能被压成一屏高"
assert ".media-reader-overlay.reader-doc > .media-reader-body" in CSS, "文档阅读器正文必须内容驱动高度"
assert "reader-doc" in JS, "文档阅读器必须带 reader-doc 标记"
assert "opts.doc === true" in JS, "reader-doc 只能给文档类阅读器"
assert "function restoreReaderProgress(" in JS, "缺少阅读位置恢复"
assert "restoreReaderProgress(viewer, lib.id, path)" in JS and JS.count("restoreReaderProgress(viewer") >= 2, \
    "漫画与电子书都要恢复阅读位置"
assert "readerRestoring" in JS and "if (readerRestoring) return;" in JS, "恢复期间不能把进度覆盖成 0"
# 阅读进度服务端持久化
assert '"/api/media/reading/progress"' in GO, "缺少阅读进度接口路由"
assert "func (a *App) readingProgress(" in PROGRESS, "缺少阅读进度处理器"
assert "if !writeAuth(r)" in PROGRESS, "阅读进度接口必须要求有效会话"
assert "safeFile(lib, mediaPath)" in PROGRESS, "阅读进度必须校验媒体路径"
assert "MEDIA_READING_PROGRESS" in PROGRESS and "MEDIA_READING_PROGRESS" in ENVFILE, "阅读进度存储路径必须可配置"
assert "function loadReadingProgress(" in JS or "async function loadReadingProgress(" in JS, "前端必须读回服务端进度"
assert "/api/media/reading/progress?id=" in JS, "前端必须调用阅读进度接口"
assert "flushReadingProgressNow" in JS and "flushReadingProgressNow" in FEATURES, "关闭阅读器要立即落盘进度"
assert 'if (group === "comic") await loadReadingProgress(lib.id)' in JS, "书架分类前必须先拉取服务端进度"

# ---------------------------------------------------------------- 6. 扫描文案
assert "libRescanAll" in STATE and "libRescrape" not in STATE, "全部重新扫描文案必须替换刮削"
assert "actRescan" in STATE and "actRescrape" not in STATE, "单库重新扫描文案必须替换刮削"
assert 'data-i18n="libRescanAll"' in HTML, "按钮必须绑定新文案 key"
assert "全部重新刮削" not in HTML and "全部重新刮削" not in STATE, "不能再出现「全部重新刮削」"
assert 't("actRescan")' in HOME, "媒体库行按钮必须用新文案"
assert "已触发全部媒体库重新扫描" in HOME and "已触发重新扫描" in HOME, "toast 文案必须改为扫描"
assert "扫描状态" in HTML, "表头必须是扫描状态"

# ---------------------------------------------------------------- 7. 阅读主题
assert ".media-reader-overlay.reader-theme-light .media-reader-body" in CSS, "亮色主题正文区必须跟随主题"
assert ".media-reader-overlay.reader-theme-custom .media-reader-body" in CSS, "自定义主题正文区必须跟随主题"
assert "readerThemeClass()" in JS, "阅读器必须应用主题类"

# ---------------------------------------------------------------- 版本与发布引用
assert HTML.count("v0.9.52") >= 2, "关于与侧栏版本必须是 v0.9.52"
assert 'VAULTHUB_ASSET_VERSION = "0.9.52"' in HTML, "资源版本必须是 0.9.52"
assert 'VAULTHUB_SCRIPT_VERSION = "0.9.52"' in STATE, "脚本版本必须是 0.9.52"
assert "ghcr.io/q807738511/vaulthub:latest" in COMPOSE, "v0.9.52 起 Compose 跟随 latest"
assert (ROOT / ".github/RELEASE_NOTES_0.9.52.md").exists(), "缺少 v0.9.52 release notes"

# ---------------------------------------------------------------- 历史契约不回退
assert 'id="view-search"' in HTML and "function runMediaSearch()" in JS, "媒体搜索不能回退"
assert "function mediaLibraryHeading(lib" in JS, "媒体库名称标题不能回退"
assert 'id="caddyPage"' in HTML and "openCaddyPage()" in HTML, "Caddy 整页编辑器不能回退"
assert 'id="audioFavoriteButton"' in HTML, "播放器喜欢按钮不能回退"
assert ".audio-player { position:fixed" in CSS and "transform:translateX(-50%)" in CSS, "播放器居中不能回退"
assert "MEDIA_FORMATS.book" in JS and "MEDIA_FORMATS.comic" in JS, "书刊格式识别不能回退"
assert 'if (group === "movie" && data.has_more)' in JS, "影视库全量加载不能回退"

print("PASS: v0.9.30 独立配置页、卡片式媒体库添加、深度扫描、漫画/电子书铺满与进度持久化、扫描文案、阅读主题")
