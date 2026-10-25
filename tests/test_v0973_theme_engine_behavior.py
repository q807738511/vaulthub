#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v1.0.9 主题引擎行为测试（Node VM 真跑 web/js/06-theme.js）。

本文件前身是 v0.9.73 的三层主题测试（调色板 × 明暗 × 强调色）。v1.0.9 按客户口径
把主题收敛成两层 —— **界面规格 × 明暗**，调色板 / 强调色 / 自定义背景三档设置整体移除，
所以这里的断言也跟着换成「规格是否真的带走整套主题定义」：

  1. initTheme 把 data-spec / data-mode / data-wallpaper / data-spec-player 落到 <html>；
  2. 切规格 = 换整套主题：SPEC_THEMES 里每套规格的配色/圆角/动效令牌各不相同；
  3. 壁纸跟着规格走：Apple=aerial / Emby=collage / Plex=ultrablur，关掉后落 off；
  4. 播放器皮肤跟着规格走：glass / osd / plex；
  5. 移除的三档设置真的不存在（函数未定义、面板不渲染、<html> 上不留 data-palette/accent）；
  6. 「跟随系统」读 matchMedia 并监听 change（系统切亮/暗时实时跟随，无需重载）；
  7. 旧入口 setTheme('dark'|'light'|'custom') 不再炸（custom 按暗色处理）。

无 node 时 SKIP。
"""
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

# v0.9.93：把仓库根显式传给 Node 夹具（默认的 /opt/data/vaulthub-github 可能指向旧的检出）。
import os as _os
_os.environ.setdefault("VH_ROOT", str(ROOT))
THEME_JS = ROOT / "web/js/06-theme.js"

if shutil.which("node") is None:
    print("SKIP: 未找到 node，跳过主题引擎行为测试")
    raise SystemExit(0)

HARNESS = r"""
const fs = require("fs"), vm = require("vm");
const src = fs.readFileSync(process.argv[2], "utf8");
const noop = () => {};

function mkEl(id) {
  const el = {
    id: id || "", innerHTML: "", textContent: "", value: "", hidden: false, checked: false,
    dataset: {},
    style: { props: {}, setProperty(k, v) { this.props[k] = v; }, removeProperty(k) { delete this.props[k]; } },
    attrs: {}, children: [],
    classList: {
      _s: new Set(),
      add(...c) { c.forEach(x => this._s.add(x)); },
      remove(...c) { c.forEach(x => this._s.delete(x)); },
      toggle(c, force) { const on = force === undefined ? !this._s.has(c) : !!force; on ? this._s.add(c) : this._s.delete(c); return on; },
      contains(c) { return this._s.has(c); }
    },
    querySelector: () => null, querySelectorAll: () => [], appendChild: noop, removeChild: noop,
    addEventListener: noop, removeEventListener: noop,
    /* 真浏览器里 setAttribute("data-x-y") 会同步 dataset.xY —— 桩必须照做，
       否则「代码用 setAttribute 落属性、测试读 dataset」这一对永远对不上。 */
    setAttribute(k, v) {
      this.attrs[k] = v;
      if (String(k).indexOf("data-") === 0) {
        const camel = String(k).slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        this.dataset[camel] = String(v);
      }
    },
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
    removeAttribute(k) {
      delete this.attrs[k];
      if (String(k).indexOf("data-") === 0) {
        const camel = String(k).slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        delete this.dataset[camel];
      }
    },
    hasAttribute(k) { return k in this.attrs; },
    focus: noop, blur: noop, closest: () => null, scrollIntoView: noop, remove: noop,
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 100, height: 100 })
  };
  Object.defineProperty(el, "innerHTML", {
    get() { return this._html || ""; },
    set(v) { this._html = String(v); this.children = parseChildren(String(v)); }
  });
  return el;
}
/* 从 innerHTML 串里抽出 data-op-opt / data-ui-opt / data-mode-opt，生成子元素桩。 */
function parseChildren(html) {
  const out = [];
  const keys = { "op-opt": "opOpt", "ui-opt": "uiOpt", "mode-opt": "modeOpt" };
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
  documentElement: mkEl("html"), body: mkEl("body"), activeElement: null, cookie: "",
  visibilityState: "visible"
};
const CHILD_SELECTORS = {
  "#themeModeSeg [data-mode-opt]": () => (els.themeModeSeg ? els.themeModeSeg.children.filter(c => "modeOpt" in c.dataset) : []),
  "#uiModeSeg [data-ui-opt]": () => (els.uiModeSeg ? els.uiModeSeg.children.filter(c => "uiOpt" in c.dataset) : []),
  "#opModeSeg [data-op-opt]": () => (els.opModeSeg ? els.opModeSeg.children.filter(c => "opOpt" in c.dataset) : [])
};
document.querySelectorAll = sel => (CHILD_SELECTORS[sel] ? CHILD_SELECTORS[sel]() : []);

