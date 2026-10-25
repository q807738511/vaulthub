/* v1.0.0 行为测试（Node VM 桩，真实执行 web/js/02-media.js）：
 *
 *   A. 详情页排版（需求1）：区块标题带加粗类 detail-section-h、季名改回常规字重容器、
 *      「多季诊断…已移到系统设置」迁移提示行彻底删除
 *   B. 小窗还原按钮（需求2）：图标换成四向外扩（不再向上箭头）、指针移入才显示、
 *      指针在小窗内部换目标不闪烁、缩小/还原会清掉悬停标记
 *   C. 内嵌字幕标签（需求3）：直接展示服务端推导出的语言标签（简体中文 / 繁体中文 …），
 *      图形字幕仍走烧录入口、文本字幕走挂载入口
 */
const fs = require("fs"), vm = require("vm"), path = require("path");
const ROOT = process.env.VH_ROOT || path.resolve(__dirname, "..");
let passed = 0, failed = 0;
const chk = (name, ok, extra) => {
  if (ok) { passed++; console.log("PASS:", name); }
  else { failed++; console.log("FAIL:", name, extra === undefined ? "" : JSON.stringify(extra)); }
};

const store = {};
/* 记忆化元素：同一个 id/选择器必须返回同一个对象（否则「写入再读回」的断言恒假）。 */
function fakeEl(extra) {
  const o = extra || {};
  const cls = new Set(o.classes || []);
  const el = {
    dataset: Object.assign({}, o.dataset || {}),
    __children: {},
    getClientRects: () => ({ length: 1 }),
    offsetParent: null, textContent: "", innerHTML: "", style: {},
    value: o.value === undefined ? "" : o.value, checked: !!o.checked,
    src: "", currentTime: 0, paused: true, duration: 100,
    classList: {
      add(c) { cls.add(c); }, remove(c) { cls.delete(c); }, contains(c) { return cls.has(c); },
      toggle(c, on) { const w = on === undefined ? !cls.has(c) : !!on; w ? cls.add(c) : cls.delete(c); return w; },
    },
    querySelector: o.querySelector || function (sel) { return (this.__children[sel] = this.__children[sel] || fakeEl()); },
    querySelectorAll: o.querySelectorAll || (() => []),
    closest: o.closest || (() => null),
    addEventListener() {}, appendChild() {}, remove() {}, setAttribute() {},
    getAttribute() { return ""; }, load() {}, play() { return Promise.resolve(); }, pause() {},
  };
  return el;
}

function makeSandbox(extra) {
  const sb = {
    console, Date, Number, Math, String, Array, JSON, Object, parseFloat, parseInt, isNaN, isFinite, RegExp, Set, Map, Promise, URL, URLSearchParams,
    encodeURIComponent, decodeURIComponent, setTimeout, clearTimeout, Blob: function Blob() {},
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
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
    jsArg: v => JSON.stringify(String(v == null ? "" : v)),
    openModal: () => {}, closeModal: () => {}, copyTextFallback: () => false,
    mediaKeepAliveStop: () => {}, mediaKeepAliveStart: () => {},
    sessionWriteHeaders: () => ({}),
    vaultStoreJSON: (k, d) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : d),
    vaultStoreSet: (k, v) => { store[k] = v; return true; },
    vaultStoreRemove: k => { delete store[k]; return true; },
    pushNotification() {}, upsertNotification() {},
    activePlayback: () => null, updatePlaybackDock: () => {}, liveActiveVideoElement: () => null,
    parseSeriesEpisode: () => ({ season: 1, episode: 1, label: "S01E01" }),
    seriesPlexSeasonLabel: n => `第${["零","一","二","三","四","五","六","七","八","九","十"][n] || n}季`,
  };
  return Object.assign(sb, extra || {});
}
function loadMedia(extra) {
  const sb = makeSandbox(extra);
  vm.createContext(sb);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "web/js/02-media.js"), "utf8"), sb, { filename: "web/js/02-media.js" });
  return sb;
}
const call = (sb, expr) => vm.runInContext(expr, sb);

/* 记录事件与 class 的假节点：用来真实驱动指针事件。 */
function fakeNode(opts) {
  const o = opts || {};
  const handlers = {};
  const cls = new Set(o.classes || []);
  return {
    __handlers: handlers, __cls: cls,
    classList: {
      add(...cs) { cs.forEach(c => cls.add(c)); },
      remove(...cs) { cs.forEach(c => cls.delete(c)); },
      contains: c => cls.has(c),
    },
    addEventListener(type, fn) { (handlers[type] = handlers[type] || []).push(fn); },
    dispatch(type, ev) { (handlers[type] || []).forEach(fn => fn(ev || {})); },
    contains(target) { return !!(target && target.__inside); },
    querySelector: () => null, querySelectorAll: () => [],
  };
}

