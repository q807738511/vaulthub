#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v1.0.12 契约测试：界面规格 = 主题轴 / 三种壁纸 / 播放器皮肤 / 三份详解文档 / ESC 返回。

覆盖七组：
  1. 移除项：调色板、强调色、自定义背景（代码、DOM、CSS、localStorage 清理）；
  2. 规格主题：SPEC_THEMES 三套 × 亮暗两套 × 23 令牌，CSS 3×2 组合，玻璃参数；
  3. 壁纸层：Aerial / 海报拼贴 / UltraBlur 三种做法与取色函数；
  4. 播放器：Emby 中央大播放键、三套图标包覆盖播放器图标、按规格的进度条/材质；
  5. 文档：三份 md 进仓库、进镜像、面板可打开；
  6. ESC 返回：goBack 处理媒体详情 / 分集详情 / 播放器最小化态；
  7. 版本纪律 + 禁用字面量（内网地址 / 容器卷路径不得进源码）。
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HTML = (ROOT / "index.html").read_text(encoding="utf-8")
STATE = (ROOT / "web/js/01-state.js").read_text(encoding="utf-8")
THEME = (ROOT / "web/js/06-theme.js").read_text(encoding="utf-8")
MEDIA = (ROOT / "web/js/02-media.js").read_text(encoding="utf-8")
FOCUS = (ROOT / "web/js/08-focus.js").read_text(encoding="utf-8")
TOPBAR = (ROOT / "web/js/07-topnav.js").read_text(encoding="utf-8")
CSS = (ROOT / "web/css/main.css").read_text(encoding="utf-8")
BOOT = (ROOT / "web/js/04-boot.js").read_text(encoding="utf-8")
DOCKERFILE = (ROOT / "Dockerfile").read_text(encoding="utf-8")
NOTES = ROOT / ".github/RELEASE_NOTES_1.0.6.md"
UPDATELOG = (ROOT / "Update Log.md").read_text(encoding="utf-8")
VERSION = "1.0.12"

checks = []


def check(name, ok, detail=""):
    checks.append((name, bool(ok), detail))


# ---------------- 1. 移除项 ----------------
check("1a 调色板/强调色定义已删除",
      "THEME_PALETTES" not in THEME and "THEME_ACCENTS" not in THEME)
check("1b 三档设置函数已删除",
      "function setThemePalette" not in THEME and "function setThemeAccent" not in THEME
      and "function setCustomBg" not in THEME)
check("1c 自定义背景上传/清除已删除",
      "function uploadBg(" not in STATE and "function clearBg(" not in STATE
      and "function applyBgImage(" not in STATE)
check("1d 旧背景图键被主动清理（否则占满配额）",
      'localStorage.removeItem("dwu_bgimg")' in STATE)
check("1e 旧 settings 字段被删除（palette/accent/customBg）",
      '["palette", "accent", "customBg"].forEach' in STATE)
check("1f 面板不再有调色板/强调色/自定义背景控件",
      'id="themePaletteGrid"' not in HTML and 'id="themeAccentSwatches"' not in HTML
      and 'id="themeCustomBgToggle"' not in HTML and 'id="bgFile"' not in HTML)
check("1g CSS 无 data-palette / data-accent 选择器",
      "data-palette" not in CSS and "data-accent" not in CSS)
check("1h applyTheme 显式摘掉旧属性",
      'root.removeAttribute("data-palette")' in THEME and 'root.removeAttribute("data-accent")' in THEME)
check("1i 外观面板保留规格/模式/明暗/壁纸/动效五项",
      all(k in HTML for k in ['id="opModeSeg"', 'id="uiModeSeg"', 'id="themeModeSeg"',
                              'id="themeWallpaperToggle"', 'id="themeReduceMotion"']))
check("1j 头像菜单不再显示调色板名",
      "themePaletteDef" not in TOPBAR and "OP_MODE_LABEL[currentOpMode()]" in TOPBAR)

# ---------------- 2. 规格主题 ----------------
check("2a SPEC_THEMES 三套规格齐全",
      all(f'  {sid}: {{' in THEME for sid in ["apple", "emby", "plex"]))
