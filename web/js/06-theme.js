/* VaultHub v1.0.6 — 主题引擎（界面规格 × 明暗）
   v0.9.73 的三层模型是「调色板 × 明暗 × 强调色」，v1.0.6 按客户口径收敛成两层：

       主题 = 界面规格(spec) × 明暗(mode)
               Apple / Emby / Plex      暗 / 亮 / 跟随系统

   调色板、强调色、自定义背景图片三档设置已整体移除 —— 它们和「界面规格」在
   语义上重复（规格本来就该自带配色与观感），同时选会互相打架。现在每套规格
   自带完整的**主题定义**（配色 / 圆角 / 动效 / 标题字族 / 壁纸 / 播放器皮肤 /
   图标包），切换规格 = 换整套主题，不存在「规格是 Plex 但配色是青瓷」这种拼接。

   三份《界面规格之 … 影音播放器界面元素详解》的要素落点（docs/specs/*.md）：
     Apple —— Liquid Glass 半透明材质、Aerial 航拍壁纸、SF Symbols 细描边图标、
              同心圆角、层叠式迷你播放器、播放时控件让位内容；
     Emby  —— 品牌绿锁定、图片槽位（Primary/Backdrop/Logo/Thumb/Disc）、
              启用背景图后海报拼贴、Spotlight 大图、OSD 中央大播放键、海报角标；
     Plex  —— chevron 符号、#E5A00D 金、UltraBlur 取色壁纸（从海报四角算色）、
              跳过片头/片尾按钮、进度条缩略图、暗色骨架。

   本文件只做四件事：把选择落到 <html> 的 data-* 上、渲染面板、驱动壁纸层、
   跟随系统明暗。持久化仍在 settings（dwu_settings）里。 */

/* ==================== v1.0.4 操作模式（自动 / Phone / TV / PC） ====================
   它换的是**交互** —— 布局密度、鼠标/遥控/键盘规则、焦点表现。
     auto  —— 按视口宽度 + 指针类型 + UA 自动识别；
     phone —— 更大点击目标、收起次要列、单列为主；
     pc    —— 默认密度，鼠标 hover 优先；
     tv    —— 大字号/大行高、遥控方向键空间导航、焦点环常显（见 web/js/08-focus.js）。
   固化：手动选定后写 localStorage + cookie（vh_mode）双份。localStorage 在媒体库很大时
   可能被写满（配额错误），旧实现把它静默吞掉，于是「切完一刷新就回到默认」；
   cookie 只有几十字节，一定能写进去，刷新时由 <head> 的首帧脚本与 loadSettings() 兜底。 */
const UI_MODES = ["auto", "phone", "tv", "pc"];
const UI_MODE_LABEL = {
  auto: { "zh-CN": "自动", "zh-TW": "自動", en: "Auto" },
  phone: { "zh-CN": "Phone", "zh-TW": "Phone", en: "Phone" },
  tv: { "zh-CN": "TV", "zh-TW": "TV", en: "TV" },
  pc: { "zh-CN": "PC", "zh-TW": "PC", en: "PC" }
};
/* 操作模式卡：图标 + 一行效果说明（选中依据，不是说明段落）。 */
const UI_MODE_ICON = { auto: "🖥", phone: "📱", tv: "📺", pc: "💻" };
const UI_MODE_TAG = {
  auto: { "zh-CN": "按设备识别", "zh-TW": "按裝置識別", en: "Detect device" },
  phone: { "zh-CN": "大点击目标 · 单列", "zh-TW": "大點擊目標 · 單列", en: "Big targets · 1 col" },
  tv: { "zh-CN": "遥控焦点 · 大字号", "zh-TW": "遙控焦點 · 大字號", en: "Remote focus · large" },
  pc: { "zh-CN": "鼠标优先 · 高密度", "zh-TW": "滑鼠優先 · 高密度", en: "Pointer · dense" }
};
function detectUIMode() {
  const w = window.innerWidth || 1024;
  let coarse = false;
  try { coarse = window.matchMedia("(pointer: coarse)").matches; } catch (e) {}
  if (w <= 700) return "phone";
  if (coarse && w >= 1200) return "tv";
  if (typeof navigator !== "undefined" && /TV|SmartTV|AppleTV/i.test(navigator.userAgent || "")) return "tv";
  return "pc";
}
function uiModeChoice() { return UI_MODES.includes(settings.uiMode) ? settings.uiMode : "auto"; }
function resolvedUIMode() {
  const choice = uiModeChoice();
  return choice !== "auto" ? choice : detectUIMode();
}
function applyUIMode() {
  const mode = resolvedUIMode();
  const root = document.documentElement;
  root.setAttribute("data-uimode", mode);
  /* 选择值（可能是 auto）与生效值分开落属性：面板要能显示「自动 → TV」。 */
  root.setAttribute("data-uimode-choice", uiModeChoice());
  return mode;
}
function setUIMode(mode, opts) {
  settings.uiMode = UI_MODES.includes(String(mode)) ? String(mode) : "auto";
  saveSettings();
  const applied = applyUIMode();
  try { themeTransitionPulse(); } catch (e) {}
  try { syncThemeControls(); } catch (e) {}
  /* 遥控/键盘切换时把焦点留在刚点的卡片上 —— 面板重排后焦点掉回 body
     是遥控器最典型的「按一下就没反应」故障。 */
  if (!opts || opts.keepFocus !== false) {
    try {
      const card = document.querySelector(`#uiModeSeg [data-ui-opt="${settings.uiMode}"]`);
      if (card && typeof card.focus === "function") card.focus({ preventScroll: true });
    } catch (e) {}
  }
  toast("🧭 " + t("opModeSaved") + "：" + themeLabel(UI_MODE_LABEL[settings.uiMode]) + (settings.uiMode === "auto" ? "（" + themeLabel(UI_MODE_LABEL[applied]) + "）" : ""));
}

/* ==================== v1.0.6 界面规格（Apple / Emby / Plex） ====================
   v1.0.2 起这套档位叫「操作模式」，v1.0.4 改名「界面规格」：它换的是**长相**。
   v1.0.6 起它同时是**唯一的主题轴** —— 每套规格带一整套主题定义：
     tokens    配色 / 圆角 / 阴影 / 标题字族 / 动效节奏（落 <html data-spec data-mode>）
     wallpaper 壁纸：Apple=Aerial 航拍层，Emby=海报拼贴，Plex=UltraBlur 取色
     player    播放器皮肤：Apple=层叠玻璃迷你条，Emby=OSD 中央大播放键，Plex=琥珀进度 + 跳片头
     icons     图标包（OP_ICON_PACK，顶栏与播放器共用）
     doc       对应的《界面元素详解》文档（docs/specs/*.md，面板里可打开）
   说明：图标是按各客户端的视觉语言手写的，不使用对方私有素材，避免授权问题。 */
const OP_MODES = ["apple", "emby", "plex"];
const OP_MODE_LABEL = {
  apple: { "zh-CN": "Apple", "zh-TW": "Apple", en: "Apple" },
  emby: { "zh-CN": "Emby", "zh-TW": "Emby", en: "Emby" },
  plex: { "zh-CN": "Plex", "zh-TW": "Plex", en: "Plex" }
};
/* 规格卡上的副标题：一句话说清这一档换了什么（不是说明段落，是选中依据）。 */
const OP_MODE_TAG = {
  apple: { "zh-CN": "液态玻璃 · 航拍壁纸", "zh-TW": "液態玻璃 · 航拍壁紙", en: "Liquid Glass · Aerial" },
  emby: { "zh-CN": "品牌绿 · 海报拼贴", "zh-TW": "品牌綠 · 海報拼貼", en: "Brand green · Collage" },
  plex: { "zh-CN": "琥珀金 · 取色背景", "zh-TW": "琥珀金 · 取色背景", en: "Amber · UltraBlur" }
};
/* 规格自带的品牌标记（抽象几何，不用对方 logo 素材）。 */
const OP_MODE_MARK = {
  apple: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.6" y="3.6" width="16.8" height="16.8" rx="5.2" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M9.4 8.6 15.8 12l-6.4 3.4Z" fill="currentColor"/></svg>',
  emby: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="3.2" fill="currentColor" opacity=".18"/><path d="M8.4 6.4 17.6 12l-9.2 5.6Z" fill="currentColor"/></svg>',
  plex: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h5.4l6.2 8-6.2 8H4l6.2-8Z" fill="currentColor"/><path d="M13.2 4H18l2.6 4-2.6 4h-4.8l2.6-4Z" fill="currentColor" opacity=".55"/></svg>'
};

