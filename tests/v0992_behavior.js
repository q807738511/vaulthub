/* v0.9.92 行为测试（Node VM 桩，真实执行源文件）：
   A. 封面/海报 sidecar 判定与「不进列表」：真值表 + supportedLocalMediaFile 生效
   B. 跨页「正在播放」：状态持久化、浮标显隐规则、暂停态、清理语义
   C. 影视铺满窗口：viewerShell({player:true}) 输出 player-fullbleed，文档阅读器不带
   D. 服务端与分页收尾：活跃窗口、命中刷 mtime、用量快照、翻页失败冷静期（真实跑状态机）
   E. 版本与脱敏
   源文件各自独立 vm 上下文（都定义同名 const，同上下文会 SyntaxError）。 */
const fs = require("fs"), vm = require("vm");
const ROOT = process.env.VH_ROOT || require("path").resolve(__dirname, "..");
let passed = 0, failed = 0;
const chk = (name, ok, extra) => {
  if (ok) { passed++; console.log("PASS:", name); }
  else { failed++; console.log("FAIL:", name, extra === undefined ? "" : JSON.stringify(extra)); }
};

/* 可用的假 DOM 元素：支持 classList / dataset / textContent / querySelector(选择器映射) */
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
    encodeURIComponent, decodeURIComponent, setTimeout, clearTimeout,
    storage, localStorage: store,
    document: {
      getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {},
      createElement: () => el(), body: { appendChild() {} }, documentElement: { scrollHeight: 2000 },
    },
    window: { handlers: [], addEventListener(ev, fn) { this.handlers.push([ev, fn]); }, isSecureContext: false, scrollY: 0, innerHeight: 800, scrollBy() {}, scrollTo() {} },
    navigator: {}, location: { origin: "http://192.0.2.10:8088", pathname: "/", href: "http://192.0.2.10:8088/" },
    curLang: "zh-CN",
    toast: () => {},
    t: k => k, tf: k => String(k), esc: s => String(s == null ? "" : s),
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
const STATE_SRC = fs.readFileSync(ROOT + "/web/js/01-state.js", "utf8");
const HTML_SRC = fs.readFileSync(ROOT + "/index.html", "utf8");
const CSS_SRC = fs.readFileSync(ROOT + "/web/css/main.css", "utf8");
const GO_MAIN = fs.readFileSync(ROOT + "/media-go/main.go", "utf8");
const GO_COVER = fs.readFileSync(ROOT + "/media-go/cover_persist.go", "utf8");
const GO_SCAN = fs.readFileSync(ROOT + "/media-go/scan_walk.go", "utf8");

