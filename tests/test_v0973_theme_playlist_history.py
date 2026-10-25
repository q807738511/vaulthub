#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v0.9.85 契约测试：播放模式提示遮挡 / 播放列表 / 历史阅读释放 / 主题三层叠加。

用户本轮四条需求（原文）：
  1. 音乐播放器，播放模式按钮点击后提示被覆盖，修复参数；
  2. 播放器上的歌词详情按钮改成播放列表，加入播放列表功能；
  3. 电子书及漫画的已读收藏释放依旧故障，重新修复，并修改已读收藏为历史阅读；
  4. 页面美化及主题增加（会话 mtkzexy5e4e2te 的页面主题升级方案）。

本文件只做静态契约（写法级）断言；行为级断言在
  · tests/test_v0973_theme_engine_behavior.py（主题引擎，Node VM 真跑）
  · tests/test_v0973_history_release_behavior.py（释放流程 + 播放队列，Node VM 真跑）
  · media-go/v0973_reading_release_test.go（服务端 DELETE 语义）
"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HTML = (ROOT / "index.html").read_text(encoding="utf-8")
CSS = (ROOT / "web/css/main.css").read_text(encoding="utf-8")
STATE = (ROOT / "web/js/01-state.js").read_text(encoding="utf-8")
MEDIA = (ROOT / "web/js/02-media.js").read_text(encoding="utf-8")
FEATURES = (ROOT / "web/js/03-features.js").read_text(encoding="utf-8")
BOOT = (ROOT / "web/js/04-boot.js").read_text(encoding="utf-8")
THEME = (ROOT / "web/js/06-theme.js").read_text(encoding="utf-8")
GO_READING = (ROOT / "media-go/reading_progress.go").read_text(encoding="utf-8")
UPDATELOG = (ROOT / "Update Log.md").read_text(encoding="utf-8")
NOTES = (ROOT / ".github/RELEASE_NOTES_0.9.90.md")

VERSION = "1.0.12"
checks = []


def check(name, ok, detail=""):
    checks.append((name, bool(ok), detail))


# ---------------- 需求 1：播放模式提示被播放器覆盖 ----------------
check("T1 提示上移量函数存在", "function toastBottomLift()" in FEATURES)
check("T1 提示条写回 --toast-lift", 'setProperty("--toast-lift"' in FEATURES)
check("T1 CSS 用 --toast-lift 计算位置", "translateY(calc(80px - var(--toast-lift, 0px)))" in CSS
      and "translateY(calc(0px - var(--toast-lift, 0px)))" in CSS)

toast_z = re.search(r"\.toast \{.*?z-index:\s*(\d+)", CSS, re.S)
player_z = re.search(r"\.audio-player \{.*?z-index:\s*(\d+)", CSS, re.S)
check("T1 提示条 z-index 高于底部播放器",
      toast_z and player_z and int(toast_z.group(1)) > int(player_z.group(1)),
      f"toast={toast_z and toast_z.group(1)} player={player_z and player_z.group(1)}")
check("T1 提示条避开最小化视频条", 'video-controller-docked' in FEATURES)
# v0.9.94（需求6）：切模式不再弹提示（那个提示会固定停在页面上），
# 模式只在循环图标上体现 —— 四个模式四个图标。
check("T1 播放模式按钮仍走 cycleAudioLoop，但不再弹提示（只在图标上体现）",
      "function cycleAudioLoop()" in MEDIA
      and "toast(" not in MEDIA.split("function cycleAudioLoop()")[1][:200]
      and 'const AUDIO_LOOP_ICON = { sequence: "sequence", list: "repeat", single: "repeatOne", random: "shuffle" };' in MEDIA)


# ---------------- 需求 2：歌词详情按钮 → 播放列表 ----------------
check("T2 播放器控制条新增播放列表按钮", 'id="audioPlaylistButton"' in HTML
      and 'onclick="toggleAudioPlaylistPanel()"' in HTML)
check("T2 原「歌曲详情与歌词」按钮已从控制条移除",
      'title="歌曲详情与歌词" onclick="showAudioDetails()"' not in HTML)
check("T2 播放列表面板结构存在", 'id="audioPlaylistPanel"' in HTML and 'id="audioPlaylistList"' in HTML
      and 'id="audioPlaylistCount"' in HTML)
check("T2 面板函数齐备",
      all(fn in MEDIA for fn in ["function renderAudioPlaylistPanel()", "function openAudioPlaylistPanel()",
                                 "function toggleAudioPlaylistPanel()", "function playAudioQueueIndex(",
                                 "function removeAudioQueueIndex(", "function clearAudioQueue()",
                                 "function saveAudioQueueAsPlaylist()"]))
