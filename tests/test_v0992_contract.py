#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v0.9.92 静态契约：影视铺满窗口、跨页「正在播放」入口、封面 sidecar 不入目录、
缓存目录映射修复，以及 v0.9.91 审查遗留的 5 项收尾。
与 tests/v0992_behavior.js（真实执行源码）互补：这里只做静态落点与文档一致性检查。"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HTML = (ROOT / "index.html").read_text(encoding="utf-8")
STATE = (ROOT / "web/js/01-state.js").read_text(encoding="utf-8")
MEDIA = (ROOT / "web/js/02-media.js").read_text(encoding="utf-8")
FEATURES = (ROOT / "web/js/03-features.js").read_text(encoding="utf-8")
CSS = (ROOT / "web/css/main.css").read_text(encoding="utf-8")
LOG = (ROOT / "Update Log.md").read_text(encoding="utf-8")
NOTES = (ROOT / ".github/RELEASE_NOTES_0.9.92.md").read_text(encoding="utf-8")
GO_MAIN = (ROOT / "media-go/main.go").read_text(encoding="utf-8")
GO_COVER = (ROOT / "media-go/cover_persist.go").read_text(encoding="utf-8")
GO_SCAN = (ROOT / "media-go/scan_walk.go").read_text(encoding="utf-8")

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


print("v0.9.92 契约检查")

# ============ 1) 影视播放自动占满整个窗口 ============
check("1a 播放器挂上 player-fullbleed 类",
      'movie-player player-fullbleed' in MEDIA)
check("1b CSS 铺满规则把浮层拉到 inset:0 且 z-index 高于顶栏/侧栏",
      '.media-reader-overlay.movie-player.player-fullbleed { top:0; left:0; right:0; bottom:0; z-index:620; }' in CSS
      and 'z-index:600' in CSS)
check("1c 铺满时视频区高度铺满且去掉内边距",
      '.media-reader-overlay.movie-player.player-fullbleed .media-video-body { min-height:0; height:100%; padding:0; }' in CSS)
check("1d 停靠小窗规则（4 类名）仍存在，优先级高于铺满",
      '.media-reader-overlay.movie-player.video-minimized.video-controller-docked' in CSS)

# ============ 2) 跨页「正在播放」入口 ============
check("2a index.html 有浮标容器", 'id="playbackDock"' in HTML)
check("2b 浮标三键齐全（播放/暂停、回到播放、停止收起）",
      'onclick="toggleActivePlayback()"' in HTML and 'onclick="returnToActivePlayback()"' in HTML
      and 'onclick="stopActivePlayback()"' in HTML)
check("2c 状态持久化在 localStorage（刷新后仍在）",
      'ACTIVE_PLAYBACK_KEY = "vaulthub_active_playback"' in STATE and 'localStorage.setItem(ACTIVE_PLAYBACK_KEY' in STATE)
check("2d 状态 API 齐全", all(k in STATE for k in
      ["function setActivePlayback(", "function setActivePlaybackPaused(", "function clearActivePlayback(",
       "function updatePlaybackDock(", "function activePlayback("]))
check("2e 视图切换时刷新浮标", "if (typeof updatePlaybackDock === \"function\") updatePlaybackDock();" in STATE)
check("2f 三语 dockReturn / dockPlaying 都在",
      STATE.count("dockReturn:") == 3 and STATE.count("dockPlaying:") == 3)
check("2g 媒体侧实现齐全", all(k in MEDIA for k in
      ["function resumeActivePlayback(", "function liveActiveVideoElement(", "function playbackSurfaceVisible(",
       "function activePlaybackPlaying(", "function returnToActivePlayback(", "function toggleActivePlayback(",
       "function stopActivePlayback(", "function markVideoActivePlayback("]))
check("2h 优先复用活着的播放元素（真续播，不重建流）",
      'const video = liveActiveVideoElement(cur);' in MEDIA and 'if (video) {' in MEDIA)
check("2i 元素已销毁时按保存进度重开（不是从 0 起播）",
      'restoreVideoPlaybackState 会按' in MEDIA or 'openLocalMedia("movie", cur.libId, cur.path)' in MEDIA)
check("2j 音频播放/停止登记与清理状态",
      'setActivePlayback({ kind: "audio"' in MEDIA and 'clearActivePlayback("audio")' in MEDIA)
check("2k 关闭播放器时清状态", 'clearActivePlayback("video")' in FEATURES)
check("2l CSS 浮标默认隐藏、只在 .show 时出现",
      '.playback-dock.show { display:flex; }' in CSS and 'display:none' in CSS.split(".playback-dock {")[1].split("}")[0])

# ============ 3) 封面/海报 sidecar 不入目录 ============
check("3a 服务端有 sidecar 判定函数", "func isMediaSidecarImage(base string) bool" in GO_COVER)
check("3b 扫描端调用它（skipIndexFile 命中即跳过）",
      "isMediaSidecarImage(filepath.Base(slash))" in GO_SCAN and "func skipIndexFile(rel string) bool" in GO_SCAN)
check("3c 前端同步拒绝（已有索引无需重建即干净）",
      "function isMediaSidecarImage(path)" in MEDIA and "if (isMediaSidecarImage(path)) return false;" in MEDIA)
check("3d 规则对齐：.cover 与 -poster/-fanart/-backdrop/-logo 都覆盖",
      "MEDIA_SIDECAR_IMAGE_EXTS" in MEDIA and '"-poster", "-fanart", "-backdrop", "-logo"' in MEDIA
      and '"-poster", "-fanart", "-backdrop", "-logo"' in GO_COVER)

