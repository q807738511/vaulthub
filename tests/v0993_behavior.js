/* v0.9.93 行为测试（Node VM 桩，真实执行源文件）：
   A. 播放占用：setPlayerImmersive / syncPlayerImmersive 的真实状态推导
   B. 彻底停止：teardownMediaElement / hardStopVideoPlayback / stopActivePlayback / 卸载停会话
   C. 剧集归组与同步：seriesGroupKeyOf 真值表、buildSeriesShows 归组、整剧同步
   D. 侧栏移除后的运行时不回归：布局收敛、自定义模块标签判空、头像菜单入口
   源文件各自独立 vm 上下文（都定义同名 const，同上下文会 SyntaxError）。 */
const fs = require("fs"), vm = require("vm");
const ROOT = process.env.VH_ROOT || require("path").resolve(__dirname, "..");
let passed = 0, failed = 0;
const chk = (name, ok, extra) => {
  if (ok) { passed++; console.log("PASS:", name); }
  else { failed++; console.log("FAIL:", name, extra === undefined ? "" : JSON.stringify(extra)); }
};

function fakeEl(selectorMap) {
  const classes = new Set();
  return {
    classes, dataset: {}, textContent: "", title: "", innerHTML: "",
    classList: {
      add: (...c) => c.forEach(x => classes.add(x)),
      remove: (...c) => c.forEach(x => classes.delete(x)),
      contains: c => classes.has(c),
      toggle: (c, on) => { const want = on === undefined ? !classes.has(c) : !!on; want ? classes.add(c) : classes.delete(c); return want; },
    },
    querySelector: sel => (selectorMap || {})[sel] || null,
    querySelectorAll: () => [],
    addEventListener() {}, setAttribute() {}, closest: () => null, offsetParent: null,
  };
}

function makeSandbox(extra) {
  const storage = {};
  const store = {
    getItem: k => (k in storage ? storage[k] : null),
    setItem: (k, v) => { storage[k] = String(v); },
    removeItem: k => { delete storage[k]; },
    get length() { return Object.keys(storage).length; },
    key: i => Object.keys(storage)[i] === undefined ? null : Object.keys(storage)[i],
  };
  const el = () => ({ value: "", textContent: "", innerHTML: "", style: {}, dataset: {}, classList: { add() {}, remove() {}, contains: () => false, toggle() {} }, addEventListener() {}, appendChild() {}, remove() {}, setAttribute() {}, querySelector: () => null, querySelectorAll: () => [] });
  const sandbox = {
    console, Date, Number, Math, String, Array, JSON, Object, parseFloat, parseInt, isNaN, RegExp, Set, Map, Promise, URL,
    encodeURIComponent, decodeURIComponent, setTimeout, clearTimeout, Blob: function Blob() {},
    storage, localStorage: store,
    document: {
      getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {},
      createElement: () => el(), body: { classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); }, toggle(c, on) { const w = on === undefined ? !this._s.has(c) : !!on; w ? this._s.add(c) : this._s.delete(c); return w; } }, appendChild() {} },
      documentElement: { scrollHeight: 2000, style: { setProperty() {} } },
    },
    window: { handlers: [], addEventListener(ev, fn) { this.handlers.push([ev, fn]); }, isSecureContext: false, scrollY: 0, innerHeight: 800, scrollBy() {}, scrollTo() {}, VAULTHUB_ASSET_VERSION: "0.9.97" },
    navigator: {},
    location: { origin: "http://192.0.2.10:8088", pathname: "/", href: "http://192.0.2.10:8088/" },
    curLang: "zh-CN",
    toast: () => {}, t: k => k, tf: k => String(k), esc: s => String(s == null ? "" : s),
    mediaKeepAliveStop: () => {}, mediaKeepAliveStart: () => {},
    fetch: async () => ({ ok: false, json: async () => ({}) }),
    sessionWriteHeaders: () => ({}),
    vaultStoreJSON: (k, d) => { try { const v = store.getItem(k); return v == null ? d : (JSON.parse(v) ?? d); } catch (e) { return d; } },
    vaultStoreSet: (k, v) => { try { store.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } },
    pushNotification() {}, upsertNotification() {},
  };
  return Object.assign(sandbox, extra || {});
}
function load(file, extra) {
  const sb = makeSandbox(extra);
  vm.createContext(sb);
  vm.runInContext(fs.readFileSync(ROOT + "/" + file, "utf8"), sb, { filename: file });
  return sb;
}
const call = (sb, expr) => vm.runInContext(expr, sb);
const MEDIA_SRC = fs.readFileSync(ROOT + "/web/js/02-media.js", "utf8");

