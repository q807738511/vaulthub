/* v0.9.96 行为测试（Node VM 桩，真实执行源文件 web/js/02-media.js）：
   A. elementRendered 真值表 —— 固定定位元素（offsetParent 恒为 null）必须有盒子才算可见，
      这正是本次客户反馈「顶栏遮挡播放器」的根因所在
   B. playbackSurfaceVisible 的影视/音频两条分支（真实函数）
   C. syncPlayerImmersive 端到端：播放器打开→回缩顶栏、关闭→恢复、缩成小窗→恢复、
      切走视图→恢复、只有音频播放→不动顶栏
   D. 与旧口径的对照：同一个「固定定位且可见」的浮层，旧表达式判 false、新实现判 true */
const fs = require("fs"), vm = require("vm"), path = require("path");
const ROOT = process.env.VH_ROOT || path.resolve(__dirname, "..");
let passed = 0, failed = 0;
const chk = (name, ok, extra) => {
  if (ok) { passed++; console.log("PASS:", name); }
  else { failed++; console.log("FAIL:", name, extra === undefined ? "" : JSON.stringify(extra)); }
};

/* ---------- 最小 DOM 桩 ---------- */
function fakeEl(extra) {
  const o = extra || {};
  const cls = new Set(o.classes || []);
  const el = {
    classes: cls,
    dataset: Object.assign({}, o.dataset || {}),
    hidden: !!o.hidden,
    __cs: o.cs || { display: "block", visibility: "visible" },
    /* rects: 渲染盒子数量 —— 0 表示没生成盒子（祖先 display:none / 未布局） */
    getClientRects: () => ({ length: o.rects === undefined ? 1 : o.rects }),
    offsetParent: o.offsetParent === undefined ? null : o.offsetParent,   /* 固定定位元素恒为 null */
    textContent: "", innerHTML: "", style: {},
    classList: {
      add(c) { cls.add(c); }, remove(c) { cls.delete(c); }, contains(c) { return cls.has(c); },
      toggle(c, on) { const w = on === undefined ? !cls.has(c) : !!on; w ? cls.add(c) : cls.delete(c); return w; },
    },
    querySelector: o.querySelector || (() => null),
    querySelectorAll: o.querySelectorAll || (() => []),
    closest: o.closest || (() => null),
    addEventListener() {}, appendChild() {}, remove() {}, setAttribute() {},
  };
  return el;
}
function makeSandbox(extra) {
  const bodyClasses = new Set();
  const sandbox = {
    console, Date, Number, Math, String, Array, JSON, Object, parseFloat, parseInt, isNaN, RegExp, Set, Map, Promise, URL,
    encodeURIComponent, decodeURIComponent, setTimeout, clearTimeout, Blob: function Blob() {},
    getComputedStyle: el => (el && el.__cs) || { display: "block", visibility: "visible" },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    document: {
      getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {},
      createElement: () => fakeEl(),
      body: { classList: { add(c) { bodyClasses.add(c); }, remove(c) { bodyClasses.delete(c); }, contains(c) { return bodyClasses.has(c); }, toggle(c, on) { const w = on === undefined ? !bodyClasses.has(c) : !!on; w ? bodyClasses.add(c) : bodyClasses.delete(c); return w; } } },
      documentElement: { style: { setProperty() {} } },
    },
    window: { addEventListener() {}, isSecureContext: false, scrollY: 0, innerHeight: 800, scrollBy() {}, scrollTo() {} },
    navigator: { userAgent: "Mozilla/5.0 (X11; Linux x86_64)" },
    location: { origin: "http://192.0.2.10:8088", pathname: "/", href: "http://192.0.2.10:8088/" },
    curLang: "zh-CN",
    toast: () => {}, t: k => k, tf: k => String(k), esc: s => String(s == null ? "" : s),
    mediaKeepAliveStop: () => {}, mediaKeepAliveStart: () => {},
    fetch: async () => ({ ok: false, json: async () => ({}) }),
    sessionWriteHeaders: () => ({}),
    vaultStoreJSON: (k, d) => d, vaultStoreSet: () => true,
    pushNotification() {}, upsertNotification() {},
    settings: {}, scraperStatus: {},
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

const mediaStub = (doc) => ({
  settings: {}, scraperStatus: {},
  document: Object.assign({
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {},
    createElement: () => fakeEl(),
    body: { classList: { contains: () => false, add() {}, remove() {}, toggle() {} } },
    documentElement: { style: { setProperty() {} } },
  }, doc || {}),
});

(async () => {
  /* ================= A. elementRendered 真值表 ================= */
  {
    const rendered = fakeEl({ rects: 1, offsetParent: null });                 /* 固定定位可见 */
    const noBox = fakeEl({ rects: 0, cs: { display: "none", visibility: "visible" } });
    const invisible = fakeEl({ rects: 1, cs: { display: "block", visibility: "hidden" } });
    const hiddenAttr = fakeEl({ rects: 1, hidden: true });
    const media = load("web/js/02-media.js", mediaStub({}));
    const R = (el) => { media.__el = el; return call(media, "elementRendered(__el)"); };
    chk("A1 固定定位但有渲染盒子（offsetParent=null）→ 视为已渲染", R(rendered) === true);
    chk("A2 没有渲染盒子（祖先 display:none）→ 未渲染", R(noBox) === false);
    chk("A3 visibility:hidden → 未渲染", R(invisible) === false);
    chk("A4 hidden 属性 → 未渲染", R(hiddenAttr) === false);
    chk("A5 null → 未渲染", call(media, "elementRendered(null)") === false);
  }

  /* ================= B. playbackSurfaceVisible 两条分支 ================= */
  {
    const overlayOk = fakeEl({ classes: ["media-reader-overlay", "movie-player"], rects: 1 });
    const overlayNoBox = fakeEl({ classes: ["media-reader-overlay", "movie-player"], rects: 0, cs: { display: "none", visibility: "visible" } });
    const barShow = fakeEl({ classes: ["audio-player", "show"] });
    const barHide = fakeEl({ classes: ["audio-player"] });
    const movieActive = fakeEl({ classes: ["view", "active"], querySelector: sel => (sel === ".media-reader-overlay.movie-player" ? overlayOk : null) });
    const movieActiveNoBox = fakeEl({ classes: ["view", "active"], querySelector: () => overlayNoBox });
    const movieInactive = fakeEl({ classes: ["view"], querySelector: () => overlayOk });
    const audioActive = fakeEl({ classes: ["view", "active"] });

    const mk = (view, bar) => load("web/js/02-media.js", mediaStub({
      getElementById: id => ({ "view-movie": view, "view-audio": audioActive, "audio-bottom-player": bar }[id] || null),
    }));
    const V = 'playbackSurfaceVisible({kind:"video", group:"movie", path:"a.mkv"})';
    const A = 'playbackSurfaceVisible({kind:"audio", group:"audio", path:"a.flac"})';
    chk("B1 影视页活跃 + 浮层有渲染盒子 → 播放面可见", call(mk(movieActive, barHide), V) === true);
    chk("B2 影视页活跃 + 浮层没有渲染盒子 → 播放面不可见", call(mk(movieActiveNoBox, barHide), V) === false);
    chk("B3 影视页不活跃（切走了视图）→ 播放面不可见", call(mk(movieInactive, barHide), V) === false);
    chk("B4 音频分支未变：播放条 show → 可见", call(mk(movieInactive, barShow), A) === true);
    chk("B5 音频分支未变：播放条未 show → 不可见", call(mk(movieInactive, barHide), A) === false);
  }

  /* ================= C. syncPlayerImmersive 端到端 ================= */
  {
    /* 可变状态：浮层是否存在/有盒子/是否最小化、视图是否活跃 */
    const st = { overlay: true, rects: 1, minimized: false, viewActive: true };
    const makeOverlay = () => {
      const cls = new Set(["media-reader-overlay", "movie-player"]);
      if (st.minimized) cls.add("video-minimized");
      return {
        classList: { contains: c => cls.has(c), add(c) { cls.add(c); }, remove(c) { cls.delete(c); }, toggle(c, on) { const w = on === undefined ? !cls.has(c) : !!on; w ? cls.add(c) : cls.delete(c); return w; } },
        getClientRects: () => ({ length: st.rects }),
        __cs: { display: "block", visibility: "visible" },
        closest: () => null, querySelector: () => null, querySelectorAll: () => [],
      };
    };
    const viewEl = { classList: { contains: c => (c === "active" ? st.viewActive : false) }, querySelector: () => (st.overlay ? makeOverlay() : null) };
    const bar = { classList: { contains: c => (c === "show" ? true : false) } };
    /* body 必须用带记忆的 classList（mediaStub 的默认桩是空操作，会让「是否回缩」永远读到 false） */
    const bodyClasses = new Set();
    const media = load("web/js/02-media.js", mediaStub({
      getElementById: id => ({ "view-movie": viewEl, "view-audio": viewEl, "audio-bottom-player": bar }[id] || null),
      querySelectorAll: sel => (sel === ".media-reader-overlay.movie-player" ? (st.overlay ? [makeOverlay()] : []) : []),
      body: { classList: {
        contains: c => bodyClasses.has(c),
        add(c) { bodyClasses.add(c); }, remove(c) { bodyClasses.delete(c); },
        toggle(c, on) { const w = on === undefined ? !bodyClasses.has(c) : !!on; w ? bodyClasses.add(c) : bodyClasses.delete(c); return w; },
      } },
    }));
    const immersive = () => call(media, "document.body.classList.contains('player-immersive')");

    call(media, "syncPlayerImmersive()");
    chk("C1 影视播放器打开（浮层可见、未缩窗）→ 顶栏回缩（player-immersive）", immersive() === true);

    st.overlay = false;                     /* 关闭播放器 */
    call(media, "syncPlayerImmersive()");
    chk("C2 关闭播放器 → 顶栏自动恢复", immersive() === false);

    st.overlay = true; st.minimized = true; /* 缩成控制器小窗 */
    call(media, "syncPlayerImmersive()");
    chk("C3 缩成控制器小窗 → 顶栏恢复（沿用 v0.9.93 口径）", immersive() === false);

    /* 切到别的视图：浮层随祖先 display:none 一起失去渲染盒子（真实浏览器实测 getClientRects 0） */
    st.minimized = false; st.viewActive = false; st.rects = 0;
    call(media, "syncPlayerImmersive()");
    chk("C4 切走视图（浮层随视图隐藏、没有渲染盒子）→ 顶栏恢复", immersive() === false);

    st.viewActive = true; st.rects = 1;
    call(media, "syncPlayerImmersive()");
    chk("C5 回到播放器 → 顶栏再次回缩（幂等可往返）", immersive() === true);

    st.overlay = false; st.rects = 0;
    call(media, "syncPlayerImmersive()");
    chk("C6 只有音频在播、无影视浮层 → 顶栏不动（音乐页照常）", immersive() === false);
  }

  /* ================= D. 新旧口径对照（本 bug 的护栏） ================= */
  {
    const fixedOverlay = fakeEl({ classes: ["media-reader-overlay", "movie-player"], rects: 1, offsetParent: null });
    const media = load("web/js/02-media.js", mediaStub({}));
    media.__el = fixedOverlay;
    chk("D1 固定定位可见浮层：旧写法 offsetParent!==null → false（这就是遮挡根因）",
        call(media, "!!(__el.offsetParent !== null)") === false);
    chk("D2 同一个浮层：新写法 elementRendered → true", call(media, "elementRendered(__el)") === true);
  }

  console.log(`\nSUMMARY pass=${passed} fail=${failed}`);
  process.exit(failed ? 1 : 0);
})();
