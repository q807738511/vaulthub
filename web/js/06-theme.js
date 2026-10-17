/* VaultHub v0.9.73 — 主题引擎（调色板 × 明暗 × 强调色）
   方案来自会话 mtkzexy5e4e2te 的主题升级：主题从「一层颜色」变成三层叠加，
   每层只覆盖一组 CSS 变量，组件代码一行不改：

       主题 = 调色板(palette) × 明暗(mode) × 强调色(accent)
               4 种            亮/暗/跟随系统      6 种（含「跟随主题」）

   实现在 web/css/main.css 的「v0.9.73 主题令牌」段：颜色之外，圆角/阴影/
   标题字族/动效速度也进令牌，所以每套调色板有各自性格；明暗不再和调色板绑定。
   本文件只做三件事：把用户选择落到 <html> 的 data-* 上、渲染面板里的真预览卡片、
   跟随系统明暗实时切换。持久化写在 settings（dwu_settings）里，与旧版本兼容：
   老字段 settings.theme 仍会同步成 dark|light，setTheme() 也保留为兼容入口。 */

const THEME_PALETTES = [
  {
    id: "emerald", r: 10, dur: 160,
    name: { "zh-CN": "青瓷", "zh-TW": "青瓷", en: "Emerald" },
    desc: { "zh-CN": "利落克制 · 默认", "zh-TW": "俐落克制 · 預設", en: "Crisp & understated · default" },
    light: { bg: "#F7F8FA", card: "#FFFFFF", card2: "#F1F3F5", text: "#12171D", accent: "#0B7C73", line: "#E5E8EB", coverA: "#2F6F6A", coverB: "#123C3A" },
    dark: { bg: "#0B1413", card: "#101A19", card2: "#162321", text: "#E8F2F1", accent: "#2BC4B4", line: "#1E2D2B", coverA: "#2B6E68", coverB: "#0B2422" }
  },
  {
    id: "plum", r: 12, dur: 180,
    name: { "zh-CN": "午夜紫曜", "zh-TW": "午夜紫曜", en: "Plum" },
    desc: { "zh-CN": "圆润 · 紫辉光", "zh-TW": "圓潤 · 紫輝光", en: "Rounded · violet glow" },
    light: { bg: "#F7F5FF", card: "#FFFFFF", card2: "#F1EEFA", text: "#1E1830", accent: "#5B2FCB", line: "#E5E0F2", coverA: "#6E5A8C", coverB: "#2A2140" },
    dark: { bg: "#0F0D16", card: "#171426", card2: "#1F1B31", text: "#EDE9FE", accent: "#8B5CF6", line: "#2A2440", coverA: "#6E5A8C", coverB: "#2A2140" }
  },
  {
    id: "neon", r: 5, dur: 130,
    name: { "zh-CN": "霓虹胶片", "zh-TW": "霓虹膠片", en: "Neon" },
    desc: { "zh-CN": "锐角 · 影院动作最快", "zh-TW": "銳角 · 影院動作最快", en: "Sharp corners · fastest motion" },
    light: { bg: "#F5F5F8", card: "#FFFFFF", card2: "#EEEEF3", text: "#16161C", accent: "#BE123C", line: "#E2E2E9", coverA: "#8C2440", coverB: "#1A0A12" },
    dark: { bg: "#0B0B0F", card: "#141419", card2: "#1C1C24", text: "#F5F5F7", accent: "#FF4D6D", line: "#242430", coverA: "#8C2440", coverB: "#1A0A12" }
  },
  {
    id: "clay", r: 14, dur: 220,
    name: { "zh-CN": "暖陶", "zh-TW": "暖陶", en: "Clay" },
    desc: { "zh-CN": "纸感 · 标题衬线", "zh-TW": "紙感 · 標題襯線", en: "Paper-like · serif headings" },
    light: { bg: "#FAF6F1", card: "#FFFDFB", card2: "#F3EDE5", text: "#2C2620", accent: "#8F3F14", line: "#E8DFD3", coverA: "#A9714A", coverB: "#5C3A22" },
    dark: { bg: "#17130F", card: "#1F1A15", card2: "#271F18", text: "#F3E9DC", accent: "#E08A4E", line: "#332A21", coverA: "#A9714A", coverB: "#5C3A22" }
  }
];

/* 强调色：只覆盖 {--accent, --accent-ink, --accent-dim, --accent-ring, --accent-glow}
   一组变量（值写在 CSS 里，这里只提供面板色块与文案，避免两处维护同一组颜色）。 */
