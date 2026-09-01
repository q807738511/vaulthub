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
assert "movie-detail-hero { background-image:var(--movie-hero-art" in CSS

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

# 4. v0.9.10 发布引用与 Docker Hub 同步优先标签。
assert 'v0.9.10' in HTML
assert 'ghcr.io/q807738511/vaulthub:v0.9.10' in COMPOSE
assert 'PRIORITY_TAG=v0.9.10' in SYNC
print('PASS: v0.9.10 poster hero, sidebar settings and Plex/Emby-style series grouping')
