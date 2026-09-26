#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v0.9.80 契约（回归守卫）：
剧集 TMDB 评分补齐 / 多季季度卡片 / 单集网格 / 视频信息改名 / 推荐略缩图+本地优先 / Bangumi 回落。
"""
import re
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

# 1) 剧集 TMDB 评分补齐（async openSeriesDetails + search tv 取 vote_average）
check("1 剧集详情异步解析 TMDB 取评分", "async function openSeriesDetails" in MEDIA and "vote_average" in MEDIA and "type=series" in MEDIA)

# 2) 多季季度卡片 + 点击展开/收起
check("2 季度卡片渲染函数", "function renderSeriesSeasonCard" in MEDIA and "series-season-head" in MEDIA)
check("2 第一季默认展开/其余折叠", 'class="series-episode-list"' in MEDIA and "is-collapsed" in MEDIA)
check("2 点击季度标题切换", "function toggleSeriesSeason" in MEDIA)
check("2 季卡 CSS", ".series-season-head" in CSS)

# 3) 单集详情 X排Y列 网格 + 集略缩图
check("3 单集网格 HTML", "function episodeGridHTML" in MEDIA and "episode-grid" in MEDIA)
check("3 网格 CSS", ".episode-grid" in CSS and ".ep-grid-card" in CSS)

# 4/5) 视频元数据 → 视频信息；演职/推荐/信息三块；推荐略缩图+本地可播
check("5 视频元数据已改名为视频信息", "视频元数据" not in MEDIA)
check("5 详情含演职/推荐/视频信息", "演职人员" in MEDIA and "视频推荐" in MEDIA and "视频信息" in MEDIA)
check("6 推荐略缩图卡片+横版+本地可播", "movie-rec-poster" in MEDIA and "本地可播" in MEDIA and "movie-rec-play" in MEDIA)
check("6 本地优先排序", "(b.local?1:0) - (a.local?1:0)" in MEDIA)
check("6 推荐卡 CSS 横版", ".movie-rec-card" in CSS)

# 7) 无本地资源弹窗展示 + Bangumi 回落
check("7 showRecInfo 弹窗", "function showRecInfo" in MEDIA and "recInfoModal" in MEDIA)
check("7 Bangumi 回落", "api.bgm.tv/v0/search/subjects" in MEDIA and "Bangumi" in MEDIA)

# 版本
check("8 版本 0.9.80", 'VAULTHUB_ASSET_VERSION = "0.9.80"' in HTML and 'VAULTHUB_SCRIPT_VERSION = "0.9.80"' in (ROOT/"web/js/01-state.js").read_text(encoding="utf-8"))

print(f"v0.9.80 {OK}/{OK+FAIL} 项剧集/季/集/推荐契约通过" if FAIL==0 else f"v0.9.80 契约 {FAIL} 项未通过")
raise SystemExit(1 if FAIL else 0)
