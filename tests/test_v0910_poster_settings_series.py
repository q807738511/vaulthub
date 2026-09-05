from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HTML = (ROOT / "index.html").read_text(encoding="utf-8")
CSS = (ROOT / "web/css/main.css").read_text(encoding="utf-8")
JS = (ROOT / "web/js/02-media.js").read_text(encoding="utf-8")
STATE = (ROOT / "web/js/01-state.js").read_text(encoding="utf-8")
COMPOSE = (ROOT / "docker-compose.yml").read_text(encoding="utf-8")
SYNC = (ROOT / ".github/workflows/sync-dockerhub-to-ghcr.yml").read_text(encoding="utf-8")

# 1. 影视详情背景必须优先使用读取到的 poster；poster 存在时不再套用主题 no-art 背景。
assert "function movieHeroArt(meta)" in JS
assert "const heroArt = movieHeroArt(meta);" in JS
assert 'heroArt.kind' in JS and 'poster-art' in JS and 'backdrop-art' in JS
assert "meta.poster" in JS and "meta.backdrop" in JS
assert ".movie-detail-hero.poster-art" in CSS
assert ".movie-detail-hero.poster-art::before" in CSS
assert "background-image:var(--movie-hero-art" in CSS

# 2. 系统设置按钮迁移到侧边栏底部，位于版本上方，跟随侧栏折叠/缩放。
header = HTML[HTML.index('<header class="topbar">'):HTML.index('</header>')]
sidebar = HTML[HTML.index('<aside class="sidebar"'):HTML.index('</aside>')]
foot = HTML[HTML.index('<div class="sidebar-foot">'):HTML.index('</div>\n</aside>')]
assert "openAccountMenuItem('settingsModal')" not in header
assert 'id="sidebarSettingsButton"' in sidebar
assert 'onclick="openSettingsModalFromSidebar()"' in sidebar
assert foot.index('id="sidebarSettingsButton"') < foot.index('class="ver"')
assert "function openSettingsModalFromSidebar()" in STATE
assert ".rail-settings" in CSS and ".sidebar-foot-row" in CSS
assert "body.sidebar-hidden .rail-settings" in CSS

# 3. 电视剧集按 Plex/Emby 风格聚合：不再每集外层单独展示卡片。
assert "function parseSeriesEpisode(path)" in JS
assert "function buildSeriesShows(files)" in JS
assert "function renderSeriesLibraryContent(host, lib, files)" in JS
assert "function renderSeriesShowCard(lib, show)" in JS
assert "function openSeriesDetails(libId, showKey)" in JS
assert "function scrapeSeriesMetadata(host, lib, files)" in JS
assert "renderSeriesLibraryContent(host, lib, files)" in JS
assert "files.map(file => renderMoviePoster(lib, file))" in JS
assert "lib?.type === \"series\"" in JS
assert ".series-show-grid" in CSS and ".series-season-block" in CSS and ".series-episode-row" in CSS
assert "data-series-show" in JS
assert "S01E01" in JS and "Season 01" in JS

# 4. v0.9.54 发布引用与增量同步工作流。
assert 'v0.9.54' in HTML
assert 'ghcr.io/q807738511/vaulthub:latest' in COMPOSE
# v0.9.30：摘要比较改为两端统一的 registry HEAD（Docker Hub 会为不接受 OCI 的
# 客户端即时转换 manifest，skopeo inspect 在两端读到的摘要因此不同）；
# 真正的推送仍然用 skopeo copy --all --preserve-digests。
assert 'registry_digest()' in SYNC, '需要统一的 registry 摘要读取函数'
assert 'docker-content-digest' in SYNC.lower(), '摘要必须来自 registry 的 Docker-Content-Digest'
assert 'skopeo copy --all --preserve-digests' in SYNC
print('PASS: v0.9.54 poster hero, sidebar settings and Plex/Emby-style series grouping')

# 折叠按钮必须有独立 id，避免 document.querySelector(".rail-btn") 命中侧栏设置按钮
assert 'id="sidebarCollapseButton"' in HTML, "折叠按钮缺少 sidebarCollapseButton id"
assert HTML.index('id="sidebarSettingsButton"') < HTML.index('id="sidebarCollapseButton"')
assert 'document.querySelector(".rail-btn")' not in STATE, "toggleBars 仍用 .rail-btn 泛选择器"
assert STATE.count('document.getElementById("sidebarCollapseButton")') == 2

# CSS url() 注入硬化：外部海报地址进 style 前必须剔除引号/括号/反斜杠
assert "function cssUrlValue(url)" in JS, "缺少 cssUrlValue 过滤器"
assert "const safeArt = cssUrlValue(heroArt.url);" in JS
assert "--movie-hero-art:url('${esc(safeArt)}')" in JS
assert "url('${esc(heroArt.url)}')" not in JS, "hero style 仍直接插入未过滤的海报地址"

# localStorage round-trip 后 seasons(Map) 会变成 {}，读回必须只依赖数组字段并回落
assert "Array.isArray(show.seasonList)" in JS
assert "Array.isArray(show.files)" in JS

# hero 必须是定位元素，否则 ::before 遮罩会相对错误的祖先定位，文字失去对比度保护
assert ".movie-detail-hero { position:relative;" in CSS, "hero 缺少 position:relative"
# backdrop-art 必须与 poster-art 共享白字与遮罩规则（此前只写了 poster-art）
assert ".movie-detail-hero.backdrop-art" in CSS, "backdrop-art 没有对应样式"
assert ".movie-detail-hero.poster-art::before, .movie-detail-hero.backdrop-art::before" in CSS

# v0.9.30：影视库必须一次加载全部媒体文件
assert "if (group === \"movie\" && data.has_more)" in JS
assert "已加载全部 ${files.length} / ${total} 项" in JS
# 剧集缓存只存详情页真正读的字段，避免 localStorage 配额溢出后静默丢失
assert "function seriesShowCacheShape(show)" in JS
assert "seriesShowMemory" in JS
assert "JSON.stringify(seriesShowCacheShape(show))" in JS
