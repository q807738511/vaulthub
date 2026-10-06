/* v0.9.87 行为测试（Node VM 桩，真实执行源文件）：
     A. 刮削地区（中/日/美）→ TMDB 请求语言
     B. 刮削队列提示只进通知栏（库页不再有队列徽标）
     C. 通知中心「同 key 就地更新」
     D. 无刮削信息时不渲染 Plex/Emby 聚合说明
     E. 设置读写带 scrape_region
   三个源文件各自独立 vm 上下文：它们都定义 esc/t 等同名 const，同上下文重复声明会 SyntaxError。 */
const fs = require("fs"), vm = require("vm");
/* 仓库根目录由本文件位置推导，不写死开发机路径（否则 CI 上必然 ENOENT）。需要时可设 VH_ROOT 覆盖。 */
const ROOT = process.env.VH_ROOT || require("path").resolve(__dirname, "..");
let passed = 0, failed = 0;

/* 真实 i18n 词典：01-state.js 里的 I18N / t / tf 都是词法作用域，外部拿不到对象，
   因此单独起一个上下文载入后把三份词典 JSON 出来，再喂给后续沙箱的 t/tf 桩 ——
   这样断言的标题文案是「真·中文」，而不是 i18n key。 */
const I18N_DICTS = (() => {
  const sb = {
    console, Date, Number, Math, String, Array, JSON, Object, parseFloat, parseInt, isNaN, RegExp, Set, Map, setTimeout, clearTimeout,
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    document: {
      getElementById: () => ({ style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, addEventListener() {}, querySelector: () => null, querySelectorAll: () => [], textContent: "", innerHTML: "", value: "" }),
      querySelector: () => null, querySelectorAll: () => [], addEventListener: () => {},
      createElement: () => ({ style: {}, dataset: {}, setAttribute() {}, appendChild() {}, remove() {}, select() {} }),
      body: { appendChild() {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false } },
    },
    window: { addEventListener: () => {}, matchMedia: () => ({ matches: false, addEventListener() {} }) },
    navigator: {}, location: { origin: "http://192.0.2.10:8088", pathname: "/", href: "http://192.0.2.10:8088/" },
    fetch: async () => ({ ok: false, json: async () => ({}) }),
  };
  vm.createContext(sb);
  vm.runInContext(fs.readFileSync(ROOT + "/web/js/01-state.js", "utf8"), sb, { filename: "01-state.js" });
  const dict = lang => JSON.parse(vm.runInContext(`JSON.stringify(I18N[${JSON.stringify(lang)}])`, sb));
  return { "zh-CN": dict("zh-CN"), "zh-TW": dict("zh-TW"), "en": dict("en") };
})();
const chk = (name, ok, extra) => {
  if (ok) { passed++; console.log("PASS:", name); }
  else { failed++; console.log("FAIL:", name, extra === undefined ? "" : JSON.stringify(extra)); }
};