check("2b 每套规格亮暗两套令牌", THEME.count("tokens: {") == 3
      and THEME.count("dark: {") >= 3 and THEME.count("light: {") >= 3)
TOKENS = ["bg", "bg2", "card", "card2", "border", "border2", "track", "text", "text2", "text3",
          "accent", "accentInk", "accentDim", "accentRing", "accentGlow",
          "radius", "radiusSm", "radiusLg", "shadow", "shadowLg", "fontHead", "dur", "ease"]
missing_tokens = []
for sid in ["apple", "emby", "plex"]:
    seg = THEME.split(f'  {sid}: {{', 1)[1].split("\n  }", 1)[0]
    for tok in TOKENS:
        if f"{tok}:" not in seg:
            missing_tokens.append(f"{sid}.{tok}")
check("2c 三套规格都带齐 23 个令牌", not missing_tokens, ",".join(missing_tokens[:6]))
check("2d CSS 覆盖 3 规格 × 2 明暗",
      all(f'html[data-spec="{s}"][data-mode="{m}"]' in CSS
          for s in ["apple", "emby", "plex"] for m in ["light", "dark"]))
check("2e 规格主色各不相同（Apple 系统蓝 / Emby 品牌绿 / Plex 琥珀金）",
      '"#0A84FF"' in THEME and '"#52B54B"' in THEME and '"#E5A00D"' in THEME)
check("2f 玻璃材质参数进令牌且只有 Apple 非零",
      "--glass-blur: 26px" in CSS and "--glass-blur: 0px" in CSS)
check("2g Apple 材质只挂在覆盖层（顶栏/菜单/弹窗/播放器）",
      'html[data-spec="apple"] .topbar' in CSS and 'html[data-spec="apple"] .modal' in CSS
      and 'html[data-spec="apple"] .audio-player' in CSS
      and "backdrop-filter: blur(var(--glass-blur)) saturate(1.7)" in CSS)
check("2h 切规格会换图标包与播放器皮肤属性",
      'root.setAttribute("data-spec-player", specThemeDef(mode).player)' in THEME
      and "applyOpModeIcons();" in THEME)
check("2i 每套规格动效节奏不同（240/150/140）",
      all(v in CSS for v in ["--dur: 240ms", "--dur: 150ms", "--dur: 140ms"]))

# ---------------- 3. 壁纸层 ----------------
check("3a 壁纸层容器与固定定位", 'class="vh-wall"' in HTML and ".vh-wall { position: fixed" in CSS)
check("3b 关壁纸时整层隐藏", 'html[data-wallpaper="off"] .vh-wall { display: none; }' in CSS)
check("3c 壁纸存在时 body 让出底色（否则盖住 -1 层）",
      'html:not([data-wallpaper="off"]) body { background: transparent; }' in CSS)
check("3d Apple Aerial 层 + 漂移动画",
      'html[data-wallpaper="aerial"] .vh-wall::before' in CSS and "@keyframes vhAerial" in CSS)
check("3e Emby 海报拼贴层", ".vh-wall-collage {" in CSS and "grid-template-columns: repeat(6, 1fr)" in CSS)
check("3f Plex UltraBlur 四角色渐变", ".vh-wall-ub {" in CSS and "var(--ub-tl" in CSS)
check("3g 壁纸种类跟着规格走",
      'var WALLPAPER = { apple: "aerial", emby: "collage", plex: "ultrablur" };' in HTML
      and 'root.setAttribute("data-wallpaper", on ? def.wallpaper : "off")' in THEME)
check("3h UltraBlur 从海报四角取色（8×8 canvas）",
      "function vhUltraBlurFromImg(" in THEME and "canvas.width = 8" in THEME
      and 'setProperty("--ub-tl"' in THEME)
check("3i 取色缓存避免每次焦点都读像素", "vhUbCache" in THEME)
check("3j 拼贴取样只取当前列表的海报",
      "function vhCollageSources(" in THEME and ".media-poster-art img" in THEME)
check("3k 壁纸开关落 settings 且有 toast",
      "function setSpecWallpaper(on)" in THEME and "settings.wallpaper = !!on" in THEME)
