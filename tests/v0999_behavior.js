/* v0.9.99 行为测试（Node VM 桩，真实执行 web/js/02-media.js）：
 *
 *   A. 季度标题作为「该季首条目的前缀」（需求4）：不再有独立标题行、前缀只出现一次、
 *      折叠只作用于首条之外的集、切换能真正显隐
 *   B. 图形字幕（需求2）：字幕条目分流（文本 / 烧录）、烧录 URL 拼接、选择记忆、
 *      「搜索并挂载」把内嵌轨与本地文件一起列出、空结果不再静默
 *   C. 本地 NFO 演职人员与推荐（需求1）：本地优先合并、推荐去重补位、本地库同类推荐
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
    seriesPlexSeasonLabel: n => `第 ${n} 季`,
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

(async () => {
  /* ================= A. 季度标题作为首条目前缀 ================= */
  {
    const sb = loadMedia({});
    sb.__lib = { id: "series-1", type: "series", name: "动画" };
    sb.__show = {
      title: "东京喰种", poster: "/p.jpg", fanart: "/f.jpg",
      seasonList: [
        { season: 1, name: "第一季", overview: "季简介一", episodes: [{ path: "Show/Season 1/S01E01.mkv" }, { path: "Show/Season 1/S01E02.mkv" }] },
        { season: 2, name: "第二季", overview: "", episodes: [{ path: "Show/Season 2/S02E01.mkv" }, { path: "Show/Season 2/S02E02.mkv" }] },
        { season: 3, name: "特别篇", overview: "", episodes: [{ path: "Show/Specials/S00E01.mkv" }] },
      ],
    };
    sb.__season = sb.__show.seasonList[0];
    sb.__season2 = sb.__show.seasonList[1];
    const first = call(sb, "renderSeriesSeasonCard(__lib, __show, __season)");
    const second = call(sb, "renderSeriesSeasonCard(__lib, __show, __season2)");

    chk("A1 季度标题不再是独立一行（无 series-season-head）", first.indexOf("series-season-head") < 0, first.slice(0, 120));
    chk("A2 季度标题作为首条目前缀存在", first.indexOf("series-season-prefix") >= 0 && first.indexOf("series-season-toggle") >= 0);
    chk("A3 前缀在组内只出现一次（最上层）",
      (first.match(/series-season-prefix/g) || []).length === 1
      && (first.match(/series-season-toggle/g) || []).length === 1, (first.match(/series-season-prefix/g) || []).length);
    chk("A4 首条目的行标上 is-season-top，其余行没有",
      (first.match(/is-season-top/g) || []).length === 1);
    chk("A5 前缀带上季名与集数", first.indexOf("第一季") >= 0 && first.indexOf("共2集") >= 0);
    chk("A6 折叠容器只包住首条之外的集（series-episode-list-rest）",
      (first.match(/series-episode-list-rest/g) || []).length === 1 && first.indexOf("S01E01") >= 0);
    chk("A7 首季默认展开、其余折叠",
      first.indexOf("is-collapsed") < 0 && second.indexOf("is-collapsed") >= 0 && second.indexOf("display:none") >= 0);
    chk("A8 单集季度不产生折叠容器（前缀仍在该条上）",
      (call(sb, "renderSeriesSeasonCard(__lib, __show, __show.seasonList[2])").match(/series-episode-list-rest/g) || []).length === 0
      && call(sb, "renderSeriesSeasonCard(__lib, __show, __show.seasonList[2])").indexOf("series-season-prefix") >= 0);
    chk("A9 前缀落在首条目内部（首条之后、第二条之前）",
      first.indexOf("S01E01") < first.indexOf("series-season-prefix")
      && first.indexOf("series-season-prefix") < first.indexOf("S01E02"));

    // 折叠按钮真实切换
    const listEl = fakeEl({ classes: ["series-episode-list-rest"] });
    const chev = fakeEl(); chev.textContent = "▾";
    const btn = fakeEl({
      closest: () => ({ querySelector: sel => (sel.indexOf("series-episode-list-rest") >= 0 ? listEl : null) }),
      querySelector: sel => (sel.indexOf("series-season-chev") >= 0 ? chev : null),
    });
    sb.__btn = btn;
    call(sb, "toggleSeriesSeason(__btn)");
    const collapsedNow = listEl.classList.contains("is-collapsed") && listEl.style.display === "none" && chev.textContent === "▸";
    call(sb, "toggleSeriesSeason(__btn)");
    const openedNow = !listEl.classList.contains("is-collapsed") && listEl.style.display === "" && chev.textContent === "▾";
    chk("A10 点击前缀折叠/展开只针对首条之外的集", collapsedNow && openedNow,
      { collapsedNow, openedNow, display: listEl.style.display, chev: chev.textContent });
  }

  /* ================= B. 图形字幕（文本 / 烧录分流） ================= */
  {
    const sb = loadMedia({});
    const bitmap = call(sb, "subtitleButtonHTML({label:'内嵌字幕 1 · jpn', kind:'bitmap', burn_track:4}, 0)");
    const text = call(sb, "subtitleButtonHTML({label:'中文 · chi', kind:'text', text:true, url:'/api/media/subtitles/extract?id=l&track=2'}, 1)");
    chk("B1 图形字幕渲染成烧录按钮", bitmap.indexOf("is-bitmap") >= 0 && bitmap.indexOf("selectVideoBurnInSubtitle") >= 0 && bitmap.indexOf('data-sub-track="4"') >= 0, bitmap);
    chk("B2 文本字幕渲染成挂载按钮", text.indexOf("is-text") >= 0 && text.indexOf("attachVideoSubtitle") >= 0, text);
    chk("B3 文本字幕 URL 原样进入按钮", text.indexOf("/api/media/subtitles/extract?id=l&track=2") >= 0);
    chk("B4 没有 kind 字段的旧服务端按文本处理",
      call(sb, "subtitleButtonHTML({label:'老服务端', url:'/x.vtt'}, 0)").indexOf("attachVideoSubtitle") >= 0);
    chk("B5 text:false 视为图形字幕",
      call(sb, "subtitleButtonHTML({label:'位图', text:false, index:7}, 0)").indexOf("selectVideoBurnInSubtitle") >= 0);

    chk("B6 烧录 URL 带 mode=full_transcode 与 sub_track",
      (() => {
        sb.__lib = { id: "lib1" };
        const u = call(sb, "videoTrackCompatUrl(__lib, '/MO/a.mkv', { sub: 4 })");
        return u.indexOf("mode=full_transcode") >= 0 && u.indexOf("sub_track=4") >= 0 && u.indexOf("/api/media/compat?") >= 0;
      })(), call(sb, "videoTrackCompatUrl({id:'lib1'}, '/MO/a.mkv', { sub: 4 })"));
    chk("B7 烧录 + 音轨可同时带上",
      (() => {
        const u = call(sb, "videoTrackCompatUrl({id:'lib1'}, '/MO/a.mkv', { sub: 4, audio: 1 })");
        return u.indexOf("sub_track=4") >= 0 && u.indexOf("audio_track=1") >= 0;
      })());
    chk("B8 不烧录时不带 sub_track",
      call(sb, "videoTrackCompatUrl({id:'lib1'}, '/MO/a.mkv', { sub: -1 })").indexOf("sub_track") < 0);

    chk("B9 图形字幕选择被记住、可清除", (() => {
      call(sb, "rememberVideoBurnSub('lib1', '/MO/a.mkv', 4, '内嵌字幕 1')");
      const got = call(sb, "videoBurnSubOf('lib1', '/MO/a.mkv')");
      call(sb, "rememberVideoBurnSub('lib1', '/MO/a.mkv', -1, '')");
      const cleared = call(sb, "videoBurnSubOf('lib1', '/MO/a.mkv')");
      const other = call(sb, "videoBurnSubOf('lib1', '/MO/别的.mkv')");
      return got && got.track === 4 && got.label === "内嵌字幕 1" && cleared === null && other === null;
    })());

    // 切音轨时保留烧录
    chk("B10 切音轨时保留图形字幕烧录", (() => {
      const sb2 = loadMedia({});
      call(sb2, "rememberVideoBurnSub('lib1', '/MO/a.mkv', 4, 'x')");
      const rootEl = fakeEl({ dataset: { library: "lib1", path: "/MO/a.mkv" } });
      const video = fakeEl({ dataset: {} });
      rootEl.querySelector = sel => (sel.indexOf("video") >= 0 ? video : fakeEl());
      rootEl.closest = () => rootEl;
      video.closest = () => rootEl;
      sb2.__root = rootEl; sb2.__video = video;
      call(sb2, "selectVideoAudioTrack(__video, 2)");
      return String(video.src).indexOf("audio_track=2") >= 0 && String(video.src).indexOf("sub_track=4") >= 0 && String(video.src).indexOf("mode=full_transcode") >= 0;
    })(), (() => null)());

    // 「搜索并挂载」：内嵌轨 + 本地文件一起列出；空结果给出明确提示
    const sb3 = loadMedia({
      fetch: async () => ({
        ok: true, status: 200,
        json: async () => ({ items: [
          { label: "内嵌 · 字幕 1 · 中文 · chi", kind: "text", text: true, url: "/api/media/subtitles/extract?id=l&track=0" },
          { label: "内嵌 · 字幕 2 · eng", kind: "bitmap", burn_in: true, burn_track: 1 },
          { label: "本地 · Show.S01E01.zh.srt", kind: "text", text: true, url: "/api/media/subtitles/proxy?id=l&path=x.srt" },
        ], count: 3 }),
      }),
    });
    const box = fakeEl();
    const rootEl = fakeEl({ dataset: { library: "lib1", path: "/MO/a.mkv" } });
    rootEl.querySelector = sel => (sel.indexOf("subtitle-options") >= 0 ? box : fakeEl());
    rootEl.closest = () => rootEl;
    const btn = fakeEl({ closest: () => rootEl });
    sb3.__b = btn;
    await vm.runInContext("searchVideoSubtitles(__b)", sb3);
    chk("B11 搜索结果含内嵌文本轨、图形烧录轨与本地文件",
      box.innerHTML.indexOf("attachVideoSubtitle") >= 0 && box.innerHTML.indexOf("selectVideoBurnInSubtitle") >= 0
      && box.innerHTML.indexOf("本地 · Show.S01E01.zh.srt") >= 0 && box.innerHTML.indexOf("is-off") >= 0, box.innerHTML.slice(0, 200));

    const sb4 = loadMedia({ fetch: async () => ({ ok: true, status: 200, json: async () => ({ items: [], count: 0 }) }) });
    const box4 = fakeEl();
    const root4 = fakeEl(); root4.querySelector = sel => (sel.indexOf("subtitle-options") >= 0 ? box4 : fakeEl()); root4.closest = () => root4;
    sb4.__b = fakeEl({ closest: () => root4 });
    await vm.runInContext("searchVideoSubtitles(__b)", sb4);
    chk("B12 空结果给出明确文案（不再是空白面板）", box4.textContent.indexOf("没有找到字幕") >= 0, box4.textContent);
  }

  /* ================= C. 演职人员合并与推荐补位 ================= */
  {
    const sb = loadMedia({});
    chk("C1 本地 NFO 演职人员优先，TMDB 只补本地没有的人", (() => {
      const out = call(sb, `mergeCastKeepLocal(
        [{name:'花江夏树', character:'金木研', avatar:'/api/media/cast/avatar?person=%2F9g.jpg'}],
        [{name:'花江夏树', character:'Ken Kaneki', profile_path:'/9g.jpg'},{name:'雨宫天', character:'雾岛董香', profile_path:'/aq.jpg'}])`);
      return out.length === 2 && out[0].name === "花江夏树" && out[0].character === "金木研"
        && out[0].avatar === "/api/media/cast/avatar?person=%2F9g.jpg" && out[0].from_nfo === true
        && out[1].name === "雨宫天" && out[1].profile_path === "/aq.jpg";
    })());
    chk("C2 姓名为空/重复的条目被剔除", (() => {
      const out = call(sb, "mergeCastKeepLocal([{name:'A'},{name:' '}],[{name:'a'},{name:'B'}])");
      return out.length === 2 && out[0].name === "A" && out[1].name === "B";
    })());
    chk("C3 推荐合并按标题去重（TMDB 在前）", (() => {
      const out = call(sb, "fillRecommendations([{title:'Alpha'}],[{title:'alpha'},{title:'Beta'}])");
      return out.length === 2 && out[0].title === "Alpha" && out[1].title === "Beta";
    })());

    // 本地库同类推荐：同类型 +3、共同演职人员 +2；排除自己与同剧其它集
    const sb2 = loadMedia({});
    sb2.__metaStore = {
      "/MO/A/movie.mkv": { title: "同类型片", genres: ["动画"], rating: 7.0 },
      "/MO/B/movie.mkv": { title: "同演员片", cast: [{ name: "花江夏树" }], rating: 6.0 },
      "/MO/C/movie.mkv": { title: "毫不相干", genres: ["纪录"], rating: 9.9 },
      "/ATV/Show/Season 1/S01E01.mkv": { title: "同剧其它集", show_title: "东京喰种", genres: ["动画"] },
      "/MO/SELF/movie.mkv": { title: "本片", genres: ["动画"] },
    };
    call(sb2, "movieMetadataMemory = __metaStore");
    const recs = call(sb2, `localRecommendationItems({ title:'本片', genres:['动画'], cast:[{name:'花江夏树'}], show_title:'东京喰种' }, { id:'lib1', type:'movie' })`);
    const titles = recs.map(r => r.title);
    chk("C4 本地同类推荐命中同类型/同演员，排除不相干与同剧",
      titles.indexOf("同类型片") >= 0 && titles.indexOf("同演员片") >= 0 && titles.indexOf("毫不相干") < 0 && titles.indexOf("同剧其它集") < 0, titles);
    chk("C5 同类型+同演员排在前面（得分优先）", titles[0] !== "同演员片" || titles.length <= 1 ? titles[0] === "同类型片" : true, titles);
    chk("C6 推荐项带本地路径（可直接播放）", recs.every(r => r.local && r.local.path && r.local.path.length > 1));
    chk("C7 无匹配时返回空数组而不是抛错",
      call(sb2, "localRecommendationItems({ title:'孤片', genres:['不存在类型'], cast:[] }, { id:'lib1' })").length === 0);
  }

  console.log(`\n===== v0.9.99 行为测试：通过 ${passed} / 失败 ${failed} =====`);
  process.exit(failed ? 1 : 0);
})();
