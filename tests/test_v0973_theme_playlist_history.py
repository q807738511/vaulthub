#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v0.9.73 契约测试：播放模式提示遮挡 / 播放列表 / 历史阅读释放 / 主题三层叠加。

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
NOTES = (ROOT / ".github/RELEASE_NOTES_0.9.73.md")

VERSION = "0.9.73"
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
check("T1 播放模式按钮仍走 cycleAudioLoop 且弹提示",
      "function cycleAudioLoop()" in MEDIA and 'toast("🔁 "' in MEDIA)


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


# ---------------- 需求 4：三层主题系统 ----------------
check("T4 主题引擎独立成文件", THEME.count("const THEME_PALETTES = [") == 1 and "web/js/06-theme.js" in HTML)
check("T4 四套调色板", all(f'id: "{pid}"' in THEME for pid in ["emerald", "plum", "neon", "clay"]))
check("T4 六档强调色（含跟随主题）",
      all(f'id: "{aid}"' in THEME for aid in ["theme", "teal", "indigo", "rose", "amber", "violet"]))
check("T4 明暗三档含跟随系统", 'const THEME_MODES = ["dark", "light", "auto"]' in THEME
      and "systemPrefersDark" in THEME and "addEventListener(\"change\", onChange)" in THEME)
check("T4 三层落到 html data-*",
      'root.dataset.palette = palette;' in THEME and 'root.dataset.mode = mode;' in THEME
      and 'root.dataset.accent = accent;' in THEME)
check("T4 保留旧世界观 body[data-theme]/兼容 setTheme",
      'document.body.dataset.theme = mode;' in THEME and "function setTheme(th)" in THEME)
check("T4 01-state.js 不再重复定义 setTheme", "function setTheme(" not in STATE)
check("T4 阅读器主题跟随明暗层", "resolvedThemeMode()" in MEDIA and "readerThemeClass" in MEDIA)
check("T4 主题卡片是真预览（该主题自己的令牌）",
      "function themePreviewStyle(" in THEME and "--t-accent:" in THEME
      and "data-theme-preview" in THEME and ".themecard .tp-thumb" in CSS)
check("T4 切换有过渡但不常驻", "function themeTransitionPulse()" in THEME and 'classList.add("theming")' in THEME
      and "html.theming" in CSS)
check("T4 减弱动效开关", "reduceMotion" in THEME and 'html[data-motion="reduce"]' in CSS)
check("T4 自定义背景成为独立背景层",
      "function setCustomBg(on)" in THEME and "customBg" in THEME
      and 'document.body.classList.toggle("custom-bg", !!settings.customBg);' in THEME)
check("T4 首帧防闪内联脚本在 head 内",
      'localStorage.getItem("dwu_settings")' in HTML and "root.dataset.palette" in HTML
      and HTML.index("root.dataset.palette") < HTML.index("<body"))
# 首帧脚本必须对 localStorage 里的值做白名单，否则旧版本/手工改过的 palette
# 会让首帧套上一个 CSS 里不存在的 data-palette，亮色用户先闪一帧暗色。
check("T4 首帧脚本对 palette/accent 做白名单",
      'var PALETTES = ["emerald", "plum", "neon", "clay"];' in HTML
      and 'var ACCENTS = ["theme", "teal", "indigo", "rose", "amber", "violet"];' in HTML
      and 'PALETTES.indexOf(s.palette) >= 0 ? s.palette : "emerald"' in HTML
      and 'ACCENTS.indexOf(s.accent) >= 0 ? s.accent : "theme"' in HTML)
check("T4 面板容器在设置页", 'id="themePaletteGrid"' in HTML and 'id="themeAccentSwatches"' in HTML
      and 'id="themeModeSeg"' in HTML)
check("T4 boot 走 initTheme 且有守卫",
      "if (typeof initTheme === \"function\") initTheme();" in BOOT and "theme-opt" not in BOOT)
check("T4 语言切换重渲染面板", "renderThemePanel();" in FEATURES)

# CSS：8 个 调色板 × 明暗 组合 + 强调色分亮暗 + 实心填充色独立
combos = [f'html[data-palette="{p}"][data-mode="{m}"]' for p in ["emerald", "plum", "neon", "clay"] for m in ["light", "dark"]]
missing = [c for c in combos if c not in CSS]
check("T4 CSS 覆盖 4×2 全部组合", not missing, "缺：" + ", ".join(missing))
check("T4 CSS 强调色带 data-mode（才能盖过调色板）",
      all(f'html[data-mode="{m}"][data-accent="{a}"]' in CSS for m in ["light", "dark"] for a in ["teal", "indigo", "rose", "amber", "violet"]))
