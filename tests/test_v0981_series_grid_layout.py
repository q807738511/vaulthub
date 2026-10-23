#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v0.9.85 契约（回归守卫）：
1. 视频推荐改网格展示 + 限制文字穿模（网格容器、溢出隐藏、徽标不压标题）
2. 无资源推荐「视频信息」弹窗海报按 16:9 查看比例
3. 剧集详情顺序：hero → 演职 → 推荐 → 季度 → 视频信息(底部)
4. 季度集数默认网格展示，删除「详情」按钮，集号 + 集标题
5. 演职人员改网格排序的头像展示
"""
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
MEDIA = (ROOT / "web/js/02-media.js").read_text(encoding="utf-8")
CSS = (ROOT / "web/css/main.css").read_text(encoding="utf-8")
HTML = (ROOT / "index.html").read_text(encoding="utf-8")

OK = 0; FAIL = 0
def check(name, cond):
    global OK, FAIL
    if cond: OK += 1
    else: FAIL += 1; print("  - FAIL", name)

# 1) 视频推荐改网格 + 限制穿模
check("1 推荐网格容器 CSS", ".movie-rec-grid" in CSS and "repeat(auto-fill,minmax(260px,1fr))" in CSS)
check("1 推荐卡溢出隐藏", "min-width:0; overflow:hidden; }" in CSS and ".movie-rec-card { display:flex; gap:10px" in CSS)
check("1 推荐元数据不穿模", ".movie-rec-meta { min-width:0" in CSS and ".movie-rec-meta b" in CSS and "text-overflow:ellipsis" in CSS.split(".movie-rec-meta b")[1][:120])
check("1 徽标移到左上角", ".movie-rec-badge { top:10px; left:10px; right:auto" in CSS)
check("1 renderRecPanel 用网格", "function renderRecPanel" in MEDIA and 'class="movie-rec-grid"' in MEDIA)

# 2) 无资源弹窗海报 16:9
check("2 rec-info 海报 16:9", ".rec-info-grid img" in CSS and "aspect-ratio:16/9" in CSS.split(".rec-info-grid img")[1][:200])

# 3) 剧集详情顺序：hero → 演职 → 推荐 → 季度 → 视频信息(底部)
seg = MEDIA.split("const renderPage = (extras)")[1].split("scrollViewerIntoView(viewer)")[0]
i_hero = seg.find("renderMovieHero")
i_cast = seg.find("renderCastPanel")
i_rec = seg.find("renderRecPanel")
i_season = seg.find('${seasons}')  # v1.0.0（需求1）：季度标题已并入首季前缀行，这里按季度容器占位定序
i_info = seg.find("renderSeriesInfoPanel")
check("3 剧集详情顺序 hero→演职→推荐→季度→信息", -1 < i_hero < i_cast < i_rec < i_season < i_info)
check("3 存在 renderSeriesInfoPanel", "function renderSeriesInfoPanel" in MEDIA)

# 4) 季度集数网格 + 删除详情按钮 + 集号与标题
check("4 季度列表为网格", ".series-episode-list { display:grid" in CSS and "repeat(auto-fill,minmax(150px,1fr))" in CSS.split(".series-episode-list")[1][:120])
check("4 集格为纵向(缩略图+标题)", ".series-episode-row { display:flex; flex-direction:column" in CSS)
check("4 已删除详情按钮", 'event.stopPropagation();openEpisodeDetails(' not in MEDIA)
# v0.9.99（需求4）：季度标题作为该季首条目的前缀插进标题区，模板因此多了 ${seasonPrefix} 占位。
# v1.0.6（需求1）：前缀行取消，季名回到独立季名行 —— 集格标题区回到「集号 + 集标题」两行。
check("4 集格显示集号+标题（v1.0.6 起标题区无季度前缀占位）",
      '<div class="series-episode-title"><b>${esc(label)}</b>' in MEDIA
      and 'epTitle ? `<small' in MEDIA
      and "seasonPrefix" not in MEDIA)

# 5) 演职人员网格头像
check("5 演职网格 CSS", ".movie-cast-strip { display:grid" in CSS and "repeat(auto-fill,minmax(104px,1fr))" in CSS)
check("5 演职卡头像+名称+角色（v0.9.85 加饰演/配音标签）",
      "function renderCastPanel" in MEDIA and 'class="movie-cast-avatar"' in MEDIA and 'x.name||""' in MEDIA
      and "String(x.character || \"\").trim()" in MEDIA and "castRoleLabel" in MEDIA)

# 版本
check("6 版本 0.9.90", 'VAULTHUB_ASSET_VERSION = "1.0.6"' in HTML and 'VAULTHUB_SCRIPT_VERSION = "1.0.6"' in (ROOT/"web/js/01-state.js").read_text(encoding="utf-8"))

print(f"v0.9.85 {OK}/{OK+FAIL} 项剧集网格/推荐/演职契约通过" if FAIL==0 else f"v0.9.85 契约 {FAIL} 项未通过")
raise SystemExit(1 if FAIL else 0)
