#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v0.9.85 契约测试：静态核对九项改动的落点（HTML / CSS / JS / Go）。

  1. 持续登录：会话 30 天默认 + 登录页勾选 60 天 + 服务端会话表落盘 + 前端不再 30 分钟自动登出；
  2. 正在播放海报上的续播按钮；
  3. 同一视频只展示最新一条记录（去重）；
  4. 搜索框右侧通知喇叭（通知 + 刮削明细）；
  5. 搜索框内的乱码字符（⌘）按平台显示 / 不再出现方块；
  6. 媒体库海报只展示名称 + 换行年份（剧集含季/集），取消元数据来源；
  7. 演职人员第一行姓名、第二行饰演/配音，随系统语言；
  8. 硬件监控压缩：「硬盘和网络」并排网卡/下行/上行 + 温度与容量剩余合并；
  9. 音乐外观色彩档位覆盖虚化背景层（半截彩色残留）。
"""
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
HTML = (ROOT / "index.html").read_text(encoding="utf-8")
CSS = (ROOT / "web/css/main.css").read_text(encoding="utf-8")
STATE = (ROOT / "web/js/01-state.js").read_text(encoding="utf-8")
MEDIA = (ROOT / "web/js/02-media.js").read_text(encoding="utf-8")
FEATURES = (ROOT / "web/js/03-features.js").read_text(encoding="utf-8")
HOME = (ROOT / "web/js/05-home.js").read_text(encoding="utf-8")
TOPNAV = (ROOT / "web/js/07-topnav.js").read_text(encoding="utf-8")
MANAGER = (ROOT / "manager/main.go").read_text(encoding="utf-8")
MGOTEST = (ROOT / "media-go/main.go").read_text(encoding="utf-8")

passed = failed = 0


def check(name, cond):
    global passed, failed
    if cond:
        passed += 1
        print("  ok  %s" % name)
    else:
        failed += 1
        print("  FAIL %s" % name)


print("== 1. 持续登录（30 天默认 / 勾选 60 天） ==")
check("服务端定义默认 30 天与勾选 60 天", "sessionDefaultDays = 30" in MANAGER and "sessionLongDays    = 60" in MANAGER)
check("TTL 按会话自身天数计算", "func sessionTTLFor(days int) time.Duration" in MANAGER and "sessionLongDays * 24 * time.Hour" in MANAGER)
check("天数只接受 30/60 两档", "func sessionDaysFor(days int) int" in MANAGER)
check("登录请求接受 keep_days", 'KeepDays int `json:"keep_days"`' in MANAGER)
check("cookie 为持久 cookie（MaxAge+Expires）", "MaxAge: int(ttl.Seconds()), Expires: time.Now().Add(ttl)" in MANAGER)
check("登录响应回显 session_days", '"session_days": days' in MANAGER)
check("会话表落盘 /data/sessions.json", "MANAGER_SESSIONS_FILE" in MANAGER and "sessions.json" in MANAGER and "func (m *manager) flushSessions()" in MANAGER)
check("启动时恢复持久化会话", "m.loadSessions(sessionsFile)" in MANAGER)
check("登录/退出/改密后同步落盘", MANAGER.count("m.flushSessions()") >= 2 and "dropOtherSessions" in MANAGER)
check("登录页有 60 天勾选框", 'id="vaultHubKeep60"' in HTML and 'data-i18n="loginKeep60"' in HTML)
check("前端按勾选传 keep_days", "keep_days:keepDays" in STATE and "vaultHubKeep60" in STATE)
check("前端不再 30 分钟自动登出", "VAULTHUB_IDLE_TIMEOUT_MS" not in STATE and "VAULTHUB_SESSION_DEFAULT_DAYS = 30" in STATE)
check("三语会话说明已改为持续登录", STATE.count("保持登录 60 天") >= 2 and "kept for 30 days by default" in STATE)

print("== 2/3. 正在播放：续播按钮 + 同一视频去重 ==")
check("海报叠加续播按钮", 'class="now-play"' in HOME and "resumeNowPlaying(" in HOME)
check("视频续播恢复上次位置", "openLocalMedia(\"movie\", libId, path)" in HOME)
check("音乐可续播暂停中的曲目", 'document.getElementById("audioPlayerElement")' in HOME)
check("同一视频身份归并", "function nowPlayingVideoIdentity(" in HOME and "seenVideos" in HOME)
check("保留最新一条记录与更靠后的进度", "const keep = v.at > prev.at ? v : prev" in HOME and "Math.max(Number(v.time) || 0, Number(prev.time) || 0)" in HOME)
check("续播按钮样式（hover 显现 / 触屏常显）", ".now-row .now-th .now-play" in CSS and "@media (hover: none)" in CSS)

print("== 4. 通知喇叭（功能通知 + 刮削明细） ==")
check("顶栏搜索框右侧有喇叭与徽标", 'id="tnNotifyBell"' in HTML and 'id="tnNotifyBadge"' in HTML)
check("通知面板与明细列表", 'id="tnNotifyPanel"' in HTML and 'id="tnNotifyList"' in HTML)
check("面板含已读/清空入口", "markNotificationsRead()" in HTML and "clearNotifications()" in HTML)
check("通知队列实现（入队/持久化/上限/已读）", all(k in TOPNAV for k in ["function pushNotification(", "VH_NOTIFY_MAX", "vhNotifyPersist", "function markNotificationsRead(", "function clearNotifications("]))
check("刮削过程投递通知", "notifyScrapeStart(" in MEDIA and "notifyScrapeResult(" in MEDIA and "notifyScrapeRetry" in STATE)
check("刮削通知带失败明细", 'tf("notifyScrapeFailItem"' in MEDIA)
check("重试入口也写通知", "notifyScrapeRetry" in MEDIA)
check("通知样式（徽标/条目/等级色）", ".tn-bell-badge" in CSS and ".tn-notify-item" in CSS and ".tn-notify-item.fail .ic" in CSS)

print("== 5. 搜索框乱码字符（⌘） ==")
check("index.html 不再直接写 ⌘", "⌘" not in HTML)
check("快捷键提示按平台渲染", 'id="topSearchKbd"' in HTML and "applySearchKbdLabel" in TOPNAV and '"Ctrl K"' in TOPNAV)

print("== 6. 媒体库海报信息（名称 + 换行年份，取消来源） ==")
check("电影海报去掉 provider", "function moviePosterSubtitle(" in MEDIA and "meta.provider" not in MEDIA.split("function moviePosterSubtitle(")[1][:400])
check("剧集海报去掉 provider 并保留季/集", "seasons?`${seasons} 季`" in MEDIA and "show.provider].filter(Boolean).join(\" · \")" not in MEDIA)
check("海报两行展示（strong/small 均块级）", ".media-poster-info strong,.media-poster-info small { display:block" in CSS)

print("== 7. 演职人员（姓名 / 饰演·配音，随系统语言） ==")
check("角色标签随语言", "function castRoleLabel(" in MEDIA and '"castVoiceAs"' in MEDIA and '"castAs"' in MEDIA)
check("动画判为配音", "动画|動畫|Animation|Anime" in MEDIA)
check("空态与标题走 i18n", 't("castEmpty")' in MEDIA and 't("castTitle")' in MEDIA)
check("三语都有 castAs/castVoiceAs/castTitle", all(STATE.count(k) >= 3 for k in ["castAs:", "castVoiceAs:", "castTitle:"]))
check("TMDB 请求带界面语言", MEDIA.count("&lang=${tmdbLangTag()}") >= 5 and "function tmdbLangTag(" in MEDIA)
check("语言切换后重取演职人员", "function refreshDetailLanguage(" in MEDIA and "refreshDetailLanguage" in FEATURES)
check("media-go 支持 lang 白名单", "func tmdbLanguage(q string) string" in MGOTEST and 'lang := tmdbLanguage(r.URL.Query().Get("lang"))' in MGOTEST)

print("== 8. 硬件监控压缩（硬盘和网络） ==")
check("卡片标题改为「硬盘和网络」", 'data-i18n="netDisksTitle"' in HTML and "netDisksTitle" in STATE)
check("网卡名/下行/上行并排", 'class="hw-net-row"' in HTML and 'class="hw-nic"' in HTML and 'id="netDown"' in HTML and 'id="netUp"' in HTML)
check("温度与容量剩余合并进同一卡", 'class="hw-disk-row"' in HTML and 'id="tempMain"' in HTML and 'id="diskFreeText"' in HTML and 'id="diskFreeBar"' in HTML)
check("库容量明细也收进卡片（不再单独占一整屏）", 'class="hw-volumes" id="diskCard"' in HTML and 'data-i18n="secDisk"' not in HTML)
check("原「网络速度 / 硬盘使用率」两卡已合并", 'data-i18n="netSpeed"' not in HTML and 'data-i18n="diskUsage"' not in HTML)
check("样式：并排网格 + 明细限高滚动", ".hw-net-row { display: grid" in CSS and ".hw-volumes {" in CSS)
check("温度明细压缩到 3 条", ".hw-temp-list" in CSS and "entries.slice(0, 3)" in FEATURES)

print("== 9. 音乐外观色彩档位（半截彩色残留） ==")
check("虚化背景层纳入色彩档位", ".audio-poster-frame::before" in CSS and "saturate(0)" in CSS)
check("全屏面板背景层同样覆盖", ".audio-fullscreen-overlay::before" in CSS and ".audio-fullscreen-poster::before" in CSS)
check("歌词页虚化图也灰度化", '.audio-lyrics-page img { filter: blur(26px) brightness(.82) saturate(0); }' in CSS)
check("音乐容器整块去色（含渐变占位面）", ":is(.audio-expand, .audio-fullscreen, .audio-player, .audio-latest-grid, .audio-album-grid)" in CSS)
check("档位变量驱动、可回原画", "--vh-quality-color" in CSS and "resetQualityLevel" in (ROOT / "web/js/03-quality.js").read_text(encoding="utf-8"))

print("\nv0.9.85 契约检查：%d 项通过，%d 项失败" % (passed, failed))
sys.exit(1 if failed else 0)