/* ---------- 每套规格的主题定义 ----------
   令牌名与 CSS 一一对应（web/css/main.css 的「v1.0.6 规格主题令牌」段）。
   圆角三档遵循各自的规范：Apple 同心大圆角、Emby Material 8/4/12、
   Plex 扁平 6/3/10；动效节奏也进令牌，所以切规格连手感一起换。 */
const SPEC_THEMES = {
  apple: {
    doc: "/docs/specs/apple.md",
    wallpaper: "aerial",
    player: "glass",
    tokens: {
      dark: {
        bg: "#0A0A0C", bg2: "rgba(28,28,30,.72)", card: "#141416", card2: "#1C1C1F",
        border: "rgba(255,255,255,.10)", border2: "rgba(255,255,255,.20)", track: "rgba(255,255,255,.12)",
        text: "#F5F5F7", text2: "#B9B9C0", text3: "#86868B",
        accent: "#0A84FF", accentInk: "#FFFFFF",
        accentDim: "rgba(10,132,255,.16)", accentRing: "rgba(10,132,255,.38)", accentGlow: "rgba(10,132,255,.45)",
        radius: "16px", radiusSm: "10px", radiusLg: "22px",
        shadow: "0 1px 2px rgba(0,0,0,.55)",
        shadowLg: "0 2px 6px rgba(0,0,0,.45), 0 24px 60px rgba(0,0,0,.60)",
        fontHead: 'inherit', dur: "240ms", ease: "cubic-bezier(.32,.72,0,1)"
      },
      light: {
        bg: "#F2F2F7", bg2: "rgba(255,255,255,.76)", card: "#FFFFFF", card2: "#F2F2F7",
        border: "rgba(0,0,0,.10)", border2: "rgba(0,0,0,.18)", track: "rgba(0,0,0,.10)",
        text: "#1D1D1F", text2: "#4A4A4F", text3: "#6E6E73",
        accent: "#007AFF", accentInk: "#FFFFFF",
        accentDim: "rgba(0,122,255,.12)", accentRing: "rgba(0,122,255,.30)", accentGlow: "rgba(0,122,255,.32)",
        radius: "16px", radiusSm: "10px", radiusLg: "22px",
        shadow: "0 1px 2px rgba(16,24,40,.06)",
        shadowLg: "0 2px 6px rgba(16,24,40,.07), 0 18px 44px rgba(16,24,40,.10)",
        fontHead: 'inherit', dur: "240ms", ease: "cubic-bezier(.32,.72,0,1)"
      }
    }
  },
  emby: {
    doc: "/docs/specs/emby.md",
    wallpaper: "collage",
    player: "osd",
    tokens: {
      dark: {
        bg: "#0F1418", bg2: "#161C21", card: "#171E24", card2: "#1E262D",
        border: "rgba(255,255,255,.08)", border2: "rgba(255,255,255,.16)", track: "rgba(255,255,255,.10)",
        text: "#E6EDF3", text2: "#A9B6C0", text3: "#7C8B96",
        /* 品牌绿是 Emby 的商标色：主题可换，这抹绿不动。 */
        accent: "#52B54B", accentInk: "#04140A",
        accentDim: "rgba(82,181,75,.16)", accentRing: "rgba(82,181,75,.34)", accentGlow: "rgba(82,181,75,.40)",
        radius: "8px", radiusSm: "4px", radiusLg: "12px",
        shadow: "0 1px 2px rgba(0,0,0,.45)",
        shadowLg: "0 1px 2px rgba(0,0,0,.45), 0 14px 36px rgba(0,0,0,.50)",
        fontHead: 'inherit', dur: "150ms", ease: "cubic-bezier(.4,0,.2,1)"
      },
      light: {
        bg: "#F3F5F7", bg2: "#FFFFFF", card: "#FFFFFF", card2: "#EDF1F4",
        border: "rgba(16,24,32,.10)", border2: "rgba(16,24,32,.20)", track: "rgba(16,24,32,.10)",
        text: "#1B242B", text2: "#46525B", text3: "#6B7883",
        accent: "#3E9E3A", accentInk: "#FFFFFF",
        accentDim: "rgba(62,158,58,.12)", accentRing: "rgba(62,158,58,.30)", accentGlow: "rgba(62,158,58,.32)",
        radius: "8px", radiusSm: "4px", radiusLg: "12px",
        shadow: "0 1px 2px rgba(16,24,32,.06)",
        shadowLg: "0 1px 2px rgba(16,24,32,.06), 0 10px 26px rgba(16,24,32,.09)",
        fontHead: 'inherit', dur: "150ms", ease: "cubic-bezier(.4,0,.2,1)"
      }
    }
  },
  plex: {
    doc: "/docs/specs/plex.md",
    wallpaper: "ultrablur",
    player: "plex",
    tokens: {
      dark: {
        bg: "#0B0B0C", bg2: "#171719", card: "#1A1A1C", card2: "#232326",
        border: "rgba(255,255,255,.09)", border2: "rgba(255,255,255,.18)", track: "rgba(255,255,255,.12)",
        text: "#F2F2F2", text2: "#B9B9BD", text3: "#8A8A90",
        accent: "#E5A00D", accentInk: "#1A1200",
        accentDim: "rgba(229,160,13,.16)", accentRing: "rgba(229,160,13,.34)", accentGlow: "rgba(229,160,13,.42)",
        radius: "6px", radiusSm: "3px", radiusLg: "10px",
        shadow: "0 1px 2px rgba(0,0,0,.50)",
        shadowLg: "0 2px 6px rgba(0,0,0,.55), 0 22px 48px rgba(0,0,0,.65)",
        fontHead: 'inherit', dur: "140ms", ease: "cubic-bezier(.2,0,0,1)"
      },
      light: {
        bg: "#F5F5F6", bg2: "#FFFFFF", card: "#FFFFFF", card2: "#EFEFF1",
        border: "rgba(20,20,22,.10)", border2: "rgba(20,20,22,.20)", track: "rgba(20,20,22,.10)",
        text: "#141416", text2: "#45454A", text3: "#6C6C72",
        accent: "#B87A00", accentInk: "#FFFFFF",
        accentDim: "rgba(184,122,0,.12)", accentRing: "rgba(184,122,0,.28)", accentGlow: "rgba(184,122,0,.30)",
        radius: "6px", radiusSm: "3px", radiusLg: "10px",
        shadow: "0 1px 2px rgba(20,20,22,.07)",
        shadowLg: "0 2px 6px rgba(20,20,22,.10), 0 16px 34px rgba(20,20,22,.14)",
        fontHead: 'inherit', dur: "140ms", ease: "cubic-bezier(.2,0,0,1)"
      }
    }
  }
};
/* 面板里的「这套规格带什么」：四行元素清单，来自三份详解文档的对应章节。 */
const SPEC_HIGHLIGHTS = {
  apple: [
    { "zh-CN": "Liquid Glass 半透明材质（顶栏/面板/播放器）", "zh-TW": "Liquid Glass 半透明材質（頂欄/面板/播放器）", en: "Liquid Glass materials" },
    { "zh-CN": "Aerial 航拍壁纸 · 缓慢漂移", "zh-TW": "Aerial 航拍壁紙 · 緩慢漂移", en: "Aerial wallpaper, slow drift" },
    { "zh-CN": "SF Symbols 细描边图标 · 同心圆角", "zh-TW": "SF Symbols 細描邊圖示 · 同心圓角", en: "SF Symbols icons, concentric radii" },
    { "zh-CN": "层叠式迷你播放器 · 控件让位内容", "zh-TW": "層疊式迷你播放器 · 控件讓位內容", en: "Layered mini player" }
  ],
  emby: [
    { "zh-CN": "品牌绿锁定（不随主题变化）", "zh-TW": "品牌綠鎖定（不隨主題變化）", en: "Locked brand green" },
    { "zh-CN": "海报拼贴背景（启用背景图才出现）", "zh-TW": "海報拼貼背景（啟用背景圖才出現）", en: "Poster-collage backdrop" },
    { "zh-CN": "图片槽位 Primary/Backdrop/Logo/Thumb/Disc", "zh-TW": "圖片槽位 Primary/Backdrop/Logo/Thumb/Disc", en: "Image slots" },
    { "zh-CN": "OSD 中央大播放键 · 海报角标", "zh-TW": "OSD 中央大播放鍵 · 海報角標", en: "Center OSD button, poster badges" }
  ],
  plex: [
    { "zh-CN": "chevron 符号 · #E5A00D 琥珀金", "zh-TW": "chevron 符號 · #E5A00D 琥珀金", en: "Chevron + amber #E5A00D" },
    { "zh-CN": "UltraBlur 取色壁纸（从海报四角算色）", "zh-TW": "UltraBlur 取色壁紙（從海報四角算色）", en: "UltraBlur colour extraction" },
    { "zh-CN": "跳过片头/片尾 · 进度条缩略图", "zh-TW": "跳過片頭/片尾 · 進度條縮圖", en: "Skip intro/credits, thumbnails" },
    { "zh-CN": "暗色骨架 · 海报 1:1.5", "zh-TW": "暗色骨架 · 海報 1:1.5", en: "Dark skeleton, 1:1.5 posters" }
  ]
};

