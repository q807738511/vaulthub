#!/usr/bin/env python3
"""v0.9.40 契约测试

覆盖需求：
1. 播放中滑动鼠标触发识别，3 秒无操作重新隐藏（暂停/悬停/浮层展开时不隐藏）。
2. 左上角向下 V 形折叠；折叠后左下角出现向上 V 形展开按钮。
3. 右上角全屏切换。
4. 左下角标题：剧集显示集数 + 分集标题，电影显示年份；实时显示 当前时间 / 视频时长。
5. 中部从左到右：上一个 / 快退 / 暂停播放 / 快进 / 下一个 / 关闭播放。
6. 右下角从左到右：更多操作（含获取信息）/ 重复播放 / 随机播放 / 设置（转码质量、音频流、字幕）/ 播放列表 / 声音。
7. 从左下到右下的方框上方是可拖动/点击定位的播放进度条。
8. 未触发识别时控制栏隐藏。
9. 版本号与 release notes 就位。
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

# ---------------------------------------------------------------- 1. 触发与自动隐藏
check("VIDEO_CHROME_HIDE_MS = 3000" in MEDIA, "自动隐藏必须是 3 秒")
check("function scheduleVideoChromeHide(" in MEDIA, "缺少控制栏计时器")
check('"pointermove"' in MEDIA and "scheduleVideoChromeHide(root)" in MEDIA,
      "必须由滑动鼠标（pointermove）触发识别")
check("function videoChromeLocked(" in MEDIA, "缺少「不该隐藏」的判定")
for marker in ['querySelector("video")?.paused',
               '[data-video-panel].show',
               'dataset.videoChromeHover']:
    check(marker in MEDIA, f"videoChromeLocked 必须考虑：{marker}")
check("function hideVideoChrome(" in MEDIA and 'root.dataset.videoControlsVisible = "false"' in MEDIA,
      "必须能真正隐藏控制栏")
# 未触发识别时控制栏不可见且不可点
chrome_rule = re.search(r"\.video-chrome \{([^}]*)\}", CSS)
check(chrome_rule is not None, "缺少 .video-chrome 规则")
if chrome_rule:
    body = chrome_rule.group(1).replace(" ", "")
    check("opacity:0" in body, "未触发识别时控制栏必须透明")
    check("pointer-events:none" in body, "未触发识别时控制栏不能拦截点击")
check(".media-video-body.video-controls-visible .video-chrome" in CSS,
      "控制栏显示必须由 .media-video-body.video-controls-visible 驱动")
# 控制层铺满整个播放区，所以它本身必须永远不接收指针事件：否则鼠标停在画面
# 中央也算「停在控制栏上」，3 秒定时器永不触发；画面点击也会被这层吞掉。
check(".vc-top,.vc-bottom { pointer-events:none; }" in CSS,
      "控制层的顶部/底部条默认不能接收指针事件")
check(".media-video-body.video-controls-visible .vc-top" in CSS
      and ".media-video-body.video-controls-visible .vc-bottom" in CSS,
      "只有控制栏可见时顶部/底部条才可点")
check("pointer-events:auto" not in chrome_rule.group(1) if chrome_rule else False,
      ".video-chrome 本体不能开启 pointer-events")
check('.querySelectorAll(".vc-top,.vc-bottom,[data-video-panel]")' in MEDIA,
      "hover 锁必须绑在真实控制条上，不能绑整块控制层")
check('.querySelectorAll(".vc-top,.vc-bottom,[data-video-panel],.vc-restore")' in MEDIA,
      "stopPropagation 只能拦控制条与浮层，画面点击必须落到 video")
check('video.addEventListener("click"' in MEDIA, "点画面必须能切换播放/暂停")
# 回归：初始化必须把 .video-controls-visible 绑到 .media-video-body 上
check("bindVideoStatus(videoRoot, video)" in MEDIA,
      "bindVideoStatus 必须收到 .media-video-body（旧代码传外层 viewer，控制栏永不显示）")

# ---------------------------------------------------------------- 2. 折叠 / 展开 V 形
check('class="vc-icon vc-collapse"' in SHELL and "collapseVideoChrome(this)" in SHELL,
      "左上角缺少向下折叠按钮")
check("\u2304" in SHELL, "左上角必须是向下的 V 形尖角 ⌄")
check('class="vc-restore"' in SHELL and "expandVideoChrome(this)" in SHELL,
      "折叠后左下角缺少展开按钮")
check("\u2303" in SHELL, "左下角必须是向上的 V 形尖角 ⌃")
check('data-video-chrome-collapsed="false"' in SHELL, "缺少折叠状态标记")
check('.media-video-body[data-video-chrome-collapsed="true"] .vc-restore' in CSS,
      "折叠态才显示展开按钮")
check('.media-video-body[data-video-chrome-collapsed="true"] .video-chrome' in CSS,
      "折叠态必须隐藏整条控制栏")
check("if (videoChromeCollapsed(root)) return;" in MEDIA,
      "折叠后滑动鼠标不能再唤出控制栏")
restore_rule = re.search(r"\.vc-restore \{([^}]*)\}", CSS)
check(restore_rule is not None and "left:" in restore_rule.group(1) and "bottom:" in restore_rule.group(1),
      "展开按钮必须固定在左下角")

# ---------------------------------------------------------------- 3. 全屏
check('class="vc-icon vc-fullscreen"' in SHELL and "toggleVideoFullscreen(this)" in SHELL,
      "右上角缺少全屏切换按钮")
check("root.requestFullscreen" in MEDIA, "全屏必须优先整块播放区（控制栏一起进全屏）")
check("requestFullscreen?.()" in MEDIA, "全屏被拒绝时必须回落到 video 元素")
check('"fullscreenchange"' in MEDIA, "全屏状态变化必须同步按钮状态")

# ---------------------------------------------------------------- 4. 左下角标题与时间
check("function videoChromeTitle(" in MEDIA, "缺少标题构造函数")
check("parseSeriesEpisode(path)" in MEDIA and "parsed.label" in MEDIA,
      "剧集标题必须带 SxxExx 集数")
check("meta.year" in MEDIA and "`(${meta.year})`" in MEDIA, "电影必须显示年份")
check("function applyVideoChromeTitle(" in MEDIA and "applyVideoChromeTitle(videoRoot, lib, path)" in MEDIA,
      "打开播放器时必须写入标题")
check("data-video-title" in SHELL and "data-video-meta-line" in SHELL, "缺少标题/副标题节点")
check('class="video-time-label"' in SHELL, "缺少时间标签")
check("`${formatVideoTime(video.currentTime)} / ${formatVideoTime(video.duration)}`" in MEDIA,
      "必须实时显示 当前时间 / 视频时长")

# ---------------------------------------------------------------- 5. 中部传输键顺序
center = SHELL.split('class="vc-center"', 1)[1].split("</div>", 1)[0]
order = re.findall(r'(videoPlayNeighbour\(this,-1\)|videoSkip\(this,-10\)|videoTogglePlay\(this\)|videoSkip\(this,10\)|videoPlayNeighbour\(this,1\)|closeVideoPlayer\(this\))', center)
check(order == ["videoPlayNeighbour(this,-1)", "videoSkip(this,-10)", "videoTogglePlay(this)",
                "videoSkip(this,10)", "videoPlayNeighbour(this,1)", "closeVideoPlayer(this)"],
      f"中部按钮顺序必须是 上一个/快退/暂停播放/快进/下一个/关闭播放，实际 {order}")
for fn in ("function videoPlayNeighbour(", "function videoSkip(", "function videoTogglePlay(", "function closeVideoPlayer("):
    check(fn in MEDIA, f"缺少实现：{fn}")
center_rule = re.search(r"\.vc-center \{([^}]*)\}", CSS)
check(center_rule is not None and "justify-content:center" in center_rule.group(1).replace(" ", ""),
      "中部按钮组必须居中")

# ---------------------------------------------------------------- 6. 右下角功能键顺序
right = SHELL.split('class="vc-right"', 1)[1].split('</div>\n</div>', 1)[0]
right_order = re.findall(r"(toggleVideoPanel\(this,'more'\)|cycleVideoRepeat\(this\)|toggleVideoShuffle\(this\)|toggleVideoPanel\(this,'settings'\)|toggleVideoPanel\(this,'playlist'\)|toggleVideoPanel\(this,'volume'\))", right)
check(right_order == ["toggleVideoPanel(this,'more')", "cycleVideoRepeat(this)", "toggleVideoShuffle(this)",
                      "toggleVideoPanel(this,'settings')", "toggleVideoPanel(this,'playlist')",
                      "toggleVideoPanel(this,'volume')"],
      f"右下角按钮顺序必须是 更多/重复/随机/设置/播放列表/声音，实际 {right_order}")
# 更多操作里必须有「获取信息」并展示元数据与解码状态
more_panel = SHELL.split('data-video-panel="more"', 1)[1].split("</div>", 1)[0]
check('class="video-info-button"' in more_panel and "toggleVideoStatusPanel(this)" in more_panel,
      "「更多操作」内必须包含获取信息选项")
check("dataset.videoMetadata" in MEDIA and "formatVideoMetadata(" in MEDIA,
      "获取信息必须展示媒体元数据")
check("VIDEO_ENGINE_LABELS[root?.dataset.videoEngine]" in MEDIA,
      "获取信息必须展示当前解码/播放引擎状态")
# 重复 / 随机
check('VIDEO_REPEAT_ORDER = ["off", "one", "all"]' in MEDIA, "重复播放必须有三种模式")
check("function toggleVideoShuffle(" in MEDIA and "videoShuffleOn(" in MEDIA, "缺少随机播放实现")
check("function videoPlaybackEnded(" in MEDIA, "播放结束必须按重复/随机模式续播")
# 设置浮层内容：转码质量 + 音频流 + 字幕
settings_panel = SHELL.split('data-video-panel="settings"', 1)[1].split('data-video-panel="playlist"', 1)[0]
check("data-video-quality-options" in settings_panel, "设置浮层缺少转码质量")
for q in ('setVideoQuality(this,\'auto\')', 'setVideoQuality(this,\'1080p\')',
          'setVideoQuality(this,\'720p\')', 'setVideoQuality(this,\'480p\')'):
    check(q in settings_panel, f"设置浮层缺少画质选项：{q}")
check("data-video-audio-options" in settings_panel and "selectVideoAudioTrack" in MEDIA,
      "设置浮层缺少音频流选择")
check("data-video-subtitle-options" in settings_panel and "searchVideoSubtitles(this)" in settings_panel,
      "设置浮层缺少字幕选择")
# 播放列表
check("data-video-playlist" in SHELL and "function renderVideoPlaylist(" in MEDIA, "缺少播放列表")
check("function setVideoPlaylist(" in MEDIA and "setVideoPlaylist(lib.id, files)" in MEDIA,
      "影视库列表必须把文件写入播放队列")
# 声音：静音或音量滑条
volume_panel = SHELL.split('data-video-panel="volume"', 1)[1].split("</div>", 1)[0]
check("toggleVideoMute(this)" in volume_panel, "声音浮层缺少静音切换")
check('type="range"' in volume_panel and "setVideoVolume(this,this.value)" in volume_panel,
      "声音浮层缺少音量滑条")
check("function syncVideoVolumeUI(" in MEDIA, "音量 UI 必须与 video 状态同步")

# ---------------------------------------------------------------- 7. 进度条
check('class="video-progress-shell"' in SHELL and "seekVideoTimeline(event,this)" in SHELL,
      "缺少可点击定位的进度条")
check("function bindVideoTimelineDrag(" in MEDIA and "pointerdown" in MEDIA,
      "进度条必须支持按住拖动")
check("video-progress-knob" in SHELL and "video-progress-knob" in CSS, "进度条缺少进度点")
check("video-buffered-range" in SHELL and "video-played-range" in SHELL, "进度条缺少缓冲/已播区间")
# 进度条必须位于底部方框上方：DOM 顺序上 .video-timeline 在 .vc-bar 之前
bottom = SHELL.split('class="vc-bottom"', 1)[1]
check(bottom.index('class="video-timeline"') < bottom.index('class="vc-bar"'),
      "进度条必须在左下到右下的方框上方")

# ---------------------------------------------------------------- 8. 原生控制条必须移除
check('<video data-movie-player playsinline' in SHELL, "video 标签不能再带原生 controls")
check("controls" not in SHELL.split("<video", 1)[1].split(">", 1)[0],
      "video 标签内不能出现 controls 属性")

# ---------------------------------------------------------------- 9. 后端转码质量
check("func qualityMaxHeight(" in PLAYBACK, "后端缺少画质→分辨率上限映射")
check('case "720p":' in PLAYBACK and "return 720" in PLAYBACK, "720p 必须映射到 720 行")
check("plan.MaxHeight = cap" in PLAYBACK, "画质上限必须写入播放计划")
check('q.Set("height"' in PLAYBACK, "compat URL 必须带 height 参数")
check("func compatArgsScaled(" in BACKEND, "compat 必须支持分辨率上限")
check("func scaleFilterValue(" in BACKEND and "scale_vaapi=w=-2:h=min(ih" in BACKEND,
      "VAAPI 必须走 scale_vaapi")
check("scale=-2:min(ih" in BACKEND, "软件缩放必须用 scale=-2:min(ih,cap) 避免放大")
check("func withScaleFilter(" in BACKEND, "缩放滤镜必须替换已有 -vf 而不是叠加")
check(':h%d"' in BACKEND or ":h%d`" in BACKEND or 'a%s:h%d' in BACKEND,
      "转码缓存键必须包含分辨率，避免不同画质互相覆盖")

# ---------------------------------------------------------------- 10. i18n 与版本
for key in ("vpCollapse", "vpExpand", "vpFullscreen", "vpPrev", "vpNext", "vpRewind", "vpForward",
            "vpPlayPause", "vpClose", "vpMore", "vpInfo", "vpRepeat", "vpShuffle", "vpSettings",
            "vpQuality", "vpPlaylist", "vpVolume", "vpMute", "vpProgress"):
    check(STATE.count(f"{key}:") >= 3, f"播放器文案 {key} 必须三语齐备")
check(HTML.count("v0.9.40") >= 2, "关于与侧栏版本必须是 v0.9.40")
check('VAULTHUB_ASSET_VERSION = "0.9.40"' in HTML, "资源版本必须是 0.9.40")
check('VAULTHUB_SCRIPT_VERSION = "0.9.40"' in STATE, "脚本版本必须是 0.9.40")
check("ghcr.io/q807738511/vaulthub:v0.9.40" in COMPOSE, "Compose 必须指向 v0.9.40")
check((ROOT / ".github/RELEASE_NOTES_0.9.40.md").exists(), "缺少 v0.9.40 release notes")

if failures:
    print(f"FAIL: {len(failures)} 项 v0.9.40 契约未满足")
    for item in failures:
        print("  -", item)
    sys.exit(1)
print("PASS: v0.9.40 悬浮控制栏触发识别、折叠/全屏、剧集与年份标题、传输键、右下功能键、进度条与转码质量")