function makeSandbox(extra) {
  const els = {};
  const el = id => {
    if (!els[id]) els[id] = { id, textContent: "", innerHTML: "", title: "", value: "", className: "", style: {}, dataset: {}, hidden: false, addEventListener() {}, removeEventListener() {}, querySelector: () => null, querySelectorAll: () => [], classList: { add() {}, remove() {}, contains: () => false }, appendChild() {}, remove() {} };
    return els[id];
  };
  const storage = {};
  const store = {
    getItem: k => (k in storage ? storage[k] : null),
    setItem: (k, v) => { storage[k] = String(v); },
    removeItem: k => { delete storage[k]; },
  };
  const sandbox = {
    console, Date, Number, Math, String, Array, JSON, Object, parseFloat, parseInt, isNaN, RegExp, Set, Map, Promise,
    setTimeout, clearTimeout,
    els, el, storage,
    localStorage: store,
    document: {
      getElementById: el,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: () => {},
      createElement: () => ({ style: {}, dataset: {}, attrs: {}, setAttribute() {}, appendChild() {}, remove() {}, select() {} }),
      body: { appendChild() {} },
    },
    window: { addEventListener: () => {}, isSecureContext: false },
    navigator: {}, location: { origin: "http://192.0.2.10:8088", pathname: "/", href: "http://192.0.2.10:8088/" },
    curLang: "zh-CN",
    toast: () => {},
    t: k => (I18N_DICTS[sandbox.curLang] && I18N_DICTS[sandbox.curLang][k]) || I18N_DICTS["zh-CN"][k] || k,
    tf: (k, v) => String(tOf(k)).replace(/\{(\w+)\}/g, (m, name) => Object.prototype.hasOwnProperty.call(v || {}, name) ? String(v[name]) : m),
    esc: s => String(s == null ? "" : s),
    jsAttrArg: s => JSON.stringify(s),
    fmtSize: b => (b / 1073741824).toFixed(1) + " GB",
    findMediaLibrary: () => null,
    fetch: async () => ({ ok: false, json: async () => ({}) }),
    sessionWriteHeaders: () => ({}),
    vaultStoreJSON: (k, d) => { try { return JSON.parse(store.getItem(k)) ?? d; } catch (e) { return d; } },
    vaultStoreSet: (k, v) => { try { store.setItem(k, JSON.stringify(v)); } catch (e) {} },
    openSettingsPage: () => {},
  };
  const tOf = k => sandbox.t(k);
  return Object.assign(sandbox, extra || {});
}
function load(file, extra) {
  const sandbox = makeSandbox(extra);
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(ROOT + file, "utf8"), sandbox, { filename: file });
  return sandbox;
}
const run = (sb, code) => vm.runInContext(code, sb);