/* 三套图标包：同一批语义图标，按规格各自的描边/填充语言重画。
   v1.0.6 起把**播放器**用到的图标也补齐（快退快进/播放列表/字幕/关闭/全屏/
   收起/原盘），否则切规格只有顶栏变、播放器还是默认图标。 */
const OP_ICON_PACK = {
  apple: {
    home: '<path d="M4.4 11.4 12 5l7.6 6.4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><path d="M6.6 10.3v8.3a1.1 1.1 0 0 0 1.1 1.1h2.8v-4.4h3v4.4h2.8a1.1 1.1 0 0 0 1.1-1.1v-8.3" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>',
    pt: '<path d="M3.6 9.2c1.7-1.5 3.4-1.5 5.1 0s3.4 1.5 5.1 0 3.4-1.5 5.1 0M3.6 14.6c1.7-1.5 3.4-1.5 5.1 0s3.4 1.5 5.1 0 3.4-1.5 5.1 0" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
    play: '<path d="M8.8 6.1 18.9 12 8.8 17.9Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>',
    pause: '<path d="M9.4 5.7v12.6M14.6 5.7v12.6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
    prev: '<path d="M6.2 5.8v12.4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><path d="M18.4 6.6 10.6 12l7.8 5.4Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>',
    next: '<path d="M17.8 5.8v12.4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><path d="M5.6 6.6 13.4 12l-7.8 5.4Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>',
    heart: '<path d="M20.6 5.1a5.1 5.1 0 0 0-7.2 0L12 6.5l-1.4-1.4a5.1 5.1 0 0 0-7.2 7.2L12 21l8.6-8.7a5.1 5.1 0 0 0 0-7.2Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>',
    heartFill: '<path d="M20.6 5.1a5.1 5.1 0 0 0-7.2 0L12 6.5l-1.4-1.4a5.1 5.1 0 0 0-7.2 7.2L12 21l8.6-8.7a5.1 5.1 0 0 0 0-7.2Z" fill="currentColor" stroke="none"/>',
    search: '<circle cx="10.8" cy="10.8" r="6.4" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="m15.5 15.5 4.7 4.7" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
    bell: '<path d="M12 4.2a5.6 5.6 0 0 0-5.6 5.6c0 4.2-1.4 5.6-1.4 5.6h14s-1.4-1.4-1.4-5.6A5.6 5.6 0 0 0 12 4.2Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M10.2 18.4a1.9 1.9 0 0 0 3.6 0" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
    settings: '<circle cx="12" cy="12" r="3.1" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M12 3.6v2.2M12 18.2v2.2M20.4 12h-2.2M5.8 12H3.6M17.9 6.1l-1.6 1.6M7.7 16.3l-1.6 1.6M17.9 17.9l-1.6-1.6M7.7 7.7 6.1 6.1" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
    palette: '<circle cx="12" cy="12" r="8.4" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="9" cy="9.4" r="1.3" fill="currentColor"/><circle cx="15" cy="9.4" r="1.3" fill="currentColor"/><circle cx="9" cy="15" r="1.3" fill="currentColor"/>',
    star: '<path d="m12 4.6 2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.6-4.8 2.6.9-5.4L4.2 10.3l5.4-.8Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>',
    user: '<circle cx="12" cy="8.4" r="3.9" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M4.8 20.2c0-3.4 3.2-5.4 7.2-5.4s7.2 2 7.2 5.4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
    logout: '<path d="M14.4 5.6H6.6a1.4 1.4 0 0 0-1.4 1.4v10a1.4 1.4 0 0 0 1.4 1.4h7.8" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><path d="M15.6 12h5.2m-2.6-2.6L20.8 12l-2.6 2.6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>',
    movie: '<rect x="3.6" y="5.4" width="16.8" height="13.2" rx="2.6" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M8.2 5.4v13.2M15.8 5.4v13.2M3.6 12h16.8" fill="none" stroke="currentColor" stroke-width="1.4"/>',
    music: '<path d="M9.4 17.4V6.6l8-1.6v10.4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><ellipse cx="7.4" cy="17.8" rx="2.2" ry="1.9" fill="none" stroke="currentColor" stroke-width="1.6"/><ellipse cx="15.4" cy="16.2" rx="2.2" ry="1.9" fill="none" stroke="currentColor" stroke-width="1.6"/>',
    book: '<path d="M5 5.2h5.4A2.6 2.6 0 0 1 13 7.8v11.4a2.2 2.2 0 0 0-2.2-2.2H5Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M19 5.2h-5.4A2.6 2.6 0 0 0 11 7.8v11.4a2.2 2.2 0 0 1 2.2-2.2H19Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>',
    external: '<path d="M13.4 5.4h5.2v5.2" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><path d="m18.2 5.8-7.4 7.4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><path d="M17.6 14v4.4a1.4 1.4 0 0 1-1.4 1.4H6.6a1.4 1.4 0 0 1-1.4-1.4V8.8a1.4 1.4 0 0 1 1.4-1.4h4.2" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
    folder: '<path d="M4 8.2A2.2 2.2 0 0 1 6.2 6h3.4l1.8 2.2h6.4A2.2 2.2 0 0 1 20 10.4v6.4A2.2 2.2 0 0 1 17.8 19H6.2A2.2 2.2 0 0 1 4 16.8Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>',
    more: '<circle cx="6" cy="12" r="1.7" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.7" fill="currentColor" stroke="none"/><circle cx="18" cy="12" r="1.7" fill="currentColor" stroke="none"/>',
    /* 播放器补充图标：SF Symbols 语言 —— 细描边、圆端、圆角连接 */
    back10: '<path d="M4.4 9.6a8 8 0 1 1 1.9 8.6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><path d="M4.2 5.2v4.6h4.6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><text x="12" y="16" text-anchor="middle" font-size="6.4" fill="currentColor" stroke="none" font-family="system-ui,sans-serif">10</text>',
    fwd10: '<path d="M19.6 9.6a8 8 0 1 0-1.9 8.6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><path d="M19.8 5.2v4.6h-4.6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><text x="12" y="16" text-anchor="middle" font-size="6.4" fill="currentColor" stroke="none" font-family="system-ui,sans-serif">10</text>',
    playlist: '<path d="M4 7h10M4 12h10M4 17h6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><path d="M18.4 10.4v6.4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><circle cx="16.6" cy="18" r="1.9" fill="none" stroke="currentColor" stroke-width="1.6"/>',
    subtitles: '<rect x="3.4" y="5.4" width="17.2" height="13.2" rx="3" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M7 11.4h4.4M7 15h7.6M14.2 11.4H17" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
    close: '<path d="m6.6 6.6 10.8 10.8M17.4 6.6 6.6 17.4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
    fullscreen: '<path d="M4.6 9.4V4.6h4.8M19.4 9.4V4.6h-4.8M4.6 14.6v4.8h4.8M19.4 14.6v4.8h-4.8" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>',
    collapse: '<path d="M9.4 4.6v4.8H4.6M14.6 4.6v4.8h4.8M9.4 19.4v-4.8H4.6M14.6 19.4v-4.8h4.8" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>',
    restore: '<path d="M4.6 9.4h4.8V4.6M19.4 9.4h-4.8V4.6M4.6 14.6h4.8v4.8M19.4 14.6h-4.8v4.8" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>',
    disc: '<circle cx="12" cy="12" r="8.6" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="12" cy="12" r="2.4" fill="none" stroke="currentColor" stroke-width="1.6"/>',
    info: '<circle cx="12" cy="12" r="8.6" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M12 10.8v5.4M12 7.9v.2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
    details: '<rect x="3.6" y="4.6" width="16.8" height="14.8" rx="3" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M7 9h6M7 12.4h10M7 15.8h7" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
    copy: '<rect x="8.4" y="8.4" width="11.2" height="11.2" rx="2.6" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M15.6 5.4H6.4a1 1 0 0 0-1 1v9.2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>'
  },
  emby: {
    home: '<path d="M12 3.4 21 11v9.2a1 1 0 0 1-1 1h-5.4v-6h-5.2v6H4a1 1 0 0 1-1-1V11Z" fill="currentColor" stroke="none"/>',
    pt: '<path d="M2.6 8.6c1.9-1.8 3.8-1.8 5.7 0s3.8 1.8 5.7 0 3.8-1.8 5.7 0v2.6c-1.9-1.8-3.8-1.8-5.7 0s-3.8 1.8-5.7 0-3.8-1.8-5.7 0Zm0 5.4c1.9-1.8 3.8-1.8 5.7 0s3.8 1.8 5.7 0 3.8-1.8 5.7 0v2.6c-1.9-1.8-3.8-1.8-5.7 0s-3.8 1.8-5.7 0-3.8-1.8-5.7 0Z" fill="currentColor" stroke="none"/>',
    play: '<path d="M8 5.4 19 12 8 18.6Z" fill="currentColor" stroke="none"/>',
    pause: '<rect x="7" y="5" width="3.7" height="14" fill="currentColor" stroke="none"/><rect x="13.3" y="5" width="3.7" height="14" fill="currentColor" stroke="none"/>',
    prev: '<path d="M5.6 5.4h2.2v13.2H5.6z" fill="currentColor" stroke="none"/><path d="M19 6.2 10 12l9 5.8Z" fill="currentColor" stroke="none"/>',
    next: '<path d="M16.2 5.4h2.2v13.2h-2.2z" fill="currentColor" stroke="none"/><path d="M5 6.2 14 12l-9 5.8Z" fill="currentColor" stroke="none"/>',
    heart: '<path d="M12 20.8 3.7 12.5a5.2 5.2 0 0 1 7.4-7.4l.9.9.9-.9a5.2 5.2 0 0 1 7.4 7.4Z" fill="currentColor" stroke="none"/>',
    heartFill: '<path d="M12 20.8 3.7 12.5a5.2 5.2 0 0 1 7.4-7.4l.9.9.9-.9a5.2 5.2 0 0 1 7.4 7.4Z" fill="currentColor" stroke="none"/>',
    search: '<path d="M10.6 3.6a7 7 0 1 0 4.1 12.7l4.2 4.2 1.5-1.5-4.2-4.2A7 7 0 0 0 10.6 3.6Zm0 2.4a4.6 4.6 0 1 1 0 9.2 4.6 4.6 0 0 1 0-9.2Z" fill="currentColor" stroke="none"/>',
    bell: '<path d="M12 3.2a6.4 6.4 0 0 0-6.4 6.4v5.2L3.6 18h16.8l-2-3.2V9.6A6.4 6.4 0 0 0 12 3.2Zm0 18a2.6 2.6 0 0 0 2.5-2h-5a2.6 2.6 0 0 0 2.5 2Z" fill="currentColor" stroke="none"/>',
    settings: '<path d="M12 8.6a3.4 3.4 0 1 0 0 6.8 3.4 3.4 0 0 0 0-6.8Zm0 5.2a1.8 1.8 0 1 1 0-3.6 1.8 1.8 0 0 1 0 3.6Z" fill="currentColor" stroke="none"/><path d="M19.6 12c0-.5-.1-1-.2-1.4l1.7-1.3-1.4-2.4-2 .8c-.7-.6-1.5-1-2.4-1.3L15 4.2h-2.8l-.3 2.2c-.9.3-1.7.7-2.4 1.3l-2-.8-1.4 2.4 1.7 1.3a7 7 0 0 0 0 2.8L6.1 15l1.4 2.4 2-.8c.7.6 1.5 1 2.4 1.3l.3 2.2H15l.3-2.2c.9-.3 1.7-.7 2.4-1.3l2 .8 1.4-2.4-1.7-1.3c.1-.4.2-.9.2-1.4Z" fill="currentColor" stroke="none" opacity=".55"/>',
    palette: '<path d="M12 3.4a8.6 8.6 0 0 0 0 17.2c1.2 0 1.9-.8 1.9-1.8 0-1.4-1.3-1.6-1.3-2.8 0-.9.8-1.5 1.8-1.5h1.6a5.2 5.2 0 0 0 5.2-5.2c0-3.2-4-5.9-9.2-5.9Zm-4.4 8.2a1.6 1.6 0 1 1 0-3.2 1.6 1.6 0 0 1 0 3.2Zm3.4-3.6a1.6 1.6 0 1 1 0-3.2 1.6 1.6 0 0 1 0 3.2Zm5 0a1.6 1.6 0 1 1 0-3.2 1.6 1.6 0 0 1 0 3.2Z" fill="currentColor" stroke="none"/>',
    star: '<path d="m12 3.6 2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 18.4l-5.8 3.1 1.1-6.5L2.6 10.4l6.5-.9Z" fill="currentColor" stroke="none"/>',
    user: '<circle cx="12" cy="8" r="4.2" fill="currentColor" stroke="none"/><path d="M4 20.4c0-4 3.6-6.4 8-6.4s8 2.4 8 6.4Z" fill="currentColor" stroke="none"/>',
    logout: '<path d="M13.4 4.4H5.8a1.4 1.4 0 0 0-1.4 1.4v12.4a1.4 1.4 0 0 0 1.4 1.4h7.6v-2.2H6.6V6.6h6.8Zm2.6 3-1.6 1.6 2.2 2.2H9.4v2.4h7.2l-2.2 2.2 1.6 1.6 4.6-5Z" fill="currentColor" stroke="none"/>',
    movie: '<path d="M3 5.4h18v13.2H3Zm2.4 2.2v2h2.2v-2Zm4.6 0v2h2.2v-2Zm4.6 0v2H17v-2ZM5.4 11.8v2h2.2v-2Zm4.6 0v2h2.2v-2Zm4.6 0v2H17v-2ZM5.4 16.4v0h13.2v-1.6H5.4Z" fill="currentColor" stroke="none"/>',
    music: '<path d="M19 3.4 9 5.4v9.2a3.4 3.4 0 1 0 2.2 3.2V9.6L19 7.8v5a3.4 3.4 0 1 0 2.2 3.2V3.4Z" fill="currentColor" stroke="none" transform="translate(-1 0)"/>',
    book: '<path d="M11 6.2C9.8 5.2 8 4.6 5.4 4.6v13c2.6 0 4.4.6 5.6 1.6Zm2 0v13c1.2-1 3-1.6 5.6-1.6v-13c-2.6 0-4.4.6-5.6 1.6Z" fill="currentColor" stroke="none"/>',
    external: '<path d="M14 4h6v6h-2.4V8.1l-7 7-1.7-1.7 7-7H14Zm-2 2v2H6.6v9.4H16V12h2v5.4a1.6 1.6 0 0 1-1.6 1.6H6.6A1.6 1.6 0 0 1 5 17.4V7.6A1.6 1.6 0 0 1 6.6 6Z" fill="currentColor" stroke="none"/>',
    folder: '<path d="M3.4 6.6A1.8 1.8 0 0 1 5.2 4.8h4l2 2.2h7.6a1.8 1.8 0 0 1 1.8 1.8v9.4a1.8 1.8 0 0 1-1.8 1.8H5.2a1.8 1.8 0 0 1-1.8-1.8Z" fill="currentColor" stroke="none"/>',
    more: '<circle cx="5.4" cy="12" r="2" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="2" fill="currentColor" stroke="none"/><circle cx="18.6" cy="12" r="2" fill="currentColor" stroke="none"/>',
    /* 播放器补充图标：Material 语言 —— 实心、几何、无描边 */
    back10: '<path d="M12 5.4a7.4 7.4 0 1 1-7.1 9.5h2.5A5 5 0 1 0 12 7.8v2.6L7.6 6.4 12 2.4Z" fill="currentColor" stroke="none"/>',
    fwd10: '<path d="M12 5.4a7.4 7.4 0 1 0 7.1 9.5h-2.5A5 5 0 1 1 12 7.8v2.6l4.4-4-4.4-4Z" fill="currentColor" stroke="none"/>',
    playlist: '<path d="M4 6.2h10.4v2.2H4Zm0 4.6h10.4v2.2H4Zm0 4.6h6.8v2.2H4Zm11.2-1.2h2.2v4.2h-2.2Zm-3.6 3.4a2.6 2.6 0 1 1 5.2 0 2.6 2.6 0 0 1-5.2 0Z" fill="currentColor" stroke="none"/>',
    subtitles: '<path d="M3.2 5.2h17.6v13.6H3.2Zm2.2 2.2v9.2h13.2V7.4Zm1.8 2h4.6v2H7.2Zm6 0h3.6v2h-3.6Zm-6 3.4h3.6v2H7.2Zm5 0h4.6v2h-4.6Z" fill="currentColor" stroke="none"/>',
    close: '<path d="m6.4 5 5.6 5.6L17.6 5 19 6.4 13.4 12 19 17.6 17.6 19 12 13.4 6.4 19 5 17.6 10.6 12 5 6.4Z" fill="currentColor" stroke="none"/>',
    fullscreen: '<path d="M4 4h6.4v2.4H6.4V10H4Zm9.6 0H20v6.4h-2.4V6.4h-4Zm4 9.6H20V20h-6.4v-2.4h4ZM4 13.6h2.4v4h4V20H4Z" fill="currentColor" stroke="none"/>',
    collapse: '<path d="M9.6 4v5.6H4V7.2h3.2V4Zm4.8 0h2.4v3.2H20v2.4h-5.6Zm-10.4 10H7.2v3.2h2.4V20H4Zm11.2 3.2h2.4V14H20v5.6h-4.8Z" fill="currentColor" stroke="none"/>',
    restore: '<path d="M4 9.6V4h5.6v2.4H7.2L11 10.2 9.8 11.4 6.4 8v1.6Zm16 0h-2.4V8l-3.4 3.4L13 10.2l3.8-3.8h-2.4V4H20ZM9.8 12.6 11 13.8 7.2 17.6h2.4V20H4v-5.6h2.4v1.6Z" fill="currentColor" stroke="none"/>',
    disc: '<path d="M12 3.2a8.8 8.8 0 1 0 0 17.6 8.8 8.8 0 0 0 0-17.6Zm0 2.4a6.4 6.4 0 1 1 0 12.8 6.4 6.4 0 0 1 0-12.8Zm0 3.6a2.8 2.8 0 1 0 0 5.6 2.8 2.8 0 0 0 0-5.6Z" fill="currentColor" stroke="none"/>',
    info: '<path d="M12 3.2a8.8 8.8 0 1 0 0 17.6 8.8 8.8 0 0 0 0-17.6Zm1.2 13.2h-2.4v-5.6h2.4Zm0-7.2h-2.4V6.8h2.4Z" fill="currentColor" stroke="none"/>',
    details: '<path d="M3.2 4.4h17.6v15.2H3.2Zm2.4 2.4v2h2.4v-2Zm4.4 0v2h8v-2Zm-4.4 3.6v2h2.4v-2Zm4.4 0v2h8v-2Zm-4.4 3.6v2h2.4v-2Zm4.4 0v2h5.6v-2Z" fill="currentColor" stroke="none"/>',
    copy: '<path d="M8 3.6h9.6v2.4H9.6v9.6H8Zm3.2 3.2H20v13.6h-8.8Zm2.4 2.4v8.8h4V9.2Z" fill="currentColor" stroke="none"/>'
  },
  plex: {
    home: '<path d="M4 10.6 12 4l8 6.6V20h-5.6v-5.8H9.6V20H4Z" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/>',
    pt: '<path d="M3 9.4c1.8-1.6 3.6-1.6 5.4 0s3.6 1.6 5.4 0 3.6-1.6 5.4 0M3 15c1.8-1.6 3.6-1.6 5.4 0s3.6 1.6 5.4 0 3.6-1.6 5.4 0" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="square"/>',
    play: '<path d="M8.6 5.2 19.6 12 8.6 18.8Z" fill="currentColor" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>',
    pause: '<rect x="7" y="5" width="3.9" height="14" rx=".7" fill="currentColor" stroke="none"/><rect x="13.1" y="5" width="3.9" height="14" rx=".7" fill="currentColor" stroke="none"/>',
    prev: '<path d="M5.4 5.2h2.6v13.6H5.4z" fill="currentColor" stroke="none"/><path d="M19.4 5.6 10.2 12l9.2 6.4Z" fill="currentColor" stroke="none"/>',
    next: '<path d="M16 5.2h2.6v13.6H16z" fill="currentColor" stroke="none"/><path d="M4.6 5.6 13.8 12l-9.2 6.4Z" fill="currentColor" stroke="none"/>',
    heart: '<path d="M12 20.8 3.9 12.7a5.4 5.4 0 0 1 7.6-7.6l.5.5.5-.5a5.4 5.4 0 0 1 7.6 7.6Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>',
    heartFill: '<path d="M12 20.8 3.9 12.7a5.4 5.4 0 0 1 7.6-7.6l.5.5.5-.5a5.4 5.4 0 0 1 7.6 7.6Z" fill="currentColor" stroke="none"/>',
    search: '<circle cx="10.8" cy="10.8" r="6.2" fill="none" stroke="currentColor" stroke-width="2.4"/><path d="m15.4 15.4 4.9 4.9" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="square"/>',
    bell: '<path d="M12 3.8a6 6 0 0 0-6 6v5l-1.8 2.6h15.6L18 14.8v-5a6 6 0 0 0-6-6Z" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linejoin="round"/><path d="M9.8 17.8a2.3 2.3 0 0 0 4.4 0" fill="none" stroke="currentColor" stroke-width="2.1"/>',
    settings: '<circle cx="12" cy="12" r="3.4" fill="none" stroke="currentColor" stroke-width="2.1"/><path d="M12 3.4v3M12 17.6v3M20.6 12h-3M6.4 12h-3M18 6l-2.1 2.1M8.1 15.9 6 18M18 18l-2.1-2.1M8.1 8.1 6 6" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="square"/>',
    palette: '<circle cx="12" cy="12" r="8.4" fill="none" stroke="currentColor" stroke-width="2.1"/><path d="M12 3.6v16.8" fill="none" stroke="currentColor" stroke-width="2.1"/>',
    star: '<path d="m12 3.8 2.8 5.8 6.3.9-4.6 4.4 1.1 6.3L12 18.3l-5.6 2.9 1.1-6.3L2.9 10.5l6.3-.9Z" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linejoin="round"/>',
    user: '<circle cx="12" cy="8.2" r="4" fill="none" stroke="currentColor" stroke-width="2.1"/><path d="M4.6 20.4c0-3.6 3.3-5.8 7.4-5.8s7.4 2.2 7.4 5.8" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="square"/>',
    logout: '<path d="M13.6 5h-7v14h7" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="square"/><path d="M15.4 12h5.2m-2.4-2.6L20.8 12l-2.6 2.6" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="square"/>',
    movie: '<rect x="3.4" y="5.2" width="17.2" height="13.6" rx="1.2" fill="none" stroke="currentColor" stroke-width="2.1"/><path d="M8 5.2v13.6M16 5.2v13.6" fill="none" stroke="currentColor" stroke-width="1.8"/>',
    music: '<path d="M9.6 17.6V6.4l8.2-1.6v10.8" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linejoin="round"/><circle cx="7.4" cy="17.8" r="2.2" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="15.6" cy="16.2" r="2.2" fill="none" stroke="currentColor" stroke-width="2"/>',
    book: '<path d="M5 5h5.6A2.4 2.4 0 0 1 13 7.4v11.8a2.2 2.2 0 0 0-2.2-2.2H5Zm14 0h-5.6A2.4 2.4 0 0 0 11 7.4v11.8a2.2 2.2 0 0 1 2.2-2.2H19Z" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linejoin="round"/>',
    external: '<path d="M13.6 5.2h5.2v5.2" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="square"/><path d="m18.4 5.6-7.6 7.6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="square"/><path d="M17.4 13.8v4.4a1.6 1.6 0 0 1-1.6 1.6H6.4a1.6 1.6 0 0 1-1.6-1.6V8.8a1.6 1.6 0 0 1 1.6-1.6h4.4" fill="none" stroke="currentColor" stroke-width="2.2"/>',
    folder: '<path d="M3.8 7A2 2 0 0 1 5.8 5h3.8l2 2.2h6.6A2 2 0 0 1 20.2 9v8a2 2 0 0 1-2 2H5.8a2 2 0 0 1-2-2Z" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linejoin="round"/>',
    more: '<circle cx="5.6" cy="12" r="2" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="2" fill="currentColor" stroke="none"/><circle cx="18.4" cy="12" r="2" fill="currentColor" stroke="none"/>',
    /* 播放器补充图标：Plex 语言 —— 粗描边、方头、chevron 味 */
    back10: '<path d="M4.4 9.6a8 8 0 1 1 1.9 8.6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="square"/><path d="M4 5v4.8h4.8" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="square"/>',
    fwd10: '<path d="M19.6 9.6a8 8 0 1 0-1.9 8.6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="square"/><path d="M20 5v4.8h-4.8" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="square"/>',
    playlist: '<path d="M3.6 7h10.8M3.6 12h10.8M3.6 17h7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="square"/><path d="M18.4 10.6v6.2" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="square"/><circle cx="16.6" cy="18" r="2" fill="none" stroke="currentColor" stroke-width="2"/>',
    subtitles: '<rect x="3.4" y="5.4" width="17.2" height="13.2" rx="1.2" fill="none" stroke="currentColor" stroke-width="2.1"/><path d="M6.8 11.2h4.6M6.8 15h7.4M13.4 11.2h3.8" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="square"/>',
    close: '<path d="m6.6 6.6 10.8 10.8M17.4 6.6 6.6 17.4" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="square"/>',
    fullscreen: '<path d="M4.4 9.4V4.4h5M19.6 9.4V4.4h-5M4.4 14.6v5h5M19.6 14.6v5h-5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="square"/>',
    collapse: '<path d="M9.4 4.4v5h-5M14.6 4.4v5h5M9.4 19.6v-5h-5M14.6 19.6v-5h5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="square"/>',
    restore: '<path d="M4.4 9.4h5v-5M19.6 9.4h-5v-5M4.4 14.6h5v5M19.6 14.6h-5v5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="square"/>',
    disc: '<circle cx="12" cy="12" r="8.4" fill="none" stroke="currentColor" stroke-width="2.1"/><circle cx="12" cy="12" r="2.2" fill="none" stroke="currentColor" stroke-width="2.1"/>',
    info: '<circle cx="12" cy="12" r="8.4" fill="none" stroke="currentColor" stroke-width="2.1"/><path d="M12 10.6v5.6M12 7.8v.1" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="square"/>',
    details: '<rect x="3.4" y="4.6" width="17.2" height="14.8" rx="1.2" fill="none" stroke="currentColor" stroke-width="2.1"/><path d="M6.8 9h6M6.8 12.4h10.4M6.8 15.8h7" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="square"/>',
    copy: '<rect x="8.4" y="8.4" width="11.2" height="11.2" rx="1.2" fill="none" stroke="currentColor" stroke-width="2.1"/><path d="M15.6 5.4H6.4a1 1 0 0 0-1 1v9.2" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="square"/>'
  }
};
function currentOpMode() { return OP_MODES.includes(settings.opMode) ? settings.opMode : "apple"; }
function opModeIcon(name) {
  const pack = OP_ICON_PACK[currentOpMode()];
  return (pack && pack[name]) || "";
}
/* 媒体库标签的图标名：按大类取，外连服务单独一个。 */
const OP_LIB_ICON = { comic: "book", movie: "movie", audio: "music", external: "external" };
/* 顶栏等「静态 HTML 图标」：按 data-op-icon 挂点替换内容。
   v1.0.4（需求3）：媒体库标签也纳入 —— 规格切换后整条顶栏的图标语言一起变。 */
