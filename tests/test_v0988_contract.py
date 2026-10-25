#!/usr/bin/env python3
"""v0.9.90 契约测试：4 项客户修正的静态落点。

1. 继续删除媒体库中的刮削设置按钮
2. TMDB 标题匹配阈值（最低识别字符占比 70%，异常靠手动改名辅助）
3. 影视 / 音乐 / 电子书刮削结果服务端持久化（避免多次批量重复读取）
4. 原盘文件（ISO / BDMV）读取与刮削优化
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
HTML = (ROOT / "index.html").read_text(encoding="utf-8")
MEDIA = (ROOT / "web/js/02-media.js").read_text(encoding="utf-8")
STATE = (ROOT / "web/js/01-state.js").read_text(encoding="utf-8")
MAIN_GO = (ROOT / "media-go/main.go").read_text(encoding="utf-8")
STORE_GO = (ROOT / "media-go/scrape_store.go").read_text(encoding="utf-8")
MATCH_GO = (ROOT / "media-go/scrape_match.go").read_text(encoding="utf-8")
DISC_GO = (ROOT / "media-go/disc_input.go").read_text(encoding="utf-8")
PLAYBACK_GO = (ROOT / "media-go/playback.go").read_text(encoding="utf-8")
MEDIA_CODE = re.sub(r"/\*.*?\*/", " ", MEDIA, flags=re.S)

fails = []


def check(name, cond, detail=""):
    if cond:
        print(f"  ✓ {name}")
    else:
        print(f"  ✗ {name}{(' — ' + detail) if detail else ''}")
        fails.append(name)


print("v0.9.90 契约检查")

# ============================================================ 1. 库页刮削按钮删除
check("1a 媒体库页头的刮削按钮函数已删除",
      "movieScrapeControls" not in MEDIA_CODE)
check("1b 电影库/剧集库标题调用不再挂第三个参数（按钮容器）",
      not re.search(r"mediaLibraryHeading\(lib, `[^`]*`,", MEDIA_CODE))
check("1c 库页不再有任何刮削状态徽标",
      "movieScrapeStatus" not in MEDIA_CODE)
check("1d 刮削入口仍只在系统设置（自动扫描 / 逐项扫描 / 编辑名称）",
      "autoScanLibrary(" in MEDIA_CODE and "openLibraryItemScan(" in MEDIA_CODE
      and "editLibraryEntry(" in MEDIA_CODE)
check("1e 库页刮削入口文案已从三语词典删除",
      "scrapeGoSettings" not in STATE)

# ============================================================ 2. 标题匹配阈值
check("2a 前端有打分函数（覆盖率 + 词元 + 二元组）",
      "function titleMatchScore(" in MEDIA and "function pickTitleMatch(" in MEDIA
      and "function titleBigrams(" in MEDIA)
check("2b 默认阈值 70% 且可被服务端配置覆盖",
      "const DEFAULT_SCRAPE_MIN_MATCH = 0.7;" in MEDIA
      and "scraperStatus.scrape_min_match" in MEDIA)
check("2c 阈值来源做范围夹紧（30%–100%，非法值不生效）",
      "Math.min(1, Math.max(0.3, v))" in MEDIA)
check("2d TMDB 候选不再「取第一条」，改为按阈值取最高分",
      "const best = pickTitleMatch(candidates, searchTitle, { year: base.year });" in MEDIA
      and "best && best.matched ? best.item : null" in MEDIA)
check("2e TVDB 候选同样经过阈值判定",
      "const tvdbBest = pickTitleMatch(tvdbList, searchTitle, { year: base.year });" in MEDIA)
check("2f 未命中时写明匹配度与手动改名入口",
      "titleMatchReason(" in MEDIA and "✎ 编辑名称" in MEDIA and "匹配度不足" in MEDIA)
check("2g original_title / original_name 参与打分（切地区后仍能命中）",
      "function itemTitleForms(item)" in MEDIA and "item.original_title" in MEDIA)
check("2h 同名作品按年份纠偏",
      "Math.abs(Number(year) - Number(wantYear)) > 1" in MEDIA and "score += 0.05" in MEDIA)
check("2i 设置页提供阈值输入框（默认 70，可被 env 覆盖）",
      'id="scrapeMinMatch"' in HTML and 'value="70"' in HTML
      and 'data-env="SCRAPE_MIN_MATCH"' in HTML)
check("2j 阈值三语文案齐备",
      STATE.count("scrapeMinMatchLabel:") >= 3
      # v1.0.11（需求10）：阈值说明段落已删除
      and STATE.count("scrapeMinMatchHint:") == 0)
check("2k 服务端持久化阈值（RuntimeConfig + 快照 + 校验 + 即时生效）",
      'ScrapeMinMatch' in MAIN_GO and '"scrape_min_match":    a.scrapeMinMatch' in MAIN_GO
      and "invalid scrape match threshold" in MAIN_GO
      and MATCH_GO.count("func normalizeScrapeMinMatch") == 1
      and "const defaultScrapeMinMatch = 0.7" in MATCH_GO)
check("2l 阈值范围拒绝而非静默夹紧（0.1 → 400）",
      "func validScrapeMinMatch(" in MATCH_GO and "scrapeMinMatchFloor = 0.3" in MATCH_GO)
check("2m Go 侧阈值单测存在",
      (ROOT / "media-go/v0988_scrape_store_test.go").exists()
      and "TestV0988ScrapeMinMatchConfig" in (ROOT / "media-go/v0988_scrape_store_test.go").read_text(encoding="utf-8"))

# ============================================================ 3. 刮削结果服务端持久化
check("3a 服务端刮削结果库落地（0600 + 原子写 + 版本号）",
      "func (a *App) saveScrapeCache(" in STORE_GO and "os.Chmod(tmp, 0600)" in STORE_GO
      and "scrapeCacheVersion" in STORE_GO)
check("3b 读写清三个动作齐备（GET/POST/DELETE）",
      "func (a *App) scrapeCacheGet(" in STORE_GO and "func (a *App) scrapeCachePost(" in STORE_GO
      and "func (a *App) scrapeCacheDelete(" in STORE_GO)
check("3c 路径与图片地址逐项校验（拒绝越界路径与非法 URL）",
      "func validScrapeCachePath(" in STORE_GO and "func validScrapeCacheURL(" in STORE_GO
      and 'strings.HasPrefix(p, "/")' in STORE_GO)
check("3d 旧结果不回冲新结果（按 checked_at 合并），显式重刮才 replace",
      "existing.CheckedAt > item.CheckedAt" in STORE_GO and "body.Replace" in STORE_GO)
check("3e 读写都要登录会话",
      "if !readAuth(r) {" in STORE_GO and "if !writeAuth(r) {" in STORE_GO)
check("3f 路由已注册",
      'mux.HandleFunc("/api/media/scrape-cache", a.scrapeCacheHandler)' in MAIN_GO)
check("3g 前端进库先读服务端结果（避免整库重复刮）",
      "async function hydrateMovieMetadataFromServer(libId)" in MEDIA
      and "hydrated = await hydrateMovieMetadataFromServer(lib.id)" in MEDIA)
check("3h 刮削结束批量写回（一批一条请求，不是每条一次）",
      "function pushMovieScrapeResults(libId, paths, opts)" in MEDIA
      and 'pushMovieScrapeResults(lib && lib.id, pending.map(file => String(file.path)));' in MEDIA)
check("3i 单条重刮 / 重试失败项 / 逐项扫描都会写回",
      "pushMovieScrapeResults(libId, [path], { replace: true });" in MEDIA
      and "pushMovieScrapeResults(libId, targets.map(file => String(file.path)));" in MEDIA
      and "await hydrateMovieMetadataFromServer(libId);" in MEDIA)
check("3j 电子书封面结果同样进服务端结果库并可回灌",
      "function pushBookScrapeResult(" in MEDIA and "function hydrateBookCoversFromServer(" in MEDIA
      and "pushBookScrapeResult(libId, mediaPath, title, local || coverUrl);" in MEDIA
      and "hydrateBookCoversFromServer(libId).then(" in MEDIA)
check("3k 音乐沿用服务端持久化：未命中曲目在窗口内不再联网",
      "const AUDIO_SCRAPE_RETRY_MS = 10 * 60 * 1000;" in MEDIA
      and "meta.status" in MEDIA and 'status === "not_found"' in MEDIA
      and "function markAudioScrapeMiss(" in MEDIA)
check("3l 服务端结果库单测存在",
      "TestV0988ScrapeCacheRoundTripAndPermissions" in (ROOT / "media-go/v0988_scrape_store_test.go").read_text(encoding="utf-8")
      and "TestV0988ScrapeCacheMergePrefersNewerAndRejectsJunk" in (ROOT / "media-go/v0988_scrape_store_test.go").read_text(encoding="utf-8"))

# ============================================================ 4. 原盘 ISO / BDMV
check("4a 服务端原盘输入链（蓝光 UDF → DVD 镜像 → 裸文件）",
      "func discInputCandidates(" in DISC_GO and 'discInput{Spec: "bluray:" + abs' in DISC_GO
      and "discInputDVD" in DISC_GO and "discInputPlain" in DISC_GO)
check("4b 蓝光镜像用 libbluray/udfread 直读（不需要挂载）",
      "bluray:" in DISC_GO and "udfread" in DISC_GO)
check("4c 探测结果按「文件 + 大小 + mtime」缓存，避免每个请求都探测",
      "func discInputCacheKey(" in DISC_GO and "discInputCacheTTL" in DISC_GO)
check("4d BDMV 片段保持既有可用路径优先（不回归）",
      'out = append(out, discInput{Spec: abs, Kind: discInputPlain, File: abs})' in DISC_GO
      and "func bluRayDiscRootOf(" in DISC_GO)
# v0.9.98（口径变更）：四处调用点统一改成「带原盘播放列表」的解析函数，
# 输入参数由 ffprobeInputArgs(kind) 换成 disc.InputArgs()（含 -playlist N / -title N）。
check("4e probe / playbackPlan / compat / streams 都使用解析后的输入（含原盘播放列表）",
      "disc := a.resolveDiscInputWithPlaylist(ctx, p, discPlaylistArg(r))" in MAIN_GO
      and "disc := a.resolveDiscInputWithPlaylist(r.Context(), p, discPlaylistArg(r))" in MAIN_GO
      and "disc := a.resolveDiscInputWithPlaylist(ctx, p, discPlaylistArg(r))" in PLAYBACK_GO
      and "disc.InputArgs()" in MAIN_GO
      and "ffprobeInputArgs(disc.Kind)" not in MAIN_GO)
check("4f 原盘失败给出可执行提示（而不是只有 media probe failed）",
      "func discProbeHint(" in DISC_GO and 'out["probe_hint"] = hint' in MAIN_GO)
check("4g 转码缓存键纳入原盘输入类型（换解析方式不复用旧缓存）",
      "a%s:h%d:d%s" in MAIN_GO)
check("4h 原盘播放计划标注输入来源",
      "plan.Disc = string(disc.Kind)" in PLAYBACK_GO and 'plan.Reason = "原盘"' in PLAYBACK_GO)
check("4i 前端原盘识别（BDMV 目录 / ISO 镜像分组）",
      "function discGroupOf(path)" in MEDIA and "function isIsoImage(path)" in MEDIA
      and 'match(/^(.*)\\/(?:BDMV|CERTIFICATE)\\//i)' in MEDIA)
check("4j ISO 与同目录 BDMV 合并为一条（优先保留可播片段）",
      "const keepNew = (!isIso && currentIsIso)" in MEDIA and "current.iso_path = path" in MEDIA)
check("4k 原盘标题在目录/镜像名不可用时上溯父目录",
      "function discTitleCandidate(seg)" in MEDIA and "UNUSABLE_DISC_NAME_RE" in MEDIA
      and "discTitleCandidate(parentDirName(path))" in MEDIA)
check("4l 卡片标注原盘形态（ISO / ISO + BDMV / 片段数）",
      "function discSubtitle(file)" in MEDIA and "原盘 · ISO + BDMV" in MEDIA
      and '"原盘 · ISO"' in MEDIA)
check("4m Go 侧原盘单测存在（候选链 / 缓存 / 提示）",
      "TestV0988DiscInputCandidates" in (ROOT / "media-go/v0988_disc_input_test.go").read_text(encoding="utf-8")
      and "TestV0988ResolveDiscInputChainAndCache" in (ROOT / "media-go/v0988_disc_input_test.go").read_text(encoding="utf-8"))

# ============================================================ 5. 版本与文档
check("5a 版本号已升至 0.9.90",
      'VAULTHUB_ASSET_VERSION = "1.0.11"' in HTML and 'VAULTHUB_SCRIPT_VERSION = "1.0.11"' in STATE)
# v0.9.92（上轮审查项）：整串一致。
_slogans_5b = re.findall(r"v\d+\.\d+\.\d+ · [^<\"]+", HTML)
check("5b 关于 / 侧栏 / 页脚标语整串一致",
      len(_slogans_5b) >= 2 and len(set(_slogans_5b)) == 1, sorted(set(_slogans_5b)))
check("5c 脚本引用带新版本号",
      "?v=1.0.11" in HTML and HTML.count("?v=1.0.11") >= 5)
check("5d Update Log 顶部为 v0.9.90",
      (ROOT / "Update Log.md").read_text(encoding="utf-8").startswith("# VaultHub 蜀鼠之家 v1.0.11"))
check("5e Release Notes 存在",
      (ROOT / ".github/RELEASE_NOTES_0.9.90.md").exists())
check("5f README 未被改动（发布说明只进 Update Log）",
      "v0.9.92" not in (ROOT / "README.md").read_text(encoding="utf-8"))

print()
if fails:
    print(f"FAIL: {len(fails)} 项未通过：")
    for f in fails:
        print("  -", f)
    sys.exit(1)
print(f"PASS: v0.9.90 契约（4 项修正 + 版本文档）全部通过")
