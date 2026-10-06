/* v0.9.90 行为测试（Node VM 桩，真实执行源文件）：
     A. TMDB 标题匹配阈值（最低识别字符占比 70%）
     B. 原盘 ISO / BDMV 识别、合并与标题
     C. 刮削结果服务端持久化（影视 / 电子书）：读写形状、合并语义、批量次数
     D. 音乐沿用服务端持久化：未命中曲目在重试窗口内不再联网
     E. 设置项与 i18n（阈值三语齐备、输入框存在）
   三个源文件各自独立 vm 上下文（都定义 esc/t 等同名 const，同上下文会 SyntaxError）。 */
const fs = require("fs"), vm = require("vm");
/* 仓库根目录由本文件位置推导，不写死开发机路径（否则 CI 上必然 ENOENT）。需要时可设 VH_ROOT 覆盖。 */
const ROOT = process.env.VH_ROOT || require("path").resolve(__dirname, "..");
let passed = 0, failed = 0;

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
      getElementById: el, querySelector: () => null, querySelectorAll: () => [], addEventListener: () => {},
      createElement: () => ({ style: {}, dataset: {}, attrs: {}, setAttribute() {}, appendChild() {}, remove() {}, select() {} }),
      body: { appendChild() {} },
    },
    window: { addEventListener: () => {}, isSecureContext: false },
    navigator: {}, location: { origin: "http://192.0.2.10:8088", pathname: "/", href: "http://192.0.2.10:8088/" },
    curLang: "zh-CN",
    toast: () => {},
    t: k => (I18N_DICTS[sandbox.curLang] && I18N_DICTS[sandbox.curLang][k]) || I18N_DICTS["zh-CN"][k] || k,
    tf: (k, v) => String(sandbox.t(k)).replace(/\{(\w+)\}/g, (m, name) => Object.prototype.hasOwnProperty.call(v || {}, name) ? String(v[name]) : m),
    esc: s => String(s == null ? "" : s),
    jsAttrArg: s => JSON.stringify(s),
    findMediaLibrary: () => null,
    fetch: async () => ({ ok: false, json: async () => ({}) }),
    sessionWriteHeaders: () => ({}),
    vaultStoreJSON: (k, d) => { try { const v = store.getItem(k); return v == null ? d : (JSON.parse(v) ?? d); } catch (e) { return d; } },
    vaultStoreSet: (k, v) => { try { store.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } },
    pushNotification: () => {}, upsertNotification: () => {},
  };
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
const media = load("/web/js/02-media.js");

/* ================= A. 标题匹配阈值 ================= */
chk("A1 完全相同 → 1.0", run(media, `titleMatchScore("Narcos", "Narcos")`) === 1, run(media, `titleMatchScore("Narcos", "Narcos")`));
chk("A2 中文完全相同 → 1.0", run(media, `titleMatchScore("黑鹰坠落", "黑鹰坠落")`) === 1);
chk("A3 发布组噪声/规格不影响判定", run(media, `titleMatchScore("Resume.Test.2019.1080p.WEB-DL", "Resume Test")`) >= 0.95, run(media, `titleMatchScore("Resume.Test.2019.1080p.WEB-DL", "Resume Test")`));
chk("A4 资源名多出副标题仍算命中（≥70%）", run(media, `titleMatchScore("阿凡达", "阿凡达：水之道")`) >= 0.7, run(media, `titleMatchScore("阿凡达", "阿凡达：水之道")`));
chk("A5 无关标题低于阈值", run(media, `titleMatchScore("黑鹰坠落", "泰坦尼克号")`) < 0.7, run(media, `titleMatchScore("黑鹰坠落", "泰坦尼克号")`));
chk("A6 大小写与全角半角归一化", run(media, `titleMatchScore("ＲＥＳＵＭＥ ＴＥＳＴ", "resume test")`) === 1, run(media, `titleMatchScore("ＲＥＳＵＭＥ ＴＥＳＴ", "resume test")`));

/* 阈值来源：服务端 scrape_min_match（默认 0.7），越界值被夹到 [0.3,1]。 */
run(media, `scraperStatus = {};`);
chk("A7 未配置时默认 70%", run(media, "scrapeMinMatchThreshold()") === 0.7);
run(media, `scraperStatus = { scrape_min_match: 0.85 };`);
chk("A8 服务端阈值生效（85%）", run(media, "scrapeMinMatchThreshold()") === 0.85);
run(media, `scraperStatus = { scrape_min_match: 0.05 };`);
chk("A9 过低阈值被夹到 30%", run(media, "scrapeMinMatchThreshold()") === 0.3);
run(media, `scraperStatus = { scrape_min_match: 3 };`);
chk("A10 过高阈值被夹到 100%", run(media, "scrapeMinMatchThreshold()") === 1);