/* 图标包的每一项都是 <svg> 的**内部标记**（path/circle/rect）。
   挂点本身是 <svg> 时直接替换 innerHTML；挂点是 <span>（顶栏文字图标、通知铃铛、
   媒体库标签）时必须自己包一层 <svg>，否则浏览器只会把孤立的 <path> 当成未知节点丢掉
   —— 这正是 v1.0.4 首轮实测「切了规格图标没变」的原因。 */
function opModeIconMarkup(name) {
  const body = opModeIcon(name);
  if (!body) return "";
  return '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">' + body + '</svg>';
}
function applyOpModeIcons() {
  document.querySelectorAll("[data-op-icon]").forEach(el => {
    const isSvg = String(el.tagName || "").toLowerCase() === "svg";
    const body = opModeIcon(el.getAttribute("data-op-icon"));
    if (!body) return;
    const next = isSvg ? body : opModeIconMarkup(el.getAttribute("data-op-icon"));
    if (el.innerHTML !== next) el.innerHTML = next;
  });
  document.querySelectorAll("#topLibTabs .libtab").forEach(tab => {
    const ic = tab.querySelector(".ic");
    if (!ic) return;
    const kind = tab.getAttribute("data-lib-kind") || "";
    const next = opModeIconMarkup(OP_LIB_ICON[kind] || "folder");
    if (next && ic.innerHTML !== next) ic.innerHTML = next;
  });
}
function specThemeDef(id) { return SPEC_THEMES[String(id)] || SPEC_THEMES.apple; }
function applyOpMode() {
  const mode = currentOpMode();
  const root = document.documentElement;
  root.setAttribute("data-opmode", mode);
  /* 新属性名与旧属性同值：语义上 data-spec 才是「界面规格」。 */
  root.setAttribute("data-spec", mode);
  root.setAttribute("data-spec-player", specThemeDef(mode).player);
  applyOpModeIcons();
  return mode;
}
/* 规格切换：配色、壁纸、播放器皮肤、图标、动效一起换，并立刻同步选中态与「当前」说明。 */
function setOpMode(mode) {
  settings.opMode = OP_MODES.includes(String(mode)) ? String(mode) : "apple";
  saveSettings();
  const applied = applyOpMode();
  try { applySpecWallpaper(true); } catch (e) {}
  try { syncThemeControls(); } catch (e) {}
  try { themeTransitionPulse(); } catch (e) {}
  toast("🎛 " + t("uiSpecSaved") + "：" + themeLabel(OP_MODE_LABEL[applied]) + " · " + themeLabel({ "zh-CN": "主题/壁纸/播放器已同步", "zh-TW": "主題/壁紙/播放器已同步", en: "theme, wallpaper, player synced" }));
}
const THEME_MODE_LABEL = {
  dark: { "zh-CN": "暗色", "zh-TW": "暗色", en: "Dark" },
  light: { "zh-CN": "亮色", "zh-TW": "亮色", en: "Light" },
  auto: { "zh-CN": "跟随系统", "zh-TW": "跟隨系統", en: "System" }
};
const THEME_MODES = ["dark", "light", "auto"];

