
const fs = require("fs"), vm = require("vm");
const MEDIA = fs.readFileSync("/opt/data/vaulthub-github/web/js/02-media.js", "utf8");
let passed = 0, failed = 0;
const chk = (name, ok, extra) => { if (ok) { passed++; console.log("PASS:", name); } else { failed++; console.log("FAIL:", name, extra || ""); } };

function mkStar(i) {
  return {
    dataset: { star: String(i) },
    querySelector(sel) { this._fillEl = this._fillEl || { style: { width: "0%" } }; return this._fillEl; },
    querySelectorAll() { return []; },
    getBoundingClientRect() { return { left: 100, width: 20 }; },
  };
}
function mkWidget() {
  const stars = [1,2,3,4,5].map(mkStar);
  const valueEl = { textContent: "" };
  const widget = {
    dataset: { rateLib: "m1", ratePath: "/M/a.mkv" },
    querySelector(sel) { return sel === ".movie-rating-value" ? valueEl : null; },
    querySelectorAll(sel) { return sel === ".movie-star" ? stars : []; },
  };
  widget.parentElement = widget;
  stars.forEach(s => s.parentElement = s);
  return { widget, stars, valueEl };
}
const storage = {};
const store = { getItem: k => (k in storage ? storage[k] : null), setItem: (k,v) => { storage[k] = String(v); }, removeItem: k => { delete storage[k]; } };
const toasts = [];
const appendedEls = [];
const sandbox = {
  console, Date, Number, Math, String,
  URL: class { constructor(p, b){ this.href = "http://x" + p; } },
  localStorage: store,
  toast: m => toasts.push(m),
  document: {
    getElementById: () => ({ addEventListener(){}, value:"", innerHTML:"", style:{} }),
    addEventListener: () => {},
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => ({ style:{cssText:""}, attrs:{}, setAttribute(k,v){ this.attrs[k]=v; }, select(){}, remove(){}, value:"", innerHTML:"" }),
    body: { appendChild(n){ appendedEls.push(n); } },
    execCommand: () => true,
  },
  navigator: {},
  location: { pathname: "/", origin: "http://192.0.2.10:8088", href: "http://192.0.2.10:8088/" },
  window: { isSecureContext: false, addEventListener: () => {} },
  esc: s => String(s), jsAttrArg: s => JSON.stringify(s),
  event: { clientX: 0 },
  scraperStatus: { tmdb_image_base: "" },
  movieMetadataFor: () => ({}),
  fetch: async () => ({ ok: false, json: async () => ({}) }),
  sessionWriteHeaders: () => ({}),
  findMediaLibrary: () => null,
  settings: {},
};
vm.createContext(sandbox);
vm.runInContext(MEDIA, sandbox);

const stars5 = vm.runInContext("movieStarsFor(10)", sandbox);
chk("B1 满分 5 颗全亮", (stars5.match(/width:100%/g) || []).length === 5);
const stars25 = vm.runInContext("movieStarsFor(3)", sandbox);
chk("B2 3 分 = 一颗全亮 + 一颗半亮", (stars25.match(/width:100%/g) || []).length === 1 && (stars25.match(/width:50%/g) || []).length === 1);
const stars0 = vm.runInContext("movieStarsFor(0)", sandbox);
chk("B3 0 分全灰", !(stars0.match(/width:(100|50)%/g) || []).length);
sandbox.mkWidget4Test = mkWidget;
chk("B4 半星步进换算（第 3 星左半 = 5 分）", vm.runInContext("(function(){ event.clientX = 105; return movieStarValue(mkWidget4Test().stars[2]); })()", sandbox) === 5);

const w1 = mkWidget();
sandbox.__w = w1;
sandbox.event = { clientX: 105, target: { closest: () => w1.stars[0] } };
vm.runInContext("movieStarHover(event, __w.widget)", sandbox);
chk("B5 悬停第 1 星左半 → 预览 1.0", w1.valueEl.textContent === "评分 1.0", w1.valueEl.textContent);
sandbox.event = { clientX: 115, target: { closest: () => w1.stars[0] } };
vm.runInContext("movieStarHover(event, __w.widget)", sandbox);
chk("B6 悬停第 1 星右半 → 预览 2.0", w1.valueEl.textContent === "评分 2.0", w1.valueEl.textContent);
sandbox.event = { clientX: 105, target: { closest: () => w1.stars[2] } };
vm.runInContext("movieStarClick(event, __w.widget)", sandbox);
chk("B7 点击写入评分 5", storage["vaulthub_movie_rating_m1_/M/a.mkv"] === "5", storage["vaulthub_movie_rating_m1_/M/a.mkv"]);
chk("B8 点击后落定显示我的评分 5.0", w1.valueEl.textContent === "我的评分 5.0", w1.valueEl.textContent);
vm.runInContext("movieStarLeave(__w.widget)", sandbox);
chk("B9 移出后恢复已存 5 分显示", w1.valueEl.textContent === "我的评分 5.0");

(async () => {
  await vm.runInContext("shareMovie('m1', '/M/a.mkv', '测试电影')", sandbox);
  const appended = appendedEls;
  const dialogHtml = appended.length ? String(appended[appended.length - 1].innerHTML || "") : "";
  chk("A1 http 下打开分享面板（不依赖剪贴板权限）", appended.length > 0 && appended[appended.length - 1].id === "shareDialog", JSON.stringify(appended.map(a=>a.id)));
  const shareUrl = appended.length ? String(appended[appended.length-1].attrs["data-share-url"] || "") : "";
  chk("A2 面板含可选中链接（内网地址）", dialogHtml.includes("shareLinkInput") && shareUrl.includes("192.0.2.10:8088"), shareUrl);
  chk("A3 面板提示内网分享语义", dialogHtml.includes("内网分享"));
  const btn = { textContent: "", attrs: {}, setAttribute(k,v){ this.attrs[k]=v; } };
  sandbox.__btn = btn;
  await vm.runInContext("toggleMovieFavorite('m1','/M/a.mkv', __btn)", sandbox);
  chk("D1 首次收藏 → 已收藏 + aria-pressed", btn.textContent === "♥ 已收藏" && btn.attrs["aria-pressed"] === "true");
  chk("D2 localStorage 写 1", storage["vaulthub_movie_favorite_m1_/M/a.mkv"] === "1");
  await vm.runInContext("toggleMovieFavorite('m1','/M/a.mkv', __btn)", sandbox);
  chk("D3 再次点击 → 取消收藏", btn.textContent === "♡ 收藏" && btn.attrs["aria-pressed"] === "false");
  chk("D4 localStorage 写 0", storage["vaulthub_movie_favorite_m1_/M/a.mkv"] === "0");
  const html = vm.runInContext("renderMovieDetails({id:'m1',type:'movie'}, '/M/a.mkv', {cast:[{name:'张三',character:'主角',profile_path:'/p.jpg'},{name:'李四',character:'配角'}]})", sandbox);
  chk("E1 头像 img + 圆形卡片", html.includes('class="movie-cast-avatar" src=') && html.includes('class="movie-cast-card"'));
  chk("E2 缺 profile_path 用首字占位", html.includes("movie-cast-avatar-fallback") && html.includes(">李<"));
  chk("E3 姓名/角色在头像下方", html.includes(">张三</b>") && html.includes(">主角</small>"));
  chk("E4 TMDB 评分徽标在 hero", vm.runInContext("renderMovieHero({id:'m1'},{},{rating:7.8,title:'x',cast:[]})", sandbox).includes("movie-tmdb-rating"));
  console.log("\nSUMMARY pass=" + passed + " fail=" + failed);
  process.exit(failed ? 1 : 0);
})();