check("3l 首帧就落壁纸属性（防闪）", "root.dataset.wallpaper = s.wallpaper === false" in HTML)

# ---------------- 4. 播放器 ----------------
check("4a Emby 中央大播放键存在且在 OSD 内",
      'class="vc-center-play' in MEDIA and 'data-video-center-play' in MEDIA)
check("4b 中央键只在 Emby 规格显示",
      "html[data-spec=\"emby\"] .vc-center-play { display: grid; }" in CSS)
check("4c 中央键与底栏播放键同源同步（图标/标题/播放态）",
      'root.querySelector("[data-video-center-play]")' in MEDIA
      and "videoPlayPauseIcon(video.paused)" in MEDIA
      and 'center.classList.toggle("is-playing", !video.paused)' in MEDIA)
PLAYER_ICONS = ["play", "pause", "prev", "next", "back10", "fwd10", "playlist", "subtitles",
                "close", "fullscreen", "collapse", "restore", "disc", "info", "details", "copy"]
icon_gap = []
ICON_PACK = THEME.split("const OP_ICON_PACK = {", 1)[1]   # 图标包在 SPEC_THEMES 之后，必须从这里切
for sid in ["apple", "emby", "plex"]:
    seg = ICON_PACK.split(f'  {sid}: {{', 1)[1].split("\n  },", 1)[0]
    for icon in PLAYER_ICONS:
        if f"{icon}:" not in seg:
            icon_gap.append(f"{sid}.{icon}")
check("4d 三套图标包覆盖播放器 16 个图标", not icon_gap, ",".join(icon_gap[:6]))
check("4e 播放器取图标走规格包", 'opModeIcon(name) : ""' in MEDIA
      and "const body = (typeof opModeIcon === \"function\" ? opModeIcon(name) : \"\") || VIDEO_ICON_SVG[name];" in MEDIA)
check("4f Plex 琥珀进度条", 'html[data-spec="plex"] .video-played-range' in CSS)
check("4g Apple 层叠玻璃迷你播放器", 'html[data-spec="apple"] .audio-player {' in CSS
      and "border-radius: 26px" in CSS)
check("4h Emby 遥控友好图标按钮 40px", 'html[data-spec="emby"] .vc-icon' in CSS and "min-width: 40px" in CSS)

# ---------------- 5. 三份文档 ----------------
for sid in ["apple", "emby", "plex"]:
    doc = ROOT / f"docs/specs/{sid}.md"
    check(f"5{sid[:1]} 文档存在且非空：docs/specs/{sid}.md", doc.is_file() and doc.stat().st_size > 4000)
check("5d 主题定义里 doc 指向 /docs/specs/<spec>.md",
      all(f'doc: "/docs/specs/{s}.md"' in THEME for s in ["apple", "emby", "plex"]))
check("5e 镜像内发布文档", "COPY docs/specs /srv/docs/specs" in DOCKERFILE)
check("5f 面板可打开规格详解弹窗",
      'id="specDocModal"' in HTML and "function openSpecDoc(" in THEME
      and 'id="opModeHighlights"' in HTML)
check("5g 每套规格 4 条元素清单（三语言）",
      THEME.count('"zh-CN"') > 30 and "SPEC_HIGHLIGHTS" in THEME
      and THEME.count('en: "') > 10)
check("5h 清单与文档要素对应（Aerial/拼贴/UltraBlur 都在清单里）",
      "Aerial 航拍壁纸" in THEME and "海报拼贴背景" in THEME and "UltraBlur 取色壁纸" in THEME)

# ---------------- 6. ESC 返回 ----------------
check("6a goBack 处理媒体阅读器/详情层",
      'var overlay = document.querySelector(".media-reader-overlay");' in FOCUS)
check("6b 先退播放器再退详情",
      "closeVideoPlayer(videoBody.querySelector" in FOCUS)
check("6c 分集详情优先于整体关闭",
      "seriesEpisodeReturn" in FOCUS and "closeEpisodeDetail()" in FOCUS)
check("6d 其余走 closeLocalViewer(group)",
      'var group = host ? host.id.replace("local-media-viewer-", "") : "movie";' in FOCUS
      and "closeLocalViewer(group);" in FOCUS)
