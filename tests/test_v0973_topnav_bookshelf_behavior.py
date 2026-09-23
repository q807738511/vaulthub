#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v0.9.75 书刊展示页 + 顶栏导航的行为级测试。

静态断言只能证明「代码这么写」，证明不了「用户会看到什么」。这里把真实的
web/js/02-media.js 与 web/js/07-topnav.js 一并载入 Node，用桩 document /
localStorage / fetch 真实执行渲染路径，断言：

  1. 书刊页有三个书架标签（书架 / 喜欢 / 🕘 历史阅读，v0.9.75 移除「全部」），计数正确；
  2. 默认是「完整展开」（v0.9.70 的展开保证不能被分页吞掉）；
  3. 喜欢（收藏）按钮真的写进 localStorage，取消收藏后从「喜欢」里消失；
  4. 开启分页浏览后按每页数量切片，翻页是纯本地操作（不再打服务端）；
  5. 排序 / 网格密度 / 视图设置真的落到偏好并影响渲染；
  6. 顶栏媒体库标签按真实媒体库渲染，高亮按 data-nav-key 精确匹配；
  7. 布局模式（顶部导航 / 侧边导航）落 body 类与 localStorage。

无 node 环境时以 SKIP 退出（不影响其它契约测试）。
"""
import shutil
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MEDIA = ROOT / "web/js/02-media.js"
TOPNAV = ROOT / "web/js/07-topnav.js"

if shutil.which("node") is None:
    print("SKIP: 未找到 node，跳过 v0.9.75 行为测试")
    raise SystemExit(0)

HARNESS = r"""
const fs = require("fs"), vm = require("vm");
const mediaSrc = fs.readFileSync(process.argv[2], "utf8");
const topnavSrc = fs.readFileSync(process.argv[3], "utf8");
const noop = () => {};
function fakeEl() {
  return {
    innerHTML: "", textContent: "", value: "", style: {}, dataset: {}, children: [],
    classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    querySelector: () => null, querySelectorAll: () => [], appendChild: noop,
    removeChild: noop, addEventListener: noop, removeEventListener: noop,
    setAttribute: noop, getAttribute: () => null, removeAttribute: noop,
    focus: noop, blur: noop, closest: () => null, scrollIntoView: noop,
    insertAdjacentHTML: noop, remove: noop, offsetParent: null, parentNode: null,
    isConnected: false, scrollTop: 0, scrollHeight: 0, clientHeight: 0,
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0 })
  };
}
const els = {};
/* body 需要真实的 classList，用来观察布局模式 */
const bodyClasses = new Set();
const body = fakeEl();
body.classList = {
  add: c => bodyClasses.add(c), remove: c => bodyClasses.delete(c),
  toggle: (c, on) => { if (on === undefined) { bodyClasses.has(c) ? bodyClasses.delete(c) : bodyClasses.add(c); } else if (on) bodyClasses.add(c); else bodyClasses.delete(c); },
  contains: c => bodyClasses.has(c)
};
/* 顶栏媒体库标签：syncTopLibTabs 只认 data-nav-key，这里造三个可观察的标签 */
function mkTab(key) {
  return { dataset: { navKey: key }, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } };
}
const fakeTabs = [mkTab("audio:m1"), mkTab("comic:c1"), mkTab("comic:b1")];
/* 已渲染的书架标签（文案形如「喜欢 0」），用来观察原地刷新 */
const fakeSegButtons = [
  { textContent: "书架 25" }, { textContent: "喜欢 0" },
  { textContent: "🕘 历史阅读 20" }
];
const document = {
  getElementById: id => (els[id] || (els[id] = fakeEl())),
  querySelector: () => null,
  querySelectorAll: sel => {
    const s = String(sel);
    if (s.includes("#topLibTabs")) return fakeTabs;
    /* 书架工具栏标签：syncBookLikeTabCount 就地改文案时找的就是这几个按钮 */
    if (s.includes(".pn-toolbar") && s.includes(".seg button")) return fakeSegButtons;
    return [];
  },
  createElement: () => fakeEl(), addEventListener: noop, removeEventListener: noop,
  body, documentElement: fakeEl(), activeElement: null, fullscreenElement: null, cookie: ""
};
const FILES = [];
for (let i = 1; i <= 45; i++) FILES.push({ path: "/MH/book-" + String(i).padStart(2, "0") + ".cbz", size: 1024 * i, mtime: 1700000000 + i });
const READ = new Set(FILES.slice(0, 20).map(f => f.path));
const requests = [];
async function fetch(url) {
  const u = String(url);
  requests.push(u);
  if (u.startsWith("/api/media/files")) {
    const q = new URL("http://x" + u);
    const offset = Number(q.searchParams.get("offset") || 0);
    const limit = Number(q.searchParams.get("limit") || 20);
    const slice = FILES.slice(offset, offset + limit);
    return { ok: true, status: 200, json: async () => ({ files: slice, total: FILES.length, has_more: offset + slice.length < FILES.length, status: "ready" }) };
  }
  if (u.startsWith("/api/media/reading/progress")) {
    const items = {};
    READ.forEach(p => { items[p] = { progress: 100, page: 9, total: 9 }; });
    return { ok: true, status: 200, json: async () => ({ items }) };
  }
  return { ok: true, status: 200, json: async () => ({}) };
}
const store = {};
const sb = {
  localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } },
  sessionStorage: { getItem: () => null, setItem: noop, removeItem: noop },
  document, fetch, toast: noop, t: k => k, console,
  esc: v => String(v == null ? "" : v).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])),
  displayBookTitle: p => String(p).split("/").pop().replace(/\.[^.]+$/, ""),
  coverGradient: () => "linear-gradient(#111,#222)",
  formatFileSize: n => Math.round(Number(n) / 1024) + " KB",
  formatHomeBytes: () => "1 MB", formatHomeCount: n => String(n),
  homeGroupOfType: t => (t === "comic" || t === "book") ? "comic" : (t === "movie" || t === "series") ? "movie" : "audio",
  openHomeLibrary: noop, openExternalService: noop, openLocalMediaButton: noop,
  movieMetadataFor: () => ({}), audioMetadataFor: () => ({}), audioBaseMetadata: () => ({}),
  movieHeroArt: () => ({ url: "" }), findExternalService: () => null, externalServicesForGroup: () => [],
  externalServices: [{ id: "e1", name: "动漫", group: "movie" }],
  homeIndexStatus: { c1: { total: 45, state: "ready", ended_at: Math.floor(Date.now() / 1000) - 120 } },
  settings: { theme: "dark", hardwareAcceleration: "auto", language: "zh" },
  saveSettings: () => { store["dwu_settings"] = JSON.stringify(sb.settings); },
  openSettingsPage: noop, logoutVaultHub: noop,
  themePaletteDef: () => ({ id: "emerald", zh: "青瓷" }), themeAccentDef: () => ({ id: "theme", zh: "跟随主题" }),
  VAULTHUB_ASSET_VERSION: "0.9.73",
  setTimeout, clearTimeout, setInterval: () => 0, clearInterval: noop,
  navigator: {}, location: { href: "http://x/", origin: "http://x" },
  alert: noop, confirm: () => true, URL, URLSearchParams,
  Blob: function () {}, Image: function () { return {}; },
  requestAnimationFrame: noop, removeEventListener: noop,
  performance: { now: () => 0 }, history: {}, screen: {},
  matchMedia: () => ({ matches: false, addEventListener: noop }),
  CustomEvent: function () {}, Event: function () {}, CSS: { escape: s => String(s).replace(/["\\]/g, "\\$&") }
};
sb.window = sb; sb.globalThis = sb;
const ctx = vm.createContext(sb);
vm.runInContext(mediaSrc + "\n" + topnavSrc + `
;this.__api = {
  loadLocalFiles, setBookShelfTab, setComicShelfView, toggleBookFavorite, readBookFavorites,
  gotoBookShelfPage, setBookPageSize, cycleBookSort, setBookCols, cycleBookDensity,
  bookShelfPrefs, renderTopLibTabs, syncTopLibTabs, setLayoutMode, currentLayoutMode, toggleBookFavButtons,
  localMediaLibraries, localMediaSelection, externalServices, getTab: () => bookShelfTab, getPage: () => bookShelfPage
};`, ctx);
const api = sb.__api;
const target = document.getElementById("local-media-content-comic");
const tabsHost = document.getElementById("topLibTabs");
const wait = () => new Promise(r => setTimeout(r, 80));
const countCards = () => (target.innerHTML.match(/class="book-card"/g) || []).length;
const paths = () => (target.innerHTML.match(/data-media-path="([^"]+)"/g) || []).map(s => s.slice(18, -1));
let pass = 0, fail = 0;
const chk = (name, cond, extra) => {
  if (cond) { pass++; console.log("PASS: " + name); }
  else { fail++; console.log("FAIL: " + name + (extra ? " | " + extra : "")); }
};
(async () => {
  api.localMediaLibraries.push({ id: "c1", name: "漫画", type: "comic", path: "/MH" });
  api.localMediaLibraries.push({ id: "b1", name: "电子书", type: "book", path: "/TXT" });
  /* 外连服务与本地库同一份顶栏数据源（02-media.js 自己的 externalServices 才是真值）。 */
  api.externalServices.push({ id: "e1", name: "动漫", group: "movie" });
  api.localMediaSelection.comic = "c1";
  const lib = api.localMediaLibraries[0];

  await api.loadLocalFiles("comic", lib, 0);
  const html = () => target.innerHTML;
  chk("页头显示库名", html().includes("<h1>漫画</h1>"));
  chk("页头元信息含本视图/全库与路径", html().includes("本视图 <b>25</b> 本") && html().includes("全库 <b>45</b> 本") && html().includes("<code>/MH</code>"));
  chk("页头含扫描时间", html().includes("上次扫描"));
  chk("三个书架标签齐备（书架/喜欢/历史阅读，无全部）", ["书架", "喜欢", "🕘 历史阅读"].every(x => html().includes(">" + x) || html().includes(x)) && !html().includes(">全部"));
  chk("标签带计数", html().includes("书架 25") && html().includes("喜欢 0") && html().includes("历史阅读 20"));
  chk("默认书架视图（扫描文件统一进书架）", api.getTab() === "shelf");
  chk("默认完整展开（不截断）", countCards() === 25, "实际 " + countCards());
  chk("默认不显示分页器", !html().includes('aria-current="page"') && html().includes("已展开全部 25 本"));
  chk("书架视图不含已读书", !html().includes("book-01.cbz"));
  chk("封面带喜欢按钮", html().includes('class="book-card-fav '));
  chk("卡片带阅读入口", html().includes("book-card-open"));
  chk("视图设置浮层齐备", html().includes('id="bookViewSet"') && html().includes("分页浏览") && html().includes("网格密度"));

  /* 喜欢：写 localStorage → 计数与视图跟着变 */
  api.toggleBookFavorite("c1", "/MH/book-30.cbz");
  api.toggleBookFavorite("c1", "/MH/book-31.cbz");
  const favs = api.readBookFavorites();
  chk("喜欢写入 localStorage", favs["c1::/MH/book-30.cbz"] === true && Object.keys(favs).length === 2);
  /* 点完心形标签上的计数必须立刻变（否则看起来像没生效）。 */
  const likeBtn = fakeSegButtons.find(b => (b.textContent || "").trim().startsWith("喜欢"));
  chk("喜欢计数就地刷新（无需重载）", (likeBtn.textContent || "").trim() === "喜欢 2", likeBtn.textContent);
  await api.loadLocalFiles("comic", lib, 0);
  chk("喜欢计数进入标签", html().includes("喜欢 2"));
  api.setBookShelfTab("like");
  await wait();
  chk("喜欢视图只显示收藏", countCards() === 2, "实际 " + countCards());
  chk("喜欢视图内容是收藏过的书", html().includes("book-30.cbz") && html().includes("book-31.cbz"));
  api.toggleBookFavorite("c1", "/MH/book-30.cbz");
  await wait();
  chk("取消收藏后从喜欢里消失", countCards() === 1 && !html().includes("book-30.cbz"), "实际 " + countCards());

  api.setBookShelfTab("completed");
  await wait();
  chk("历史阅读视图只显示已读", countCards() === 20, "实际 " + countCards());
  chk("历史阅读仍带释放按钮", html().includes("book-card-release"));
  /* v0.9.75：「全部」标签已移除；setBookShelfTab 对未知标签回退到书架。 */
  api.setBookShelfTab("all");
  await wait();
  chk("移除的『全部』标签回退到书架视图", api.getTab() === "shelf" && countCards() === 25, "实际 " + countCards());

  /* 分页浏览：显式开启后才切片，翻页纯本地 */
  const before = requests.filter(u => u.includes("/api/media/files")).length;
  api.setBookPageSize(20);
  await wait();
  chk("开启分页后每页 20 本", countCards() === 20, "实际 " + countCards());
  chk("分页器高亮第 1 页", html().includes('aria-current="page"'));
  chk("分页器统计正确", html().includes("每页 20 · 共 25 本"));
  api.gotoBookShelfPage(1);
  await wait();
  chk("第 2 页剩余 5 本", countCards() === 5, "实际 " + countCards());
  chk("第 2 页高亮页码 2", html().includes(">2</button>") && html().includes('aria-current="page"'));
  chk("翻页不再请求服务端", requests.filter(u => u.includes("/api/media/files")).length === before);
  api.gotoBookShelfPage(0);
  await wait();
  chk("回到第 1 页", api.getPage() === 0 && countCards() === 20);
  api.setBookPageSize(0);
  await wait();
  chk("关闭分页后恢复完整展开", countCards() === 25, "实际 " + countCards());

  /* 排序 / 密度 */
  api.cycleBookSort();
  await wait();
  chk("排序切到添加时间并影响渲染", api.bookShelfPrefs().sort === "mtime" && paths()[0].endsWith("book-45.cbz"), paths()[0]);
  api.cycleBookSort();
  await wait();
  chk("再切到文件大小（最大的在前）", api.bookShelfPrefs().sort === "size" && paths()[0].endsWith("book-45.cbz"));
  api.setBookCols(4);
  await wait();
  chk("网格密度写入偏好与内联变量", api.bookShelfPrefs().cols === 4 && html().includes("--cols:4"));
  api.cycleBookDensity();
  chk("密度按钮按 宽松4 → 紧凑6 循环", api.bookShelfPrefs().cols === 6, String(api.bookShelfPrefs().cols));

  /* 封面收藏按钮可整列隐藏（视图设置里的开关） */
  api.toggleBookFavButtons();
  await wait();
  chk("隐藏收藏按钮后网格不再有心形", !html().includes("book-card-fav") && api.bookShelfPrefs().showFav === false);
  api.toggleBookFavButtons();
  await wait();
  chk("再次显示收藏按钮", html().includes("book-card-fav"));

  /* 顶栏媒体库标签 */
  api.renderTopLibTabs();
  const tabs = tabsHost.innerHTML;
  chk("顶栏渲染真实媒体库", tabs.includes("漫画") && tabs.includes("电子书") && tabs.includes("动漫"));
  chk("标签带唯一 data-nav-key", tabs.includes('data-nav-key="comic:c1"') && tabs.includes('data-nav-key="comic:b1"'));
  chk("同组媒体库可区分（漫画/电子书）", tabs.includes('data-nav-key="comic:b1"') && tabs.includes('data-view="comic"'));
  chk("外连服务带外链标记", tabs.includes("🔗"));
  chk("标签带条目计数", tabs.includes('<span class="cnt">45</span>'));
  chk("默认无高亮", tabs.includes('aria-current="false"'));
  api.syncTopLibTabs("comic:b1");
  const states = fakeTabs.map(t => t.attrs["aria-current"]);
  chk("高亮精确落在同组的目标库上", states.join(",") === "false,false,true", states.join(","));

  /* 布局模式 */
  api.setLayoutMode("sidebar");
  chk("切到侧边导航时 body 类与偏好同步", !bodyClasses.has("layout-topnav") && JSON.parse(store["dwu_settings"]).layout === "sidebar");
  api.setLayoutMode("topnav");
  chk("切回顶部导航", bodyClasses.has("layout-topnav") && api.currentLayoutMode() === "topnav");

  console.log("SUMMARY pass=" + pass + " fail=" + fail);
  process.exit(fail ? 1 : 0);
})();
"""

with tempfile.TemporaryDirectory() as tmp:
    harness = Path(tmp) / "harness.js"
    harness.write_text(HARNESS, encoding="utf-8")
    proc = subprocess.run(["node", str(harness), str(MEDIA), str(TOPNAV)],
                          capture_output=True, text=True, timeout=180)
print(proc.stdout.strip())
if proc.returncode != 0:
    print(proc.stderr.strip()[-2000:])
    raise SystemExit("v0.9.75 行为测试未通过")
print("v0.9.75 书刊展示页 + 顶栏导航行为测试通过")
