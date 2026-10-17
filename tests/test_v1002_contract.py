#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v1.0.4 契约测试：8 项修正的静态契约、发布纪律、洗版自查。

只做静态契约断言；行为验证在 tests/v1002_behavior.js、media-go/v1002_douban_test.go
与真实容器/浏览器验证里。
"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ok = True


def check(name, cond, extra=""):
    global ok
    if cond:
        print("PASS:", name)
    else:
        ok = False
        print("FAIL:", name, extra)


def rd(p):
    return (ROOT / p).read_text(encoding="utf-8")


HTML = rd("index.html")
STATE = rd("web/js/01-state.js")
MEDIA = rd("web/js/02-media.js")
THEME = rd("web/js/06-theme.js")
BOOT = rd("web/js/04-boot.js")
CSS = rd("web/css/main.css")
GO = rd("media-go/main.go")
LM = rd("media-go/local_metadata.go")
DB = rd("media-go/douban.go")
LOG = rd("Update Log.md")
NOTES = rd(".github/RELEASE_NOTES_1.0.2.md")

print("== 1. 需求1：季度展示回归 0.9.89 版式（不再有首集大图）==")
check("1a 季名回到独立 h3 季名行",
      '<h3 class="series-season-head" onclick="toggleSeriesSeason(this)">${head}</h3>' in MEDIA)
check("1b 全部剧集进同一网格（首条目前缀行已移除）",
      'eps.map(ep => renderSeriesEpisodeRow(lib, ep, art(ep))).join("")' in MEDIA
      and "series-season-prefix" not in MEDIA and "series-episode-list-rest" not in MEDIA)
check("1c 不再有「首集大图」行标记（is-season-top 彻底移除）",
      "is-season-top" not in MEDIA)
check("1d 折叠对象回到整季分集网格",
      'const list = sec ? sec.querySelector(".series-episode-list") : null;' in MEDIA)
check("1e 中文序号与加粗「季度」同行口径保留",
      '<span class="season-inline-title">季度</span>' in MEDIA
      and "seriesPlexSeasonLabel(season.season)" in MEDIA)
check("1f 季名行样式：季度 700 / 季名 400",
      ".series-season-head .season-inline-title { font-weight: 700;" in CSS
      and ".series-season-head .series-season-title { font-weight: 400;" in CSS)

print("\n== 2. 需求2：演职人员全量修复 ==")
check("2a 剧集库无条件补读 show 级 NFO（不再以「本集没有 NFO」为前提）",
      "func mergeSeriesShowNFO(" in LM
      and "if lib.Type == \"series\" {\n\t\tmergeSeriesShowNFO(lib, dir, &m)" in LM)
check("2b 剧名来源与剧集级 ID 单独带出（json 字段齐全）",
      all(f'json:"{k}' in LM for k in ("show_tmdb_id", "show_tvdb_id", "show_title_source", "episode_tmdb_id")))
check("2c 季标记标题不当剧名（Season N / 第 N 季 / Specials）",
      "func seasonMarkerTitle(" in LM and "plexParseSeasonDir" in LM)
check("2d 前端以服务端剧名（本地 NFO/目录名）为准并即时修复",
      "const nfoTitle = String((sdata && sdata.show_title) || \"\").trim();" in MEDIA
      and "repairSeriesShowTitleFromNFO(libId, show, nfoTitle)" in MEDIA
      and "function repairSeriesShowTitleFromNFO(" in MEDIA)
check("2e 剧集级 TMDB 查询用 show_tmdb_id（不再拿分集 id 查剧集）",
      "let tid = String((sdata && sdata.show_tmdb_id) || show.tmdb_id || \"\").trim();" in MEDIA)
check("2e2 只信任 NFO 剧名：目录名兜底不覆盖已刮削剧名（本地化剧名不被目录名顶掉）",
      'const trustNfoTitle = !!nfoTitle && (nfoTitleSource === "season-nfo" || nfoTitleSource === "tvshow-nfo");' in MEDIA
      and 'const lookupTitle = (trustNfoTitle ? nfoTitle : "") || cachedTitle || nfoTitle;' in MEDIA)
check("2e3 剧名为空时用本地剧名兜底（空标题比目录名更差）",
      'if (nfoTitle && (trustNfoTitle ? nfoTitle !== cachedTitle : !cachedTitle)) {' in MEDIA)
check("2f 元数据取路改用真视频的第一集",
      "function seriesFirstVideoPath(" in MEDIA
      and "const firstPath = seriesFirstVideoPath(show) || (show.files?.[0]?.path || \"\");" in MEDIA)

print("\n== 3. 需求3：视频推荐定位与播放 ==")
check("3a 推荐卡片库 id 随详情页显式传递（不再依赖全局旁路）",
      "__libId: lib.id" in MEDIA
      and 'const recLibId = String(meta.__libId || scraperStatus._recLibId || "");' in MEDIA)