check("T2 队列即播放队列（不另存副本）",
      "audioQueueEntries()" in MEDIA and "(audioFiles || []).map((file, index)" in MEDIA)
check("T2 移除靠前的曲目后当前索引左移",
      "if (activeAudio && Number(activeAudio.index) > index) activeAudio.index = Number(activeAudio.index) - 1;" in MEDIA)
check("T2 移除后重渲染面板", MEDIA.count("renderAudioPlaylistPanel();") >= 3)
check("T2 切曲/重载队列后刷新面板", MEDIA.count("refreshAudioPlaylistPanel();") >= 3)
check("T2 每行保留歌曲详情/歌词入口", "audioQueueDetails(" in MEDIA
      and 'title="歌曲详情与歌词"' in MEDIA)
check("T2 面板可保存为歌单", "readAudioPlaylists()" in MEDIA and "writeAudioPlaylists(list)" in MEDIA)
check("T2 面板样式齐备", all(sel in CSS for sel in [".audio-playlist-panel {", ".apl-head {", ".apl-row {", ".apl-empty {"]))


# ---------------- 需求 3：历史阅读（原「已读收藏」）可释放 ----------------
# 允许历史注释里出现旧名（v0.9.30 的「未读 / 已读收藏」是本版梳理的来龙去脉），
# 但界面字符串（带引号的 UI 文案）里不能再有「已读收藏」。
check("T3 UI 已改名为历史阅读", "🕘 历史阅读" in MEDIA and '"已读收藏"' not in MEDIA
      and '"✓ 已读收藏"' not in MEDIA)
check("T3 释放提示文案更新", "已移入历史阅读" in MEDIA and "已移入历史阅读" in FEATURES)
check("T3 前端释放函数存在", "async function releaseReadingState(" in MEDIA)
check("T3 释放同时清服务端/内存/localStorage",
      'method: "DELETE"' in MEDIA and "readingProgressCache[lib].delete" not in MEDIA
      and "delete readingProgressCache[lib][rel]" in MEDIA
      and "localStorage.removeItem(mediaStateKey(lib, rel))" in MEDIA)
check("T3 释放撤掉未落盘的待写进度", "readingProgressPending.delete(`${lib}\\n${rel}`)" in MEDIA)
check("T3 阅读器按钮两态（标记已读 / 释放）",
      'id="readerReadToggle"' in MEDIA and "function syncReaderReadToggle()" in MEDIA
      and 'done ? "↩ 释放" : "✓ 标记已读"' in MEDIA)
check("T3 已读状态下点按钮走释放",
      "if (Number(readingState(libId, path).progress || 0) >= COMPLETED_PROGRESS) { releaseBookFromHistory(libId, path); return; }" in MEDIA)
check("T3 历史阅读视图卡片带释放按钮",
      "book-card-release" in MEDIA and "releaseBookFromHistory(${jsAttrArg(lib.id)},${jsAttrArg(path)})" in MEDIA
      and ".book-card-release" in CSS)
check("T3 关闭阅读器保持当前书架视图（不被踢回未读）",
      "setComicShelfView(comicShelfView);" in FEATURES and 'setComicShelfView("shelf");' not in FEATURES)
check("T3 释放后重渲染书架", "releaseBookFromHistory" in MEDIA and "loadLocalFiles(String(activeReader ? activeReader.group : \"comic\"), lib, 0)" in MEDIA)
check("T3 服务端支持 DELETE 释放",
      "case http.MethodDelete:" in GO_READING and 'method not allowed' in GO_READING)
check("T3 服务端释放按库 + 路径校验",
      'key := overrideKey(lib.ID, mediaPath)' in GO_READING
      and GO_READING.count("safeFile(lib, mediaPath)") >= 2)
check("T3 服务端释放幂等（removed=false）",
      '"removed": false' in GO_READING and '"removed": true' in GO_READING)


# ---------------- 需求 4：主题系统（v1.0.12 起 = 界面规格 × 明暗） ----------------
# v0.9.73 的三层模型（调色板 × 明暗 × 强调色）在 v1.0.12 收敛成两层：调色板、强调色、
# 自定义背景三档设置按客户口径整体移除，每套界面规格自带完整主题定义。
check("T4 主题引擎独立成文件", "const SPEC_THEMES = {" in THEME and "web/js/06-theme.js" in HTML)
check("T4 三套规格各有主题定义",
      all(f'  {sid}: {{' in THEME for sid in ["apple", "emby", "plex"])
      and THEME.count("tokens: {") == 3)
