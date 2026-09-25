#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v0.9.78 契约：
1) TMDB 影视推荐依旧不生效的根治：metadata.tmdb_id 缺失(豆瓣/本地NFO/TVDB 刮削)时，
   打开详情会自动用标题回查 TMDB 拿 id 再取 recommendations（不再只有 tmdb_id 才显示）。
2) 演职人员头像刮削插件（Metashark / Plex NFO Agent）内置：新增 /api/media/cast/avatar
   本地代理端点（Metashark 适配器：person 头像经本地抓取、无额外容器）。
3) 分离刮削与硬件：显卡加速 / 转码缓存 / NAS 监控 →「硬件配置」单独立项；
   刮削来源 / API 网络测速 / 网络能效 / 演职人员头像刮削插件 →「刮削配置」。
"""
import re
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
MEDIA = (ROOT / "web/js/02-media.js").read_text(encoding="utf-8")
STATE = (ROOT / "web/js/01-state.js").read_text(encoding="utf-8")
HTML = (ROOT / "index.html").read_text(encoding="utf-8")
GOMAIN = (ROOT / "media-go/main.go").read_text(encoding="utf-8")

OK = 0
FAIL = 0

def check(name, cond):
    global OK, FAIL
    if cond:
        OK += 1
    else:
        FAIL += 1
        print("  - FAIL", name)

# ===== 1) TMDB 影视推荐不再仅依赖 tmdb_id =====
# openMovieDetails 会在 tmdb_id 缺失时按标题回查 TMDB 再取 id → recommendations
check("1.1 详情打开时可用标题回查 TMDB 取 id（修复推荐不生效）",
      "(meta.title||meta.name)" in MEDIA and "recommendations:movieRecommendationsFor(d,meta)" in MEDIA
      and "/api/media/tmdb?query=" in MEDIA)
check("1.2 TMDB id 回查后才取 recommendations",
      "tidRes" in MEDIA and "movieRecommendationsFor(d,meta)" in MEDIA)
check("1.3 TMDB 错误有可见提示（不再静默）", "tmdb_error" in MEDIA and "movieTMDBErrorText" in MEDIA)

# ===== 2) 演职人员头像刮削插件（Metashark/Plex NFO 内置）+ 内置端点 =====
check("2.1 头像走本地 /api/media/cast/avatar 代理（Metashark 适配器，不改用浏览器外链）",
      '"/api/media/cast/avatar?person=${encodeURIComponent(' in MEDIA)
check("2.2 后端新增 castAvatar 处理器", "func (a *App) castAvatar" in GOMAIN
      and 'HandleFunc("/api/media/cast/avatar", a.castAvatar)' in GOMAIN)
check("2.3 castAvatar 校验 person 防穿越/越界", 'strings.HasPrefix(person, "//")' in GOMAIN
      and 'len(person) > 256' in GOMAIN and 'LimitReader(res.Body, 4<<20)' in GOMAIN)
check("2.4 头像插件在刮削配置里（saveCastScraperPlugin 内置）", "function saveCastScraperPlugin" in STATE
      and "Metashark" in STATE and "无需额外容器" in STATE)
check("2.5 头像刮削插件归类刮削配置面板", "演职人员图像刮削插件" in HTML
      and "castScraperPlugin" in HTML)

# ===== 3) 分离刮削与硬件 =====
scrape = HTML[HTML.find('id="setpanel-scrape"'):HTML.find('id="setpanel-account"')]
hard = HTML[HTML.find('id="setpanel-hardware"'):HTML.find('id="setpanel-account"')]
check("3.1 有独立「硬件配置」面板", 'id="setpanel-hardware"' in HTML and 'setScrape">刮削配置' in HTML)
check("3.2 硬件配置含 显卡加速/转码缓存/NAS监控", all(k in hard for k in ["显卡加速", "转码缓存", "NAS 监控"]))
check("3.3 刮削配置含 刮削来源/API测速/网络能效/头像插件", all(k in scrape for k in ["刮削来源", "API 网络链接测速", "网络能效", "演职人员图像刮削插件"]))
check("3.4 switchSetTab 支持 hardware 标签", 'key === "hardware"' in STATE)

print(f"\n{'='*20} v0.9.78 契约: {OK} checks, FAIL={FAIL}")
print("FAIL: v0.9.78 契约未全部通过" if FAIL else "PASS: v0.9.78 契约全部通过")