const THEME_ACCENTS = [
  { id: "theme", css: "sw-theme" },
  { id: "teal", css: "", color: "#0F9E92", label: { "zh-CN": "青绿", "zh-TW": "青綠", en: "Teal" } },
  { id: "indigo", css: "", color: "#4338CA", label: { "zh-CN": "靛蓝", "zh-TW": "靛藍", en: "Indigo" } },
  { id: "rose", css: "", color: "#BE123C", label: { "zh-CN": "玫红", "zh-TW": "玫紅", en: "Rose" } },
  { id: "amber", css: "", color: "#92400E", label: { "zh-CN": "琥珀", "zh-TW": "琥珀", en: "Amber" } },
  { id: "violet", css: "", color: "#6D28D9", label: { "zh-CN": "紫罗兰", "zh-TW": "紫羅蘭", en: "Violet" } }
];
const THEME_MODES = ["dark", "light", "auto"];

/* ==================== v1.0.4 操作模式（自动 / Phone / TV / PC） ====================
   v0.9.76 起这一档叫「界面规格」，v1.0.4 按客户口径改名「操作模式」：
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
/* ==================== v1.0.4 界面规格（Apple / Emby / Plex） ====================
   v1.0.2 起这套档位叫「操作模式」，v1.0.4 按客户口径改名「界面规格」：
   它换的是**长相** —— 图标包 + 动效节奏 + 圆角阴影 + 顶栏/标签的形态。
   另一档「操作模式」（自动 / Phone / TV / PC，见上面的 UI_MODES）换的是**交互** ——
   布局密度、鼠标/遥控/键盘规则、焦点表现。两档互相独立，可以任意组合。
   落点：<html data-opmode>（历史属性名保留，避免破坏既有 CSS 与测试）
        + <html data-spec>（同值，语义更清楚的新属性）
        + OP_ICON_PACK（顶栏/菜单/播放器图标按规格替换）。
   说明：图标是按各客户端的视觉语言手写的，不使用对方私有素材，避免授权问题。 */
const OP_MODES = ["apple", "emby", "plex"];
const OP_MODE_LABEL = {
  apple: { "zh-CN": "Apple", "zh-TW": "Apple", en: "Apple" },
  emby: { "zh-CN": "Emby", "zh-TW": "Emby", en: "Emby" },
  plex: { "zh-CN": "Plex", "zh-TW": "Plex", en: "Plex" }
};
/* 规格卡上的副标题：一句话说清这一档换了什么（不是说明段落，是选中依据）。 */
const OP_MODE_TAG = {
  apple: { "zh-CN": "毛玻璃 · 弹性动效", "zh-TW": "毛玻璃 · 彈性動效", en: "Frosted · springy" },
  emby: { "zh-CN": "Material · 水波", "zh-TW": "Material · 水波", en: "Material · ripple" },
  plex: { "zh-CN": "扁平 · 琥珀高亮", "zh-TW": "扁平 · 琥珀高亮", en: "Flat · amber" }
};
/* 规格自带的品牌标记（抽象几何，不用对方 logo 素材）。 */
const OP_MODE_MARK = {
  apple: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.6" y="3.6" width="16.8" height="16.8" rx="5.2" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M9.4 8.6 15.8 12l-6.4 3.4Z" fill="currentColor"/></svg>',
  emby: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="3.2" fill="currentColor" opacity=".18"/><path d="M8.4 6.4 17.6 12l-9.2 5.6Z" fill="currentColor"/></svg>',
  plex: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h5.4l6.2 8-6.2 8H4l6.2-8Z" fill="currentColor"/><path d="M13.2 4H18l2.6 4-2.6 4h-4.8l2.6-4Z" fill="currentColor" opacity=".55"/></svg>'
};

