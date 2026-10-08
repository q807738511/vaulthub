/* v0.9.95 行为测试（Node VM 桩，真实执行源文件）：
   A. playbackSurfaceVisible 的真实判定（跑 02-media.js）—— 音乐页播放条可见 / 视图不活跃 /
      播放条未显示 / 影视播放器浮层可见 / 浮层被隐藏（offsetParent=null）
   B. 端到端门控：把 02-media.js 的真实 playbackSurfaceVisible 接进 01-state.js 的
      updatePlaybackDock（同一个媒体上下文，模拟「切到别的视图」「播放器占满窗口」），
      断言顶栏迷你播放器的显示/隐藏 —— 这是客户要求的那条规则的完整调用链。
   源文件各自独立 vm 上下文（两个文件各自声明同名 const，同上下文会 SyntaxError）。 */
const fs = require("fs"), vm = require("vm"), path = require("path");
const ROOT = process.env.VH_ROOT || path.resolve(__dirname, "..");
let passed = 0, failed = 0;
const chk = (name, ok, extra) => {
  if (ok) { passed++; console.log("PASS:", name); }
  else { failed++; console.log("FAIL:", name, extra === undefined ? "" : JSON.stringify(extra)); }
};

/* ---------- 最小 DOM 桩：够 playbackSurfaceVisible / updatePlaybackDock 用 ---------- */
function fakeEl(extra) {
  const cls = new Set(extra && extra.classes ? extra.classes : []);
  const el = {
    classes: cls,
    dataset: {},
    style: {},
    offsetParent: extra && "offsetParent" in extra ? extra.offsetParent : { tagName: "DIV" },
    textContent: "",
    innerHTML: "",
    classList: {
      add(c) { cls.add(c); }, remove(c) { cls.delete(c); }, contains(c) { return cls.has(c); },
      toggle(c, on) { const want = on === undefined ? !cls.has(c) : !!on; want ? cls.add(c) : cls.delete(c); return want; },
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {}, appendChild() {}, remove() {}, setAttribute() {},
  };
  if (extra && extra.querySelector) el.querySelector = extra.querySelector;
  return el;
}
function makeSandbox(extra) {
  const storage = {};
  const store = {
    getItem: k => (k in storage ? storage[k] : null),
    setItem: (k, v) => { storage[k] = String(v); },
    removeItem: k => { delete storage[k]; },
    get length() { return Object.keys(storage).length; },
    key: i => (Object.keys(storage)[i] === undefined ? null : Object.keys(storage)[i]),
  };
  const bodyClasses = new Set();
  const sandbox = {
    console, Date, Number, Math, String, Array, JSON, Object, parseFloat, parseInt, isNaN, RegExp, Set, Map, Promise, URL,
    encodeURIComponent, decodeURIComponent, setTimeout, clearTimeout, Blob: function Blob() {},
    storage, localStorage: store,
    document: {
      getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {},
      createElement: () => fakeEl(),
      body: { classList: { add(c) { bodyClasses.add(c); }, remove(c) { bodyClasses.delete(c); }, contains(c) { return bodyClasses.has(c); }, toggle(c, on) { const w = on === undefined ? !bodyClasses.has(c) : !!on; w ? bodyClasses.add(c) : bodyClasses.delete(c); return w; } }, appendChild() {} },
      documentElement: { scrollHeight: 2000, style: { setProperty() {} } },
    },
    window: { handlers: [], addEventListener(ev, fn) { this.handlers.push([ev, fn]); }, isSecureContext: false, scrollY: 0, innerHeight: 800, scrollBy() {}, scrollTo() {}, VAULTHUB_ASSET_VERSION: "0.9.95" },
    navigator: { userAgent: "Mozilla/5.0 (X11; Linux x86_64)" },
    location: { origin: "http://192.0.2.10:8088", pathname: "/", href: "http://192.0.2.10:8088/" },
    curLang: "zh-CN",
    toast: () => {}, t: k => k, tf: k => String(k), esc: s => String(s == null ? "" : s),
    mediaKeepAliveStop: () => {}, mediaKeepAliveStart: () => {},
    fetch: async () => ({ ok: false, json: async () => ({}) }),
    sessionWriteHeaders: () => ({}),
    vaultStoreJSON: (k, d) => { try { const v = store.getItem(k); return v == null ? d : (JSON.parse(v) ?? d); } catch (e) { return d; } },
    vaultStoreSet: (k, v) => { try { store.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } },
    pushNotification() {}, upsertNotification() {},
    settings: {}, scraperStatus: { tmdb_image_base: "https://image.tmdb.org/t/p" },
    activePlayback: () => null, updatePlaybackDock: () => {}, liveActiveVideoElement: () => null,
  };
  return Object.assign(sandbox, extra || {});
}
function load(file, extra) {
  const sb = makeSandbox(extra);
  vm.createContext(sb);
  vm.runInContext(fs.readFileSync(path.join(ROOT, file), "utf8"), sb, { filename: file });
  return sb;
}
const call = (sb, expr) => vm.runInContext(expr, sb);

(async () => {
  /* ================= A. playbackSurfaceVisible 的真实判定（02-media.js） ================= */
  {
    const audioView = fakeEl({ classes: ["view", "active"], id: "view-audio" });
    const audioViewInactive = fakeEl({ classes: ["view"], id: "view-audio" });
    const barShown = fakeEl({ classes: ["audio-player", "show"], id: "audio-bottom-player" });
    const barHidden = fakeEl({ classes: ["audio-player"], id: "audio-bottom-player" });
    const overlayVisible = fakeEl({ classes: ["media-reader-overlay", "movie-player"], offsetParent: { tagName: "BODY" } });
    const overlayHidden = fakeEl({ classes: ["media-reader-overlay", "movie-player"], offsetParent: null });
    const movieView = fakeEl({ classes: ["view", "active"], id: "view-movie", querySelector: sel => (sel === ".media-reader-overlay.movie-player" ? overlayVisible : null) });
    const movieViewNoOverlay = fakeEl({ classes: ["view", "active"], id: "view-movie", querySelector: () => null });
    const movieViewHiddenOverlay = fakeEl({ classes: ["view", "active"], id: "view-movie", querySelector: sel => (sel === ".media-reader-overlay.movie-player" ? overlayHidden : null) });

    const media = load("web/js/02-media.js", {
      settings: {}, scraperStatus: { tmdb_image_base: "https://image.tmdb.org/t/p" },
      document: {
        getElementById: id => ({ "view-audio": audioView, "audio-bottom-player": barShown }[id] || null),
        querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, createElement: () => fakeEl(),
        body: { classList: { contains: () => false, add() {}, remove() {}, toggle() {} }, appendChild() {} },
        documentElement: { style: { setProperty() {} } },
      },
    });
    chk("A1 音乐页活跃且播放条可见 → 播放面可见", call(media, 'playbackSurfaceVisible({kind:"audio", group:"audio", path:"a.flac"})') === true);

    /* 切到别的视图：view-audio 不再 active（同一个函数、同一个上下文） */
    const media2 = load("web/js/02-media.js", {
      settings: {}, scraperStatus: { tmdb_image_base: "https://image.tmdb.org/t/p" },
      document: {
        getElementById: id => ({ "view-audio": audioViewInactive, "audio-bottom-player": barShown }[id] || null),
        querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, createElement: () => fakeEl(),
        body: { classList: { contains: () => false, add() {}, remove() {}, toggle() {} }, appendChild() {} },
        documentElement: { style: { setProperty() {} } },
      },
    });
    chk("A2 切到别的视图（view-audio 不活跃）→ 播放面不可见", call(media2, 'playbackSurfaceVisible({kind:"audio", group:"audio", path:"a.flac"})') === false);

    const media3 = load("web/js/02-media.js", {
      settings: {}, scraperStatus: { tmdb_image_base: "https://image.tmdb.org/t/p" },
      document: {
        getElementById: id => ({ "view-audio": audioView, "audio-bottom-player": barHidden }[id] || null),
        querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, createElement: () => fakeEl(),
        body: { classList: { contains: () => false, add() {}, remove() {}, toggle() {} }, appendChild() {} },
        documentElement: { style: { setProperty() {} } },
      },
    });
    chk("A3 音乐页活跃但播放条未显示 → 播放面不可见", call(media3, 'playbackSurfaceVisible({kind:"audio", group:"audio", path:"a.flac"})') === false);

    const mkMedia = (view, bar) => load("web/js/02-media.js", {
      settings: {}, scraperStatus: { tmdb_image_base: "https://image.tmdb.org/t/p" },
      document: {
        getElementById: id => ({ "view-movie": view, "view-audio": audioView, "audio-bottom-player": bar }[id] || null),
        querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, createElement: () => fakeEl(),
        body: { classList: { contains: () => false, add() {}, remove() {}, toggle() {} }, appendChild() {} },
        documentElement: { style: { setProperty() {} } },
      },
    });
    chk("A4 影视播放器浮层可见 → 播放面可见",
        call(mkMedia(movieView, barHidden), 'playbackSurfaceVisible({kind:"video", group:"movie", path:"m.mkv"})') === true);
    chk("A5 影视页活跃但没有播放器浮层 → 播放面不可见",
        call(mkMedia(movieViewNoOverlay, barHidden), 'playbackSurfaceVisible({kind:"video", group:"movie", path:"m.mkv"})') === false);
    chk("A6 播放器浮层存在但被隐藏（offsetParent=null）→ 播放面不可见",
        call(mkMedia(movieViewHiddenOverlay, barHidden), 'playbackSurfaceVisible({kind:"video", group:"movie", path:"m.mkv"})') === false);
  }

  /* ================= B. 端到端门控（02-media.js 判定 → 01-state.js 浮标） ================= */
  {
    /* 同一个媒体上下文，用可变状态模拟「切视图 / 播放条显隐」，不重建上下文 */
    const state = { viewActive: true, barShown: true, immersive: false };
    const audioView = { classList: { contains: c => (c === "active" ? state.viewActive : false) } };
    const bar = { classList: { contains: c => (c === "show" ? state.barShown : false) } };
    const media = load("web/js/02-media.js", {
      settings: {}, scraperStatus: { tmdb_image_base: "https://image.tmdb.org/t/p" },
      document: {
        getElementById: id => ({ "view-audio": audioView, "audio-bottom-player": bar }[id] || null),
        querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, createElement: () => fakeEl(),
        body: { classList: { contains: () => false, add() {}, remove() {}, toggle() {} }, appendChild() {} },
        documentElement: { style: { setProperty() {} } },
      },
    });

    const dock = fakeEl({ querySelector: sel => ({ "[data-dock-title]": fakeEl(), "[data-dock-sub]": fakeEl(), "[data-dock-toggle]": fakeEl(), ".pd-return": fakeEl() }[sel] || null) });
    const bodyClasses = new Set();
    /* 注意：playbackSurfaceVisible 不是 01-state.js 声明的函数，把它从媒体上下文接过来
       （跨 vm 直接调用函数对象是可行的），这样 01-state.js 走的是真实判定结果。 */
    const sb = load("web/js/01-state.js", {
      document: {
        getElementById: id => (id === "playbackDock" ? dock : null),
        querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, createElement: () => fakeEl(),
        body: { classList: { contains: c => bodyClasses.has(c), add(c) { bodyClasses.add(c); }, remove(c) { bodyClasses.delete(c); }, toggle(c, on) { const w = on === undefined ? !bodyClasses.has(c) : !!on; w ? bodyClasses.add(c) : bodyClasses.delete(c); return w; } } },
        documentElement: { style: { setProperty() {} } },
      },
      playbackSurfaceVisible: cur => media.playbackSurfaceVisible(cur),
      activePlaybackPlaying: c => !c.paused,
      t: k => k,
    });

    call(sb, 'setActivePlayback({kind:"audio", group:"audio", libId:"yy", path:"YY/歌.flac", title:"一首歌", paused:false})');
    chk("B1 音乐页正在播（播放条可见）→ 顶栏不显示迷你播放器（不重复占位）", dock.classList.contains("show") === false);

    state.viewActive = false;                       /* 用户切到首页/阅读等别的视图 */
    call(sb, "updatePlaybackDock()");
    chk("B2 切到别的视图（播放面不可见）→ 迷你播放器出现", dock.classList.contains("show") === true);

    state.viewActive = true;                        /* 又回到音乐页 */
    call(sb, "updatePlaybackDock()");
    chk("B3 回到播放页 → 迷你播放器收起", dock.classList.contains("show") === false);

    state.viewActive = false; state.barShown = false;
    call(sb, "updatePlaybackDock()");
    chk("B4 播放条没显示（例如刚切回来还没渲染）→ 仍显示迷你播放器", dock.classList.contains("show") === true);

    /* 影视播放器占满窗口：顶栏本身已回缩，chip 跟着收起 */
    state.barShown = true;
    call(sb, 'setActivePlayback({kind:"video", group:"movie", libId:"m1", path:"M/x.mkv", title:"x", paused:false})');
    bodyClasses.add("player-immersive");
    call(sb, "updatePlaybackDock()");
    chk("B5 影视播放器占满窗口 → 迷你播放器收起", dock.classList.contains("show") === false);
    bodyClasses.delete("player-immersive");

    call(sb, "clearActivePlayback()");
    chk("B6 主动关闭（清播放状态）→ 迷你播放器不显示", dock.classList.contains("show") === false);
  }

  console.log(`\nSUMMARY pass=${passed} fail=${failed}`);
  process.exit(failed ? 1 : 0);
})();
