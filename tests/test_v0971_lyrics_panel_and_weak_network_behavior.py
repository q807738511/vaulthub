#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v0.9.71 歌词页药丸 + 拖动跟随 + 弱网档位的行为级测试。

静态断言只能证明写法，证明不了行为，因此本测试把真实的
`web/js/02-media.js` 与 `web/js/03-audio-zoom.js` 一起加载进 Node 沙箱，
用桩 document/localStorage/navigator/fetch/performance 真实执行：

  1. 放大视图药丸切换：data-page、aria-selected、歌词渲染（真实 LRC 解析成行）；
  2. 歌词拖动：位移方向、拖动阈值（<6px 才算点击）、点击行跳转播放；
  3. 跟随暂停：拖动后暂停、提示条文案切换、超时后自动恢复跟随；
  4. 弱网档位：测速分级、自动档位码率、显式档位优先、音质档位循环与持久化、
     转码流 URL 构造、测速接口路径与结果落库、漫画省流联动。

无 node 环境时以 SKIP 退出。
"""
import shutil
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MEDIA = ROOT / "web/js/02-media.js"
ZOOM = ROOT / "web/js/03-audio-zoom.js"

if shutil.which("node") is None:
    print("SKIP: 未找到 node，跳过 v0.9.71 行为测试")
    raise SystemExit(0)

HARNESS = r"""
const fs = require("fs"), vm = require("vm");
const mediaSrc = fs.readFileSync(process.argv[2], "utf8");
const zoomSrc = fs.readFileSync(process.argv[3], "utf8");
const noop = () => {};
let failures = [], checks = 0;
function ok(name, cond, extra) {
  checks++;
  if (cond) console.log("  PASS " + name);
  else { failures.push(name + (extra ? " → " + extra : "")); console.log("  FAIL " + name + (extra ? " → " + extra : "")); }
}
function near(a, b, eps) { return Math.abs(a - b) <= (eps === undefined ? 1e-6 : eps); }

/* ---------- 通用假元素 ---------- */
function fakeEl(id) {
  const el = {
    id: id || "", innerHTML: "", textContent: "", value: "", src: "", title: "",
    style: { setProperty: noop, removeProperty: noop },
    dataset: {}, children: [],
    classList: {
      _set: new Set(),
      add(...c) { c.forEach(x => this._set.add(x)); },
      remove(...c) { c.forEach(x => this._set.delete(x)); },
      toggle(c, force) { const on = force === undefined ? !this._set.has(c) : !!force; if (on) this._set.add(c); else this._set.delete(c); return on; },
      contains(c) { return this._set.has(c); }
    },
    querySelector: () => null, querySelectorAll: () => [], appendChild: noop,
    removeChild: noop, addEventListener: noop, removeEventListener: noop,
    setAttribute(k, v) { this["attr_" + k] = String(v); }, getAttribute(k) { return this["attr_" + k] === undefined ? null : this["attr_" + k]; },
    removeAttribute: noop, focus: noop, blur: noop, closest: () => null, scrollIntoView: noop,
    insertAdjacentHTML: noop, remove: noop, offsetParent: {}, parentNode: null, parentElement: null,
    isConnected: true, scrollTop: 0, scrollHeight: 400, clientHeight: 200, offsetTop: 0, clientHeightBase: 200,
    scrollTo(opts) { if (opts && typeof opts.top === "number") this.scrollTop = opts.top; },
    setPointerCapture: noop, releasePointerCapture: noop,
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 100, height: 100 })
  };
  return el;
}

/* ---------- 会解析 .lyric-line 的歌词容器 ---------- */
function lyricHost(ids) {
  const el = fakeEl();
  el._lines = [];
  Object.defineProperty(el, "innerHTML", {
    get() { return el._html || ""; },
    set(html) {
      el._html = String(html);
      el._lines = [];
      const re = /data-time="([^"]+)"[^>]*>([^<]*)</g;
      let m, i = 0;
      while ((m = re.exec(el._html)) !== null) {
        const line = fakeEl();
        line.dataset = { time: m[1], index: String(i) };
        line.textContent = m[2];
        line.offsetTop = 30 * i;
        line.clientHeight = 24;
        el._lines.push(line);
        i++;
      }
    }
  });
  el.querySelectorAll = sel => (sel === ".lyric-line" ? el._lines : []);
  el.querySelector = sel => {
    if (sel === ".lyric-line.active") return el._lines.find(l => l.classList.contains("active")) || null;
    if (sel === "[data-audio-quality-label]") return el._label || null;
    return null;
  };
  return el;
}