function themeLangKey() { return curLang === "en" ? "en" : curLang === "zh-TW" ? "zh-TW" : "zh-CN"; }
function themeLabel(table) { return table[themeLangKey()] || table["zh-CN"]; }
function systemPrefersDark() {
  try { return !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches); }
  catch (e) { return true; }
}
/* 「明暗」层解析结果：auto 读系统偏好实时决定；返回值只会是 dark / light。 */
function resolvedThemeMode() {
  if (settings.mode === "light") return "light";
  if (settings.mode === "auto") return systemPrefersDark() ? "dark" : "light";
  return "dark";
}

/* ==================== 壁纸层 ====================
   三套规格的壁纸做法完全不同，所以不是一张可替换的图，而是三种「算出来的」背景：
     aerial    Apple 航拍：多层径向渐变 + 48s 缓慢漂移，暗亮各一套配色；
     collage   Emby：把当前媒体库的海报铺成一张拼贴，重度模糊后压暗（对应「启用背景图」）；
     ultrablur Plex：从海报四角取色，生成一整张氛围底图（UltraBlur 的客户端实现）。
   关掉壁纸时只留 --bg 底色，一切仍可读。 */
let vhWallCollageKey = "";
let vhUbCache = {};
function wallpaperOn() { return settings.wallpaper !== false; }
function setSpecWallpaper(on) {
  settings.wallpaper = !!on;
  saveSettings();
  applySpecWallpaper(true);
  toast(settings.wallpaper ? "🖼 " + t("wallpaperOn") : "🚫 " + t("wallpaperOff"));
}
/* Emby 拼贴：从当前 DOM 里取海报（不额外请求接口，避免与列表加载抢带宽）。 */
function vhCollageSources(limit) {
  const out = [];
  const seen = {};
  document.querySelectorAll(".media-poster-art img, .hp-art img, .audio-album-cover img, .book-card-cover img, .series-show-art img, .media-poster-card img").forEach(img => {
    const src = img.getAttribute("src") || "";
    if (!src || seen[src] || out.length >= limit) return;
    seen[src] = 1;
    out.push(src);
  });
  return out;
}
function vhRenderCollage() {
  const layer = document.getElementById("vhWallCollage");
  if (!layer) return;
  const srcs = vhCollageSources(12);
  const key = srcs.join("|");
  if (key === vhWallCollageKey) return;
  vhWallCollageKey = key;
  layer.innerHTML = srcs.map(src => `<img src="${esc(src)}" alt="" aria-hidden="true" loading="lazy" decoding="async">`).join("");
  layer.dataset.count = String(srcs.length);
}
/* Plex UltraBlur：把海报缩到 8×8 取四角平均色，再交给 CSS 做四角渐变。
   同源图片可以直接读像素；跨源（外链海报）读不到就保留上一组色，不报错。 */
