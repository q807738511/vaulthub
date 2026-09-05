#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v0.9.55 契约测试 —— 四项需求的可静态检查断言：
   1) 音乐播放器歌词页（展开双页 + 歌词磨砂覆盖海报 + 时间同步滚动）
   2) 音乐/漫画封面刮削写入媒体库文件持久化（/api/media/cover）
   3) 鉴权模式：开放模式（无密码）+ 系统设置可改用户名/密码
   4) 影视详情右上角返回按钮：单集→返回详情，剧集/电影详情→返回媒体库
   另含版本串、release notes、compose 跟随 latest 等常规检查。"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HTML = (ROOT / "index.html").read_text(encoding="utf-8")
STATE = (ROOT / "web" / "js" / "01-state.js").read_text(encoding="utf-8")
MEDIA = (ROOT / "web" / "js" / "02-media.js").read_text(encoding="utf-8")
CSS = (ROOT / "web" / "css" / "main.css").read_text(encoding="utf-8")
BOOT = (ROOT / "web" / "js" / "04-boot.js").read_text(encoding="utf-8")
MANAGER = (ROOT / "manager" / "main.go").read_text(encoding="utf-8")
MGO = (ROOT / "media-go" / "main.go").read_text(encoding="utf-8")
COVERGO = (ROOT / "media-go" / "cover_persist.go").read_text(encoding="utf-8")
CADDY = (ROOT / "Caddyfile").read_text(encoding="utf-8")

failures = []
def check(name, cond, detail=""):
    if not cond:
        failures.append(f"{name} {detail}".strip())

# ---------------------------------------------------------------- 1. 歌词页
check("歌词双页容器", 'id="audioExpand"' in HTML and 'id="audioExpandPosterTab"' in HTML
      and 'id="audioExpandLyricsTab"' in HTML)
check("海报页元素", 'id="audioBigPoster"' in HTML and 'id="audioBigPosterFallback"' in HTML)
check("歌词磨砂层元素", 'id="audioLyricsBg"' in HTML and 'id="audioPlayerLyrics"' in HTML
      and 'class="audio-player-lyrics"' in HTML and 'class="audio-lyrics-scrim"' in HTML)
check("切页函数", "function setAudioExpandPage(page)" in MEDIA
      and "function updateAudioExpandArt(meta)" in MEDIA)
check("海报/歌词 tab 切换绑定", "onclick=\"setAudioExpandPage('poster')\"" in HTML
      and "onclick=\"setAudioExpandPage('lyrics')\"" in HTML)
check("展开区只在最大化显示", ".audio-player .audio-expand { display:none; }" in CSS
      and ".audio-player.maximized .audio-expand { display:flex" in CSS)
check("歌词覆盖海报磨砂", ".audio-lyrics-page img" in CSS and "blur(26px)" in CSS
      and ".audio-lyrics-scrim" in CSS and ".audio-player-lyrics .lyric-line.active" in CSS)
check("歌词随播放时间高亮滚动", "function updateLyricHighlight()" in MEDIA
      and "scrollActiveLyricIntoView" in MEDIA and "lastLyricActiveIndex" in MEDIA)
check("点击歌词行跳转播放", "function seekLyric(event)" in MEDIA and "audioPlayerLyrics" in HTML)

# ---------------------------------------------------------------- 2. 封面持久化
check("后端封面端点文件", COVERGO != "" and "func sniffImageExt" in COVERGO
      and "coverSidecarRel" in COVERGO and "coverSave" in COVERGO and "coverGet" in COVERGO)
check("后端 POST 需登录 + GET 公开", 'func (a *App) coverSave' in COVERGO and 'if !writeAuth(r)' in COVERGO)
check("魔数限制格式", "jpeg/png/webp/gif" in COVERGO)
check("路由注册", 'HandleFunc("/api/media/cover", a.coverSave)' in MGO
      and 'HandleFunc("/api/media/cover/", a.coverGet)' in MGO)
check("前端持久化辅助", "function persistCoverToLibrary" in MEDIA and "function localizeAudioCover" in MEDIA
      and "function coverCacheKey" in MEDIA and "coverPersistAttempted" in MEDIA)
check("音频刮削/播放/手动保存落盘挂钩",
      "localizeAudioCover(lib.id, path)" in MEDIA)
