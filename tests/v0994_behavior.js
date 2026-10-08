/* v0.9.94 行为测试（Node VM 桩，真实执行源文件）：
   A. 需求1 迷你播放器常驻条件（真实跑 01-state.js 的 updatePlaybackDock）
   B. 需求2 搜索弹窗开合 / Ctrl+K / 点遮罩关闭（真实跑 07-topnav.js）
   C. 需求9 季标签解析与归组（真实跑 02-media.js 的 parseSeriesSeasonTag / seriesSeasonTagOf /
      seriesGroupKeyOf / buildSeriesShows / fetchSeriesSeason）
   D. 需求6 音频播放模式：四模式四图标 + 不再弹窗（真实跑 setAudioLoop / cycleAudioLoop）
   E. 需求3/4/5 视频控制条：模板里没有随机/重复、最大化在设置与更多之间、VCD 双三角、
      播完与上一集/下一集规则（真实跑 videoPlaybackEnded / videoPlayNeighbour）
   源文件各自独立 vm 上下文（多个文件定义同名 const，同上下文会 SyntaxError）。 */
const fs = require("fs"), vm = require("vm"), path = require("path");
const ROOT = process.env.VH_ROOT || path.resolve(__dirname, "..");
let passed = 0, failed = 0;
const chk = (name, ok, extra) => {
  if (ok) { passed++; console.log("PASS:", name); }
  else { failed++; console.log("FAIL:", name, extra === undefined ? "" : JSON.stringify(extra)); }
};

