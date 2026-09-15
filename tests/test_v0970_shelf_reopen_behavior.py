#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v0.9.70 书架「已读收藏」重新展开的行为级测试。

背景：用户报告漫画/电子书标记已读后，进入「已读收藏」再返回时列表无法重新展开。
静态断言只能证明代码写法，无法证明行为，因此本测试把真实的 web/js/02-media.js
加载进 Node，用桩 document/localStorage/fetch 真实执行 loadLocalFiles，断言：
  1. 未读视图只显示未读，且一次展开全部未读（不因单页全已读而空白）；
  2. 已读收藏视图能展开全部已读书籍；
  3. 切回未读视图仍然可用（修复前会卡住）；
  4. 请求里不再出现 limit=100000 之类的超大分页。

无 node 环境时以 SKIP 退出（不影响其它契约测试）。
"""
import json
import shutil
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MEDIA = ROOT / "web/js/02-media.js"

if shutil.which("node") is None:
    print("SKIP: 未找到 node，跳过已读收藏行为测试")
    raise SystemExit(0)

HARNESS = r"""
const fs = require("fs"), vm = require("vm");
const src = fs.readFileSync(process.argv[2], "utf8");
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
const document = {
  getElementById: id => (els[id] || (els[id] = fakeEl())),
  querySelector: () => null, querySelectorAll: () => [], createElement: () => fakeEl(),
  addEventListener: noop, removeEventListener: noop, body: fakeEl(),
  documentElement: fakeEl(), activeElement: null, fullscreenElement: null, cookie: ""
};
const FILES = [];
for (let i = 1; i <= 45; i++) FILES.push({ path: "/MH/book-" + String(i).padStart(2, "0") + ".cbz", size: 1024 * i });
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
  /* 01-state.js / 05-home.js 提供的全局工具：行为测试只需要等价桩。 */
  esc: v => String(v == null ? "" : v).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])),
  displayBookTitle: p => String(p).split("/").pop().replace(/\.[^.]+$/, ""),
  coverGradient: () => "linear-gradient(#111,#222)",
  formatFileSize: () => "1 MB",
  formatHomeBytes: () => "1 MB",
  movieMetadataFor: () => ({}), audioMetadataFor: () => ({}), audioBaseMetadata: () => ({}),
  movieHeroArt: () => ({ url: "" }), findExternalService: () => null, externalServicesForGroup: () => [],
  settings: { theme: "dark", hardwareAcceleration: "auto", language: "zh" },
  setTimeout, clearTimeout, setInterval: () => 0, clearInterval: noop,
  navigator: {}, location: { href: "http://x/", origin: "http://x" },
  alert: noop, confirm: () => true, URL, URLSearchParams,
  Blob: function () {}, Image: function () { return {}; },
  requestAnimationFrame: noop, removeEventListener: noop,
  performance: { now: () => 0 }, history: {}, screen: {},
  matchMedia: () => ({ matches: false, addEventListener: noop }),
  CustomEvent: function () {}, Event: function () {}
};
sb.window = sb; sb.globalThis = sb;
const ctx = vm.createContext(sb);
vm.runInContext(src + "\n;this.__api = { loadLocalFiles, setComicShelfView, localMediaLibraries, localMediaSelection, readingProgressCache, getShelfView: () => comicShelfView };", ctx);
const api = sb.__api;
const target = document.getElementById("local-media-content-comic");
const wait = () => new Promise(r => setTimeout(r, 80));
const countCards = () => (target.innerHTML.match(/class="book-card"/g) || []).length;
let pass = 0, fail = 0;
const chk = (name, cond, extra) => {
  if (cond) { pass++; console.log("PASS: " + name); }
  else { fail++; console.log("FAIL: " + name + (extra ? " | " + extra : "")); }
};
(async () => {
  api.localMediaLibraries.push({ id: "c1", name: "漫画", type: "comic", path: "/MH" });
  const lib = api.localMediaLibraries[0];
  /* 真实交互里 setComicShelfView 会按 localMediaSelection 找到当前库再重载，
     行为测试必须还原这一步，否则切页签根本不会触发重新加载。 */
  api.localMediaSelection.comic = "c1";

  await api.loadLocalFiles("comic", lib, 0);
  chk("默认进入未读视图", api.getShelfView() === "shelf");
  chk("未读视图展开全部未读（25 条）", countCards() === 25, "实际 " + countCards());
  chk("未读视图不含已读书籍", !target.innerHTML.includes("book-01.cbz") && !target.innerHTML.includes("book-20.cbz"));
  chk("未读视图含靠后的未读书籍", target.innerHTML.includes("book-45.cbz"));
  chk("未读视图未出现空页提示", !target.innerHTML.includes("本页无匹配"));

  api.setComicShelfView("completed");
  await wait();
  chk("已读收藏视图可展开", api.getShelfView() === "completed");
  chk("已读收藏展开全部已读（20 条）", countCards() === 20, "实际 " + countCards());
  chk("已读收藏含第一本已读", target.innerHTML.includes("book-01.cbz"));
  chk("已读收藏不含未读", !target.innerHTML.includes("book-45.cbz"));
  chk("已读收藏未出现空页提示", !target.innerHTML.includes("本页无匹配"));

  api.setComicShelfView("shelf");
  await wait();
  chk("可切回未读视图", api.getShelfView() === "shelf" && countCards() === 25, "实际 " + countCards());

  api.setComicShelfView("completed");
  await wait();
  api.setComicShelfView("completed");
  await wait();
  chk("重复点击已读收藏仍可展开", countCards() === 20, "实际 " + countCards());

  chk("没有超大分页请求", !requests.some(u => /limit=(100000|10000[0-9])/.test(u)));
  const fileReqs = requests.filter(u => u.includes("/api/media/files"));
  chk("按游标分页拉取完整索引", fileReqs.length >= 4, "请求数 " + fileReqs.length);
  chk("分页请求均为常规上限", fileReqs.every(u => /limit=(20|500)/.test(u)), fileReqs.join(" "));
  console.log("SUMMARY pass=" + pass + " fail=" + fail);
  process.exit(fail ? 1 : 0);
})();
"""

with tempfile.TemporaryDirectory() as tmp:
    js = Path(tmp) / "harness.js"
    js.write_text(HARNESS, encoding="utf-8")
    proc = subprocess.run(["node", str(js), str(MEDIA)], capture_output=True, text=True, timeout=120)
print(proc.stdout.strip())
if proc.returncode != 0:
    print(proc.stderr.strip()[-1500:])
    raise SystemExit("FAIL: v0.9.70 已读收藏展开行为测试未通过")
print("PASS: v0.9.70 已读收藏/未读视图展开行为契约通过")