/* 三套图标包：同一批语义图标，按规格各自的描边/填充语言重画。
   只覆盖「看得见差别」的那些；其余沿用站内默认图标。 */
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
    more: '<circle cx="6" cy="12" r="1.7" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.7" fill="currentColor" stroke="none"/><circle cx="18" cy="12" r="1.7" fill="currentColor" stroke="none"/>'
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
    more: '<circle cx="5.4" cy="12" r="2" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="2" fill="currentColor" stroke="none"/><circle cx="18.6" cy="12" r="2" fill="currentColor" stroke="none"/>'
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
    more: '<circle cx="5.6" cy="12" r="2" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="2" fill="currentColor" stroke="none"/><circle cx="18.4" cy="12" r="2" fill="currentColor" stroke="none"/>'
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
function applyOpMode() {
  const mode = currentOpMode();
  const root = document.documentElement;
  root.setAttribute("data-opmode", mode);
  /* 新属性名与旧属性同值：语义上 data-spec 才是「界面规格」。 */
  root.setAttribute("data-spec", mode);
  applyOpModeIcons();
  return mode;
}
/* 规格切换：图标、动效、圆角、顶栏形态一起变，并立刻同步选中态与「当前」说明。 */
function setOpMode(mode) {
  settings.opMode = OP_MODES.includes(String(mode)) ? String(mode) : "apple";
  saveSettings();
  const applied = applyOpMode();
  try { syncThemeControls(); } catch (e) {}
  try { themeTransitionPulse(); } catch (e) {}
  toast("🎛 " + t("uiSpecSaved") + "：" + themeLabel(OP_MODE_LABEL[applied]));
}
const THEME_MODE_LABEL = {
  dark: { "zh-CN": "暗色", "zh-TW": "暗色", en: "Dark" },
  light: { "zh-CN": "亮色", "zh-TW": "亮色", en: "Light" },
  auto: { "zh-CN": "跟随系统", "zh-TW": "跟隨系統", en: "System" }
};

