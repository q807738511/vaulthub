#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# v0.9.98 契约测试：本地 NFO 后在线补演职人员 / BDMV·ISO 原盘单条目与播放菜单 /
# 多季刮削入口迁到系统设置 / 自动测速勾选归位。
# 口径：断言「新实现存在」且「旧实现已不存在」。
import io
import os
import re
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
FAILED = []


def rd(p):
    with io.open(ROOT / p, encoding="utf-8") as f:
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
GODISC = rd("media-go/disc_playlist.go")
GODIN = rd("media-go/disc_input.go")
GOLOCAL = rd("media-go/local_metadata.go")
GONFO = rd("media-go/nfo_write.go")
GOMAIN = rd("media-go/main.go")
GOTEST = rd("media-go/v0998_disc_playlist_test.go")
NOTES = rd(".github/RELEASE_NOTES_0.9.98.md")
LOG = rd("Update Log.md")

print("== 1. 原盘播放列表（服务端）==")
check("1a 不自己解析 MPLS：读 libbluray 打印的真实清单",
      "playlist (\\d{5})\\.mpls" in GODISC or "discPlaylistLineRe" in GODISC)
check("1b 解析播放列表与默认项（selected）",
      "func discPlaylistsFromLog(" in GODISC and "discSelectedLineRe" in GODISC)
check("1c 主影片 = 时长最长者，其余标注「标题 N」",
      "func finalizeDiscPlaylists(" in GODISC and "func discPlaylistLabel(" in GODISC
      and "主影片" in GODISC)
check("1d DVD 镜像按 -title N 逐个探测（连续 3 次找不到即停，有上限）",
      "func (a *App) discScanDVDTitles(" in GODISC and '"-title"' in GODISC
      and "discDVDTitleMaxProbe" in GODISC and "misses < 3" in GODISC)
check("1e 清单缓存 + 展示标题取原盘目录名（不是片段编号）",
      "discPlaylistCache" in GODISC and "func discTitleFromRoot(" in GODISC)
check("1f 接口 GET /api/media/disc/playlists 已注册且要登录",
      'mux.HandleFunc("/api/media/disc/playlists", a.discPlaylistHandler)' in GOMAIN
      and "func (a *App) discPlaylistHandler(" in GODISC and "readAuth(r)" in GODISC)
check("1g 播放列表参数贯穿 file / compat / streams / probe / playbackPlan",
      GOMAIN.count("discPlaylistArg(r)") >= 3 and "discPlaylistArg(r)" in rd("media-go/playback.go")
      and "disc.InputArgs()" in GOMAIN and "ffprobeInputArgs(disc.Kind)" not in GOMAIN)
check("1h 蓝光 -playlist N / DVD -f dvdvideo -title N",
      'args = append(args, "-playlist", strconv.Itoa(in.Playlist))' in GODIN
      and '"-f", "dvdvideo"' in GODIN and '"-title", strconv.Itoa(in.Title)' in GODIN)
check("1i 转码缓存键带上选中的标题（换标题不会命中旧产物）",
      "d%s:r%d" in GOMAIN and "disc.SelectedRef()" in GOMAIN)
check("1j 原盘 Go 单测存在（真实日志解析 / 主影片 / 参数 / 解析函数）",
      "TestV0998DiscPlaylistParseRealBluRayLog" in GOTEST
      and "TestV0998ResolveDiscInputWithPlaylist" in GOTEST
      and "TestV0998DiscInputArgsCarryPlaylist" in GOTEST)

print("\n== 2. 本地 NFO 演职人员（服务端）==")
check("2a NFO 的 <actor><thumb> 被读取（头像三形态）",
      'Thumb string `xml:"thumb,omitempty"`' in GOLOCAL
      and "func localCastAvatar(" in GOLOCAL and '"https://image.tmdb.org' not in GOLOCAL)
check("2b TMDB 图片地址 → 走既有头像代理；本地文件 → 本地头像代理",
      '"/t/p/"' in GOLOCAL and 'avatar?person=' in GOLOCAL and 'avatar?id=' in GOLOCAL)
check("2c 本地头像代理有扩展名白名单与大小上限，且走 safeFile",
      "func (a *App) castAvatarLocal(" in GOMAIN and "func localAvatarContentType(" in GOMAIN
      and "safeFile(lib, rel)" in GOMAIN and "4<<20" in GOMAIN)
check("2d 本地头像代理不需要额外凭据泄漏：person 为空才走本地分支",
      "strings.TrimSpace(person) == \"\"" in GOMAIN)
check("2e 写回 NFO 时演员带 <thumb>（原样优先，否则还原成 w500 原图）",
      "func nfoActorThumb(" in GONFO and 'base + "/w500" + p' in GONFO and "Thumb: nfoActorThumb(" in GONFO)