function vhUltraBlurFromImg(img) {
  const src = img && (img.currentSrc || img.getAttribute("src") || "");
  if (!src) return false;
  if (vhUbCache[src]) { vhApplyUb(vhUbCache[src]); return true; }
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 8; canvas.height = 8;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return false;
    ctx.drawImage(img, 0, 0, 8, 8);
    const data = ctx.getImageData(0, 0, 8, 8).data;
    const pick = (x, y) => {
      const i = (y * 8 + x) * 4;
      return [data[i], data[i + 1], data[i + 2]];
    };
    const avg = (pts) => {
      let r = 0, g = 0, b = 0;
      pts.forEach(([x, y]) => { const c = pick(x, y); r += c[0]; g += c[1]; b += c[2]; });
      const n = pts.length || 1;
      return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
    };
    const corners = {
      tl: avg([[0, 0], [1, 0], [0, 1], [1, 1]]),
      tr: avg([[7, 0], [6, 0], [7, 1], [6, 1]]),
      br: avg([[7, 7], [6, 7], [7, 6], [6, 6]]),
      bl: avg([[0, 7], [1, 7], [0, 6], [1, 6]])
    };
    const css = {
      tl: `rgb(${corners.tl.join(",")})`,
      tr: `rgb(${corners.tr.join(",")})`,
      br: `rgb(${corners.br.join(",")})`,
      bl: `rgb(${corners.bl.join(",")})`
    };
    vhUbCache[src] = css;
    vhApplyUb(css);
    return true;
  } catch (e) { return false; }
}
function vhApplyUb(css) {
  const root = document.documentElement;
  root.style.setProperty("--ub-tl", css.tl);
  root.style.setProperty("--ub-tr", css.tr);
  root.style.setProperty("--ub-br", css.br);
  root.style.setProperty("--ub-bl", css.bl);
  root.setAttribute("data-ub", "on");
}
/* 焦点/点击海报时更新取色：Plex 的「背景跟着内容走」。 */
function vhWatchArtwork() {
  if (vhWatchArtwork._bound) return;
  vhWatchArtwork._bound = true;
  const onArt = (ev) => {
    if (currentOpMode() !== "plex" || !wallpaperOn()) return;
    const card = ev.target && ev.target.closest ? ev.target.closest("article, .hp, .book-card, .audio-album-card") : null;
    if (!card) return;
    const img = card.querySelector("img");
    if (img && img.complete) vhUltraBlurFromImg(img);
  };
  document.addEventListener("pointerover", onArt, true);
  document.addEventListener("focusin", onArt, true);
  document.addEventListener("click", onArt, true);
}
function applySpecWallpaper(force) {
  const root = document.documentElement;
  const spec = currentOpMode();
  const def = specThemeDef(spec);
  const on = wallpaperOn();
  root.setAttribute("data-wallpaper", on ? def.wallpaper : "off");
  const layer = document.getElementById("vhWall");
  if (layer) layer.dataset.kind = on ? def.wallpaper : "off";
  if (!on) return;
  if (def.wallpaper === "collage") {
    vhRenderCollage();
    /* 首屏列表是异步来的：先渲染一次，再在 1.2s/3.5s 补两次，之后靠列表点击刷新。 */
    if (force !== false) {
      clearTimeout(applySpecWallpaper._t1); clearTimeout(applySpecWallpaper._t2);
      applySpecWallpaper._t1 = setTimeout(vhRenderCollage, 1200);
      applySpecWallpaper._t2 = setTimeout(vhRenderCollage, 3500);
    }
  }
  if (def.wallpaper === "ultrablur") {
    vhWatchArtwork();
    const first = document.querySelector(".media-poster-art img, .hp-art img, .audio-album-cover img");
    if (first && first.complete) vhUltraBlurFromImg(first);
    else if (first) first.addEventListener("load", () => vhUltraBlurFromImg(first), { once: true });
  }
}
/* 列表切换后刷新壁纸：委托点击顶栏标签与媒体库卡片，不额外轮询。 */
document.addEventListener("click", (ev) => {
  const t = ev.target;
  if (!t || !t.closest) return;
  if (t.closest("#topLibTabs .libtab, .libtab, .media-poster-card, .book-card, .audio-album-card, .hp")) {
    setTimeout(() => { try { applySpecWallpaper(false); } catch (e) {} }, 900);
  }
});