check("3b ▶ 按钮走 openLocalMedia 直接播放",
      "event.stopPropagation();openLocalMedia('movie',${jsAttrArg(recLocalLib)}" in MEDIA)
check("3c 点卡片进详情，用命中条目自己的库",
      'const recLocalLib = String((x.local && x.local.libId) || recLibId || "");' in MEDIA
      and "openMovieDetails(${jsAttrArg(recLocalLib)}" in MEDIA)
check("3d 本地命中只认真视频并带库 id",
      "function movieRecLocalHit(title){" in MEDIA and "libId: libraryIdForMediaPath(path)" in MEDIA
      and "function libraryIdForMediaPath(path)" in MEDIA)

print("\n== 4. 需求4/5：豆瓣评分与综合推荐 ==")
check("4a 服务端豆瓣代理端点已注册",
      'mux.HandleFunc("/api/media/douban", a.douban)' in GO
      and 'mux.HandleFunc("/api/media/douban/batch", a.doubanBatch)' in GO)
check("4b 服务端搜索 + rexxar 详情两个上游都在（无需 API Key）",
      "func (a *App) doubanSearch(" in DB and "func (a *App) doubanDetail(" in DB
      and "movie.douban.com/j/subject_suggest" in DB and "rexxar/api/v2/" in DB)
check("4c 匹配打分制：低于阈值不出分（不拿别的片子顶替）",
      "func doubanBest(" in DB and "case name == target:" in DB and "case strings.Contains(name, target)" in DB)
check("4d 24 小时缓存 + 单飞去重 + 批量上限",
      "doubanCacheTTL" in DB and "24 * time.Hour" in DB
      and "doubanInflight" in DB and "doubanMaxBatch" in DB and "doubanRetryTTL" in DB)
check("4e 请求带 UA / Referer（豆瓣风控）", "doubanUA" in DB and "doubanReferer" in DB)
check("4f 前端评分获取与展示落点齐全",
      "async function fetchDoubanRating(" in MEDIA
      and 'class="movie-douban-rating"' in MEDIA and "<dt>豆瓣评分</dt>" in MEDIA
      and ".movie-douban-rating {" in CSS)
check("4g 推荐按 TMDB × 豆瓣综合分排序（两边都有按票数加权）",
      "function combinedDoubanTmdbScore(" in MEDIA and "async function rankRecommendationsWithDouban(" in MEDIA
      and "(t * tw + d * dw) / (tw + dw)" in MEDIA)

print("\n== 5. 需求6/7：操作模式（Apple / Emby / Plex）==")
check("5a 外观主题面板：操作模式 + 界面规格两个独立档位",
      'id="opModeSeg"' in HTML and 'id="uiModeSeg"' in HTML
      and "操作模式" in HTML and "界面规格" in HTML and "UI 模式" not in HTML)
# v1.0.4（需求2/3）：这档改名「界面规格」，说明段落换成卡片副标题 OP_MODE_TAG，
# 并新增品牌标记 OP_MODE_MARK（规格切换要连图标与观感一起换）。
check("5b 三档界面规格与标签齐备",
      'const OP_MODES = ["apple", "emby", "plex"];' in THEME
      and all(k in THEME for k in ("OP_MODE_LABEL", "OP_MODE_TAG", "OP_MODE_MARK", "OP_ICON_PACK")))
check("5c 图标包三档并存且接入播放器",
      all(f"  {m}: {{" in THEME for m in ("apple", "emby", "plex"))
      and "typeof opModeIcon === \"function\" ? opModeIcon(name) : \"\"" in MEDIA)
check("5d 落点与开关函数齐备",
      "function applyOpMode(" in THEME and "function setOpMode(" in THEME
      and 'setAttribute("data-opmode", mode)' in THEME
      and "opSeg.innerHTML" in THEME and 'data-op-opt=' in THEME)
check("5e 设置项与三语文案齐备",
      'opMode: "apple",' in STATE and "if (OP_MODES.includes(s.opMode)) settings.opMode = s.opMode;" in STATE
      and STATE.count("opModeSaved:") == 3)
# v1.0.4（需求3/4）：选中态改由 syncThemeControls 统一同步（卡片形态 + aria-checked），
# setOpMode 切换后必须调用它，否则高亮会停在上一档。
check("5f2 切换界面规格后同步选中态（高亮不停在上一档）",
      "function setOpMode(" in THEME and "syncThemeControls();" in THEME
      and 'document.querySelectorAll("#opModeSeg [data-op-opt]").forEach(el => {' in THEME
      and "el.dataset.opOpt === currentOpMode()" in THEME)
check("5g 豆瓣未命中时界面给出状态（不是只显示 --）",
      'extras.douban_status = String(dub.match_note || "未收录").trim() || "未收录";' in MEDIA
      and 'esc(meta.douban_status||"--")' in MEDIA
      and 'esc((meta&&meta.douban_status)||"--")' in MEDIA
      and MEDIA.count("douban_status") >= 3)
