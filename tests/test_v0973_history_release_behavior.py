#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v0.9.73 行为测试：历史阅读「释放」真的生效 + 播放列表面板操作队列。

用户报告「电子书及漫画的已读收藏释放依旧故障」。静态断言只能证明写了 DELETE 字样，
证明不了「点下去之后条目真的从书架消失」。本测试把真实的 web/js/02-media.js 装进
Node VM，用桩 fetch 维护一个可变的服务端进度库，真实调用：

  1. releaseBookFromHistory() → 必须发出 DELETE、服务端条目消失、内存缓存与
     localStorage 残留一起清掉、书架「历史阅读」视图里该卡片随即消失（19 张）；
  2. 释放后再标记已读 → 变成 PUT（两态开关在同一入口上）；
  3. 播放列表：移除靠前曲目后当前索引要左移（否则连播跳歌）、清空队列后面板回到空态。

无 node 时 SKIP。
"""
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MEDIA_JS = ROOT / "web/js/02-media.js"

if shutil.which("node") is None:
    print("SKIP: 未找到 node，跳过历史阅读释放行为测试")
    raise SystemExit(0)

HARNESS = r"""
const fs = require("fs"), vm = require("vm");
const src = fs.readFileSync(process.argv[2], "utf8");
const noop = () => {};
function mkEl(id) {
  const el = {
    id: id || "", _html: "", textContent: "", value: "", hidden: false, checked: false,
    dataset: {}, attrs: {}, children: [],
    style: { props: {}, setProperty(k, v) { this.props[k] = v; }, removeProperty(k) { delete this.props[k]; } },
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
  Object.defineProperty(el, "innerHTML", { get() { return this._html; }, set(v) { this._html = String(v); } });
  return el;
}
const els = {};
const document = {
  getElementById(id) { return els[id] || (els[id] = mkEl(id)); },
  querySelector: () => null, querySelectorAll: () => [], createElement: () => mkEl(),
  addEventListener: noop, removeEventListener: noop, body: mkEl("body"),
  documentElement: mkEl("html"), activeElement: null, fullscreenElement: null, cookie: ""
};

const FILES = [];
for (let i = 1; i <= 45; i++) FILES.push({ path: "/MH/book-" + String(i).padStart(2, "0") + ".cbz", size: 1024 * i });
/* 服务端阅读进度库（可变）：先有 20 本已读 */
const SERVER = {};
FILES.slice(0, 20).forEach(f => { SERVER[f.path] = { progress: 100, page: 9, total: 9 }; });
const CALLS = [];
async function fetch(url, options) {
  const u = String(url);
  const method = (options && options.method) || "GET";
  CALLS.push(method + " " + u);
  const q = new URL("http://x" + u);
  if (u.startsWith("/api/media/files")) {
    const offset = Number(q.searchParams.get("offset") || 0);
    const limit = Number(q.searchParams.get("limit") || 20);
    const slice = FILES.slice(offset, offset + limit);
    return { ok: true, status: 200, json: async () => ({ files: slice, total: FILES.length, has_more: offset + slice.length < FILES.length, status: "ready" }) };
  }
  if (u.startsWith("/api/media/reading/progress")) {
    const path = q.searchParams.get("path");
    if (method === "PUT") {
      const body = JSON.parse((options && options.body) || "{}");
      SERVER[path] = { progress: body.progress === undefined ? 0 : body.progress, page: body.page || 0, total: body.total || 0 };
      return { ok: true, status: 200, json: async () => SERVER[path] };
    }
    if (method === "DELETE") {
      const removed = Object.prototype.hasOwnProperty.call(SERVER, path);
      delete SERVER[path];
      return { ok: true, status: 200, json: async () => ({ ok: true, removed }) };
    }
    const items = {};
    Object.keys(SERVER).forEach(k => { items[k] = SERVER[k]; });
    return { ok: true, status: 200, json: async () => ({ id: "lib-books", items }) };
  }
  return { ok: true, status: 200, json: async () => ({}) };
}
const store = {};
const toasts = [];
const sb = {
  localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } },
  sessionStorage: { getItem: () => null, setItem: noop, removeItem: noop },
  document, fetch, toast: m => toasts.push(String(m)), t: k => k, console,
  sessionWriteHeaders: () => ({}), handleProtectedResponse: async () => true,
  esc: v => String(v == null ? "" : v).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])),
  displayBookTitle: p => String(p).split("/").pop().replace(/\.[^.]+$/, ""),
  coverGradient: () => "linear-gradient(#111,#222)",
  formatFileSize: () => "1 MB", formatHomeBytes: () => "1 MB",
  movieMetadataFor: () => ({}), audioBaseMetadata: () => ({}),
  audioMetadataFor: p => ({ title: String(p).split("/").pop().replace(/\.[^.]+$/, ""), artist: "歌手", album: "专辑" }),
  movieHeroArt: () => ({ url: "" }), findExternalService: () => null, externalServicesForGroup: () => [],
  settings: { theme: "dark", hardwareAcceleration: "auto" },
  setTimeout, clearTimeout, setInterval: () => 0, clearInterval: noop,
  navigator: {}, location: { href: "http://x/", origin: "http://x" },
  alert: noop, confirm: () => true, URL, URLSearchParams, prompt: () => "",
  Blob: function () {}, Image: function () { return {}; },
  requestAnimationFrame: noop, performance: { now: () => 0 }, history: {}, screen: {},
  matchMedia: () => ({ matches: false, addEventListener: noop }),
  CustomEvent: function () {}, Event: function () {}, AbortController: function () { this.abort = noop; this.signal = null; }
};
sb.window = sb; sb.globalThis = sb;
const ctx = vm.createContext(sb);
const EXPOSE = `
;this.__api = {
  loadLocalFiles, setComicShelfView, releaseBookFromHistory, releaseReadingState, markReaderCompleted,
  renderAudioPlaylistPanel, removeAudioQueueIndex, clearAudioQueue, openAudioPlaylistPanel, audioPlaylistPanelOpen,
  localMediaLibraries, localMediaSelection, readingProgressCache, readingProgressPending, mediaStateKey, flushReadingProgressNow,
  getShelfView: () => comicShelfView,
  setReader: v => { activeReader = v; },
  setQueue: (files, active) => { audioFiles = files; activeAudio = active; },
  getQueue: () => audioFiles, getActive: () => activeAudio
};`;
vm.runInContext(src + EXPOSE, ctx);
const api = sb.__api;