check("6e 返回键仍覆盖弹窗/浮层/设置页",
      'document.querySelectorAll(".modal-mask.show")' in FOCUS
      and 'document.querySelector(".tn-pop.open")' in FOCUS
      and "closeSettingsPage();" in FOCUS)
check("6f 详情层判定在设置页之前（层级顺序正确）",
      FOCUS.index('.media-reader-overlay') < FOCUS.index('var settings = document.getElementById("view-settings")'))

# ---------------- 7. 版本纪律 ----------------
check("7a 入口页资源版本", f'window.VAULTHUB_ASSET_VERSION = "{VERSION}";' in HTML)
check("7b 脚本自校验版本", f'const VAULTHUB_SCRIPT_VERSION = "{VERSION}";' in STATE)
check("7c 静态资源查询串 ≥12 处", HTML.count(f"?v={VERSION}") >= 12, str(HTML.count(f"?v={VERSION}")))
check("7d 三处标语同步", HTML.count(f"v{VERSION} · ") >= 3)
check("7e 安装/升级脚本版本", all(f'VERSION="v{VERSION}"' in (ROOT / f"scripts/{n}").read_text(encoding="utf-8")
                              for n in ["install.sh", "upgrade.sh"]))
check("7f 字幕 UA 版本", f"VaultHub-Subtitle/{VERSION}" in (ROOT / "subtitle-api/main.go").read_text(encoding="utf-8"))
check("7g Release Notes 存在", NOTES.is_file() and NOTES.stat().st_size > 4000)
check("7h Update Log 顶部是当前版本", UPDATELOG.startswith(f"# VaultHub 蜀鼠之家 v{VERSION}"))
check("7i boot 走 initTheme", "if (typeof initTheme === \"function\") initTheme();" in BOOT)
check("7j 12 个脚本仍按顺序加载 06-theme 在 04-boot 之前",
      HTML.index("/web/js/06-theme.js") < HTML.index("/web/js/04-boot.js"))

# ---------------- 8. 字幕接口鉴权（既有缺陷，本版补齐） ----------------
SUBAPI = (ROOT / "subtitle-api/main.go").read_text(encoding="utf-8")
check("8a 字幕服务有会话探针（向媒体 API 验 401）",
      "func sessionOK(r *http.Request) bool" in SUBAPI
      and "/api/media/files?id=__vh_auth_probe__" in SUBAPI
      and "res.StatusCode != http.StatusUnauthorized" in SUBAPI)
check("8b search 先过鉴权门",
      SUBAPI.index("if !sessionOK(r)") < SUBAPI.index("id := r.URL.Query().Get(\"id\")"))
check("8c download 先过鉴权门",
      "func download(w http.ResponseWriter, r *http.Request) {\n\tif !sessionOK(r) {" in SUBAPI)
check("8d 探针失败放行（媒体 API 挂掉不拖死字幕服务）",
      "auth probe unavailable" in SUBAPI)

# ---------------- 9. 禁用字面量 ----------------
FORBIDDEN = [r"enged\.top", r"192\.168\.", r"/vol[1-4]"]
sources = [HTML, STATE, THEME, MEDIA, FOCUS, CSS, TOPBAR, BOOT,
           (ROOT / "web/js/05-home.js").read_text(encoding="utf-8"),
           (ROOT / "web/js/03-features.js").read_text(encoding="utf-8")]
hits = []
for idx, src in enumerate(sources):
    for pat in FORBIDDEN:
        if re.search(pat, src):
            hits.append(f"src{idx}:{pat}")
check("9a 源码无内网地址/容器卷路径", not hits, ",".join(hits))

failed = [(n, d) for n, ok, d in checks if not ok]
for name, ok, detail in checks:
    print(("PASS: " if ok else "FAIL: ") + name + (f"  [{detail}]" if detail and not ok else ""))
print(f"\nSUMMARY {len(checks) - len(failed)}/{len(checks)} PASS")
if failed:
    raise SystemExit("FAIL: v1.0.12 契约测试未通过")
print("PASS: v1.0.12 契约（规格主题 / 三种壁纸 / 播放器皮肤 / 三份文档 / ESC 返回）全部满足")