/* 应用主题：把两层选择落到 <html>，并让旧的世界观（body[data-theme] / 阅读器主题类）继续成立。 */
function applyTheme(options = {}) {
  const mode = resolvedThemeMode();
  const spec = currentOpMode();
  const root = document.documentElement;
  root.dataset.spec = spec;
  root.dataset.mode = mode;
  /* 旧属性 data-palette / data-accent 已随调色板与强调色一起移除；
     这里显式清掉，避免旧 localStorage 或手工改过的 DOM 让旧 CSS 复活。 */
  root.removeAttribute("data-palette");
  root.removeAttribute("data-accent");
  if (settings.reduceMotion) root.dataset.motion = "reduce"; else delete root.dataset.motion;
  /* body[data-theme] 保持 dark|light：老 CSS 里 body[data-theme="light"] 的覆盖规则要继续生效。 */
  document.body.dataset.theme = mode;
  document.body.classList.remove("custom-bg");
  /* 阅读器（iframe/整页覆盖层）不在 <html> 变量链上，需要显式同步主题类。 */
  document.querySelectorAll(".media-reader-overlay").forEach(el => {
    el.classList.remove("reader-theme-dark", "reader-theme-light", "reader-theme-custom");
    el.classList.add(readerThemeClass());
  });
  applySpecWallpaper(false);
  syncThemeControls();
  try { applyOpModeIcons(); } catch (e) {}
  if (options.animate) themeTransitionPulse();
}
/* 切换主题时给整页挂一段统一颜色过渡，避免硬切；260ms 后摘掉，
   不常驻一个全局 transition（那会拖慢日常滚动/交互 —— 性能优先）。 */
