/* v0.9.98 行为测试（Node VM 桩，真实执行 web/js/02-media.js 与 web/js/03-series-plex.js）：
 *
 *   A. 原盘（BDMV/ISO）媒体菜单：播放列表参数拼接、选择记忆、菜单渲染、
 *      非原盘隐藏按钮、打开播放器时自动拉取清单
 *   B. 本地 NFO 演职人员补全：是否该补的判定、本地优先合并（标题/海报不被覆盖）、
 *      端到端跑一次 scrapeOneMovie（TMDB 桩）确认 cast 落地且 provider 仍是本地 NFO
 *   C. 原盘条目合并（含剧集库）带上原盘标题/根目录
 */
const fs = require("fs"), vm = require("vm"), path = require("path");
const ROOT = process.env.VH_ROOT || path.resolve(__dirname, "..");
let passed = 0, failed = 0;
const chk = (name, ok, extra) => {
  if (ok) { passed++; console.log("PASS:", name); }
  else { failed++; console.log("FAIL:", name, extra === undefined ? "" : JSON.stringify(extra)); }
};

function fakeEl(extra) {
  const o = extra || {};
  const cls = new Set(o.classes || []);
  return {
    dataset: Object.assign({}, o.dataset || {}),
    __cs: o.cs || { display: "block", visibility: "visible" },
    getClientRects: () => ({ length: 1 }),
    offsetParent: null, textContent: "", innerHTML: "", style: {}, value: o.value === undefined ? "" : o.value,
    checked: !!o.checked, src: "", currentTime: 0, paused: true, duration: 100,
    classList: { add(c) { cls.add(c); }, remove(c) { cls.delete(c); }, contains(c) { return cls.has(c); }, toggle(c, on) { const w = on === undefined ? !cls.has(c) : !!on; w ? cls.add(c) : cls.delete(c); return w; } },
    querySelector: o.querySelector || (() => null), querySelectorAll: o.querySelectorAll || (() => []),
    closest: o.closest || (() => null), addEventListener() {}, appendChild() {}, remove() {}, setAttribute() {}, getAttribute() { return ""; },
    load() {}, play() { return Promise.resolve(); }, pause() {},
  };
}

const store = {};
function makeSandbox(extra) {
  const sb = {
    console, Date, Number, Math, String, Array, JSON, Object, parseFloat, parseInt, isNaN, isFinite, RegExp, Set, Map, Promise, URL, URLSearchParams,
    encodeURIComponent, decodeURIComponent, setTimeout, clearTimeout, Blob: function Blob() {},
    getComputedStyle: el => (el && el.__cs) || { display: "block", visibility: "visible" },
    localStorage: { getItem: k => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null), setItem(k, v) { store[k] = String(v); }, removeItem(k) { delete store[k]; } },
    fetch: async () => ({ ok: false, status: 404, json: async () => ({}) }),
    document: {
      getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {},
      createElement: () => fakeEl(),
      body: { classList: { contains: () => false, add() {}, remove() {}, toggle() {} } },
      documentElement: { style: { setProperty() {} } },
    },
    window: { addEventListener() {}, isSecureContext: false, scrollY: 0, innerHeight: 800 },
    navigator: { userAgent: "Mozilla/5.0 (X11; Linux x86_64)" },
    location: { origin: "http://192.0.2.10:8088", pathname: "/", href: "http://192.0.2.10:8088/", search: "" },
    curLang: "zh-CN", settings: {}, scraperStatus: {},
    toast: () => {}, t: k => String(k), tf: k => String(k), esc: s => String(s == null ? "" : s),
    jsAttrArg: v => "'" + String(v == null ? "" : v).replace(/'/g, "") + "'",
    openModal: () => {}, closeModal: () => {}, copyTextFallback: () => false,
    mediaKeepAliveStop: () => {}, mediaKeepAliveStart: () => {},
    sessionWriteHeaders: () => ({}),
    vaultStoreJSON: (k, d) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : d),
    vaultStoreSet: (k, v) => { store[k] = v; return true; },
    vaultStoreRemove: k => { delete store[k]; return true; },
    pushNotification() {}, upsertNotification() {},
    activePlayback: () => null, updatePlaybackDock: () => {}, liveActiveVideoElement: () => null,
  };
  return Object.assign(sb, extra || {});
}
function loadBoth(extra) {
  const sb = makeSandbox(extra);
  vm.createContext(sb);
  ["web/js/02-media.js", "web/js/03-series-plex.js"].forEach(f => {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), sb, { filename: f });
  });
  return sb;
}
const call = (sb, expr) => vm.runInContext(expr, sb);
const J = v => JSON.stringify(v);