/* ---------- 文档与全局桩 ---------- */
const els = {};
function get(id) { return els[id] || (els[id] = fakeEl(id)); }
const lyricsInner = lyricHost();
const lyricsOuter = fakeEl("audioFullscreenLyrics");
const panelLyrics = lyricHost();
const overlay = fakeEl("audioFullscreenOverlay");
const posterImg = fakeEl("audioFullscreenImg");
const posterFallback = fakeEl("audioFullscreenFallback");
const player = fakeEl("audioPlayerElement");
player.currentTime = 0; player.paused = true; player.src = "";
player.play = () => { player.paused = false; return Promise.resolve(); };
player.pause = () => { player.paused = true; };
player.load = noop;
const qualityLabelSpan = fakeEl();
const qualityButton = fakeEl("audioQualityButton");
qualityButton.querySelector = sel => (sel === "[data-audio-quality-label]" ? qualityLabelSpan : null);
Object.assign(els, {
  audioFullscreenOverlay: overlay,
  audioFullscreenLyricsInner: lyricsInner,
  audioFullscreenLyrics: lyricsOuter,
  audioFullscreenLyricsHint: get("audioFullscreenLyricsHint"),
  audioFullscreenImg: posterImg,
  audioFullscreenFallback: posterFallback,
  audioFullscreenPoster: fakeEl("audioFullscreenPoster"),
  audioFsPosterPill: get("audioFsPosterPill"),
  audioFsLyricsPill: get("audioFsLyricsPill"),
  audioPlayerElement: player,
  audioPlayerLyrics: panelLyrics,
  audioQualityButton: qualityButton,
  audioCover: fakeEl("audioCover"),
  audioPlayerTitle: fakeEl("audioPlayerTitle"),
  audioPlayerMeta: fakeEl("audioPlayerMeta"),
  audioFavoriteButton: fakeEl("audioFavoriteButton"),
  weakNetworkMode: fakeEl("weakNetworkMode"),
  weakNetworkStatus: fakeEl("weakNetworkStatus"),
  weakNetworkStatus: fakeEl("weakNetworkStatus")
});
const store = {};
const localStorage = {
  getItem: k => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: k => { delete store[k]; }
};
const navigatorStub = { userAgent: "node-harness", connection: undefined };
const fetched = [];
let probeDelayMs = 500;
let nowMs = 1000;
const performanceStub = { now: () => nowMs };
const realSetTimeout = setTimeout;
const document = {
  getElementById: id => els[id] || (els[id] = fakeEl(id)),
  querySelector: sel => (sel === ".audio-cover-zoom-btn" ? fakeEl("zoomBtn") : sel === ".audio-fullscreen-close-sr" ? fakeEl("closeSr") : null),
  querySelectorAll: () => [],
  createElement: () => fakeEl(),
  addEventListener: noop, removeEventListener: noop,
  body: fakeEl(), documentElement: fakeEl(), activeElement: null, fullscreenElement: null, cookie: ""
};
function fetchStub(url, opts) {
  const u = String(url);
  fetched.push({ url: u, opts: opts || {} });
  if (u.startsWith("/api/media/weak/probe")) {
    const kb = Number(new URL("http://x" + u).searchParams.get("kb") || 256);
    const bytes = kb * 1024;
    return Promise.resolve({ ok: true, status: 200, arrayBuffer: () => { nowMs += probeDelayMs; return Promise.resolve(new ArrayBuffer(bytes)); } });
  }
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}), text: () => Promise.resolve("") });
}
const windowStub = {
  addEventListener: noop, removeEventListener: noop, location: { href: "http://x/", search: "" },
  performance: performanceStub, requestIdleCallback: undefined,
  matchMedia: () => ({ matches: false, addEventListener: noop }),
  localStorage, navigator: navigatorStub,
  innerWidth: 1440, innerHeight: 900, VAULTHUB_ASSET_VERSION: "0.9.71"
};
const ctx = vm.createContext({
  window: windowStub, document, localStorage, navigator: navigatorStub,
  /* 03-features.js 的全局 helper（本测试不加载该文件，只补被测路径用到的）：
     esc 用于歌词行转义，toast 是档位切换提示。 */
  esc: s => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;"),
  toast: msg => { (ctx.__toasts = ctx.__toasts || []).push(String(msg)); },
  fetch: fetchStub, performance: performanceStub, console,
  setTimeout: realSetTimeout, clearTimeout, setInterval: () => 0, clearInterval: noop,
  requestAnimationFrame: cb => realSetTimeout(() => cb(nowMs), 0), cancelAnimationFrame: noop,
  URL, URLSearchParams, Date, Math, JSON, Object, Array, String, Number, Boolean, RegExp, Error,
  Promise, Set, Map, isNaN, parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
  btoa: s => Buffer.from(s, "binary").toString("base64"), atob: s => Buffer.from(s, "base64").toString("binary"),
  Audio: function () { return fakeEl(); }, Image: function () { return fakeEl(); },
  getComputedStyle: () => ({ display: "block", overflowY: "auto", getPropertyValue: () => "" }),
  MutationObserver: function () { this.observe = noop; this.disconnect = noop; },
  IntersectionObserver: function () { this.observe = noop; this.disconnect = noop; }
});
ctx.globalThis = ctx;
ctx.window.document = document;