const mq = { matches: true, _l: [], addEventListener(t, fn) { this._l.push(fn); }, addListener(fn) { this._l.push(fn); } };
const store = {};
const settings = { theme: "dark", mode: "dark", uiMode: "auto", opMode: "apple", wallpaper: true, reduceMotion: false };
const toasts = [];
const sb = {
  document, settings, toast: m => toasts.push(String(m)),
  saveSettings: noop, t: k => k,
  esc: v => String(v == null ? "" : v).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])),
  readerThemeClass: () => "reader-theme-dark", curLang: "zh-CN",
  localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } },
  matchMedia: () => mq, setTimeout, clearTimeout, setInterval: () => 0, console, navigator: {},
  location: { href: "http://x/", origin: "http://x" },
  innerWidth: 1280, openModal: noop, closeModal: noop
};
sb.window = sb; sb.globalThis = sb;
const ctx = vm.createContext(sb);
vm.runInContext(src + "\n;this.__api = { initTheme, applyTheme, applyOpMode, setOpMode, setThemeMode, setTheme, setSpecWallpaper, setThemeReduceMotion, resolvedThemeMode, renderThemePanel, syncThemeControls, SPEC_THEMES, SPEC_HIGHLIGHTS, OP_MODES, OP_ICON_PACK, currentOpMode, specThemeDef, wallpaperOn, settings };", ctx);
const api = sb.__api;

let pass = 0, fail = 0;
const chk = (name, cond, extra) => { if (cond) { pass++; console.log("PASS: " + name); } else { fail++; console.log("FAIL: " + name + (extra ? "  [" + extra + "]" : "")); } };
const root = document.documentElement;

api.initTheme();
chk("initTheme：data-spec=apple", root.dataset.spec === "apple", JSON.stringify(root.dataset));
chk("initTheme：data-mode=dark", root.dataset.mode === "dark");
chk("initTheme：data-wallpaper=aerial（Apple 航拍）", root.dataset.wallpaper === "aerial", root.dataset.wallpaper);
chk("initTheme：data-spec-player=glass", root.dataset.specPlayer === "glass", root.dataset.specPlayer);
chk("body[data-theme] 与明暗层一致（旧 CSS 仍按它取色）", document.body.dataset.theme === "dark");
chk("移除的旧属性不在 <html> 上", !root.hasAttribute("data-palette") && !root.hasAttribute("data-accent"));

/* 切规格 = 换整套主题 */
api.setOpMode("emby");
chk("切 Emby：data-spec=emby", root.dataset.spec === "emby");
chk("切 Emby：壁纸换成海报拼贴", root.dataset.wallpaper === "collage", root.dataset.wallpaper);
chk("切 Emby：播放器皮肤 osd（中央大播放键）", root.dataset.specPlayer === "osd", root.dataset.specPlayer);
chk("切 Emby：品牌绿锁定 #52B54B", api.SPEC_THEMES.emby.tokens.dark.accent === "#52B54B");
chk("切 Emby：Material 圆角 8px / 150ms", api.SPEC_THEMES.emby.tokens.dark.radius === "8px" && api.SPEC_THEMES.emby.tokens.dark.dur === "150ms");
chk("切规格弹提示（含「主题/壁纸/播放器已同步」）", toasts.some(m => m.indexOf("uiSpecSaved") >= 0));

api.setOpMode("plex");
chk("切 Plex：data-spec=plex", root.dataset.spec === "plex");
chk("切 Plex：壁纸换成 UltraBlur 取色", root.dataset.wallpaper === "ultrablur", root.dataset.wallpaper);
chk("切 Plex：播放器皮肤 plex", root.dataset.specPlayer === "plex", root.dataset.specPlayer);
chk("切 Plex：琥珀金 #E5A00D", api.SPEC_THEMES.plex.tokens.dark.accent === "#E5A00D");
chk("切 Plex：扁平圆角 6px / 140ms", api.SPEC_THEMES.plex.tokens.dark.radius === "6px" && api.SPEC_THEMES.plex.tokens.dark.dur === "140ms");

/* 三套规格的主题定义完整性：亮暗各一套，令牌齐全，文档路径与壁纸/播放器都给了 */
const REQUIRED = ["bg","bg2","card","card2","border","border2","track","text","text2","text3","accent","accentInk","accentDim","accentRing","accentGlow","radius","radiusSm","radiusLg","shadow","shadowLg","fontHead","dur","ease"];
const missing = [];
Object.keys(api.SPEC_THEMES).forEach(id => {
  const t = api.SPEC_THEMES[id];
  ["dark","light"].forEach(mode => {
    const tok = t.tokens[mode] || {};
    REQUIRED.forEach(k => { if (!tok[k]) missing.push(id + "." + mode + "." + k); });
  });
  if (!t.doc || t.doc.indexOf("/docs/specs/") !== 0) missing.push(id + ".doc");
  if (["aerial","collage","ultrablur"].indexOf(t.wallpaper) < 0) missing.push(id + ".wallpaper");
  if (["glass","osd","plex"].indexOf(t.player) < 0) missing.push(id + ".player");
});
chk("三套规格 × 亮暗 令牌齐全（23 个令牌 × 6 套）", missing.length === 0, missing.slice(0, 6).join(","));
chk("三套规格各自有壁纸种类（互不相同）",
    new Set(api.OP_MODES.map(id => api.SPEC_THEMES[id].wallpaper)).size === 3);
