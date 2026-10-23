#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# v0.9.97 契约测试：多季剧集按 Plex 口径刮削（目录结构 / 文件命名 / 缺失集比对 / 重匹配）。
# 口径：断言「新实现存在」且「旧实现已不存在」；历史断言按新口径重定向。
import io
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FAILED = []


def rd(p):
    with io.open(os.path.join(ROOT, p), encoding="utf-8") as f:
        return f.read()


def check(label, cond, detail=""):
    if cond:
        print(f"  ✔ {label}")
    else:
        print(f"  ✗ {label}" + (f"  [{detail}]" if detail else ""))
        FAILED.append(label)


HTML = rd("index.html")
CSS = rd("web/css/main.css")
M = rd("web/js/02-media.js")
P = rd("web/js/03-series-plex.js")
S = rd("web/js/01-state.js")
GO = rd("media-go/plex_naming.go")
GOAPI = rd("media-go/series_plan.go")
GOMAIN = rd("media-go/main.go")
GOTEST = rd("media-go/plex_naming_test.go")
NOTES = rd(".github/RELEASE_NOTES_0.9.97.md")
LOG = rd("Update Log.md")

print("== 1. 服务端 Plex 命名引擎（media-go/plex_naming.go）==")
check("1a 安全：不需要鉴权，纯函数无 IO", '"os"' not in GO and '"net/http"' not in GO)
check("1b 方括号（含全角）整体剥离 + 方括号内季集号单独判定",
      "func plexStripBrackets(" in GO and "func plexBracketSeasonEpisode(" in GO
      and "`\\[[^\\]]*\\]|【[^】]*】`" in GO)
check("1c 剧根目录解析出剧名 / 首播年份 / 季标签",
      "func plexParseShowDir(" in GO and "plexYearSuffixRe" in GO and "plexShowSeasonTagRe" in GO)
check("1d 季目录：Season XX / SXX / 第X季 / Specials / Season 00 → 季号（特别篇=0）",
      "func plexParseSeasonDir(" in GO and "plexSpecialDirRe" in GO and "func plexCnNumber(" in GO)
check("1e 文件名六种季集形式 + 多集合并",
      "func plexParseEpisodeTag(" in GO and "plexEpSERe" in GO and "plexEpXRe" in GO
      and "plexEpCnRe" in GO and "plexEpERe" in GO and "plexBareNumRe" in GO
      and "tag.EpisodeEnd, tag.Multi = end, true" in GO)
check("1f 季目录优先于文件名季号", "季目录是权威" in GO and "season = dirSeason" in GO)
check("1g 解析失败以文件名展示（不吞条目）", "display = strings.TrimSpace(stem)" in GO)
check("1h 缺失集比对 + E07-E09 压缩标签",
      "func plexMissingEpisodes(" in GO and "func plexEpisodeRanges(" in GO
      and "func plexMissingLabel(" in GO and "func plexSeasonMissingReport(" in GO)
check("1i 多季聚合：年份/季标签写法不同也归同一部剧（聚合键归一化）",
      "func plexShowKey(" in GO and "func normalizeSeriesTitle(" in GO
      and "plexShowGroup" in GO and "MultiSeason" in GO and "HasSpecials" in GO)
check("1j 全球盘结构文件与非媒体文件不进方案",
      "if !plexIsMediaExt(ext) {" in GO and "inBluRayStructure(slash)" in GO)
check("1k 有单测文件", "func TestPlexParseShowDir(" in GOTEST and "func TestPlexPlanMultiSeasonGrouping(" in GOTEST
      and "func TestPlexMultiEpisodeFileCoversBothNumbers(" in GOTEST)

print("\n== 2. 服务端接口与路由 ==")
check("2a /api/media/series/plan 走 readAuth",
      "func (a *App) seriesPlan(" in GOAPI and GOAPI.split("func (a *App) seriesPlan(")[1][:300].count("readAuth(r)") == 1)
check("2b /api/media/series/missing 走 readAuth 且 TMDB ID 做整数校验",
      "func (a *App) seriesMissing(" in GOAPI
      and GOAPI.split("func (a *App) seriesMissing(")[1][:900].count("readAuth(r)") == 1
      and "invalid TMDB id" in GOAPI)
check("2c 官方集数取最大集号（避免特别篇占位误报）", "maxNum" in GOAPI and "official[season.Season] = maxNum" in GOAPI)
check("2d 未知/失败情形不猜：404 视为该季无数据、未配 key 只提示",
      "res.StatusCode == 404" in GOAPI and "TMDB_API_KEY 未配置" in GOAPI)
