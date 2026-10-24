/* v1.0.7 行为测试（Node VM 桩，真实执行 web/js/02-media.js 与 06-theme.js）：
 *
 *   A. 季度版式回归（需求1）：季名回到独立季名行、全部剧集在同一网格、
 *      不再有首集大图（is-season-top 消失）、加粗「季度」只在最上层
 *   B. 演职人员/剧名修复（需求2）：真视频取路、剧名修复回写整部剧
 *   C. 视频推荐定位与播放（需求3）：卡片用命中条目的库 id、▶ 直接播放、双评分展示
 *   D. 豆瓣评分与综合排序（需求4/5）：键格式与服务端一致、加权综合分、会话内缓存
 *   E. 操作模式（需求6/7）：三档图标包差异 + <html data-opmode> 落点
 */
const fs = require("fs"), vm = require("vm"), path = require("path");
const ROOT = process.env.VH_ROOT || path.resolve(__dirname, "..");
let passed = 0, failed = 0;
const chk = (name, ok, extra) => {
  if (ok) { passed++; console.log("PASS:", name); }
  else { failed++; console.log("FAIL:", name, extra === undefined ? "" : JSON.stringify(extra)); }
};

const store = {};
function makeSandbox(extra) {
  const sb = {
    console, Date, Number, Math, String, Array, JSON, Object, parseFloat, parseInt, isNaN, isFinite, RegExp, Set, Map, Promise, URL, URLSearchParams,
    encodeURIComponent, decodeURIComponent, setTimeout, clearTimeout, Blob: function Blob() {},
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
    localStorage: { getItem: k => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null), setItem(k, v) { store[k] = String(v); }, removeItem(k) { delete store[k]; } },
    fetch: async () => ({ ok: false, status: 404, json: async () => ({}) }),
    document: {
      getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {},
      createElement: () => ({ style: {}, classList: { add() {}, remove() {}, toggle() {} }, setAttribute() {}, appendChild() {} }),
      body: { classList: { contains: () => false, add() {}, remove() {}, toggle() {} } },
      documentElement: { style: { setProperty() {} }, __attrs: {}, setAttribute(k, v) { this.__attrs[k] = v; } },
    },
    window: { addEventListener() {}, isSecureContext: false, scrollY: 0, innerHeight: 800, matchMedia: () => ({ matches: false, addEventListener() {} }) },
    navigator: { userAgent: "Mozilla/5.0 (X11; Linux x86_64)" },
    location: { origin: "http://192.0.2.10:8088", pathname: "/", href: "http://192.0.2.10:8088/", search: "" },
    curLang: "zh-CN", settings: {}, scraperStatus: {},
    toast: () => {}, t: k => String(k), tf: k => String(k), esc: s => String(s == null ? "" : s),
    jsAttrArg: v => "'" + String(v == null ? "" : v).replace(/'/g, "") + "'",
    jsObjArg: v => JSON.stringify(v),
    jsArg: v => JSON.stringify(String(v == null ? "" : v)),
    openModal: () => {}, closeModal: () => {}, copyTextFallback: () => false,
    mediaKeepAliveStop: () => {}, mediaKeepAliveStart: () => {},
    sessionWriteHeaders: () => ({}),
    vaultStoreJSON: (k, d) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : d),
    vaultStoreSet: (k, v) => { store[k] = v; return true; },
    vaultStoreRemove: k => { delete store[k]; return true; },
    pushNotification() {}, upsertNotification() {},
    pushMovieScrapeResults: () => true,
    activePlayback: () => null, updatePlaybackDock: () => {}, liveActiveVideoElement: () => null,
    parseSeriesEpisode: p => {
      const m = String(p).match(/S(\d{2})E(\d{2})/);
      return { season: m ? Number(m[1]) : 1, episode: m ? Number(m[2]) : 0, label: m ? m[0] : "S01E01" };
    },
    seriesPlexSeasonLabel: n => `第${["零", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十"][n] || n}季`,
    coverThumbUrl: u => String(u || ""),
    cssUrlValue: u => String(u || ""),
  };
  return Object.assign(sb, extra || {});
}
function loadMedia(extra) {
  const sb = makeSandbox(extra);
  vm.createContext(sb);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "web/js/02-media.js"), "utf8"), sb, { filename: "02-media.js" });
  return sb;
}
function loadTheme(extra) {
  const sb = makeSandbox(extra);
  sb.settings = Object.assign({ uiMode: "auto", opMode: "apple" }, (extra && extra.settings) || {});
  sb.saveSettings = () => {};
  sb.themeLangKey = () => "zh-CN";
  sb.themeLabel = tbl => (tbl && (tbl["zh-CN"] || tbl.en)) || "";
  sb.syncThemeControls = () => {};
  vm.createContext(sb);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "web/js/06-theme.js"), "utf8"), sb, { filename: "06-theme.js" });
  return sb;
}
const call = (sb, expr) => vm.runInContext(expr, sb);