function themeTransitionPulse() {
  const root = document.documentElement;
  root.classList.add("theming");
  clearTimeout(themeTransitionPulse._timer);
  themeTransitionPulse._timer = setTimeout(() => root.classList.remove("theming"), 260);
}
function setThemeMode(mode) {
  settings.mode = THEME_MODES.includes(String(mode)) ? String(mode) : "dark";
  settings.theme = resolvedThemeMode();
  saveSettings();
  applyTheme({ animate: true });
  toast("🎨 " + t("themeModeSaved") + "：" + themeLabel(THEME_MODE_LABEL[settings.mode]) + (settings.mode === "auto" ? "（" + themeLabel(THEME_MODE_LABEL[resolvedThemeMode()]) + "）" : ""));
}
function setThemeReduceMotion(on) {
  settings.reduceMotion = !!on;
  saveSettings();
  applyTheme();
}
/* 兼容旧入口：setTheme('dark'|'light')。旧书签/旧版本 localStorage 仍会调用它。
   v1.0.6：'custom' 档（自定义背景）已移除，按暗色处理。 */
function setTheme(th) {
  setThemeMode(String(th) === "light" ? "light" : "dark");
}
/* 系统明暗跟随：auto 档下系统切换要实时生效（会话方案里的「跟随系统 + 监听实时变化」）。 */
(function watchSystemTheme() {
  try {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => { if (settings.mode === "auto") applyTheme({ animate: true }); };
    if (typeof mq.addEventListener === "function") mq.addEventListener("change", onChange);
    else if (typeof mq.addListener === "function") mq.addListener(onChange);
  } catch (e) { /* 环境不支持时静默降级为手动明暗 */ }
})();

/* ---------- 面板渲染 ---------- */
function renderThemePanel() {
  /* v1.0.6：调色板卡片与强调色色块整体移除，规格卡成为唯一的主题入口；
     每张卡同时给出「这套规格带什么」（四行元素清单，来自对应详解文档）。 */
  const opSeg = document.getElementById("opModeSeg");
  if (opSeg) {
    opSeg.innerHTML = OP_MODES.map(m => `<button type="button" class="spec-card" role="radio" data-op-opt="${m}"
        aria-checked="false" title="${esc(themeLabel(OP_MODE_TAG[m]))}" onclick="setOpMode('${m}')">
        <span class="sc-mark">${OP_MODE_MARK[m] || ""}</span>
        <span class="sc-tx"><b>${esc(themeLabel(OP_MODE_LABEL[m]))}</b><small>${esc(themeLabel(OP_MODE_TAG[m]))}</small></span>
        <span class="sc-dot" aria-hidden="true"></span>
      </button>`).join("");
  }
  const uiSeg = document.getElementById("uiModeSeg");
  if (uiSeg) {
    uiSeg.innerHTML = UI_MODES.map(m => `<button type="button" class="mode-card" role="radio" data-ui-opt="${m}"
        aria-checked="false" title="${esc(themeLabel(UI_MODE_TAG[m]))}" onclick="setUIMode('${m}')">
        <span class="sc-ic" aria-hidden="true">${UI_MODE_ICON[m]}</span>
        <span class="sc-tx"><b>${esc(themeLabel(UI_MODE_LABEL[m]))}</b><small>${esc(themeLabel(UI_MODE_TAG[m]))}</small></span>
        <span class="sc-dot" aria-hidden="true"></span>
      </button>`).join("");
  }
  const seg = document.getElementById("themeModeSeg");
  if (seg) {
    seg.innerHTML = THEME_MODES.map(mode => `<button type="button" data-mode-opt="${mode}" data-i18n-mode="${mode}" onclick="setThemeMode('${mode}')">${esc(themeLabel(THEME_MODE_LABEL[mode]))}</button>`).join("");
  }
  const motion = document.getElementById("themeReduceMotion");
  if (motion) motion.checked = !!settings.reduceMotion;
  const wall = document.getElementById("themeWallpaperToggle");
  if (wall) wall.checked = wallpaperOn();
  syncThemeControls();
}
/* 规格详解：把 docs/specs/*.md 的要素清单摊在弹窗里（不加载外部图片，纯文本）。 */
function openSpecDoc(mode) {
  const id = OP_MODES.includes(String(mode)) ? String(mode) : currentOpMode();
  const def = specThemeDef(id);
  const box = document.getElementById("specDocBody");
  const title = document.getElementById("specDocTitle");
  if (!box || !title) return;
  title.textContent = themeLabel(OP_MODE_LABEL[id]) + " · " + t("specDocTitle");
  const rows = (SPEC_HIGHLIGHTS[id] || []).map((h, i) => `<li><b>${i + 1}.</b> ${esc(themeLabel(h))}</li>`).join("");
  box.innerHTML = `<p class="spec-doc-lead">${esc(t("specDocLead"))}</p>
    <ul class="spec-doc-list">${rows}</ul>
    <p class="spec-doc-meta">${esc(t("specDocMeta"))}<a href="${esc(def.doc)}" target="_blank" rel="noopener"><code>${esc(def.doc)}</code></a></p>
    <div class="spec-doc-actions">
      <button class="btn btn-primary" type="button" onclick="setOpMode('${id}');closeModal('specDocModal')">${esc(t("specDocApply"))}</button>
      <button class="btn" type="button" onclick="closeModal('specDocModal')">${esc(t("specDocClose"))}</button>
    </div>`;
  openModal("specDocModal");
}
function syncThemeControls() {
  const mode = settings.mode || "dark";
  document.querySelectorAll("#themeModeSeg [data-mode-opt]").forEach(el => el.classList.toggle("on", el.dataset.modeOpt === mode));
  document.querySelectorAll("#uiModeSeg [data-ui-opt]").forEach(el => {
    const on = el.dataset.uiOpt === uiModeChoice();
    el.classList.toggle("on", on);
    el.setAttribute("aria-checked", on ? "true" : "false");
    el.setAttribute("tabindex", on ? "0" : "-1");
  });
  document.querySelectorAll("#opModeSeg [data-op-opt]").forEach(el => {
    const on = el.dataset.opOpt === currentOpMode();
    el.classList.toggle("on", on);
    el.setAttribute("aria-checked", on ? "true" : "false");
    el.setAttribute("tabindex", on ? "0" : "-1");
  });
  const wall = document.getElementById("themeWallpaperToggle");
  if (wall) wall.checked = wallpaperOn();
  /* 当前生效说明：自动档要同时显示「自动」与真正落地的档位。 */
  const specNow = document.getElementById("opModeCurrent");
  if (specNow) {
    const def = OP_MODE_LABEL[currentOpMode()], tag = OP_MODE_TAG[currentOpMode()];
    specNow.textContent = t("uiSpecNow") + "：" + themeLabel(def) + " · " + themeLabel(tag) +
      " · " + themeLabel(THEME_MODE_LABEL[resolvedThemeMode()]);
  }
  const modeNow = document.getElementById("uiModeCurrent");
  if (modeNow) {
    const choice = uiModeChoice(), applied = resolvedUIMode();
    modeNow.textContent = t("opModeNow") + "：" + themeLabel(UI_MODE_LABEL[choice]) +
      (choice === "auto" ? " → " + themeLabel(UI_MODE_LABEL[applied]) : "") +
      (choice === "tv" ? " · " + t("opModeTvRules") : "");
  }
  /* 规格清单直接铺在面板里，不用点开弹窗也能看到这套规格带什么。 */
  const hl = document.getElementById("opModeHighlights");
  if (hl) {
    const rows = (SPEC_HIGHLIGHTS[currentOpMode()] || []).map(h => `<li>${esc(themeLabel(h))}</li>`).join("");
    hl.innerHTML = `<ul>${rows}</ul><button class="btn btn-sm" type="button" onclick="openSpecDoc('${currentOpMode()}')">${esc(t("specDocOpen"))}</button>`;
  }
}
function initTheme() {
  renderThemePanel();
  applyTheme();
  applyUIMode();
  /* v1.0.2（需求6/7）：操作模式要在首帧就落到 <html>，避免先按默认模式画一遍。 */
  applyOpMode();
  applySpecWallpaper(true);
}
