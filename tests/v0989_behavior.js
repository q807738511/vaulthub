/* v0.9.90 行为测试（Node VM 桩，真实执行源文件）：
     A. 阈值辅助口径：识别字符占比为主判据；匹配不足 → review（待确认），不自动重试
     B. 原因文案：不再出现「最高 0%」
     C. 本地化流水线：命中后图片按角色落盘 + 写 NFO；已本地化不重复写
     D. NFO 目标选择（电影 movie.nfo / 剧集 tvshow.nfo 上一层）
     E. 原文件名称进「媒体信息编辑」（只读字段 + 回填）
     F. 版本推进
   源文件各自独立 vm 上下文（都定义同名 const，同上下文会 SyntaxError）。 */
const fs = require("fs"), vm = require("vm");
const ROOT = process.env.VH_ROOT || require("path").resolve(__dirname, "..");
let passed = 0, failed = 0;

const I18N_DICTS = (() => {
  const sb = {
    console, Date, Number, Math, String, Array, JSON, Object, parseFloat, parseInt, isNaN, RegExp, Set, Map, setTimeout, clearTimeout,
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    document: {
      getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener: () => {},
      createElement: () => ({ style: {}, dataset: {}, setAttribute() {}, appendChild() {}, remove() {}, select() {} }),
      body: { appendChild() {} },
    },
    window: { addEventListener: () => {} },
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
  const storage = {};
  const store = {
    getItem: k => (k in storage ? storage[k] : null),
    setItem: (k, v) => { storage[k] = String(v); },
    removeItem: k => { delete storage[k]; },
  };
  const el = () => ({ value: "", textContent: "", innerHTML: "", style: {}, dataset: {}, classList: { add() {}, remove() {}, contains: () => false }, addEventListener() {}, appendChild() {}, remove() {} });
  const sandbox = {
    console, Date, Number, Math, String, Array, JSON, Object, parseFloat, parseInt, isNaN, RegExp, Set, Map, Promise,
    setTimeout, clearTimeout,
    storage, localStorage: store,
    document: {
      getElementById: el, querySelector: () => null, querySelectorAll: () => [], addEventListener: () => {},
      createElement: () => ({ style: {}, dataset: {}, setAttribute() {}, appendChild() {}, remove() {}, select() {} }),
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
  vm.runInContext(fs.readFileSync(ROOT + "/" + file, "utf8"), sandbox, { filename: file });
  return sandbox;
}
const call = (sb, expr) => vm.runInContext(expr, sb);
const MEDIA_SRC = fs.readFileSync(ROOT + "/web/js/02-media.js", "utf8");

/* ================= A. 阈值辅助口径 ================= */
{
  const sb = load("web/js/02-media.js");
  const detail = call(sb, `JSON.stringify(titleMatchDetail("Resume Test 2019", "Resume Test"))`);
  const d = JSON.parse(detail);
  chk("A1 覆盖率达标即可命中（辅助口径）", d.coverage >= 0.7, d);

  const hit = JSON.parse(call(sb, `JSON.stringify(pickTitleMatch([{title:"Resume Test", release_date:"2019-01-01"}], "Resume.Test.2019.1080p.BluRay.x264", {year:"2019"}))`));
  chk("A2 资源名带后缀仍命中，且带 coverage 字段", hit && hit.matched === true && typeof hit.coverage === "number" && hit.coverage >= 0.7, hit);

  const miss = JSON.parse(call(sb, `JSON.stringify(pickTitleMatch([{title:"Totally Different Film", release_date:"1993-05-01"}], "Water.Boys.2001.1080p.BluRay", {}))`));
  chk("A3 无关候选不命中", miss && miss.matched === false, miss);

  const low = JSON.parse(call(sb, `JSON.stringify(pickTitleMatch([{title:""},{name:""}], "Water.Boys.2001", {}))`));
  chk("A4 无标题候选返回 null（不炸）", low === null, low);

  // 命中判据以覆盖率为主：覆盖率达标即命中，即使综合分因年份差被压低
  const covHit = JSON.parse(call(sb, `JSON.stringify(pickTitleMatch([{title:"Water Boys", release_date:"1978-01-01"}], "Water.Boys.2001.1080p", {year:"2001"}))`));
  chk("A5 覆盖率达标即命中（年份不达标也不阻塞）", covHit && covHit.matched === true, covHit);

  // review 状态分流：匹配不足 → review；网络/凭据 → failed
  const setMeta = (obj) => { sb.storage["vaulthub_movie_metadata_v1"] = JSON.stringify(obj); call(sb, "movieMetadataMemory = null"); };
  setMeta({ "A/x.mp4": { reason: "识别字符占比 42%（＜ 70%）· 未采用" } });
  chk("A6 匹配不足 → review（待确认）", call(sb, `movieFallbackState("A/x.mp4")`) === "review");
  setMeta({ "A/x.mp4": { reason: "TMDB 请求失败：网络错误" } });
  chk("A7 网络失败 → failed（可重试）", call(sb, `movieFallbackState("A/x.mp4")`) === "failed");
  setMeta({ "A/x.mp4": { reason: "" } });
  chk("A8 无原因 → review（默认不阻塞）", call(sb, `movieFallbackState("A/x.mp4")`) === "review");

  // 队列：review 不自动重试
  chk("A9 待刮队列排除 review（不反复批量联网）", /state === "ok" \|\| state === "skip" \|\| state === "review"/.test(MEDIA_SRC));
  chk("A10 收尾状态使用 movieFallbackState（不再一律 failed）", MEDIA_SRC.includes("scrape_state: movieFallbackState(path)") && !/scrape_state: "failed", reason: readMovieMetadata/.test(MEDIA_SRC));
}

/* ================= B. 原因文案 ================= */
{
  const sb = load("web/js/02-media.js");
  const none = call(sb, `titleMatchReason(null, 0.7)`);
  chk("B1 无候选文案：不出现「最高 0%」", !none.includes("最高 0%") && none.includes("没有返回候选"), none);
  const zero = call(sb, `titleMatchReason({coverage:0, score:0}, 0.7)`);
  chk("B2 零覆盖文案：不出现「最高 0%」", !zero.includes("最高 0%") && zero.includes("没有共同字符"), zero);
  const low = call(sb, `titleMatchReason({coverage:0.5, score:0.6}, 0.7)`);
  chk("B3 低覆盖文案展示识别字符占比", low.includes("识别字符占比 50%") && low.includes("✎ 编辑名称"), low);
}

/* ================= C. 本地化流水线 ================= */
(async () => {
  const requests = [];
  const sb = load("web/js/02-media.js", {
    fetch: async (url, opts) => {
      const body = opts && opts.body ? JSON.parse(opts.body) : null;
      requests.push({ url: String(url), body });
      if (String(url).includes("/api/media/cover")) return { ok: true, status: 200, json: async () => ({ ok: true, url: `/api/media/cover?id=movie1&path=local-${body.role}&v=1`, role: body.role }) };
      if (String(url).includes("/api/media/nfo")) return { ok: true, status: 200, json: async () => ({ ok: true, nfo: "Water.Boys.2001/Water.Boys.2001.nfo", written: ["Water.Boys.2001/Water.Boys.2001.nfo"] }) };
      return { ok: false, status: 404, json: async () => ({}) };
    },
  });
  sb.scheduleMovieRender = () => {};
  sb.storage["vaulthub_movie_metadata_v1"] = JSON.stringify({
    "Water.Boys.2001/Water.Boys.2001.1080p.mkv": {
      title: "五个扑水的少年", year: "2001", scrape_state: "ok", overview: "剧情简介",
      poster: "https://image.tmdb.org/t/p/w342/wb.jpg", fanart: "https://image.tmdb.org/t/p/w1280/wb-f.jpg",
      tmdb_id: 61, rating: 6.8,
    },
  });
  call(sb, "movieMetadataMemory = null");
  await call(sb, `localizeMovieEntry({id:"movie1",type:"movie",name:"电影"}, "Water.Boys.2001/Water.Boys.2001.1080p.mkv")`);

  const coverCalls = requests.filter(r => r.url.includes("/api/media/cover"));
  const nfoCalls = requests.filter(r => r.url.includes("/api/media/nfo"));
  chk("C1 命中条目按角色请求图片本地化（poster/fanart）", coverCalls.length === 2 && coverCalls.map(r => r.body.role).sort().join(",") === "fanart,poster", coverCalls.map(r => r.body && r.body.role));
  chk("C2 会请求写 NFO（带 extras 与 meta）", nfoCalls.length === 1 && nfoCalls[0].body && nfoCalls[0].body.meta && nfoCalls[0].body.meta.title === "五个扑水的少年", nfoCalls[0] && nfoCalls[0].body);
  chk("C3 NFO 请求带电影 extras（movie.nfo）", nfoCalls.length === 1 && JSON.stringify(nfoCalls[0].body.extras) === JSON.stringify([{ name: "movie.nfo", up: 0 }]), nfoCalls.length ? nfoCalls[0].body.extras : null);
  chk("C4 站内图不重复下载", coverCalls.every(r => !String(r.body.url).startsWith("/api/media/")));
  /* writeMovieMetadata 是 400ms 防抖落盘（v0.9.82 的 localStorage 配额优化），
     测试里直接 flush 一次，避免等 400ms 也让断言稳定。 */
  call(sb, "flushMovieMetadata()");
  const stored = JSON.parse(sb.storage["vaulthub_movie_metadata_v1"]);
  const entry = stored["Water.Boys.2001/Water.Boys.2001.1080p.mkv"];
  chk("C5 本地化结果写回元数据（本地图 + nfo + 原文件名 + 标记）", !!entry.localized_at && entry.nfo === "Water.Boys.2001/Water.Boys.2001.nfo" && String(entry.poster).startsWith("/api/media/cover") && entry.original_path === "Water.Boys.2001/Water.Boys.2001.1080p.mkv", entry);
  /* v0.9.93：命中后的处理从单行变成语句块（块内新增「同剧分集同步」），断言改为块兼容。 */
  chk("C6 源码：mark 命中时排队本地化",
      /if \(patch\.scrape_state === "ok"\)\s*\{[\s\S]{0,240}queueMovieLocalization\(lib, path\);/.test(MEDIA_SRC));
  chk("C7 源码：已本地化条目跳过重复写盘", /meta\.localized_at && meta\.nfo/.test(MEDIA_SRC));
  chk("C8 源码：本地化串行（不会并发写盘风暴）", /movieLocalizeBusy/.test(MEDIA_SRC) && /while \(movieLocalizeQueue\.length\)/.test(MEDIA_SRC));

  /* 已本地化的条目再次排队 → 不再发起请求 */
  const before = requests.length;
  call(sb, `queueMovieLocalization({id:"movie1",type:"movie"}, "Water.Boys.2001/Water.Boys.2001.1080p.mkv")`);
  await new Promise(r => setTimeout(r, 20));
  chk("C9 已本地化条目不再重复请求", requests.length === before, requests.length - before);

  /* 回填：已刮削但未本地化的条目应被排队；已本地化的跳过；非 ok 状态跳过 */
  const sb2 = load("web/js/02-media.js");
  sb2.storage["vaulthub_movie_metadata_v1"] = JSON.stringify({
    "A/ok-no-nfo.mp4": { title: "甲", scrape_state: "ok" },
    "A/ok-done.mp4": { title: "乙", scrape_state: "ok", localized_at: 1, nfo: "A/ok-done.nfo" },
    "A/review.mp4": { title: "丙", scrape_state: "review" },
  });
  call(sb2, "movieMetadataMemory = null");
  sb2.scheduleMovieRender = () => {};
  const queued = call(sb2, `queueLocalizationBacklog({id:"movie1",type:"movie"}, [{path:"A/ok-no-nfo.mp4"},{path:"A/ok-done.mp4"},{path:"A/review.mp4"}])`);
  chk("C10 回填只排队「已刮削且未本地化」的条目", queued === 1, queued);
  chk("C11 回填单次进库限量（避免一口气写上千文件）", /MOVIE_LOCALIZE_BACKLOG_PER_VISIT = 60/.test(MEDIA_SRC));
  chk("C12 进库流程调用回填", /queueLocalizationBacklog\(lib, files\)/.test(MEDIA_SRC));

/* ================= D. NFO 目标 ================= */
{
  const sb = load("web/js/02-media.js");
  const movie = JSON.parse(call(sb, `JSON.stringify(movieNFOExtras({type:"movie"}, "A/B.mkv"))`));
  const series = JSON.parse(call(sb, `JSON.stringify(movieNFOExtras({type:"series"}, "Show/Season 01/E01.mkv"))`));
  chk("D1 电影写 movie.nfo（同目录）", JSON.stringify(movie) === JSON.stringify([{ name: "movie.nfo", up: 0 }]), movie);
  chk("D2 剧集写 tvshow.nfo（上一层 show 根）", JSON.stringify(series) === JSON.stringify([{ name: "tvshow.nfo", up: 1 }]), series);
}

/* ================= E. 原文件名称 ================= */
{
  const html = fs.readFileSync(ROOT + "/index.html", "utf8");
  chk("E1 媒体信息编辑新增只读「原文件名称」字段", /id="mediaEditOriginalName"[^>]*readonly/.test(html), html.includes("mediaEditOriginalName"));
  chk("E2 字段带三语 i18n", I18N_DICTS["zh-CN"].editOriginalNameLabel && I18N_DICTS["zh-TW"].editOriginalNameLabel && I18N_DICTS["en"].editOriginalNameLabel, [I18N_DICTS["zh-CN"].editOriginalNameLabel, I18N_DICTS["zh-TW"].editOriginalNameLabel, I18N_DICTS["en"].editOriginalNameLabel]);
  chk("E3 弹窗打开时回填原文件名", /mediaEditOriginalName.*split\("\/"\).pop\(\)/.test(MEDIA_SRC.replace(/\s+/g, "")) || MEDIA_SRC.includes('origInput.value=String(path).split("/").pop()'));
  chk("E4 卡片保留原文件名（tooltip，不占版面）", MEDIA_SRC.includes('title="原文件：${esc(path)}"'));
}

/* ================= F. 版本 ================= */
{
  const html = fs.readFileSync(ROOT + "/index.html", "utf8");
  const state = fs.readFileSync(ROOT + "/web/js/01-state.js", "utf8");
  chk("F1 index.html 资源版本 0.9.93 ×10", (html.match(/\?v=0\.9\.93/g) || []).length === 10);
  chk("F2 ASSET_VERSION = 0.9.90", html.includes('window.VAULTHUB_ASSET_VERSION = "0.9.93";'));
  /* v0.9.90：标语随版本推进，这里只校验「版本前缀正确 + 三处一致」，避免每个版本都要改测试。 */
  /* v0.9.92（上轮审查项）：整串一致，而不是只数版本前缀。 */
  chk("F3 三处标语整串一致", (() => {
    const s = (html.match(/v0\.9\.9\d · [^<"]+/g) || []);
    return s.length === 3 && new Set(s).size === 1;
  })());
  chk("F4 SCRIPT_VERSION = 0.9.90", state.includes('const VAULTHUB_SCRIPT_VERSION = "0.9.93";'));
}

console.log(`\nSUMMARY pass=${passed} fail=${failed}`);
process.exit(failed ? 1 : 0);
})();