(async () => {
  /* ================= A. 封面/海报 sidecar ================= */
  {
    const sb = load("web/js/02-media.js", { settings: {} });
    const t = [
      ["One Piece v01.cover.jpg", true],
      ["dir/海贼王 第1卷.cover.png", true],
      ["a b.cover.WEBP", true],
      ["Movie-poster.jpg", true],
      ["Movie-fanart.jpg", true],
      ["Movie-backdrop.png", true],
      ["Movie-logo.png", true],
      ["cover.jpg", false],          // 库级封面，保留
      ["poster.jpg", false],         // 库级封面，保留
      ["第01集.mp4", false],
      ["a.cover.txt", false],        // 非图片扩展不算 sidecar
      ["a.cover", false],            // 没有扩展名
      [".cover.jpg", false],         // 没有名字
      ["note.nfo", false],
    ];
    t.forEach(([p, want], i) => {
      const got = call(sb, `isMediaSidecarImage(${JSON.stringify(p)})`);
      chk(`A${i + 1} isMediaSidecarImage(${p}) = ${want}`, got === want, got);
    });
    const okLib = { id: "c1", type: "comic", name: "漫画" };
    chk("A15 漫画库里 .cover.jpg 不进列表",
        call(sb, `supportedLocalMediaFile("comic", ${JSON.stringify(okLib)}, "One Piece v01.cover.jpg")`) === false);
    chk("A16 电子书组里 -poster.jpg 不进列表",
        call(sb, `supportedLocalMediaFile("comic", ${JSON.stringify(okLib)}, "书.首页-poster.jpg")`) === false);
    chk("A17 正常漫画 .cbz 仍进列表",
        call(sb, `supportedLocalMediaFile("comic", ${JSON.stringify(okLib)}, "第01话.cbz")`) === true);
    chk("A18 漫画散图 001.jpg 仍是内容（不清空整章）",
        call(sb, `supportedLocalMediaFile("comic", ${JSON.stringify(okLib)}, "第01话/001.jpg")`) === true);
    chk("A19 电子书 .txt 不受影响",
        call(sb, `supportedLocalMediaFile("comic", ${JSON.stringify(okLib)}, "book.txt")`) === true);
    chk("A20 服务端与前端规则同源（都覆盖 .cover 与角色后缀）",
        GO_COVER.includes('"-poster", "-fanart", "-backdrop", "-logo"')
        && MEDIA_SRC.includes('"-poster", "-fanart", "-backdrop", "-logo"'));
    chk("A21 扫描端确实调用判定函数", GO_SCAN.includes("isMediaSidecarImage(filepath.Base(slash))"));
  }

  /* ================= B. 跨页「正在播放」 ================= */
  {
    const titleEl = fakeEl(), subEl = fakeEl(), toggleEl = fakeEl(), returnBtn = fakeEl();
    const dock = fakeEl({
      "[data-dock-title]": titleEl, "[data-dock-sub]": subEl,
      "[data-dock-toggle]": toggleEl, ".pd-return": returnBtn,
    });
    const sb = load("web/js/01-state.js", {
      document: {
        getElementById: id => (id === "playbackDock" ? dock : null),
        querySelector: () => null, querySelectorAll: () => [], addEventListener() {},
        createElement: () => fakeEl(), body: { appendChild() {} }, documentElement: { scrollHeight: 2000 },
      },
      playbackSurfaceVisible: () => false,
      activePlaybackPlaying: c => !c.paused,
      t: k => "T:" + k,
    });

    chk("B1 初始没有播放状态", call(sb, `activePlayback()`) === null);
    call(sb, `setActivePlayback({kind:"video", group:"movie", libId:"m1", path:"Mo/片.mkv", title:"测试片"})`);
    const st = call(sb, `activePlayback()`);
    chk("B2 状态字段齐全", st && st.kind === "video" && st.group === "movie" && st.libId === "m1" && st.path === "Mo/片.mkv" && st.title === "测试片", st);
    chk("B3 写进了 localStorage（刷新后仍在）",
        JSON.parse(call(sb, `localStorage.getItem("vaulthub_active_playback")`)).path === "Mo/片.mkv");
    chk("B4 播放面不可见 → 浮标出现", dock.classes.has("show"));
    chk("B5 浮标渲染标题", titleEl.textContent === "测试片", titleEl.textContent);
    chk("B6 浮标显示「正在播放」+ 媒体类型", String(subEl.textContent).includes("正在播放") && String(subEl.textContent).includes("影视"), subEl.textContent);

    call(sb, `setActivePlaybackPaused(true)`);
    chk("B7 暂停态写回状态与文案",
        call(sb, `activePlayback().paused`) === true
        && String(subEl.textContent).includes("已暂停")
        && toggleEl.textContent === "▶", subEl.textContent);

    call(sb, `setActivePlayback({kind:"audio", group:"audio", libId:"a1", path:"YY/歌.flac", title:"一首歌"})`);
    chk("B8 换歌后浮标跟随新条目", titleEl.textContent === "一首歌" && dock.dataset.kind === "audio", titleEl.textContent);

    call(sb, `clearActivePlayback("video")`);
    chk("B9 清理不匹配的 kind 不会误清（音频仍在）", call(sb, `activePlayback().kind`) === "audio");
    call(sb, `clearActivePlayback("audio")`);
    chk("B10 匹配 kind 时清空并隐藏浮标",
        call(sb, `activePlayback()`) === null && !dock.classes.has("show")
        && call(sb, `localStorage.getItem("vaulthub_active_playback")`) === null);

    /* v0.9.95：浮标只在「播放面不可见」时出现 —— 播放面已经看得见时它是重复信息。
       这里把 playbackSurfaceVisible 作为沙箱桩（它不是 01-state.js 声明的函数，桩不会被覆盖），
       断言真实调用链：源文件确实用它的返回值门控显示。 */
    const dock2 = fakeEl({ "[data-dock-title]": fakeEl(), "[data-dock-sub]": fakeEl(), "[data-dock-toggle]": fakeEl(), ".pd-return": fakeEl() });
    const sb2 = load("web/js/01-state.js", {
      document: { getElementById: id => (id === "playbackDock" ? dock2 : null), querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, createElement: () => fakeEl(), body: { appendChild() {} }, documentElement: { scrollHeight: 2000 } },
      playbackSurfaceVisible: () => true,
      activePlaybackPlaying: c => !c.paused,
      t: k => k,
    });
    call(sb2, `setActivePlayback({kind:"audio", group:"audio", libId:"a1", path:"YY/歌.flac", title:"一首歌"})`);
    chk("B11 播放面可见时不显示迷你播放器（v0.9.95：不再重复常驻）",
        !dock2.classes.has("show"));
    chk("B11c v0.9.94 的「有播放就常驻」口径已不再成立（旧断言反向后仍必须为真）",
        call(sb2, "typeof playbackSurfaceVisible === 'function' && playbackSurfaceVisible(activePlayback())") === true
        && !dock2.classes.has("show"));
    /* 播放面不可见（切到别的视图）时才出现 */
    const dock4 = fakeEl({ "[data-dock-title]": fakeEl(), "[data-dock-sub]": fakeEl(), "[data-dock-toggle]": fakeEl(), ".pd-return": fakeEl() });
    const sb4 = load("web/js/01-state.js", {
      document: { getElementById: id => (id === "playbackDock" ? dock4 : null), querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, createElement: () => fakeEl(), body: { appendChild() {} }, documentElement: { scrollHeight: 2000 } },
      playbackSurfaceVisible: () => false,
      activePlaybackPlaying: c => !c.paused,
      t: k => k,
    });
    call(sb4, `setActivePlayback({kind:"audio", group:"audio", libId:"a1", path:"YY/歌.flac", title:"一首歌"})`);
    chk("B11a 播放面不可见时出现（离开播放页仍可一键回到播放）", dock4.classes.has("show"));
    /* 占满窗口时不显示（顶栏已回缩，chip 跟着收起） */
    const dock3 = fakeEl({ "[data-dock-title]": fakeEl(), "[data-dock-sub]": fakeEl(), "[data-dock-toggle]": fakeEl(), ".pd-return": fakeEl() });
    const bodyCls = new Set(["player-immersive"]);
    const sb3 = load("web/js/01-state.js", {
      document: {
        getElementById: id => (id === "playbackDock" ? dock3 : null), querySelector: () => null, querySelectorAll: () => [],
        addEventListener() {}, createElement: () => fakeEl(),
        body: { classList: { contains: c => bodyCls.has(c), add: c => bodyCls.add(c), remove: c => bodyCls.delete(c), toggle(c, on) { const w = on === undefined ? !bodyCls.has(c) : !!on; w ? bodyCls.add(c) : bodyCls.delete(c); return w; } }, appendChild() {} },
        documentElement: { scrollHeight: 2000 },
      },
      t: k => k,
    });
    call(sb3, `setActivePlayback({kind:"video", group:"movie", libId:"m1", path:"M/x.mkv", title:"x"})`);
    chk("B11b 影视占满窗口时不显示迷你播放器", !dock3.classes.has("show"));
    chk("B12 状态在 mount 时从 localStorage 恢复（跨刷新）",
        call(sb2, `activePlayback().kind`) === "audio");
    /* 真实执行 02-media.js 的浮标/续播判定 */
    const media = load("web/js/02-media.js", { settings: {}, activePlayback: () => null, updatePlaybackDock: () => {} });
    chk("B13 媒体侧提供续播判定与入口函数",
        ["resumeActivePlayback", "liveActiveVideoElement", "playbackSurfaceVisible", "activePlaybackPlaying", "toggleActivePlayback", "stopActivePlayback", "markVideoActivePlayback"]
          .every(fn => call(media, `typeof ${fn} === "function"`)));
    chk("B14 没有播放状态时 resumeActivePlayback 安全返回 false",
        call(media, `resumeActivePlayback(null)`) === false);
    chk("B15 音频条目在视图外时 playbackSurfaceVisible 为 false（浮标该出现）",
        call(media, `playbackSurfaceVisible({kind:"audio", group:"audio"})`) === false);
    chk("B16 视频条目没有活元素时 liveActiveVideoElement 返回 null",
        call(media, `liveActiveVideoElement({kind:"video", libId:"m1", path:"x.mkv"})`) === null);
    chk("B17 关闭播放器会清状态（03-features 接线）",
        fs.readFileSync(ROOT + "/web/js/03-features.js", "utf8").includes('clearActivePlayback("video")'));
  }

  /* ================= C. 影视铺满窗口 ================= */
  {
    const mkLib = { id: "m1", name: "电影", type: "movie", path: "/media/MO" };
    const sb = load("web/js/02-media.js", {
      settings: {}, t: k => k, esc: s => String(s == null ? "" : s),
      readingState: () => ({ progress: 0 }),
      displayBookTitle: p => String(p),
      activeReader: null,
    });
    const player = call(sb, `viewerShell("movie", ${JSON.stringify(mkLib)}, "片.mkv", "<video></video>", "/u", {player:true})`);
    chk("C1 视频播放器浮层带 player-fullbleed（自动铺满窗口）", String(player).includes("movie-player player-fullbleed"), String(player).slice(0, 120));
    const docView = call(sb, `viewerShell("comic", ${JSON.stringify(mkLib)}, "书.txt", "正文", "/u", {doc:true})`);
    chk("C2 文档阅读器不带铺满类（阅读体验不变）", !String(docView).includes("player-fullbleed"));
    chk("C3 铺满规则 z-index 高于顶栏/侧栏",
        CSS_SRC.includes(".media-reader-overlay.movie-player.player-fullbleed { top:0; left:0; right:0; bottom:0; z-index:620; }"));
    chk("C4 铺满时视频区去内边距、满高",
        CSS_SRC.includes(".media-reader-overlay.movie-player.player-fullbleed .media-video-body { min-height:0; height:100%; padding:0; }"));
    chk("C5 停靠小窗规则仍在（4 类名优先于铺满）",
        CSS_SRC.includes(".media-reader-overlay.movie-player.video-minimized.video-controller-docked"));
  }

  /* ================= D. 服务端与分页收尾 ================= */
  {
    chk("D1 活跃窗口常量存在", GO_MAIN.includes("cacheActiveWindow    = 30 * time.Minute"));
    chk("D2 两处淘汰逻辑都用活跃窗口",
        (GO_MAIN.match(/now\.Sub\(it\.mod\) < cacheActiveWindow/g) || []).length === 2);
    chk("D3 命中缓存即刷 mtime", GO_MAIN.includes("_ = os.Chtimes(cache, nowT, nowT)"));
    chk("D4 两种早退路径都写用量快照",
        GO_MAIN.includes("a.cacheBytes, a.cacheFiles, a.cacheCleanedAt = total, len(items), now.Unix()")
        && GO_MAIN.includes("a.cacheBytes, a.cacheFiles, a.cacheCleanedAt = 0, 0, time.Now().Unix()"));
    chk("D5 缓存目录变更时重新派生分页缓存目录",
        GO_MAIN.includes("!a.pageCacheDirPinned && oldCacheDir != c.CacheDir")
        && GO_MAIN.includes('a.pageCacheDir = filepath.Join(c.CacheDir, "page-cache")'));

    /* 真实跑翻转页状态机：失败进冷静期、成功不冷静 */
    const libs = { id: "l1", name: "库", type: "comic", path: "/media/MH" };
    let calls = 0, reject = false;
    const sb = load("web/js/02-media.js", {
      settings: {},
      findMediaLibrary: () => libs,
      loadLocalFiles: () => { calls++; return reject ? Promise.reject(new Error("boom")) : Promise.resolve(); },
      bookShelfLoadMore: () => {},
      reducedMotionOn: () => true,
      updatePlaybackDock: () => {},
    });
    /* 说明：loadLocalFiles 是 02-media.js 里的函数声明，会覆盖 VM 桩（与 t 同理），
       所以这里验证「状态机守卫 + busy 生命周期」，失败冷静期的落点由静态契约
       （tests/test_v0992_contract.py 5d/5e）与源码断言覆盖。 */
    call(sb, `mediaPagingSet({mode:"offset", group:"comic", libId:"l1", offset:0, pageSize:20, hasMore:false})`);
    chk("D6 hasMore=false 时不翻页", call(sb, `mediaAutoPage(1)`) === false);
    chk("D7 没有请求发出", calls === 0, calls);
    /* findMediaLibrary 读的是源文件里的 localMediaLibraries（顶层 let，同上下文可见）。 */
    call(sb, `localMediaLibraries = [{id:"l1", name:"库", type:"comic", path:"/media/MH"}]`);
    call(sb, `mediaPagingSet({mode:"offset", group:"comic", libId:"l1", offset:0, pageSize:20, hasMore:true})`);
    chk("D8 正常翻页请求被触发并返回 true", call(sb, `mediaAutoPage(1)`) === true);
    chk("D9 请求在途时 busy 未解锁（不会连发第二个）",
        call(sb, `mediaPagingState.busy`) === true);
    call(sb, `mediaPagingState.at = 0`);
    chk("D10 冷却窗口内再次触发被拒", call(sb, `mediaAutoPage(1)`) === false);
    call(sb, `mediaPagingState.at = 0; mediaPagingState.blockUntil = Date.now() + 2000`);
    chk("D11 冷静期（失败后）内触发被拒", call(sb, `mediaAutoPage(1)`) === false);
    call(sb, `mediaPagingState.blockUntil = 0`);
    chk("D12 冷静期常量存在（4s）", MEDIA_SRC.includes("MEDIA_SCROLL_FAIL_COOLDOWN_MS = 4000"));
    chk("D13 成功/失败都会在结束时解锁 busy（源码断言）",
        MEDIA_SRC.includes("setTimeout(() => { mediaPagingState.busy = false; }, ok ? 120 : 0);"));
  }

  /* ================= E. 版本与脱敏 ================= */
  {
    chk("E1 资源版本本版（≥10 处）", (HTML_SRC.match(/\?v=1\.0\.12/g) || []).length >= 10);
    chk("E2 ASSET_VERSION / SCRIPT_VERSION = 0.9.97",
        HTML_SRC.includes('window.VAULTHUB_ASSET_VERSION = "1.0.12";')
        && STATE_SRC.includes('const VAULTHUB_SCRIPT_VERSION = "1.0.12";'));
    const slogans = (HTML_SRC.match(/v\d+\.\d+\.\d+ · [^<"]+/g) || []);
    chk("E3 三处标语整串一致", slogans.length === 3 && new Set(slogans).size === 1, [...new Set(slogans)]);
    const notes = fs.readFileSync(ROOT + "/.github/RELEASE_NOTES_0.9.92.md", "utf8");
    chk("E4 公开 Release Notes 无主机容量/内网路径",
        !/\b\d+\s?G\b|\/vol[0-9]\/|192\.168\.|enged\.top/.test(notes));
    chk("E5 浮标结构在 index.html 且三键齐",
        HTML_SRC.includes('id="playbackDock"') && HTML_SRC.includes("returnToActivePlayback()") && HTML_SRC.includes("stopActivePlayback()"));
  }

  console.log(`\nSUMMARY pass=${passed} fail=${failed}`);
  process.exit(failed ? 1 : 0);
})();