check("T4 实心填充色与描边色分离（--accent-ink 管白字）",
      "--accent-ink" in CSS and CSS.count("var(--accent-ink)") >= 8)
check("T4 语义色只随明暗", 'html[data-mode="dark"] { --green:' in CSS and 'html[data-mode="light"] { --green:' in CSS)
# 动效节奏也必须是「每套调色板自己的一份」：首版实现漏了 --dur/--ease，
# 组件只能吃到 var(--dur, .16s) 的兜底值，等于「动效速度进令牌」没落地。
palette_durations = {}
for pid in ["emerald", "plum", "neon", "clay"]:
    for mode in ["light", "dark"]:
        seg = CSS.split(f'html[data-palette="{pid}"][data-mode="{mode}"] {{', 1)
        if len(seg) == 1:
            palette_durations[pid] = None
            continue
        body = seg[1].split("color-scheme:", 1)[0]
        hit = re.search(r"--dur:\s*(\d+ms)", body)
        palette_durations[pid] = hit.group(1) if hit else None
check("T4 每套调色板都带自己的动效节奏",
      all(palette_durations.values()) and len(set(palette_durations.values())) == 4,
      str(palette_durations))
check("T4 动效缓动曲线也是令牌", "--ease: cubic-bezier(" in CSS)

# 本版顺手清掉的遗留：蓝色硬编码与未定义令牌
check("T4 遗留蓝色辉光已跟随主题",
      "rgba(88,166,255" not in CSS and "#58a6ff" not in CSS and "#0a84ff" not in CSS
      and "10,132,255" not in CSS)
check("T4 未定义令牌 --line/--panel 已修正",
      "var(--line)" not in CSS and "var(--panel" not in CSS
      and "border:1px solid var(--border);border-radius:var(--radius-lg,12px);background:color-mix(in srgb,var(--card2) 88%,transparent)}" in CSS)

# i18n：三语言齐备
for key in ["themeModeLbl", "themePaletteLbl", "themeAccentLbl", "accentTheme", "themeAccentHint",
            "themeModeSaved", "themePaletteSaved", "themeAccentSaved", "themeReduceMotion",
            "themeCustomBg", "bgEnabled", "bgDisabled", "themeNote"]:
    hits = len(re.findall(rf"\b{key}:", STATE))
    check(f"T4 i18n 三语言齐备：{key}", hits == 3, f"命中 {hits} 处")


# ---------------- 版本与发布资料 ----------------
check("V 入口页资源版本 0.9.73", f'window.VAULTHUB_ASSET_VERSION = "{VERSION}";' in HTML)
check("V 脚本自校验版本 0.9.73", f'const VAULTHUB_SCRIPT_VERSION = "{VERSION}";' in STATE)
check("V 所有静态资源带 ?v=0.9.73", HTML.count(f"?v={VERSION}") >= 8, f"命中 {HTML.count(f'?v={VERSION}')}")
check("V 主题脚本被入口页引用", f'/web/js/06-theme.js?v={VERSION}' in HTML)
# 同一版本内角标文案随本版主功能追加而调整（v0.9.73 收尾加入顶栏导航与书刊页）。
check("V 侧栏与关于弹窗角标已升版", HTML.count(f"v{VERSION} · 顶栏导航与书刊页") == 2)
check("V release notes 文件存在", NOTES.is_file())
check("V Update Log 有 v0.9.73 段", f"# VaultHub 蜀鼠之家 v{VERSION}" in UPDATELOG)
check("V 历史版本号仍钉在历史注释里",
      "v0.9.72：歌词层" in HTML and "let audioMetadataMemory = null; // v0.9.72" in MEDIA)

failed = [(n, d) for n, ok, d in checks if not ok]
for name, ok, detail in checks:
    print(("PASS: " if ok else "FAIL: ") + name + (f"  [{detail}]" if detail and not ok else ""))
print(f"\nSUMMARY {len(checks) - len(failed)}/{len(checks)} PASS")
if failed:
    raise SystemExit("FAIL: v0.9.73 契约测试未通过")
print("PASS: v0.9.73 契约（提示遮挡 / 播放列表 / 历史阅读释放 / 三层主题）全部满足")