vm.runInContext(mediaSrc, ctx, { filename: "02-media.js" });
/* 02-media.js 的 activeAudio/audioFiles 是顶层 let（不挂 window），
   因此必须用「同一上下文里的脚本」读写：this.__api 暴露取值/赋值入口。 */
vm.runInContext(`this.__api = {
  setActiveAudio: value => { activeAudio = value; },
  getActiveAudio: () => activeAudio,
  setWeakState: patch => { saveWeakNetworkState(patch); }
};`, ctx, { filename: "harness-api.js" });
const sandbox = ctx.__api;
sandbox.weakNetworkLevel = (n) => ctx.weakNetworkLevel(n);
sandbox.effectiveAudioKbps = () => ctx.effectiveAudioKbps();
sandbox.audioQualityLabel = () => ctx.audioQualityLabel();
sandbox.saveWeakNetworkState = (patch) => ctx.saveWeakNetworkState(patch);
sandbox.weakNetworkState = () => ctx.weakNetworkState();
sandbox.weakNetworkActive = () => ctx.weakNetworkActive();
sandbox.audioQualityChoice = () => ctx.audioQualityChoice();
sandbox.saveAudioQualityChoice = (v) => ctx.saveAudioQualityChoice(v);
sandbox.cycleAudioQuality = () => ctx.cycleAudioQuality();
sandbox.audioStreamUrl = (lib, path, kbps) => ctx.audioStreamUrl(lib, path, kbps);
sandbox.probeWeakNetwork = (o) => ctx.probeWeakNetwork(o || {});
sandbox.applyAudioSource = (lib, path, player, o) => ctx.applyAudioSource(lib, path, player, o || {});
sandbox.comicSaveDataActive = () => ctx.comicSaveDataActive();
sandbox.syncWeakNetworkSettings = () => ctx.syncWeakNetworkSettings();
sandbox.updateLyricHighlight = () => ctx.updateLyricHighlight();
sandbox.toggleAudioCoverZoom = () => ctx.toggleAudioCoverZoom();
sandbox.setAudioFullscreenPage = (page) => ctx.setAudioFullscreenPage(page);

/* ================= 弱网档位 ================= */
console.log("== 弱网档位与音质 ==");
ok("弱网分级 slow", sandbox.weakNetworkLevel(100 * 1024) === "slow");
ok("弱网分级 medium", sandbox.weakNetworkLevel(900 * 1024) === "medium");
ok("弱网分级 fast", sandbox.weakNetworkLevel(5 * 1024 * 1024) === "fast");
ok("弱网分级 未测速 → 空", sandbox.weakNetworkLevel(0) === "");

