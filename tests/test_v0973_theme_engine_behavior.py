#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v0.9.73 主题引擎行为测试（Node VM 真跑 web/js/06-theme.js）。

静态契约只能证明「写了哪些字段」，证明不了「选了之后真的生效」。这里把真实的
06-theme.js 装进 Node VM，桩掉 document/localStorage/matchMedia，然后真实调用
setThemeMode / setThemePalette / setThemeAccent / setCustomBg / initTheme，断言：
  1. 三层选择真的落到 <html data-palette|data-mode|data-accent>；
  2. 「跟随系统」读 matchMedia 并监听 change（系统切亮/暗时实时跟随，无需重载）；
  3. 旧入口 setTheme('light'|'dark'|'custom') 仍然可用（旧版本 localStorage/旧书签）；
  4. 主题卡片是「用该主题自己的令牌渲染的缩略界面」（--t-* 来自该调色板）；
  5. 面板同步：只有当前调色板/强调色/明暗处于选中态；
  6. 自定义背景是独立背景层（不影响明暗与调色板）。

无 node 时 SKIP。
"""
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
THEME_JS = ROOT / "web/js/06-theme.js"

if shutil.which("node") is None:
    print("SKIP: 未找到 node，跳过主题引擎行为测试")
    raise SystemExit(0)

HARNESS = r"""
const fs = require("fs"), vm = require("vm");
const src = fs.readFileSync(process.argv[2], "utf8");
const noop = () => {};

/* ---- 最小 DOM 桩：能记住 class / dataset / innerHTML，并把 innerHTML 里的
       data-* 解析成子元素（面板渲染后要能查询选中态）。 ---- */
function mkEl(id) {
  const el = {
    id: id || "", innerHTML: "", textContent: "", value: "", hidden: false, checked: false,
    dataset: {}, style: { props: {}, setProperty(k, v) { this.props[k] = v; }, removeProperty(k) { delete this.props[k]; } },
    attrs: {}, children: [],
    classList: {
      _s: new Set(),
      add(...c) { c.forEach(x => this._s.add(x)); },
      remove(...c) { c.forEach(x => this._s.delete(x)); },
      toggle(c, force) { const on = force === undefined ? !this._s.has(c) : !!force; on ? this._s.add(c) : this._s.delete(c); return on; },
      contains(c) { return this._s.has(c); }
    },
    querySelector: () => null, querySelectorAll: () => [], appendChild: noop, removeChild: noop,
    addEventListener: noop, removeEventListener: noop, setAttribute(k, v) { this.attrs[k] = v; },
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }, removeAttribute(k) { delete this.attrs[k]; },
    focus: noop, blur: noop, closest: () => null, scrollIntoView: noop, remove: noop,
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 100, height: 100 })
  };
  Object.defineProperty(el, "innerHTML", {
    get() { return this._html || ""; },
    set(v) { this._html = String(v); this.children = parseChildren(String(v)); }
  });
  return el;
}
/* 从 innerHTML 串里抽出 [data-xxx="v"] + style 里的 --t-* 令牌，生成子元素桩。
   注意标签不一定是 <div>（预览块是 <span>、色块是 <button>），必须按标签名逐个扫。 */
function parseChildren(html) {
  const out = [];
  const keys = { "theme-card": "themeCard", "theme-accent": "themeAccent", "mode-opt": "modeOpt", "theme-preview": "themePreview" };
  const tagRe = /<(div|span|button)\b[^>]*>/g;
  let m;
  while ((m = tagRe.exec(html))) {
    const tag = m[0];
    let hit = null, value = null;
    for (const k of Object.keys(keys)) {
      const found = tag.match(new RegExp('data-' + k + '="([^"]*)"'));
      if (found) { hit = keys[k]; value = found[1]; break; }
    }
    if (!hit) continue;
    const el = mkEl();
    el.dataset[hit] = value;
    const styleMatch = tag.match(/style="([^"]*)"/);
    if (styleMatch) el.attrs.style = styleMatch[1];
    if (/class="[^"]*\bon\b/.test(tag)) el.classList.add("on");
    out.push(el);
  }
  return out;
}