function themeLangKey() { return curLang === "en" ? "en" : curLang === "zh-TW" ? "zh-TW" : "zh-CN"; }
function themeLabel(table) { return table[themeLangKey()] || table["zh-CN"]; }
function themePaletteDef(id) { return THEME_PALETTES.find(p => p.id === String(id)) || THEME_PALETTES[0]; }
function themeAccentDef(id) { return THEME_ACCENTS.find(a => a.id === String(id)) || THEME_ACCENTS[0]; }
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
function themePreviewStyle(def, mode) {
  const t = def[mode === "light" ? "light" : "dark"];
  return `--t-bg:${t.bg};--t-card:${t.card};--t-card2:${t.card2};--t-text:${t.text};--t-accent:${t.accent};--t-line:${t.line};--t-r:${def.r}px;--t-cover-a:${t.coverA};--t-cover-b:${t.coverB}`;
}
/* 应用主题：把三层选择落到 <html>，并让旧的世界观（body[data-theme] / 阅读器主题类）继续成立。 */
function applyTheme(options = {}) {
  const mode = resolvedThemeMode();
  const palette = themePaletteDef(settings.palette).id;
  const accent = themeAccentDef(settings.accent).id;
  const root = document.documentElement;
  root.dataset.palette = palette;
  root.dataset.mode = mode;
  root.dataset.accent = accent;
  if (settings.reduceMotion) root.dataset.motion = "reduce"; else delete root.dataset.motion;
  /* body[data-theme] 保持 dark|light：老 CSS 里 body[data-theme="light"] 的覆盖规则要继续生效。
     自定义背景只是背景层，不再伪装成第三种主题（旧版自定义背景一律按暗色走，亮色下会难读）。 */
  document.body.dataset.theme = mode;
  document.body.classList.toggle("custom-bg", !!settings.customBg);
  if (settings.customBg) applyBgImage();
  /* 阅读器（iframe/整页覆盖层）不在 <html> 变量链上，需要显式同步主题类。 */
  document.querySelectorAll(".media-reader-overlay").forEach(el => {
    el.classList.remove("reader-theme-dark", "reader-theme-light", "reader-theme-custom");
    el.classList.add(readerThemeClass());
  });
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
function setThemePalette(id) {
  settings.palette = themePaletteDef(id).id;
  saveSettings();
  applyTheme({ animate: true });
  toast("🎨 " + t("themePaletteSaved") + "：" + themeLabel(themePaletteDef(settings.palette).name));
}
function setThemeAccent(id) {
  settings.accent = themeAccentDef(id).id;
  saveSettings();
  applyTheme({ animate: true });
  const def = themeAccentDef(settings.accent);
  toast("🎨 " + t("themeAccentSaved") + "：" + (def.id === "theme" ? t("accentTheme") : themeLabel(def.label)));
}
function setThemeReduceMotion(on) {
  settings.reduceMotion = !!on;
  saveSettings();
  applyTheme();
}
/* 自定义背景图片开关（v0.9.73：变成独立的背景层开关，不再挤占「主题」三档）。 */
function setCustomBg(on) {
  settings.customBg = !!on;
  settings.theme = resolvedThemeMode();
  saveSettings();
  applyTheme();
  toast(settings.customBg ? "🖼 " + t("bgEnabled") : "🗑 " + t("bgDisabled"));
}
/* 兼容旧入口：setTheme('dark'|'light'|'custom')。旧书签/旧版本 localStorage 仍会调用它。 */
function setTheme(th) {
  const value = String(th || "");
  if (value === "custom") { setCustomBg(true); return; }
  settings.customBg = false;
  setThemeMode(value === "light" ? "light" : "dark");
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

/* ---------- 面板渲染：主题卡片是「用该主题自己的令牌渲染的小界面」，不是色块 ---------- */
function renderThemePanel() {
  const grid = document.getElementById("themePaletteGrid");
  if (grid) {
    grid.innerHTML = THEME_PALETTES.map(def => `
      <div class="themecard" role="button" tabindex="0" data-theme-card="${def.id}" onclick="setThemePalette('${def.id}')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();setThemePalette('${def.id}')}">
        <span class="tp" data-theme-preview="${def.id}" style="${themePreviewStyle(def, resolvedThemeMode())}">
          <span class="tp-top"><i></i><i></i></span>
          <span class="tp-body"><span class="tp-thumb"></span><span class="tp-lines"><b>${esc(themeLabel(def.name))}</b><i></i><i></i></span></span>
        </span>
        <span class="tc-name">${esc(themeLabel(def.name))}<span class="tc-check">✓</span></span>
        <span class="tc-desc">${esc(themeLabel(def.desc))} · ${def.r}px · ${def.dur}ms</span>
      </div>`).join("");
  }
  /* v1.0.4（需求3/4）：界面规格 = 带品牌标记的卡片；操作模式 = 带设备图标的卡片。
     两张卡都同时给出「换成什么」与「当前生效」，点一下立刻能看到变化。 */
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
  const swatches = document.getElementById("themeAccentSwatches");
  if (swatches) {
    swatches.innerHTML = THEME_ACCENTS.map(a => {
      const label = a.id === "theme" ? t("accentTheme") : themeLabel(a.label);
      const style = a.id === "theme" ? "" : ` style="--sw:${a.color}"`;
      return `<button type="button" class="swatch ${a.css}" data-theme-accent="${a.id}"${style} title="${esc(label)}" aria-label="${esc(label)}" onclick="setThemeAccent('${a.id}')"></button>`;
    }).join("");
  }
  const seg = document.getElementById("themeModeSeg");
  if (seg) {
    seg.innerHTML = THEME_MODES.map(mode => `<button type="button" data-mode-opt="${mode}" data-i18n-mode="${mode}" onclick="setThemeMode('${mode}')">${esc(themeLabel(THEME_MODE_LABEL[mode]))}</button>`).join("");
  }
  const motion = document.getElementById("themeReduceMotion");
  if (motion) motion.checked = !!settings.reduceMotion;
  const bgToggle = document.getElementById("themeCustomBgToggle");
  if (bgToggle) bgToggle.checked = !!settings.customBg;
  syncThemeControls();
}
function syncThemeControls() {
  const palette = themePaletteDef(settings.palette).id, accent = themeAccentDef(settings.accent).id, mode = settings.mode || "dark";
  document.querySelectorAll("[data-theme-card]").forEach(el => el.classList.toggle("on", el.dataset.themeCard === palette));
  /* 预览卡片跟着「亮/暗」实时换色：选亮色时要看到亮色版缩略界面。 */
  document.querySelectorAll("[data-theme-preview]").forEach(el => {
    el.setAttribute("style", themePreviewStyle(themePaletteDef(el.dataset.themePreview), resolvedThemeMode()));
  });
  document.querySelectorAll("[data-theme-accent]").forEach(el => el.classList.toggle("on", el.dataset.themeAccent === accent));
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
  /* 当前生效说明：自动档要同时显示「自动」与真正落地的档位。 */
  const specNow = document.getElementById("opModeCurrent");
  if (specNow) {
    const def = OP_MODE_LABEL[currentOpMode()], tag = OP_MODE_TAG[currentOpMode()];
    specNow.textContent = t("uiSpecNow") + "：" + themeLabel(def) + " · " + themeLabel(tag);
  }
  const modeNow = document.getElementById("uiModeCurrent");
  if (modeNow) {
    const choice = uiModeChoice(), applied = resolvedUIMode();
    modeNow.textContent = t("opModeNow") + "：" + themeLabel(UI_MODE_LABEL[choice]) +
      (choice === "auto" ? " → " + themeLabel(UI_MODE_LABEL[applied]) : "") +
      (choice === "tv" ? " · " + t("opModeTvRules") : "");
  }
}
function initTheme() {
  renderThemePanel();
  applyTheme();
  applyUIMode();
  /* v1.0.2（需求6/7）：操作模式要在首帧就落到 <html>，避免先按默认模式画一遍。 */
  applyOpMode();
}