/* 候选挑选：original_title 参与打分（切地区后 TMDB 返回当地语言标题） */
run(media, `scraperStatus = { scrape_min_match: 0.7 };`);
const picked = run(media, `pickTitleMatch([
  { id: 1, title: "The Great Escape", original_title: "大逃亡" },
  { id: 2, title: "Resume Test", original_title: "Resume Test" }
], "大逃亡 1963", { year: "1963" })`);
chk("A11 用 original_title 命中中文查询", picked && picked.item.id === 1 && picked.matched, picked);
const low = run(media, `pickTitleMatch([{ id: 9, title: "完全不同的一部片" }], "黑鹰坠落", {})`);
chk("A12 全部低于阈值 → matched=false（不改用文件名之前的错误候选）", low && low.item.id === 9 && low.matched === false, low);
const none = run(media, `pickTitleMatch([], "黑鹰坠落", {})`);
chk("A13 没有候选 → null（不会抛错）", none === null, none);
const yearPick = run(media, `pickTitleMatch([
  { id: 1, title: "Dune", release_date: "1984-12-14" },
  { id: 2, title: "Dune", release_date: "2021-10-22" }
], "Dune", { year: "2021" })`);
chk("A14 同名作品按年份纠偏（1984 vs 2021）", yearPick && yearPick.item.id === 2, yearPick);
/* v0.9.90：口径改为「识别字符占比」，文案同步（且不再出现「最高】n%」）。 */
chk("A15 匹配度不足的原因写明识别字符占比与阈值",
  run(media, `titleMatchReason({ coverage: 0.42, score: 0.42 }, 0.7)`).includes("识别字符占比 42%")
  && run(media, `titleMatchReason({ coverage: 0.42, score: 0.42 }, 0.7)`).includes("70%")
  && !run(media, `titleMatchReason({ coverage: 0.42, score: 0.42 }, 0.7)`).includes("最高"),
  run(media, `titleMatchReason({ coverage: 0.42, score: 0.42 }, 0.7)`));

/* 端到端：单条刮削的失败原因必须保留「匹配度不足」，而不是被末尾的笼统文案覆盖 */
const mkE2E = results => load("/web/js/02-media.js", {
  fetch: async (url) => {
    const u = String(url);
    if (u.includes("/api/media/tmdb")) return { ok: true, status: 200, json: async () => ({ results }) };
    return { ok: false, status: 404, json: async () => ({}) };
  }
});
const e2eMiss = mkE2E([{ id: 5, title: "完全不同的一部片", release_date: "1999-01-01" }]);
run(e2eMiss, `scraperStatus = { scraper_mode: "auto", tmdb_enabled: true, scrape_min_match: 0.7 };`);
await run(e2eMiss, `scrapeOneMovie({id:"movie1",type:"movie"}, [{path:"黑鹰坠落.Blu-ray.2001.iso"}], {path:"黑鹰坠落.Blu-ray.2001.iso"})`);
const missMeta = run(e2eMiss, `movieMetadataFor("黑鹰坠落.Blu-ray.2001.iso")`);
/* v0.9.90：匹配不足不再是硬失败 —— 记 review（待确认，保留文件名展示、不进自动重试），
   原因写明「没有共同字符」而不是让人误以为程序坏掉的「最高 0%」。 */
chk("A16 候选都低于阈值 → 记 review 且原因写明「没有共同字符」（不被笼统文案覆盖）",
  missMeta.scrape_state === "review" && !String(missMeta.reason).includes("最高 0%")
  && (missMeta.reason.includes("没有共同字符") || missMeta.reason.includes("识别字符占比")), missMeta.reason);

const e2eHit = mkE2E([
  { id: 7, title: "无关短片", vote_average: 9 },
  { id: 42, title: "黑鹰坠落", release_date: "2001-12-28", poster_path: "/bhd.jpg", overview: "摩加迪沙", vote_average: 8.1 }
]);
run(e2eHit, `scraperStatus = { scraper_mode: "auto", tmdb_enabled: true, scrape_min_match: 0.7 };`);
await run(e2eHit, `scrapeOneMovie({id:"movie1",type:"movie"}, [{path:"黑鹰坠落.Blu-ray.2001.iso"}], {path:"黑鹰坠落.Blu-ray.2001.iso"})`);
const hitMeta = run(e2eHit, `movieMetadataFor("黑鹰坠落.Blu-ray.2001.iso")`);
chk("A17 命中时取最高分候选并记录候选名与匹配度",
  hitMeta.scrape_state === "ok" && hitMeta.tmdb_id === 42 && hitMeta.match_score >= 0.99 && hitMeta.tmdb_title === "黑鹰坠落" && hitMeta.poster.includes("/bhd.jpg"), hitMeta);