function makeSandbox(extra) {
  const storage = {};
  const store = {
    getItem: k => (k in storage ? storage[k] : null),
    setItem: (k, v) => { storage[k] = String(v); },
    removeItem: k => { delete storage[k]; },
    get length() { return Object.keys(storage).length; },
    key: i => (Object.keys(storage)[i] === undefined ? null : Object.keys(storage)[i]),
  };
  const el = () => ({ value: "", textContent: "", innerHTML: "", style: {}, dataset: {}, classList: { add() {}, remove() {}, contains: () => false, toggle() {} }, addEventListener() {}, appendChild() {}, remove() {}, setAttribute() {}, querySelector: () => null, querySelectorAll: () => [] });
  const bodyClasses = new Set();
  const sandbox = {
    console, Date, Number, Math, String, Array, JSON, Object, parseFloat, parseInt, isNaN, RegExp, Set, Map, Promise, URL,
    encodeURIComponent, decodeURIComponent, setTimeout, clearTimeout, Blob: function Blob() {},
    storage, localStorage: store,
    document: {
      getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {},
      createElement: () => el(),
      body: { classList: { add(c) { bodyClasses.add(c); }, remove(c) { bodyClasses.delete(c); }, contains(c) { return bodyClasses.has(c); }, toggle(c, on) { const w = on === undefined ? !bodyClasses.has(c) : !!on; w ? bodyClasses.add(c) : bodyClasses.delete(c); return w; } }, appendChild() {} },
      documentElement: { scrollHeight: 2000, style: { setProperty() {} } },
    },
    window: { handlers: [], addEventListener(ev, fn) { this.handlers.push([ev, fn]); }, isSecureContext: false, scrollY: 0, innerHeight: 800, scrollBy() {}, scrollTo() {}, VAULTHUB_ASSET_VERSION: "0.9.97" },
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
  /* ================= A. 需求1 迷你播放器常驻条件 ================= */
  {
    const dockTitle = { textContent: "" }, dockSub = { textContent: "" }, dockToggle = { textContent: "" }, dockReturn = { textContent: "" };
    const dock = {
      dataset: {}, classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); }, toggle(c, on) { const w = on === undefined ? !this._s.has(c) : !!on; w ? this._s.add(c) : this._s.delete(c); return w; } },
      querySelector: sel => ({ "[data-dock-title]": dockTitle, "[data-dock-sub]": dockSub, "[data-dock-toggle]": dockToggle, ".pd-return": dockReturn }[sel] || null),
    };
    /* 注意：activePlayback / setActivePlayback / clearActivePlayback 都由 01-state.js 自己声明，
       用 sandbox 传同名桩会被函数声明覆盖 —— 所以一律用源文件自己的 setter 造状态。 */
    const bodyClasses = new Set();
    const sb = load("web/js/01-state.js", {
      document: {
        getElementById: id => (id === "playbackDock" ? dock : null),
        querySelector: () => null, querySelectorAll: () => [], addEventListener() {},
        createElement: () => ({ style: {}, classList: { add() {} }, addEventListener() {} }),
        body: { classList: { contains: c => bodyClasses.has(c), add(c) { bodyClasses.add(c); }, remove(c) { bodyClasses.delete(c); }, toggle(c, on) { const w = on === undefined ? !bodyClasses.has(c) : !!on; w ? bodyClasses.add(c) : bodyClasses.delete(c); return w; } } },
        documentElement: { style: { setProperty() {} } },
      },
    });
    call(sb, 'setActivePlayback({ kind: "video", group: "movie", libId: "movie-1", path: "/m/幽游白书/S01E01.mkv", title: "幽游白书 第1集", paused: false })');
    call(sb, "updatePlaybackDock()");
    chk("A1 有播放、未占满窗口、可见性判定不可用（兜底路径）→ 显示迷你播放器", dock.classList.contains("show") === true);
    chk("A2 常驻时写入 kind/playing 与标题", dock.dataset.kind === "video" && dock.dataset.playing === "1" && dockTitle.textContent === "幽游白书 第1集", { kind: dock.dataset.kind, playing: dock.dataset.playing, title: dockTitle.textContent });
    chk("A3 播放中显示暂停图标", dockToggle.textContent === "⏸");

    call(sb, 'setActivePlayback({ kind: "audio", group: "audio", libId: "yy", path: "/yy/a.mp3", title: "某首歌", paused: true })');
    call(sb, "updatePlaybackDock()");
    chk("A4 音频暂停中仍然常驻（不是关闭就一直在）", dock.classList.contains("show") === true && dock.dataset.kind === "audio");
    chk("A5 暂停时显示播放图标", dockToggle.textContent === "▶");
    /* 源文件自带真实 i18n 表（t 由 01-state.js 定义），所以这里断言真实文案。 */
    chk("A6 副标题体现暂停 + 类型", dockSub.textContent.indexOf("暂停") >= 0 && dockSub.textContent.indexOf("音乐") >= 0, dockSub.textContent);

    bodyClasses.add("player-immersive");   /* 影视播放器占满窗口 = 顶栏已回缩 */
    call(sb, 'setActivePlayback({ kind: "video", group: "movie", libId: "movie-1", path: "/m/x.mkv", title: "x", paused: false })');
    call(sb, "updatePlaybackDock()");
    chk("A7 影视占满窗口（顶栏已回缩）时不显示 chip", dock.classList.contains("show") === false);
    bodyClasses.delete("player-immersive");

    call(sb, "clearActivePlayback()");
    chk("A8 主动关闭（清播放状态）→ 不常驻", dock.classList.contains("show") === false);

    /* v0.9.95：可见性判定真正参与门控 —— playbackSurfaceVisible 由 02-media.js 声明
       （不是 01-state.js 的函数），所以沙箱桩不会被覆盖，这里跑的是真实调用链。 */
    const mkDock2 = () => {
      const t2 = { textContent: "" };
      return {
        dataset: {},
        classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); }, toggle(c, on) { const w = on === undefined ? !this._s.has(c) : !!on; w ? this._s.add(c) : this._s.delete(c); return w; } },
        querySelector: sel => ({ "[data-dock-title]": t2, "[data-dock-sub]": t2, "[data-dock-toggle]": t2, ".pd-return": t2 }[sel] || null),
      };
    };
    const withSurface = flag => {
      const d = mkDock2();
      const s = load("web/js/01-state.js", {
        document: { getElementById: id => (id === "playbackDock" ? d : null), querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, createElement: () => ({ style: {}, classList: { add() {} }, addEventListener() {} }), body: { classList: { contains: () => false, add() {}, remove() {}, toggle() {} } }, documentElement: { style: { setProperty() {} } } },
        playbackSurfaceVisible: () => flag,
        t: k => k,
      });
      call(s, 'setActivePlayback({ kind: "audio", group: "audio", libId: "yy", path: "/yy/a.mp3", title: "某首歌", paused: false })');
      call(s, "updatePlaybackDock()");
      return d;
    };
    chk("A11 播放面可见（影视播放器/音乐页播放器已在屏幕上）→ 不显示迷你播放器", withSurface(true).classList.contains("show") === false);
    chk("A12 播放面不可见（切到别的视图）→ 显示迷你播放器", withSurface(false).classList.contains("show") === true);
  }
  /* 迷你播放器在顶栏里、搜索图标左侧、且不固定定位（静态契约的运行期对照） */
  {
    const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
    const actions = html.slice(html.indexOf('<div class="tn-actions">'), html.indexOf('<div class="tn-pop" id="topUserMenu"'));
    chk("A9 顶栏操作区顺序：迷你播放器 → 搜索图标 → 通知 → 头像",
        actions.indexOf('id="playbackDock"') < actions.indexOf('id="tnSearchButton"')
        && actions.indexOf('id="tnSearchButton"') < actions.indexOf('class="tn-notify-wrap"')
        && actions.indexOf('class="tn-notify-wrap"') < actions.indexOf('id="topUserButton"'));
    const dockCss = fs.readFileSync(path.join(ROOT, "web/css/main.css"), "utf8").split(".playback-dock {")[1].split("}")[0];
    chk("A10 迷你播放器不是 fixed 浮层（已随顶栏布局）", !dockCss.includes("position:fixed") && !dockCss.includes("bottom:18px"));
  }

  /* ================= B. 需求2 搜索弹窗 ================= */
  {
    const maskClass = new Set(["modal-mask", "search-modal-mask"]);
    const modal = { classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); }, toggle(c, on) { const w = on === undefined ? !this._s.has(c) : !!on; w ? this._s.add(c) : this._s.delete(c); return w; } } };
    const searchBox = { value: "", focus() { this.focused = true; }, select() { this.selected = true; } };
    const button = { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } };
    const handlers = [];
    const sb = load("web/js/07-topnav.js", {
      document: {
        getElementById: id => ({ mediaSearchModal: modal, mediaSearchInput: searchBox, tnSearchButton: button }[id] || null),
        querySelector: () => null, querySelectorAll: () => [],
        addEventListener: (ev, fn) => handlers.push([ev, fn]),
        createElement: () => ({ style: {}, classList: { add() {} }, addEventListener() {}, appendChild() {}, setAttribute() {} }),
        body: { classList: { contains: () => false, add() {}, remove() {}, toggle() {} } },
        documentElement: { style: { setProperty() {} } },
      },
    });
    call(sb, "initTopNav()");   /* 绑定全局 click / keydown 委托 */
    chk("B1 初始未打开", call(sb, "mediaSearchModalOpen()") === false);

    call(sb, "toggleMediaSearchModal()");
    chk("B2 点放大镜 → 弹窗打开", modal.classList.contains("show") === true && call(sb, "mediaSearchModalOpen()") === true);
    chk("B3 图标 aria-expanded 同步为 true", button.attrs["aria-expanded"] === "true");
    chk("B4 打开时聚焦搜索框", searchBox.focused === true);

    call(sb, "toggleMediaSearchModal()");
    chk("B5 再点一次 → 关闭并复位 aria-expanded", modal.classList.contains("show") === false && button.attrs["aria-expanded"] === "false");

    call(sb, "openMediaSearchModal()");
    const keyHandler = handlers.filter(h => h[0] === "keydown").map(h => h[1])[0];
    chk("B6 已绑定全局 keydown 委托", typeof keyHandler === "function");
    let prevented = false;
    keyHandler({ key: "k", ctrlKey: true, metaKey: false, preventDefault() { prevented = true; } });
    chk("B7 Ctrl+K 打开弹窗并阻止默认行为", modal.classList.contains("show") === true && prevented === true);
    keyHandler({ key: "Escape" });
    chk("B8 Esc 关闭弹窗", modal.classList.contains("show") === false);

    call(sb, "openMediaSearchModal()");
    const clickHandler = handlers.filter(h => h[0] === "click").map(h => h[1])[0];
    chk("B9 已绑定全局 click 委托", typeof clickHandler === "function");
    clickHandler({ target: { classList: { contains: c => maskClass.has(c) }, closest: () => null } });
    chk("B10 点遮罩关闭弹窗", modal.classList.contains("show") === false);
    call(sb, "openMediaSearchModal()");
    clickHandler({ target: { classList: { contains: () => false }, closest: () => null } });
    chk("B11 点弹窗内部不关闭", modal.classList.contains("show") === true);

    chk("B12 搜索取值指向弹窗输入框", call(sb, "topNavSearchBox()") === searchBox);
    const css = fs.readFileSync(path.join(ROOT, "web/css/main.css"), "utf8");
    chk("B13 弹窗带弹出动画（keyframes + 从右上角缩放）",
        css.includes("@keyframes searchModalPop") && css.includes("transform-origin: 92% 0"));
    chk("B14 减少动效偏好下不动画", css.includes("@media (prefers-reduced-motion: reduce) { .search-modal-mask.show .search-modal { animation: none; } }"));
  }

  /* ================= C. 需求9 季标签与多季度归组 ================= */
  {
    const sb = load("web/js/02-media.js", { settings: {}, scraperStatus: { tmdb_image_base: "https://image.tmdb.org/t/p" } });
    const parse = text => call(sb, `JSON.stringify(parseSeriesSeasonTag(${JSON.stringify(text)}))`);
    const cases = [
      ["幽游白书S04", "幽游白书", 4],
      ["幽游白书 S1", "幽游白书", 1],
      ["幽游白书 第4季", "幽游白书", 4],
      ["幽游白书S01E12", "幽游白书", 1],
      ["Bleach S02", "Bleach", 2],
    ];
    let allOk = true;
    for (const [raw, show, season] of cases) {
      const got = JSON.parse(parse(raw));
      if (!got || got.show !== show || got.season !== season) { allOk = false; console.log("     季标签解析异常：", raw, parse(raw)); }
    }
    chk("C1 季标签解析：S0N / S N / 第N季 / S0NE0M（含英文剧名）", allOk);
    chk("C2 普通标签不当季标签（国配 / 完结 / 1080p）",
        call(sb, 'parseSeriesSeasonTag("国配")') === null && call(sb, 'parseSeriesSeasonTag("完结")') === null
        && call(sb, 'parseSeriesSeasonTag("1080p")') === null);
    chk("C3 空/纯季号不当季标签", call(sb, 'parseSeriesSeasonTag("")') === null && call(sb, 'parseSeriesSeasonTag("S04")') === null);
    chk("C4 季号写进 tag 字段（S04 两位补零）", JSON.parse(parse("幽游白书 第4季")).tag === "S04");

    /* seriesSeasonTagOf：手工标签优先，其次目录名 */
    call(sb, `writeMovieMetadata({ "/m/幽游白书/S01E01.mkv": { tags: ["幽游白书S01"] }, "/m/幽游白书/S04E02.mkv": { tags: ["国配", "幽游白书S04"] } })`);
    const t1 = JSON.parse(call(sb, 'JSON.stringify(seriesSeasonTagOf("/m/幽游白书/S01E01.mkv"))'));
    const t4 = JSON.parse(call(sb, 'JSON.stringify(seriesSeasonTagOf("/m/幽游白书/S04E02.mkv"))'));
    chk("C5 手工标签识别（S01 与夹在中间的 S04）", t1 && t1.season === 1 && t4 && t4.season === 4 && t4.show === "幽游白书");
    const byDir = JSON.parse(call(sb, 'JSON.stringify(seriesSeasonTagOf("/m/幽游白书S07/Season 01/01.mkv"))'));
    chk("C6 回落到目录名（目录就叫 幽游白书S07）", byDir && byDir.season === 7 && byDir.show === "幽游白书");
    chk("C7 无标签返回 null", call(sb, 'seriesSeasonTagOf("/m/别的剧/S01E01.mkv")') === null);

    /* 归组：同一部剧的不同季 → 同一个键；不同剧 → 不同键 */
    const k1 = call(sb, 'seriesGroupKeyOf("/m/幽游白书S01/Season 01/S01E01.mkv", parseSeriesEpisode("/m/幽游白书S01/Season 01/S01E01.mkv"))');
    const k4 = call(sb, 'seriesGroupKeyOf("/m/幽游白书S04/Season 04/S04E02.mkv", parseSeriesEpisode("/m/幽游白书S04/Season 04/S04E02.mkv"))');
    const other = call(sb, 'seriesGroupKeyOf("/m/Bleach/S01E01.mkv", parseSeriesEpisode("/m/Bleach/S01E01.mkv"))');
    chk("C8 同剧不同季 → 同一个归组键（多季度分离刮削后仍在一张卡里）", k1 === k4 && k1.indexOf("tag:") === 0);
    chk("C9 不同剧 → 不同键", k1 !== other && other.indexOf("tag:") !== 0);

    /* buildSeriesShows：季标签的剧名当卡片名；两季归到一张卡并按季分开 */
    const files = [
      { path: "/m/幽游白书/Season 01/S01E01.mkv", size: 100 },
      { path: "/m/幽游白书/Season 01/S01E02.mkv", size: 100 },
      { path: "/m/幽游白书/Season 04/S04E01.mkv", size: 100 },
    ];
    const shows = JSON.parse(call(sb, `JSON.stringify(buildSeriesShows(${JSON.stringify(files)}).map(s => ({ title: s.title, seasons: s.seasonList.map(x => x.season), episodes: s.files.length })))`));
    chk("C10 两季归到同一张剧集卡", shows.length === 1, shows);
    chk("C11 卡片名用标签里的剧名（未刮削也能显示对）", shows[0] && shows[0].title === "幽游白书");
    chk("C12 卡内按季分开（S01 / S04）", shows[0] && JSON.stringify(shows[0].seasons) === "[1,4]");
    chk("C13 分集总数正确", shows[0] && shows[0].episodes === 3);

    /* fetchSeriesSeason：请求季端点（带 season 参数），解析季名/季海报/分集名 */
    const urls = [];
    const sb2 = load("web/js/02-media.js", {
      settings: {},
      scraperStatus: { tmdb_image_base: "https://image.tmdb.org/t/p" },
      fetch: async url => {
        urls.push(String(url));
        return {
          ok: true,
          json: async () => ({ name: "幽游白书 第四季", overview: "第四季简介", poster_path: "/season4.jpg", episodes: [{ episode_number: 2, name: "第二集：暗黑武术会" }] }),
        };
      },
    });
    const season = JSON.parse(await call(sb2, '(async () => JSON.stringify(await fetchSeriesSeason(1234, 4)))()') || "null");
    chk("C14 季详情请求带 id/type=series/season/lang", urls.length === 1
      && urls[0].indexOf("/api/media/tmdb?") === 0 && urls[0].indexOf("id=1234") > 0 && urls[0].indexOf("type=series") > 0
      && urls[0].indexOf("season=4") > 0 && urls[0].indexOf("lang=") > 0, urls);
    chk("C15 季名/季简介/季海报解析正确", season && season.name === "幽游白书 第四季" && season.poster === "https://image.tmdb.org/t/p/w342/season4.jpg");
    chk("C16 分集列表透传（按集号匹配分集名靠它）", season && season.episodes.length === 1 && season.episodes[0].episode_number === 2);
    const before = urls.length;
    await call(sb2, '(async () => { await fetchSeriesSeason(1234, 200); })()');
    await call(sb2, '(async () => { await fetchSeriesSeason(0, 4); })()');
    chk("C18 季号越界 / 无 id 直接返回 null 且不发请求", urls.length === before);
    chk("C19 刮削搜索词用标签剧名（源码口径）",
        fs.readFileSync(path.join(ROOT, "web/js/02-media.js"), "utf8").includes("const searchTitle = seasonTag && seasonTag.show ? seasonTag.show : title;"));
  }

  /* ================= D. 需求6 音频播放模式 ================= */
  {
    const button = { dataset: {}, title: "", innerHTML: "", classList: { _s: new Set(), toggle(c, on) { const w = on === undefined ? !this._s.has(c) : !!on; w ? this._s.add(c) : this._s.delete(c); }, add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); } } };
    const toasts = [];
    const sb = load("web/js/02-media.js", {
      settings: {},
      toast: m => toasts.push(String(m)),
      document: {
        getElementById: id => (id === "audioLoopButton" ? button : null),
        querySelector: () => null, querySelectorAll: () => [], addEventListener() {},
        createElement: () => ({ style: {}, classList: { add() {} }, addEventListener() {} }),
        body: { classList: { contains: () => false, add() {}, remove() {}, toggle() {} } },
        documentElement: { style: { setProperty() {} } },
      },
      findMediaLibrary: () => null,
    });
    const seen = [];
    for (let i = 0; i < 4; i++) {
      call(sb, "cycleAudioLoop()");
      seen.push({ mode: button.dataset.loopMode, icon: button.innerHTML, title: button.title });
    }
    chk("D1 四种模式循环顺序 顺序→列表→单曲→随机",
        JSON.stringify(seen.map(x => x.mode)) === JSON.stringify(["list", "single", "random", "sequence"]), seen.map(x => x.mode));
    chk("D2 四个模式四个不同图标（不再是 repeat 一个图标打天下）",
        new Set(seen.map(x => x.icon)).size === 4, seen.map(x => x.icon.slice(0, 40)));
    chk("D3 顺序模式用 sequence 图标、随机用 shuffle 图标",
        seen[3].icon.includes("M4.4 6.6h11.2") && seen[2].icon.includes("m16 3.2 4.8.1"));
    chk("D4 单曲循环用 repeatOne（带数字 1）", seen[1].icon.includes(">1</text>"));
    chk("D5 切换模式不再弹任何模式弹窗（toast 一次都没触发）", toasts.length === 0, toasts);
    chk("D6 模式写进 data-loop-mode", seen.map(x => x.mode).every(Boolean));
    chk("D7 回到顺序模式后按钮不再高亮", button.dataset.loopMode === "sequence" && button.classList.contains("loop-active") === false);
    chk("D8 标题随模式变化", seen[0].title.includes("列表循环") && seen[2].title.includes("随机播放"));
    /* 循环图标本身在 DOM 里也是唯一的模式出口 */
    const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
    chk("D9 播放器只有循环按钮这一个模式出口（没有第二个模式控件）",
        (html.match(/id="audioLoopButton"/g) || []).length === 1 && !/audioLoopMenu|audioModePopup|data-audio-mode/.test(html));
  }

  /* ================= E. 需求3/4/5 视频控制条 ================= */
  {
    const src = fs.readFileSync(path.join(ROOT, "web/js/02-media.js"), "utf8");
    const vcRight = src.slice(src.indexOf('class="vc-right"'), src.indexOf('class="vc-right"') + 1600);
    const order = ['data-video-panel-button="playlist"', 'data-video-panel-button="settings"', "vc-fullscreen", 'data-video-panel-button="more"'].map(k => vcRight.indexOf(k));
    chk("E1 右下角顺序：播放列表 → 设置 → 最大化 → 更多", order.every(x => x >= 0) && JSON.stringify(order) === JSON.stringify([...order].sort((a, b) => a - b)));
    chk("E2 右下角没有随机/重复按钮", !vcRight.includes("video-repeat-button") && !vcRight.includes("video-shuffle-button"));
    const vcTop = src.slice(src.indexOf('<div class="vc-top">'), src.indexOf('<div class="vc-bottom">'));
    chk("E3 顶栏只剩最小化 + 标题（全屏已移走）", vcTop.includes("vc-collapse") && !vcTop.includes("vc-fullscreen"));
    chk("E4 快退/快进是双实心三角（VCD 样式）",
        /back10: '<path d="M11\.4 5\.6 4\.6 12l6\.8 6\.4Z" fill="currentColor" stroke="none"\/><path d="M20 5\.6 13\.2 12 20 18\.4Z"/.test(src)
        && /fwd10: '<path d="M12\.6 5\.6 19\.4 12l-6\.8 6\.4Z"/.test(src));

    /* 播完规则：剧集自动下一集、最后一集停住、电影停住；不再有 repeat/shuffle 分支 */
    /* 注意：videoPlaylist / videoPlaylistIndex / playVideoFromPlaylist 都由源文件自己声明，
       sandbox 传同名值会被函数声明覆盖 —— 所以用源文件自己的 setVideoPlaylist 建队列，
       再把 playVideoFromPlaylist 这一个函数换成就地记录（观察"跳到哪一集"）。 */
    const sb = load("web/js/02-media.js", { settings: {}, toast: () => {} });
    call(sb, 'setVideoPlaylist("l", [{ path: "/m/S01E01.mkv" }, { path: "/m/S01E02.mkv" }, { path: "/m/S01E03.mkv" }])');
    call(sb, 'globalThis.__played = []; playVideoFromPlaylist = function (i) { globalThis.__played.push(i); };');
    /* 元素要能 closest(".media-video-body") 返回带 dataset 的播放根（videoRootOf 的真实路径） */
    call(sb, 'globalThis.__mkRoot = (eligible, path) => { const root = { dataset: { videoPlaylistEligible: eligible ? "true" : "false", library: "l", path: path } }; root.closest = () => root; return root; };');
    const played = () => JSON.parse(call(sb, "JSON.stringify(globalThis.__played)"));
    call(sb, 'videoPlaybackEnded(__mkRoot(true, "/m/S01E01.mkv"), {})');
    chk("E5 剧集播完自动连播下一集", JSON.stringify(played()) === "[1]", played());
    call(sb, 'videoPlaybackEnded(__mkRoot(true, "/m/S01E03.mkv"), {})');
    chk("E6 最后一集播完不再循环回第一集", JSON.stringify(played()) === "[1]", played());
    call(sb, 'videoPlaybackEnded(__mkRoot(false, "/m/S01E01.mkv"), {})');
    chk("E7 电影（非剧集）播完停在结尾", JSON.stringify(played()) === "[1]", played());
    call(sb, 'videoPlayNeighbour(__mkRoot(true, "/m/S01E01.mkv"), 1)');
    chk("E7b 手动「下一集」也走同一条队列规则", JSON.stringify(played()) === "[1,1]", played());
    const toasts = [];
    call(sb, 'globalThis.__toasts = []; toast = function (m) { globalThis.__toasts.push(String(m)); };');
    call(sb, 'videoPlayNeighbour(__mkRoot(true, "/m/S01E03.mkv"), 1)');
    chk("E7c 最后一集点下一集 → 提示而不是循环", JSON.parse(call(sb, "JSON.stringify(globalThis.__toasts)")).join("").indexOf("vpLastItem") >= 0
        && JSON.stringify(played()) === "[1,1]", call(sb, "JSON.stringify(globalThis.__toasts)"));
    chk("E8 源码里再无 repeat/shuffle 状态分支", !/videoRepeatMode|videoShuffleOn|VIDEO_REPEAT_ORDER/.test(src));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})().catch(e => { console.error("行为测试异常：", e); process.exit(1); });