ok("默认自动档位（未测速）→ 原文件", sandbox.effectiveAudioKbps() === 0, String(sandbox.effectiveAudioKbps()));

sandbox.saveWeakNetworkState({ speedBps: 100 * 1024, measuredAt: Date.now(), level: "slow" });
ok("测速为弱网 → 自动档位 96k", sandbox.effectiveAudioKbps() === 96, String(sandbox.effectiveAudioKbps()));
ok("音质文案含 96k", sandbox.audioQualityLabel().includes("96k"), sandbox.audioQualityLabel());
ok("弱网生效", sandbox.weakNetworkActive() === true);

sandbox.saveWeakNetworkState({ speedBps: 900 * 1024, measuredAt: Date.now(), level: "medium" });
ok("中等网络 → 自动档位 160k", sandbox.effectiveAudioKbps() === 160, String(sandbox.effectiveAudioKbps()));
ok("中等网络不判弱网", sandbox.weakNetworkActive() === false);

sandbox.saveWeakNetworkState({ mode: "on", speedBps: 5 * 1024 * 1024, measuredAt: Date.now(), level: "fast" });
ok("显式开启弱网 → 96k", sandbox.effectiveAudioKbps() === 96, String(sandbox.effectiveAudioKbps()));
sandbox.saveWeakNetworkState({ mode: "off", speedBps: 100 * 1024, level: "slow" });
ok("显式关闭弱网 → 原文件", sandbox.effectiveAudioKbps() === 0 && sandbox.weakNetworkActive() === false);
sandbox.saveWeakNetworkState({ mode: "auto" });

ok("显式选择 192k 优先于自动判定", (function () {
  sandbox.saveWeakNetworkState({ mode: "off", speedBps: 100 * 1024, level: "slow" });
  const prev = sandbox.audioQualityChoice();
  sandbox.saveAudioQualityChoice("192");
  const v = sandbox.effectiveAudioKbps();
  sandbox.saveAudioQualityChoice(prev);
  return v === 192;
})(), String(sandbox.effectiveAudioKbps()));

/* 音质档位循环 */
const ladderSeen = [];
sandbox.saveAudioQualityChoice("original");
for (let i = 0; i < 6; i++) { ladderSeen.push(sandbox.audioQualityChoice()); sandbox.cycleAudioQuality(); }
ok("音质档位循环覆盖 6 档且回到起点",
  ladderSeen.join(",") === "original,auto,320,192,128,96" && sandbox.audioQualityChoice() === "original",
  ladderSeen.join(",") + " → " + sandbox.audioQualityChoice());

/* 转码流 URL */
const url = sandbox.audioStreamUrl({ id: "lib-1" }, "/YY/夜に駆ける.mp3", 128);
ok("转码流 URL 路径与档位", url.startsWith("/api/media/audio/stream?") && url.includes("bitrate=128k"), url);
ok("转码流 URL 转义路径", url.includes(encodeURIComponent("/YY/夜に駆ける.mp3")));