/* ================= B. 原盘 ISO / BDMV ================= */
chk("B1 BDMV 片段归到原盘目录", run(media, `discGroupOf("/MO/片/BDMV/STREAM/00011.m2ts").key`) === "/MO/片" && run(media, `discGroupOf("/MO/片/BDMV/STREAM/00011.m2ts").kind`) === "bdmv");
chk("B2 ISO 归到所在目录", run(media, `discGroupOf("/MO/片/片.iso").key`) === "/MO/片" && run(media, `discGroupOf("/MO/片/片.iso").kind`) === "iso");
chk("B3 普通视频不算原盘", run(media, `discGroupOf("/MO/片/片.mkv")`) === null);
chk("B4 普通视频不参与合并", run(media, `collapseDiscFragments([{path:"/MO/a.mkv"},{path:"/MO/b.mp4"}]).length`) === 2);

const isoOnly = run(media, `collapseDiscFragments([{path:"/MO/片A/片A.iso", size: 900}])`);
chk("B5 单个 ISO 成为一条原盘条目（disc_kind=iso）", isoOnly.length === 1 && isoOnly[0].disc === true && isoOnly[0].disc_kind === "iso" && isoOnly[0].disc_fragments === 1, isoOnly);

const multiIso = run(media, `collapseDiscFragments([{path:"/MO/片A/DISC1.iso", size: 100},{path:"/MO/片A/DISC2.iso", size: 900}])`);
chk("B6 同目录多张 ISO 合并为一条并保留最大镜像", multiIso.length === 1 && multiIso[0].disc_fragments === 2 && multiIso[0].path === "/MO/片A/DISC2.iso", multiIso);

const mixed = run(media, `collapseDiscFragments([
  {path:"/MO/片B/片B.Blu-ray.iso", size: 50000},
  {path:"/MO/片B/BDMV/STREAM/00000.m2ts", size: 900},
  {path:"/MO/片B/BDMV/STREAM/00001.m2ts", size: 1200}
])`);
chk("B7 ISO 与解压出的 BDMV 并存 → 只出现一条", mixed.length === 1, mixed);
chk("B8 合并后播放路径取可播的 BDMV 片段", mixed[0].path === "/MO/片B/BDMV/STREAM/00001.m2ts", mixed[0]);
chk("B9 仍然记录镜像路径与片段数", mixed[0].iso_path === "/MO/片B/片B.Blu-ray.iso" && mixed[0].disc_fragments === 3, mixed[0]);
chk("B10 合并幂等", run(media, `collapseDiscFragments(${JSON.stringify(mixed)}).length`) === 1);

const bdmvOnly = run(media, `collapseDiscFragments([
  {path:"/MO/片C/BDMV/STREAM/00000.m2ts", size: 900},
  {path:"/MO/片C/BDMV/STREAM/00001.m2ts", size: 1200},
  {path:"/MO/其它/片D.mkv", size: 10}
])`);
chk("B11 纯 BDMV 目录行为不变（合并 + 保留最大片段）", bdmvOnly.length === 2 && bdmvOnly[0].disc_fragments === 2 && bdmvOnly[0].path.endsWith("00001.m2ts"), bdmvOnly);