api.localMediaLibraries.push({ id: "lib-books", name: "书架", type: "comic", path: "/MH" });
api.localMediaSelection.comic = "lib-books";
const target = document.getElementById("local-media-content-comic");
const panelList = document.getElementById("audioPlaylistList");
const wait = () => new Promise(r => setTimeout(r, 120));
const countCards = () => (target.innerHTML.match(/class="book-card"/g) || []).length;
let pass = 0, fail = 0;
const chk = (name, cond, extra) => { if (cond) { pass++; console.log("PASS: " + name); } else { fail++; console.log("FAIL: " + name + (extra ? "  [" + extra + "]" : "")); } };

(async () => {
  const lib = api.localMediaLibraries[0];

  /* ---------- 历史阅读视图 ---------- */
  api.setComicShelfView("completed");
  await api.loadLocalFiles("comic", lib, 0);
  await wait();
  chk("历史阅读视图展开全部 20 本已读", countCards() === 20, "实际 " + countCards());
  chk("历史阅读卡片带「↩ 释放」按钮", target.innerHTML.indexOf("book-card-release") >= 0);
  chk("历史阅读不含未读", target.innerHTML.indexOf("book-45.cbz") < 0);
  /* 服务端已读 → 书架进度来自服务端，而不是本地残留 */
  chk("已读判定来自服务端进度库", Object.keys(SERVER).length === 20);

  /* ---------- 释放一本 ---------- */
  const path = "/MH/book-01.cbz";
  store[api.mediaStateKey("lib-books", path)] = JSON.stringify({ progress: 100, page: 9, total: 9 });
  toasts.length = 0;
  CALLS.length = 0;
  await api.releaseBookFromHistory("lib-books", path);
  await wait();
  chk("释放发出 DELETE 到阅读进度端点",
      CALLS.some(c => c.startsWith("DELETE /api/media/reading/progress?id=lib-books&path=%2FMH%2Fbook-01.cbz")),
      CALLS.join(" | "));
  chk("服务端条目真的消失", !Object.prototype.hasOwnProperty.call(SERVER, path));
  chk("内存缓存同步清掉", !(api.readingProgressCache["lib-books"] || {})[path]);
  chk("localStorage 残留一起清掉（否则下次读取又变已读）", !(api.mediaStateKey("lib-books", path) in store));
  chk("书架历史阅读视图里该卡片已消失", countCards() === 19 && target.innerHTML.indexOf("book-01.cbz") < 0,
      "卡片数 " + countCards());
  chk("释放弹提示", toasts.some(m => m.indexOf("释放") >= 0), toasts.join(" | "));
  chk("释放后书架仍停在历史阅读视图（不被踢回未读）", api.getShelfView() === "completed");

  /* ---------- 两态开关：再标记已读 ---------- */
  api.setReader({ group: "comic", libId: "lib-books", path });
  CALLS.length = 0;
  await api.markReaderCompleted();
  /* 进度写入是 800ms 合并批量（滚动会高频触发），测试里直接冲刷之后再看请求。 */
  api.flushReadingProgressNow();
  await wait();
  chk("未读态点按钮 → PUT 进度 100",
      CALLS.some(c => c.startsWith("PUT /api/media/reading/progress?id=lib-books&path=%2FMH%2Fbook-01.cbz")),
      CALLS.join(" | "));
  chk("服务端重新记为已读", SERVER[path] && SERVER[path].progress === 100);
  CALLS.length = 0;
  await api.markReaderCompleted();
  await wait();
  chk("已读态再点 → 变成释放（DELETE）",
      CALLS.some(c => c.startsWith("DELETE /api/media/reading/progress")) && !CALLS.some(c => c.startsWith("PUT ")),
      CALLS.join(" | "));
  chk("释放后服务端不再有该条目", !Object.prototype.hasOwnProperty.call(SERVER, path));

  /* ---------- 播放列表（队列） ---------- */
  const files = [{ path: "/mu/a.mp3" }, { path: "/mu/b.mp3" }, { path: "/mu/c.mp3" }];
  api.setQueue(files, { libId: "lib-mu", path: "/mu/c.mp3", index: 2 });
  api.renderAudioPlaylistPanel();
  chk("播放列表面板渲染 3 行", (panelList.innerHTML.match(/class="apl-row/g) || []).length === 3,
      "实际 " + (panelList.innerHTML.match(/class="apl-row/g) || []).length);
  chk("当前曲目行高亮", /apl-row active[^"]*"[^>]*onclick="playAudioQueueIndex\(2\)"/.test(panelList.innerHTML));
  chk("队列计数写在面板标题", (document.getElementById("audioPlaylistCount").textContent || "").indexOf("3") >= 0);
  api.removeAudioQueueIndex(0);
  await wait();
  const queue = api.getQueue();
  chk("移除靠前曲目后队列长度 2", queue.length === 2 && queue[0].path === "/mu/b.mp3", JSON.stringify(queue.map(f => f.path)));
  chk("当前索引左移一位（否则连播会跳歌）", api.getActive().index === 1, "index=" + api.getActive().index);
  chk("高亮切到左移后的曲目", /apl-row active[^"]*"[^>]*onclick="playAudioQueueIndex\(1\)"/.test(panelList.innerHTML));
  api.clearAudioQueue();
  await wait();
  chk("清空后面板回到空态", api.getQueue().length === 0 && panelList.innerHTML.indexOf("apl-empty") >= 0);

  console.log("\nTOTAL=" + (pass + fail) + " PASSED=" + pass + " FAILED=" + fail);
  process.exit(fail ? 1 : 0);
})();
"""

with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False, encoding="utf-8") as handle:
    handle.write(HARNESS)
    harness_path = handle.name

result = subprocess.run(["node", harness_path, str(MEDIA_JS)], capture_output=True, text=True)
sys.stdout.write(result.stdout)
if result.stderr.strip():
    sys.stdout.write("STDERR: " + result.stderr.strip()[:2000] + "\n")
Path(harness_path).unlink(missing_ok=True)
if result.returncode != 0:
    raise SystemExit("FAIL: v0.9.73 释放/播放列表行为测试未通过")
print("PASS: v0.9.73 释放真的生效（服务端删条目 + 清本地残留 + 书架即时更新），播放队列操作正确")
