/* v0.9.97 行为测试（Node VM 桩，真实执行 web/js/02-media.js 与 web/js/03-series-plex.js）：
 *
 *   A. parseSeriesEpisode 的 Plex 口径：方括号内容忽略、sXXeYY、sXXeYY-eZZ 多集合并、
 *      1x02、第X季第Y集、E05（有季目录）、纯数字（标记 by=number）、无标记回落文件名
 *   B. 季目录优先于文件名季号；Season 00 / Specials → 第 0 季（特别篇）
 *   C. 多季标签与集号工具：特别篇称号、Season XX 目录名、E01-E03 压缩、缺失集
 *   D. 把官方季/集元数据写回本地记录（多集合并写两集名、本地 NFO 默认不覆盖、缺集保留文件名）
 *   E. 服务端方案与前端剧卡的目录对齐 + 面板渲染
 *   F. 新旧口径对照：方括号里的 s01e05（旧实现认得，Plex 口径不认）
 */
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
  return {
    dataset: Object.assign({}, o.dataset || {}),
    __cs: o.cs || { display: "block", visibility: "visible" },
    getClientRects: () => ({ length: o.rects === undefined ? 1 : o.rects }),
    offsetParent: null, textContent: "", innerHTML: "", style: {}, value: "", checked: !!o.checked,
    classList: { add(c) { cls.add(c); }, remove(c) { cls.delete(c); }, contains(c) { return cls.has(c); }, toggle(c, on) { const w = on === undefined ? !cls.has(c) : !!on; w ? cls.add(c) : cls.delete(c); return w; } },
    querySelector: o.querySelector || (() => null), querySelectorAll: o.querySelectorAll || (() => []),
    closest: () => null, addEventListener() {}, appendChild() {}, remove() {}, setAttribute() {}, getAttribute() { return ""; },
  };
}

const store = {};                          /* 桩的 localStorage 键值（vaultStore* 走这里） */
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
    /* vaultStore* 定义在 01-state.js（本测试不加载），因此桩生效：
       readMovieMetadata 从 vaultStoreJSON 取，writeMovieMetadata 先进内存。 */
    vaultStoreJSON: (k, d) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : d),
    vaultStoreSet: (k, v) => { store[k] = v; return true; },
    vaultStoreRemove: k => { delete store[k]; return true; },
    pushNotification() {}, upsertNotification() {},
    activePlayback: () => null, updatePlaybackDock: () => {}, liveActiveVideoElement: () => null,
  };
  return Object.assign(sb, extra || {});
}