chk("三套规格各自有播放器皮肤（互不相同）",
    new Set(api.OP_MODES.map(id => api.SPEC_THEMES[id].player)).size === 3);
chk("三套规格各带 4 条元素清单（对应三份详解文档）",
    api.OP_MODES.every(id => (api.SPEC_HIGHLIGHTS[id] || []).length === 4));

/* 播放器图标：三套包都要覆盖播放器实际用到的图标名，否则切规格播放器还是默认图标 */
const PLAYER_ICONS = ["play","pause","prev","next","back10","fwd10","playlist","subtitles","close","fullscreen","collapse","restore","disc","info","details","copy"];
const iconGap = [];
api.OP_MODES.forEach(id => PLAYER_ICONS.forEach(n => { if (!api.OP_ICON_PACK[id][n]) iconGap.push(id + "." + n); }));
chk("三套图标包覆盖播放器全部图标（16 个 × 3 套）", iconGap.length === 0, iconGap.slice(0, 6).join(","));

/* 壁纸开关 */
api.setSpecWallpaper(false);
chk("关壁纸：data-wallpaper=off", root.dataset.wallpaper === "off", root.dataset.wallpaper);
chk("关壁纸：settings.wallpaper=false", api.settings.wallpaper === false);
api.setSpecWallpaper(true);
chk("开壁纸：回到当前规格的壁纸种类", root.dataset.wallpaper === "ultrablur", root.dataset.wallpaper);

/* 明暗 + 跟随系统 */
api.setThemeMode("light");
chk("切亮色：data-mode=light", root.dataset.mode === "light");
chk("切亮色：body data-theme=light", document.body.dataset.theme === "light");
chk("切亮色：settings 落盘字段同步", api.settings.mode === "light" && api.settings.theme === "light");
chk("切主题有一次性过渡类（不常驻）", root.classList.contains("theming"));
api.setThemeMode("auto");
chk("auto 档：系统暗色 → mode=dark", api.resolvedThemeMode() === "dark" && root.dataset.mode === "dark");
mq.matches = false;
mq._l.forEach(fn => fn({ matches: false }));
chk("系统切亮色：实时跟随（无需重载）", root.dataset.mode === "light" && api.resolvedThemeMode() === "light", "mode=" + root.dataset.mode);

/* 旧入口兼容 + 移除项 */
api.setTheme("dark");
chk("旧入口 setTheme('dark') 仍可用", api.settings.mode === "dark" && root.dataset.mode === "dark");
api.setTheme("custom");
chk("旧入口 setTheme('custom') 不再炸（按暗色处理，无背景层）",
    api.settings.mode === "dark" && typeof api.settings.customBg === "undefined");
chk("调色板/强调色/自定义背景三档函数已移除",
    typeof api.setThemePalette === "undefined" && typeof api.setThemeAccent === "undefined" && typeof api.setCustomBg === "undefined");
api.applyTheme();
chk("applyTheme 后 <html> 仍不留 data-palette/data-accent",
    !root.hasAttribute("data-palette") && !root.hasAttribute("data-accent"));

api.setThemeReduceMotion(true);
chk("减弱动效开关落到 html", root.dataset.motion === "reduce");
api.setThemeReduceMotion(false);
chk("减弱动效可关闭", !("motion" in root.dataset));

/* 面板：规格卡 3 张、操作模式 4 张、明暗 3 档；调色板网格与强调色块不再渲染 */
api.renderThemePanel();
chk("面板渲染 3 张界面规格卡", els.opModeSeg.children.filter(c => "opOpt" in c.dataset).length === 3,
    "实际 " + els.opModeSeg.children.filter(c => "opOpt" in c.dataset).length);
chk("面板渲染 4 张操作模式卡", els.uiModeSeg.children.filter(c => "uiOpt" in c.dataset).length === 4,
    "实际 " + els.uiModeSeg.children.filter(c => "uiOpt" in c.dataset).length);
chk("明暗段控件 3 档（暗/亮/跟随系统）", els.themeModeSeg.children.filter(c => "modeOpt" in c.dataset).length === 3);
chk("调色板网格不再渲染", !els.themePaletteGrid || els.themePaletteGrid.innerHTML === "");
chk("强调色色块不再渲染", !els.themeAccentSwatches || els.themeAccentSwatches.innerHTML === "");

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
    raise SystemExit("FAIL: v1.0.9 主题引擎行为测试未通过")
print("PASS: v1.0.9 主题引擎行为正确（规格=主题轴 / 壁纸随规格 / 播放器皮肤随规格 / 三档设置已移除）")