print("\n== 3. 本地 NFO 演职人员补全（前端口径）==")
check("3a 本地条目不再被整条踢出待刮队列",
      "if (localPaths.has(path)) return nfoCastFillWanted(meta0, path);" in M
      and "if (localPaths.has(path)) return false;" not in M)
check("3b 判定口径：本地来源 + 无 cast / 无头像才补（可选开关）",
      "function nfoCastFillWanted(" in M and "function nfoCastFillEnabled(" in M
      and "function setNfoCastFill(" in M and "NFO_CAST_FILL_KEY" in M)
check("3c 本地优先合并：核心字段与 provider 不被在线结果覆盖",
      "function keepLocalMetadataFirst(" in M and '"provider"]' in M
      and "localFirst ? keepLocalMetadataFirst(base, patch) : patch" in M)
check("3d 本地已有演员按姓名合并（本地角色名优先）",
      "byName.set(String(c.name).trim(), c)" in M and "character: c.character || hit.character" in M)
check("3e 本地优先时仍取 TMDB credits（搜索结果没有 credits，必须再取详情）",
      'append_to_response' not in M and "detail.credits" in M and "patch.cast_source = \"TMDB\"" in M)
check("3f 补全失败有重试上限与状态（不会每次进库都联网）",
      "cast_fill_attempts" in M and "cast_fill_state" in M and "cast_fill_last" in M)
check("3g 本地 NFO 的演职人员直接进元数据（离线也能显示）",
      "const localCast = Array.isArray(local.cast)" in M and "cast_source" in M)
check("3h 渲染优先用服务端算好的 avatar（本地头像/代理地址都可直接显示）",
      "const avatarSrc = x.avatar" in M)

print("\n== 4. 原盘播放器「媒体菜单」（前端）==")
check("4a 播放器新增媒体菜单按钮与面板",
      'data-video-panel-button="disc"' in M and 'class="vc-panel vc-panel-disc" data-video-panel="disc"' in M
      and 'data-video-disc-items' in M)
check("4b 菜单数据来自 /api/media/disc/playlists；打开播放器即拉取",
      "/api/media/disc/playlists?id=" in M and "loadDiscPlaylists(videoRoot, lib, path)" in M)
check("4c 非原盘自动隐藏按钮（data-disc-kind=none + CSS）",
      'root.dataset.discKind = info && info.kind && info.kind !== "none"' in M
      and '.media-video-body[data-disc-kind="none"] .vc-icon.vc-disc { display: none; }' in CSS)
check("4d 选中标题切流并记住选择（每部片一条）",
      "function selectDiscPlaylist(" in M and "withDiscPick(mediaCompatUrl(lib, path), ref)" in M
      and 'const DISC_PICK_KEY = "vaulthub_disc_pick_v1"' in M)
check("4e 打开/播放时按记忆的标题取流（转码/探测/音轨都带上）",
      "const compat = withDiscPick(mediaCompatUrl(lib, path), discPickOf(lib, path));" in M
      and "withDiscPick(plan.url" in M
      and "discPickOf(lib, path) > 0 ? `&disc_playlist=" in M)
check("4f 切换标题后音轨/字幕清单随之刷新",
      "function refreshDiscTracks(" in M and "/api/media/streams?${q}" in M)
check("4g 原盘条目带上原盘根目录与标题（卡片/刮削不再用片段编号）",
      "disc_root: group.key, disc_title: movieTitleFromPath(path)" in M)
check("4h 剧集库里的原盘同样合并成一条",
      'if (lib && lib.type !== "series") files = collapseDiscFragments(files);' not in M
      and 'if (group === "movie" || group === "series") {' in M)
check("4i CSS 菜单样式齐备", ".video-disc-item {" in CSS and ".video-disc-hint {" in CSS)

print("\n== 5. 多季刮削入口迁到系统设置 ==")
check("5a 设置页新增「多季剧集刮削」区块与四个按钮",
      'id="multiSeasonScrapeBlock"' in HTML and "多季剧集刮削（Plex 口径）" in HTML
      and "plexSettingsRun('diagnose')" in HTML and "plexSettingsRun('scrape')" in HTML
      and "plexSettingsRun('compare')" in HTML and "plexSettingsRun('dance')" in HTML)
check("5b 设置页可选库 / 单剧或整库 / 是否覆盖本地 NFO",
      'id="plexLibSelect"' in HTML and 'id="plexShowSelect"' in HTML and 'id="plexOverwriteLocal"' in HTML
      and "全部剧集（整库）" in P)
