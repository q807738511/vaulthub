#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v0.9.69 契约测试：漫画阅读器（按页转码/预取/模式/页码进度）+ 音乐歌词刮削与元数据缓存。"""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HTML = (ROOT / "index.html").read_text(encoding="utf-8")
STATE = (ROOT / "web/js/01-state.js").read_text(encoding="utf-8")
MEDIA = (ROOT / "web/js/02-media.js").read_text(encoding="utf-8")
CSS = (ROOT / "web/css/main.css").read_text(encoding="utf-8")
# v0.9.67 的发布说明属于该版本历史（当前版本已前移到 0.9.68 的补丁说明）。
NOTES = (ROOT / ".github/RELEASE_NOTES_0.9.67.md").read_text(encoding="utf-8")
LOG = (ROOT / "Update Log.md").read_text(encoding="utf-8")
GO_MAIN = (ROOT / "media-go/main.go").read_text(encoding="utf-8")
GO_CACHE = (ROOT / "media-go/page_cache.go").read_text(encoding="utf-8")
GO_TRANS = (ROOT / "media-go/page_transcode.go").read_text(encoding="utf-8")
GO_HANDLER = (ROOT / "media-go/page_handler.go").read_text(encoding="utf-8")
GO_PROGRESS = (ROOT / "media-go/reading_progress.go").read_text(encoding="utf-8")
GO_LYRICS = (ROOT / "media-go/audio_lyrics.go").read_text(encoding="utf-8")
GO_LOCAL = (ROOT / "media-go/audio_lyrics_local.go").read_text(encoding="utf-8")
GO_ACACHE = (ROOT / "media-go/audio_cache.go").read_text(encoding="utf-8")
GO_NETEASE = (ROOT / "media-go/audio_metadata_netease.go").read_text(encoding="utf-8")