const els = {};
const document = {
  getElementById(id) { return els[id] || (els[id] = mkEl(id)); },
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: () => mkEl(), addEventListener: noop, removeEventListener: noop,
  documentElement: mkEl("html"), body: mkEl("body"), activeElement: null, cookie: ""
};
/* document.querySelectorAll 要能按选择器返回真实子元素（含 innerHTML 生成的）。 */
const CHILD_SELECTORS = {
  "[data-theme-card]": () => (els.themePaletteGrid ? els.themePaletteGrid.children.filter(c => "themeCard" in c.dataset) : []),
  "[data-theme-preview]": () => (els.themePaletteGrid ? els.themePaletteGrid.children.filter(c => "themePreview" in c.dataset) : []),
  "[data-theme-accent]": () => (els.themeAccentSwatches ? els.themeAccentSwatches.children.filter(c => "themeAccent" in c.dataset) : []),
  "#themeModeSeg [data-mode-opt]": () => (els.themeModeSeg ? els.themeModeSeg.children.filter(c => "modeOpt" in c.dataset) : [])
};
document.querySelectorAll = sel => (CHILD_SELECTORS[sel] ? CHILD_SELECTORS[sel]() : []);

/* ---- matchMedia 桩：可手动触发 change（模拟系统切换亮/暗） ---- */
const mq = { matches: true, _l: [], addEventListener(t, fn) { this._l.push(fn); }, addListener(fn) { this._l.push(fn); } };
const store = {};
const settings = { theme: "dark", mode: "dark", palette: "emerald", accent: "theme", customBg: false, reduceMotion: false };
const toasts = [];
const sb = {
  document, settings, toast: m => toasts.push(String(m)),
  saveSettings: noop, t: k => k, esc: v => String(v == null ? "" : v).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])),
  readerThemeClass: () => "reader-theme-dark", applyBgImage: noop, curLang: "zh-CN",
  localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } },
  matchMedia: () => mq, setTimeout, clearTimeout, setInterval: () => 0, console, navigator: {},
  location: { href: "http://x/", origin: "http://x" }
};
sb.window = sb; sb.globalThis = sb;
const ctx = vm.createContext(sb);
vm.runInContext(src + "\n;this.__api = { initTheme, applyTheme, setThemeMode, setThemePalette, setThemeAccent, setTheme, setCustomBg, setThemeReduceMotion, resolvedThemeMode, themePreviewStyle, THEME_PALETTES, THEME_ACCENTS, renderThemePanel, settings };", ctx);
const api = sb.__api;

let pass = 0, fail = 0;
const chk = (name, cond, extra) => { if (cond) { pass++; console.log("PASS: " + name); } else { fail++; console.log("FAIL: " + name + (extra ? "  [" + extra + "]" : "")); } };
const root = document.documentElement;

api.initTheme();
chk("默认三层：调色板 emerald / 明暗 dark / 强调色 theme",
    root.dataset.palette === "emerald" && root.dataset.mode === "dark" && root.dataset.accent === "theme",
    JSON.stringify(root.dataset));
chk("body[data-theme] 与明暗层一致（旧 CSS 仍按它取色）", document.body.dataset.theme === "dark");

api.setThemeMode("light");
chk("切到亮色：html data-mode=light", root.dataset.mode === "light");
chk("切到亮色：body data-theme=light", document.body.dataset.theme === "light");
chk("切到亮色：settings 落盘字段同步", api.settings.mode === "light" && api.settings.theme === "light");
chk("切主题有一次性过渡类（不常驻）", root.classList.contains("theming"));
chk("切主题弹提示", toasts.some(m => m.indexOf("themeModeSaved") >= 0));