# ============ 4) 缓存目录映射 ============
check("4a 显式配置 MEDIA_PAGE_CACHE_DIR 时不被运行时覆盖",
      "pageCacheDirPinned" in GO_MAIN and 'a.pageCacheDirPinned = os.Getenv("MEDIA_PAGE_CACHE_DIR") != ""' in GO_MAIN)
check("4b cache_dir 变更时重新派生分页缓存目录并丢弃旧实例",
      '!a.pageCacheDirPinned && oldCacheDir != c.CacheDir' in GO_MAIN
      and 'a.pageCacheDir = filepath.Join(c.CacheDir, "page-cache")' in GO_MAIN
      and 'a.pageCache = nil' in GO_MAIN)
check("4c 音频转码缓存本来就按当前 cacheDir 现算（无需改）",
      'base := a.cacheDir' in (ROOT / "media-go/audio_stream.go").read_text(encoding="utf-8"))

# ============ 5) v0.9.91 审查遗留 5 项 ============
check("5a 活跃窗口常量存在且被两处淘汰逻辑使用",
      "cacheActiveWindow    = 30 * time.Minute" in GO_MAIN and GO_MAIN.count("now.Sub(it.mod) < cacheActiveWindow") == 2)
check("5b 命中缓存即刷新 mtime（LRU 保护正在播放的条目）",
      "_ = os.Chtimes(cache, nowT, nowT)" in GO_MAIN)
check("5c 早退路径也写用量快照（配额/过期都为 0、目录不可读）",
      "a.cacheBytes, a.cacheFiles, a.cacheCleanedAt = total, len(items), now.Unix()" in GO_MAIN
      and "a.cacheBytes, a.cacheFiles, a.cacheCleanedAt = 0, 0, time.Now().Unix()" in GO_MAIN)
check("5d 翻页失败冷静期常量与守卫",
      "MEDIA_SCROLL_FAIL_COOLDOWN_MS = 4000" in MEDIA and "if (now < Number(st.blockUntil || 0)) return false;" in MEDIA)
check("5e 翻页忙标记保持到这一页取回（成功 120ms / 失败进冷静期）",
      "pending.then(() => finish(true)).catch(() => finish(false));" in MEDIA
      and "mediaPagingState.blockUntil = Date.now() + MEDIA_SCROLL_FAIL_COOLDOWN_MS;" in MEDIA)
check("5f cleanCache 不再在函数入口直接 return",
      "if cacheMaxBytes <= 0 && cacheMaxAge <= 0 {\n\t\treturn\n\t}" not in GO_MAIN)
# 测试断言升级（审查项：标语整串一致 + 冗余 or）
check("5g 标语断言已升级为整串一致（至少 5 处；正则与版本号无关）",
      sum(1 for f in list((ROOT / "tests").glob("*.py")) + list((ROOT / "tests").glob("*.js"))
          if "len(set(" in f.read_text(encoding="utf-8") and 'v\\d+\\.\\d+\\.\\d+ · ' in f.read_text(encoding="utf-8")) >= 5)
# v0.9.94：改成与版本号无关的正则，避免每次升版都要机械改断言。
check("5h test_v0960 冗余 or 已清理",
      not re.search(r'"v0\.9\.\d+" in HTML or "v0\.9\.\d+" in HTML', (ROOT / "tests/test_v0960_audio_edit_jump.py").read_text(encoding="utf-8")))

# ============ 6) 版本与文档 ============
check("6a 资源版本号已升至本版（≥10 处）", HTML.count("?v=1.0.8") >= 10)
check("6b ASSET / SCRIPT 版本一致",
      'VAULTHUB_ASSET_VERSION = "1.0.8"' in HTML and 'VAULTHUB_SCRIPT_VERSION = "1.0.8"' in STATE)
_slogans = re.findall(r"v\d+\.\d+\.\d+ · [^<\"]+", HTML)
check("6c 标语三处整串一致", len(_slogans) == 3 and len(set(_slogans)) == 1, sorted(set(_slogans)))
check("6d Update Log 顶部为本版", LOG.startswith("# VaultHub 蜀鼠之家 v1.0.8"))
check("6e Release Notes 存在且写明四项需求",
      (ROOT / ".github/RELEASE_NOTES_0.9.92.md").exists()
      and "铺满" in NOTES and "正在播放" in NOTES and "sidecar" in NOTES and "缓存目录" in NOTES)
check("6f README 未被改动（发布说明只进 Update Log）",
      "v0.9.92" not in (ROOT / "README.md").read_text(encoding="utf-8"))
# 公开文档脱敏（上轮审查项）
_leak = re.compile(r"\b\d+\s?G\b|/vol[0-9]/|192\.168\.|\bsszj\.|\benged\.top\b")
check("6g 公开文档（Update Log 本版段 / Release Notes）无主机容量与内网细节",
      not _leak.search(NOTES) and not _leak.search(LOG.split("---")[0]),
      [_leak.findall(NOTES)[:4], _leak.findall(LOG.split("---")[0])[:4]])
check("6h 历史发布说明也已脱敏",
      "63G" not in (ROOT / ".github/RELEASE_NOTES_0.9.91.md").read_text(encoding="utf-8"))

print()
print("通过 %d / 失败 %d" % (OK, len(FAILS)))
if FAILS:
    print("失败项:", ", ".join(FAILS))
raise SystemExit(1 if FAILS else 0)