/* 标题：ISO 名可用则用名；通用名（BDMV/disc/纯编号）上溯父目录 */
chk("B12 ISO 名就是片名", run(media, `movieTitleFromPath("/MO/[黑鹰坠落]Black.Hawk.Down.2001.Blu-ray.iso")`) === "黑鹰坠落 Black Hawk Down", run(media, `movieTitleFromPath("/MO/[黑鹰坠落]Black.Hawk.Down.2001.Blu-ray.iso")`));
chk("B13 ISO 名为 BDMV.iso → 用父目录名", run(media, `movieTitleFromPath("/MO/五个扑水的少年(2001)/BDMV.iso")`) === "五个扑水的少年", run(media, `movieTitleFromPath("/MO/五个扑水的少年(2001)/BDMV.iso")`));
chk("B14 ISO 名为纯编号 → 用父目录名", run(media, `movieTitleFromPath("/MO/Resume Test (2019)/01002.iso")`) === "Resume Test", run(media, `movieTitleFromPath("/MO/Resume Test (2019)/01002.iso")`));
chk("B15 BDMV 片段仍取原盘目录名", run(media, `movieTitleFromPath("/MO/[黑鹰坠落]Black.Hawk.Down.2001.Blu-ray.1080p.AVC/BDMV/STREAM/00011.m2ts")`).startsWith("黑鹰坠落 Black Hawk Down"), run(media, `movieTitleFromPath("/MO/[黑鹰坠落]Black.Hawk.Down.2001.Blu-ray.1080p.AVC/BDMV/STREAM/00011.m2ts")`));
chk("B16 原盘目录名不可用（disc）→ 上溯父目录", run(media, `movieTitleFromPath("/MO/Resume Test (2019)/disc/BDMV/STREAM/00011.m2ts")`) === "Resume Test", run(media, `movieTitleFromPath("/MO/Resume Test (2019)/disc/BDMV/STREAM/00011.m2ts")`));
chk("B17 普通文件标题行为不变", run(media, `movieTitleFromPath("/MO/Resume.Test.2019.1080p.mp4")`) === "Resume Test");

chk("B18 副标题：ISO", run(media, `discSubtitle({disc:true,disc_kind:"iso",disc_fragments:1})`) === "原盘 · ISO");
chk("B19 副标题：多镜像", run(media, `discSubtitle({disc:true,disc_kind:"iso",disc_fragments:3})`) === "原盘 · ISO · 3 个镜像");
chk("B20 副标题：ISO + BDMV", run(media, `discSubtitle({disc:true,disc_kind:"bdmv",iso_path:"/x.iso",disc_fragments:5})`) === "原盘 · ISO + BDMV · 5 个片段");
chk("B21 副标题：纯 BDMV 目录", run(media, `discSubtitle({disc:true,disc_kind:"bdmv",disc_fragments:12})`) === "原盘 · 12 个片段");
chk("B22 卡片副标题含年份与原盘形态", run(media, `moviePosterSubtitle({year:"2001"}, "/MO/片.iso", {disc:true,disc_kind:"iso",disc_fragments:1})`) === "2001 · 原盘 · ISO");

/* ================= C. 刮削结果服务端持久化 ================= */
const calls = [];
const jfetch = async (url, opts) => {
  calls.push({ url: String(url), method: (opts && opts.method) || "GET", body: opts && opts.body });
  if (String(url).includes("/api/media/scrape-cache")) {
    if ((opts && opts.method) === "POST") return { ok: true, status: 200, json: async () => ({ ok: true, stored: 1 }) };
    if ((opts && opts.method) === "DELETE") return { ok: true, status: 200, json: async () => ({ ok: true, cleared: 1 }) };
    return { ok: true, status: 200, json: async () => ({ ok: true, id: "movie1", items: jfetch.serverItems || {} }) };
  }
  return { ok: false, status: 404, json: async () => ({}) };
};
const store2 = load("/web/js/02-media.js", { fetch: jfetch });

chk("C1 上传形状只带服务端认识的字段", (() => {
  const shape = run(store2, `movieScrapeStoreShape({title:"片",year:"2024",poster:"https://x/y.jpg",tmdb_id:12,scrape_state:"ok",reason:"",cover:"ignored",checkedAt:1234})`);
  return shape.title === "片" && shape.tmdb_id === 12 && shape.checked_at === 1234 && shape.cover === undefined && shape.reason === undefined && shape.year === "2024";
})(), run(store2, `movieScrapeStoreShape({title:"片",cover:"ignored",checkedAt:1234})`));
chk("C2 空值字段不上传（不污染结果库）", (() => {
  const shape = run(store2, `movieScrapeStoreShape({title:"片",poster:"",rating:0,overview:"",checkedAt:5})`);
  return shape.poster === undefined && shape.rating === undefined && shape.overview === undefined && shape.checked_at === 5;
})());