check("2e 路由已注册", 'mux.HandleFunc("/api/media/series/plan", a.seriesPlan)' in GOMAIN
      and 'mux.HandleFunc("/api/media/series/missing", a.seriesMissing)' in GOMAIN)

print("\n== 3. 前端季集解析升级（02-media.js）==")
PARSE = M.split("function parseSeriesEpisode(path)")[1].split("\nfunction buildSeriesShows")[0]
check("3a 方括号内容整体忽略（含全角）", "PLEX_BRACKET_STRIP_RE" in M and "plexStripBracketsLocal" in PARSE)
check("3b 季目录优先于文件名季号", "if (dirSeason >= 0) season = dirSeason;" in PARSE)
check("3c Specials / Season 00 → 第 0 季，且不会被 `season || 1` 抹成第 1 季",
      "PLEX_SPECIAL_DIR_RE" in M and "season: (season >= 0 ? season : 1)" in PARSE
      and "season: season || 1" not in PARSE)
check("3d 多集合并 sXXeYY-eZZ → episodeEnd/multi + S02E18-E19 标签",
      "episodeEnd = Math.max(ep, end)" in PARSE and "multi: episodeEnd > episode" in PARSE
      and "-E${pad(episodeEnd)}" in PARSE)
check("3e E05 简写只在有季目录时生效", "if (!episode && dirSeason >= 0) { m = stem.match(PLEX_EP_E_RE)" in PARSE)
check("3f 纯数字命名标记 by=number（Plex 不认，交由体检提示）", 'assign(m, "number", false)' in PARSE)
check("3g 解析失败以文件名当展示名与标签", ": clean(stem);" in PARSE and "title = episode > 0 ? `第 ${episode} 集` : clean(stem)" in PARSE)
check("3h 剧名剥离年份与季标签（plexShowTitleLocal）",
      "function plexShowTitleLocal(" in M and "plexShowTitleLocal(dirs[showIdx]" in PARSE)
check("3i 剧集详情「季度」区保留，工具条与迁移提示都已清除（v1.0.6 口径：季名行内加粗）",
      '<span class="season-inline-title">季度</span>' in M
      and '<section><h3 class="detail-section-h">季度</h3></section>' not in M
      and 'series-plex-moved' not in M and '多季诊断与多季全量刮削已移到' not in M
      and "seriesPlexToolbarHtml" not in M
      and 'id="multiSeasonScrapeBlock"' in HTML and "function plexSettingsRun" in P)
check("3j 季卡标题走 Plex 季称号（第 0 季 = 特别篇）",
      # v0.9.99（需求4）：季称号走 Plex 口径；v1.0.6（需求1）回到独立季名行。
      "${esc(seriesPlexSeasonLabel(season.season))}${seasonName ? ` · ${esc(seasonName)}` : \"\"}" in M
      and "series-season-head" in M
      and "series-season-prefix" not in M)

print("\n== 4. 前端多季刮削与诊断（03-series-plex.js）==")
check("4a 脚本加载于 02-media.js 之后且带版本参数",
      '<script src="/web/js/03-series-plex.js?v=1.0.6"></script>' in HTML
      and HTML.index("02-media.js?v=1.0.6") < HTML.index("03-series-plex.js?v=1.0.6"))
check("4b 多季全量刮削：逐季取季元数据并按集号写分集名",
      "async function scrapeSeriesAllSeasons(" in P and "function applySeriesSeasonScrape(" in P
      and "const first = byNum.get(Number(parsed.episode) || 0);" in P)
check("4c 多集合并文件写两集名（E18 名 / E19 名）",
      "title = `${title} / ${secondName}`;" in P and "end > (Number(parsed.episode) || 0)" in P)
check("4d 季号/季标签/季名/季简介写回本地记录（跨设备持久化字段）",
      "rec.season_num =" in P and "rec.season_tag =" in P and "rec.season_name =" in P
      and "rec.season_overview =" in P)
check("4e 本地 NFO 优先（Local Media Assets 口径）+ 覆盖开关",
      'String(cur.provider || "") === "本地 NFO"' in P
      and "const overwriteLocal = !!(opts && opts.overwriteLocal);" in P
      and "skippedLocal" in P
      and 'id="seriesPlexOverwriteLocal"' in P)
