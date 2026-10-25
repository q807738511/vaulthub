#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v0.9.90 静态契约：三项客户修正 + 大媒体库响应修复。

1) 转码 / 限档提示从画面顶栏移入播放器「获取信息」面板；
2) 剧集刮削命名跟随所选语言（写入 show_title，展示优先用它）；
3) 大库响应：前端 O(1) 状态索引、整库分块拉取 + 让出主线程、渐进渲染窗口、
   批量元数据端点、后端 mtime 覆盖索引与单页上限。
"""
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
MEDIA = (ROOT / "web/js/02-media.js").read_text(encoding="utf-8")
STATE = (ROOT / "web/js/01-state.js").read_text(encoding="utf-8")
CSS = (ROOT / "web/css/main.css").read_text(encoding="utf-8")
GO_MAIN = (ROOT / "media-go/main.go").read_text(encoding="utf-8")
GO_LM = (ROOT / "media-go/local_metadata.go").read_text(encoding="utf-8")
HTML = (ROOT / "index.html").read_text(encoding="utf-8")
LOG = (ROOT / "Update Log.md").read_text(encoding="utf-8")
NOTES = (ROOT / ".github/RELEASE_NOTES_0.9.90.md").read_text(encoding="utf-8")

OK = 0
FAILS = []


def check(name, cond, extra=""):
    global OK
    if cond:
        OK += 1
        print("PASS:", name)
    else:
        FAILS.append(name)
        print("FAIL:", name, extra)


# ============ 1) 转码提示移入「获取信息」面板 ============
check("1a 面板内新增转码提示行（data-video-compat）",
      '<div class="video-status-panel">' in MEDIA
      # v0.9.92：面板内紧跟一行「解码路径」（data-video-decode），故两行连排后收尾。
      and '<span class="status-compat movie-compat-status" data-video-compat></span><span class="status-decode" data-video-decode></span></div>' in MEDIA)
check("1b 画面顶栏不再有提示条（vpPreparing 的旧节点已移除）",
      '<span class="movie-compat-status">${esc(t("vpPreparing"))}</span>' not in MEDIA)
check("1c setMovieCompatStatus 写入面板并给信息按钮加提示点",
      'root?.querySelector("[data-video-compat]") || root?.querySelector(".movie-compat-status")' in MEDIA
      and 'classList.toggle("has-note", !!text)' in MEDIA
      and 'classList.toggle("show", !!text)' in MEDIA)
check("1d CSS：面板内提示行（可读配色 + 展开才显示）",
      ".video-status-panel .status-compat" in CSS and ".status-compat.show" in CSS)
check("1e CSS：信息按钮小圆点", ".video-info-button.has-note::after" in CSS)

# ============ 2) 刮削命名跟随语言 ============
check("2a 剧集把选中语言刮到的剧名写入 show_title", MEDIA.count('show_title: mediaType === "series"') >= 2)
check("2b show_title 覆盖 TMDB / TVDB / 豆瓣 三条命中路径",
      MEDIA.count('base.show_title || ""') >= 3)
check("2c 剧集 title 改为分集名（不再重复剧名）", "function seriesEpisodeTitleOf(" in MEDIA
      and MEDIA.count("seriesEpisodeTitleOf(path)") >= 2)
# v0.9.93：归组键改为路径口径（刮削状态不再影响分组），剧名仍优先取刮削的 show_title。
check("2d 剧集卡片与播放器标题仍优先用 show_title",
      "const scrapedTitle = String(meta.show_title || \"\").trim();" in MEDIA
      and "if (scrapedTitle && !show.scrapedTitle) show.scrapedTitle = scrapedTitle;" in MEDIA
      and "show.title = show.scrapedTitle;" in MEDIA)
check("2e NFO 落盘带 show_title（showtitle）", 'show_title: meta.show_title || ""' in MEDIA
      and 'xml:"showtitle' in (ROOT / "media-go/local_metadata.go").read_text(encoding="utf-8"))
check("2f 语言开关仍由 tmdbLangTag() 驱动", "&lang=${tmdbLangTag()}" in MEDIA)

# ============ 3) 大库响应 ============
check("3a 阅读进度改内存索引（readingState 不再逐条解析 localStorage）",
      "function readingStateIndexFor(" in MEDIA and "function readingStateLocal(" in MEDIA
      and 'JSON.parse(localStorage.getItem(mediaStateKey(libId, path)))' not in MEDIA
      and "const local = readingStateLocal(libId, path);" in MEDIA)
check("3b 进度索引写入/删除同步 + 失效入口",
      "readingStateIndexFor(libId)[String(path)] = stored;" in MEDIA
      and "delete readingStateIndex[String(lib)][String(rel)];" in MEDIA
      and "function readingStateInvalidate(" in MEDIA)
check("3c 收藏表读缓存（不再每次整表解析）",
      "const bookFavoritesCache = { map: null };" in MEDIA
      and "if (bookFavoritesCache.map) return bookFavoritesCache.map;" in MEDIA
      and "bookFavoritesCache.map = (map && typeof map === \"object\") ? map : {};" in MEDIA)
check("3d 整库分块 2000 + 让出主线程 + 进度回调",
      "const LIBRARY_INDEX_CHUNK = 2000;" in MEDIA
      and "function libraryIndexYield()" in MEDIA
      and "await libraryIndexYield();" in MEDIA
      and "opts.onProgress(files.length, page)" in MEDIA
      and "&limit=${chunk}" in MEDIA)
check("3e 书刊架首屏先出 + 整库补齐后重绘",
      "renderComicShelf(lib, files.slice(), offset, { preview: true, notice: t(\"shelfLoadingIndex\") })" in MEDIA
      and "function renderComicShelf(" in MEDIA)
check("3f 渲染窗口：≤3000 全量，超出渐进 + 继续加载",
      "const BOOK_SHELF_AUTO_MAX = 3000;" in MEDIA
      and "function bookShelfWindowSlice" in MEDIA
      and 'if (list.length <= BOOK_SHELF_AUTO_MAX) return { pageFiles: list, more: "" };' in MEDIA
      and "function bookShelfLoadMore()" in MEDIA
      and "继续加载（已显示" in MEDIA)
check("3g 前端批量元数据（200 条/次）替代逐文件串行",
      'fetch("/api/media/metadata/batch"' in MEDIA and "i += 200" in MEDIA
      and "for (const file of files) {\n    const path = String(file.path);\n    try {\n      const res = await fetch(`/api/media/metadata?" not in MEDIA)
check("3h 服务端批量端点 + 路由",
      "func (a *App) localMetadataBatch(w http.ResponseWriter, r *http.Request) {" in GO_LM
      and 'mux.HandleFunc("/api/media/metadata/batch", a.localMetadataBatch)' in GO_MAIN
      and "if len(req.Paths) > 500 {" in GO_LM)
check("3i 单页上限 500 → maxFilesLimit(5000)",
      "const maxFilesLimit = 5000" in GO_MAIN
      and "if lim <= 0 || lim > maxFilesLimit {" in GO_MAIN
      and "if lim <= 0 || lim > 500 {" not in GO_MAIN)
check("3j 新增 (lib, mtime, path) 覆盖索引（首页最近入库不再整库排序）",
      "CREATE INDEX IF NOT EXISTS idx_files_lib_mtime ON files(lib, mtime, path);" in GO_MAIN)
check("3k i18n 三语言都补了索引加载提示",
      STATE.count("shelfLoadingIndex:") == 3 and STATE.count("shelfLoadingIndexN:") == 3
      and STATE.count("{n} / {total}") == 3)

# ============ 版本与文档 ============
check("4a index.html 资源版本 ≥10 且为本版", HTML.count("?v=1.0.11") >= 10)
check("4b ASSET_VERSION 0.9.90", 'window.VAULTHUB_ASSET_VERSION = "1.0.11";' in HTML)
check("4c SCRIPT_VERSION 0.9.90", 'const VAULTHUB_SCRIPT_VERSION = "1.0.11";' in STATE)
# v0.9.92（上轮审查项）：标语整串一致，而不是只数版本前缀。
_slogans_4d = re.findall(r"v\d+\.\d+\.\d+ · [^<\"]+", HTML)
check("4d 标语三处整串一致",
      len(_slogans_4d) == 3 and len(set(_slogans_4d)) == 1, sorted(set(_slogans_4d)))
check("4e 更新日志顶部为 v0.9.90", LOG.lstrip().startswith("# VaultHub 蜀鼠之家 v1.0.11"))
check("4f 更新日志写明「整库可见不变 + 三条链路根因」",
      "整库可见" in LOG and "37 万次主线程 JSON 解析" in LOG and "370 次请求" in LOG)
check("4g 发布说明文件存在且含本版内容",
      ("184,693" in NOTES or "18.4 万" in NOTES) and "获取信息" in NOTES
      and "show_title" in NOTES and ("tmdbLangTag" in NOTES or "语言" in NOTES))
check("4h 行为测试与契约测试文件齐备",
      (ROOT / "tests/v0990_behavior.js").is_file() and (ROOT / "tests/test_v0990_behavior.py").is_file()
      and (ROOT / "tests/test_v0990_contract.py").is_file())
check("4i README 未被改动（固定项目介绍）",
      "VaultHub" in (ROOT / "README.md").read_text(encoding="utf-8"))

print(f"\n==================== v0.9.90 契约: {OK} checks, FAIL={len(FAILS)}")
if FAILS:
    print("FAIL: v0.9.90 契约未全部通过")
    for f in FAILS:
        print("  - " + f)
    sys.exit(1)
print("PASS: v0.9.90 契约全部通过")
