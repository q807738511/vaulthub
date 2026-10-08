#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v0.9.93 静态契约：播放时顶栏回缩、关闭/停止彻底断流（前后端）、侧栏彻底移除、
剧集归组与同步，以及上轮 5 项收尾的回归复核。
与 tests/v0993_behavior.js（真实执行源码）互补：这里只做静态落点与文档一致性检查。"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HTML = (ROOT / "index.html").read_text(encoding="utf-8")
STATE = (ROOT / "web/js/01-state.js").read_text(encoding="utf-8")
MEDIA = (ROOT / "web/js/02-media.js").read_text(encoding="utf-8")
FEATURES = (ROOT / "web/js/03-features.js").read_text(encoding="utf-8")
TOPCSS = (ROOT / "web/js/07-topnav.js").read_text(encoding="utf-8")
HOMEJS = (ROOT / "web/js/05-home.js").read_text(encoding="utf-8")
BOOT = (ROOT / "web/js/04-boot.js").read_text(encoding="utf-8")
CSS = (ROOT / "web/css/main.css").read_text(encoding="utf-8")
LOG = (ROOT / "Update Log.md").read_text(encoding="utf-8")
NOTES = (ROOT / ".github/RELEASE_NOTES_0.9.93.md").read_text(encoding="utf-8")
GO_MAIN = (ROOT / "media-go/main.go").read_text(encoding="utf-8")
GO_PLAY = (ROOT / "media-go/playback.go").read_text(encoding="utf-8")
GO_TEST = (ROOT / "media-go/v0993_playback_stop_test.go").read_text(encoding="utf-8")
README = (ROOT / "README.md").read_text(encoding="utf-8")

OK = 0
FAILS = []


def check(name, cond, extra=None):
    global OK
    if cond:
        OK += 1
        print("PASS:", name)
    else:
        FAILS.append(name)
        print("FAIL:", name, "" if extra is None else extra)


print("v0.9.93 契约检查")

# ============ 1) 播放影视时顶栏回缩、窗口空间真正释放 ============
check("1a body.player-immersive 把 --topbar-h 归零（真正释放占位，而不是盖住顶栏）",
      "body.player-immersive { --topbar-h: 0px; }" in CSS)
check("1b 顶栏同时滑出视口并禁用点击",
      # v0.9.97：回缩规则补齐「真的看不见」（0 高度盒子挡不住溢出的子元素与 1px 底边线），
      # 断言改为按归一化后的关键声明检查，兼容规则的续行与新增属性。
      all(k in re.sub(r"\s+", " ", CSS) for k in (
          "body.player-immersive .topbar { transform: translateY(-100%); opacity: 0; pointer-events: none;",
          "visibility: hidden;", "border-bottom-color: transparent;",
      )))
check("1c 顶栏有过渡动画（回缩/恢复不跳动）",
      ".topbar { transition: transform .18s ease, opacity .18s ease; }" in CSS)
check("1d 前端有占用开关与推导函数",
      "function setPlayerImmersive(on)" in MEDIA and "function syncPlayerImmersive()" in MEDIA)
check("1e 浮标刷新统一收口（早退路径也同步占用）",
      "if (typeof syncPlayerImmersive === \"function\") syncPlayerImmersive();" in STATE
      and "function updatePlaybackDock() {" in STATE)
check("1f 最小化小窗时释放顶栏、展开时重新占用",
      "syncPlayerImmersive();\n}" in MEDIA and MEDIA.count("syncPlayerImmersive();") >= 3)
check("1g 关闭阅读器/播放器时释放顶栏",
      "if (typeof setPlayerImmersive === \"function\") setPlayerImmersive(false);" in FEATURES)

# ============ 2) 关闭/停止后不能还有后台数据在跑 ============
check("2a 媒体元素彻底断开（pause + 去 src + load）",
      "function teardownMediaElement(el)" in MEDIA
      and 'el.removeAttribute("src");' in MEDIA
      and "if (typeof el.load === \"function\") el.load();" in MEDIA)
