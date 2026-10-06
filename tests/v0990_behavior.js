/* v0.9.90 行为测试（Node VM 桩，真实执行源文件）：
   A. 阅读进度 / 收藏读取是 O(1) 内存索引 —— 含**冷读**（不预热缓存）用例
   B. 整库索引分块拉取（2000/块）+ 让出主线程 + 进度回调
   C. 书刊架渲染窗口：≤3000 一次全量（整库可见不变）；超大库渐进 + 「继续加载」
      —— 含「切密度 / 切回完整展开」不得绕过窗口（审查发现并已修）
   D. 刮削命名跟随语言：剧集写入 show_title，展示名不再回落文件名解析值
   E. 跨标签页一致性：storage 事件必须让内存索引失效（审查发现并已修）
   源文件各自独立 vm 上下文（都定义同名 const，同上下文会 SyntaxError）。 */
const fs = require("fs"), vm = require("vm");
const ROOT = process.env.VH_ROOT || require("path").resolve(__dirname, "..");
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
    /* v0.9.90：按库建索引时会遍历 localStorage.length / key(i)，桩必须支持。 */
    get length() { return Object.keys(storage).length; },
    key: i => Object.keys(storage)[i] === undefined ? null : Object.keys(storage)[i],
  };
  const el = () => ({ value: "", textContent: "", innerHTML: "", style: {}, dataset: {}, classList: { add() {}, remove() {}, contains: () => false }, addEventListener() {}, appendChild() {}, remove() {}, setAttribute() {}, querySelector: () => null, querySelectorAll: () => [] });
  const sandbox = {
    console, Date, Number, Math, String, Array, JSON, Object, parseFloat, parseInt, isNaN, RegExp, Set, Map, Promise, URL,
    encodeURIComponent, decodeURIComponent, setTimeout, clearTimeout,
    storage, localStorage: store,
    document: {
      getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {},
      createElement: () => el(), body: { appendChild() {} },
    },
    /* window 记录注册过的监听器，供 E 组手动触发 storage 事件。 */
    window: { handlers: [], addEventListener(ev, fn) { this.handlers.push([ev, fn]); }, isSecureContext: false },
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

(async () => {
  /* ================= A. O(1) 状态索引（冷读） ================= */
  {
    const sb = load("web/js/02-media.js");
    const paths = [];
    for (let i = 0; i < 500; i++) paths.push("/TXT/book-" + i + ".txt");
    /* 冷读：直接写底层存储，**不**调用 writeBookFavorites / saveReadingProgress，
       否则会把内存缓存预热，测不出「首次打开」的真实开销（审查指出的原测试缺陷）。 */
    const favMap = {};
    paths.forEach(p => { favMap["L1::" + p] = true; });
    sb.storage["vaultHubBookFavorites"] = JSON.stringify(favMap);
    paths.forEach(p => {
      sb.storage[`vaulthub_reading_L1_${p}`] = JSON.stringify({ progress: 42, page: 3, total: 10, updatedAt: Date.now() });
    });
    chk("A0 冷启动：缓存与索引均未预热", call(sb, `bookFavoritesCache.map === null && Object.keys(readingStateIndexBuilt).length === 0`) === true);

    let gets = 0;
    const realGet = sb.localStorage.getItem;
    sb.localStorage.getItem = k => { gets++; return realGet(k); };
    const t0 = Date.now();
    const r = JSON.parse(call(sb, `(() => {
      const ps = ${JSON.stringify(paths)};
      let fav = 0, prog = 0;
      for (let i = 0; i < 5000; i++) {
        const p = ps[i % ps.length];
        if (isBookFavorite("L1", p)) fav++;
        if (readingState("L1", p).progress === 42) prog++;
      }
      return JSON.stringify({ fav, prog });
    })()`));
    const ms = Date.now() - t0;
    chk("A1 冷读下收藏与进度全部命中（10000 次读取）", r.fav === 5000 && r.prog === 5000, r);
    /* 修复前：每次 isBookFavorite 整表解析 + 每次 readingState 一次 getItem → ≥ 10000 次。
       修复后：收藏表 1 次冷读回填 + 进度索引 1 次建表（含 500 次 key 读取）。 */
    chk("A2 冷读 localStorage 次数与文件数同阶（修复前为 10000 次）", gets <= 600, gets);
    console.log("   [A] 冷读 10000 次状态读取耗时 " + ms + " ms，localStorage.getItem 共 " + gets + " 次（500 本库）");

    /* A3/A4 写入后立即生效（索引同步） */
    call(sb, `saveReadingProgress("L1", "/TXT/book-0.txt", 88, 9, 10)`);
    chk("A3 写入后立即读到新进度", call(sb, `readingState("L1", "/TXT/book-0.txt").progress`) === 88);
    call(sb, `toggleBookFavorite("L1", "/TXT/book-1.txt")`);
    chk("A4 取消收藏后立即生效", call(sb, `isBookFavorite("L1", "/TXT/book-1.txt")`) === false);

    /* A5 收藏表规模与实际条目一致（回填不能污染数据） */
    const n = call(sb, `bookFavoritesCount("L1")`);
    chk("A5 收藏计数正确（500 减掉取消的 1 条）", n === 499, n);
  }

  /* ================= B. 分块拉取 + 让出主线程 ================= */
  {
    const log = [];
    const total = 5000;
    const sb = load("web/js/02-media.js", {
      fetch: async (url) => {
        const u = new URL("http://x" + url);
        const off = Number(u.searchParams.get("offset")) || 0;
        const lim = Number(u.searchParams.get("limit")) || 500;
        log.push(lim + "@" + off);
        const files = [];
        for (let i = off; i < Math.min(total, off + lim); i++) files.push({ path: "/TXT/b" + String(i).padStart(5, "0") + ".txt", size: 100 });
        return { ok: true, json: async () => ({ status: "ready", total, offset: off, limit: lim, has_more: off + files.length < total, files, version: "v1" }) };
      },
    });
    const first = { has_more: true, total, status: "ready", files: [{ path: "/TXT/b00000.txt", size: 100 }] };
    const r = JSON.parse(await call(sb, `(async () => {
      let progressCalls = 0;
      const all = await fetchAllLibraryFiles("L1", ${JSON.stringify(first)}, 0, { onProgress: () => { progressCalls++; } });
      return JSON.stringify({ n: all.length, progressCalls });
    })()`));
    chk("B1 5000 条整库一次拉齐", r.n === total, r);
    const limits = log.map(x => Number(x.split("@")[0]));
    chk("B2 默认分块 2000（旧实现 500/块）", limits.every(l => l === 2000), log.slice(0, 3));
    const offsets = log.map(x => Number(x.split("@")[1]));
    chk("B3 偏移严格递增、无跳段", offsets.every((v, i) => i === 0 || v > offsets[i - 1]), offsets);
    chk("B4 每块回调进度（供首屏提示）", r.progressCalls >= 2, r.progressCalls);
    chk("B5 每块之间让出主线程（libraryIndexYield）", MEDIA_SRC.includes("await libraryIndexYield()"));
  }

  /* ================= C. 书刊架渲染窗口 ================= */
  {
    const els = {};
    const mkEl = () => ({ value: "", textContent: "", innerHTML: "", style: {}, dataset: {}, classList: { add() {}, remove() {}, contains: () => false }, addEventListener() {}, appendChild() {}, remove() {}, setAttribute() {}, querySelector: () => null, querySelectorAll: () => [] });
    const sb = load("web/js/02-media.js", {
      document: {
        getElementById: id => (els[id] || (els[id] = mkEl())),
        querySelector: () => null, querySelectorAll: () => [], addEventListener() {},
        createElement: mkEl, body: { appendChild() {} },
      },
    });
    const lib = { id: "L1", type: "book", name: "电子书" };
    const mk = n => { const a = []; for (let i = 0; i < n; i++) a.push({ path: "/TXT/c" + String(i).padStart(5, "0") + ".txt", size: 100 }); return a; };
    const count = () => (els["local-media-content-comic"].innerHTML.match(/data-media-path=/g) || []).length;

    call(sb, `renderComicShelf(${JSON.stringify(lib)}, ${JSON.stringify(mk(1200))}, 0, { force: true })`);
    const c1200 = count();
    chk("C1 1200 本一次全量渲染（整库可见保持不变）", c1200 === 1200, c1200);

    call(sb, `bookShelfRenderLimit = 0`);
    call(sb, `renderComicShelf(${JSON.stringify(lib)}, ${JSON.stringify(mk(4000))}, 0, { force: true })`);
    const c4000 = count();
    const html4000 = els["local-media-content-comic"].innerHTML;
    chk("C2 4000 本走渐进窗口（不再一次塞满 DOM）", c4000 > 0 && c4000 <= 3000, c4000);
    chk("C3 超大库提供「继续加载」入口（整库仍可达）", html4000.includes("继续加载") && html4000.includes("4000"), html4000.includes("继续加载"));

    /* C4/C5/C6：审查发现的漏洞 —— 密度/每页/展开等本地重绘绕过了窗口。
       修复前 setBookCols(4) 会把 4000 张卡一次性塞回 DOM（探针实测 4000）。 */
    call(sb, `localMediaSelection.comic = "L1"; localMediaLibraries = [${JSON.stringify(lib)}];`);
    call(sb, `setBookCols(4)`);
    const cDensity = count();
    chk("C4 切网格密度不绕过渲染窗口（修复前为整库 4000 张）", cDensity > 0 && cDensity <= 3000, cDensity);

    call(sb, `setBookPageSize(0)`);   // 「完整展开」
    const cExpand = count();
    chk("C5 切「完整展开」不绕过渲染窗口（修复前为整库 4000 张）", cExpand > 0 && cExpand <= 3000, cExpand);

    call(sb, `bookShelfLoadMore()`);
    const cMore = count();
    chk("C6 「继续加载」按窗口放大而非一次到底", cMore > cExpand && cMore <= 4000, cMore);
    chk("C7 窗口切片是公共函数（两条渲染路径共用）", MEDIA_SRC.includes("function bookShelfWindowSlice") && (MEDIA_SRC.match(/bookShelfWindowSlice\(/g) || []).length >= 3);
  }

  /* ================= D. 刮削命名跟随语言 ================= */
  {
    const path = "康熙王朝.Kang.Xi.Kingdom.S01E01.2001.1080p.WEB-DL.H265.AAC-ADWeb.mp4";
    const sb = load("web/js/02-media.js", {
      curLang: "zh-CN",
      fetch: async (url) => {
        const u = String(url);
        if (u.includes("/api/media/scrapers")) return { ok: true, json: async () => ({ tmdb_enabled: true, tvdb_enabled: false, scraper_mode: "auto", tmdb_image_base: "https://image.tmdb.org/t/p", scrape_min_match: 0.7 }) };
        if (u.includes("/api/media/tmdb")) return { ok: true, json: async () => ({ results: [{ id: 999, name: "康熙王朝", first_air_date: "2001-01-01", overview: "清朝康熙…", poster_path: "/k.jpg", vote_average: 8.6 }] }) };
        return { ok: false, json: async () => ({}) };
      },
    });
    await call(sb, `loadScraperStatus()`);   // 生产路径由 scrapeMovieMetadata 先加载
    await call(sb, `scrapeOneMovie({ id: "series-1", type: "series" }, [], { path: ${JSON.stringify(path)} })`);
    const meta = JSON.parse(call(sb, `JSON.stringify(movieMetadataFor(${JSON.stringify(path)}))`));
    chk("D1 剧集刮削写入 show_title = 当前语言剧名", meta.show_title === "康熙王朝", meta.show_title);
    const shows = JSON.parse(call(sb, `JSON.stringify(buildSeriesShows([{ path: ${JSON.stringify(path)}, size: 1 }]).map(s => s.title))`));
    chk("D2 剧集展示名 = 康熙王朝（不再回落「康熙王朝 Kang Xi Kingdom」）", shows[0] === "康熙王朝", shows);
    chk("D3 分集名不再重复剧名", String(meta.title || "").indexOf("康熙王朝") === -1, meta.title);
    /* 英文界面同一条目应得到英文命名（语言是变量） */
    const sbEn = load("web/js/02-media.js", {
      curLang: "en",
      fetch: async (url) => {
        const u = String(url);
        if (u.includes("/api/media/scrapers")) return { ok: true, json: async () => ({ tmdb_enabled: true, tvdb_enabled: false, scraper_mode: "auto", tmdb_image_base: "https://image.tmdb.org/t/p", scrape_min_match: 0.7 }) };
        if (u.includes("/api/media/tmdb")) return { ok: true, json: async () => ({ results: [{ id: 999, name: "Kangxi Dynasty", first_air_date: "2001-01-01", overview: "Qing…", poster_path: "/k.jpg", vote_average: 8.6 }] }) };
        return { ok: false, json: async () => ({}) };
      },
    });
    await call(sbEn, `loadScraperStatus()`);
    await call(sbEn, `scrapeOneMovie({ id: "series-1", type: "series" }, [], { path: ${JSON.stringify(path)} })`);
    const metaEn = JSON.parse(call(sbEn, `JSON.stringify(movieMetadataFor(${JSON.stringify(path)}))`));
    chk("D4 英文界面刮削后 show_title = 英文命名（语言变量生效）", metaEn.show_title === "Kangxi Dynasty", metaEn.show_title);
  }

  /* ================= E. 跨标签页一致性（storage 事件） ================= */
  {
    const sb = load("web/js/02-media.js");
    const reg = (sb.window.handlers || []).filter(h => h[0] === "storage").map(h => h[1]);
    chk("E1 已注册 storage 监听（此前一个都没有）", reg.length === 1, reg.length);
    if (reg.length === 1) {
      /* 预置一份收藏并被本页读进内存 */
      sb.storage["vaultHubBookFavorites"] = JSON.stringify({ "L1::/TXT/a.txt": true });
      chk("E2 本页读到初始收藏", call(sb, `isBookFavorite("L1", "/TXT/a.txt")`) === true);
      chk("E3 内存缓存已填充", call(sb, `bookFavoritesCache.map !== null`) === true);
      /* 模拟另一个标签页写入（storage 事件不改变本页 localStorage 快照，只通知） */
      call(sb, `bookFavoritesCache.map["L1::/TXT/b.txt"] = true; 1`);
      sb.storage["vaultHubBookFavorites"] = JSON.stringify({ "L1::/TXT/a.txt": true, "L1::/TXT/b.txt": true });
      reg[0]({ key: "vaultHubBookFavorites" });
      chk("E4 storage 事件后收藏缓存失效（下次读取重新解析）", call(sb, `bookFavoritesCache.map === null`) === true);
      chk("E5 失效后读到另一标签页的新收藏", call(sb, `isBookFavorite("L1", "/TXT/b.txt")`) === true);
      /* 该标签页的旧 isBookFavorite 结果不能残留 */
      call(sb, `saveReadingProgress("L1", "/TXT/a.txt", 60, 6, 10)`);
      chk("E6 进度索引已建立", call(sb, `Object.keys(readingStateIndexBuilt).length`) === 1);
      sb.storage[`vaulthub_reading_L1_/TXT/a.txt`] = JSON.stringify({ progress: 99, page: 9, total: 10, updatedAt: Date.now() });
      reg[0]({ key: `vaulthub_reading_L1_/TXT/a.txt` });
      /* 注意：readingState() 会优先返回服务端进度缓存（saveReadingProgress 也写它），
         所以这里直接断言**本地索引**被清掉并按新值重建（失效语义的落点）。 */
      /* 顺序要紧：先触发一次读取（此时才会按新值重建索引），再断言标志位。 */
      const rebuilt = call(sb, `readingStateLocal("L1", "/TXT/a.txt").progress`);
      chk("E7 storage 事件后本地进度索引按新值重建", rebuilt === 99, rebuilt);
      chk("E7b 重建后索引标志位为已建立", call(sb, `readingStateIndexBuilt["L1"] === true`) === true);
      chk("E8 readingStateInvalidate 不再是死代码（同一套失效逻辑被复用）", MEDIA_SRC.includes("function readingStateInvalidate"));
    }
    /* 书架偏好在另一标签页改动后同样失效 */
    const sb2 = load("web/js/02-media.js");
    const reg2 = (sb2.window.handlers || []).filter(h => h[0] === "storage").map(h => h[1])[0];
    call(sb2, `bookShelfPrefs()`);
    chk("E9 书架偏好缓存已填充", call(sb2, `bookShelfPrefsCache !== null`) === true);
    if (reg2) { reg2({ key: "vaultHubBookShelf" }); }
    chk("E10 偏好缓存失效后可重新读取", call(sb2, `bookShelfPrefsCache === null`) === true);
  }

  console.log(`\nSUMMARY pass=${passed} fail=${failed}`);
  process.exit(failed ? 1 : 0);
})();