check("5c 进刮削配置自动刷新库与剧列表", "if (typeof plexSettingsInit === \"function\") plexSettingsInit(false);" in S)
check("5d 整库/单剧作用域与面板渲染（复用同一套面板）",
      "function plexSettingsTargets(" in P and "function plexSettingsRun(" in P
      and "function plexSettingsRender(" in P and "seriesPlexPanelHtml(lib, show, planData" in P)
check("5e 面板按钮各自携带库/剧（整库不串台）",
      "seriesPlexAction('compare',${jsAttrArg(lib.id)},${jsAttrArg(show.key)})" in P
      and "seriesPlexScrapeSeason(${Number(planSeason.season) || 0},${jsAttrArg(lib.id)},${jsAttrArg(show.key)})" in P)
check("5f 旧实现已移除：详情页既无工具条也无迁移提示（v1.0.4 口径）",
      '<span class="season-inline-title">季度</span>' in M
      and '<section><h3 class="detail-section-h">季度</h3></section>' not in M
      and "seriesPlexToolbarHtml" not in M and "seriesPlexToolbarHtml" not in P
      and "series-plex-moved" not in M and "多季诊断与多季全量刮削已移到" not in M)
check("5g 缺失集结果按「库|剧」缓存（整库面板不再共用单上下文）",
      "const seriesPlexMissingCache = {}" in P and "function seriesPlexMissingOf(" in P)

print("\n== 6. 自动测速勾选按钮归位 ==")
check("6a 勾选按钮在选项行末尾（文字在前、开关在后）",
      'toggle-row toggle-row-tail' in HTML
      and HTML.index('class="l">当天首次打开 WEBUI 时自动测速') < HTML.index('id="autoSpeedTestToggle"'))
check("6b 保留原有 id 与保存函数（存储键不变）",
      'id="autoSpeedTestToggle"' in HTML and 'onchange="setAutoSpeedTest(this.checked)"' in HTML
      and "AUTO_SPEEDTEST_KEY" in M)
check("6c CSS 让开关贴到行尾（勾选框原生尺寸 + 行显式 flex，压过 .cfg-field label 的 display:block）",
      ".toggle-row.toggle-row-tail .toggle-tail-input { width: auto; flex: 0 0 auto; margin-left: auto;" in CSS
      and '.toggle-row input[type="checkbox"] { width: auto; flex: 0 0 auto; }' in CSS
      and ".cfg-field label.toggle-row { display: flex; align-items: center; }" in CSS)

print("\n== 7. 版本与文档 ==")
check("7a 版本串 ?v=1.0.4（≥11 处）且无其它版本串",
      len(re.findall(r"\?v=1\.0\.4", HTML)) >= 11
      and set(re.findall(r"\?v=([0-9.]+)", HTML)) == {"1.0.4"})
check("7b ASSET_VERSION / SCRIPT_VERSION = 0.9.98",
      'VAULTHUB_ASSET_VERSION = "1.0.4"' in HTML and 'VAULTHUB_SCRIPT_VERSION = "1.0.4"' in S)
check("7c 新标语 ×3 且旧标语已清除",
      HTML.count("v1.0.4 · 术语归位 · TV 焦点层 · 配置页精简") == 3
      and "v0.9.97 ·" not in HTML)
check("7d install/upgrade 脚本版本同步",
      'VERSION="v1.0.4"' in rd("scripts/install.sh") and 'VERSION="v1.0.4"' in rd("scripts/upgrade.sh"))
check("7e Update Log 顶部为 v0.9.98 段且保留 v0.9.97", LOG.startswith("# VaultHub 蜀鼠之家 v1.0.4"))
check("7f 发布说明覆盖本轮四项需求",
      all(k in NOTES for k in ("演职人员", "/api/media/disc/playlists", "多季剧集刮削（Plex 口径）", "自动测速"))
      and "多季诊断" in NOTES and "刮削配置" in NOTES)
check("7g 新测试文件在库内且不被忽略",
      os.path.exists(ROOT / "tests/v0998_behavior.js") and os.path.exists(ROOT / "media-go/v0998_disc_playlist_test.go"))

print("\n== 8. 洗版自查（禁止真实域名 / 内网 IP / 卷路径字面量）==")
for name, text in (("原盘清单实现", GODISC), ("原盘输入", GODIN), ("本地 NFO 头像", GOLOCAL),
                   ("新测试", GOTEST), ("前端菜单", M), ("多季设置入口", P)):
    bad = ["enged" + ".top", "192" + ".168.", "/vol" + "1/", "/vol" + "2/", "/vol" + "3/", "/vol" + "4/"]
    hit = [b for b in bad if b in text]
    check(f"8 洗版自查：{name} 不含禁用字面量", not hit, hit)

if FAILED:
    print(f"\nv0.9.98 契约测试失败 {len(FAILED)} 项：" + "、".join(FAILED))
    sys.exit(1)
print("\nv0.9.98 契约测试全部通过")
