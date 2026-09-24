// v0.9.76 行为测试：推荐函数 + UI 模式，直接对 02-media.js/06-theme.js 做 Node VM 沙盒
const fs = require("fs"), vm = require("vm");
const ROOT = "/opt/data/vaulthub-github";
const MEDIA = fs.readFileSync(ROOT + "/web/js/02-media.js", "utf8");
const THEME = fs.readFileSync(ROOT + "/web/js/06-theme.js", "utf8");
let passed = 0, failed = 0;
const chk = (name, ok, extra) => { if (ok) { passed++; console.log("PASS:", name); } else { failed++; console.log("FAIL:", name, extra || ""); } };

const storeData = {};
const store = { getItem: k => (k in storeData ? storeData[k] : null), setItem: (k,v) => { storeData[k] = String(v); }, removeItem: k => { delete storeData[k]; } };
const settings = { uiMode: "auto" };
const sandbox = {
  console, Date, Number, Math, String, JSON, Object, Array, Infinity, isFinite, parseInt, parseFloat, RegExp, Error, NaN,
  localStorage: store,
  settings,
  saveSettings: () => {},
  readMovieMetadata: () => ({ "/M/a.mkv": {} }),
  writeMovieMetadata: () => {},
  movieMetadataFor: () => ({}),
  saveMovieMetadataOverride: async () => ({ user_rating: 0 }),
  toast: m => {},
  fetch: async () => ({ ok: true, json: async () => ({}) }),
  window: { innerWidth: 1280, matchMedia: () => ({ matches: false }) },
  navigator: { userAgent: "" },
  document: {
    documentElement: { setAttribute: (k,v) => {}, },
    getElementById: () => null,
    querySelectorAll: () => [],
    querySelector: () => null,
    addEventListener: () => {},
  },
  setTimeout, clearTimeout, setInterval, clearInterval,
};
vm.createContext(sandbox);
vm.runInContext(THEME, sandbox);
vm.runInContext(MEDIA, sandbox);

function run(label, fn) { try { return fn(); } catch (e) { failed++; console.log("FAIL:", label, e.message); return undefined; } }

// ---- 推荐规则 ----
const rec = run("普通片推荐", () => sandbox.movieRecommendationsFor({ vote_average: 6.0, recommendations: { results: [
  { title: "低分D", vote_average: 4.0 }, { title: "同分B", vote_average: 6.0 },
  { title: "达标A", vote_average: 6.4 }, { title: "高分C", vote_average: 7.0 } ] } }, { rating: 6.0 }));
chk("普通片 过滤≥6.3 的有2个在前", rec && rec[0].rating >= 6.3 && rec[1].rating >= 6.3 && rec.filter(x => x.rating >= 6.3).length === 2, JSON.stringify(rec));
chk("普通片 不足8条用相关条目补位", rec && rec.length === 4 && rec[2].rating === 4, JSON.stringify(rec));

const recMax = run("近满分推荐", () => sandbox.movieRecommendationsFor({ vote_average: 9.6, recommendations: { results: [
  { title: "近满X", vote_average: 9.8 }, { title: "近满Y", vote_average: 9.4 }, { title: "低Z", vote_average: 5.0 }, { title: "超W", vote_average: 10.0 } ] } }, { rating: 9.6 }));
chk("近满分 首个为 10.0 同评分", recMax && recMax[0].title === "超W", JSON.stringify(recMax));
chk("近满分 前3全在±5%同评分带", recMax && recMax.slice(0,3).every(x => x.rating >= 9.12), JSON.stringify(recMax));
chk("近满分 低分Z排最后", recMax && recMax[recMax.length-1].title === "低Z", JSON.stringify(recMax));

// ---- 徽标 ----
const badgeLow = run("徽标", () => sandbox.movieRecBadge({ rating: 6.4 }, { rating: 6.0 }));
const badgeNear = run("徽标2", () => sandbox.movieRecBadge({ rating: 9.8 }, { rating: 9.6 }));
chk("普通达标=评分+5%", badgeLow === "评分+5%", badgeLow);
chk("近满分=同评分", badgeNear === "同评分", badgeNear);

// ---- UI 模式 ----
let ui = null;
sandbox.document.documentElement.setAttribute = (k,v) => { ui = [k,v]; };
run("手动tv", () => { sandbox.settings.uiMode = "tv"; sandbox.applyUIMode(); });
chk("手动 tv → data-uimode=tv", ui && ui[1] === "tv", JSON.stringify(ui));
run("auto窄屏", () => { sandbox.settings.uiMode = "auto"; sandbox.window.innerWidth = 600; sandbox.window.matchMedia = () => ({ matches: true }); });
chk("auto 600px → phone", sandbox.resolvedUIMode() === "phone", sandbox.resolvedUIMode());

// ---- saveMovieUserRating 写服务端 ----
(async () => {
  let ratingSaved = null;
  sandbox.saveMovieMetadataOverride = async (libId, path, vals) => { ratingSaved = vals.user_rating; return { user_rating: vals.user_rating }; };
  try { await sandbox.saveMovieUserRating("m1", "/M/a.mkv", 8); } catch (e) { console.log("FAIL saveMovieUserRating err:", e.message); failed++; }
  chk("saveMovieUserRating 调服务端 user_rating=8", ratingSaved === 8, String(ratingSaved));
  console.log("SUMMARY " + passed + "/" + (passed + failed) + " PASS");
  process.exit(failed ? 2 : 0);
})();