check("漫画封面命中后落盘", "await persistCoverToLibrary(libId, mediaPath, coverUrl)" in MEDIA)
check("漫画缓存键按库+文件", 'return (libId ? libId + "\\n" : "")' in MEDIA)
check("本地封面失败清缓存重刮", "delete cache[key]" in MEDIA and "bookCoverFallback" in MEDIA)

# ---------------------------------------------------------------- 3. 鉴权模式
check("manager 存储结构与开放模式推导", "type storedAuth struct" in MANAGER
      and "deriveStoredAuth" in MANAGER and 'Mode: "open"' in MANAGER and "passwordOK" in MANAGER)
check("auth.json 持久化路径", "MANAGER_AUTH_FILE" in MANAGER and "saveAuthFile" in MANAGER
      and "loadAuthFile" in MANAGER and "0600" in MANAGER)
check("登录/会话/写操作开放模式放行", 'userOK := m.open' in MANAGER and 'if m.open {' in MANAGER)
check("manager 路由注册", 'HandleFunc("/api/auth/mode", m.authMode)' in MANAGER
      and 'HandleFunc("/api/account", m.account)' in MANAGER)
check("managerRoutes 注入清单", '"handle /api/auth/mode"' in MANAGER and '"handle /api/account"' in MANAGER)
check("Caddyfile 代理新端点", "handle /api/auth/mode" in CADDY and "handle /api/account" in CADDY)
check("设置面板凭据区块", 'id="accountCredentialsBlock"' in HTML and 'id="accountAuthModeBadge"' in HTML
      and 'id="accountAuthUsername"' in HTML and 'id="accountNewUsername"' in HTML
      and 'id="accountCurrentPassword"' in HTML and 'id="accountNewPassword"' in HTML
      and 'id="accountNewPassword2"' in HTML and 'id="accountOpenModeButton"' in HTML
      and 'id="accountPasswordModeButton"' in HTML)
check("账户保存/切换 JS", "function saveAccountCredentials()" in STATE
      and "function switchAccountOpenMode()" in STATE and "function switchAccountPasswordMode()" in STATE
      and "function loadAccountCredentialsUI()" in STATE)
check("启动探测鉴权模式", "async function initVaultHubAuth()" in STATE and "initVaultHubAuth();" in BOOT
      and "async function vaultHubFetchAuthMode()" in STATE and "async function vaultHubAutoLogin()" in STATE)
check("开放模式不弹登录遮罩", 'vaultHubAuthMode === "open"' in STATE
      and "vaultHubAuthMode !== \"open\"" in STATE)

# ---------------------------------------------------------------- 4. 影视返回语义
check("返回语境按钮", "function movieDetailCloseButton()" in MEDIA and "✕ 返回详情" in MEDIA
      and "✕ 返回媒体库" in MEDIA and "closeEpisodeDetail()" in MEDIA)
check("单集详情入口", "function openEpisodeDetails(libId, path)" in MEDIA
      and "activeSeriesDetail" in MEDIA and "seriesEpisodeReturn" in MEDIA)
check("剧集详情行用单集入口", "onclick=\"openEpisodeDetails(" in MEDIA)
check("详情页复用语境关闭按钮", "movieDetailCloseButton()" in MEDIA and MEDIA.count("movieDetailCloseButton()") >= 3)
check("关闭详情复位语境", "seriesEpisodeReturn=null" in MEDIA)

# ---------------------------------------------------------------- 版本与发布
check("release notes", (ROOT / ".github" / "RELEASE_NOTES_0.9.55.md").exists(), "缺少 v0.9.55 release notes")
check("版本串", HTML.count("v0.9.55") >= 2 and 'VAULTHUB_SCRIPT_VERSION = "0.9.55"' in STATE)
check("资产缓存版本", 'v=0.9.55' in HTML)
check("compose 跟随 latest", (ROOT / "docker-compose.yml").read_text(encoding="utf-8").find("ghcr.io/q807738511/vaulthub:latest") >= 0)
check("无旧版本残留", "0.9.53" not in HTML and "0.9.53" not in STATE and "0.9.53" not in MEDIA
      and "0.9.53" not in COVERGO)

if failures:
    print(f"FAIL: {len(failures)} 项 v0.9.55 契约未满足")
    for f in failures:
        print("  - " + f)
    sys.exit(1)
print("PASS: v0.9.55 lyrics pages, cover persistence, auth mode & movie return contracts")