check("T4 每套规格亮暗两套令牌", THEME.count("dark: {") >= 3 and THEME.count("light: {") >= 3)
check("T4 规格带壁纸与播放器皮肤字段",
      all(f'wallpaper: "{w}"' in THEME for w in ["aerial", "collage", "ultrablur"])
      and all(f'player: "{pl}"' in THEME for pl in ["glass", "osd", "plex"]))
check("T4 三份规格文档路径都指向 docs/specs",
      all(f'doc: "/docs/specs/{sid}.md"' in THEME for sid in ["apple", "emby", "plex"]))
check("T4 明暗三档含跟随系统", 'const THEME_MODES = ["dark", "light", "auto"]' in THEME
      and "systemPrefersDark" in THEME and "addEventListener(\"change\", onChange)" in THEME)
check("T4 规格与明暗落到 html data-*",
      'root.setAttribute("data-spec", mode);' in THEME and 'root.dataset.mode = mode;' in THEME
      and 'root.setAttribute("data-wallpaper"' in THEME and 'root.setAttribute("data-spec-player"' in THEME)
check("T4 保留旧世界观 body[data-theme]/兼容 setTheme",
      'document.body.dataset.theme = mode;' in THEME and "function setTheme(th)" in THEME)
check("T4 01-state.js 不再重复定义 setTheme", "function setTheme(" not in STATE)
check("T4 阅读器主题跟随明暗层", "resolvedThemeMode()" in MEDIA and "readerThemeClass" in MEDIA)
check("T4 切换有过渡但不常驻", "function themeTransitionPulse()" in THEME and 'classList.add("theming")' in THEME
      and "html.theming" in CSS)
check("T4 减弱动效开关", "reduceMotion" in THEME and 'html[data-motion="reduce"]' in CSS)

# 移除项：调色板 / 强调色 / 自定义背景
check("T4 调色板与强调色定义已移除",
      "THEME_PALETTES" not in THEME and "THEME_ACCENTS" not in THEME
      and "setThemePalette" not in THEME and "setThemeAccent" not in THEME)
check("T4 自定义背景已移除（无 setCustomBg / 无 --bgImg 渲染）",
      "setCustomBg" not in THEME and "function uploadBg(" not in STATE
      and "--bgImg" not in STATE and "--bgImg" not in CSS
      and 'removeItem("dwu_bgimg")' in STATE)
check("T4 CSS 不再有 data-palette / data-accent 令牌块",
      "data-palette" not in CSS and "data-accent" not in CSS)
check("T4 外观面板不再渲染调色板/强调色容器",
      'id="themePaletteGrid"' not in HTML and 'id="themeAccentSwatches"' not in HTML
      and 'id="themeCustomBgToggle"' not in HTML and 'id="bgFile"' not in HTML)
check("T4 首帧防闪内联脚本在 head 内",
      'localStorage.getItem("dwu_settings")' in HTML and "root.dataset.spec = spec" in HTML
      and HTML.index("root.dataset.spec = spec") < HTML.index("<body"))
check("T4 首帧脚本对规格做白名单",
      'var SPECS = ["apple", "emby", "plex"];' in HTML
      and 'SPECS.indexOf(s.opMode) >= 0 ? s.opMode' in HTML
      and 'var WALLPAPER = { apple: "aerial", emby: "collage", plex: "ultrablur" };' in HTML)
check("T4 面板容器在设置页", 'id="opModeSeg"' in HTML and 'id="themeModeSeg"' in HTML
      and 'id="themeWallpaperToggle"' in HTML and 'id="opModeHighlights"' in HTML)
check("T4 boot 走 initTheme 且有守卫",
      "if (typeof initTheme === \"function\") initTheme();" in BOOT and "theme-opt" not in BOOT)
check("T4 语言切换重渲染面板", "renderThemePanel();" in FEATURES)

# CSS：3 规格 × 2 明暗 组合 + 实心填充色 + 语义色只随明暗
combos = [f'html[data-spec="{sp}"][data-mode="{m}"]' for sp in ["apple", "emby", "plex"] for m in ["light", "dark"]]
missing = [c for c in combos if c not in CSS]
check("T4 CSS 覆盖 3×2 全部组合", not missing, "缺：" + ", ".join(missing))
check("T4 实心填充色与描边色分离（--accent-ink 管白字）",
      "--accent-ink" in CSS and CSS.count("var(--accent-ink)") >= 8)