/* 同时加载 02-media.js 与 03-series-plex.js（与浏览器里 index.html 的顺序一致）。 */
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
  const sb = loadBoth({});
  const P = p => call(sb, `parseSeriesEpisode(${J(p)})`);

  /* ================= A. parseSeriesEpisode 的 Plex 口径 ================= */
  {
    const a1 = P("The Big Bang Theory (2007)/Season 03/The Big Bang Theory - s03e05 - 浴室里的心理学.mkv");
    chk("A1 sXXeYY + 分集名 + 剧根年份", a1.season === 3 && a1.episode === 5 && a1.title === "浴室里的心理学" && a1.show === "The Big Bang Theory", a1);
    const a2 = P("老友记 (1994)/Season 05/老友记 - s05e12 - 瑞秋的妹妹.mkv");
    chk("A2 中文剧名与分集名", a2.season === 5 && a2.episode === 12 && a2.title === "瑞秋的妹妹" && a2.show === "老友记", a2);
    const a3 = P("FRIENDS/Season 05/FRIENDS 5x12 The One.mkv");
    chk("A3 1x02 形式", a3.season === 5 && a3.episode === 12 && /The One/.test(a3.title), a3);
    const a4 = P("某剧/Season 02/某剧 第 2 季 第 7 集 大结局.mkv");
    chk("A4 第X季第Y集", a4.season === 2 && a4.episode === 7 && a4.title === "大结局", a4);
    const a5 = P("某剧/Season 02/某剧.第7集.mkv");
    chk("A5 第Y集（季号取自季目录）", a5.season === 2 && a5.episode === 7 && a5.by === "cn_ep", a5);
    const a6 = P("某剧/Season 03/某剧 - E05.mkv");
    chk("A6 有季目录时的 E05 简写", a6.season === 3 && a6.episode === 5 && a6.by === "e", a6);
    const a7 = P("Movie.Name.E05.mkv");
    chk("A7 无季目录的 E05 不认（否则电影会被当剧集）", a7.episode === 0, a7);
    const a8 = P("某剧/Season 01/03.mkv");
    chk("A8 季目录内纯数字：兜底 3 集但标记 by=number（Plex 不认这种写法）", a8.episode === 3 && a8.by === "number", a8);
    const a9 = P("[YYDS]某剧 (2019)/Season 02/[YYDS]某剧 [s02e05] 1080p.mkv");
    chk("A9 方括号内的季集号按 Plex 口径忽略（不认）", a9.episode === 0, a9);
    const a10 = P("[YYDS]Show (2019)/Season 01/[YYDS]Show - s01e07 - 标题.mkv");
    chk("A10 方括号只在文件名前缀/规格处时不影响季集识别", a10.episode === 7 && a10.season === 1, a10);
    const a11 = P("老剧合集/某某剧 第一集.mkv");
    chk("A11 解析不出来时以文件名当展示名（条目不丢）", a11.episode === 0 && a11.label === "某某剧 第一集" && a11.title === "某某剧 第一集", a11);
    const a12 = P("The Flash (2014)/Season 01/The Flash - s01e01 - 1080p WEB-DL x265.mkv");
    chk("A12 分集名剔除规格噪声", a12.title === "" || !/1080p|x265|WEB/i.test(a12.title), a12);
  }

  /* ================= B. 季目录优先 / 特别篇 ================= */
  {
    const b1 = P("The Flash (2014)/Season 03/The Flash - s02e05 - 标题.mkv");
    chk("B1 季目录优先于文件名季号（Season 03 胜过 s02）", b1.season === 3 && b1.episode === 5, b1);
    const b2 = P("The Flash (2014)/Season 04/The Flash - s04e02.mkv");
    chk("B2 季目录与文件名一致时正常", b2.season === 4 && b2.episode === 2, b2);
    const b3 = P("The Flash (2014)/Specials/The Flash - s00e02 - 花絮.mkv");
    chk("B3 Specials → 第 0 季", b3.season === 0 && b3.episode === 2 && b3.label === "S00E02", b3);
    const b4 = P("The Flash (2014)/Season 00/The Flash - s00e01.mkv");
    chk("B4 Season 00 → 第 0 季", b4.season === 0 && b4.episode === 1, b4);
    const b5 = P("某剧/第 3 季/某剧 - s03e01.mkv");
    chk("B5 中文季目录「第 3 季」识别", b5.season === 3 && b5.episode === 1, b5);
    const b6 = P("/m/幽游白书S04/Season 04/S04E02.mkv");
    chk("B6 剧根带季标签（沿用 v0.9.94 约定）不破坏解析", b6.season === 4 && b6.episode === 2, b6);
    const b7 = P("The Flash (2014)/Season 01/The Flash - s01e01.mkv");
    chk("B7 剧名取季目录上一层目录（并去掉年份）", b7.show === "The Flash", b7);
  }

  /* ================= C. 多集合并 ================= */
  {
    const c1 = P("神盾局特工 (2013)/Season 02/神盾局特工 - s02e18-e19.mkv");
    chk("C1 sXXeYY-eZZ 多集合并：起始 18 / 结束 19 / multi", c1.episode === 18 && c1.episodeEnd === 19 && c1.multi === true, c1);
    chk("C1b 多集合并标签为 S02E18-E19", c1.label === "S02E18-E19", c1.label);
    const c2 = P("神盾局特工 (2013)/Season 02/神盾局特工 - s02e18-19.mkv");
    chk("C2 省略第二个 e 的写法（s02e18-19）同样识别", c2.episode === 18 && c2.episodeEnd === 19, c2);
    const c3 = P("神盾局特工 (2013)/Season 02/神盾局特工 - s02e18-e19 - 双集联播.mkv");
    chk("C3 多集合并保留分集名", c3.title === "双集联播", c3);
  }

  /* ================= D. 工具函数 ================= */
  {
    chk("D1 特别篇称号", call(sb, "seriesPlexSeasonLabel(0)") === "特别篇" && call(sb, "seriesPlexSeasonLabel(3)") === "第 3 季");
    chk("D2 季目录名", call(sb, "seriesPlexSeasonDir(0)") === "Season 00" && call(sb, "seriesPlexSeasonDir(3)") === "Season 03");
    chk("D3 剧根目录名带年份", call(sb, 'seriesPlexShowDirName("The Flash","2014")') === "The Flash (2014)"
        && call(sb, 'seriesPlexShowDirName("某剧","")') === "某剧 (年份)");
    chk("D4 剧根目录名剥离方括号", call(sb, 'seriesPlexShowDirName("[YYDS]某剧","2019")') === "某剧 (2019)");
    chk("D5 集号压缩 E01-E03", call(sb, "seriesPlexEpisodeRanges([1,2,3])") === "E01-E03"
        && call(sb, "seriesPlexEpisodeRanges([7,8,9,12])") === "E07-E09、E12"
        && call(sb, "seriesPlexEpisodeRanges([1,2,4])") === "E01、E02、E04");
    const miss = call(sb, "seriesPlexMissing([1,2,3,5,6], 9)");
    chk("D6 缺失集 [4,7,8,9]", J(miss) === J([4, 7, 8, 9]), miss);
    chk("D7 官方集数未知（0）时不臆造缺失集", J(call(sb, "seriesPlexMissing([1,2], 0)")) === J([]));
    const nums = call(sb, "seriesPlexLocalNumbers({season:2, episodes:[{path:'a/Season 02/a - s02e18-e19.mkv'},{path:'a/Season 02/a - s02e01.mkv'}]})");
    chk("D8 多集合并文件在本地集号里同时覆盖 18、19", J(nums) === J([1, 18, 19]), nums);
  }

  /* ================= E. 官方元数据写回本地 ================= */
  {
    const show = {
      key: "k", title: "神盾局特工", year: "2013",
      seasonList: [{ season: 2, episodes: [
        { path: "神盾局特工 (2013)/Season 02/神盾局特工 - s02e18-e19.mkv", parsed: null },
        { path: "神盾局特工 (2013)/Season 02/神盾局特工 - s02e03.mkv", parsed: null },
        { path: "神盾局特工 (2013)/Season 02/神盾局特工 - E05.mkv", parsed: null },
        { path: "神盾局特工 (2013)/Season 02/神盾局特工 - s02e06.mkv", parsed: null },
      ] }],
    };
    const data = {
      name: "第二季", overview: "第二季简介",
      episodes: [
        { episode_number: 18, name: "第十八集", still_path: "/s18.jpg" },
        { episode_number: 19, name: "第十九集", still_path: "/s19.jpg" },
        { episode_number: 3, name: "第三集", still_path: "/s3.jpg" },
        { episode_number: 5, name: "第五集", still_path: "/s5.jpg" },
        { episode_number: 6, name: "第六集", still_path: "/s6.jpg" },
      ],
    };
    /* 第三条带本地 NFO（Plex 的 Local Media Assets 优先：默认不覆盖） */
    sb.__all = { "神盾局特工 (2013)/Season 02/神盾局特工 - s02e06.mkv": { provider: "本地 NFO", title: "本地标题", show_title: "神盾局特工" } };
    call(sb, "movieMetadataMemory = __all");
    sb.__show = show;
    sb.__data = data;
    const res = vm.runInContext("applySeriesSeasonScrape('lib1', __show, __show.seasonList[0], __data, {})", sb);
    const all = call(sb, "readMovieMetadata()");
    chk("E1 写入成功计数（3 集写入，1 集跳过本地 NFO）", res.written === 3 && res.skippedLocal === 1, res);
    const ep18 = all["神盾局特工 (2013)/Season 02/神盾局特工 - s02e18-e19.mkv"] || {};
    chk("E2 多集合并文件写入两集名（E18 名 / E19 名）", ep18.title === "第十八集 / 第十九集", ep18.title);
    chk("E3 写入季号 / 季标签 / 季名 / 季简介", ep18.season_num === 2 && ep18.season_tag === "S02" && ep18.season_name === "第二季" && ep18.season_overview === "第二季简介", ep18);
    const ep3 = all["神盾局特工 (2013)/Season 02/神盾局特工 - s02e03.mkv"] || {};
    chk("E4 按集号写分集名", ep3.title === "第三集" && ep3.media_type === "series", ep3);
    const ep5 = all["神盾局特工 (2013)/Season 02/神盾局特工 - E05.mkv"] || {};
    chk("E5 E05 简写条目也能按集号拿到分集名", ep5.title === "第五集", ep5);
    const ep6 = all["神盾局特工 (2013)/Season 02/神盾局特工 - s02e06.mkv"] || {};
    chk("E6 本地 NFO 默认不被网络刮削覆盖（Local Media Assets 优先）", ep6.title === "本地标题", ep6);
    chk("E7 季卡拿到季名/季简介", show.seasonList[0].name === "第二季" && show.seasonList[0].overview === "第二季简介", show.seasonList[0]);

    /* 勾选「覆盖本地 NFO」后应覆盖 */
    const res2 = vm.runInContext("applySeriesSeasonScrape('lib1', __show, __show.seasonList[0], __data, { overwriteLocal: true })", sb);
    const all2 = call(sb, "readMovieMetadata()");
    chk("E8 勾选覆盖后本地 NFO 也被写入", res2.written === 4 && res2.skippedLocal === 0
        && (all2["神盾局特工 (2013)/Season 02/神盾局特工 - s02e06.mkv"] || {}).title === "第六集", res2);

    /* 官方没有这一集时保留文件名展示，不写空标题 */
    const res3 = vm.runInContext(`(() => {
      const show3 = { key:'k3', title:'某剧', seasonList:[{ season:1, episodes:[{ path:'某剧 (2019)/Season 01/某剧 - s01e99.mkv', parsed:null }] }] };
      const r = applySeriesSeasonScrape('lib1', show3, show3.seasonList[0], { name:'第一季', episodes:[{ episode_number:1, name:'第一集' }] }, {});
      return { r, rec: readMovieMetadata()['某剧 (2019)/Season 01/某剧 - s01e99.mkv'] || {} };
    })()`, sb);
    chk("E9 官方缺该集时保留文件名展示（不写空标题）", /s01e99|第 99 集/.test(String(res3.rec.title || "")) && res3.r.written === 1, res3);
  }

  /* ================= F. 方案与剧卡对齐 / 面板渲染 ================= */
  {
    const planData = {
      ok: true, plan: {
        shows: [{
          key: "theflash\x002014", title: "The Flash", year: "2014", dirs: ["The Flash (2014)"],
          season_count: 4, multi_season: true, has_specials: true, episode_num: 5, issue_num: 1,
          seasons: [
            { season: 0, label: "特别篇", tag: "S00", dir: "Specials", special: true, count: 1, numbers: [1], numbers_tag: "E01", episodes: [] },
            { season: 1, label: "第 1 季", tag: "S01", dir: "Season 01", special: false, count: 2, numbers: [1, 2], numbers_tag: "E01、E02", episodes: [] },
          ],
          issues: [{ path: "[YYDS]The Flash [s01e05].mkv", issues: ["季集号写在方括号 [s01e05] 里：Plex 会完全忽略方括号内容，必须移到文件名主干"], suggested: "The Flash (2014)/Season 01/The Flash - s01e05.mkv" }],
        }],
        issue_num: 1, show_num: 1, multi_season_num: 1, season_num: 4, episode_num: 5,
      },
      notes: ["识别到 1 部多季剧集，季目录优先于文件名里的季号（Plex 口径）。"],
    };
    sb.__plan = planData;
    sb.__show = { key: "k", title: "The Flash", year: "2014", seasonList: [{ season: 1, episodes: [{ path: "The Flash (2014)/Season 01/The Flash - s01e01.mkv" }] }], files: [{ path: "The Flash (2014)/Season 01/The Flash - s01e01.mkv" }] };
    const hit = call(sb, "seriesPlexShowInPlan(__plan, __show)");
    chk("F1 按剧根目录名把前端剧卡对齐到服务端方案", !!hit && hit.title === "The Flash", hit && hit.title);
    const miss2 = call(sb, "seriesPlexShowInPlan(__plan, { title:'别的剧', year:'', seasonList:[{season:1,episodes:[{path:'别的剧/Season 01/a.mkv'}]}] })");
    chk("F2 对不上的剧卡不会误配", miss2 === null);
    chk("F3 剧根目录名解析（季目录上一层）", call(sb, "seriesPlexShowDirOf('The Flash (2014)/Season 03/a.mkv')") === "The Flash (2014)");
    chk("F3b 特别篇目录同样取上一层", call(sb, "seriesPlexShowDirOf('The Flash (2014)/Specials/a.mkv')") === "The Flash (2014)");

    sb.__lib = { id: "lib1", name: "剧集库" };
    const html = call(sb, "seriesPlexPanelHtml(__lib, __show, __plan, null)");
    chk("F4 面板渲染出季表（含特别篇）", html.includes("特别篇") && html.includes("Season 00") && html.includes("Season 01"));
    chk("F5 面板渲染出命名体检与建议路径", html.includes("命名体检") && html.includes("方括号") && html.includes("The Flash - s01e05.mkv"));
    /* v0.9.98：面板按钮带上自己的库/剧上下文（整库面板不串台）。 */
    chk("F6 面板按钮齐全（比对/多季刮削/重匹配）且各自携带库与剧", html.includes("seriesPlexAction('compare',") && html.includes("seriesPlexAction('scrape',") && html.includes("seriesPlexAction('dance',") && html.includes("seriesPlexScrapeSeason(1,"));
    chk("F7 未比对时标注「待比对」", html.includes("待比对"));
    const html2 = call(sb, "seriesPlexPanelHtml(__lib, __show, __plan, {seasons:[{season:1, official_count:5, missing:[3,4], missing_label:'S01E03、S01E04'}]})");
    chk("F8 比对结果渲染缺失集", html2.includes("缺 E03、E04"), html2.includes("缺 E03、E04"));
    const html3 = call(sb, "seriesPlexPanelHtml(__lib, { title:'空剧', seasonList:[], files:[] }, __plan, null)");
    chk("F9 方案里没有这部剧时给出明确提示", html3.includes("索引里还没识别到这部剧的多季结构"));
    const html4 = call(sb, "seriesPlexPanelHtml(__lib, __show, null, null)");
    chk("F10 读不到方案时给出明确提示", html4.includes("读不到多季方案"));
  }

  /* ================= G. 新旧口径对照 ================= */
  {
    const oldWay = vm.runInContext('(() => { const stem = "[YYDS]某剧 [s02e05] 1080p"; const m = stem.match(/[sS](\\d{1,2})[eE](\\d{1,3})/); return m ? Number(m[2]) : 0; })()', sb);
    const newWay = P("[YYDS]某剧 (2019)/Season 02/[YYDS]某剧 [s02e05] 1080p.mkv");
    chk("G1 旧写法（方括号内也认）会误判出集号 5", oldWay === 5, oldWay);
    chk("G2 新实现按 Plex 口径忽略方括号内容 → 集号 0", newWay.episode === 0, newWay.episode);
    const oldMulti = vm.runInContext('(() => { const stem = "神盾局特工 - s02e18-e19"; const m = stem.match(/^(.*?)\\s*-?\\s*[sS](\\d{1,2})[eE](\\d{1,3})\\s*-?\\s*(.*)$/); return m ? { ep: Number(m[3]), title: m[4] } : null; })()', sb);
    chk("G3 旧写法把多集合并的第二集当标题（ep=18 title=e19）", !!oldMulti && oldMulti.ep === 18 && /e19/.test(oldMulti.title), oldMulti);
    const newMulti = P("神盾局特工 (2013)/Season 02/神盾局特工 - s02e18-e19.mkv");
    chk("G4 新实现识别为多集合并（18-19）", newMulti.multi === true && newMulti.episodeEnd === 19, newMulti);
  }

  console.log(`\nSUMMARY pass=${passed} fail=${failed}`);
  process.exit(failed ? 1 : 0);
})();