check("2b 视频会话硬停止（Worker / 分片 / 会话 / 计时器一次清干净）",
      "function hardStopVideoPlayback(root)" in MEDIA
      and "root.__wasmAbort.abort()" in MEDIA
      and "terminateWasmVideo(root);" in MEDIA
      and "stopVideoPlaybackSession(root);" in MEDIA)
check("2c 浮标 ✕（停止播放）由「仅暂停」改为彻底停止",
      "if (video) hardStopVideoPlayback(video.closest(\".media-video-body\"));" in MEDIA
      and "if (video) { try { video.pause(); } catch (e) {} }\n  setPlayerImmersive(false);" not in MEDIA)
check("2d 关闭阅读器：视频硬停 + 其它内嵌音视频也断源",
      "hardStopVideoPlayback(root)" in FEATURES
      and 'el.querySelectorAll("video, audio").forEach(teardownMediaElement);' in FEATURES)
check("2e WASM 整片下载可中止",
      "const abort = new AbortController();" in MEDIA
      and "signal: abort.signal" in MEDIA)
check("2f 页面卸载时停掉播放会话（刷新/关标签不留会话）",
      "function flushPlaybackOnUnload()" in MEDIA
      and 'window.addEventListener("pagehide", flushPlaybackOnUnload);' in MEDIA
      and 'window.addEventListener("beforeunload", flushPlaybackOnUnload);' in MEDIA
      and "navigator.sendBeacon" in MEDIA)
check("2g 服务端：后台预转码注册表保存 cancel 与媒体路径",
      "type compatBuildState struct {" in GO_MAIN
      and "mediaPath string" in GO_MAIN
      and "compatBuilds   = map[string]*compatBuildState{}" in GO_MAIN)
check("2h 服务端：按观看者计数取消后台预转码",
      "func noteCompatWatcher(cache string)" in GO_MAIN
      and "func releaseCompatWatcher(cache string)" in GO_MAIN
      and "compatWatchers[cache] == 0" in GO_MAIN)
check("2i 服务端：compat 处理器把「有人在看」与父 ctx 传下去",
      "noteCompatWatcher(cache)" in GO_MAIN
      and "defer releaseCompatWatcher(cache)" in GO_MAIN
      and "a.buildCompatCache(r.Context(), disc, cache, audioTrack, hw, mode, maxHeight)" in GO_MAIN)
check("2j 服务端：buildCompatCache 不再用 context.Background 独走",
      "func (a *App) buildCompatCache(parent context.Context," in GO_MAIN
      and "case <-parent.Done():\n\t\t\t\tcancel()" in GO_MAIN)
check("2k 服务端：并发上限，避免一堆后台 ffmpeg 抢 CPU",
      "const compatBuildMaxConcurrent = 2" in GO_MAIN
      and "if len(compatBuilds) >= compatBuildMaxConcurrent {" in GO_MAIN)
check("2l 服务端：停止播放会话同时取消该媒体的后台预转码",
      "func cancelCompatBuildsForMedia(mediaPath string) int" in GO_MAIN
      and 'stopped := cancelCompatBuildsForMedia(s.Path)' in GO_PLAY
      and '"precache_cancelled": stopped' in GO_PLAY)
check("2m Go 单元测试覆盖取消语义", "TestV0993ReleaseWatcherCancelsBuildOnlyWhenIdle" in GO_TEST
      and "TestV0993CancelBuildsForMediaSuffixMatch" in GO_TEST
      and "TestV0993BuildConcurrencyCapSkips" in GO_TEST)

# ============ 3) 侧栏彻底移除（含系统设置里的 UI 设置） ============
check("3a index.html 不再有侧栏结构/拖动条/折叠按钮",
      '<aside class="sidebar"' not in HTML and 'id="sidebar"' not in HTML
      and "sidebarResizer" not in HTML and "sidebarCollapseButton" not in HTML)