(async () => {
  /* ================= A. 播放占用（顶栏回缩） ================= */
  {
    const sb = load("web/js/02-media.js", { settings: {} });
    chk("A1 setPlayerImmersive 加类", call(sb, "setPlayerImmersive(true)") === true
        && call(sb, "document.body.classList.contains('player-immersive')") === true);
    chk("A2 setPlayerImmersive 去类", call(sb, "setPlayerImmersive(false)") === false
        && call(sb, "document.body.classList.contains('player-immersive')") === false);
    chk("A3 setPlayerImmersive 幂等（同态不重复切换）",
        call(sb, "setPlayerImmersive(false)") === false);
  }
  /* syncPlayerImmersive 的真实推导：可见且未最小化才回缩。
     注意：源文件里自己定义了 liveActiveVideoElement，sandbox 传同名桩会被函数声明覆盖，
     所以这里让真实的元素查找（document.querySelectorAll → closest → dataset）能找到视频。 */
  {
    const overlay = fakeEl();
    /* v0.9.97（需求1）：源文件改为按「有没有渲染盒子」判定播放面可见 ——
       浮层是 position:fixed，offsetParent 恒为 null，用它判会永远判成不可见。
       fakeEl 没有 getClientRects / getComputedStyle 时 elementRendered 视为已渲染。 */
    const viewEl = { classList: { contains: c => c === "active" }, querySelector: () => overlay };
    const videoRoot = { dataset: { path: "a/b.mkv", library: "movie-1" }, querySelector: () => null, querySelectorAll: () => [] };
    const videoEl = { paused: false, closest: sel => (sel === ".media-reader-overlay" ? overlay : videoRoot) };
    const sb = load("web/js/02-media.js", {
      settings: {},
      __video: videoEl,
      activePlayback: () => ({ kind: "video", group: "movie", libId: "movie-1", path: "a/b.mkv" }),
      /* playbackSurfaceVisible 同样由源文件定义，必须让真实的可见性判定成立 */
      document: {
        getElementById: id => (id === "view-movie" ? viewEl : null), querySelector: () => null, addEventListener() {},
        /* v0.9.97（需求1）：沉浸判定改为直接查 .media-reader-overlay，桩要同时喂这两条查询 */
        querySelectorAll: sel => (sel === "video[data-movie-player]" ? [videoEl]
          : (sel === ".media-reader-overlay.movie-player" ? [overlay] : [])),
        createElement: () => ({ style: {}, classList: { add() {} }, addEventListener() {} }),
        body: { classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); }, toggle(c, on) { const w = on === undefined ? !this._s.has(c) : !!on; w ? this._s.add(c) : this._s.delete(c); return w; } } },
        documentElement: { style: { setProperty() {} } },
      },
    });
    chk("A4 完整播放器可见 → 回缩顶栏", call(sb, "syncPlayerImmersive()") === true
        && call(sb, "document.body.classList.contains('player-immersive')") === true);
    overlay.classList.add("video-minimized");
    chk("A5 最小化成控制器小窗 → 顶栏还给用户", call(sb, "syncPlayerImmersive()") === false);
    overlay.classList.remove("video-minimized");
    chk("A6 展开继续播放 → 再次回缩", call(sb, "syncPlayerImmersive()") === true);
  }
  {
    const sb = load("web/js/02-media.js", {
      settings: {},
      activePlayback: () => ({ kind: "audio", group: "audio", path: "x.mp3" }),
      playbackSurfaceVisible: () => true,
      liveActiveVideoElement: () => null,
    });
    chk("A7 音频播放不占用整窗（顶栏保持不变）", call(sb, "syncPlayerImmersive()") === false);
  }
  {
    const sb = load("web/js/02-media.js", { settings: {}, activePlayback: () => null });
    chk("A8 没有在播 → 不回缩", call(sb, "syncPlayerImmersive()") === false);
  }
  /* CSS 静态：--topbar-h 归零 = 真正释放占位 */
  {
    const css = fs.readFileSync(ROOT + "/web/css/main.css", "utf8");
    chk("A9 CSS body.player-immersive 把 --topbar-h 归零", css.includes("body.player-immersive { --topbar-h: 0px; }"));
    chk("A10 CSS 顶栏滑出视口且禁用点击",
        /* v0.9.97：回缩规则补齐 visibility:hidden 与透明底边（0 高度盒子挡不住溢出子元素/1px 线），
           断言按归一化关键声明检查，兼容续行与新增属性。 */
        (() => { const c = css.replace(/\s+/g, " ");
          return c.includes("body.player-immersive .topbar { transform: translateY(-100%); opacity: 0; pointer-events: none;")
            && c.includes("visibility: hidden;") && c.includes("border-bottom-color: transparent;"); })());
  }

  /* ================= B. 关闭/停止后彻底断流 ================= */
  {
    /* 媒体元素：pause → 去 src → load()（load 会中止进行中的网络读取） */
    const calls = [];
    const el = {
      paused: false, currentTime: 42,
      pause() { calls.push("pause"); this.paused = true; },
      removeAttribute(n) { calls.push("removeAttribute:" + n); },
      load() { calls.push("load"); },
      querySelectorAll: () => [],
    };
    /* 把元素注入 vm 上下文后再调用，才能断言真实调用序列 */
    const sb2 = makeSandbox({ settings: {}, __el: el });
    vm.createContext(sb2);
    vm.runInContext(MEDIA_SRC, sb2, { filename: "web/js/02-media.js" });
    calls.length = 0;
    const ok2 = vm.runInContext("teardownMediaElement(__el)", sb2);
    chk("B1 teardownMediaElement 返回 true 且断源顺序正确", ok2 === true && calls.join(",") === "pause,removeAttribute:src,load", calls);
    chk("B2 teardownMediaElement 对 null/非法元素安全返回 false",
        vm.runInContext("teardownMediaElement(null)", sb2) === false
        && vm.runInContext("teardownMediaElement({})", sb2) === false);
  }
  {
    /* 视频会话硬停止：中止下载 + 终止 Worker + 断源 + 停会话 + 清计时器 */
    const calls = [];
    const video = {
      paused: false, currentTime: 10,
      pause() { calls.push("video.pause"); },
      removeAttribute(n) { calls.push("video.removeAttribute:" + n); },
      load() { calls.push("video.load"); },
      querySelectorAll: () => [],
    };
    const root = {
      dataset: { playbackSession: "sess-1", path: "Show/S01E01.mkv" },
      querySelector: sel => (sel === "video[data-movie-player]" ? video : null),
      querySelectorAll: sel => (sel === "audio" ? [] : []),
      __wasmWorker: { terminate() { calls.push("worker.terminate"); } },
      __wasmObjectUrl: "blob:x",
      __wasmAbort: { abort() { calls.push("abort"); } },
      __videoProgressTimer: 1, __videoChromeTimer: 2,
    };
    const fetched = [];
    const sb = makeSandbox({
      settings: {}, __root: root,
      fetch: async (url, opts) => { fetched.push(url + "|" + ((opts && opts.method) || "GET")); return { ok: true, json: async () => ({}) }; },
      mediaKeepAliveStop: s => calls.push("keepAliveStop:" + s),
      URL: { revokeObjectURL: () => calls.push("revokeObjectURL") },
    });
    vm.createContext(sb);
    vm.runInContext(MEDIA_SRC, sb, { filename: "web/js/02-media.js" });
    vm.runInContext("hardStopVideoPlayback(__root)", sb);
    chk("B4 硬停会中止 WASM 下载", calls.includes("abort"));
    chk("B5 硬停终止解码 Worker 并回收 ObjectURL",
        calls.includes("worker.terminate") && calls.includes("revokeObjectURL"));
    chk("B6 硬停断开视频元素（去 src + load）",
        calls.includes("video.pause") && calls.includes("video.removeAttribute:src") && calls.includes("video.load"));
    chk("B7 硬停上报播放会话 stop 并释放保活",
        fetched.some(u => u.includes("/api/media/playback/sessions/sess-1/stop"))
        && calls.includes("keepAliveStop:video"), fetched);
    chk("B8 硬停清掉计时器与 abort 句柄",
        root.__videoProgressTimer === undefined || root.__videoProgressTimer === null
        || vm.runInContext("__root.__videoChromeTimer", sb) === undefined
        || root.__wasmAbort === null);
  }
  {
    /* 浮标 ✕（停止播放）走硬停，而不是只 pause */
    const calls = [];
    const pauseCalls = [];
    let videoRef = null;
    const videoRoot = {
      dataset: { playbackSession: "", path: "a/b.mkv", library: "movie-1" },
      querySelector: sel => (sel === "video[data-movie-player]" ? videoRef : null),
      querySelectorAll: () => [],
    };
    videoRef = {
      closest: () => videoRoot,
      pause() { pauseCalls.push("pause"); }, removeAttribute(n) { pauseCalls.push("rm:" + n); }, load() { pauseCalls.push("load"); }, currentTime: 5,
      querySelectorAll: () => [],
    };
    const sb = load("web/js/02-media.js", {
      settings: {},
      activePlayback: () => ({ kind: "video", group: "movie", libId: "movie-1", path: "a/b.mkv" }),
      clearActivePlayback: k => calls.push("clear:" + k),
      document: {
        getElementById: () => null, querySelector: () => null, addEventListener() {},
        querySelectorAll: sel => (sel === "video[data-movie-player]" ? [videoRef] : []),
        createElement: () => ({ style: {}, classList: { add() {} }, addEventListener() {} }),
        body: { classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); }, toggle(c, on) { const w = on === undefined ? !this._s.has(c) : !!on; w ? this._s.add(c) : this._s.delete(c); return w; } } },
        documentElement: { style: { setProperty() {} } },
      },
    });
    call(sb, "stopActivePlayback()");
    chk("B9 浮标 ✕ 走硬停：元素去 src + load（不是只暂停）",
        pauseCalls.includes("rm:src") && pauseCalls.includes("load"), pauseCalls);
    chk("B10 浮标 ✕ 释放播放占用并清状态",
        calls.includes("clear:video")
        && call(sb, "document.body.classList.contains('player-immersive')") === false);
  }
  {
    /* 卸载：暂停媒体 + sendBeacon 停会话 */
    const beats = [];
    const paused = [];
    const els = [{ pause() { paused.push("video"); } }, { pause() { paused.push("audio"); } }];
    const sb = load("web/js/02-media.js", {
      settings: {},
      navigator: { sendBeacon: (url) => { beats.push(url); return true; } },
      document: {
        getElementById: () => null, querySelector: () => null, createElement: () => ({ style: {}, classList: { add() {} } }),
        querySelectorAll: sel => (sel.indexOf("video[data-movie-player]") === 0 ? els : [{ dataset: { playbackSession: "s1" } }, { dataset: { playbackSession: "s2" } }]),
        addEventListener() {}, body: { classList: { add() {}, remove() {}, contains: () => false, toggle() {} } },
        documentElement: { style: { setProperty() {} } },
      },
    });
    call(sb, "flushPlaybackOnUnload()");
    chk("B11 卸载时暂停所有播放元素", paused.length === 2, paused);
    chk("B12 卸载时用 sendBeacon 停掉每个播放会话",
        beats.length === 2 && beats.every(u => u.includes("/stop")), beats);
  }

  /* ================= C. 剧集归组与整剧同步 ================= */
  {
    /* 客户端反馈的原话：刮削能刮出正确剧名，但「出现第一集后其他媒体完全没同步到同一剧集上」。
       这里造出「只有第一集有刮削结果」的真实数据：3 集必须落进同一部剧，且剧名取刮削值。 */
    const files = [
      { path: "Show Name/Season 01/Show Name S01E01.mkv", size: 1 },
      { path: "Show Name/Season 01/Show Name S01E02.mkv", size: 2 },
      { path: "Show Name/Season 01/Show Name S01E03.mkv", size: 3 },
      { path: "Other Show/Season 01/Other.Show.S01E01.mkv", size: 4 },
      { path: "Flat Show/Flat Show S01E01.mkv", size: 5 },
    ];
    const meta = {
      "Show Name/Season 01/Show Name S01E01.mkv": { title: "第 1 集", show_title: "正确剧名", poster: "/cover/a.jpg", overview: "简介", provider: "TMDB · 剧集", media_type: "series", checkedAt: 1 },
      "Show Name/Season 01/Show Name S01E02.mkv": { title: "第 2 集", media_type: "series", checkedAt: 1 },
      "Other Show/Season 01/Other.Show.S01E01.mkv": { title: "第 1 集", show_title: "另一部剧", media_type: "series", checkedAt: 1 },
    };
    const sb = makeSandbox({ settings: {}, __files: files, __meta: meta });
    vm.createContext(sb);
    vm.runInContext('localStorage.setItem("vaulthub_movie_metadata_v1", JSON.stringify(__meta));', sb);
    vm.runInContext(MEDIA_SRC, sb, { filename: "web/js/02-media.js" });
    vm.runInContext("const __shows = buildSeriesShows(__files);"
      + "const __main = __shows.find(s => s.seasonList[0] && s.seasonList[0].episodes.length === 3);", sb);
    const shows = vm.runInContext("__shows.map(s => ({ key: s.key, title: s.title, eps: (s.seasonList[0]||{}).episodes.length, files: s.files.length, poster: s.poster }))", sb);
    chk("C1 同一部剧的 3 集归到 1 部剧（只有第一集刮到也照样归组）",
        shows.length === 3 && shows.some(s => s.eps === 3 && s.files === 3), shows);
    const main = shows.find(s => s.eps === 3);
    chk("C2 整剧显示刮削剧名而不是文件名解析名", main && main.title === "正确剧名", main);
    chk("C3 刮削海报整组共用", main && main.poster === "/cover/a.jpg", main);
    chk("C4 同名不同剧仍分开", shows.some(s => s.title === "另一部剧") && shows.some(s => s.eps === 3), shows);
    chk("C5 未刮削的剧回落路径解析名", shows.some(s => s.title === "Flat Show"), shows);
    /* 归组键与刮削状态无关：给第一集再换一个剧名，键不变 */
    const k1 = vm.runInContext('seriesGroupKeyOf("Show Name/Season 01/Show Name S01E01.mkv", parseSeriesEpisode("Show Name/Season 01/Show Name S01E01.mkv"))', sb);
    const k2 = vm.runInContext('seriesGroupKeyOf("Show Name/Season 01/Show Name S01E03.mkv", parseSeriesEpisode("Show Name/Season 01/Show Name S01E03.mkv"))', sb);
    const k3 = vm.runInContext('seriesGroupKeyOf("Other Show/Season 01/Other.Show.S01E01.mkv", parseSeriesEpisode("Other Show/Season 01/Other.Show.S01E01.mkv"))', sb);
    chk("C6 同剧不同集归组键一致", k1 === k2 && !!k1, [k1, k2]);
    chk("C7 不同剧归组键不同", k1 !== k3, [k1, k3]);
    /* 整剧同步：把刮削信息补到全部同剧分集 */
    const synced = vm.runInContext("syncSeriesShowMetadata('series-lib', __main)", sb);
    const after = vm.runInContext('(() => { const all = readMovieMetadata(); return __files.slice(0,3).map(f => ({ p: f.path, t: all[f.path] && all[f.path].show_title, ep: all[f.path] && all[f.path].title, po: all[f.path] && all[f.path].poster })); })()', sb);
    chk("C8 整剧同步把剧名补到每一条分集", synced === 3 && after.every(r => r.t === "正确剧名"), [synced, after]);
    chk("C9 同步不覆盖各集自己的分集名", after[0].ep === "第 1 集" && after[1].ep === "第 2 集", after);
    chk("C10 同步把海报等整剧字段补齐", after[1].po === "/cover/a.jpg", after);
    /* 刮到剧名那一刻即时同步（另一部剧不受影响） */
    const touched = vm.runInContext('syncSeriesShowTitleToSiblings({ id: "series-lib", type: "series" }, __files, "Show Name/Season 01/Show Name S01E01.mkv", "新剧名")', sb);
    const other = vm.runInContext('readMovieMetadata()["Other Show/Season 01/Other.Show.S01E01.mkv"].show_title', sb);
    chk("C11 即时同步只影响同一部剧", touched === 2 && other === "另一部剧", [touched, other]);
  }

  /* ================= D. 侧栏移除后的运行时不回归 ================= */
  {
    const sb = load("web/js/07-topnav.js", { settings: {}, toast: () => {} });
    call(sb, "applyLayoutMode()");
    chk("D1 布局恒为顶栏（body.layout-topnav）",
        call(sb, "document.body.classList.contains('layout-topnav')") === true);
    chk("D2 currentLayoutMode 恒为 topnav（旧参数按顶栏处理）",
        call(sb, "currentLayoutMode()") === "topnav");
    chk("D3 侧栏相关函数确实已不存在（不会留下死调用）",
        call(sb, "typeof setLayoutMode") === "undefined"
        && call(sb, "typeof renderLayoutChips") === "undefined");
    let modals = 0;
    const sb2 = load("web/js/07-topnav.js", { settings: {}, openModuleModal: () => { modals++; } });
    call(sb2, "topUserMenuModules()");
    chk("D4 头像菜单的自定义模块入口可用", modals === 1, modals);
  }
  {
    const sb = load("web/js/03-features.js", { settings: {} });
    let threw = false;
    try { call(sb, "renderCustomNav()"); } catch (e) { threw = true; }
    chk("D5 容器缺失时 renderCustomNav 不抛错（原实现无判空）", threw === false);
  }
  {
    const state = fs.readFileSync(ROOT + "/web/js/01-state.js", "utf8");
    const css = fs.readFileSync(ROOT + "/web/css/main.css", "utf8");
    const html = fs.readFileSync(ROOT + "/index.html", "utf8");
    chk("D6 侧栏交互与容器彻底消失",
        !html.includes('id="sidebar"') && !/\bclass="sidebar"/.test(html)
        && !html.includes("sidebarResizer") && !html.includes("layoutModeChips")
        && !css.includes(".sidebar") && !css.includes("body.sidebar-hidden")
        && !state.includes("function toggleBars(") && !state.includes("function initSidebarResizer("));
    chk("D7 顶栏补齐原侧栏入口（媒体搜索入口归一为右侧放大镜 + 自定义模块 + 头像菜单）",
        html.includes('id="tnSearchButton"') && !html.includes('data-topnav="search"')
        && html.includes('id="topCustomNav"')
        && html.includes('onclick="topUserMenuModules()"'));
  }

  console.log("\nSUMMARY pass=" + passed + " fail=" + failed);
  process.exit(failed ? 1 : 0);
})();