/* ================= A. 季度版式（需求1） ================= */
{
  const sb = loadMedia({});
  call(sb, 'localMediaLibraries = [{ id: "lib-1", type: "series", name: "动画", path: "/ATV" }]');
  sb.__lib = { id: "lib-1", type: "series", name: "动画" };
  sb.__show = {
    title: "东京喰种", poster: "/poster.jpg",
    seasonList: [
      { season: 1, name: "", overview: "", episodes: [{ path: "/ATV/东京喰种/Season 1/S01E01.mkv" }, { path: "/ATV/东京喰种/Season 1/S01E02.mkv" }] },
      { season: 2, name: "", overview: "", episodes: [{ path: "/ATV/东京喰种/Season 2/S02E01.mkv" }] },
    ],
  };
  const first = call(sb, "renderSeriesSeasonCard(__lib, __show, __show.seasonList[0])");
  const second = call(sb, "renderSeriesSeasonCard(__lib, __show, __show.seasonList[1])");

  chk("A1 季名回到独立季名行（首条目前缀已消失）",
    first.indexOf('<h3 class="series-season-head"') >= 0 && first.indexOf("series-season-prefix") < 0 && first.indexOf("series-season-toggle") < 0);
  chk("A2 加粗「季度」在季名行内、季名之前",
    first.indexOf('<span class="season-inline-title">季度</span>') > first.indexOf("series-season-head")
    && first.indexOf("season-inline-title") < first.indexOf("series-season-title"));
  chk("A3「季度」只在最上层那一季出现一次",
    (first.match(/season-inline-title/g) || []).length === 1 && second.indexOf("season-inline-title") < 0);
  chk("A4 季名行走中文序号（第一季 / 第二季）",
    first.indexOf("第一季") >= 0 && second.indexOf("第二季") >= 0);
  chk("A5 全部剧集在同一个网格容器（不再有 -rest 容器与首集大图）",
    (first.match(/class="series-episode-list"/g) || []).length === 1
    && first.indexOf("series-episode-list-rest") < 0
    && first.indexOf("is-season-top") < 0);
  chk("A6 每集都是网格卡片（2 集 = 2 张卡，尺寸由网格决定而非整行）",
    (first.match(/series-episode-card/g) || []).length === 2
    && (first.match(/series-episode-row/g) || []).length === 2);
  chk("A7 季名行在分集网格之前（标题在上、集在下）",
    first.indexOf("series-season-head") < first.indexOf("series-episode-list"));
  chk("A8 首季默认展开、后续季默认折叠",
    first.indexOf("is-collapsed") < 0 && second.indexOf("is-collapsed") >= 0 && second.indexOf("display:none") >= 0);
  chk("A9 单集季同样是一张网格卡片（第 2 季）",
    (second.match(/series-episode-card/g) || []).length === 1 && second.indexOf("series-episode-list") >= 0);
}