check("T4 语义色只随明暗", 'html[data-mode="dark"] { --green:' in CSS and 'html[data-mode="light"] { --green:' in CSS)
# 动效节奏也必须是「每套规格自己的一份」：否则切规格连手感都不变，等于只换了颜色。
spec_durations = {}
for sid in ["apple", "emby", "plex"]:
    for mode in ["light", "dark"]:
        seg = CSS.split(f'html[data-spec="{sid}"][data-mode="{mode}"] {{', 1)
        if len(seg) == 1:
            spec_durations[f"{sid}/{mode}"] = None
            continue
        body = seg[1].split("color-scheme:", 1)[0]
        hit = re.search(r"--dur:\s*(\d+ms)", body)
        spec_durations[f"{sid}/{mode}"] = hit.group(1) if hit else None
check("T4 每套规格都带自己的动效节奏",
      all(spec_durations.values()) and len(set(spec_durations.values())) == 3,
      str(spec_durations))
check("T4 动效缓动曲线也是令牌", "--ease: cubic-bezier(" in CSS)

# 壁纸层与播放器皮肤：三份详解文档里的美化元素真的落到了 CSS
check("T4 壁纸层容器存在", 'class="vh-wall"' in HTML and ".vh-wall { position: fixed" in CSS)
check("T4 三种壁纸各有实现",
      'html[data-wallpaper="aerial"] .vh-wall::before' in CSS
      and ".vh-wall-collage {" in CSS and ".vh-wall-ub {" in CSS)
check("T4 UltraBlur 四角色由 JS 写入 CSS 变量",
      "--ub-tl" in CSS and 'setProperty("--ub-tl"' in THEME and "vhUltraBlurFromImg" in THEME)
check("T4 海报拼贴由 JS 从当前列表取样", "function vhRenderCollage()" in THEME and "vhCollageSources" in THEME)
check("T4 Emby 中央大播放键（OSD）",
      'class="vc-center-play' in MEDIA and "html[data-spec=\"emby\"] .vc-center-play" in CSS
      and "data-video-center-play" in MEDIA)
check("T4 Apple 液态玻璃材质挂到顶栏/弹窗/播放器",
      'html[data-spec="apple"] .topbar' in CSS and "backdrop-filter: blur(var(--glass-blur))" in CSS)
check("T4 Plex 琥珀进度条", 'html[data-spec="plex"] .video-played-range' in CSS)

# i18n：三语言齐备（v1.0.12 新增规格壁纸与规格详解文案）
for key in ["themeModeLbl", "themeModeSaved", "themeReduceMotion",
            "themeWallpaperLbl", "themeWallpaperSub", "wallpaperOn", "wallpaperOff",
            "specDocTitle", "specDocOpen", "specDocLead", "specDocApply"]:
    hits = len(re.findall(rf"\b{key}:", STATE))
    check(f"T4 i18n 三语言齐备：{key}", hits == 3, f"命中 {hits} 处")


# ---------------- 版本与发布资料 ----------------
check("V 入口页资源版本 0.9.90", f'window.VAULTHUB_ASSET_VERSION = "{VERSION}";' in HTML)
check("V 脚本自校验版本 0.9.90", f'const VAULTHUB_SCRIPT_VERSION = "{VERSION}";' in STATE)
check("V 所有静态资源带 ?v=1.0.12", HTML.count(f"?v={VERSION}") >= 8, f"命中 {HTML.count(f'?v={VERSION}')}")
check("V 主题脚本被入口页引用", f'/web/js/06-theme.js?v={VERSION}' in HTML)
# 同一版本内角标文案随本版主功能追加而调整（v0.9.83 收尾加入顶栏导航与书刊页）。
check("V 侧栏与关于弹窗角标已升版", HTML.count(f"v{VERSION}") >= 1)
check("V release notes 文件存在", NOTES.is_file())
check("V Update Log 有 v0.9.85 段", f"# VaultHub 蜀鼠之家 v{VERSION}" in UPDATELOG)
check("V 历史版本号仍钉在历史注释里",
      "v0.9.72：歌词层" in HTML and "let audioMetadataMemory = null; // v0.9.72" in MEDIA)

failed = [(n, d) for n, ok, d in checks if not ok]
for name, ok, detail in checks:
    print(("PASS: " if ok else "FAIL: ") + name + (f"  [{detail}]" if detail and not ok else ""))
print(f"\nSUMMARY {len(checks) - len(failed)}/{len(checks)} PASS")
if failed:
    raise SystemExit("FAIL: v0.9.85 契约测试未通过")
print("PASS: v0.9.85 契约（提示遮挡 / 播放列表 / 历史阅读释放 / 三层主题）全部满足")