check("4f 官方缺该集时保留文件名/集号展示（不写空标题）",
      'const fallback = String(parsed.title || "").trim() || String(movieTitleFromPath(path) || "").trim();' in P)
check("4g 缺失集比对调用服务端接口并压缩成 E07-E09",
      "/api/media/series/missing?" in P and "async function seriesPlexCompareMissing(" in P
      and "function seriesPlexMissing(" in P and "function seriesPlexEpisodeRanges(" in P)
check("4h 重匹配（Plex Dance）：清本地记录 + 清剧卡记忆 + 重新逐季匹配",
      "async function seriesPlexRematch(" in P and "delete all[p];" in P
      and "show.tmdb_id = \"\";" in P and "await scrapeSeriesAllSeasons(lib.id, show.key" in P)
check("4i0 服务端按剧输出问题清单（面板直接渲染该剧这一段）",
      'Issues []*plexEpisodeEntry `json:"issues"`' in GO and "show.Issues = append(show.Issues, e)" in GO)
check("4i 命名体检渲染问题清单 + 建议路径 + 复制按钮",
      "function seriesPlexIssueRow(" in P and "seriesPlexCopySuggestion(this)" in P
      and "建议改为" in P)
check("4j 面板与前端剧卡按剧根目录对齐（不靠各自的归一化键）",
      "function seriesPlexShowInPlan(" in P and "function seriesPlexShowDirOf(" in P)
check("4k 方案数据来自服务端 /api/media/series/plan",
      "function loadSeriesPlexPlan(" in P and "/api/media/series/plan?lib=" in P)
check("4l TMDB ID 缺失时给出可执行提示而不是静默失败",
      "async function seriesPlexTmdbId(" in P and "未匹配到 TMDB 条目" in P)
check("4m 面板入口与弹窗容器齐备",
      'id="seriesPlexModal"' in HTML and 'id="seriesPlexContent"' in HTML
      and "function openSeriesPlexPanel(" in P and "function closeSeriesPlexPanel(" in P
      and "seriesPlexAction('compare'," in P)
check("4n CSS 面板样式齐备", ".series-plex-table {" in CSS and ".series-plex-issues {" in CSS
      and ".series-plex-suggest code {" in CSS)

print("\n== 5. 版本与文档 ==")
check("5a 版本串 ?v=1.0.6 ≥11（新增 03-series-plex.js 后仍全站同版）且无其它版本串",
      len(re.findall(r"\?v=1\.0\.6", HTML)) >= 11
      and set(re.findall(r"\?v=([0-9.]+)", HTML)) == {"1.0.6"})
check("5b ASSET_VERSION / SCRIPT_VERSION = 0.9.98",
      'VAULTHUB_ASSET_VERSION = "1.0.6"' in HTML and 'VAULTHUB_SCRIPT_VERSION = "1.0.6"' in S)
check("5c 新标语 ×3 且旧标语已清除",
      HTML.count("v1.0.6 · 三套规格主题 · 壁纸随内容 · 返回键归位") == 3
      and "v0.9.96 ·" not in HTML)
check("5d install/upgrade 脚本版本同步",
      'VERSION="v1.0.6"' in rd("scripts/install.sh") and 'VERSION="v1.0.6"' in rd("scripts/upgrade.sh"))
check("5e 发布说明覆盖四项需求",
      all(k in NOTES for k in ("方括号", "sXXeYY-eZZ", "缺失集", "Plex Dance", "Local Media Assets")))
check("5f Update Log 顶部为 v0.9.98 段且保留 v0.9.96",
      LOG.startswith("# VaultHub 蜀鼠之家 v1.0.6") and "# VaultHub 蜀鼠之家 v0.9.96" in LOG
      and "## 验证（本轮实测）" in LOG)

print("\n== 6. 洗版自查（本仓禁止真实域名 / 内网 IP / 卷路径字面量）==")
for name, text in (("测试文件自身", rd("tests/test_v0997_contract.py")),
                   ("Plex 引擎", GO), ("多季接口", GOAPI), ("前端多季脚本", P)):
    bad = [p for p in ("enged" + ".top", "192" + ".168.", "/vol" + "1/", "/vol" + "3/") if p in text]
    check(f"6 {name}不含禁用字面量", not bad, str(bad))

print()
if FAILED:
    print(f"v0.9.97 契约测试失败 {len(FAILED)} 项：" + "、".join(FAILED))
    sys.exit(1)
print("v0.9.97 契约测试全部通过")