/* 测速 */
console.log("== 下行测速 ==");
probeDelayMs = 500; // 256KiB / 0.5s ≈ 512KiB/s → medium
let probePromise = sandbox.probeWeakNetwork({ kb: 256 });
probePromise.then(() => {
  const st = sandbox.weakNetworkState();
  ok("测速请求打到 /api/media/weak/probe", fetched.some(f => f.url.includes("/api/media/weak/probe?kb=256")));
  ok("测速速率换算（256KiB / 0.5s ≈ 512KiB/s）", Math.abs(st.speedBps - 512 * 1024) < 8 * 1024, String(st.speedBps));
  ok("测速结果落库含 measuredAt/level", st.measuredAt > 0 && st.level === "medium", JSON.stringify(st));

  /* 源选择 */
  console.log("== 播放源选择与回落 ==");
  sandbox.saveAudioQualityChoice("original");
  let kbps = sandbox.applyAudioSource({ id: "lib-1" }, "/YY/a.mp3", player);
  ok("原文件档位 → 直出文件地址",
    kbps === 0 && player.src.startsWith("/api/media/file?") && player.src.includes("id=lib-1")
    && player.src.includes(encodeURIComponent("/YY/a.mp3")), player.src);
  sandbox.saveAudioQualityChoice("128");
  kbps = sandbox.applyAudioSource({ id: "lib-1" }, "/YY/a.mp3", player);
  ok("128k 档位 → 转码流地址 + dataset 记录", kbps === 128 && player.src.includes("bitrate=128k") && player.dataset.streamKbps === "128", player.src);
  ok("applyAudioSource 复位回落标记", player.dataset.streamFallback === "");
  sandbox.saveAudioQualityChoice("original");

  /* 漫画省流联动 */
  console.log("== 漫画省流联动 ==");
  sandbox.saveWeakNetworkState({ mode: "auto", speedBps: 100 * 1024, level: "slow" });
  ok("弱网判定联动省流（自动档）", sandbox.comicSaveDataActive() === true);
  sandbox.saveWeakNetworkState({ mode: "off", speedBps: 100 * 1024, level: "slow" });
  ok("关闭弱网时省流不启用（无 saveData 提示）", sandbox.comicSaveDataActive() === false);
  sandbox.saveWeakNetworkState({ mode: "auto" });

  /* 设置面板文案 */
  sandbox.saveWeakNetworkState({ mode: "auto", speedBps: 2 * 1024 * 1024, measuredAt: Date.now(), level: "fast" });
  sandbox.syncWeakNetworkSettings();
  ok("设置面板状态文案", String(els.weakNetworkStatus.textContent).includes("2.00 MiB/s"), els.weakNetworkStatus.textContent);

  /* ================= 放大视图：药丸 + 歌词 ================= */
  console.log("== 放大视图药丸与歌词 ==");
  vm.runInContext(zoomSrc, ctx, { filename: "03-audio-zoom.js" });
  /* 造一个正在播放的曲目（activeAudio 是 02 的顶层 let，用公开函数间接设置） */
  sandbox.setActiveAudio({ libId: "lib-1", path: "/YY/hit.mp3", index: 0 });
  store["vaulthub_audio_metadata_v1"] = JSON.stringify({
    "/YY/hit.mp3": {
      title: "残酷な天使のテーゼ", artist: "高橋洋子", album: "残酷な天使のテーゼ - EP",
      cover: "https://art.example/jp1/600x600bb.jpg",
      lyrics: "[00:00.00]残酷な天使のテーゼ\n[00:02.00]少年よ 神話になれ\n[00:04.00]青い風が吹く"
    }
  });
  sandbox.toggleAudioCoverZoom();
  ok("打开放大视图落在海报页", overlay.dataset.page === "poster", overlay.dataset.page);
  sandbox.setAudioFullscreenPage("lyrics");
  ok("切到歌词页 data-page=lyrics", overlay.dataset.page === "lyrics");
  ok("歌词药丸 active + aria-selected", els.audioFsLyricsPill.classList.contains("active") && els.audioFsLyricsPill.getAttribute("aria-selected") === "true");
  ok("海报药丸取消 active", !els.audioFsPosterPill.classList.contains("active") && els.audioFsPosterPill.getAttribute("aria-selected") === "false");
  ok("真实 LRC 解析成 3 行歌词", lyricsInner._lines.length === 3, String(lyricsInner._lines.length));

  /* 高亮跟随播放时间（视口调成 40px，否则 3 行歌词的居中位置会被 Math.max(0,…) 夹紧，
     无法区分「有滚动」与「没滚动」） */
  lyricsOuter.clientHeight = 40;
  player.currentTime = 2.5;
  sandbox.updateLyricHighlight();
  ok("第 2 行（2.0s）为当前高亮", lyricsInner._lines[1].classList.contains("active") && !lyricsInner._lines[2].classList.contains("active"));
  ok("高亮变化触发居中滚动", lyricsOuter.scrollTop > 0, String(lyricsOuter.scrollTop));

  /* 拖动：暂停跟随 + 方向正确 */
  lyricsOuter.dataset.dragMoved = "0";
  ctx.audioFsLyricsDragStart({ button: 0, clientY: 300, pointerId: 1 });
  ctx.audioFsLyricsDragMove({ clientY: 200, pointerId: 1 });
  ok("向下拖动指针 → 内容上滚（scrollTop 增加）", lyricsOuter.scrollTop > 0, String(lyricsOuter.scrollTop));
  ok("拖动中判定为暂停跟随", ctx.lyricFollowPaused({ id: "audioFullscreenLyricsInner" }) === true);
  ctx.audioFsLyricsDragEnd({ pointerId: 1 });
  ok("拖动位移被记录", Number(lyricsOuter.dataset.dragMoved) >= 100, lyricsOuter.dataset.dragMoved);
  ok("提示条切换为已暂停", String(els.audioFullscreenLyricsHint.textContent).includes("已暂停跟随") && els.audioFullscreenLyricsHint.classList.contains("follow-paused"));
  ok("拖动后滚动位置不再被自动跟随改写", (function () {
    const before = lyricsOuter.scrollTop;
    player.currentTime = 4.5;
    sandbox.updateLyricHighlight();
    return lyricsOuter.scrollTop === before;
  })());

  /* 拖动结束后的 click 不跳转（阈值判断） */
  player.currentTime = 0;
  ctx.audioFsLyricsClick({ stopPropagation: noop, target: { closest: () => lyricsInner._lines[2] }, clientY: 200 });
  ok("位移超过阈值（拖动）时点击不跳转", player.currentTime === 0, String(player.currentTime));

  /* 低于阈值视为点击：跳转 + 恢复跟随 */
  lyricsOuter.dataset.dragMoved = "2";
  ctx.audioFsLyricsClick({ stopPropagation: noop, target: { closest: () => lyricsInner._lines[2] }, clientY: 200 });
  ok("轻点歌词行跳转到该句时间", Math.abs(player.currentTime - 4) < 1e-6, String(player.currentTime));
  ok("点击后恢复跟随", ctx.lyricFollowPaused({ id: "audioFullscreenLyricsInner" }) === false);

  /* 暂停过期后恢复 */
  ctx.audioFsLyricsDragStart({ button: 0, clientY: 100, pointerId: 2 });
  ctx.audioFsLyricsDragMove({ clientY: 40, pointerId: 2 });
  ctx.audioFsLyricsDragEnd({ pointerId: 2 });
  const pausedNow = ctx.lyricFollowPaused({ id: "audioFullscreenLyricsInner" });
  const realNow = Date.now;
  Date.now = () => realNow() + 7000; // 模拟 7 秒后（提示条也在同一时刻刷新）
  const pausedLater = ctx.lyricFollowPaused({ id: "audioFullscreenLyricsInner" });
  ctx.updateAudioFsLyricsHint();
  const hintAfterExpiry = String(els.audioFullscreenLyricsHint.textContent);
  const hintClassAfterExpiry = els.audioFullscreenLyricsHint.classList.contains("follow-paused");
  Date.now = realNow;
  ok("拖动后 6 秒内暂停、超时后恢复", pausedNow === true && pausedLater === false);
  ok("恢复后提示条回到引导文案", hintAfterExpiry.includes("拖动可浏览") && hintClassAfterExpiry === false, hintAfterExpiry);

  /* 每次打开回到海报页 */
  ctx.closeAudioCoverZoom();
  sandbox.toggleAudioCoverZoom();
  ok("再次打开回到海报页", overlay.dataset.page === "poster", overlay.dataset.page);

  console.log("TOTAL=" + checks + " FAILED=" + failures.length);
  if (failures.length) {
    console.log("FAILED CASES:\n" + failures.map(f => "  - " + f).join("\n"));
    process.exit(1);
  }
  console.log("PASS: v0.9.71 药丸/拖动/弱网行为契约通过");
}).catch(err => { console.log("HARNESS ERROR: " + (err && err.stack || err)); process.exit(1); });
"""

with tempfile.TemporaryDirectory() as tmp:
    harness = Path(tmp) / "harness.js"
    harness.write_text(HARNESS, encoding="utf-8")
    proc = subprocess.run(["node", str(harness), str(MEDIA), str(ZOOM)], capture_output=True, text=True, timeout=180)
    print(proc.stdout.strip())
    if proc.returncode != 0:
        print(proc.stderr.strip()[:2000])
        raise SystemExit("FAIL: v0.9.71 行为测试未通过")
print("PASS: v0.9.71 药丸切换/歌词拖动/弱网档位行为契约通过")