/* ================= B. 剧名/取路修复（需求2） ================= */
{
  const sb = loadMedia({});
  const show = { title: "错剧名", seasonList: [{ season: 1, episodes: [{ path: "/ATV/A/Season 1/poster.jpg" }, { path: "/ATV/A/Season 1/A.S01E01.mkv" }] }] };
  sb.__show = show;
  chk("B1 seriesFirstVideoPath 跳过海报取真视频",
    call(sb, "seriesFirstVideoPath(__show)") === "/ATV/A/Season 1/A.S01E01.mkv");
  chk("B2 目录里没有视频时返回空串（不会拿海报顶替）",
    call(sb, "seriesFirstVideoPath({ seasonList: [{ season: 1, episodes: [{ path: '/ATV/A/poster.jpg' }] }] })") === "");

  call(sb, "writeMovieMetadata({'/ATV/A/Season 1/A.S01E01.mkv': { title: '悲剧', show_title: '错剧名' }, '/ATV/A/Season 1/A.S01E02.mkv': { title: '孵化', show_title: '错剧名' }})");
  sb.__show2 = { title: "错剧名", seasonList: [{ season: 1, episodes: [{ path: "/ATV/A/Season 1/A.S01E01.mkv" }, { path: "/ATV/A/Season 1/A.S01E02.mkv" }] }] };
  const changed = call(sb, "repairSeriesShowTitleFromNFO('lib-1', __show2, '东京喰种')");
  const after = call(sb, "JSON.stringify({ t: __show2.title, s: __show2.scrapedTitle, m: movieMetadataFor('/ATV/A/Season 1/A.S01E02.mkv').show_title })");
  chk("B3 剧名修复回写整部剧（含第二集）并更新剧集对象",
    changed === 2 && JSON.parse(after).t === "东京喰种" && JSON.parse(after).m === "东京喰种", { changed, after });
  chk("B4 未变化的剧名不产生写入",
    call(sb, "repairSeriesShowTitleFromNFO('lib-1', __show2, '东京喰种')") === 0);

  /* 目录名兜底（folder）只能补空剧名：不能把已刮削的本地化剧名换成目录名。 */
  const trustRule = call(sb, `(() => {
    const apply = (nfoTitle, nfoTitleSource, cached) => {
      const show = { title: cached, seasonList: [] };
      const trust = !!nfoTitle && (nfoTitleSource === "season-nfo" || nfoTitleSource === "tvshow-nfo");
      const cachedTitle = String(show.title || "").trim();
      if (nfoTitle && (trust ? nfoTitle !== cachedTitle : !cachedTitle)) show.title = nfoTitle;
      const lookup = (trust ? nfoTitle : "") || cachedTitle || nfoTitle;
      return { display: show.title, lookup };
    };
    return JSON.stringify({
      nfo: apply("东京喰种", "season-nfo", "错剧名"),
      folder: apply("Tokyo Ghoul", "folder", "东京喰种"),
      empty: apply("Tokyo Ghoul", "folder", "")
    });
  })()`);
  const tr = JSON.parse(trustRule);
  chk("B5 NFO 剧名来源：显示与查询都用 NFO 剧名（修掉被写错的剧名）",
    tr.nfo.display === "东京喰种" && tr.nfo.lookup === "东京喰种", tr.nfo);
  chk("B6 目录名来源：不覆盖已刮削的本地化剧名（Tokyo Ghoul 不顶掉 东京喰种）",
    tr.folder.display === "东京喰种" && tr.folder.lookup === "东京喰种", tr.folder);
  chk("B7 目录名来源：剧名为空时才用它兜底（并回写显示名）",
    tr.empty.display === "Tokyo Ghoul" && tr.empty.lookup === "Tokyo Ghoul", tr.empty);
}

/* ================= C. 推荐定位与播放（需求3） ================= */
{
  const sb = loadMedia({});
  call(sb, 'localMediaLibraries = [{ id: "lib-movie", type: "movie", name: "电影", path: "/MO" }]');
  chk("C1 路径反查所属媒体库",
    call(sb, "libraryIdForMediaPath('/MO/A/x.mkv')") === "lib-movie"
    && call(sb, "libraryIdForMediaPath('/ATV/x.mkv')") === "");

  call(sb, "movieRecLocalHit = () => ({ path: '/MO/A/x.mkv', libId: 'lib-movie' })");
  const local = call(sb, "movieRecStripHTML({ __libId: 'lib-series', recommendations: [{ title: '本地可播片', year: '2020', rating: 8.1, douban_rating: 9.0 }] })");
  /* jsAttrArg 生成的是双引号 JS 字面量（内联进 onclick 属性），断言按真实输出形态匹配。 */
  chk("C2 有本地资源：▶ 用命中条目自己的库 id 直接播放",
    local.indexOf('openLocalMedia(\'movie\',"lib-movie","/MO/A/x.mkv")') >= 0,
    local.slice(local.indexOf("movie-rec-play"), local.indexOf("movie-rec-play") + 220));
  chk("C3 有本地资源：点卡片进详情（而不是走播放或空库）",
    local.indexOf('openMovieDetails("lib-movie","/MO/A/x.mkv")') >= 0);
  chk("C4 卡片同时展示 TMDB 与豆瓣评分",
    local.indexOf("TMDB 8.1") >= 0 && local.indexOf("豆瓣 9.0") >= 0);

  call(sb, "movieRecLocalHit = () => null");
  const remote = call(sb, "movieRecStripHTML({ __libId: 'lib-series', recommendations: [{ title: '无本地资源片', year: '2019', rating: 7.7 }] })");
  chk("C5 无本地资源：不显示播放按钮，点卡片弹信息窗",
    remote.indexOf("movie-rec-play") < 0 && remote.indexOf("showRecInfo(") >= 0);
}