/* 进库先合并服务端结果：服务端较新 → 覆盖；本地较新 → 保留 */
jfetch.serverItems = {
  "a.mkv": { title: "服务端标题", poster: "https://img/a.jpg", scrape_state: "ok", checked_at: 5000 },
  "b.mkv": { title: "服务端旧标题", scrape_state: "failed", reason: "未命中", checked_at: 100 },
  "c.mkv": { title: "新增条目", scrape_state: "ok", checked_at: 900 },
  "e.mkv": { title: "服务端失败条目", scrape_state: "failed", reason: "标题匹配度不足（最高 42% ＜ 70%）", checked_at: 3000 }
};
run(store2, `localStorage.setItem("vaulthub_movie_metadata_v1", JSON.stringify({
  "a.mkv": { title: "本地旧标题", checkedAt: 1000 },
  "b.mkv": { title: "本地新标题", checkedAt: 9999 }
})); movieMetadataMemory = null;`);
const hydrated = await run(store2, `hydrateMovieMetadataFromServer("movie1")`);
const after = run(store2, `JSON.stringify(readMovieMetadata())`);
const afterObj = JSON.parse(after);
chk("C3 进库读服务端并合并（返回 true）", hydrated === true);
chk("C4 服务端较新 → 覆盖本地", afterObj["a.mkv"].title === "服务端标题" && afterObj["a.mkv"].poster === "https://img/a.jpg", afterObj["a.mkv"]);
chk("C5 本地较新 → 不被旧结果回冲", afterObj["b.mkv"].title === "本地新标题", afterObj["b.mkv"]);
chk("C6 本地没有的条目被补齐（已刮削的不再进队列）", afterObj["c.mkv"].title === "新增条目" && afterObj["c.mkv"].scrape_state === "ok", afterObj["c.mkv"]);
chk("C7 合并后 checked_at 不残留（本地统一用 checkedAt）", afterObj["a.mkv"].checked_at === undefined);
const getCalls = calls.filter(c => c.url.includes("/api/media/scrape-cache") && c.method === "GET");
chk("C8 只发一次读取请求（不是每条一次）", getCalls.length === 1, getCalls.length);
chk("C8b 服务端记过的「失败」条目沿用尝试时间与次数（换设备不立刻重打 3 遍）",
  afterObj["e.mkv"].scrape_attempts === 1 && afterObj["e.mkv"].last_attempt === 3000
  && afterObj["e.mkv"].reason.includes("匹配度不足"), afterObj["e.mkv"]);
chk("C8d 本地更新过的条目不被服务端陈旧结果覆盖（连尝试信息一起保留）",
  afterObj["b.mkv"].scrape_attempts === undefined || afterObj["b.mkv"].title === "本地新标题", afterObj["b.mkv"]);
jfetch.serverItems = { "d.mkv": { title: "失败条目", scrape_state: "failed", reason: "标题匹配度不足（最高 42% ＜ 70%）", checked_at: 8000 } };
await run(store2, `hydrateMovieMetadataFromServer("movie1")`);
const dMeta = JSON.parse(run(store2, `JSON.stringify(readMovieMetadata()["d.mkv"])`));
chk("C8c 失败条目带上了 last_attempt（重试窗口生效）", dMeta.scrape_attempts === 1 && dMeta.last_attempt === 8000, dMeta);

/* 写回：一次请求带多条 */
calls.length = 0;
run(store2, `pushMovieScrapeResults("movie1", ["a.mkv", "b.mkv", "c.mkv", "a.mkv"])`);
await new Promise(r => setTimeout(r, 10));
const posts = calls.filter(c => c.method === "POST");
chk("C9 写回是「一批一条请求」", posts.length === 1, posts.length);
const sentBody = posts.length ? JSON.parse(posts[0].body) : {};
chk("C10 去重后提交 3 条", Object.keys(sentBody.items || {}).length === 3, Object.keys(sentBody.items || {}));
chk("C11 默认非 replace（旧结果不覆盖新结果）", sentBody.replace === false);
calls.length = 0;
run(store2, `pushMovieScrapeResults("movie1", ["a.mkv"], { replace: true })`);
await new Promise(r => setTimeout(r, 10));
chk("C12 手动重刮时 replace=true", JSON.parse(calls.filter(c => c.method === "POST")[0].body).replace === true);
calls.length = 0;
await run(store2, `clearServerScrapeCache("movie1")`);
chk("C13 重新刮削可清空服务端结果库", calls.some(c => c.method === "DELETE" && c.url.includes("id=movie1")), calls);