check("5h 三档操作模式样式（令牌 + 动效 + 图标尺寸）齐备",
      all(f'html[data-opmode="{m}"] {{' in CSS for m in ("apple", "emby", "plex"))
      and "--op-dur:" in CSS and "opAppleIn" in CSS and "html[data-opmode=\"emby\"] .btn::after" in CSS
      and "html[data-opmode=\"plex\"] .movie-rec-card:hover .movie-rec-poster" in CSS)

print("\n== 6. 需求8：多重垂直滚动条治理 ==")
check("6a 覆盖层打开时锁住背景页滚动",
      "html.vh-overlay-open, html.vh-overlay-open body { overflow: hidden !important; }" in CSS
      and 'classList.toggle("vh-overlay-open", open)' in BOOT)
check("6b 挂钩方式为 MutationObserver（不必逐个改打开/关闭逻辑）",
      "new MutationObserver(" in BOOT and 'document.querySelector(OVERLAY_SELECTOR)' in BOOT)
check("6c 内部滚动条禁止滚动穿透",
      "overscroll-behavior: contain;" in CSS and "overscroll-behavior: none;" in CSS)

print("\n== 7. 版本与发布纪律 ==")
check("7a index.html 资源版本 ≥11 处且为本版",
      len(re.findall(r"\?v=1\.0\.4", HTML)) >= 11 and "?v=1.0.1" not in HTML)
check("7b 全部静态资源版本串只出现本版", set(re.findall(r"\?v=([0-9.]+)", HTML)) == {"1.0.4"})
check("7c ASSET / SCRIPT 版本 = 1.0.4",
      'VAULTHUB_ASSET_VERSION = "1.0.4"' in HTML and 'VAULTHUB_SCRIPT_VERSION = "1.0.4"' in STATE)
check("7d 三处标语整串一致",
      len(re.findall(r"v1\.0\.4 · [^<\"]+", HTML)) == 3 and len(set(re.findall(r"v1\.0\.4 · [^<\"]+", HTML))) == 1,
      sorted(set(re.findall(r"v1\.0\.4 · [^<\"]+", HTML))))
# v1.0.4：本文件是 v1.0.2 的历史契约，日志顶部已换成当前版本 ——
# 断言改成「v1.0.2 段落仍然完整」，历史记录不因升版而丢失。
# 注：v1.0.2 当年是以「> 修正版。8 项修正」的续块写在 v1.0.3 段之前的，
# 没有独立的一级标题，所以这里只校验历史要点仍在、且顶部已换成当前版本。
check("7e Update Log 保留 v1.0.2 历史要点",
      "豆瓣评分获取与展示" in LOG and "Apple / Emby / Plex 三档操作模式" in LOG
      and LOG.startswith("# VaultHub 蜀鼠之家 v1.0.4"))
check("7f 发布说明存在且覆盖 8 项", len(NOTES) > 1500 and all(
      k in NOTES for k in ("季度展示回归", "演职人员全量修复", "视频推荐定位与播放修复", "推荐机制全量修复",
                           "豆瓣评分获取与展示", "操作模式", "多重垂直滚动条治理")))
check("7g 安装/升级脚本与 subtitle-api 版本同步",
      'VERSION="v1.0.4"' in rd("scripts/install.sh") and 'VERSION="v1.0.4"' in rd("scripts/upgrade.sh")
      and "VaultHub-Subtitle/1.0.4" in rd("subtitle-api/main.go"))
check("7h 本轮只推 Gitea + Docker Hub（GitHub 按 20 版本节流）",
      "GitHub" in NOTES and "20" in NOTES)

print("\n== 8. 新增测试文件在库内 ==")
for rel in ("media-go/v1002_douban_test.go", "tests/v1002_behavior.js", "tests/test_v1002_behavior.py",
            "tests/test_v1002_contract.py"):
    check(f"8 {rel} 存在", (ROOT / rel).exists())

print("\n== 9. 洗版自查（本仓禁止真实域名 / 内网 IP / 卷路径字面量）==")
BANNED = ["enged" + ".top", "engd" + ".top", "192" + ".168.", "/vol" + "1", "/vol" + "2", "/vol" + "3"]
for rel in ("media-go/douban.go", "media-go/v1002_douban_test.go", "web/js/02-media.js",
            "web/js/06-theme.js", "web/css/main.css", "tests/v1002_behavior.js",
            "tests/test_v1002_contract.py", ".github/RELEASE_NOTES_1.0.2.md", "Update Log.md"):
    body = rd(rel)
    check(f"9 {rel} 无禁用字面量", not any(b in body for b in BANNED), [b for b in BANNED if b in body])

print("\n===== v1.0.4 契约测试：", "全部通过 =====" if ok else "存在失败 =====")
raise SystemExit(0 if ok else 1)