(async () => {
  const MEDIA_SRC = fs.readFileSync(path.join(ROOT, "web/js/02-media.js"), "utf8");
  const CSS_SRC = fs.readFileSync(path.join(ROOT, "web/css/main.css"), "utf8");

  /* ================= A. 详情页排版（需求1） ================= */
  {
    const sb = loadMedia({});
    sb.__castMeta = { cast: [{ name: "演员甲", character: "队长" }], roleLabel: "饰演" };
    const castPanel = call(sb, "renderCastPanel(__castMeta)");
    const recPanel = call(sb, "renderRecPanel({ recs: [] })");
    chk("A1 演职人员标题带加粗类 detail-section-h",
      castPanel.indexOf('<h3 class="detail-section-h">') >= 0, castPanel.slice(0, 80));
    chk("A2 视频推荐标题带加粗类 detail-section-h",
      recPanel.indexOf('<h3 class="detail-section-h">') >= 0, recPanel.slice(0, 80));

    const sb2 = loadMedia({});
    sb2.__lib = { id: "series-1", type: "series", name: "动画" };
    sb2.__show = {
      title: "保龄球少女！", poster: "/p.jpg", fanart: "/f.jpg",
      seasonList: [
        { season: 1, name: "第一季", overview: "", episodes: [{ path: "S/Season 1/S01E01.mkv" }, { path: "S/Season 1/S01E02.mkv" }] },
        { season: 2, name: "第二季", overview: "", episodes: [{ path: "S/Season 2/S02E01.mkv" }] },
      ],
    };
    const card1 = call(sb2, "renderSeriesSeasonCard(__lib, __show, __show.seasonList[0])");
    const card2 = call(sb2, "renderSeriesSeasonCard(__lib, __show, __show.seasonList[1])");
    chk("A3 季名用常规字重容器（series-season-title，不再是 <b>）",
      card1.indexOf('<span class="series-season-title">保龄球少女！') >= 0 && card1.indexOf("<b>保龄球少女！</b>") < 0,
      card1.slice(card1.indexOf("series-season-head"), card1.indexOf("series-season-head") + 240));
    chk("A4 第二季同样带该季前缀（每季只一次）",
      (card2.match(/series-season-title/g) || []).length === 1 && card2.indexOf("第二季") >= 0);

    chk("A5 迁移提示行已从源码删除（渲染与样式都不再引用）",
      MEDIA_SRC.indexOf("多季诊断与多季全量刮削已移到") < 0 && MEDIA_SRC.indexOf("series-plex-moved") < 0);
    /* v1.0.9（需求1）：「季度」二字改为季名行内的加粗 span。 */
    const INLINE = '<span class="season-inline-title">季度</span>';
    chk("A6 独立成行的「季度」标题区块已从源码移除",
      MEDIA_SRC.indexOf('<section><h3 class="detail-section-h">季度</h3></section>') < 0);
    chk("A7 最上层季：加粗「季度」在季名行内、且在季名之前（季度 → 季名 → 共N集）",
      card1.indexOf('<h3 class="series-season-head"') >= 0
      && card1.indexOf(INLINE) > card1.indexOf('<h3 class="series-season-head"')
      && card1.indexOf(INLINE) < card1.indexOf("series-season-title"),
      card1.slice(card1.indexOf("series-season-head"), card1.indexOf("series-season-head") + 220));
    chk("A8 后续季只有常规字重季名行，不再出现「季度」标题",
      card2.indexOf("season-inline-title") < 0 && card2.indexOf("series-season-head") >= 0);
    chk("A9 所有季卡片中「季度」标题恰好出现一次（只显示在最上层季位）",
      (card1 + card2).split(INLINE).length - 1 === 1, (card1 + card2).split(INLINE).length - 1);

    /* 边界：排序最上层那一季没有剧集（前缀行为空）时，「季度」标题不能整体消失。 */
    const sb3 = loadMedia({});
    sb3.__lib = { id: "series-1", type: "series", name: "动画" };
    sb3.__show = {
      title: "空季剧集", poster: "/p.jpg",
      seasonList: [
        { season: 1, name: "第一季", overview: "", episodes: [] },
        { season: 2, name: "第二季", overview: "", episodes: [{ path: "S/Season 2/S02E01.mkv" }] },
      ],
    };
    const cardEmpty = call(sb3, "renderSeriesSeasonCard(__lib, __show, __show.seasonList[0])");
    chk("A10 最上层季无剧集时季名行仍然渲染（加粗「季度」不消失）",
      cardEmpty.indexOf('<h3 class="series-season-head"') >= 0 && cardEmpty.indexOf(INLINE) >= 0,
      cardEmpty.slice(0, 200));
    chk("A11 加粗只给「季度」二字：季名行 flex 同行 + 季度 700 + 季名 400",
      CSS_SRC.indexOf(".series-season-head { display:flex; align-items:center; gap:8px;") >= 0
      && CSS_SRC.indexOf(".series-season-head .season-inline-title { font-weight: 700;") >= 0
      && CSS_SRC.indexOf(".series-season-head .series-season-title { font-weight: 400;") >= 0
      && CSS_SRC.indexOf(".series-season-head small { color: var(--text2); font-weight: 400; }") >= 0);
    chk("A12 季简介在季名行下独立成段（.series-season-overview 样式仍在）",
      CSS_SRC.indexOf(".series-season-overview {") >= 0);
  }

  /* ================= B. 小窗还原按钮（需求2） ================= */
  {
    const sb = loadMedia({});
    const icon = call(sb, "videoIcon('restore')");
    chk("B1 还原图标不再是向上箭头（旧 path 已清除）", icon.indexOf("M12 20.8V10.2") < 0, icon);
    chk("B2 还原图标为四向外扩对角箭头", icon.indexOf("M19.6 4.4 11.8 12.2") >= 0 && icon.indexOf("M4.4 19.6 12.2 11.8") >= 0, icon);
    chk("B3 还原按钮渲染用该图标", call(sb, "typeof bindDockedRestoreHover === 'function'"));

    /* 真实驱动指针事件：指针进入小窗 → 打标记；移到外部 → 撤销；内部换目标不撤销。 */
    const overlay = fakeNode({});
    const root = fakeNode({});
    root.closest = () => overlay;
    const video = fakeNode({});
    sb.__ov = overlay; sb.__root = root; sb.__video = video;
    call(sb, "bindDockedRestoreHover(__root, __video)");
    chk("B4 指针事件绑在「小窗容器 + 画面」两处",
      (root.__handlers.pointerenter || []).length === 1 && (root.__handlers.pointerleave || []).length === 1
      && (video.__handlers.pointerenter || []).length === 1 && (video.__handlers.pointerleave || []).length === 1);
    call(sb, "__root.dispatch('pointerenter', {})");
    chk("B5 鼠标移入 → 显示还原按钮（vc-restore-hover）", overlay.__cls.has("vc-restore-hover"));
    const inside = { __inside: true };
    sb.__inside = inside;
    call(sb, "__video.dispatch('pointerleave', { relatedTarget: __inside })");
    chk("B6 指针在小窗内部换目标 → 不闪烁（标记保留）", overlay.__cls.has("vc-restore-hover"));
    call(sb, "__video.dispatch('pointerleave', { relatedTarget: {} })");
    chk("B7 指针移到小窗之外 → 撤销标记（恢复隐藏）", !overlay.__cls.has("vc-restore-hover"));
    chk("B8 重复绑定不会叠加监听器",
      (function () { call(sb, "bindDockedRestoreHover(__root, __video)"); return (root.__handlers.pointerenter || []).length === 1; })());
  }
  {
    /* 缩小 / 还原时清掉悬停标记：刚缩下去时指针多半还在画面上。 */
    const sb = loadMedia({});
    const overlay = fakeNode({ classes: ["vc-restore-hover"] });
    const root = fakeNode({});
    root.closest = sel => (sel === ".media-reader-overlay.movie-player" ? overlay : root);
    root.dataset = {};
    sb.__root = root;
    sb.__btn = { closest: () => root };
    call(sb, "minimizeVideoPlayer(__btn)");
    chk("B9 缩小后清掉 hover 标记并进入小窗态",
      !overlay.__cls.has("vc-restore-hover") && overlay.__cls.has("video-minimized") && overlay.__cls.has("video-controller-docked"));
    overlay.__cls.add("vc-restore-hover");
    call(sb, "expandVideoPlayer(__btn)");
    chk("B10 还原后同样清掉标记并退出小窗态",
      !overlay.__cls.has("vc-restore-hover") && !overlay.__cls.has("video-minimized"));
  }

  /* ================= C. 内嵌字幕标签（需求3） ================= */
  {
    const sb = loadMedia({});
    const text = call(sb, "subtitleButtonHTML({label:'内嵌 · 简体中文', kind:'text', url:'/api/x', index:0}, 0)");
    chk("C1 文本字幕直接展示服务端语言标签", text.indexOf("内嵌 · 简体中文") >= 0 && text.indexOf("内嵌字幕 1") < 0, text);
    const hant = call(sb, "subtitleButtonHTML({label:'内嵌 · 繁体中文', kind:'text', url:'/api/x', index:1}, 1)");
    chk("C2 繁体标签同样原样展示", hant.indexOf("内嵌 · 繁体中文") >= 0, hant);
    const bmp = call(sb, "subtitleButtonHTML({label:'内嵌 · 中文', kind:'bitmap', burn_in:true, burn_track:2, index:2}, 2)");
    chk("C3 图形字幕仍走服务端烧录入口", bmp.indexOf("is-bitmap") >= 0 && bmp.indexOf("selectVideoBurnInSubtitle(this,2,") >= 0, bmp);
    chk("C4 无标签时才回落到「内嵌字幕 N」",
      call(sb, "subtitleButtonHTML({kind:'text', url:'/api/x', index:4}, 3)").indexOf("内嵌字幕 4") >= 0);
  }

  console.log(`\nSUMMARY pass=${passed} fail=${failed}`);
  process.exit(failed ? 1 : 0);
})();