check("3b 系统设置里不再有「布局」「侧栏」两节（UI 设置已去除）",
      "layoutModeChips" not in HTML and "setLayoutMode(" not in HTML
      and "resetSidebarWidth" not in HTML and 'data-i18n="setLayout"' not in HTML
      and 'data-i18n="setSidebar"' not in HTML)
check("3c CSS 里侧栏规则全清、占位恒为 0",
      ".sidebar" not in CSS and "body.sidebar-hidden" not in CSS
      and "--sidebar-w: 0px;" in CSS)
check("3d JS 里侧栏交互全清（折叠/宽度/resizer/溢出/详情侧栏模式）",
      all(k not in STATE for k in ("function toggleBars(", "function loadSidebarRail(",
                                   "function applySidebarWidth(", "function resetSidebarWidth(",
                                   "function initSidebarResizer(", "function initSidebarNavOverflowWatch(",
                                   "function enterMovieDetailSidebarMode(", "function leaveMovieDetailSidebarMode("))
      and "loadSidebarWidth();" not in BOOT and "initSidebarResizer();" not in BOOT)
check("3e 布局收敛为顶栏单一布局（旧参数按顶栏处理）",
      'document.body.classList.add("layout-topnav");' in TOPCSS
      and "function currentLayoutMode() { return \"topnav\"; }" in TOPCSS
      and "renderLayoutChips" not in TOPCSS and "setLayoutMode" not in TOPCSS)
check("3f 原侧栏入口不丢：媒体搜索在顶栏（v0.9.97 起只保留右侧放大镜，左侧重复项已移除）、自定义模块在顶栏标签 + 头像菜单",
      'id="tnSearchButton"' in HTML and "toggleMediaSearchModal()" in HTML
      and 'data-topnav="search"' not in HTML
      and 'id="topCustomNav"' in HTML
      and "function topUserMenuModules()" in TOPCSS
      and 'onclick="topUserMenuModules()"' in HTML)
check("3g 自定义模块标签渲染到顶栏且带判空（原实现无判空会抛错）",
      'const wrap = document.getElementById("topCustomNav");' in FEATURES
      and "if (!wrap) return;" in FEATURES
      and 'class="tn-item"' in FEATURES)
check("3h 媒体库标签刷新不再依赖已删除的侧栏容器",
      "function renderLibraryNav()" in HOMEJS and "renderHomeLibraryNav" not in HOMEJS
      and 'getElementById("libNavAll")' not in HOMEJS
      and "renderHomeLibraryNav" not in MEDIA and "renderHomeLibraryNav" not in FEATURES)
check("3i 侧栏相关的死监听/死函数已清除",
      "#mainNav .nav-item" not in STATE and "openSettingsModalFromSidebar" not in STATE
      and 'getElementById("sidebarSettingsButton")' not in STATE)

# ============ 4) 剧集归组与「同步到同一剧集」 ============
check("4a 新增路径口径归组键，且键不含刮削标题",
      "function seriesGroupKeyOf(path, parsed)" in MEDIA
      and "meta.show_title" not in MEDIA.split("function seriesGroupKeyOf")[1].split("\n}")[0])
check("4b buildSeriesShows 用路径口径归组（刮削状态不再影响分组）",
      "const key = seriesGroupKeyOf(path, parsed);" in MEDIA
      and "const title = meta.show_title || parsed.show, key = title.toLowerCase();" not in MEDIA)
check("4c 剧名取整组第一个刮到的 show_title，否则回落解析名",
      "if (scrapedTitle && !show.scrapedTitle) show.scrapedTitle = scrapedTitle;" in MEDIA
      and "show.title = show.scrapedTitle;" in MEDIA)