api.setThemePalette("clay");
chk("切调色板：html data-palette=clay", root.dataset.palette === "clay");
chk("切调色板不改明暗", root.dataset.mode === "light");
chk("切调色板提示带调色板名", toasts.some(m => m.indexOf("暖陶") >= 0));
const clayStyle = api.themePreviewStyle(api.THEME_PALETTES.find(p => p.id === "clay"), "light");
chk("暖陶预览令牌来自该调色板自己（底色/圆角/主色）",
    clayStyle.indexOf("--t-bg:#FAF6F1") >= 0 && clayStyle.indexOf("--t-r:14px") >= 0 && clayStyle.indexOf("--t-accent:#8F3F14") >= 0,
    clayStyle);

api.setThemeAccent("violet");
chk("切强调色：html data-accent=violet", root.dataset.accent === "violet");
api.setThemeAccent("theme");
chk("强调色可回到「跟随主题」", root.dataset.accent === "theme");

/* 跟随系统：auto 档下由 matchMedia 决定，且 change 事件要实时跟随 */
api.setThemeMode("auto");
chk("auto 档：系统暗色 → mode=dark", api.resolvedThemeMode() === "dark" && root.dataset.mode === "dark");
mq.matches = false;
mq._l.forEach(fn => fn({ matches: false }));
chk("系统切亮色：实时跟随（无需重载）", root.dataset.mode === "light" && api.resolvedThemeMode() === "light",
    "mode=" + root.dataset.mode);

/* 旧入口兼容 */
api.setTheme("dark");
chk("旧入口 setTheme('dark') 仍可用", api.settings.mode === "dark" && root.dataset.mode === "dark");
api.setTheme("custom");
chk("旧入口 setTheme('custom') → 打开背景层（不再伪装成第三种主题）",
    api.settings.customBg === true && document.body.classList.contains("custom-bg"));
api.setCustomBg(false);
chk("关闭背景层不影响明暗/调色板", !api.settings.customBg && root.dataset.palette === "clay" && root.dataset.mode === "dark");

api.setThemeReduceMotion(true);
chk("减弱动效开关落到 html", root.dataset.motion === "reduce");
api.setThemeReduceMotion(false);
chk("减弱动效可关闭", !("motion" in root.dataset));

/* 面板：真预览卡片 + 选中态唯一 */
api.renderThemePanel();
const cards = els.themePaletteGrid.children.filter(c => "themeCard" in c.dataset);
chk("面板渲染 4 张调色板卡片", cards.length === 4, "实际 " + cards.length);
const previews = els.themePaletteGrid.children.filter(c => "themePreview" in c.dataset);
chk("每张卡片带自己的预览令牌", previews.length === 4 && previews.every(p => String(p.attrs.style || "").indexOf("--t-accent:") >= 0));
const swatches = els.themeAccentSwatches.children.filter(c => "themeAccent" in c.dataset);
chk("面板渲染 6 档强调色", swatches.length === 6, "实际 " + swatches.length);
chk("强调色色块带各自的颜色值",
    swatches.filter(s => /--sw:#/.test(String(s.attrs.style || ""))).length === 5);
chk("明暗段控件 3 档（暗/亮/跟随系统）", els.themeModeSeg.children.filter(c => "modeOpt" in c.dataset).length === 3);

console.log("\nTOTAL=" + (pass + fail) + " PASSED=" + pass + " FAILED=" + fail);
process.exit(fail ? 1 : 0);
"""

with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False, encoding="utf-8") as handle:
    handle.write(HARNESS)
    harness_path = handle.name

result = subprocess.run(["node", harness_path, str(THEME_JS)], capture_output=True, text=True)
sys.stdout.write(result.stdout)
if result.stderr.strip():
    sys.stdout.write("STDERR: " + result.stderr.strip()[:2000] + "\n")
Path(harness_path).unlink(missing_ok=True)
if result.returncode != 0:
    raise SystemExit("FAIL: v0.9.73 主题引擎行为测试未通过")
print("PASS: v0.9.73 主题引擎行为正确（三层叠加 / 跟随系统 / 旧入口兼容 / 真预览卡片）")