(async () => {
/* ================= A. 刮削地区 → TMDB 语言 ================= */
const media = load("/web/js/02-media.js");

run(media, `scraperStatus = { scrape_region: "jp" }; curLang = "zh-CN";`);
chk("A1 地区=日本 → TMDB 用 ja-JP（覆盖界面语言 zh-CN）", run(media, "tmdbLangTag()") === "ja-JP", run(media, "tmdbLangTag()"));
run(media, `scraperStatus = { scrape_region: "cn" }; curLang = "en";`);
chk("A2 地区=中国 → zh-CN（覆盖界面语言 en）", run(media, "tmdbLangTag()") === "zh-CN", run(media, "tmdbLangTag()"));
run(media, `scraperStatus = { scrape_region: "us" }; curLang = "zh-TW";`);
chk("A3 地区=美国 → en-US", run(media, "tmdbLangTag()") === "en-US", run(media, "tmdbLangTag()"));
run(media, `scraperStatus = { scrape_region: "auto" }; curLang = "zh-TW";`);
chk("A4 地区=auto → 跟随界面语言（zh-TW）", run(media, "tmdbLangTag()") === "zh-TW", run(media, "tmdbLangTag()"));
run(media, `scraperStatus = {}; curLang = "en";`);
chk("A5 未配置（老后端）→ 跟随界面语言", run(media, "tmdbLangTag()") === "en-US", run(media, "tmdbLangTag()"));
chk("A6 大小写不敏感", run(media, `scrapeRegionLangTag("JP")`) === "ja-JP");
chk("A7 未知地区不产出语言（回落界面语言）", run(media, `scrapeRegionLangTag("de")`) === "");
chk("A8 空值安全", run(media, `scrapeRegionLangTag(null) === "" && scrapeRegionLangTag(undefined) === ""`));
/* 详情页演职人员缓存按「语言」失效：地区切换后缓存语言标记必须变化。 */
run(media, `scraperStatus = { scrape_region: "jp" }; curLang = "zh-CN";`);
const castLangJp = run(media, "tmdbLangTag()");
run(media, `scraperStatus = { scrape_region: "us" };`);
chk("A9 切换地区后语言标记变化 → 演职人员缓存自动重取", castLangJp !== run(media, "tmdbLangTag()"), [castLangJp, run(media, "tmdbLangTag()")]);

/* ================= B. 队列提示只进通知栏 ================= */
const mediaSource = fs.readFileSync(ROOT + "/web/js/02-media.js", "utf8");
/* 注释里保留了「曾经有什么 / 为什么删」的说明，判定只针对真实代码。 */
const mediaCode = mediaSource.replace(/\/\*[\s\S]*?\*\//g, " ");
chk("B1 库页不再出现刮削队列徽标", !mediaCode.includes("movieScrapeStatus"));
chk("B2 库页刮削设置按钮整块删除（v0.9.90）", !mediaCode.includes("movieScrapeControls") && !mediaCode.includes("刮削设置</span>"));
chk("B3 库页标题只带库名与统计（无第三参数入口）",
    /mediaLibraryHeading\(lib, `\$\{files\.length\} 部`\)/.test(mediaCode)
    && /mediaLibraryHeading\(lib, `\$\{shows\.length\} 部剧/.test(mediaCode));

const calls = [];
run(media, `this.__notice = null; upsertNotification = e => { __notice = e; };`);
run(media, `localStorage.setItem("vaulthub_movie_metadata_v1", JSON.stringify({ "a.mkv": { scrape_state: "ok" }, "b.mkv": { scrape_state: "failed" } }));`);
run(media, `movieMetadataMemory = null; movieScrapeContext = { host: null, lib: { id: "m1", name: "电影" }, files: [{ path: "a.mkv" }, { path: "b.mkv" }] };`);
run(media, `updateMovieScrapeStatus([{ path: "a.mkv" }, { path: "b.mkv" }])`);
const notice = run(media, "__notice");
chk("B4 队列状态写进通知中心（带稳定 key）", !!notice && notice.key === "scrape-queue-m1", notice && notice.key);
chk("B5 通知标题是真实中文文案并插入进度 {ok}/{total}", !!notice && notice.title === "刮削队列 1/2", notice && notice.title);
chk("B6 通知明细含库名与排队/重试数", !!notice && notice.detail.includes("电影") && notice.detail.includes("待重试 1") && notice.detail.includes("已刮削 1"), notice && notice.detail);
chk("B7 有失败项 → 通知等级 warn", !!notice && notice.level === "warn", notice && notice.level);
chk("B8 点击通知跳回影视视图", !!notice && notice.action && notice.action.view === "movie", notice && notice.action);

run(media, `this.__pushed = null; pushNotification = e => { __pushed = e; }; upsertNotification = undefined;`);
run(media, `updateMovieScrapeStatus([{ path: "a.mkv" }])`);
const pushed = run(media, "__pushed");
chk("B9 通知中心未加载时回落 pushNotification（不静默丢状态）", !!pushed && pushed.key === "scrape-queue-m1", pushed && pushed.key);

/* ================= C. 同 key 就地更新（07-topnav.js） ================= */
const top = load("/web/js/07-topnav.js");
run(top, `vhNotifications = [];`);
run(top, `upsertNotification({ key: "scrape-queue-m1", level: "info", title: "刮削队列 0/4", detail: "电影 · 排队中 4", action: { view: "movie" } })`);
chk("C1 首次写入生成一条通知并带 key", run(top, `vhNotifications.length === 1 && vhNotifications[0].key === "scrape-queue-m1"`), run(top, "JSON.stringify(vhNotifications)"));
run(top, `vhNotifications[0].read = true; upsertNotification({ key: "scrape-queue-m1", level: "warn", title: "刮削队列 1/4", detail: "电影 · 已刮削 1 · 待重试 3" })`);
chk("C2 同 key 只保留一条（进度刷新不刷屏）", run(top, "vhNotifications.length === 1"), run(top, "vhNotifications.length"));
chk("C3 同 key 更新标题/等级/明细", run(top, `vhNotifications[0].title === "刮削队列 1/4" && vhNotifications[0].level === "warn" && vhNotifications[0].detail.includes("待重试 3")`), run(top, "JSON.stringify(vhNotifications[0])"));
chk("C4 已读状态不被进度刷新重置（未读徽标不虚高）", run(top, "vhNotifications[0].read === true"), run(top, "vhNotifications[0].read"));
run(top, `upsertNotification({ key: "scrape-queue-m2", level: "ok", title: "刮削队列 5/5" })`);
chk("C5 不同媒体库各自一条", run(top, "vhNotifications.length === 2"), run(top, "vhNotifications.length"));
chk("C6 最新一条排在前面", run(top, "vhNotifications[0].key === 'scrape-queue-m2'"), run(top, "vhNotifications.map(n => n.key).join(',')"));
chk("C7 无 key 的通知仍走原 push 路径", run(top, `(() => { upsertNotification({ title: "普通通知" }); return vhNotifications.length === 3; })()`), run(top, "vhNotifications.length"));

/* ================= D. 无刮削信息不显示聚合说明 ================= */
chk("D1 文件名展示（解析回落）不算刮削信息", run(media, `hasScrapedInfo({ provider: "文件名展示", title: "Narcos" })`) === false);
chk("D2 无任何元数据不算刮削信息", run(media, `hasScrapedInfo(null) === false && hasScrapedInfo({}) === false`));
chk("D3 TMDB 刮削算刮削信息", run(media, `hasScrapedInfo({ provider: "TMDB" }) === true`));
chk("D4 本地元数据/海报/评分任一存在即算刮削信息", run(media, `hasScrapedInfo({ provider: "本地元数据" }) && hasScrapedInfo({ poster: "/api/media/cover?id=a&path=x.jpg" }) && hasScrapedInfo({ rating: 8.1 }) && hasScrapedInfo({ overview: "简介" })`));

const unscrapedHtml = run(media, `renderMovieHero({ id: "s1" }, "Narcos/S01E01.mkv", { title: "Narcos", media_type: "series", overview: "", provider: "文件名展示" })`);
chk("D5 剧集无刮削信息 → 不渲染聚合说明", !unscrapedHtml.includes("已按 Plex") && !unscrapedHtml.includes("聚合到同一剧集"), unscrapedHtml.slice(0, 200));
chk("D6 剧集无刮削信息 → 连介绍段落都不渲染", !unscrapedHtml.includes("<p>"), unscrapedHtml.slice(0, 200));
chk("D7 剧集无刮削信息仍有操作按钮（播放/收藏/编辑）", unscrapedHtml.includes("▶ 播放") && unscrapedHtml.includes("✎ 编辑"), unscrapedHtml.slice(0, 200));

chk("D8 已刮削但无简介 → 保留聚合说明（有信息价值）", run(media, `seriesHeroOverview({ title: "Narcos", provider: "TMDB" })`).includes("已按 Plex"), run(media, `seriesHeroOverview({ title: "Narcos", provider: "TMDB" })`));
chk("D8b 无刮削信息 → 聚合说明判定为空串", run(media, `seriesHeroOverview({ title: "Narcos", provider: "文件名展示" })`) === "", run(media, `seriesHeroOverview({ title: "Narcos", provider: "文件名展示" })`));
chk("D8c 有真实简介优先于聚合说明", run(media, `seriesHeroOverview({ overview: "真实简介", provider: "文件名展示" })`) === "真实简介");

const withOverview = run(media, `renderMovieHero({ id: "s1" }, "Narcos/S01E01.mkv", { title: "Narcos", media_type: "series", overview: "真实简介", provider: "TMDB" })`);
chk("D9 有简介时渲染简介而非聚合说明", withOverview.includes("真实简介") && !withOverview.includes("已按 Plex"));

const movieNoOverview = run(media, `renderMovieHero({ id: "m1" }, "a.mkv", { title: "电影", media_type: "movie", overview: "" })`);
chk("D10 电影保持原有兜底文案（未被本次改动影响）", movieNoOverview.includes("暂无电影介绍"), movieNoOverview.slice(0, 160));

/* ================= E. 设置读写带 scrape_region ================= */
const payloads = [];
const media2 = load("/web/js/02-media.js", {
  fetch: async (url, opt) => { payloads.push({ url, body: opt && opt.body }); return { ok: true, json: async () => ({}) }; },
});
media2.el("scrapeRegion").value = "jp";
media2.el("mediaScraperMode").value = "auto";
media2.el("mediaCacheDir").value = "/cache";
media2.el("mediaCacheMaxBytes").value = "0";
media2.el("mediaCacheMaxAge").value = "0";
media2.el("mediaCacheCleanup").value = "24";
await run(media2, `saveMediaRuntimeSettings()`);
const putBody = (payloads.find(p => p.body) || {}).body || "";
let putJson = {};
try { putJson = JSON.parse(putBody); } catch (e) {}
chk("E1 保存设置带上 scrape_region", putJson.scrape_region === "jp", putJson.scrape_region);
/* 读取：把服务端值回填到下拉框 */
const media3 = load("/web/js/02-media.js", {
  fetch: async () => ({ ok: true, json: async () => ({ scraper_mode: "auto", scrape_region: "us", cache_dir: "/c", tmdb_api_base: "https://api.themoviedb.org/3", tmdb_image_base: "https://image.tmdb.org/t/p", tvdb_api_base: "https://api4.thetvdb.com/v4" }) }),
});
await run(media3, `loadMediaRuntimeSettings(false)`);
chk("E2 读设置回填刮削地区下拉框", media3.el("scrapeRegion").value === "us", media3.el("scrapeRegion").value);
chk("E3 读取后原文生效（详情页语言立即跟随）", run(media3, "tmdbLangTag()") === "en-US", run(media3, "tmdbLangTag()"));


/* ================= F. i18n 三语齐备（真实词典，非桩） ================= */
["zh-CN", "zh-TW", "en"].forEach(lang => {
  const d = I18N_DICTS[lang];
  chk(`F1 ${lang} 刮削地区文案齐备（标签/四选项/说明）`,
    !!(d.scrapeRegionLabel && d.scrapeRegionAuto && d.scrapeRegionCn && d.scrapeRegionJp && d.scrapeRegionUs && d.scrapeRegionHint));
  chk(`F2 ${lang} 队列通知文案带 {{ok}}/{{total}} 占位符`,
    /\{ok\}/.test(d.notifyScrapeQueue || "") && /\{total\}/.test(d.notifyScrapeQueue || ""), d.notifyScrapeQueue);
});
chk("F3 中文选项写明 TMDB 语言码（ja-JP / en-US）",
  /ja-JP/.test(I18N_DICTS["zh-CN"].scrapeRegionJp) && /en-US/.test(I18N_DICTS["zh-CN"].scrapeRegionUs),
  [I18N_DICTS["zh-CN"].scrapeRegionJp, I18N_DICTS["zh-CN"].scrapeRegionUs]);
chk("F4 地区切换后 TMDB 语言标签随之变化（zh-CN 界面上三个地区各不相同）", (() => {
  const seen = run(media, `curLang = "zh-CN"; ["cn","jp","us"].map(r => { scraperStatus = { scrape_region: r }; return tmdbLangTag(); })`);
  return JSON.stringify(seen) === JSON.stringify(["zh-CN", "ja-JP", "en-US"]);
})(), run(media, `curLang = "zh-CN"; ["cn","jp","us"].map(r => { scraperStatus = { scrape_region: r }; return tmdbLangTag(); })`));

console.log("\nSUMMARY pass=" + passed + " fail=" + failed);
process.exit(failed ? 1 : 0);
})().catch(e => { console.log("HARNESS ERROR:", e && e.stack || e); process.exit(1); });
