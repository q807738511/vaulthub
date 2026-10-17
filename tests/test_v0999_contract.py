#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v1.0.0 契约测试：版本、文档、Go 侧图形字幕烧录、前端演职人员/推荐/季度前缀、缩小态 CSS。

本测试只做静态契约与「旧实现确实被移除」的断言，行为验证在 v0999_behavior.js 与
真实容器验证里。
"""
import os
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
MEDIA = rd("web/js/02-media.js")
PLEX = rd("web/js/03-series-plex.js")
CSS = rd("web/css/main.css")
MAIN = rd("media-go/main.go")
LM = rd("media-go/local_metadata.go")
STATE = rd("web/js/01-state.js")
LOG = rd("Update Log.md")
NOTES = rd(".github/RELEASE_NOTES_1.0.0.md")
# v1.0.0：本文件是 v0.9.99 那一轮的契约测试，功能断言指向当时的发布说明，
# 版本类断言才跟着当前版本号走（否则每次升版都会误判「需求没写进说明」）。
NOTES_V0999 = rd(".github/RELEASE_NOTES_0.9.99.md")

# ---------------------------------------------------------------- 1 版本
check("1 版本串 ?v=1.0.4 且 ≥11 处（新增脚本后仍全站同版）",
      len(re.findall(r"\?v=1\.0\.4", HTML)) >= 11 and "?v=0.9.98" not in HTML,
      len(re.findall(r"\?v=1\.0\.4", HTML)))
check("1 资源版本常量一致",
      'window.VAULTHUB_ASSET_VERSION = "1.0.4";' in HTML
      and 'const VAULTHUB_SCRIPT_VERSION = "1.0.4";' in STATE)
check("1 安装/升级脚本同版",
      'VERSION="v1.0.4"' in rd("scripts/install.sh") and 'VERSION="v1.0.4"' in rd("scripts/upgrade.sh"))
check("1 标语 ×3 且历史标语已清除",
      HTML.count("v1.0.4 · 术语归位 · TV 焦点层 · 配置页精简") == 3
      and "v0.9.98 · 原盘播放菜单与演职人员补全" not in HTML)

# ---------------------------------------------------------------- 2 文档
check("2 发布说明存在且够长", len(NOTES) >= 2000, len(NOTES))
check("2 发布说明覆盖四项需求",
      all(k in NOTES_V0999 for k in ["演职人员", "图形字幕", "缩小", "前缀"]))
check("2 发布说明写明发布策略（GitHub 频率 + windows-desktop）",
      "GitHub" in NOTES_V0999 and "20 个版本" in NOTES_V0999 and "windows-desktop" in NOTES_V0999)
check("2 Update Log 顶部为本版（仓库格式：# VaultHub 蜀鼠之家 vX 置顶）", LOG.startswith("# VaultHub 蜀鼠之家 v1.0.4"))

# ---------------------------------------------------------------- 3 Go：图形字幕
check("3a 新增字幕类型判定（图形字幕含 PGS/DVD/DVB/XSUB）",
      "func subtitleTrackKind(codec string) string" in MAIN
      and 'case "hdmv_pgs_subtitle", "dvd_subtitle", "dvb_subtitle", "xsub", "dvb_teletext":' in MAIN)
check("3b streams 不再跳过图形字幕（旧实现确实移除）",
      "if s.CodecName == \"hdmv_pgs_subtitle\" || s.CodecName == \"dvd_subtitle\" || s.CodecName == \"dvb_subtitle\" {" not in MAIN
      and "subtitleTrackKind(s.CodecName)" in MAIN
      and '"burn_track"' in MAIN)
check("3c 内嵌字幕清单抽成公共函数（面板与搜索同一口径）",
      "func embeddedSubtitleTracks(ctx context.Context, disc discInput, libID, relPath string) []map[string]any" in MAIN
      and "embeddedSubtitleTracks(subCtx, disc, l.ID, relPath)" in MAIN)
check("3d compat 支持 sub_track 并强制 full_transcode",
      'r.URL.Query().Get("sub_track")' in MAIN and 'mode = "full_transcode"' in MAIN)
check("3e 烧录用 overlay 且软编码 libx264（不用硬件编码链）",
      "[0:v:0]%ssetpts=PTS-STARTPTS[v0];[v0][%s]overlay=format=auto:eof_action=pass[vout]" in MAIN
      and 'subSpec := fmt.Sprintf("0:s:%d", subTrack)' in MAIN
      and '"-c:v", "libx264"' in MAIN)
# v0.9.99 续（容器实测发现的第三处根因）：原盘直接用 bluray: overlay 时 PGS 流没有尺寸信息，
# sub2video 退回 720x480 画布，字幕位图落在画布外（实测黑底 YMAX 恒 16＝纯黑，等于没烧）。
# 必须先 -c:s copy 抽成 .sup 再作第二路输入 [1:s:0]overlay，并保证抽不出来时能退回原地。
check("3e2 原盘图形字幕先抽 .sup 再作第二路输入（否则字幕根本叠不上）",
      'if burnInput != "" {\n\t\t\tsubSpec = "1:s:0"' in MAIN
      and '"-map", fmt.Sprintf("0:s:%d", subTrack), "-c:s", "copy", "-f", "sup"' in MAIN
      and 'disc.Kind != discInputBluRay && disc.Kind != discInputDVD' in MAIN
      and 'args = append(args, "-i", burnInput)' in MAIN)
check("3e3 抽出物落在 burnsub/ 子目录且失败安全退回",
      'filepath.Join(filepath.Dir(cache), "burnsub")' in MAIN
      and 'if burnInput != "" {\n\t\t\targs = append(args, "-i", burnInput)\n\t\t}' in MAIN)
check("3f 缓存键并入 sub_track（换字幕不命中旧产物）",
      "disc.SelectedRef(), subTrack))" in MAIN and 'r%d:s%d' in MAIN)
check("3g 实时流与后台预转码都带 sub_track",
      "compatArgsScaled(ctx, disc.Spec, audioTrack, hw, mode, maxHeight, subTrack, burnInput)" in MAIN
      and "subTrack int, burnInput string) (pre []string, mid []string) {" in MAIN
      and "a.buildCompatCache(r.Context(), disc, cache, audioTrack, hw, mode, maxHeight, subTrack, burnInput)" in MAIN)
check("3h 字幕搜索补上读权限校验",
      "func (a *App) subtitle(w http.ResponseWriter, r *http.Request) {\n\tif !readAuth(r) {" in MAIN)
check("3i 字幕搜索扫描子目录与剧名根目录，并支持集号匹配",
      '[]string{"Subs", "subs", "Sub", "sub", "Subtitles", "subtitles", "字幕"}' in MAIN
      and "seriesShowDirs(l, d)" in MAIN and "func subtitleNameMatches(" in MAIN and "func episodeTokenOf(" in MAIN)
SUBAPI = rd("subtitle-api/main.go")
check("3k 字幕服务（「搜索并挂载」的真实入口）改为聚合器：内嵌轨 + 库感知本地字幕",
      "func embeddedFromMediaAPI(r *http.Request, id, rawPath string) []Subtitle" in SUBAPI
      and "add(embeddedFromMediaAPI(r, id, rawPath))" in SUBAPI
      and '"MEDIA_API"' in SUBAPI)
check("3l 字幕服务不再因「文件解析失败」整体 400（原盘片段路径以前直接失败）",
      'http.Error(w, e.Error(), 400)' not in SUBAPI
      and 'log.Printf("subtitle: skip local/online providers (%v)", e)' in SUBAPI)
check("3m 内嵌轨字段穿透到前端（kind/text/burn_in/burn_track）",
      'BurnTrack *int   `json:"burn_track,omitempty"`' in SUBAPI
      and 'Provider: "内嵌"' in SUBAPI)
check("3j 媒体 API 的字幕搜索返回内嵌轨 + 本地文件两类结果",
      '"items": items, "count": len(items)' in MAIN and 'entry["burn_track"] = s["burn_track"]' in MAIN)

# ---------------------------------------------------------------- 4 Go：本地 NFO 上溯
check("4a 剧集库 NFO 逐级上溯到剧名根目录",
      "for _, showDir := range seriesShowDirs(lib, dir) {" in LM
      and '[]string{"tvshow.nfo", "movie.nfo"}' in LM)
# v1.0.4（需求2）：头像解析抽成 nfoCastEntries(nfoDir)：show 级 NFO 的
# `.actors/x.jpg` 仍按「NFO 所在目录」解析，剧集库补齐 tvshow.nfo 时同样走它。
check("4b show 级 NFO 的相对头像按 NFO 目录解析",
      "localCastAvatar(lib, nfoDir, strings.TrimSpace(a.Thumb))" in LM
      and "m.Cast = append(m.Cast, nfoCastEntries(lib, filepath.Dir(nfo), doc.Actors)...)" in LM
      and "nfoCastEntries(lib, filepath.Dir(cand), doc.Actors)" in LM)
check("4c 电影库不上溯（不会误读上层目录 NFO）",
      'if nfo == "" && lib.Type == "series" {' in LM)

# ---------------------------------------------------------------- 5 前端：演职人员与推荐
check("5a 演职人员本地优先合并（不再被 TMDB 覆盖）",
      "function mergeCastKeepLocal(localCast, tmdbCast)" in MEDIA
      and "cast:mergeCastKeepLocal(meta.cast,detail.credits?.cast)" in MEDIA
      and "extras.cast = mergeCastKeepLocal(localShowCast, d.credits?.cast)" in MEDIA)
check("5b 剧集详情读取本地 NFO 演职人员（show 级）",
      "const localShowCast = Array.isArray(sdata && sdata.cast) ? sdata.cast : [];" in MEDIA
      and "if (localShowCast.length) extras.cast = mergeCastKeepLocal(localShowCast, []);" in MEDIA)
check("5c 推荐合并去重 + 本地库补位",
      "function fillRecommendations(primary, local, limit = 20)" in MEDIA
      and "function localRecommendationItems(baseMeta, lib, opts = {})" in MEDIA
      and "fillRecommendations(movieRecommendationsFor(detail,meta),localRecommendationItems(meta,lib))" in MEDIA
      and MEDIA.count("localRecommendationItems(meta,lib)") >= 3)
check("5d 本地推荐按同类型/同演职人员打分并排除同剧",
      "score += 3" in MEDIA and "score += 2" in MEDIA
      and 'const excludeShow = String(opts.excludeShow || base.show_title || "").trim().toLowerCase();' in MEDIA)
check("5e 剧集详情的推荐也会本地补位",
      "localRecommendationItems({ ...hero, cast: extras.cast || localShowCast, genres: extras.genres || hero.genres }, lib, { excludeShow: show.title })" in MEDIA)

# ---------------------------------------------------------------- 6 前端：字幕
check("6a 字幕条目按文本/图形分流",
      "function subtitleButtonHTML(s, i)" in MEDIA
      and "selectVideoBurnInSubtitle(this," in MEDIA and "attachVideoSubtitle(this.closest" in MEDIA)
check("6b 图形字幕烧录 URL 与音轨可同时携带",
      "function videoTrackCompatUrl(lib, path, opts = {})" in MEDIA
      and "&mode=full_transcode&sub_track=" in MEDIA and "&audio_track=" in MEDIA)
check("6c 选择记忆 + 关闭字幕 + 按钮状态同步",
      "function videoBurnSubOf(libId, path)" in MEDIA and "function rememberVideoBurnSub(" in MEDIA
      and "function clearVideoSubtitle(btn)" in MEDIA and "function syncVideoSubtitleButtons(root, video)" in MEDIA)
check("6d 切音轨时保留图形字幕烧录（旧实现只带 audio_track）",
      "const pick = videoBurnSubOf(lib.id, path);" in MEDIA
      and "videoTrackCompatUrl(lib, path, { audio: Number(index), sub: pick ? Number(pick.track) : -1 })" in MEDIA)
check("6e 「搜索并挂载」渲染内嵌轨与关闭项（旧实现只渲染 attachVideoSubtitle）",
      "items.map(subtitleButtonHTML).join('')" in MEDIA and "没有找到字幕" in MEDIA
      and "找到 ${items.length} 条字幕（含内嵌轨）" in MEDIA)
check("6f 播放器字幕面板列出全部轨道 + 关闭项（旧实现的单类型渲染已移除）",
      "subBox.innerHTML = subs.map(subtitleButtonHTML).join('') +" in MEDIA
      and "// Embedded (in-container) text subtitle tracks extracted to WebVTT." not in MEDIA)

# ---------------------------------------------------------------- 7 前端：季度前缀
# v1.0.4（需求1）：回归 0.9.89 版式 —— 季名回到独立 h3 季名行，取消首条目前缀行。
check("7a 季名回到独立季名行（首条目前缀已移除）",
      "series-season-head" in MEDIA and "series-season-prefix" not in MEDIA
      and '<span class="season-inline-title">季度</span>' in MEDIA)
check("7b 全部剧集在同一网格（首集不再单独成行）",
      'eps.map(ep => renderSeriesEpisodeRow(lib, ep, art(ep))).join("")' in MEDIA
      and "is-season-top" not in MEDIA)
check("7c 折叠对象＝整季分集网格",
      "series-episode-list-rest" not in MEDIA
      and 'const list = sec ? sec.querySelector(".series-episode-list") : null;' in MEDIA)
check("7d 季名行样式存在", ".series-season-head" in CSS and ".series-season-head .season-inline-title" in CSS)

# ---------------------------------------------------------------- 8 缩小态 CSS
check("8a 停靠高度 138px → 96px（旧值已清除）",
      "height:96px" in CSS and "height:138px" not in CSS)
check("8b 内层裁切、外层不裁切（消除内部滚动条）",
      ".media-video-body { height:96px; min-height:0; padding:0; overflow:hidden; }" in CSS
      and "border-radius:16px 16px 0 0; overflow:visible;" in CSS)
check("8c 还原按钮在缩小态常显可点",
      ".video-minimized.video-controller-docked .vc-restore {" in CSS
      and "opacity:1; visibility:visible; pointer-events:auto;" in CSS)
check("8d 窄屏停靠态同步收紧（180 → 128，去掉 overflow:auto）",
      "height:128px; overflow:visible;" in CSS and "height:180px; overflow:auto" not in CSS)

# ---------------------------------------------------------------- 9 新增测试与资产
check("9a 新增 Go 测试文件", (ROOT / "media-go/v0999_subtitle_burn_test.go").exists())
check("9b 新增行为测试与包装器",
      (ROOT / "tests/v0999_behavior.js").exists() and (ROOT / "tests/test_v0999_behavior.py").exists())
check("9c 发布说明文件按当前版本命名",
      (ROOT / ".github/RELEASE_NOTES_1.0.0.md").exists())

# ---------------------------------------------------------------- 10 敏感信息不落库
NEW_FILES = ["media-go/v0999_subtitle_burn_test.go", "tests/v0999_behavior.js",
             "tests/test_v0999_behavior.py", "tests/test_v0999_contract.py",
             ".github/RELEASE_NOTES_1.0.0.md"]
bad = []
for f in NEW_FILES:
    txt = rd(f)
    # 拼接写法：本文件自己不能包含这些字面量（仓库另有全库扫描测试）
    for token in ["enged" + ".top", "192" + ".168.", "/vol" + "1", "/vol" + "2", "/vol" + "3", "/vol" + "8"]:
        if token in txt:
            bad.append(f"{f}:{token}")
check("10 新文件不含内网域名/IP/卷路径", not bad, bad)

print("\n===== v1.0.0 契约测试：", "全部通过" if ok else "存在失败", "=====")
raise SystemExit(0 if ok else 1)
