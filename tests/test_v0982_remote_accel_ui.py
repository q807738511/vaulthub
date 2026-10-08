#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v0.9.85 契约（回归守卫）：
1. 视频推荐的播放按钮叠在略缩图之上，鼠标滑过（或键盘聚焦）才显示
2. 浏览器本地写入失败：统一走配额安全写入通道（清理可重建缓存 + 内存回退 + 准确提示）
3. 无资源推荐「视频信息」弹窗补齐类型/时长（TMDB 详情），画框优先用 16:9 的 backdrop
4. 顶栏媒体库标签不再带媒体数量后缀
5. 远程访问性能：索引 ETag/304 + 会话级整库索引复用 + 封面按尺寸取缩略图 + 减少绘制开销
"""
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
MEDIA = (ROOT / "web/js/02-media.js").read_text(encoding="utf-8")
STATE = (ROOT / "web/js/01-state.js").read_text(encoding="utf-8")
TOPCSS = (ROOT / "web/js/07-topnav.js").read_text(encoding="utf-8")
HOME = (ROOT / "web/js/05-home.js").read_text(encoding="utf-8")
CSS = (ROOT / "web/css/main.css").read_text(encoding="utf-8")
HTML = (ROOT / "index.html").read_text(encoding="utf-8")
GO_MAIN = (ROOT / "media-go/main.go").read_text(encoding="utf-8")
GO_COND = (ROOT / "media-go/index_conditional.go").read_text(encoding="utf-8")
GO_COVER = (ROOT / "media-go/cover_persist.go").read_text(encoding="utf-8")
GO_THUMB = (ROOT / "media-go/cover_thumb.go").read_text(encoding="utf-8")
CADDY = (ROOT / "Caddyfile").read_text(encoding="utf-8")

OK = 0; FAIL = 0
def check(name, cond):
    global OK, FAIL
    if cond: OK += 1
    else: FAIL += 1; print("  - FAIL", name)

# ---------- 1) 推荐播放按钮叠在图片上，hover 显示 ----------
card = MEDIA.split("function movieRecStripHTML")[1].split("function recInfoBase")[0]
check("1 播放按钮在略缩图容器内", '<div class="movie-rec-poster">${art}${play}</div>' in card)
check("1 播放按钮不再占标题行", "${play}</div></article>" not in card and "${play}" in card)
check("1 按钮阻止冒泡直接播放", 'class="movie-rec-play"' in card and "event.stopPropagation();openMovieDetails(" in card)
check("1 CSS 叠层 + 默认隐藏", ".movie-rec-play { position:absolute; inset:0;" in CSS and "opacity:0;" in CSS.split(".movie-rec-play {")[1][:400])
check("1 CSS hover/focus 显示", ".movie-rec-card:hover .movie-rec-play" in CSS and ":focus-within .movie-rec-play" in CSS)
check("1 CSS 触屏常显", "@media (hover:none) { .movie-rec-play { opacity:1; } }" in CSS)
check("1 图片容器 relative", ".movie-rec-card .movie-rec-poster {" in CSS and "position:relative;" in CSS.split(".movie-rec-card .movie-rec-poster {")[1][:220])

# ---------- 2) 本地写入失败的统一处理 ----------
check("2a 存在安全写入通道", "function vaultStoreSet(" in STATE and "function vaultStoreGet(" in STATE)
check("2b 单键上限判断", "VAULTHUB_LS_SINGLE_LIMIT" in STATE and "text.length > VAULTHUB_LS_SINGLE_LIMIT" in STATE)
check("2c 先清理可重建缓存再重试", "function vaulthubReclaimStorage(" in STATE and "if (vaulthubReclaimStorage(key) > 0)" in STATE)
check("2d 内存回退", "vaulthubMemoryStore.set(key, text)" in STATE and "vaulthubMemoryStore.has(key)" in STATE)
check("2e 按真实原因提示一次", "QuotaExceededError" in STATE and "vaulthubStorageWarned" in STATE and "浏览器本地缓存已满" in STATE)
check("2f 只清理可重建缓存", "VAULTHUB_EVICTABLE_PATTERNS" in STATE and "vaulthub_cover_scrape_v1" in STATE and "vaulthub_audio_favorites_v1" not in STATE)
check("2g 影视元数据走安全通道", "vaultStoreSet(movieMetadataCache" in MEDIA and "vaultStoreJSON(movieMetadataCache" in MEDIA)
check("2h 音频/歌手/封面缓存走安全通道", "vaultStoreSet(audioMetadataCache" in MEDIA and "vaultStoreSet(audioArtistCache" in MEDIA and "vaultStoreSet(coverScrapeCache" in MEDIA)
check("2i 剧集结构缓存走安全通道", "vaultStoreSet(key, shape)" in MEDIA and "seriesShowMemory[key] = shape" in MEDIA)
check("2j 影视元数据合并写入 + 内存权威副本", "movieMetadataMemory" in MEDIA and "movieMetadataFlushTimer" in MEDIA and "function flushMovieMetadata(" in MEDIA)

# ---------- 3) 推荐「视频信息」弹窗 ----------
info = MEDIA.split("function recInfoBodyHTML")[1].split("function buildRecInfoModal")[0]
check("3a 弹窗补齐类型/时长", '"类型"' in info and '"时长"' in info and "genres" in info and "runtime" in info)
check("3b 画框优先 backdrop（16:9）", "function recInfoArtUrl(" in MEDIA and "backdrop || item.poster" in MEDIA.split("function recInfoArtUrl(")[1][:200])
check("3c 异步取 TMDB 完整详情", "/api/media/tmdb?type=" in info and "episode_run_time" in info)
check("3d Bangumi 兜底保留", "api.bgm.tv/v0/search/subjects" in info and "Bangumi" in info)
check("3e 弹窗结构含 art/main 容器", 'class="rec-info-art"' in MEDIA and 'class="rec-info-main"' in MEDIA and "function buildRecInfoModal(" in MEDIA)
check("3f CSS 保留 16:9 画框", ".rec-info-grid img" in CSS and "aspect-ratio:16/9" in CSS.split(".rec-info-grid img")[1][:200])
check("3g CSS 简介排版", ".rec-info-overview" in CSS and ".rec-info-art" in CSS)
check("3h 弹窗宽版避免文字挤成竖排", ".rec-info-modal { width:720px" in CSS and ".rec-info-art { flex:0 0 320px" in CSS and ".rec-info-main { min-width:0; flex:1 1 auto" in CSS)
check("3i 窄屏改为上下堆叠", "@media (max-width:640px){ .rec-info-grid{flex-direction:column;}" in CSS)

# ---------- 4) 顶栏媒体库标签去掉数量后缀 ----------
tabs = TOPCSS.split("function renderTopLibTabs()")[1].split("function syncTopLibTabs(")[0]
lib_block = tabs.split("if (typeof externalServices")[0]
check("4a 顶栏标签不再渲染数量", "formatHomeCount" not in lib_block and 'class="cnt"' not in lib_block and "homeIndexStatus" not in lib_block)
check("4b 外连服务标记仍在", "↗" in tabs)
check("4c 标签仍带库名与图标", "${esc(lib.name)}" in tabs and "topNavIconForType" in tabs)

# ---------- 5) 远程访问性能 ----------
check("5a Go 索引 ETag + 304", "func writeIndexJSON(" in GO_COND and "If-None-Match" in GO_COND and "http.StatusNotModified" in GO_COND)
check("5b Go 索引版本字段", "func libraryIndexVersion(" in GO_COND and '"files": files, "version": version' in GO_MAIN)
check("5c Go 不再对索引强制 no-store", 'w.Header().Set("Cache-Control", "private, no-cache")' in GO_COND and "writeIndexJSON(w, r, version" in GO_MAIN)
check("5d Go 封面缩略 w 参数", "func (a *App) serveCoverThumb(" in GO_THUMB and "transcodePageImage(raw, width, coverJPEGQuality)" in GO_THUMB)
check("5e Go 封面流式直出", "func serveCoverOriginal(" in GO_THUMB and "http.ServeContent(w, r, fi.Name(), fi.ModTime(), f)" in GO_THUMB)
check("5f 端点接线 w 参数", 'strconv.Atoi(q.Get("w"))' in GO_COVER and "a.serveCoverThumb(w, r, l, rel, p, fi, width)" in GO_COVER)
check("5g 前端按尺寸取封面缩略图", "function coverThumbUrl(" in MEDIA and "coverThumbUrl(meta.poster, 320)" in MEDIA and "coverThumbUrl(meta.cover, 320)" in MEDIA and "coverThumbUrl(cover, 320)" in HOME)
check("5h 前端索引会话缓存 + 版本探测", "libraryIndexSessionGet" in MEDIA and "libraryIndexVersionProbe" in MEDIA and "LIBRARY_INDEX_TTL_MS" in MEDIA)
check("5i 扫描完成后失效会话缓存", "libraryIndexSessionClear(lib.id)" in MEDIA and "libraryIndexSessionClear();" in MEDIA)
check("5j 标题索引懒加载", "function movieLocalTitleIndex()" in MEDIA and "movieLocalTitleIndexCache" in MEDIA)
check("5k CSS 减少绘制开销", ".media-file-list .media-file-row { content-visibility:auto" in CSS and ".movie-rec-card, .movie-cast-card" in CSS and "contain:content;" in CSS)
check("5l 封面缓存头仍是公开长缓存", 'Cache-Control", "public, max-age=86400' in GO_THUMB)
check("5m 入口 Caddy 仍启用压缩", "encode zstd gzip" in CADDY)

# ---------- 版本一致性 ----------
check("V1 HTML 资源版本", 'VAULTHUB_ASSET_VERSION = "0.9.94"' in HTML)
check("V2 脚本版本", 'VAULTHUB_SCRIPT_VERSION = "0.9.94"' in STATE)
check("V3 静态缓存串", HTML.count("?v=0.9.94") >= 7)
check("V4 UI 角标", "v0.9.94" in HTML)

print(f"v0.9.85 checks: {OK} passed, {FAIL} failed")
import sys
sys.exit(1 if FAIL else 0)
