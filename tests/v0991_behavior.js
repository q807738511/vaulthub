/* v0.9.91 行为测试（Node VM 桩，真实执行源文件）：
   A. 解/转码风向标：策略开关、播放计划带 server_transcode、客户端解码标签与「解码路径」行、
      禁用时兼容流回退被拒绝（源码级守卫）
   B. 下滑自动翻页：到底判定、窗口模式（书刊架）/ 分页模式（offset）、冷却窗口、hasMore 守卫、
      监听器只注册一次
   C. 剧名修复：旧记录（只有 title）补出 show_title；已有 show_title / 电影库 / 失败态不动
   D. 长会话内存治理：非当前库的重型缓存与阅读状态索引被释放，当前库保留
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
const GO_PLAYBACK = fs.readFileSync(ROOT + "/media-go/playback.go", "utf8");
const GO_MAIN = fs.readFileSync(ROOT + "/media-go/main.go", "utf8");
const GO_SCRAPE = fs.readFileSync(ROOT + "/media-go/scrape_store.go", "utf8");

(async () => {
  /* ================= A. 解/转码风向标 ================= */
  {
    const tfStub = (k, v) => (v && v.path !== undefined ? String(k) + "::" + String(v.path) : String(k));
    const mk = (policy) => load("web/js/02-media.js", {
      settings: { serverTranscode: policy, hardwareAcceleration: "auto" },
      t: k => "T:" + k, tf: tfStub,
    });

    const off = mk("off");
    chk("A1 禁用时 serverTranscodeDisabled() 为真", call(off, `serverTranscodeDisabled()`) === true);
    chk("A2 禁用时播放计划策略为 off", call(off, `serverTranscodePolicy()`) === "off");
    const auto = mk("auto");
    chk("A3 默认（auto）策略为 auto 且不视为禁用",
        call(auto, `serverTranscodePolicy()`) === "auto" && call(auto, `serverTranscodeDisabled()`) === false);
    const missing = load("web/js/02-media.js", { settings: {} });
    chk("A4 设置缺失时按 auto 处理（不误禁用）", call(missing, `serverTranscodeDisabled()`) === false);

    chk("A5 播放计划请求带上 server_transcode",
        /server_transcode:\s*serverTranscodePolicy\(\)/.test(MEDIA_SRC));

    chk("A6 客户端解码时模式标签为「本机设备解码 · 原画直放」",
        call(off, `playbackModeLabel({ mode: "direct", hardware: "client" })`).includes("本机设备解码"));
    chk("A7 服务端转码时标签仍为原画直放",
        call(off, `playbackModeLabel({ mode: "direct", hardware: "cuda" })`).includes("Direct Play"));

    /* 解码路径行写进「获取信息」面板的 [data-video-decode] 节点。 */
    const el = { textContent: "", classes: [], classList: { toggle(c, on) { el.classes.push([c, !!on]); } } };
    const root = { querySelector: sel => (sel === "[data-video-decode]" ? el : null) };
    off.__el = el; off.__root = root;
    call(off, `setVideoDecodePath(__root, "解码路径：本机设备解码")`);
    chk("A8 解码路径写进面板行并置 show", el.textContent.includes("本机设备解码") &&
        el.classes.some(([c, on]) => c === "show" && on === true), el.classes);
    call(off, `setVideoDecodePath(__root, "")`);
    chk("A9 清空时移除 show 类", el.classes.some(([c, on]) => c === "show" && on === false), el.classes);
    chk("A10 videoDecodePathText 用本机/服务端两种路径文案",
        call(off, `videoDecodePathText({ hardware: "client" })`).includes("stCompassClient") &&
        call(off, `videoDecodePathText({ hardware: "cuda" })`).includes("stCompassServer"));

    /* 源码级守卫：禁用时不允许切兼容流（否则服务器照样被拉去转码）。 */
    chk("A11 useCompat 在禁用时拒绝回退兼容流",
        /const useCompat = \(reason, url=compat\) => \{\s*\n\s*if \(serverTranscodeDisabled\(\)\)/.test(MEDIA_SRC) &&
        MEDIA_SRC.includes("已禁用服务端转/解码"));

    /* 后端：禁用时强制原画直连 + 单条目缓存上限 + 缓存用量暴露。 */
    chk("A12 后端接收 server_transcode 并强制原画直连",
        GO_PLAYBACK.includes('ServerTranscode string `json:"server_transcode"`') &&
        GO_PLAYBACK.includes("func forceClientDirectPlan(") &&
        GO_PLAYBACK.includes(`strings.EqualFold(req.ServerTranscode, "off")`) &&
        GO_PLAYBACK.includes(`plan.Hardware = "client"`));
    chk("A13 原盘镜像 + 禁用转码组合被如实拒绝（409）",
        /disc.Kind != discInputPlain \{\s*\n\s*errJSON\(w, http.StatusConflict/.test(GO_PLAYBACK) ||
        GO_PLAYBACK.includes("原盘镜像无法本地直接播放"));
    chk("A14 播放计划结构带 warn 字段（画质限制未生效等提醒）",
        GO_MAIN.includes('Warn string `json:"warn,omitempty"`') && GO_PLAYBACK.includes("plan.Warn ="));
    chk("A15 硬件探测返回核数与弱算力提示", GO_MAIN.includes(`"cores":         runtime.NumCPU()`) &&
        GO_MAIN.includes(`"weak_cpu":      selected == "cpu" && runtime.NumCPU() <= 4`));
    chk("A16 设置页有「服务端转/解码」选择项与风向标徽标",
        HTML_SRC.includes('id="serverTranscode"') && HTML_SRC.includes('id="transcodeCompass"') &&
        HTML_SRC.includes("saveServerTranscode()"));
    chk("A17 设置读写：默认 auto、载入校验、保存后刷新风向标",
        STATE_SRC.includes(`serverTranscode: "auto"`) &&
        STATE_SRC.includes(`if (["auto","off"].includes(s.serverTranscode))`) &&
        STATE_SRC.includes("function saveServerTranscode()") &&
        STATE_SRC.includes("function updateTranscodeCompass("));
    chk("A18 三语文案齐全（服务端转/解码 + 风向标 + 解码路径）",
        (STATE_SRC.match(/setSt:/g) || []).length === 3 &&
        (STATE_SRC.match(/stCompassFmt:/g) || []).length === 3 &&
        (STATE_SRC.match(/vpDecodePath:/g) || []).length === 3 &&
        (STATE_SRC.match(/stWeak:/g) || []).length === 3);
  }

  /* ================= B. 下滑自动翻页 ================= */
  {
    const dbg = { listeners: [], scrolls: [] };
    const hostEl = { offsetParent: {}, querySelector: () => null };
    const sb = load("web/js/02-media.js", {
      settings: { serverTranscode: "auto", reduceMotion: true },
      document: {
        getElementById: () => null,
        querySelector: sel => (sel === ".media-wide-host.show" ? hostEl : null),
        querySelectorAll: () => [],
        addEventListener: (ev, fn) => { dbg.listeners.push([ev, fn]); },
        createElement: () => ({}), body: { appendChild() {} },
        documentElement: { scrollHeight: 2000 },
      },
      window: {
        innerHeight: 800, scrollY: 1200, handlers: [],
        addEventListener(ev, fn) { this.handlers.push([ev, fn]); },
        scrollBy(o) { dbg.scrolls.push(["by", o.top]); },
        scrollTo(o) { dbg.scrolls.push(["to", o.top]); },
        isSecureContext: false,
      },
    });
    /* 1200 + 800 = 2000 >= 2000 - 160 → 到底 */
    chk("B1 到底判定（整页滚动）", call(sb, `mediaPagingEdge(mediaPagingHost()).atBottom`) === true);
    chk("B2 未到底时不翻页（scrollY=0）", (() => {
      call(sb, `window.scrollY = 0`);
      const at = call(sb, `mediaPagingEdge(mediaPagingHost()).atBottom`);
      call(sb, `window.scrollY = 1200`);
      return at === false;
    })());

    const more = [];
    call(sb, `bookShelfLoadMore = () => { globalThis.__more = (globalThis.__more || 0) + 1; }`);
    call(sb, `mediaPagingSet({ mode: "window", group: "comic", libId: "L1", offset: 0, pageSize: 20, hasMore: true }); mediaPagingState.at = 0;`);
    chk("B3 窗口模式下滑 → 调起「继续加载」并顺势滚动一屏",
        call(sb, `mediaAutoPage(1)`) === true &&
        call(sb, `__more || 0`) === 1 &&
        dbg.scrolls.some(([kind, top]) => kind === "by" && top >= 240), dbg.scrolls);

    chk("B4 冷却窗口内连续下滑不会连翻数页",
        call(sb, `mediaAutoPage(1)`) === false && call(sb, `__more || 0`) === 1);

    call(sb, `mediaPagingSet({ mode: "window", group: "comic", libId: "L1", offset: 0, pageSize: 20, hasMore: false }); mediaPagingState.at = 0;`);
    chk("B5 没有更多内容时不翻页（hasMore=false）", call(sb, `mediaAutoPage(1)`) === false);
    chk("B6 没有可翻模式时（未进库/整库已渲染）不翻页",
        call(sb, `mediaPagingReset(); mediaAutoPage(1)`) === false);

    /* offset 模式：音乐库 / 文件列表按 offset 取下一页。 */
    const calls = [];
    call(sb, `findMediaLibrary = (id) => ({ id: id, type: "audio" })`);
    call(sb, `loadLocalFiles = (group, lib, offset) => { globalThis.__pages = (globalThis.__pages || []); globalThis.__pages.push([group, lib.id, offset]); }`);
    call(sb, `mediaPagingSet({ mode: "offset", group: "audio", libId: "AU", offset: 500, pageSize: 500, hasMore: true }); mediaPagingState.at = 0;`);
    chk("B7 分页模式下滑 → 取下一页 offset(1000) 并回顶部",
        call(sb, `mediaAutoPage(1)`) === true &&
        JSON.stringify(call(sb, `__pages`)) === JSON.stringify([["audio", "AU", 1000]]) &&
        dbg.scrolls.some(([kind, top]) => kind === "to" && top === 0), call(sb, `__pages`));

    call(sb, `mediaPagingSet({ mode: "offset", group: "audio", libId: "AU", offset: 1000, pageSize: 500, hasMore: true }); mediaPagingState.at = 0;`);
    chk("B8 上滑 → 回上一页 offset(500)",
        call(sb, `mediaAutoPage(-1)`) === true &&
        JSON.stringify(call(sb, `__pages`)).includes('"AU",500'), call(sb, `__pages`));

    call(sb, `mediaPagingSet({ mode: "offset", group: "audio", libId: "AU", offset: 0, pageSize: 500, hasMore: true }); mediaPagingState.at = 0;`);
    chk("B9 首页时上滑不再回退（offset 已为 0）", call(sb, `mediaAutoPage(-1)`) === false);

    const before = dbg.listeners.length;
    call(sb, `installMediaScrollPaging()`);
    chk("B10 翻页监听器只注册一次（滚轮 + 键盘）",
        dbg.listeners.filter(([ev]) => ev === "wheel").length === 1 &&
        dbg.listeners.filter(([ev]) => ev === "keydown").length === 1 &&
        dbg.listeners.length === before, dbg.listeners.map(([ev]) => ev));

    chk("B11 键盘下滑键包含 PageDown/↓/空格，上滑键包含 PageUp/↑",
        /const downKeys = \["PageDown", "ArrowDown", " "\]/.test(MEDIA_SRC) &&
        /const upKeys = \["PageUp", "ArrowUp"\]/.test(MEDIA_SRC));
    chk("B12 不抢播放器/阅读器的键盘语义",
        MEDIA_SRC.includes(`target.closest("[data-video-panel]")`) &&
        MEDIA_SRC.includes('target.closest(".media-video-body")') &&
        MEDIA_SRC.includes('target.closest(".media-viewer-doc")'));
    chk("B13 书刊架与分页器都有「下滑自动翻页」提示",
        MEDIA_SRC.includes(`esc(t("pagerScrollHint"))`) &&
        /class="page-scroll-hint"/.test(MEDIA_SRC) && CSS_SRC.includes(".page-scroll-hint"));
    chk("B14 loadLocalFiles 登记 offset 模式、书刊架登记 window 模式",
        MEDIA_SRC.includes(`mediaPagingSet({ mode: "offset", group, libId: String(lib.id), offset, pageSize, hasMore: true })`) &&
        MEDIA_SRC.includes(`mediaPagingSet({ mode: more ? "window" : "", group: "comic"`));
  }

  /* ================= C. 刮削剧名修复 ================= */
  {
    const sb = load("web/js/02-media.js", { settings: {} });
    /* 真实库表由 02-media.js 自己维护（函数声明会遮蔽注入的同名函数），这里直接喂库表。 */
    call(sb, `localMediaLibraries = [{ id: "seriesLib", type: "series" }, { id: "movieLib", type: "movie" }]`);
    chk("C1 旧记录（只有 title）在剧集库补出剧名",
        call(sb, `repairSeriesShowTitle("seriesLib", { title: "康熙王朝", scrape_state: "ok" }).show_title`) === "康熙王朝");
    chk("C2 已有 show_title 不被覆盖",
        call(sb, `repairSeriesShowTitle("seriesLib", { title: "分集名", show_title: "康熙王朝" }).show_title`) === "康熙王朝");
    chk("C3 电影库不补（电影的一级标题就是 title）",
        call(sb, `repairSeriesShowTitle("movieLib", { title: "沙丘 2", scrape_state: "ok" }).show_title`) === undefined);
    chk("C4 失败 / 待确认态不补（避免把文件名当剧名）",
        call(sb, `repairSeriesShowTitle("seriesLib", { title: "某某", scrape_state: "failed" }).show_title`) === undefined);
    chk("C5 没有 title 时不动", call(sb, `repairSeriesShowTitle("seriesLib", { scrape_state: "ok" }).show_title`) === undefined);
    chk("C6 服务端刮削结果库字段白名单包含 show_title",
        /MOVIE_SCRAPE_STORE_FIELDS = \["title", "show_title"/.test(MEDIA_SRC));
    chk("C7 后端结果库结构体与清洗都保留 show_title",
        GO_SCRAPE.includes('ShowTitle string  `json:"show_title,omitempty"`') &&
        GO_SCRAPE.includes("ShowTitle: clipScrapeText(in.ShowTitle, scrapeCacheMaxTitle),") &&
        GO_SCRAPE.includes('it.Title == "" && it.ShowTitle == ""'));
    chk("C8 水合两条路径都调用剧名修复",
        (MEDIA_SRC.match(/repairSeriesShowTitle\(/g) || []).length >= 3);
  }

  /* ================= D. 长会话内存治理 ================= */
  {
    const sb = load("web/js/02-media.js", { settings: {} });
    call(sb, `localMediaSelection.comic = "L1";
              libraryIndexSession["L1"] = { at: 1, group: "comic", files: [1] };
              libraryIndexSession["L2"] = { at: 1, group: "comic", files: [2] };
              bookShelfIndexCache["L1"] = { at: 1, files: [1] };
              bookShelfIndexCache["L2"] = { at: 1, files: [2] };
              bookShelfCountsCache["L1"] = { shelf: 1 };
              bookShelfCountsCache["L2"] = { shelf: 2 };
              readingStateIndex["L1"] = { "a": {} };
              readingStateIndex["L2"] = { "b": {} };
              readingStateIndexBuilt["L1"] = true;
              readingStateIndexBuilt["L2"] = true;
              bookShelfVisibleCache = [1, 2, 3];`);
    const freed = call(sb, `releaseMediaHeavyCaches("L1")`);
    chk("D1 释放非当前库的重型缓存（索引 / 书架 / 统计）",
        call(sb, `!!libraryIndexSession["L2"]`) === false &&
        call(sb, `!!bookShelfIndexCache["L2"]`) === false &&
        call(sb, `!!bookShelfCountsCache["L2"]`) === false && freed >= 3, freed);
    chk("D2 当前库的缓存保留（不重新拉整库索引）",
        call(sb, `!!libraryIndexSession["L1"] && !!bookShelfIndexCache["L1"] && !!bookShelfCountsCache["L1"]`) === true);
    chk("D3 阅读状态索引同步释放（电子书库一个库 18.4 万条）",
        call(sb, `!!readingStateIndex["L2"]`) === false && call(sb, `!!readingStateIndexBuilt["L2"]`) === false &&
        call(sb, `!!readingStateIndex["L1"] && !!readingStateIndexBuilt["L1"]`) === true);
    chk("D4 非当前库时书架可见列表也清空",
        call(sb, `releaseMediaHeavyCaches("OTHER"); (bookShelfVisibleCache || []).length`) === 0);
    chk("D5 loadLocalFiles 进入库时先释放其它库缓存",
        /* v1.0.12（需求8）：实现体改名 loadLocalFilesInner，释放逻辑不变。 */
        /async function loadLocalFilesInner\(group, lib, offset = 0, token = 0\) \{\s*\n\s*const target = document\.getElementById\("local-media-content-" \+ group\);\s*\n\s*if \(!target\) return;\s*\n[\s\S]{0,300}releaseMediaHeavyCaches\(lib\.id\)/.test(MEDIA_SRC));
    chk("D6 后端转码缓存有兜底清理间隔与单条目上限",
        GO_MAIN.includes("cacheCleanupFallback = 10 * time.Minute") &&
        GO_MAIN.includes("cacheEntryMaxShare   = 4") &&
        GO_MAIN.includes("if interval > cacheCleanupFallback {") &&
        GO_MAIN.includes("budget/cacheEntryMaxShare"));
    chk("D7 缓存用量暴露给设置页（cache_bytes / cache_files / cache_cleaned_at）",
        GO_MAIN.includes(`"cache_bytes": a.cacheBytes`) &&
        GO_MAIN.includes(`"cache_files": a.cacheFiles`) &&
        GO_MAIN.includes(`"cache_cleaned_at": a.cacheCleanedAt`));
    chk("D8 清理会回收中断残留的 *.mp4.bg-<pid> 分片",
        GO_MAIN.includes('strings.Contains(name, ".mp4."') && GO_MAIN.includes("staleCutoff"));
    chk("D9 keepCount 语义生效：窗口扩张跳过整库统计重算",
        MEDIA_SRC.includes("(fresh || opts.preview) && opts.keepCount !== true"));
  }

  /* ================= E. 版本与审查项 ================= */
  {
    chk("E1 资源版本 本版（≥10 处）", (HTML_SRC.match(/\?v=1\.0\.12/g) || []).length >= 10);
    chk("E2 ASSET_VERSION / SCRIPT_VERSION = 0.9.97",
        HTML_SRC.includes('window.VAULTHUB_ASSET_VERSION = "1.0.12";') &&
        STATE_SRC.includes('const VAULTHUB_SCRIPT_VERSION = "1.0.12";'));
    /* 审查项：标语断言必须校验「三处完全一致」，而不是各自存在。 */
    const slogans = (HTML_SRC.match(/v\d+\.\d+\.\d+ · [^<"]+/g) || []);
    chk("E3 三处标语完全一致（审查项：断言强度）",
        slogans.length === 3 && new Set(slogans).size === 1, [...new Set(slogans)]);
    chk("E4 面板提示行重置旧胶囊底色（审查项：CSS 药丸）",
        /\.video-status-panel \.status-compat \{[\s\S]{0,240}background:none; padding:0; border-radius:0;/.test(CSS_SRC));
    chk("E5 解码路径行有自己的样式",
        CSS_SRC.includes(".video-status-panel .status-decode") && CSS_SRC.includes(".video-status-panel .status-decode.show"));
  }

  /* ================= F. v0.9.91 独立审查修复项 ================= */
  {
    /* F1-F4：剧名修复不得把「分集名」提升成剧名（审查复现用例）。 */
    const sb = load("web/js/02-media.js", { settings: {} });
    call(sb, `localMediaLibraries = [{ id: "seriesLib", type: "series" }]`);
    const epPath = "/ATV2/康熙王朝 Kang Xi Kingdom/Season 01/康熙王朝 Kang Xi Kingdom S01E01 2024.mkv";
    chk("F1 分集名（2024）不得被当成剧名提升",
        call(sb, `repairSeriesShowTitle("seriesLib", { title: "2024", scrape_state: "ok" }, ${JSON.stringify(epPath)}).show_title`) === undefined);
    chk("F2 与文件名解析剧名相同的 title 不重复补",
        call(sb, `repairSeriesShowTitle("seriesLib", { title: "康熙王朝 Kang Xi Kingdom", scrape_state: "ok" }, ${JSON.stringify(epPath)}).show_title`) === undefined);
    chk("F3 真正的刮削剧名（文件名里没有）仍会被补出",
        call(sb, `repairSeriesShowTitle("seriesLib", { title: "康熙王朝", scrape_state: "ok" }, ${JSON.stringify(epPath)}).show_title`) === "康熙王朝");
    chk("F4 调用点把 path 传入剧名修复（两处）",
        (MEDIA_SRC.match(/repairSeriesShowTitle\([^)]*,\s*path\)/g) || []).length >= 2 ||
        (MEDIA_SRC.includes("repairSeriesShowTitle(libId, merged, path)") && MEDIA_SRC.includes("repairSeriesShowTitle(lib?.id, all[path], path)")));

    /* F5-F7：禁用服务端转码时「画质上限不生效」必须常驻可见（审查发现只 toast 一次）。 */
    const off = load("web/js/02-media.js", { settings: { serverTranscode: "off" } });
    const on = load("web/js/02-media.js", { settings: { serverTranscode: "auto" } });
    chk("F5 禁用时解码路径行包含「画质上限不生效」",
        String(call(off, `videoDecodePathText({ hardware: "client" })`)).includes("vpCapOff"));
    chk("F6 未禁用时不加该标注", !String(call(on, `videoDecodePathText({ hardware: "client" })`)).includes("vpCapOff"));
    chk("F7 服务端解码（hardware=server）不加该标注",
        !String(call(off, `videoDecodePathText({ hardware: "cpu" })`)).includes("vpCapOff"));
    chk("F8 画质控件有「不生效」标记函数与两处调用",
        MEDIA_SRC.includes("function markQualityCapInactive(") &&
        (MEDIA_SRC.match(/markQualityCapInactive\(/g) || []).length >= 3);
    chk("F9 不生效的画质按钮有对应样式",
        CSS_SRC.includes(".video-quality-options.cap-inactive button[data-quality]") &&
        CSS_SRC.includes('.video-quality-options.cap-inactive button[data-quality].active'));
    chk("F10 三语都有 vpCapOff",
        (STATE_SRC.match(/vpCapOff:/g) || []).length === 3);

    /* F11-F13：缓存清理阈值（审查发现：分片陈旧阈值必须长于构建上限；单条目阈值不能退化成 0）。 */
    chk("F11 构建超时抽成常量并被 cleanCache/构建共用",
        GO_MAIN.includes("compatBuildTimeout = 6 * time.Hour") &&
        GO_MAIN.includes("context.WithTimeout(context.Background(), compatBuildTimeout)"));
    chk("F12 分片陈旧阈值取「构建上限 + 缓冲」，不再是固定 2 小时",
        /staleCutoff := now\.Add\(-\(compatBuildTimeout \+ 30\*time\.Minute\)\)/.test(GO_MAIN) &&
        !GO_MAIN.includes("staleCutoff := now.Add(-2 * time.Hour)"));
    chk("F13 单条目阈值抽成共用函数且配额过小时返回 0（不做限制）",
        GO_MAIN.includes("func cacheEntryLimit(budget int64) int64") &&
        GO_MAIN.includes("entryMax := cacheEntryLimit(cacheMaxBytes)") &&
        GO_MAIN.includes("if limit := cacheEntryLimit(budget); limit > 0") &&
        !GO_MAIN.includes("info.Size() > budget/cacheEntryMaxShare") &&
        !GO_MAIN.includes("entryMax = cacheMaxBytes / cacheEntryMaxShare"));
  }

  console.log(`\nSUMMARY pass=${passed} fail=${failed}`);
  process.exit(failed ? 1 : 0);
})();