checks = {
    # ============ A. 漫画：服务端按页转码 + 磁盘缓存 ============
    "转码缓存LRU": "func newPageCache(" in GO_CACHE and "evictLocked" in GO_CACHE
        and "func (c *pageCache) put(" in GO_CACHE and "func (c *pageCache) get(" in GO_CACHE,
    "缓存键内容寻址": 'func pageCacheKey(' in GO_CACHE and "sha1" in GO_CACHE
        and "zipSize, zipMtime" in GO_CACHE,
    "缓存可禁用": "func (c *pageCache) enabled()" in GO_CACHE and "maxBytes > 0" in GO_CACHE,
    "半成品清理": '".tmp"' in GO_CACHE and "rescan" in GO_CACHE,
    "转码双快路径": "scaleYCbCrPage" in GO_TRANS and "scaleRGBAPage" in GO_TRANS,
    "转码有安全上限": "maxTranscodePixels" in GO_TRANS and "maxPageSourceBytes" in GO_TRANS
        and "pageMaxHeight" in GO_TRANS,
    "不放大且不可行则直出": "if !resized && format == \"jpeg\"" in GO_TRANS
        and "buf.Len() >= len(raw)" in GO_TRANS,
    "按页端点": "func (a *App) archivePage(" in GO_HANDLER,
    "首图封面端点": "func (a *App) archiveCover(" in GO_HANDLER and "naturalLess" in GO_HANDLER,
    "条目白名单校验": "ze.indexOf(entry)" in GO_HANDLER,
    "参数越界400": "invalid w or q" in GO_HANDLER and "pageParams(" in GO_HANDLER,
    # v0.9.68：该端点受会话鉴权保护，缓存头由 public 改为 private（浏览器缓存收益不变，
    # 避免中间缓存把受保护内容重放给未登录者）——契约随行为升级。
    "不可变缓存头": "private, max-age=31536000, immutable" in GO_HANDLER
        and "public, max-age=31536000, immutable" not in GO_HANDLER and "ETag" in GO_HANDLER,
    "并发合并": "beginPageJob" in GO_HANDLER and "pageJob{" in GO_HANDLER,
    "可观测响应头": "X-Vaulthub-Page-Cache" in GO_HANDLER,
    "路由注册": 'mux.HandleFunc("/api/media/archive/zip/page", a.archivePage)' in GO_MAIN
        and 'mux.HandleFunc("/api/media/archive/zip/cover", a.archiveCover)' in GO_MAIN,
    "缓存配额环境变量": 'MEDIA_PAGE_CACHE_MAX_BYTES' in GO_MAIN and 'MEDIA_PAGE_CACHE_DIR' in GO_MAIN,
    # 安全审查驱动的加固（第二轮）
    "转码全局并发闸门": "func (a *App) acquireTranscode(" in GO_HANDLER
        and "transcodeQueueTimeout" in GO_HANDLER and "transcodeSemOnce" in GO_MAIN,
    "像素上限收紧": "maxTranscodePixels = 16 << 20" in GO_TRANS,
    "ETag精确匹配": "func ifNoneMatchSatisfied(" in GO_HANDLER
        and "strings.Contains(match, key)" not in GO_HANDLER,
    "缓存自淘汰已修": 'c.evictLocked(key)' in GO_CACHE and "protect" in GO_CACHE,
    "tmp名唯一": "time.Now().UnixNano()" in GO_CACHE,
    "缓存文件不可读则直出": "func serveCachedPage(w http.ResponseWriter, r *http.Request, path, key string) bool" in GO_HANDLER,
    # 响应头必须在写响应体之前设置（http.ServeContent 一写体就落头，之后 Set 会被静默丢弃）
    "缓存标记先于写体": 'w.Header().Set("X-Vaulthub-Page-Cache", "hit")\n\t\tif serveCachedPage(w, r, file, key) {' in GO_HANDLER
        and 'w.Header().Set("X-Vaulthub-Page-Cache", "miss")\n\t\tif serveCachedPage(w, r, file, key) {' in GO_HANDLER,
    "歌词读取有上限": "tagScanWindow" in GO_LOCAL and "func readTagWindows(" in GO_LOCAL
        and "os.ReadFile(absPath)" not in GO_LOCAL,

    # ============ B. 漫画：前端阅读器 ============
    "阅读器挂载": "function mountComicReader(" in MEDIA and "function closeComicReader(" in MEDIA,
    "三种模式": "comicSetMode" in MEDIA and '"single", "double", "scroll"' in MEDIA,
    "阅读方向右起": "state.rtl" in MEDIA and "comic-rtl" in MEDIA and "saveComicPrefs({ rtl" in MEDIA,
    "预取窗口": "COMIC_PREFETCH_AHEAD" in MEDIA and "function comicPrefetch(" in MEDIA
        and "fetchPriority" in MEDIA,
    "省流模式弱网自动": "function comicSaveDataActive(" in MEDIA and "effectiveType" in MEDIA
        and "saveData" in MEDIA,
    "转码宽度随省流": "function comicTranscodeWidth(" in MEDIA,
    "页码进度与跳转": "comicResumePage" in MEDIA and "comicGoto" in MEDIA
        and "comicRecordProgress" in MEDIA and "state.total" in MEDIA,
    "键盘翻页": 'ev.key === "ArrowRight"' in MEDIA and 'ev.key === "PageUp"' in MEDIA,
    # 工具栏文案写了 Esc 关闭，就必须真的绑定（此前只有音乐海报遮罩绑了 Esc）
    "Esc 关闭阅读器": 'ev.key === "Escape"' in MEDIA and 'closeLocalViewer("comic")' in MEDIA,
    # 关闭后不得残留监听：keydown 守卫必须判阅读器 DOM，closeLocalViewer 必须释放
    "关闭后监听自愈": 'state.viewer.querySelector(".comic-reader")' in MEDIA
        and 'closeComicReader()' in MEDIA,
    "关闭入口释放监听": 'if (typeof closeComicReader === "function") closeComicReader();' in
        (ROOT / "web/js/03-features.js").read_text(encoding="utf-8"),
    "半屏点击翻页": "leftHalf" in MEDIA and "const forward = state.rtl ? leftHalf : !leftHalf;" in MEDIA,
    "工具栏自动隐藏": "comicShowToolbar" in MEDIA and "toolbar-hidden" in CSS,
    "滚动模式复用归档页容器": "comic-archive-pages" in MEDIA and ".comic-archive-pages" in CSS,
    "书架首图封面": "comicCoverUrl(lib, path, 320)" in MEDIA,
    "阅读器样式": ".comic-reader {" in CSS and ".comic-toolbar" in CSS and ".comic-stage" in CSS
        and ".comic-reader.fit-height .comic-img" in CSS,

    # ============ C. 进度：按页码（兼容旧百分比） ============
    "服务端存页码": "Page      int" in GO_PROGRESS and "Total     int" in GO_PROGRESS,
    "页码边界校验": "in.Page > in.Total" in GO_PROGRESS,
    "前端上报页码": "function saveReadingProgress(libId, path, progress, page, total)" in MEDIA
        and "JSON.stringify(entry)" in MEDIA,
    "旧百分比换算": "Math.round(pct * total / 100)" in MEDIA,

    # ============ D. 音乐：歌词识别（本地） ============
    "同名lrc识别": "func sidecarLyrics(" in GO_LOCAL and 'stem + ".lrc"' in GO_LOCAL,
    "ID3 USLT": "func id3USLT(" in GO_LOCAL and '"USLT"' in GO_LOCAL,
    "Vorbis LYRICS": "func vorbisLyrics(" in GO_LOCAL and "UNSYNCEDLYRICS=" in GO_LOCAL,
    "MP4 ©lyr": "func mp4Lyrics(" in GO_LOCAL and "0xA9, 'l', 'y', 'r'" in GO_LOCAL,
    "编码判定防乱码": "detectTextEncoding" in GO_LOCAL and "utf16le" in GO_LOCAL
        and "latin1" in GO_LOCAL,
    "占位歌词过滤": "func lyricsLooksValid(" in GO_LOCAL and "暂无歌词" in GO_LOCAL
        and "func lrcStripTimestamps(" in GO_LOCAL,

    # ============ E. 音乐：在线歌词源链 ============
    "歌词源链": "func (a *App) scrapeAudioLyrics(" in GO_LYRICS and "lrclibGet" in GO_LYRICS
        and "lrclibSearch" in GO_LYRICS and "lyricsOvh" in GO_LYRICS,
    "503退避重试": "StatusServiceUnavailable" in GO_LYRICS and "backoff *= 2" in GO_LYRICS,
    "全局节流": "lyricsMinInterval" in GO_LYRICS and "func (a *App) lyricsThrottle(" in GO_LYRICS,
    "网易云默认关闭": "func (a *App) neteaseLyricsEnabled(" in GO_LYRICS
        and 'env("VAULTHUB_LYRICS_NETEASE", "0")' in GO_LYRICS,
    "sidecar原子写": "func writeLyricsSidecar(" in GO_LYRICS and 'stem+".lrc"' in GO_LYRICS
        and "os.Rename(tmp, final)" in GO_LYRICS,
    "歌词端点": "func (a *App) audioLyrics(" in GO_LYRICS and "func (a *App) batchLyrics(" in GO_LYRICS,
    "歌词路由": '"/api/media/audio/lyrics"' in GO_MAIN and '"/api/media/audio/lyrics/batch"' in GO_MAIN,

    # ============ F. 音乐：刮削源扩展 ============
    "网易云元数据源": "func (a *App) scrapeAudioNetease(" in GO_NETEASE,
    "封面兜底CAA": "func coverArtArchiveURL(" in GO_NETEASE and "coverartarchive.org" in GO_NETEASE,
    "源链接入": "scrapeAudioNetease(ctx, title, artist)" in (ROOT / "media-go/audio_metadata.go").read_text(encoding="utf-8"),

    # ============ G. 音乐：服务端元数据缓存 ============
    "sqlite缓存表": "ensureAudioCacheTable" in GO_ACACHE and "CREATE TABLE IF NOT EXISTS audio_metadata" in GO_ACACHE,
    "size+mtime失效": "f.size = m.size AND f.mtime = m.mtime" in GO_ACACHE,
    "缓存路由": '"/api/media/audio/cache"' in GO_MAIN and '"/api/media/audio/cache/stats"' in GO_MAIN,
    "歌词长度上限": "audioCacheLyricsLimit" in GO_ACACHE,

    # ============ H. 前端：歌词与缓存接入 ============
    "播放自动补歌词": "ensureAudioLyrics(lib.id, path, meta)" in MEDIA,
    "歌词请求": "async function fetchAudioLyrics(" in MEDIA and "audio/lyrics?" in MEDIA,
    "来源标记": "function audioLyricsSourceLabel(" in MEDIA and "LRCLIB" in MEDIA,
    "批量刮削入口": "async function scrapeAllAudioLyrics(" in MEDIA and "scrapeAllAudioLyrics()" in HTML,
    "服务端缓存优先": "async function loadAudioServerCache(" in MEDIA
        and "saveAudioServerCache(lib.id, path" in MEDIA,
    "弹窗按钮": "scrapeLyricsForOpenEditor()" in HTML and "scrapeAllAudioLyrics()" in HTML,

    # ============ I. 版本与发布物 ============
    "HTML版本": 'VAULTHUB_ASSET_VERSION = "0.9.69"' in HTML and HTML.count("?v=0.9.69") >= 7,
    "脚本版本": 'VAULTHUB_SCRIPT_VERSION = "0.9.69"' in STATE,
    "UI角标": "v0.9.69 · Hardening R2" in HTML,
    "发布说明": "VaultHub 蜀鼠之家 v0.9.67" in NOTES and "漫画阅读器" in NOTES  # 读的是本版（v0.9.67）历史说明
        and "歌词" in NOTES and "不新增任何容器" in NOTES,
    "更新日志段": "# VaultHub 蜀鼠之家 v0.9.69" in LOG,
    "历史说明未改": (ROOT / ".github/RELEASE_NOTES_0.9.66.md").read_text(encoding="utf-8").startswith(
        "# VaultHub 蜀鼠之家 v0.9.66"),
}

# ---- 数据化断言：省流模式默认在局域网关闭（避免「为了省流反而更慢」）----
checks["省流默认自动而非强制"] = 'saveData: "auto"' in MEDIA and 'if (mode === "off") return false;' in MEDIA

failed = [name for name, ok in checks.items() if not ok]
for name, ok in checks.items():
    print(("PASS" if ok else "FAIL") + ": " + name)
if failed:
    raise SystemExit(f"FAIL: v0.9.69 契约 {len(failed)} 项未通过: {failed}")
print("PASS: v0.9.67 漫画阅读器（转码/预取/模式/页码）与音乐歌词刮削、刮削源扩展、服务端缓存契约通过")