/* 电子书：封面结果同样持久化 + 进书架先灌回本地缓存 */
calls.length = 0;
run(store2, `pushBookScrapeResult("comic1", "书/一本.epub", "一本书", "/api/media/file?id=comic1&path=x.jpg")`);
await new Promise(r => setTimeout(r, 10));
const bookPost = calls.filter(c => c.method === "POST")[0];
const bookBody = bookPost ? JSON.parse(bookPost.body) : {};
chk("C14 书籍封面写入同一结果库（kind=book）", bookBody.items && bookBody.items["书/一本.epub"] && bookBody.items["书/一本.epub"].kind === "book" && bookBody.items["书/一本.epub"].poster.startsWith("/api/media/"), bookBody);
jfetch.serverItems = { "书/一本.epub": { title: "一本书", poster: "/api/media/file?id=comic1&path=x.jpg", kind: "book", checked_at: 7000 } };
run(store2, `localStorage.removeItem("vaulthub_cover_scrape_v1");`);
const bookHydrated = await run(store2, `hydrateBookCoversFromServer("comic1")`);
const coverCache = run(store2, `JSON.stringify(readCoverCache())`);
chk("C15 进书架前把服务端封面灌回本地缓存（避免重复刮削）", bookHydrated === true && coverCache.includes("x.jpg"), coverCache);

/* ================= D. 音乐：未命中不重复联网 ================= */
const audioCalls = [];
const afetch = async (url) => {
  audioCalls.push(String(url));
  if (String(url).includes("/api/media/audio/cache")) return { ok: false, status: 404, json: async () => ({}) };
  if (String(url).includes("/api/media/audio/metadata?")) return { ok: true, status: 200, json: async () => ({ title: "刮到的标题", artist: "歌手", provider: "MusicBrainz" }) };
  return { ok: true, status: 200, json: async () => ({}) };
};
const audio = load("/web/js/02-media.js", { fetch: afetch });
const providerQueries = () => audioCalls.filter(u => u.includes("/api/media/audio/metadata?")).length;

run(audio, `localStorage.setItem("vaulthub_audio_metadata_v1", JSON.stringify({ "song.mp3": { title: "歌", artist: "未知歌手", status: "not_found", checkedAt: Date.now() } })); audioMetadataMemory = null;`);
await run(audio, `scrapeAudioMetadataInner(null, { id: "a1" }, [{ path: "song.mp3" }])`);
chk("D1 服务端记过未命中 → 窗口内不再联网（0 次）", providerQueries() === 0, audioCalls);
audioCalls.length = 0;
run(audio, `localStorage.setItem("vaulthub_audio_metadata_v1", JSON.stringify({ "song.mp3": { title: "歌", artist: "未知歌手", status: "failed", checkedAt: Date.now() - 11 * 60 * 1000 } })); audioMetadataMemory = null; audioScrapeAttemptedSession.clear();`);
await run(audio, `scrapeAudioMetadataInner(null, { id: "a1" }, [{ path: "song.mp3" }])`);
chk("D2 超出重试窗口（>10 分钟）→ 正常重试（1 次）", providerQueries() === 1, audioCalls);
chk("D3 窗口常量与影视一致（10 分钟）", run(audio, "AUDIO_SCRAPE_RETRY_MS") === 10 * 60 * 1000);

/* ================= E. 设置项与 i18n ================= */
const html = fs.readFileSync(ROOT + "/index.html", "utf8");
chk("E1 设置页有匹配阈值输入框（默认 70）", /id="scrapeMinMatch"[^>]*value="70"/.test(html) && html.includes('data-env="SCRAPE_MIN_MATCH"'), (html.match(/<input id="scrapeMinMatch"[^>]*>/) || [])[0]);
for (const [lang, dict] of Object.entries(I18N_DICTS)) {
  chk(`E2 ${lang} 有 scrapeMinMatchLabel`, !!dict.scrapeMinMatchLabel, dict.scrapeMinMatchLabel);
  chk(`E3 ${lang} 有 scrapeMinMatchHint`, !!dict.scrapeMinMatchHint, dict.scrapeMinMatchHint);
}
chk("E4 三语阈值文案互不相同（确实翻译了）", new Set(Object.values(I18N_DICTS).map(d => d.scrapeMinMatchLabel)).size === 3);
chk("E5 已删除的库页入口文案不再残留", !Object.values(I18N_DICTS).some(d => d.scrapeGoSettings));
chk("E6 设置保存/读取都带 scrape_min_match", /scrape_min_match:Math\.max\(30/.test(fs.readFileSync(ROOT + "/web/js/02-media.js", "utf8")) && /scrapeMinMatch:Math\.round\(\(Number\(c\.scrape_min_match\)/.test(fs.readFileSync(ROOT + "/web/js/02-media.js", "utf8")));

console.log(`\nSUMMARY pass=${passed} fail=${failed}`);
process.exit(failed ? 1 : 0);
})();