(async () => {
  /* ================= A. 原盘媒体菜单 ================= */
  {
    const sb = loadBoth({});
    const lib = { id: "lib1", type: "movie", name: "电影库" };
    sb.__lib = lib;
    sb.__path = "/MO/[黑鹰坠落]Black.Hawk.Down.2001/BDMV/STREAM/00005.m2ts";
    chk("A1 未选标题时不加参数（默认主影片）",
      call(sb, "withDiscPick('/api/media/compat?id=x',0)") === "/api/media/compat?id=x"
      && call(sb, "withDiscPick('/api/media/compat?id=x', null)") === "/api/media/compat?id=x");
    chk("A2 选了标题则带上 disc_playlist（已带 ? 用 &）",
      call(sb, "withDiscPick('/api/media/compat?id=x',12)") === "/api/media/compat?id=x&disc_playlist=12"
      && call(sb, "withDiscPick('/api/media/x',3)") === "/api/media/x?disc_playlist=3");
    chk("A3 选择记在本机（每部片一条）", (() => {
      call(sb, `setDiscPick(__lib, __path, 12)`);
      const got = call(sb, "discPickOf(__lib, __path)");
      call(sb, `setDiscPick(__lib, __path, 0)`);
      const cleared = call(sb, "discPickOf(__lib, __path)");
      const other = call(sb, "discPickOf({id:'lib1'}, '/MO/别的片.iso')");
      return got === 12 && cleared === 0 && other === 0;
    })(), { got: call(sb, "discPickOf(__lib, __path)") });

    /* 菜单渲染：主影片 / 各标题时长 / 默认项 */
    sb.__info = {
      ok: true, kind: "bluray", items: [
        { index: 0, ref: 12, kind: "playlist", file: "00012.mpls", label: "主影片", seconds: 8957, duration_text: "2:29:17", main: true, selected: true },
        { index: 1, ref: 4, kind: "playlist", file: "00004.mpls", label: "标题 4", seconds: 8622, duration_text: "2:23:42", main: false, selected: false },
      ],
      notes: ["播放列表来自 libbluray 的原盘清单"],
    };
    const box = fakeEl({});
    const hint = fakeEl({});
    sb.__root = {
      dataset: {},
      querySelector: (sel) => (sel.indexOf("items") >= 0 ? box : (sel.indexOf("hint") >= 0 ? hint : null)),
      querySelectorAll: () => [],
    };
    call(sb, "renderDiscPlaylistPanel(__root, __lib, __path, __info)");
    chk("A4 菜单列出主影片与各标题（含时长）与「默认」项",
      box.innerHTML.includes("主影片 · 2:29:17") && box.innerHTML.includes("标题 4 · 2:23:42")
      && box.innerHTML.includes("默认（原盘自动选择）") && box.innerHTML.includes("主影片 · 主影片") === false);
    chk("A5 未选时高亮主影片；有无记录决定 active",
      (box.innerHTML.match(/video-disc-item active/g) || []).length === 1
      && /默认（原盘自动选择）/.test(box.innerHTML),
      { actives: (box.innerHTML.match(/video-disc-item active/g) || []).length });
    chk("A6 菜单底部给出清单来源说明", hint.textContent.includes("共 2 个标题") && hint.textContent.includes("libbluray"));

    /* 选了标题以后：高亮切到该标题 */
    call(sb, `setDiscPick(__lib, __path, 4)`);
    call(sb, "renderDiscPlaylistPanel(__root, __lib, __path, __info)");
    chk("A7 选过标题后高亮该项（记忆生效）",
      box.innerHTML.indexOf("标题 4 · 2:23:42") > 0
      && (box.innerHTML.match(/video-disc-item active/g) || []).length === 1
      && !box.innerHTML.includes('class="video-disc-item active"><span class="video-disc-name">主影片'));

    /* 非原盘：按钮隐藏（data-disc-kind=none） */
    const sb2 = loadBoth({
      fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: false, kind: "none", items: [], notes: ["该路径不是原盘镜像或 BDMV 片段"] }) }),
    });
    const root2 = { dataset: {}, querySelector: () => null, querySelectorAll: () => [] };
    sb2.__root2 = root2;
    await call(sb2, "loadDiscPlaylists(__root2, {id:'lib1'}, '/MO/普通电影.mkv')");
    chk("A8 非原盘隐藏「媒体菜单」按钮（data-disc-kind=none）", root2.dataset.discKind === "none" && root2.dataset.discTitles === "0");

    /* 原盘：读取清单并挂到播放器根节点 */
    const sb3 = loadBoth({
      fetch: async (url) => ({ ok: true, status: 200, json: async () => ({ ok: true, kind: "bluray", items: [{ ref: 12, label: "主影片", duration_text: "2:29:17", main: true }, { ref: 4, label: "标题 4", duration_text: "2:23:42" }], notes: [] }) }),
    });
    const box3 = fakeEl({}), hint3 = fakeEl({});
    const root3 = { dataset: {}, querySelector: (sel) => (sel.indexOf("items") >= 0 ? box3 : (sel.indexOf("hint") >= 0 ? hint3 : null)), querySelectorAll: () => [] };
    sb3.__root3 = root3;
    await call(sb3, "loadDiscPlaylists(__root3, {id:'lib1'}, '/MO/黑鹰坠落/BDMV/STREAM/00005.m2ts')");
    chk("A9 原盘读取清单：按钮可见 + 条目渲染",
      root3.dataset.discKind === "bluray" && root3.dataset.discTitles === "2" && box3.innerHTML.includes("主影片 · 2:29:17"));
  }

  /* ================= B. 本地 NFO 演职人员补全 ================= */
  {
    const sb = loadBoth({});
    chk("B1 本地 NFO 没有演职人员 → 需要在线补",
      call(sb, "nfoCastFillWanted({provider:'本地 NFO', nfo:'movie.nfo', title:'本地片名', cast:[]}, '/MO/a.mkv')") === true
      && call(sb, "nfoCastFillWanted({provider:'本地 NFO', nfo:'movie.nfo', cast:[{name:'甲'}]}, '/MO/a.mkv')") === true);
    chk("B2 已有带头像的演职人员 → 不再补",
      call(sb, "nfoCastFillWanted({provider:'本地 NFO', nfo:'m.nfo', cast:[{name:'甲', profile_path:'/a.jpg'}]}, '/MO/a.mkv')") === false
      && call(sb, "nfoCastFillWanted({provider:'本地 NFO', nfo:'m.nfo', cast:[{name:'甲', avatar:'/api/media/cast/avatar?person=%2Fa.jpg'}]}, '/MO/a.mkv')") === false);
    chk("B3 非本地来源（TMDB/豆瓣/文件名）不进「补演职人员」队列",
      call(sb, "nfoCastFillWanted({provider:'TMDB · 电影', cast:[]}, '/MO/a.mkv')") === false
      && call(sb, "nfoCastFillWanted({provider:'文件名展示', cast:[]}, '/MO/a.mkv')") === false
      && call(sb, "nfoCastFillWanted(null, '/MO/a.mkv')") === false);
    chk("B4 确认「这部片没有演职人员」后不再反复联网",
      call(sb, "nfoCastFillWanted({provider:'本地 NFO', nfo:'m.nfo', cast:[], cast_fill_state:'empty'}, '/MO/a.mkv')") === false
      && call(sb, "nfoCastFillWanted({provider:'本地 NFO', nfo:'m.nfo', cast:[], cast_fill_state:'skip'}, '/MO/a.mkv')") === false);
    chk("B5 重试有上限与时间窗（3 次 + 退避窗口内不再补）",
      call(sb, "nfoCastFillWanted({provider:'本地 NFO', nfo:'m.nfo', cast:[], cast_fill_attempts:3, cast_fill_last:Date.now()}, '/MO/a.mkv')") === false
      && call(sb, "nfoCastFillWanted({provider:'本地 NFO', nfo:'m.nfo', cast:[], cast_fill_attempts:3, cast_fill_last:1}, '/MO/a.mkv')") === true);
    chk("B6 开关可整体关掉本地 NFO 演职人员补全", (() => {
      call(sb, "setNfoCastFill(false)");
      const off = call(sb, "nfoCastFillWanted({provider:'本地 NFO', nfo:'m.nfo', cast:[]}, '/MO/a.mkv')");
      call(sb, "setNfoCastFill(true)");
      const on = call(sb, "nfoCastFillWanted({provider:'本地 NFO', nfo:'m.nfo', cast:[]}, '/MO/a.mkv')");
      return off === false && on === true;
    })());

    /* 本地优先合并：核心字段不被在线结果覆盖，演职人员按姓名合并 */
    sb.__base = { provider: "本地 NFO", nfo: "movie.nfo", title: "本地片名", year: "2001", poster: "/api/media/cover?id=x&path=poster.jpg", overview: "本地简介", cast: [{ name: "汤姆·汉克斯", character: "米勒上尉" }, { name: "本地演员", character: "配角" }] };
    sb.__patch = { title: "在线片名", year: "1998", poster: "https://image.tmdb.org/t/p/w342/x.jpg", overview: "在线简介", provider: "TMDB · 电影", scrape_state: "ok", cast: [{ name: "汤姆·汉克斯", character: "Capt. Miller", profile_path: "/9.jpg" }, { name: "在线新演员", character: "新角色", profile_path: "/7.jpg" }] };
    const merged = call(sb, "keepLocalMetadataFirst(__base, __patch)");
    chk("B7 本地优先：标题/年份/海报/简介/provider 保持本地值",
      merged.title === "本地片名" && merged.year === "2001" && merged.poster.includes("/api/media/cover")
      && merged.overview === "本地简介" && merged.scrape_state === "ok"
      && merged.provider === "本地 NFO");
    chk("B8 演职人员按姓名合并：本地角色名优先 + 在线头像补上 + 在线新增演员保留",
      merged.cast.length === 3
      && merged.cast[0].name === "汤姆·汉克斯" && merged.cast[0].character === "米勒上尉" && merged.cast[0].profile_path === "/9.jpg"
      && merged.cast[1].name === "本地演员"
      && merged.cast[2].name === "在线新演员");

    /* 端到端：跑真实 scrapeOneMovie（TMDB 桩），确认本地条目也能补出演职人员 */
    const calls = [];
    const sb4 = loadBoth({
      fetch: async (url, opts) => {
        calls.push(String(url));
        if (String(url).indexOf("/api/media/tmdb?query=") >= 0) {
          return { ok: true, status: 200, json: async () => ({ results: [{ id: 855, name: "黑鹰坠落", title: "黑鹰坠落", release_date: "2001-12-28", poster_path: "/p.jpg", overview: "在线简介", vote_average: 7.7 }] }) };
        }
        if (String(url).indexOf("/api/media/tmdb?id=855") >= 0) {
          return { ok: true, status: 200, json: async () => ({ credits: { cast: [{ name: "乔什·哈奈特", character: "Eversmann", profile_path: "/a.jpg" }, { name: "汤姆·塞兹摩尔", character: "McKnight", profile_path: "/b.jpg" }] } }) };
        }
        return { ok: true, status: 200, json: async () => ({}) };
      },
    });
    /* scraperStatus 由 02-media.js 自己声明（桩属性会被声明覆盖）→ 直接在沙箱里置值。 */
    call(sb4, "scraperStatus.tmdb_enabled = true; scraperStatus.tvdb_enabled = false; scraperStatus.scraper_mode = 'tmdb'; scraperStatus.tmdb_image_base = 'https://image.tmdb.org/t/p'");
    const path1 = "/MO/黑鹰坠落 (2001)/黑鹰坠落.mkv";
    const all = {};
    all[path1] = { provider: "本地 NFO", nfo: "黑鹰坠落.nfo", title: "黑鹰坠落", year: "2001", poster: "/api/media/cover?id=cine&path=poster.jpg", overview: "本地简介", cast: [{ name: "乔什·哈奈特", character: "本地角色" }], scrape_state: "ok", scrape_attempts: 0 };
    /* 元数据存储是模块级共享的桩：这里显式重置成空对象，避免影响后续用例。 */
    store["vaulthub_movie_metadata_v1"] = {};
    sb4.__meta = all;
    sb4.__path1 = path1;
    sb4.__lib = { id: "cine", type: "movie", name: "电影库" };
    call(sb4, "movieMetadataMemory = __meta");
    await call(sb4, "scrapeOneMovie(__lib, [{path:__path1}], {path:__path1})");
    const after = call(sb4, "movieMetadataFor(__path1)");
    chk("B9 端到端：本地 NFO 条目在线补出演职人员（含头像）",
      Array.isArray(after.cast) && after.cast.length === 2 && !!after.cast[0].profile_path, after && after.cast);
    chk("B10 端到端：标题/海报/provider 仍是本地值（本地优先）",
      after.title === "黑鹰坠落" && String(after.poster).includes("/api/media/cover") && after.provider === "本地 NFO", { title: after && after.title, provider: after && after.provider });
    chk("B11 端到端：确实请求了 TMDB 详情（取 credits），不再是「整条跳过」",
      calls.some(u => u.includes("/api/media/tmdb?query=")) && calls.some(u => u.includes("id=855")), calls);
  }

  /* ================= C. 原盘条目合并 ================= */
  {
    const sb = loadBoth({});
    sb.__files = [
      { path: "/MO/[黑鹰坠落]Black.Hawk.Down.2001/BDMV/STREAM/00005.m2ts", size: 43388866560 },
      { path: "/MO/[黑鹰坠落]Black.Hawk.Down.2001/BDMV/STREAM/00007.m2ts", size: 1025968128 },
      { path: "/MO/普通电影/普通电影.mkv", size: 100 },
    ];
    const out = call(sb, "collapseDiscFragments(__files)");
    chk("C1 原盘多片段合并成一条（保留最大片段）",
      out.length === 2 && out[0].disc === true && out[0].path.includes("00005.m2ts") && out[0].disc_fragments === 2, out.map(x => x.path));
    chk("C2 合并条目带上原盘根目录与可刮削的原盘标题（不是片段编号）",
      out[0].disc_root === "/MO/[黑鹰坠落]Black.Hawk.Down.2001"
      && out[0].disc_title !== "00005" && out[0].disc_title.includes("Black Hawk Down"), out[0].disc_title);
    chk("C3 普通视频不参与合并", out[1].disc === undefined);
  }

  /* ================= D. 特别篇与主季归同一部剧 + 设置页剧卡缓存 ================= */
  {
    const sb = loadBoth({});
    sb.__files = [
      { path: "The Flash (2014)/Season 01/The Flash - s01e01 - 试播集.mkv" },
      { path: "The Flash (2014)/Season 01/The Flash - s01e02 - 快如闪电.mkv" },
      { path: "The Flash (2014)/Season 02/The Flash - s02e01 - 新起点.mkv" },
      { path: "The Flash (2014)/Specials/The Flash - s00e01 - 幕后.mkv" },
    ];
    const shows = call(sb, "buildSeriesShows(__files)");
    chk("D1 同剧的 Season 01/02 与 Specials 归成一张剧卡（不再拆成两张）",
      shows.length === 1 && shows[0].seasonList.length === 3, shows.map(s => ({ t: s.title, seasons: s.seasonList.map(x => x.season) })));
    chk("D2 季节号含特别篇第 0 季",
      JSON.stringify(shows[0].seasonList.map(s => s.season)) === JSON.stringify([0, 1, 2]), shows[0].seasonList.map(s => s.season));
    chk("D3 分组键对 Specials / 特别篇 / Season 00 与 Season NN 一致（同一剧根）", (() => {
      const k1 = call(sb, "seriesGroupKeyOf('The Flash (2014)/Season 01/a.mkv', parseSeriesEpisode('The Flash (2014)/Season 01/a.mkv'))");
      const k2 = call(sb, "seriesGroupKeyOf('The Flash (2014)/Specials/a.mkv', parseSeriesEpisode('The Flash (2014)/Specials/a.mkv'))");
      const k3 = call(sb, "seriesGroupKeyOf('老友记 (1994)/Season 00/特别篇.mkv', parseSeriesEpisode('老友记 (1994)/Season 00/特别篇.mkv'))");
      const k4 = call(sb, "seriesGroupKeyOf('老友记 (1994)/Season 05/a.mkv', parseSeriesEpisode('老友记 (1994)/Season 05/a.mkv'))");
      return k1 === k2 && k3 === k4 && k1 !== k3;
    })());

    /* 设置页加载剧集列表时必须把剧卡写进缓存（否则诊断面板/详情页读不到剧卡） */
    const storeKey = "vaulthub_series_show_playlist_v1";
    const __settingsEls = {};
    const sb2 = loadBoth({
      fetch: async (url) => {
        if (String(url).indexOf("/api/media/files") >= 0) {
          return { ok: true, status: 200, json: async () => ({ files: [{ path: "The Flash (2014)/Season 01/The Flash - s01e01.mkv" }], total: 1, has_more: false }) };
        }
        return { ok: true, status: 200, json: async () => ({}) };
      },
      document: {
        /* 同一 id 必须返回同一个桩元素（每次新建会让断言读到另一个对象）。 */
        getElementById: (id) => {
          if (!__settingsEls[id] && (id === "plexLibSelect" || id === "plexShowSelect" || id === "plexSettingsStatus")) {
            __settingsEls[id] = fakeEl({ value: id === "plexLibSelect" ? "tvlib" : "" });
          }
          return __settingsEls[id] || null;
        },
        querySelector: () => null, querySelectorAll: () => [], addEventListener() {},
        createElement: () => fakeEl(),
        body: { classList: { contains: () => false, add() {}, remove() {}, toggle() {} } },
        documentElement: { style: { setProperty() {} } },
      },
    });
    sb2.__libs = [{ id: "tvlib", name: "剧集库", type: "series" }];
    call(sb2, "localMediaLibraries = __libs");
    const before = call(sb2, "readSeriesShow('tvlib', seriesGroupKeyOf('The Flash (2014)/Season 01/a.mkv', parseSeriesEpisode('The Flash (2014)/Season 01/a.mkv')))");
    await call(sb2, "plexSettingsLoadShows(true)");
    const after = call(sb2, "readSeriesShow('tvlib', seriesGroupKeyOf('The Flash (2014)/Season 01/a.mkv', parseSeriesEpisode('The Flash (2014)/Season 01/a.mkv')))");
    chk("D4 设置页加载剧集即写缓存：面板/详情页随后能读到剧卡", before === null && !!(after && after.key), { before: !!before, after: !!after });
    chk("D5 设置页下拉列出整库与单剧（整库选项带部数）",
      call(sb2, "document.getElementById('plexShowSelect').innerHTML").indexOf("全部剧集（整库 · 1 部）") >= 0);
  }

  console.log(`\nSUMMARY pass=${passed} fail=${failed}`);
  process.exit(failed ? 1 : 0);
})();