check("4d 整剧同步：渲染剧集库时把刮削信息补到全部同剧分集",
      "function syncSeriesShowMetadata(libId, show)" in MEDIA
      and "syncSeriesShowMetadata(lib.id, show); rememberSeriesShow(lib.id, show);" in MEDIA)
check("4e 刮到剧名那一刻即时同步给同剧其它分集",
      "function syncSeriesShowTitleToSiblings(lib, files, path, showTitle)" in MEDIA
      and "if (mediaType === \"series\" && patch.show_title) syncSeriesShowTitleToSiblings(lib, files, path, patch.show_title);" in MEDIA)
check("4f 同步只补空字段，不覆盖各集自己的分集名/评分",
      "if (show.poster && !cur.poster) patch.poster = show.poster;" in MEDIA
      and "if (show.overview && !cur.overview) patch.overview = show.overview;" in MEDIA
      and "patch.rating" not in MEDIA.split("function syncSeriesShowMetadata")[1].split("function syncSeriesShowTitleToSiblings")[0])
check("4g Release Notes 写明四项需求", all(k in NOTES for k in ("顶栏", "回缩", "断流", "侧栏", "剧集")))

# ============ 5) 上轮 5 项收尾的回归复核（不得回退） ============
check("5a 缓存活跃窗口与命中刷 mtime 仍在",
      "cacheActiveWindow" in GO_MAIN and "os.Chtimes(cache, nowT, nowT)" in GO_MAIN)
check("5b 用量快照在所有早退路径仍会写",
      "a.cacheBytes, a.cacheFiles, a.cacheCleanedAt = 0, 0, time.Now().Unix()" in GO_MAIN
      and "a.cacheBytes, a.cacheFiles, a.cacheCleanedAt = total, kept, now.Unix()" in GO_MAIN)
check("5c 翻页失败冷静期与忙标记释放仍在",
      "MEDIA_SCROLL_FAIL_COOLDOWN_MS" in MEDIA and "blockUntil" in MEDIA)
check("5d 标语断言仍是「整串一致」而不是计数式",
      "len(slogans) == 3 and len(set(slogans)) == 1" in (ROOT / "tests/test_v0991_contract.py").read_text(encoding="utf-8")
      and "new Set(slogans).size === 1" in (ROOT / "tests/v0992_behavior.js").read_text(encoding="utf-8"))
check("5e 公开文档无主机容量与内网细节（含本轮）",
      not re.search(r"\b\d+\s?G\b|/vol[0-9]/|192\.168\.|\bvaulthub\.enged\.top\b", NOTES))

# ============ 6) 版本与文档 ============
_m = re.search(r'window\.VAULTHUB_ASSET_VERSION = "([\d.]+)";', HTML)
VERSION = _m.group(1) if _m else ""
check("6a index.html 资源缓存串与本版一致（≥10 处）",
      VERSION and HTML.count(f"?v={VERSION}") >= 10, f"VERSION={VERSION} 命中 {HTML.count('?v=' + VERSION)}")
check("6b ASSET / SCRIPT 版本一致",
      f'window.VAULTHUB_ASSET_VERSION = "{VERSION}";' in HTML
      and f'const VAULTHUB_SCRIPT_VERSION = "{VERSION}";' in STATE)
_slogans = re.findall(r"v0\.9\.9\d · [^<\"]+", HTML)
check("6c 标语三处整串一致", len(_slogans) == 3 and len(set(_slogans)) == 1, sorted(set(_slogans)))
check("6d Update Log 顶部为本版", LOG.startswith(f"# VaultHub 蜀鼠之家 v{VERSION}"))
check("6e Release Notes 存在", (ROOT / f".github/RELEASE_NOTES_{VERSION}.md").exists())
check("6f README 未被改动（发布说明只进 Update Log）", VERSION not in README)

print()
print("通过 %d / 失败 %d" % (OK, len(FAILS)))
if FAILS:
    print("失败项:", ", ".join(FAILS))
raise SystemExit(1 if FAILS else 0)
