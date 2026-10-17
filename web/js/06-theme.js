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

/* ==================== v0.9.76 UI 设备模式 ====================
   auto：按视口宽度+指针类型自动识别 Phone / PC / TV；
   手动指定 phone/tv/pc 时跳过自动识别。
   模式落在 <html data-uimode> 上，CSS 按档位调整信息密度：
     phone —— 更大点击目标、收起次要列；
     pc    —— 默认密度；
     tv    —— 更大字号/行高、焦点高亮加粗（遥控器场景）。 */
const UI_MODES = ["auto", "phone", "tv", "pc"];
const UI_MODE_LABEL = {
  auto: { "zh-CN": "自动识别", "zh-TW": "自動識別", en: "Auto" },
  phone: { "zh-CN": "Phone", "zh-TW": "Phone", en: "Phone" },
  tv: { "zh-CN": "TV", "zh-TW": "TV", en: "TV" },
  pc: { "zh-CN": "PC", "zh-TW": "PC", en: "PC" }
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
function resolvedUIMode() { return UI_MODES.includes(settings.uiMode) && settings.uiMode !== "auto" ? settings.uiMode : detectUIMode(); }
function applyUIMode() {
  const mode = resolvedUIMode();
  document.documentElement.setAttribute("data-uimode", mode);
  return mode;
}
function setUIMode(mode) {
  settings.uiMode = UI_MODES.includes(String(mode)) ? String(mode) : "auto";
  saveSettings();
  const applied = applyUIMode();
  toast("🖥 界面规格：" + themeLabel(UI_MODE_LABEL[settings.uiMode]) + (settings.uiMode === "auto" ? "（当前 " + applied + "）" : ""));
}
/* ==================== v1.0.2 操作模式（需求6/7） ====================
   三档操作模式，各按对应开源客户端的「操作手感」还原：
     apple —— 圆角更大、弹性缓动、半透明毛玻璃、细描边圆头图标（SF Symbols 风格）；
     emby  —— Material：方一些的圆角、标准缓动、点击水波高亮、实心图标、卡片抬升；
     plex  —— 扁平硬朗：小圆角、极短过渡、海报琥珀色高亮、粗圆角图标。
   落点：<html data-opmode>（CSS 令牌与动效在 web/css/main.css 的「操作模式」段）
        + OP_ICON_PACK（播放器/顶栏图标按模式替换）。
   说明：图标是按各客户端的视觉语言手写的，不使用对方私有素材，避免授权问题。 */
const OP_MODES = ["apple", "emby", "plex"];
const OP_MODE_LABEL = {
  apple: { "zh-CN": "Apple", "zh-TW": "Apple", en: "Apple" },
  emby: { "zh-CN": "Emby", "zh-TW": "Emby", en: "Emby" },
  plex: { "zh-CN": "Plex", "zh-TW": "Plex", en: "Plex" }
};
const OP_MODE_DESC = {
  "zh-CN": "Apple / Emby / Plex：动效节奏、圆角阴影与图标风格各按对应客户端还原",
  "zh-TW": "Apple / Emby / Plex：動效節奏、圓角陰影與圖示風格各按對應客戶端還原",
  en: "Apple / Emby / Plex: motion, radii, shadows and icon style per client"
};
/* 各模式只覆盖「看得见差别」的那几个图标，其余沿用站内默认图标。 */
const OP_ICON_PACK = {
  apple: {
    play: '<path d="M8.8 6.1 18.9 12 8.8 17.9Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>',
    pause: '<path d="M9.4 5.7v12.6M14.6 5.7v12.6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
    prev: '<path d="M6.2 5.8v12.4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><path d="M18.4 6.6 10.6 12l7.8 5.4Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>',
    next: '<path d="M17.8 5.8v12.4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><path d="M5.6 6.6 13.4 12l-7.8 5.4Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>',
    heart: '<path d="M20.6 5.1a5.1 5.1 0 0 0-7.2 0L12 6.5l-1.4-1.4a5.1 5.1 0 0 0-7.2 7.2L12 21l8.6-8.7a5.1 5.1 0 0 0 0-7.2Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>',
    search: '<circle cx="10.8" cy="10.8" r="6.4" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="m15.5 15.5 4.7 4.7" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
    settings: '<circle cx="12" cy="12" r="3.1" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M12 3.6v2.2M12 18.2v2.2M20.4 12h-2.2M5.8 12H3.6M17.9 6.1l-1.6 1.6M7.7 16.3l-1.6 1.6M17.9 17.9l-1.6-1.6M7.7 7.7 6.1 6.1" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
    more: '<circle cx="6" cy="12" r="1.7" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.7" fill="currentColor" stroke="none"/><circle cx="18" cy="12" r="1.7" fill="currentColor" stroke="none"/>'
  },
  emby: {
    play: '<path d="M8 5.4 19 12 8 18.6Z" fill="currentColor" stroke="none"/>',
    pause: '<rect x="7" y="5" width="3.7" height="14" fill="currentColor" stroke="none"/><rect x="13.3" y="5" width="3.7" height="14" fill="currentColor" stroke="none"/>',
    prev: '<path d="M5.6 5.4h2.2v13.2H5.6z" fill="currentColor" stroke="none"/><path d="M19 6.2 10 12l9 5.8Z" fill="currentColor" stroke="none"/>',
    next: '<path d="M16.2 5.4h2.2v13.2h-2.2z" fill="currentColor" stroke="none"/><path d="M5 6.2 14 12l-9 5.8Z" fill="currentColor" stroke="none"/>',
    heart: '<path d="M12 20.8 3.7 12.5a5.2 5.2 0 0 1 7.4-7.4l.9.9.9-.9a5.2 5.2 0 0 1 7.4 7.4Z" fill="currentColor" stroke="none"/>',
    heartFill: '<path d="M12 20.8 3.7 12.5a5.2 5.2 0 0 1 7.4-7.4l.9.9.9-.9a5.2 5.2 0 0 1 7.4 7.4Z" fill="currentColor" stroke="none"/>',
    search: '<path d="M10.6 3.6a7 7 0 1 0 4.1 12.7l4.2 4.2 1.5-1.5-4.2-4.2A7 7 0 0 0 10.6 3.6Zm0 2.4a4.6 4.6 0 1 1 0 9.2 4.6 4.6 0 0 1 0-9.2Z" fill="currentColor" stroke="none"/>',
    settings: '<path d="M12 8.6a3.4 3.4 0 1 0 0 6.8 3.4 3.4 0 0 0 0-6.8Zm0 5.2a1.8 1.8 0 1 1 0-3.6 1.8 1.8 0 0 1 0 3.6Z" fill="currentColor" stroke="none"/><path d="M19.6 12c0-.5-.1-1-.2-1.4l1.7-1.3-1.4-2.4-2 .8c-.7-.6-1.5-1-2.4-1.3L15 4.2h-2.8l-.3 2.2c-.9.3-1.7.7-2.4 1.3l-2-.8-1.4 2.4 1.7 1.3a7 7 0 0 0 0 2.8L6.1 15l1.4 2.4 2-.8c.7.6 1.5 1 2.4 1.3l.3 2.2H15l.3-2.2c.9-.3 1.7-.7 2.4-1.3l2 .8 1.4-2.4-1.7-1.3c.1-.4.2-.9.2-1.4Z" fill="currentColor" stroke="none" opacity=".55"/>',
    more: '<circle cx="5.4" cy="12" r="2" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="2" fill="currentColor" stroke="none"/><circle cx="18.6" cy="12" r="2" fill="currentColor" stroke="none"/>'
  },
  plex: {
    play: '<path d="M8.6 5.2 19.6 12 8.6 18.8Z" fill="currentColor" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>',
    pause: '<rect x="7" y="5" width="3.9" height="14" rx=".7" fill="currentColor" stroke="none"/><rect x="13.1" y="5" width="3.9" height="14" rx=".7" fill="currentColor" stroke="none"/>',
    prev: '<path d="M5.4 5.2h2.6v13.6H5.4z" fill="currentColor" stroke="none"/><path d="M19.4 5.6 10.2 12l9.2 6.4Z" fill="currentColor" stroke="none"/>',
    next: '<path d="M16 5.2h2.6v13.6H16z" fill="currentColor" stroke="none"/><path d="M4.6 5.6 13.8 12l-9.2 6.4Z" fill="currentColor" stroke="none"/>',
    heart: '<path d="M12 20.8 3.9 12.7a5.4 5.4 0 0 1 7.6-7.6l.5.5.5-.5a5.4 5.4 0 0 1 7.6 7.6Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>',
    search: '<circle cx="10.8" cy="10.8" r="6.2" fill="none" stroke="currentColor" stroke-width="2.4"/><path d="m15.4 15.4 4.9 4.9" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="square"/>',
    more: '<circle cx="5.6" cy="12" r="2" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="2" fill="currentColor" stroke="none"/><circle cx="18.4" cy="12" r="2" fill="currentColor" stroke="none"/>'
  }
};
function currentOpMode() { return OP_MODES.includes(settings.opMode) ? settings.opMode : "apple"; }
function opModeIcon(name) {
  const pack = OP_ICON_PACK[currentOpMode()];
  return (pack && pack[name]) || "";
}
/* 顶栏等「静态 HTML 图标」：按 data-op-icon 挂点替换内容。 */
function applyOpModeIcons() {
  const nodes = document.querySelectorAll("[data-op-icon]");
  for (const el of nodes) {
    const body = opModeIcon(el.getAttribute("data-op-icon"));
    if (body && el.innerHTML !== body) el.innerHTML = body;
  }
}
function applyOpMode() {
  const mode = currentOpMode();
  document.documentElement.setAttribute("data-opmode", mode);
  applyOpModeIcons();
  return mode;
}
function setOpMode(mode) {
  settings.opMode = OP_MODES.includes(String(mode)) ? String(mode) : "apple";
  saveSettings();
  const applied = applyOpMode();
  /* v1.0.2：切换后必须同步选中态 —— 否则按钮高亮停在上一档（实测发现的缺陷）。 */
  try { syncThemeControls(); } catch (e) {}
  const active = document.querySelector("#opModeSeg [data-op-opt].on");
  if (active && active.getAttribute("data-op-opt") !== applied) active.classList.add("on");
  document.querySelectorAll("#opModeSeg [data-op-opt]").forEach(el => el.classList.toggle("on", el.dataset.opOpt === applied));
  toast("🖱 " + t("opModeSaved") + "：" + themeLabel(OP_MODE_LABEL[applied]));
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
  const opSeg = document.getElementById("opModeSeg");
  if (opSeg) {
    opSeg.innerHTML = OP_MODES.map(m => `<button type="button" class="seg-btn" data-op-opt="${m}" onclick="setOpMode('${m}')">${esc(themeLabel(OP_MODE_LABEL[m]))}</button>`).join("");
  }
  const uiSeg = document.getElementById("uiModeSeg");
  if (uiSeg) {
    uiSeg.innerHTML = UI_MODES.map(m => `<button type="button" class="seg-btn" data-ui-opt="${m}" onclick="setUIMode('${m}')">${esc(themeLabel(UI_MODE_LABEL[m]))}</button>`).join("");
  }
  const swatches = document.getElementById("themeAccentSwatches");
  if (swatches) {
    swatches.innerHTML = THEME_ACCENTS.map(a => {
      const label = a.id === "theme" ? t("accentTheme") : themeLabel(a.label);
      const style = a.id === "theme" ? "" : ` style="--sw:${a.color}"`;
      return `<button type="button" class="swatch ${a.css}" data-theme-accent="${a.id}"${style} title="${esc(label)}" aria-label="${esc(label)}" onclick="setThemeAccent('${a.id}')"></button>`;
    }).join("") + `<span class="swatch-label">${esc(t("themeAccentHint"))}</span>`;
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
  document.querySelectorAll("#uiModeSeg [data-ui-opt]").forEach(el => el.classList.toggle("on", el.dataset.uiOpt === (settings.uiMode || "auto")));
  document.querySelectorAll("#opModeSeg [data-op-opt]").forEach(el => el.classList.toggle("on", el.dataset.opOpt === currentOpMode()));
}
function initTheme() {
  renderThemePanel();
  applyTheme();
  applyUIMode();
  /* v1.0.2（需求6/7）：操作模式要在首帧就落到 <html>，避免先按默认模式画一遍。 */
  applyOpMode();
}