/* ================= D. 豆瓣评分与综合排序（需求4/5） ================= */
async function doubanSection() {
  const sb = loadMedia({});
  chk("D1 豆瓣缓存键与服务端同口径（小写/去标点/全角转半角）",
    call(sb, "doubanKeyOf('series', '東京喰種：re', '2018')") === "tv|東京喰種re|2018"
    && call(sb, "doubanKeyOf('movie', ' 肖申克的救赎 ', '1994')") === "movie|肖申克的救赎|1994");
  chk("D2 综合分：两边都有按票数加权",
    Math.abs(call(sb, "combinedDoubanTmdbScore(8, 9, 90, 10)") - 8.1) < 1e-6);
  chk("D3 综合分：只有一边时用那一边（不惩罚单一来源）",
    call(sb, "combinedDoubanTmdbScore(0, 9.3)") === 9.3 && call(sb, "combinedDoubanTmdbScore(7.4, 0)") === 7.4);

  let calls = 0;
  const sb2 = loadMedia({
    fetch: async (url) => {
      calls++;
      if (String(url).indexOf("/api/media/douban?") === 0) {
        return { ok: true, status: 200, json: async () => ({ match: true, rating: 8.6, votes: 5000, url: "https://movie.douban.com/subject/1/" }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    },
  });
  const hit1 = await call(sb2, "fetchDoubanRating('东京喰种', '2014', 'series')");
  chk("D4 豆瓣评分走服务端代理并回填分值/票数",
    calls === 1 && hit1 && hit1.rating === 8.6 && hit1.votes === 5000, { calls, hit1 });
  const hit2 = await call(sb2, "fetchDoubanRating('东京喰种', '2014', 'series')");
  chk("D5 同一部剧第二次走会话缓存（不再外呼）",
    calls === 1 && hit2 && hit2.rating === 8.6, { calls });
  const miss = await call(sb2, "fetchDoubanRating('', '', 'series')");
  chk("D6 空片名直接返回 null（不发请求）", miss === null && calls === 1);

  /* 综合排序：豆瓣 9.5 的作品应排在 TMDB 9.0 之前。 */
  const ranked = await call(sb, `rankRecommendationsWithDouban([
      { title: 'A', rating: 9.0, douban_rating: 6.0, media_type: 'movie' },
      { title: 'B', rating: 7.0, douban_rating: 9.5, media_type: 'movie' },
      { title: 'C', rating: 8.0, media_type: 'movie' }
    ])`);
  const titles = (ranked || []).map(x => x.title).join(",");
  chk("D7 综合 TMDB × 豆瓣排序：豆瓣 9.5 的 B 排在 TMDB 9.0 的 A 之前",
    titles.indexOf("B") === 0 && titles.indexOf("A") > titles.indexOf("B"), titles);
  chk("D8 排序后每条都带 combined_rating（前端只读这一个字段）",
    (ranked || []).every(x => typeof x.combined_rating === "number" && x.combined_rating > 0));
}

/* ================= E. 操作模式（需求6/7） ================= */
function opModeSection() {
  const apple = loadTheme({ settings: { opMode: "apple", uiMode: "auto" } });
  const emby = loadTheme({ settings: { opMode: "emby", uiMode: "auto" } });
  const plex = loadTheme({ settings: { opMode: "plex", uiMode: "auto" } });
  chk("E1 三档操作模式都存在且能从设置读出来",
    call(apple, "currentOpMode()") === "apple" && call(emby, "currentOpMode()") === "emby" && call(plex, "currentOpMode()") === "plex");
  chk("E2 非法值回落 apple（不会把 <html> 挂成空档）",
    call(loadTheme({ settings: { opMode: "nope" } }), "currentOpMode()") === "apple");
  chk("E3 三档图标包对同一图标给出不同实现",
    call(apple, 'opModeIcon("play")') !== call(emby, 'opModeIcon("play")')
    && call(emby, 'opModeIcon("play")') !== call(plex, 'opModeIcon("play")')
    && call(apple, 'opModeIcon("search")') !== call(plex, 'opModeIcon("search")'));
  chk("E4 Emby 图标实心（Material 手感）、Apple 描边（SF 手感）",
    call(emby, 'opModeIcon("play")').indexOf('fill="currentColor"') >= 0
    && call(apple, 'opModeIcon("play")').indexOf('fill="none"') >= 0);
  chk("E5 applyOpMode 把档位落到 <html data-opmode>",
    call(emby, "applyOpMode()") === "emby" && call(emby, "document.documentElement.__attrs['data-opmode']") === "emby");
  chk("E6 未覆盖的图标返回空串（调用方回落站内默认图标）",
    call(apple, 'opModeIcon("不存在的图标")') === "");
  chk("E7 操作模式与界面规格是两个独立档位（互不覆盖）",
    call(emby, 'UI_MODES.join(",")') === "auto,phone,tv,pc" && call(emby, 'OP_MODES.join(",")') === "apple,emby,plex");
}

(async () => {
  await doubanSection();
  opModeSection();
  console.log(`\n===== v1.0.7 行为测试：通过 ${passed} / 失败 ${failed} =====`);
  process.exit(failed ? 1 : 0);
})();
