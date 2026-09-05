#!/usr/bin/env python3
"""v0.9.54 契约测试（承接 v0.9.40 悬浮控制栏契约并升级）

覆盖需求：
1. 点击视频直接播放：初次切换源即自动 play；播放计划请求带 20s 超时，不再卡住。
2. 隐藏播放引擎展示：状态行/信息面板/设置浮层不再出现引擎名与「三层播放」手动按钮；
   超过 256 MB 的原片不再触发注定失败的 WASM 全量下载（先 Range 探测大小）。
3. 右下角静音按钮删除，音量滑条并入设置浮层；播放列表按钮只在电视剧集类型播放时展示，
   电影播放不展示且播完不自动连播，剧集自动连播下一集。
4. 左上角 ⌄ 最小化整个播放器（overlay 缩为右下角小窗继续播放），左下角 ⌃ 还原。
5. 播放器外层标题条与 ✕ 删除（movie-player 不再渲染 media-reader-head），
   标题移入播放器左上角 ⌄ 右侧的 vc-heading（data-video-title / data-video-meta-line）。
6. 播放异常兜底：计划流失败先切换基础兼容流重试；仍失败且原片 ≤256 MB 才尝试 WASM，
   其余给出可操作提示而不是卡死报错。
7. 版本号与 release notes 就位。
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
HTML = (ROOT / "index.html").read_text(encoding="utf-8")
MEDIA = (ROOT / "web/js/02-media.js").read_text(encoding="utf-8")
STATE = (ROOT / "web/js/01-state.js").read_text(encoding="utf-8")
CSS = (ROOT / "web/css/main.css").read_text(encoding="utf-8")
COMPOSE = (ROOT / "docker-compose.yml").read_text(encoding="utf-8")
PLAYBACK = (ROOT / "media-go/playback.go").read_text(encoding="utf-8")
BACKEND = (ROOT / "media-go/main.go").read_text(encoding="utf-8")

failures = []


def check(ok, message):
    if not ok:
        failures.append(message)


# 播放器模板：只取 movie 分支，避免命中别处同名字符串。
SHELL = MEDIA.split("else if (MEDIA_FORMATS.movie.includes(ext)) body =", 1)[1].split(";\n", 1)[0]

# ---------------------------------------------------------------- 1. 点击即播与计划超时
check("function switchMovieSource(video, url" in MEDIA, "缺少源切换函数")
check("const first = !video.dataset.currentSrc;" in MEDIA, "源切换必须识别「首次设置源」")
check("if (first && autoplay)" in MEDIA, "首次设置源后必须尝试自动播放")
check('updateVideoStatus(root, video, "点击画面开始播放")' in MEDIA,
      "自动播放被浏览器拦截时必须提示点击画面开始播放")
check("function requestPlaybackPlan(" in MEDIA and "AbortController" in MEDIA,
      "播放计划请求必须带 AbortController")
check("setTimeout(() => controller.abort(), 20000)" in MEDIA, "播放计划超时必须为 20s")
check('"播放计划请求超时（20s），已转用本地降级策略"' in MEDIA, "超时错误文案缺失")
check('const timer = setTimeout(() => controller.abort(), 20000);' in MEDIA, "计划超时必须真正中止请求")

# ---------------------------------------------------------------- 2. 隐藏播放引擎展示
check('function setVideoEngine(root, engine, detail)' in MEDIA, "缺少引擎状态函数")
check("if (detail) setMovieCompatStatus(root, detail);" in MEDIA,
      "状态行只能写 detail 文案，不能拼引擎标签")
check("VIDEO_ENGINE_LABELS[root?.dataset.videoEngine]" not in MEDIA,
      "信息面板 detail 不能再展示引擎字段")
check('"播放模式：${root.dataset.playbackMode || "auto"}`' in MEDIA or "播放模式：${root.dataset.playbackMode" in MEDIA,
      "诊断文案里不能残留引擎字段")
check('data-video-panel="settings"' in SHELL and 'data-engine-choice' not in SHELL,
      "设置浮层不能再有「三层播放」引擎选择按钮")
check("data-movie-direct" not in SHELL and "data-movie-wasm" not in SHELL,
      "模板不能残留手动引擎按钮")
check("function probeVideoFileSize(" in MEDIA, "缺少降级前原片大小探测")
check("Range: \"bytes=0-0\"" in MEDIA, "大小探测必须是 Range 请求（不下载正文）")
check("size > WASM_INPUT_LIMIT" in MEDIA and "无法在浏览器软解" in MEDIA,
      "超过 256 MB 必须停止 WASM 并提示，而不是继续全量下载")
check('"播放异常，请重试或更换片源"' in MEDIA, "播放异常必须有可操作的提示文案")

# ---------------------------------------------------------------- 3. 静音删除 / 播放列表门控 / 自动连播
check("data-video-mute" not in SHELL, "音量浮层不能再有静音按钮")
check("toggleVideoMute" not in MEDIA, "不能再引用一键静音函数")
check('data-video-panel="volume"' not in SHELL, "不能再有独立音量浮层面板")
check('data-video-panel="settings"' in SHELL and "data-video-volume" in SHELL,
      "音量滑条必须并入设置浮层")
check("vc-playlist-toggle" in SHELL, "播放列表按钮必须带门控类名")
check(".media-video-body .vc-playlist-toggle { display:none; }" in CSS,
      "播放列表按钮默认必须隐藏（电影不展示）")
check('.media-video-body[data-video-playlist-eligible="true"] .vc-playlist-toggle { display:inline-flex; }' in CSS,
      "只有剧集上下文才显示播放列表按钮")
check('dataset.videoPlaylistEligible = episodeContext ? "true" : "false"' in MEDIA,
      "播放器必须按剧集上下文设置播放列表门控")
check('if (root.dataset.videoPlaylistEligible !== "true") return;' in MEDIA,
      "非剧集播放播完必须停在结尾（不能自动连播下一部电影）")
check("videoRoot.dataset.videoPlaylistEligible" in MEDIA, "缺少播放列表门控写入点")

# ---------------------------------------------------------------- 4. ⌄ 最小化整个播放器
check("function minimizeVideoPlayer(" in MEDIA, "缺少最小化整个播放器函数")
check("function expandVideoPlayer(" in MEDIA, "缺少还原播放器函数")
check('overlay.classList.add("video-minimized")' in MEDIA, "最小化必须标记 overlay 小窗态")
check("video-minimized" in CSS and "right:" in CSS.split("video-minimized", 1)[1][:400],
      "CSS 必须有右下角小窗样式")
check('onclick="minimizeVideoPlayer(this)"' in SHELL, "左上角 ⌄ 必须触发最小化整个播放器")
check('onclick="expandVideoPlayer(this)"' in SHELL, "左下角 ⌃ 必须触发还原播放器")

# ---------------------------------------------------------------- 5. 外层头删除 + 标题移入左上角
check('.media-reader-overlay movie-player' not in SHELL and 'class="movie-player"' not in HTML,
      "overlay 播放器类名只由 opts.player 控制")
check('const head = opts.player ? "" :' in MEDIA, "视频播放器必须跳过外层标题头渲染")
check("opts.player ? \" movie-player\"" in MEDIA, "movie-player 类必须随 opts.player 输出")
check('{ player: isVideoPlayer }' in MEDIA, "openLocalMedia 必须给视频播放器传 player 标记")
check('class="vc-heading"' in SHELL, "vc-top 缺少标题块容器")
check('data-video-title' in SHELL and 'data-video-meta-line' in SHELL, "标题/副标题节点必须在 vc-heading 内")
check("movie-player-head" not in SHELL, "不再引用 movie-player-head 外层头")
check("closeLocalViewer('" not in SHELL, "视频播放器外层不能再有 ✕ 关闭按钮")

# ---------------------------------------------------------------- 6. 播放异常兜底
check("usingPlanURL" in MEDIA and "切换基础兼容流重试" in MEDIA,
      "计划流失败必须先切换基础兼容流重试一次")
check("engineFailurePending" in MEDIA, "引擎错误防抖必须保留")
check('video.addEventListener("error"' in MEDIA, "video error 兜底链必须保留")
check('if (root.dataset.videoPlaylistEligible !== "true") return;' in MEDIA,
      "电影播完不自动连播，剧集自动连播由 videoPlaybackEnded 继续保证")

# ---------------------------------------------------------------- 7. 触发 / 隐藏 / 全屏 / 进度条（回归自 v0.9.40）
check("VIDEO_CHROME_HIDE_MS = 3000" in MEDIA, "自动隐藏必须是 3 秒")
check("function scheduleVideoChromeHide(" in MEDIA, "缺少控制栏计时器")
check('"pointermove"' in MEDIA and "scheduleVideoChromeHide(root)" in MEDIA,
      "必须由滑动鼠标（pointermove）触发识别")
check("function videoChromeLocked(" in MEDIA, "缺少「不该隐藏」的判定")
check("function hideVideoChrome(" in MEDIA and 'root.dataset.videoControlsVisible = "false"' in MEDIA,
      "必须能真正隐藏控制栏")
chrome_rule = re.search(r"\.video-chrome \{([^}]*)\}", CSS)
check(chrome_rule is not None, "缺少 .video-chrome 规则")
if chrome_rule:
    body = chrome_rule.group(1).replace(" ", "")
    check("opacity:0" in body, "未触发识别时控制栏必须透明")
    check("pointer-events:none" in body, "未触发识别时控制栏不能拦截点击")
check(".media-video-body.video-controls-visible .video-chrome" in CSS,
      "控制栏显示必须由 .media-video-body.video-controls-visible 驱动")
check('class="vc-icon vc-fullscreen"' in SHELL and "toggleVideoFullscreen(this)" in SHELL,
      "右上角缺少全屏切换按钮")
check('class="video-progress-shell"' in SHELL and "seekVideoTimeline(event,this)" in SHELL,
      "缺少可点击定位的进度条")
check("function bindVideoTimelineDrag(" in MEDIA and "pointerdown" in MEDIA,
      "进度条必须支持按住拖动")
center = SHELL.split('class="vc-center"', 1)[1].split("</div>", 1)[0]
order = re.findall(r'(videoPlayNeighbour\(this,-1\)|videoSkip\(this,-10\)|videoTogglePlay\(this\)|videoSkip\(this,10\)|videoPlayNeighbour\(this,1\)|closeVideoPlayer\(this\))', center)
check(order == ["videoPlayNeighbour(this,-1)", "videoSkip(this,-10)", "videoTogglePlay(this)",
                "videoSkip(this,10)", "videoPlayNeighbour(this,1)", "closeVideoPlayer(this)"],
      f"中部按钮顺序必须是 上一个/快退/暂停播放/快进/下一个/关闭播放，实际 {order}")
check('data-video-status' in SHELL, "状态面板必须保留")
check("function videoChromeTitle(" in MEDIA, "缺少标题构造函数")

# ---------------------------------------------------------------- 8. 后端转码质量（回归）
check("func qualityMaxHeight(" in PLAYBACK, "后端缺少画质→分辨率上限映射")
check('case "720p":' in PLAYBACK and "return 720" in PLAYBACK, "720p 必须映射到 720 行")
check("func compatArgsScaled(" in BACKEND, "compat 必须支持分辨率上限")
check("func withScaleFilter(" in BACKEND, "缩放滤镜必须替换已有 -vf 而不是叠加")

# ---------------------------------------------------------------- 9. i18n 与版本
for key in ("vpCollapse", "vpExpand", "vpPreparing", "vpFullscreen", "vpPrev", "vpNext",
            "vpRewind", "vpForward", "vpPlayPause", "vpClose", "vpMore", "vpInfo",
            "vpRepeat", "vpShuffle", "vpSettings", "vpQuality", "vpPlaylist", "vpVolume", "vpProgress"):
    check(STATE.count(f"{key}:") >= 3, f"播放器文案 {key} 必须三语齐备")
check(HTML.count("v0.9.54") >= 2, "关于与侧栏版本必须是 v0.9.54")
check('VAULTHUB_ASSET_VERSION = "0.9.54"' in HTML, "资源版本必须是 0.9.54")
check('VAULTHUB_SCRIPT_VERSION = "0.9.54"' in STATE, "脚本版本必须是 0.9.54")
check("ghcr.io/q807738511/vaulthub:latest" in COMPOSE, "v0.9.54 起 Compose 跟随 latest")
check((ROOT / ".github/RELEASE_NOTES_0.9.54.md").exists(), "缺少 v0.9.54 release notes")

if failures:
    print(f"FAIL: {len(failures)} 项 v0.9.54 契约未满足")
    for item in failures:
        print("  -", item)
    sys.exit(1)
print("PASS: v0.9.54 点击即播、计划超时、引擎隐藏、>256MB 不软解、静音删除、剧集播放列表门控与自动连播、最小化小窗、标题移入左上角、异常兜底")
