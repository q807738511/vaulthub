/* VaultHub frontend — split from index.html in phase 4.
   Plain ordered classic scripts (no bundler): global functions remain global
   so the ~131 inline on*= handlers keep working. Load order is fixed by the
   <script> tags in index.html and MUST be preserved. */
const MEDIA_VIEWS = ["comic", "movie", "audio"];

/* v0.9.62：播放影视/音乐时，海报/封面作为主区域背景虚化。
   背景层仅在 .main 内容区渲染，不影响侧栏与顶栏。 */
function setPlaybackBg(imageUrl) {
  const main = document.querySelector(".main");
  if (!main) return;
  let bg = document.getElementById("playbackBg");
  if (!bg) { bg = document.createElement("div"); bg.id = "playbackBg"; bg.className = "playback-bg"; main.prepend(bg); }
  if (!imageUrl) { clearPlaybackBg(); return; }
  /* v0.9.68：封面 URL 一律经 cssUrlValue 清洗后再拼进 style（与 v0.9.66 的详情背景一致）。
     数据来源含服务端元数据缓存（可由已登录用户写入），未清洗时等于把 CSS 值注入面留给它。 */
  bg.style.backgroundImage = `url('${cssUrlValue(imageUrl)}')`;
  /* 图片加载成功后再显示，避免闪烁 */
  const img = new Image();
  img.onload = () => bg.classList.add("show");
  img.onerror = () => { bg.classList.remove("show"); bg.style.backgroundImage = ""; };
  img.src = imageUrl;
}
function clearPlaybackBg() {
  const bg = document.getElementById("playbackBg");
  if (!bg) return;
  bg.classList.remove("show");
  setTimeout(() => { if (!bg.classList.contains("show")) bg.style.backgroundImage = ""; }, 800);
}

/* v0.9.66：详情背景严格绑定当前查看条目，不复用正在播放媒体的 playbackBg。
   URL 经 cssUrlValue 清洗后才进入 style，避免 CSS 注入。 */
function detailArtworkUrl(meta) {
  /* v0.9.82：详情 hero 用 1280 宽的缩略图（本地封面原图可能是 1–3 MB）。 */
  return cssUrlValue(coverThumbUrl(meta?.fanart || meta?.backdrop || meta?.poster || meta?.cover || "", 1280));
}
function detailBackdropStyle(meta) {
  const art = detailArtworkUrl(meta);
  return art ? `--detail-backdrop:url('${art}')` : "";
}

/* v0.9.66：音频与视频共享唯一播放权；切换类型前同步暂停另一方并释放保活。 */
function claimExclusivePlayback(kind, exceptVideo = null) {
  if (kind === "audio") {
    document.querySelectorAll("video[data-movie-player]").forEach(video => {
      if (video === exceptVideo) return;
      video.pause();
      const root = video.closest(".media-video-body");
      if (root) { mediaKeepAliveStop("video"); clearTimeout(root.__videoProgressTimer); }
    });
    return;
  }
  const audio = document.getElementById("audioPlayerElement");
  if (audio && !audio.paused) {
    audio.pause();
    audioSetPauseIcon(false);
    stopAudioSessionKeepAlive();
  }
}

/* ================= 外连服务（v0.7.0：从「资料库」页迁入系统设置） =================
   过去每个大类页面里都内嵌一份 Komga/Emby/Navidrome 的表单，导致侧边栏和顶栏
   反复出现同样的大类入口。现在外连服务和本地媒体库一样，只是「媒体库」的一种
   来源，统一在系统设置 → 媒体库 → 媒体库增加里维护，侧边栏只显示用户填写的名称。 */
const EXTERNAL_SERVICES_KEY = "vaulthub_external_services_v1";
let externalServices = [];
function loadExternalServices() {
  try { externalServices = JSON.parse(localStorage.getItem(EXTERNAL_SERVICES_KEY) || "[]") || []; }
  catch (e) { externalServices = []; }
  externalServices = externalServices.filter(x => x && x.id && x.name && x.lan);
  return externalServices;
}
function saveExternalServices() {
  try { localStorage.setItem(EXTERNAL_SERVICES_KEY, JSON.stringify(externalServices)); } catch (e) {}
}
function externalServicesForGroup(group) {
  return externalServices.filter(x => x.group === group);
}
function findExternalService(id) { return externalServices.find(x => x.id === id); }
function addExternalMediaService() {
  const group = document.getElementById("extLibGroup")?.value || "comic";
  const name = (document.getElementById("extLibName")?.value || "").trim();
  const lan = normalizeMediaUrl((document.getElementById("extLibLan")?.value || "").trim());
  const proxy = normalizeMediaUrl((document.getElementById("extLibProxy")?.value || "").trim());
  if (!name || !lan) { toast("⚠️ " + t("extLibNeed")); return; }
  externalServices.push({ id: "ext-" + Date.now().toString(36), group, name, lan, proxy });
  saveExternalServices();
  document.getElementById("extLibName").value = "";
  document.getElementById("extLibLan").value = "";
  document.getElementById("extLibProxy").value = "";
  renderExternalServiceList();
  if (typeof renderHomeLibraryNav === "function") renderHomeLibraryNav();
  toast("✅ " + tf("extLibAdded", { name }));
}
function removeExternalMediaService(id) {
  externalServices = externalServices.filter(x => x.id !== id);
  saveExternalServices();
  renderExternalServiceList();
  if (typeof renderHomeLibraryNav === "function") renderHomeLibraryNav();
  toast("✅ " + t("extLibRemoved"));
}
function renderExternalServiceList() {
  const host = document.getElementById("extServiceList");
  if (!host) return;
  if (!externalServices.length) { host.innerHTML = `<div class="empty-tip">${esc(t("extLibEmpty"))}</div>`; return; }
  host.innerHTML = `<div class="media-file-list">${externalServices.map(svc => `<div class="media-file-row">
    <div class="media-file-name"><strong>${esc(svc.name)}</strong><div class="hint">${esc(svc.lan)}${svc.proxy ? " · " + esc(svc.proxy) : ""}</div></div>
    <span class="badge">${esc(t(MEDIA_GROUP_I18N[svc.group] || svc.group))}</span>
    <div class="media-actions">
      <button class="btn" type="button" onclick="openExternalService(${jsAttrArg(svc.id)})">↗ ${esc(t("btnMediaLogin"))}</button>
      <button class="btn btn-danger" type="button" onclick="removeExternalMediaService(${jsAttrArg(svc.id)})">${esc(t("actRemove"))}</button>
    </div></div>`).join("")}</div>`;
}
const MEDIA_GROUP_I18N = { comic: "navGroupBook", movie: "navGroupVideo", audio: "navGroupAudio" };
function setLibrarySource(src) {
  document.querySelectorAll("[data-libsrc]").forEach(el => el.classList.toggle("active", el.dataset.libsrc === src));
  const local = document.getElementById("libSrc-local");
  const ext = document.getElementById("libSrc-external");
  if (local) local.style.display = src === "local" ? "" : "none";
  if (ext) ext.style.display = src === "external" ? "" : "none";
  if (src === "external") renderExternalServiceList();
}

function initMediaLogin() {
  loadExternalServices();
  renderExternalServiceList();
  MEDIA_VIEWS.forEach(v => renderMediaHome(v));
  refreshMediaLibraries(false);
  applyI18n();
}

function isPrivateHostname(hostname) {
  const host = String(hostname || "").toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1" ||
    /^10\./.test(host) || /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host);
}
function isPrivateServiceUrl(url) {
  try { return isPrivateHostname(new URL(normalizeMediaUrl(url)).hostname); }
  catch (e) { return false; }
}
/* 外网浏览器无法直连家庭内网地址：页面本身在公网时自动改走反代域名。
   Navidrome 的 FPK 版没有 BaseURL 开关，根路径要补 /app/ 才是真正入口。 */
function serviceAccessUrl(svc, pageHostname = location.hostname) {
  if (!svc) return "";
  let url = normalizeMediaUrl(svc.lan);
  if (!isPrivateHostname(pageHostname) && isPrivateServiceUrl(url) && svc.proxy) {
    url = normalizeMediaUrl(svc.proxy);
  }
  if (/navidrome/i.test(svc.name || "")) {
    try { const u = new URL(url); if (u.pathname === "/") u.pathname = "/app/"; url = u.toString(); } catch (e) {}
  }
  return url;
}
function normalizeMediaUrl(url) {
  const raw = String(url || "").trim();
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw)) return raw;
  return "http://" + raw;
}
/* v0.8.0 内容页只展示已扫描资源；来源和刮削配置仅存在于系统设置。 */
let externalSelection = {};
function renderMediaHome(group) {
  const host = document.getElementById("media-wide-" + group);
  if (!host) return;
  host.classList.add("show");
  renderLocalMedia(group);
}
function openExternalService(id) {
  const svc = findExternalService(id);
  if (!svc) { toast("⚠️ " + t("homeOpenFail")); return; }
  if (typeof closeSettingsPage === "function" && typeof settingsPageOpen === "function" && settingsPageOpen()) closeSettingsPage();
  openExternalServiceWindow(svc.id);
}
function openExternalServiceWindow(id) {
  const svc = findExternalService(id);
  if (!svc) return;
  window.open(serviceAccessUrl(svc), "_blank", "noopener");
}
function openActiveMediaExternal(group) {
  const svc = findExternalService(externalSelection[group]) || externalServicesForGroup(group)[0];
  if (svc) openExternalServiceWindow(svc.id);
}

/* ================= 本地媒体库 ================= */
let localMediaLibraries = [];
const localMediaSelection = {};
const COMPLETED_PROGRESS = 99.9;
let comicShelfView = "shelf";

/* ---------------- v0.9.74 电子书刊展示页 ----------------
   书架视图（未读 / 喜欢 / 历史阅读 / 全部）、排序（名称 / 添加时间 / 文件大小）、
   网格密度与每页数量都是「本浏览器」偏好；喜欢（收藏）沿用音频收藏那套
   localStorage 方案，不新增服务端接口，避免与阅读进度混在一张表里。
   注意 comicShelfView 仍是历史阅读的开关（v0.9.73 的释放逻辑依赖它），
   这里由 bookShelfTab 单向同步过去。 */
let bookShelfTab = "shelf";
let bookShelfOffset = 0;
let bookShelfPage = 0;                    /* 分页浏览时的当前页（0 基） */
let bookShelfCountsCache = {};             /* 整库统计：{libId: {shelf, like, completed, all}} */
let bookShelfIndexCache = {};
/* v0.9.90：不分页视图的渐进渲染窗口（每次「继续加载」扩大）。 */
let bookShelfRenderLimit = 0;
let bookShelfVisibleCache = [];      /* 当前书架视图（筛选+排序后）的完整列表 */              /* 整库文件索引：{libId: {at, files}} —— 翻页/筛选不重复拉取 */
const BOOK_SHELF_PREFS_KEY = "vaultHubBookShelf";
const BOOK_FAVORITES_KEY = "vaultHubBookFavorites";
const BOOK_SHELF_TABS = [
  { id: "shelf", label: "书架" },
  { id: "like", label: "喜欢" },
  { id: "completed", label: "🕘 历史阅读" }
];
const BOOK_SORT_MODES = [
  { id: "name", label: "按名称" },
  { id: "mtime", label: "按添加时间" },
  { id: "size", label: "按文件大小" }
];
/* 书刊类型说明文案：查表而不是三元表达式，避免任何「预设大类名写死」的字面模式。 */
const BOOK_KIND_LABELS = { book: "电子书", ebook: "电子书", novel: "电子书", comic: "漫画" };
const BOOK_DENSITIES = [
  { cols: 6, label: "紧凑" },
  { cols: 5, label: "标准" },
  { cols: 4, label: "宽松" }
];
let bookShelfPrefsCache = null;
function bookShelfPrefs() {
  /* v0.9.90：渲染 3000 张卡时旧实现每张都 JSON.parse 一次偏好，这里加一层内存缓存。 */
  if (bookShelfPrefsCache) return bookShelfPrefsCache;
  /* paged=false 是默认：v0.9.70 起书刊视图保证「一次展开全部」（未读/历史阅读
     都不因单页全已读而空白）；开启分页浏览后才按每页数量切片并显示分页器。 */
  const def = { tab: "shelf", sort: "name", cols: 5, showFav: true, paged: false, pageSize: 20 };
  try { bookShelfPrefsCache = Object.assign(def, JSON.parse(localStorage.getItem(BOOK_SHELF_PREFS_KEY) || "{}") || {}); } catch (e) { bookShelfPrefsCache = def; }
  return bookShelfPrefsCache;
}
function saveBookShelfPrefs(patch) {
  const next = Object.assign(bookShelfPrefs(), patch || {});
  bookShelfPrefsCache = next;
  try { localStorage.setItem(BOOK_SHELF_PREFS_KEY, JSON.stringify(next)); } catch (e) {}
  return next;
}
/* v0.9.90：大库性能 —— 收藏表读缓存。
   旧实现每次调用都 JSON.parse 整个收藏表，而书刊架对 18.4 万条文件逐条调
   isBookFavorite()，等于 18 万次整表解析（主线程卡死、「页面无法响应」）。 */
const bookFavoritesCache = { map: null };
function readBookFavorites() {
  if (bookFavoritesCache.map) return bookFavoritesCache.map;
  let map = {};
  try {
    const parsed = JSON.parse(localStorage.getItem(BOOK_FAVORITES_KEY) || "{}");
    map = parsed && typeof parsed === "object" ? parsed : {};
  } catch (e) { map = {}; }
  /* v0.9.90 修复：冷读必须回填缓存。旧写法只在 writeBookFavorites 里写缓存，
     首次打开页面时每次 isBookFavorite() 都要整表 JSON.parse —— 18.4 万条库
     就是 18 万次整表解析，正是「页面无法响应」的主因之一。 */
  bookFavoritesCache.map = map;
  return map;
}
function writeBookFavorites(map) {
  /* 内存为权威副本：写入后立即生效，避免下一次读取又整表解析。 */
  bookFavoritesCache.map = (map && typeof map === "object") ? map : {};
  try { localStorage.setItem(BOOK_FAVORITES_KEY, JSON.stringify(map || {})); } catch (e) {}
}
function bookFavoriteKey(libId, path) { return String(libId) + "::" + String(path); }
function isBookFavorite(libId, path) { return readBookFavorites()[bookFavoriteKey(libId, path)] === true; }
function bookFavoritesCount(libId) {
  const prefix = String(libId) + "::";
  return Object.keys(readBookFavorites()).filter(k => k.startsWith(prefix)).length;
}
function toggleBookFavorite(libId, path) {
  const map = readBookFavorites();
  const key = bookFavoriteKey(libId, path);
  const wasOn = map[key] === true;
  if (wasOn) delete map[key]; else map[key] = true;
  writeBookFavorites(map);
  /* 卡片状态就地更新：按钮是 hover 才显形的，重绘整页会让鼠标下那一张闪一下。 */
  document.querySelectorAll(".book-card-fav").forEach(btn => {
    if (btn.dataset.favKey !== key) return;
    btn.classList.toggle("on", !wasOn);
    btn.setAttribute("aria-pressed", String(!wasOn));
    btn.textContent = wasOn ? "♡" : "♥";
    btn.title = wasOn ? "加入喜欢" : "从喜欢移除";
  });
  /* 标签上的「喜欢 N」就地跟着变，否则点完心形还写着旧的 0，看起来像没生效。 */
  syncBookLikeTabCount();
  if (typeof toast === "function") toast(wasOn ? "♡ 已从喜欢移除" : "♥ 已加入喜欢");
  /* 喜欢视图里取消收藏必须立刻把这张移出列表，否则点完还在「喜欢」里。 */
  if (bookShelfTab === "like") refreshBookShelf();
  return !wasOn;
}
/* 喜欢数就地刷新（标签文案 + 统计缓存），不重新请求整库。 */
function syncBookLikeTabCount() {
  const lib = findMediaLibrary(localMediaSelection.comic);
  if (!lib) return;
  const count = bookFavoritesCount(lib.id);
  if (bookShelfCountsCache[lib.id]) bookShelfCountsCache[lib.id].like = count;
  [...document.querySelectorAll(".pn-toolbar .seg button")].forEach(btn => {
    if ((btn.textContent || "").trim().startsWith("喜欢")) btn.textContent = "喜欢 " + count;
  });
  return count;
}
function refreshBookShelf() {
  const lib = findMediaLibrary(localMediaSelection.comic);
  if (!lib) return;
  bookShelfPage = 0;
  bookShelfOffset = 0;
  loadLocalFiles("comic", lib, 0);
}
function setBookShelfTab(tab) {
  const id = BOOK_SHELF_TABS.some(x => x.id === tab) ? tab : "shelf";
  bookShelfTab = id;
  comicShelfView = id === "completed" ? "completed" : "shelf";
  saveBookShelfPrefs({ tab: id });
  refreshBookShelf();
}
function setBookSort(sort) {
  const id = BOOK_SORT_MODES.some(x => x.id === sort) ? sort : "name";
  saveBookShelfPrefs({ sort: id });
  refreshBookShelf();
}
function cycleBookSort() {
  const modes = BOOK_SORT_MODES.map(x => x.id);
  const cur = modes.indexOf(bookShelfPrefs().sort);
  setBookSort(modes[(cur + 1) % modes.length]);
}
function setBookCols(cols) {
  const n = BOOK_DENSITIES.some(d => d.cols === Number(cols)) ? Number(cols) : 5;
  saveBookShelfPrefs({ cols: n });
  const grid = document.querySelector(".book-grid");
  if (grid) grid.style.setProperty("--cols", String(n));
  document.querySelectorAll('#bookViewSet .chips button[data-cols]').forEach(b => b.setAttribute("aria-pressed", String(Number(b.dataset.cols) === n)));
  /* 网格样式来自渲染出来的内联变量，所以密度变化要重渲染一次（纯本地，不重新请求）。 */
  renderBookShelfPage();
}
function cycleBookDensity() {
  const cols = BOOK_DENSITIES.map(d => d.cols);
  const cur = cols.indexOf(Number(bookShelfPrefs().cols));
  setBookCols(cols[(cur + 1) % cols.length]);
}
function toggleBookFavButtons() {
  const on = !bookShelfPrefs().showFav;
  saveBookShelfPrefs({ showFav: on });
  refreshBookShelf();
  if (typeof toast === "function") toast(on ? "♥ 封面收藏按钮已显示" : "封面收藏按钮已隐藏");
}
function toggleBookViewSettings(event) {
  if (event) event.stopPropagation();
  const panel = document.getElementById("bookViewSet");
  const btn = document.getElementById("bookViewSetButton");
  if (!panel) return;
  const open = !panel.classList.contains("open");
  panel.classList.toggle("open", open);
  if (btn) btn.setAttribute("aria-expanded", String(open));
}
function closeBookViewSettings() {
  const panel = document.getElementById("bookViewSet");
  const btn = document.getElementById("bookViewSetButton");
  if (panel) panel.classList.remove("open");
  if (btn) btn.setAttribute("aria-expanded", "false");
}
function bookSortFiles(files, sort) {
  const list = (files || []).slice();
  const byName = (a, b) => String(a.path).localeCompare(String(b.path), "zh-CN");
  if (sort === "size") list.sort((a, b) => Number(b.size || 0) - Number(a.size || 0) || byName(a, b));
  else if (sort === "mtime") list.sort((a, b) => Number(b.mtime || 0) - Number(a.mtime || 0) || byName(a, b));
  else list.sort(byName);
  return list;
}
/* 上次扫描时间：/api/media/index/status 的 ended_at（秒，兼容毫秒）。 */
function bookScanLabel(lib) {
  if (typeof homeIndexStatus === "undefined" || !homeIndexStatus) return "";
  const st = homeIndexStatus[lib.id];
  if (!st) return "";
  if (st.running || st.state === "scanning") return "正在扫描索引 " + Number(st.percent || 0) + "%";
  const raw = Number(st.ended_at || 0);
  if (!raw) return "";
  const ms = raw > 1e12 ? raw : raw * 1000;
  const secs = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (secs < 90) return "上次扫描 刚刚";
  if (secs < 3600) return "上次扫描 " + Math.floor(secs / 60) + " 分钟前";
  if (secs < 86400) return "上次扫描 " + Math.floor(secs / 3600) + " 小时前";
  return "上次扫描 " + Math.floor(secs / 86400) + " 天前";
}
function bookShelfEmptyTip(hasMore) {
  if (bookShelfTab === "like") return "还没有喜欢的书 —— 鼠标移到封面上点右上角的心形即可收藏，收藏的书会集中在这里。";
  if (bookShelfTab === "completed") return "历史阅读还是空的 —— 读完或标记已读的书会出现在这里。";

  return "书架还是空的 —— 扫描到的文件会先集中在这里。";
}
function bookPageSizeValue(prefs) {
  return Math.max(1, Number(prefs.pageSize) || Number(mediaPageSize) || 20);
}
function bookViewSettingsHtml(prefs, densityLabel) {
  const pagingChips = [[0, "关闭"], [20, "20"], [50, "50"], [100, "100"]].map(([n, label]) => {
    const on = n === 0 ? !prefs.paged : (prefs.paged && bookPageSizeValue(prefs) === n);
    return `<button type="button" data-pagesize="${n}" aria-pressed="${on}" onclick="setBookPageSize(${n})">${label}</button>`;
  }).join("");
  const densities = BOOK_DENSITIES.map(d =>
    `<button type="button" data-cols="${d.cols}" aria-pressed="${Number(prefs.cols) === d.cols}" title="${d.label}" onclick="setBookCols(${d.cols})">${d.cols}</button>`).join("");
  return `<div class="viewset" id="bookViewSet">
    <div class="vrow"><span class="lbl">分页浏览</span><span class="chips">${pagingChips}</span></div>
    <div class="vrow"><span class="lbl">网格密度</span><span class="chips">${densities}</span></div>
    <div class="vrow"><span class="lbl">封面收藏按钮</span><span class="chips"><button type="button" aria-pressed="${prefs.showFav ? "true" : "false"}" onclick="toggleBookFavButtons()">${prefs.showFav ? "显示" : "隐藏"}</button></span></div>
    <div class="vrow"><span class="lbl">当前</span><span class="lbl">${densityLabel} · ${prefs.paged ? "每页 " + bookPageSizeValue(prefs) : "完整展开"}</span></div>
  </div>`;
}
/* 分页浏览开关 + 每页数量：0 表示关闭分页（完整展开）。 */
function setBookPageSize(size) {
  const n = Number(size) || 0;
  if (n === 0) {
    saveBookShelfPrefs({ paged: false });
    if (typeof toast === "function") toast("▤ 已改为完整展开");
  } else {
    mediaPageSize = [20, 50, 100].includes(n) ? n : 20;
    saveBookShelfPrefs({ paged: true, pageSize: mediaPageSize });
    if (typeof toast === "function") toast("▤ 每页 " + mediaPageSize + " 本");
  }
  bookShelfPage = 0;
  renderBookShelfPage();
}
/* 翻页纯本地：不重新请求，也不重算统计，避免老版本「翻页即跳段」的问题。 */
function gotoBookShelfPage(page) {
  const prefs = bookShelfPrefs();
  if (!prefs.paged) return;
  const size = bookPageSizeValue(prefs);
  bookShelfPage = Math.max(0, Number(page) || 0);
  bookShelfOffset = bookShelfPage * size;
  renderBookShelfPage();
}
/* v0.9.90 修复：把「渲染窗口」抽成公共切片。
   旧写法只有 renderComicShelf 会窗口化，而切密度 / 改每页 / 关掉分页 / 换标签
   都走 renderBookShelfPage()，它在「完整展开」模式下直接把整库（18.4 万条）
   一次性 innerHTML 塞进 DOM —— 改个列数就把页面再次卡死。 */
function bookShelfWindowSlice(visible, prefs) {
  const list = Array.isArray(visible) ? visible : [];
  const p = prefs || bookShelfPrefs();
  const size = Math.max(1, Number(p.pageSize) || mediaPageSize || 20);
  if (p.paged) return { pageFiles: list.slice(bookShelfOffset, bookShelfOffset + size), more: "" };
  if (list.length <= BOOK_SHELF_AUTO_MAX) return { pageFiles: list, more: "" };
  const limit = Math.max(BOOK_SHELF_RENDER_WINDOW, Number(bookShelfRenderLimit) || 0);
  const shown = list.slice(0, limit);
  const more = list.length > shown.length
    ? `<div class="media-actions"><button class="btn" type="button" onclick="bookShelfLoadMore()">继续加载（已显示 ${shown.length} / ${list.length}）</button><span class="page-scroll-hint">${esc(t("pagerScrollHint"))}</span></div>`
    : "";
  return { pageFiles: shown, more };
}
function renderBookShelfPage() {
  const host = document.getElementById("local-media-content-comic");
  const lib = findMediaLibrary(localMediaSelection.comic);
  if (!host || !lib) return;
  const prefs = bookShelfPrefs();
  const visible = Array.isArray(bookShelfVisibleCache) ? bookShelfVisibleCache : [];
  const size = bookPageSizeValue(prefs);
  const pages = Math.max(1, Math.ceil(visible.length / size));
  bookShelfPage = Math.min(Math.max(0, bookShelfPage), pages - 1);
  const slice = bookShelfWindowSlice(visible, prefs);
  host.innerHTML = bookShelfPageHtml(lib, slice.pageFiles, bookShelfCountsCache[lib.id], visible.length) + slice.more;
  if (typeof scrapeVisibleBookCovers === "function") scrapeVisibleBookCovers(host);
  /* v0.9.92：密度/页签变化后的重绘同样要刷新下滑翻页状态，否则会停在旧模式上。 */
  mediaPagingSet({ mode: slice.more ? "window" : "", group: "comic", libId: String(lib.id), offset: 0, pageSize: size, hasMore: !!slice.more });
  closeBookViewSettings();
}
function bookPagerHtml(total, shown, unit) {
  const prefs = bookShelfPrefs();
  const size = bookPageSizeValue(prefs);
  const count = Number(total) || 0;
  if (!prefs.paged) {
    /* 未开启分页：完整展开，只给出统计，不给假分页器（v0.9.70 的展开保证）。 */
    return `<div class="pager"><span class="total">已展开全部 ${count} ${unit} · 需要分页可在「视图设置 → 分页浏览」开启</span></div>`;
  }
  const pages = Math.max(1, Math.ceil(count / size));
  const cur = Math.min(pages, Math.max(1, bookShelfPage + 1));
  const nums = [];
  const add = n => { if (n >= 1 && n <= pages && !nums.includes(n)) nums.push(n); };
  [1, cur - 1, cur, cur + 1, pages].forEach(add);
  nums.sort((a, b) => a - b);
  let seq = "", prev = 0;
  nums.forEach(n => {
    if (prev && n - prev > 1) seq += `<span class="gap">…</span>`;
    seq += `<button class="pg" type="button" aria-current="${n === cur ? "page" : "false"}" onclick="gotoBookShelfPage(${n - 1})">${n}</button>`;
    prev = n;
  });
  const prevBtn = `<button class="pg nav" type="button" ${cur <= 1 ? "disabled" : ""} onclick="gotoBookShelfPage(${cur - 2})">‹ 上一页</button>`;
  const nextBtn = `<button class="pg nav" type="button" ${cur >= pages ? "disabled" : ""} onclick="gotoBookShelfPage(${cur})">下一页 ›</button>`;
  return `<nav class="pager" aria-label="分页">${prevBtn}${seq}${nextBtn}`
    + `<span class="total">每页 ${size} · 共 ${count} ${unit} · 本页 ${Number(shown) || 0} ${unit}</span></nav>`;
}
function bookShelfPageHtml(lib, pageFiles, counts, total) {
  const prefs = bookShelfPrefs();
  const unit = "本";
  const tabs = BOOK_SHELF_TABS.map(tab => {
    const n = counts && typeof counts[tab.id] === "number" ? counts[tab.id] : null;
    return `<button type="button" role="tab" aria-selected="${bookShelfTab === tab.id ? "true" : "false"}"`
      + ` onclick="setBookShelfTab('${tab.id}')">${tab.label}${n !== null ? " " + n : ""}</button>`;
  }).join("");
  const sortLabel = (BOOK_SORT_MODES.find(m => m.id === prefs.sort) || BOOK_SORT_MODES[0]).label;
  const density = BOOK_DENSITIES.find(d => d.cols === Number(prefs.cols)) || BOOK_DENSITIES[1];
  const kind = BOOK_KIND_LABELS[String(lib.type)] || "书刊";
  const scan = bookScanLabel(lib);
  const head = `<div class="pn-head">
    <div>
      <h1>${esc(lib.name)}</h1>
      <div class="pn-meta">
        <span>${esc(kind)} · 本视图 <b>${Number(total) || 0}</b> ${unit}</span>
        <span>全库 <b>${Number((counts && counts.all) || 0)}</b> ${unit}</span>
        ${/* v0.9.86：客户要求漫画 / 电子书的副标题不再展示媒体库映射的空间位置
             （路径属于配置信息，放系统设置里看即可，不该占副标题）。 */ ''}
        <span>本页 <b>${pageFiles.length}</b> ${unit}</span>
        ${scan ? `<span>${esc(scan)}</span>` : ""}
      </div>
    </div>
  </div>`;
  const toolbar = `<div class="pn-toolbar">
    <div class="seg" role="tablist" aria-label="书架视图">${tabs}</div>
    <div class="pn-tools">
      <button class="tbtn" type="button" onclick="cycleBookSort()" title="切换排序：名称 / 添加时间 / 文件大小">⇅ ${sortLabel}</button>
      <button class="tbtn icononly" type="button" onclick="cycleBookDensity()" title="网格密度：${density.label}">▦</button>
      <button class="tbtn icononly" type="button" id="bookViewSetButton" aria-expanded="false" onclick="toggleBookViewSettings(event)" title="视图设置"><span aria-hidden="true">⚙</span></button>
    </div>
    ${bookViewSettingsHtml(prefs, density.label)}
  </div>`;
  const grid = pageFiles.length
    ? `<div class="book-grid" style="--cols:${Number(prefs.cols) || 5}">${pageFiles.map(file => renderBookCard("comic", lib, file)).join("")}</div>`
    : `<div class="empty-tip">${esc(bookShelfEmptyTip(false))}</div>`;
  return head + toolbar + grid + bookPagerHtml(total, pageFiles.length, unit);
}
let mediaResourceView = (() => { try { return localStorage.getItem("vaulthub_media_resource_view") === "list" ? "list" : "poster"; } catch(e) { return "poster"; } })();
let mediaPageSize = 20;
let audioPageSize = 20;
let audioView = "albums";
/* v0.9.82：本文件的本地缓存读写统一走 01-state.js 的 vaultStore* 安全通道
   （生产环境入口页保证 01-state.js 先加载）。行为测试的 Node VM 沙盒通常只加载
   本文件，这里补一份等价兜底实现：补不上会让「测试环境缺依赖」看起来像功能回归。 */
var vaultStoreSet = typeof vaultStoreSet === "function" ? vaultStoreSet : function (key, value) {
  try { localStorage.setItem(key, typeof value === "string" ? value : JSON.stringify(value)); return true; } catch (e) { return false; }
};
var vaultStoreGet = typeof vaultStoreGet === "function" ? vaultStoreGet : function (key) {
  try { return localStorage.getItem(key); } catch (e) { return null; }
};
var vaultStoreJSON = typeof vaultStoreJSON === "function" ? vaultStoreJSON : function (key, fallback) {
  try { const raw = vaultStoreGet(key); if (raw == null) return fallback; const parsed = JSON.parse(raw); return parsed == null ? fallback : parsed; } catch (e) { return fallback; }
};

let audioFiles = [];
let audioCursor = 0;
let audioTrackTitle = "";
let activeAudio = null;
const audioMetadataCache = "vaulthub_audio_metadata_v1";
let audioMetadataMemory = null; // v0.9.72: 单次载入内存 Map，避免每张卡片重复 JSON.parse
const audioFavoritesCache = "vaulthub_audio_favorites_v1";
let activeReader = null;
function readAudioFavorites() { return vaultStoreJSON(audioFavoritesCache, []); }
function audioFavoriteKey(libId, path) { return `${libId}\n${path}`; }
function isAudioFavorite(libId, path) { return readAudioFavorites().includes(audioFavoriteKey(libId, path)); }
function toggleAudioFavorite(libId, path) {
  const key = audioFavoriteKey(libId, path), values = readAudioFavorites(), index = values.indexOf(key);
  if (index >= 0) values.splice(index, 1); else values.push(key);
  vaultStoreSet(audioFavoritesCache, values);
  updateAudioFavoriteButton();
  const lib = findMediaLibrary(localMediaSelection.audio); if (lib) loadLocalFiles("audio", lib, audioCursor);
}
function toggleActiveAudioFavorite() { if (activeAudio) toggleAudioFavorite(activeAudio.libId, activeAudio.path); }
function updateAudioFavoriteButton() {
  const button = document.getElementById("audioFavoriteButton");
  if (!button) return;
  const fav = !!(activeAudio && isAudioFavorite(activeAudio.libId, activeAudio.path));
  button.innerHTML = fav ? audioIcon("heartFill") : audioIcon("heart");
  button.title = fav ? "取消喜欢" : "喜欢";
  button.classList.toggle("audio-fav-on", fav);
}
function audioFavoriteRows() {
  const favorites = new Set(readAudioFavorites()), rows = [];
  localMediaLibraries.filter(lib => lib.type === "audio").forEach(lib => {
    favorites.forEach(key => { const split = key.indexOf("\n"); if (split < 0 || key.slice(0, split) !== lib.id) return; const path = key.slice(split + 1); rows.push({ lib, path }); });
  });
  return rows;
}
function renderAudioFavorites(lib) {
  const rows = audioFavoriteRows();
  return rows.length ? `<div class="media-file-list">${rows.map(({lib: rowLib, path}) => renderAudioRow(rowLib, { path })).join("")}</div>` : '<div class="empty-tip">还没有喜欢的歌曲，请在歌曲列表中点击 ♡ 收藏。</div>';
}

/* ================= 手动歌单（v0.9.56） =================
   歌曲行的 ♫ 按钮弹出歌单勾选器：可把当前歌曲加入多个本地歌单或新建歌单；
   「歌单」页签展示全部歌单，支持播放整单/查看/删除。循环模式只保留在
   底部播放器（cycleAudioLoop），列表页不再放播放模式按钮。 */
const audioPlaylistsCache = "vaulthub_audio_playlists_v1";
let audioPlaylistFilter = ""; // 非空 = 当前曲目列表是某歌单（按 audioPlaylistSongSet 过滤）
function readAudioPlaylists() {
  const list = vaultStoreJSON(audioPlaylistsCache, []);
  return Array.isArray(list) ? list.filter(p => p && String(p.name || "").trim() && Array.isArray(p.songs)) : [];
}
function writeAudioPlaylists(list) { vaultStoreSet(audioPlaylistsCache, list); }
function audioPlaylistSongSet(name) {
  const p = readAudioPlaylists().find(x => x.name === String(name));
  return new Set(Array.isArray(p?.songs) ? p.songs : []);
}
function audioPlaylistHasSong(name, key) { return audioPlaylistSongSet(name).has(String(key)); }
function audioPlaylistsOfSong(key) {
  const k = String(key);
  return readAudioPlaylists().filter(p => p.songs.includes(k)).map(p => p.name);
}
function saveAudioPlaylistSongs(name, set) {
  const list = readAudioPlaylists();
  const p = list.find(x => x.name === String(name));
  if (!p) return;
  p.songs = [...set];
  writeAudioPlaylists(list);
}
function deleteAudioPlaylist(name) {
  const target = String(name);
  if (!readAudioPlaylists().some(x => x.name === target)) return;
  if (!window.confirm(`删除歌单「${target}」？歌曲本身不会被删除。`)) return;
  writeAudioPlaylists(readAudioPlaylists().filter(x => x.name !== target));
  if (audioPlaylistFilter === target) { audioPlaylistFilter = ""; audioArtistFilter = ""; }
  toast(`🗑 歌单「${target}」已删除`);
  const lib = findMediaLibrary(localMediaSelection.audio);
  if (lib) loadLocalFiles("audio", lib, audioCursor);
}
let audioPlaylistPicker = null; // {libId, path} 当前正在勾选歌曲的上下文
function openAudioPlaylistPicker(libId, path) {
  audioPlaylistPicker = { libId: String(libId), path: String(path) };
  const meta = audioMetadataFor(String(path));
  const label = document.getElementById("audioPlaylistSongLabel");
  if (label) label.textContent = `${meta.title} · ${meta.artist}`;
  document.getElementById("audioPlaylistNewName").value = "";
  renderAudioPlaylistPickerBody();
  openModal("audioPlaylistModal");
}
function renderAudioPlaylistPickerBody() {
  const host = document.getElementById("audioPlaylistContent");
  if (!host || !audioPlaylistPicker) return;
  const key = audioFavoriteKey(audioPlaylistPicker.libId, audioPlaylistPicker.path);
  const inPl = new Set(audioPlaylistsOfSong(key));
  const list = readAudioPlaylists();
  host.innerHTML = list.length
    ? list.map(p => `<label class="playlist-pick-row"><input type="checkbox" data-key="${esc(key)}" data-playlist-name="${esc(p.name)}" onchange="togglePickerPlaylist(this)" ${inPl.has(p.name) ? "checked" : ""}><span>${esc(p.name)}</span><small>${p.songs.length} 首</small></label>`).join("")
    : '<div class="empty-tip">还没有歌单：在下方输入名称，点「新建并加入」创建。</div>';
}
function togglePickerPlaylist(box) {
  const name = String(box.dataset.playlistName || ""), key = String(box.dataset.key || "");
  const set = audioPlaylistSongSet(name);
  if (box.checked) set.add(key); else set.delete(key);
  saveAudioPlaylistSongs(name, set);
  renderAudioPlaylistPickerBody();
  toast(box.checked ? `♫ 已加入歌单「${name}」` : `已从歌单「${name}」移除`);
}
function createAudioPlaylistFromPicker() {
  const name = (document.getElementById("audioPlaylistNewName").value || "").trim();
  if (!name) { toast("⚠️ 请输入歌单名称"); return; }
  const list = readAudioPlaylists();
  if (list.some(p => p.name === name)) { toast("⚠️ 歌单已存在，请直接勾选"); return; }
  list.push({ name, songs: [] });
  writeAudioPlaylists(list);
  if (audioPlaylistPicker) {
    const set = audioPlaylistSongSet(name);
    set.add(audioFavoriteKey(audioPlaylistPicker.libId, audioPlaylistPicker.path));
    saveAudioPlaylistSongs(name, set);
  }
  document.getElementById("audioPlaylistNewName").value = "";
  renderAudioPlaylistPickerBody();
  toast(`♫ 歌单「${name}」已创建并加入`);
}
function renderAudioPlaylists(lib) {
  const list = readAudioPlaylists();
  if (!list.length) return '<div class="empty-tip">还没有歌单：在歌曲列表中点 ♫ 即可新建歌单并把歌曲加入。</div>';
  return `<div class="media-file-list">${list.map(p => `<div class="media-file-row"><div class="media-file-name"><b>${esc(p.name)}</b><small>${p.songs.length} 首歌曲</small></div><div class="media-actions"><button class="btn" title="播放整个歌单" onclick="playAudioPlaylist(${jsAttrArg(lib.id)},${jsAttrArg(p.name)})">▶ 播放</button><button class="btn" title="查看歌单歌曲" onclick="openAudioPlaylistTracks(${jsAttrArg(lib.id)},${jsAttrArg(p.name)})">列表</button><button class="btn btn-danger" title="删除歌单" onclick="deleteAudioPlaylist(${jsAttrArg(p.name)})">✕</button></div></div>`).join("")}</div>`;
}
async function loadPlaylistTracks(lib, name, autoPlay) {
  const setName = String(name);
  const set = audioPlaylistSongSet(setName);
  if (!set.size) { toast("⚠️ 该歌单还没有歌曲"); return; }
  const host = document.getElementById("local-media-content-audio");
  if (!host) return;
  const all = await fetchAllLibraryFiles(lib.id, { has_more: true }, 0);
  const files = all
    .filter(file => supportedLocalMediaFile("audio", lib, String(file.path)) && set.has(audioFavoriteKey(lib.id, String(file.path))))
    .sort((a, b) => String(a.path).localeCompare(String(b.path), "zh-CN"));
  if (!files.length) { toast("⚠️ 歌单歌曲不在当前媒体库中"); return; }
  audioPlaylistFilter = setName;
  audioArtistFilter = "";
  audioTrackTitle = setName;
  audioTracksBack = "playlists";
  audioView = "tracks";
  audioFiles = files;
  audioCursor = 0;
  renderAudioLibraryContent(host, lib, files);
  if (autoPlay && files.length) playAudioFile(lib.id, files[0].path);
}
function playAudioPlaylist(libId, name) {
  const lib = findMediaLibrary(String(libId));
  if (lib) loadPlaylistTracks(lib, String(name), true);
}
function openAudioPlaylistTracks(libId, name) {
  const lib = findMediaLibrary(String(libId));
  if (lib) loadPlaylistTracks(lib, String(name), false);
}

const movieMetadataCache = "vaulthub_movie_metadata_v1";
let scraperStatus = { default: "douban", tmdb_enabled: false };
/* v0.9.82：影视元数据是「整库单键」，两万条的库一次 JSON.parse/stringify 就是几十 MB 的
   主线程工作 —— 旧实现每次点击都在主线程重新序列化整库，是「操作迟缓」的直接来源。
   现在内存里保留一份权威副本：读取恒为 O(1)（不再重复解析），写入合并到 400ms 窗口内
   只落盘一次；落盘统一走 vaultStoreSet（配额已满时先清理可重建缓存再重试）。 */
let movieMetadataMemory = null, movieMetadataFlushTimer = null;
function readMovieMetadata() {
  if (movieMetadataMemory) return movieMetadataMemory;
  movieMetadataMemory = vaultStoreJSON(movieMetadataCache, {});
  return movieMetadataMemory;
}
function flushMovieMetadata() {
  movieMetadataFlushTimer = null;
  vaultStoreSet(movieMetadataCache, movieMetadataMemory || {});
}
function writeMovieMetadata(data) {
  movieMetadataMemory = data || {};
  movieLocalTitleIndexCache = null;
  if (movieMetadataFlushTimer) return;
  movieMetadataFlushTimer = setTimeout(flushMovieMetadata, 400);
}
/* v0.9.84：把「一部蓝光原盘」从 600+ 个片段合并成 1 条库条目。
   原盘目录（含 BDMV/ 的目录，例如 /MO/黑鹰坠落.../BDMV/STREAM/00011.m2ts）在库里
   只会出现一次，保留体积最大的那个片段作为可播放文件，标题用原盘目录名。
   幂等：已经合并过的条目（disc: true）原样返回，因此会话索引缓存复用不会重复计数。 */
function collapseDiscFragments(files) {
  const groups = new Map();
  const out = [];
  let merged = 0;
  (files || []).forEach((file) => {
    if (file && file.disc) { out.push(file); return; }
    const path = String((file && file.path) || "");
    const group = discGroupOf(path);
    if (!group) { out.push(file); return; }
    const isIso = group.kind === "iso";
    const current = groups.get(group.key);
    if (!current) {
      const entry = { ...file, disc: true, disc_folder: group.key, disc_kind: group.kind, disc_fragments: 1 };
      if (isIso) entry.iso_path = path;
      groups.set(group.key, entry);
      out.push(entry);
      return;
    }
    current.disc_fragments = Number(current.disc_fragments || 1) + 1;
    merged++;
    if (isIso && !current.iso_path) current.iso_path = path;
    /* v0.9.88：同一目录里 ISO 与 BDMV 并存（先下镜像再解压很常见）时，
       播放路径保留可直接播的 BDMV 片段，镜像路径另存 —— 一部片子只出现一条，
       不会既有「能播的片段」又有一条打不开的 ISO 卡片。
       同类之间保留体积最大的那个（多碟 / 分卷 ISO 的唯一入口）。 */
    const currentIsIso = current.disc_kind === "iso";
    const keepNew = (!isIso && currentIsIso) || (isIso === currentIsIso && Number(file.size || 0) > Number(current.size || 0));
    if (keepNew) {
      current.path = file.path;
      current.size = file.size;
      current.mtime = file.mtime;
      current.disc_kind = group.kind;
    }
  });
  if (merged) console.info(`[scrape] 原盘条目合并：${files.length} → ${out.length} 条（合并 ${merged} 个片段/镜像）`);
  return out;
}
/* 影视文件名常见的发布组/规格标记，展示标题时剔除 */
const MOVIE_NOISE_RE = /\b(2160p|1080p|1080i|720p|480p|4k|8k|uhd|hdr10\+?|hdr|dv|dolby[\s.]?vision|remux|bluray|blu-ray|bdrip|brrip|webrip|web-?dl|hdtv|dvdrip|x264|x265|h\.?264|h\.?265|hevc|avc|aac|ac3|eac3|dts(?:-hd)?|truehd|atmos|flac|10bit|8bit|s\d{1,2}e\d{1,3}|s\d{1,2}|e\d{1,3}|repack|proper|extended|imax|cn|chs|cht|zh|eng)\b/gi;

function parseSeriesEpisode(path) {
  const raw = String(path || "");
  const parts = raw.split(/[\\/]+/).filter(Boolean);
  const filename = parts.pop() || raw;
  const stem = filename.replace(/\.[^.]+$/, "");
  const seasonDir = [...parts].reverse().find(p => /^Season\s*\d+$/i.test(p) || /^第\s*\d+\s*季$/.test(p));
  const patterns = [/^(.*?)\s*-?\s*[sS](\d{1,2})[eE](\d{1,3})\s*-?\s*(.*)$/, /^(.*?)\s+(\d{1,2})x(\d{1,3})\s*-?\s*(.*)$/, /^(.*?)第\s*(\d{1,2})\s*季\s*第\s*(\d{1,3})\s*集\s*(.*)$/];
  let show = "", season = 1, episode = 0, title = "";
  for (const re of patterns) { const m = stem.match(re); if (m) { show = m[1]; season = Number(m[2]); episode = Number(m[3]); title = m[4] || ""; break; } }
  if (!show) { const m = stem.match(/[sS](\d{1,2})[eE](\d{1,3})/); if (m) { season = Number(m[1]); episode = Number(m[2]); title = stem.replace(m[0], " "); } }
  if (!show) { const seasonIndex = parts.findIndex(p => /^Season\s*\d+$/i.test(p) || /^第\s*\d+\s*季$/.test(p)); show = seasonIndex > 0 ? parts[seasonIndex - 1] : (parts[0] || movieTitleFromPath(path)); }
  if (seasonDir) { const sm = seasonDir.match(/(\d+)/); if (sm) season = Number(sm[1]); }
  const clean = s => String(s || "").replace(MOVIE_NOISE_RE, " ").replace(/[._]+/g, " ").replace(/\s+-\s*$/g, "").replace(/\s+/g, " ").trim();
  show = clean(show) || movieTitleFromPath(path);
  title = clean(title) || `第 ${episode || "?"} 集`;
  return { show, key: show.toLowerCase(), season: season || 1, episode: episode || 0, title, label: `S${String(season || 1).padStart(2,"0")}E${String(episode || 0).padStart(2,"0")}` };
}
function buildSeriesShows(files) {
  const shows = new Map();
  files.forEach(file => {
    const path = String(file.path), parsed = parseSeriesEpisode(path), meta = movieMetadataFor(path);
    const title = meta.show_title || parsed.show, key = title.toLowerCase();
    if (!shows.has(key)) shows.set(key, { key, title, poster: meta.poster || "", logo: meta.logo || "", fanart: meta.fanart || "", backdrop: meta.backdrop || "", watched: !!meta.watched, overview: meta.overview || "", year: meta.year || "", provider: meta.provider || "文件名展示", seasons: new Map(), files: [] });
    const show = shows.get(key); show.poster ||= meta.poster || ""; show.logo ||= meta.logo || ""; show.fanart ||= meta.fanart || ""; show.backdrop ||= meta.backdrop || ""; show.watched ||= !!meta.watched; show.overview ||= meta.overview || ""; show.year ||= meta.year || "";
    if (!show.seasons.has(parsed.season)) show.seasons.set(parsed.season, []);
    show.seasons.get(parsed.season).push({ ...file, parsed, meta }); show.files.push(file);
  });
  return [...shows.values()].sort((a,b)=>a.title.localeCompare(b.title,"zh-CN")).map(show => { show.seasonList = [...show.seasons.entries()].sort((a,b)=>a[0]-b[0]).map(([season, episodes]) => ({ season, episodes: episodes.sort((a,b)=>(a.parsed.episode||0)-(b.parsed.episode||0)) })); return show; });
}
const seriesShowMemory = {};
function seriesShowStoreKey(libId, showKey) { return `vaulthub_series_show_${libId}_${showKey}`; }
/* show.files 与 show.seasonList[*].episodes 是同一批条目的两份拷贝，show.seasons 又是
   无法 JSON 序列化的 Map。整份写入会让一部 200 集的剧占掉约 120 KB，2 万集的库直接撞上
   localStorage 5 MB 配额并静默失败（setItem 抛 QuotaExceededError）。这里只持久化
   openSeriesDetails 真正会读的字段：季集结构，加上 hero 需要的首集路径。 */
function seriesShowCacheShape(show) {
  return {
    key: show.key, title: show.title, poster: show.poster, logo: show.logo, fanart: show.fanart, backdrop: show.backdrop,
    watched: show.watched,
    overview: show.overview, year: show.year, provider: show.provider,
    files: show.files?.length ? [{ path: show.files[0].path }] : [],
    seasonList: (show.seasonList || []).map(season => ({
      season: season.season,
      episodes: (season.episodes || []).map(ep => ({ path: ep.path, size: ep.size, parsed: ep.parsed, meta: ep.meta })),
    })),
  };
}
function rememberSeriesShow(libId, show) {
  /* v0.9.82：先由 vaultStoreSet 判定能否落盘（超过单键上限直接判失败），
     不能落盘就退化为内存缓存，详情页仍能从本次渲染的数据打开。 */
  const key = seriesShowStoreKey(libId, show.key), shape = seriesShowCacheShape(show);
  if (!vaultStoreSet(key, shape)) seriesShowMemory[key] = shape;
}
/* JSON.stringify 会把 seasons(Map) 序列化成 {}，因此读回后只有数组 seasonList 与 files 可用；
   openSeriesDetails 必须只依赖这两个字段，并对旧缓存缺字段的情况回落空数组。 */
/* v0.9.87：是否已有刮削信息 —— 「文件名展示」是解析回落态，不算刮削结果。
   没有刮削信息时不再显示「已按 Plex / Emby 风格…聚合到同一剧集」这类说明，
   因为此时剧名只是目录名，说明只会造成误读。 */
function hasScrapedInfo(meta) {
  if (!meta) return false;
  const provider = String(meta.provider || "").trim();
  if (provider && !/文件名/.test(provider)) return true;
  if (meta.tmdb_id || meta.poster || meta.logo || meta.fanart || meta.backdrop) return true;
  if (String(meta.overview || "").trim()) return true;
  return Number(meta.rating || 0) > 0;
}
/* v0.9.87：剧集首屏介绍文案的判定集中在这一处，便于「无刮削信息不显示聚合说明」被单测直接驱动。
   已有真实简介 → 用简介；已刮削但无简介 → 保留聚合说明（有信息价值）；完全没刮削 → 空（不渲染段落）。 */
function seriesHeroOverview(show) {
  const own = String((show && show.overview) || "").trim();
  if (own) return own;
  return hasScrapedInfo(show) ? "已按 Plex / Emby 风格根据根目录、Season 01 和 S01E01 规则聚合到同一剧集。" : "";
}
function readSeriesShow(libId, showKey) { const key = seriesShowStoreKey(libId, showKey); try { const show = vaultStoreJSON(key, null) || seriesShowMemory[key] || null; if (!show) return null; if (!Array.isArray(show.seasonList)) show.seasonList = []; if (!Array.isArray(show.files)) show.files = []; return show; } catch(e) { return null; } }

/* v0.9.84：蓝光原盘目录判定（BDMV / CERTIFICATE 结构的上一级目录即「一部片子」）。 */
function discFolderOf(path) {
  const m = String(path).match(/^(.*)\/(?:BDMV|CERTIFICATE)\//i);
  return m ? m[1] : "";
}
/* v0.9.88：原盘镜像（ISO）—— 蓝光/DVD 原盘最常见的另一种存放形态。
   服务端会把 .iso 交给 libbluray（UDF 直读）或 dvdvideo 读取，前端这里负责
   把它当成「一条原盘条目」而不是普通视频文件。 */
function isIsoImage(path) { return /\.iso$/i.test(String(path || "")); }
function parentDir(path) { const p = String(path || "").split("/"); p.pop(); return p.join("/"); }
function parentDirName(path) { const p = String(path || "").split("/").filter(Boolean); return p.length >= 2 ? p[p.length - 2] : ""; }
/* 原盘里「不可能是片名」的目录 / 镜像名：结构名、占位名、纯编号符号。
   命中就继续往上一级找 —— 否则这类原盘永远只能以「文件名展示」结束。 */
const UNUSABLE_DISC_NAME_RE = /^(bdmv|certificate|disc|disc\d+|disk\d+|cd\d+|dvd|dvdrom|iso|title|movie|volume|vol\d+|video_ts|audio_ts|vts[\d_]*|原盘|镜像|影片|视频|\d{1,4})$/i;
function discTitleCandidate(seg) {
  const raw = String(seg || "").trim();
  if (!raw) return "";
  /* 只对「是否可用」做一次宽松探测（去掉扩展名与括号），返回值保留原始分隔符 ——
     提前把 . _ - 换成空格会让后续 MOVIE_NOISE_RE 匹配不到 Blu-ray/HD-DVD 这类
     规格词，标题里就会残留「Blu ray」。 */
  const probe = raw.replace(/\.iso$/i, "").replace(/[\[\]()【】]/g, " ").replace(/\s+/g, " ").trim();
  if (!probe || UNUSABLE_DISC_NAME_RE.test(probe) || !scrapableMovieTitle(probe)) return "";
  return raw.replace(/\.iso$/i, "");
}
/* 原盘条目的分组与类型：BDMV 片段按原盘目录归组，ISO 镜像按所在目录归组。 */
function discGroupOf(path) {
  const folder = discFolderOf(path);
  if (folder) return { key: folder, kind: "bdmv" };
  if (isIsoImage(path)) return { key: parentDir(String(path)), kind: "iso" };
  return null;
}
function movieTitleFromPath(path) {
  /* 先在原始文件名上剔除年份与发布规格，再做分隔符归一化：
     displayBookTitle 会把 WEB-DL 这类连字符换成空格，先跑它会导致噪声词漏匹配。 */
  const raw = (() => {
    const name = String(path).split("/").pop().replace(/\.[^.]+$/, "");
    /* v0.9.84：蓝光原盘里的文件名是 00001.m2ts / MovieObject.bdmv 这类片段编号，
       拿它去刮削必然查不到。原盘条目的标题一律取 BDMV 的上一级目录名
       （例如 [黑鹰坠落]Black.Hawk.Down.2001.Blu-ray... → 可被 TMDB 命中）。
       v0.9.88：ISO 镜像用镜像名（片名通常就在上面）；当镜像名或原盘目录名本身
       不可用（BDMV / disc / title / 纯编号）时继续上溯到父目录 —— 这类原盘以前
       只能停在「文件名展示」，现在能正常刮到。 */
    const disc = discFolderOf(path);
    if (disc) {
      const segs = String(disc).split("/").filter(Boolean);
      for (let i = segs.length - 1; i >= 0; i--) {
        const cand = discTitleCandidate(segs[i]);
        if (cand) return cand;
      }
      return name;
    }
    if (isIsoImage(path)) {
      return discTitleCandidate(name) || discTitleCandidate(parentDirName(path)) || name;
    }
    return name;
  })();
  const base = raw
    .replace(/\b(19|20)\d{2}\b/g, " ")
    .replace(MOVIE_NOISE_RE, " ")
    .replace(/[\[\]()【】]/g, " ")
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return base || displayBookTitle(path);
}

function movieYearFromPath(path) { const m = String(path).match(/\b(19|20)\d{2}\b/); return m ? m[0] : ""; }
function movieBaseMetadata(path) { return { title: movieTitleFromPath(path), year: movieYearFromPath(path), poster: "", overview: "", provider: "文件名展示", checkedAt: 0 }; }
function movieMetadataFor(path) { const all = readMovieMetadata(); return { ...movieBaseMetadata(path), ...(all[path] || {}) }; }
/* v0.9.92：剧名修复 —— v0.9.89 把「刮削标题」写在 title 上（当时还没有 show_title），
   v0.9.90 起剧集的 title 改成「分集名」、剧名单独放 show_title。历史记录于是只有 title，
   卡片会退回文件名解析出的剧名，表现为「刮削后的媒体名称展示规则没生效」。
   这里按库类型把「已刮削但缺 show_title」的记录补上剧名，让旧数据同样遵守
   「一级标题 = 刮削标题」。新记录本身带 show_title，不受影响。 */
function repairSeriesShowTitle(libId, meta, path) {
  if (!meta || meta.show_title) return meta;
  const lib = (typeof findMediaLibrary === "function") ? findMediaLibrary(libId) : null;
  const isSeries = lib ? lib.type === "series" : meta.media_type === "series";
  if (!isSeries) return meta;
  if (meta.scrape_state && meta.scrape_state !== "ok") return meta;
  const title = String(meta.title || "").trim();
  if (!title) return meta;
  const fallback = String(path || meta.original_path || "").trim();
  if (fallback && title === movieTitleFromPath(fallback)) return meta;
  /* v0.9.91 审查修复：v0.9.90 起剧集记录的 title 写的是「分集名」，把它当剧名会把
     分集名提升成剧名（例如整季只有年份的分集名「2024」）。这类记录无法从自身推出
     剧名，故不补 —— 卡片继续用文件名解析出的剧名展示，与用户预期一致。 */
  if (fallback && typeof parseSeriesEpisode === "function") {
    const parsed = parseSeriesEpisode(fallback);
    const epTitle = String((parsed && parsed.title) || "").trim();
    const showParsed = String((parsed && parsed.show) || "").trim();
    if (epTitle && title === epTitle && title !== showParsed) return meta;
  }
  meta.show_title = title;
  return meta;
}
/* ==================== v0.9.88：刮削结果服务端持久化 ====================
   客户要求：「影视及音乐及电子书籍刮削，完成刮削后优先将刮削信息返回到服务器内部
   进行持久化保存，防止出现多次批量重复读取的操作从而影响体验」。
   影视与电子书的刮削结果以前只写浏览器 localStorage：换浏览器、清缓存、换设备，
   或同一媒体库被多次整库扫描，都要重新刮一遍（每条一次 TMDB 请求）——这就是
   重复批量读取。现在进库先读服务端 /api/media/scrape-cache，取较新的那份合并，
   刮完再批量写回；「已刮削」条目自然不再进待刮队列。
   音乐本来就有服务端持久化（v0.9.67：sidecar + SQLite + /api/media/audio/cache），
   同一套思路，不重复造。
   ============================================================================ */
const MOVIE_SCRAPE_STORE_FIELDS = ["title", "show_title", "year", "poster", "backdrop", "logo", "fanart", "overview",
  "rating", "provider", "tmdb_id", "tvdb_id", "media_type", "user_title", "scrape_state", "reason"];
/* 上传前统一成服务端字段（并剔除空值，避免把空字段写进结果库）。 */
function movieScrapeStoreShape(meta) {
  const out = {};
  MOVIE_SCRAPE_STORE_FIELDS.forEach((key) => {
    const v = meta ? meta[key] : undefined;
    if (v === undefined || v === null || v === "" || v === 0) return;
    out[key] = v;
  });
  out.checked_at = Number((meta && meta.checkedAt) || 0) || Date.now();
  return out;
}
async function hydrateMovieMetadataFromServer(libId) {
  if (!libId) return false;
  try {
    const res = await fetch(`/api/media/scrape-cache?id=${encodeURIComponent(libId)}`, { cache: "no-store", credentials: "same-origin" });
    if (!res.ok) return false;
    const data = await res.json();
    const items = (data && data.items) || {};
    const all = readMovieMetadata();
    let changed = 0;
    Object.keys(items).forEach((path) => {
      const item = items[path];
      if (!path || !item) return;
      const cur = all[path];
      const serverAt = Number(item.checked_at || 0);
      if (cur && Number(cur.checkedAt || 0) > serverAt) return; // 本地更新，不覆盖
      const merged = { ...movieBaseMetadata(path), ...(cur || {}), ...item, checkedAt: serverAt || Date.now() };
      delete merged.checked_at;
      /* v0.9.92：老记录只有 title（v0.9.89 口径）→ 补出剧名，避免退回文件名。 */
      repairSeriesShowTitle(libId, merged, path);
      /* v0.9.88：服务端记过这次尝试 → 沿用它的时间戳与次数。否则换浏览器 / 换设备后
         整库「失败」条目会被当成从没刮过，每台设备再连打 3 遍（仍是重复批量读取）。
         需要立即重试时走「逐项扫描 → 仅重试失败项」（那里显式复位次数与时间）。 */
      if (merged.scrape_state === "failed" || merged.scrape_state === "pending") {
        merged.scrape_attempts = Number(merged.scrape_attempts || 0) || 1;
        merged.last_attempt = Number(merged.last_attempt || 0) || serverAt;
      }
      all[path] = merged;
      changed++;
    });
    if (changed) { writeMovieMetadata(all); movieLocalTitleIndexCache = null; }
    return changed > 0;
  } catch (e) { return false; }
}
/* 写回服务端：批量一次请求（不是每条一次）。失败只记日志，不影响本次会话展示。 */
function pushMovieScrapeResults(libId, paths, opts) {
  if (!libId) return;
  const list = [...new Set((paths || []).map(String).filter(Boolean))];
  if (!list.length) return;
  const all = readMovieMetadata();
  const items = {};
  list.forEach((path) => { if (all[path]) items[path] = movieScrapeStoreShape(all[path]); });
  if (!Object.keys(items).length) return;
  try {
    fetch("/api/media/scrape-cache", {
      method: "POST", headers: sessionWriteHeaders(true), credentials: "same-origin",
      body: JSON.stringify({ id: String(libId), items, replace: !!(opts && opts.replace) })
    }).then(res => { if (!res.ok) console.info("[scrape] 服务端保存刮削结果失败：HTTP", res.status); })
      .catch(() => { /* 服务端不可用：本地仍可用 */ });
  } catch (e) { /* 保持与旧版一致的静默降级 */ }
}
function pushAllMovieScrapeResults(libId) {
  if (!libId) return;
  pushMovieScrapeResults(libId, Object.keys(readMovieMetadata()));
}
async function clearServerScrapeCache(libId) {
  if (!libId) return;
  try { await fetch(`/api/media/scrape-cache?id=${encodeURIComponent(libId)}`, { method: "DELETE", headers: sessionWriteHeaders(true), credentials: "same-origin" }); }
  catch (e) { /* 清不掉不影响本地重刮 */ }
}
async function loadScraperStatus() { try { const res = await fetch("/api/media/scrapers", { cache:"no-store" }); if (res.ok) scraperStatus = await res.json(); } catch(e) {} }
async function loadMediaRuntimeSettings(notify = false) {
  const status = document.getElementById("mediaRuntimeStatus");
  const hwStatus = document.getElementById("hardwareRuntimeStatus");
  try {
    const res = await fetch("/api/media/settings", { cache:"no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const c = await res.json();
    /* v0.9.75：读设置时同步刷新本机缓存的运行时配置（外网分享地址/TMDB 图片基址等），
       否则服务端改了配置而页面未重载时，分享仍用旧地址。 */
    scraperStatus = { ...scraperStatus, ...c, default: c.scraper_mode || scraperStatus.default };
    const values = { scrapeRegion:c.scrape_region || "auto", scrapeMinMatch:Math.round((Number(c.scrape_min_match) || 0.7) * 100), mediaScraperMode:c.scraper_mode, tmdbApiBase:c.tmdb_api_base, tmdbImageBase:c.tmdb_image_base, tvdbApiBase:c.tvdb_api_base, mediaCacheDir:c.cache_dir, mediaCacheMaxBytes:c.cache_max_bytes, mediaCacheMaxAge:c.cache_max_age_hours, mediaCacheCleanup:c.cache_cleanup_interval_hours, mediaPageCacheMaxBytes:c.page_cache_max_bytes, mediaScanMaxDepth:c.scan_max_depth, sharePublicBase:c.share_public_base || "" }; 
    Object.entries(values).forEach(([id,value]) => { const el=document.getElementById(id); if(el && value !== undefined) el.value=String(value); });
    const key=document.getElementById("tmdbApiKey"); if(key){ key.value=""; key.placeholder=c.tmdb_api_key_masked ? "已设置；留空保留" : "未设置"; }
    const tvdbKey=document.getElementById("tvdbApiKey"); if(tvdbKey){ tvdbKey.value=""; tvdbKey.placeholder=c.tvdb_api_key_masked ? "已设置；留空保留" : "未设置"; }
    const proxy=document.getElementById("scraperProxy"); if(proxy){ proxy.value=""; proxy.placeholder=c.scraper_proxy_configured ? `已配置 ${c.scraper_proxy_display||"代理"}；留空保留` : "例：http://192.0.2.10:7890"; proxy.dataset.configured=c.scraper_proxy_configured?"1":"0"; }
    if(status) status.textContent="✅ 已载入运行配置";
    if(hwStatus) hwStatus.textContent="✅ 已载入运行配置";
    if(notify) toast("✅ 已重新载入刮削与缓存设置");
  } catch(e) { if(status) status.textContent=`⚠ ${e.message}`; if(hwStatus) hwStatus.textContent=`⚠ ${e.message}`; if(notify) toast("⚠️ 设置读取失败"); }
}
async function saveMediaRuntimeSettings() {
  const value=id=>document.getElementById(id)?.value?.trim() || "";
  const proxyEl=document.getElementById("scraperProxy"), proxyValue=value("scraperProxy");
  const payload={ scraper_mode:value("mediaScraperMode")||"auto", scrape_region:value("scrapeRegion")||"auto", scrape_min_match:Math.max(30, Math.min(100, Number(value("scrapeMinMatch"))||70))/100, tmdb_api_key:value("tmdbApiKey"), tmdb_api_base:value("tmdbApiBase"), tmdb_image_base:value("tmdbImageBase"), tvdb_api_key:value("tvdbApiKey"), tvdb_api_base:value("tvdbApiBase"), scraper_proxy:proxyValue, scraper_proxy_set:!!proxyValue || proxyEl?.dataset.configured!=="1", share_public_base:value("sharePublicBase").trim(), share_public_base_set:true, cache_dir:value("mediaCacheDir"), cache_max_bytes:Number(value("mediaCacheMaxBytes")), cache_max_age_hours:Number(value("mediaCacheMaxAge")), cache_cleanup_interval_hours:Number(value("mediaCacheCleanup")), page_cache_max_bytes:Number(value("mediaPageCacheMaxBytes")||"0"), scan_max_depth:Number(value("mediaScanMaxDepth")||"0") };
  const status=document.getElementById("mediaRuntimeStatus"); const hwStatus=document.getElementById("hardwareRuntimeStatus"); if(status) status.textContent="保存中…"; if(hwStatus) hwStatus.textContent="保存中…";
  try { const res=await fetch("/api/media/settings",{method:"PUT",headers:sessionWriteHeaders(true),body:JSON.stringify(payload)}); const data=await res.json(); if(!res.ok) throw new Error(data.error||`HTTP ${res.status}`); scraperStatus={...scraperStatus,...data,default:data.scraper_mode}; await loadMediaRuntimeSettings(false); toast("✅ 运行配置已立即生效"); }
  catch(e){ if(status)status.textContent=`⚠ ${e.message}`; if(hwStatus)hwStatus.textContent=`⚠ ${e.message}`; toast("⚠️ 保存失败："+e.message); }
}
async function clearScraperProxy() {
  const proxy=document.getElementById("scraperProxy"); if(proxy){proxy.value="";proxy.dataset.configured="0";proxy.placeholder="保存后使用直连";} await saveMediaRuntimeSettings();
}
async function testScraperNetworks() {
  const button=document.getElementById("networkSpeedButton"), summary=document.getElementById("networkSpeedSummary"), host=document.getElementById("networkSpeedResults");
  if(button) button.disabled=true; if(summary) summary.textContent="测速中…"; if(host) host.innerHTML="";
  try { const res=await fetch("/api/media/network/speed",{method:"POST",headers:sessionWriteHeaders(true),body:"{}"}); const data=await res.json(); if(!res.ok)throw new Error(data.error||`HTTP ${res.status}`); const ok=(data.results||[]).filter(x=>x.ok).length; if(summary)summary.textContent=`${data.proxy_enabled?"代理":"直连"} · ${ok}/${data.results.length} 可达`; if(host)host.innerHTML=(data.results||[]).map(x=>`<div class="network-speed-item ${x.ok?"ok":"bad"}"><b>${esc(x.host)}</b><span>${x.ok?`${x.latency_ms} ms · HTTP ${x.status_code}`:esc(x.error||"失败")}</span></div>`).join(""); }
  catch(e){if(summary)summary.textContent=`⚠ ${e.message}`;toast("⚠️ 网络测速失败："+e.message);} finally {if(button)button.disabled=false;}
}
/* ==================== v0.9.84：影视刮削状态机 ====================
   客户反馈：「新增了部分不带元数据的视频文件，无法进行刮削」。
   旧实现的三个真实缺陷（已逐条实测确认）：
     1) 进库时就把所有待刮条目预写成「文件名展示（等待豆瓣刮削）」并落盘，
        随后才真正刮削；这一轮只要没刮到（TMDB 未命中 / 代理抖动 / 页面切走 /
        localStorage 写失败），路径已经进了缓存 → 下次进库 pending 为空 →
        永远不会再试，用户看到的就是「怎么点都不刮」。且没有任何重试入口
        （旧的 refreshMovieMetadata 是死代码，没绑到任何按钮）。
     2) 每刮到一条就整库重渲染一次：687 条就是 O(n²) 次海报墙重建，界面实质卡死。
     3) 刮削请求用 cache:"force-cache" —— 一次空结果会被浏览器缓存住，
        同一标题后续直接读缓存，永久失败。
   现在的做法：
     · 每条记录带 scrape_state：pending / ok / failed / skip，并记 attempts / last_attempt / reason；
     · failed 条目在下次进库自动重试（attempts < 3 且距上次 ≥ 10 分钟）；
     · 请求改 no-store；并发 3；渲染节流 400ms（只重建海报网格，不重建整页）；
     · 标题无意义的资源（纯数字片段等）标记 skip，不浪费请求；
     · 库标题右侧显示「刮削 n/m · x 待重试」，并提供「重新刮削 / 重试失败项」按钮。 */
const MOVIE_SCRAPE_MAX_ATTEMPTS = 3;
const MOVIE_SCRAPE_RETRY_MS = 10 * 60 * 1000;
const MOVIE_RENDER_THROTTLE_MS = 400;
const MOVIE_SCRAPE_CONCURRENCY = 3;
let movieRenderTimer = null;
let movieScrapeContext = null;

/* 文件名/目录名能否作为刮削查询词：纯数字或纯符号（蓝光片段 00011、音轨 01 等）不可能命中。 */
function scrapableMovieTitle(title) {
  const compact = String(title || "").replace(/[\s._\-—–·\[\]()（）【】]+/g, "");
  return compact.length >= 2 && /[A-Za-z\u4e00-\u9fff]/.test(compact);
}
function movieMetaState(meta) {
  if (!meta) return "pending";
  return String(meta.scrape_state || (meta.provider && meta.provider !== "文件名展示" ? "ok" : "pending"));
}
function movieScrapeStats(files) {
  const all = readMovieMetadata();
  const stats = { total: 0, ok: 0, failed: 0, pending: 0, skip: 0, review: 0 };
  (files || []).forEach((file) => {
    stats.total++;
    const state = movieMetaState(all[String((file && file.path) || file)]);
    if (state === "ok") stats.ok++;
    else if (state === "failed") stats.failed++;
    else if (state === "skip") stats.skip++;
    /* v0.9.89：review = 匹配度不足（等用户手动改名/调阈值后重刮），
       与 failed（网络/凭据问题，可自动重试）分开统计，避免吓人的「失败」数字。 */
    else if (state === "review") stats.review++;
    else stats.pending++;
  });
  return stats;
}
function movieScrapeSummary(files) {
  const s = movieScrapeStats(files);
  const parts = [`刮削 ${s.ok}/${s.total}`];
  if (s.pending) parts.push(`${s.pending} 排队中`);
  if (s.review) parts.push(`${s.review} 待确认`);
  if (s.failed) parts.push(`${s.failed} 待重试`);
  if (s.skip) parts.push(`${s.skip} 无可识别标题`);
  return parts.join(" · ");
}
/* v0.9.87（客户要求「刮削队列提示放到通知栏里面，不展示到媒体库中」）：
   队列状态只写通知中心（顶栏喇叭），库页不再有 #movieScrapeStatus 徽标。
   同一媒体库共用一个 key → 进度刷新只更新那一条，不刷屏。 */
function scrapeQueueKey(lib) {
  return `scrape-queue-${lib && lib.id != null ? lib.id : "all"}`;
}
function scrapeQueueNotice(files) {
  const list = files || (movieScrapeContext && movieScrapeContext.files) || [];
  if (!list.length) return;
  const lib = movieScrapeContext && movieScrapeContext.lib;
  const s = movieScrapeStats(list);
  const bits = [];
  if (s.ok) bits.push(`已刮削 ${s.ok}`);
  if (s.pending) bits.push(`排队中 ${s.pending}`);
  if (s.review) bits.push(`待确认 ${s.review}`);
  if (s.failed) bits.push(`待重试 ${s.failed}`);
  if (s.skip) bits.push(`无可识别标题 ${s.skip}`);
  const entry = {
    key: scrapeQueueKey(lib),
    level: s.failed ? "warn" : ((s.pending || s.review) ? "info" : "ok"),
    title: typeof tf === "function" ? tf("notifyScrapeQueue", { ok: s.ok, total: s.total }) : `刮削队列 ${s.ok}/${s.total}`,
    detail: [(lib && lib.name) || "", bits.join(" · ")].filter(Boolean).join(" · "),
    action: { view: "movie" }
  };
  if (typeof upsertNotification === "function") upsertNotification(entry);
  else if (typeof pushNotification === "function") pushNotification(entry);
}
function updateMovieScrapeStatus(files) {
  scrapeQueueNotice(files);
}
/* v0.9.88（客户要求「继续删除媒体库中的刮削设置按钮」）：媒体库页头不再有任何
   刮削按钮与刮削状态 —— 队列进度只出现在顶栏通知栏，刮削入口只在
   「系统设置 → 媒体库 → 已添加的媒体库」（⚡ 自动扫描 / ▤ 逐项扫描）。
   实现上直接删掉了 movieScrapeControls 及其两处调用，避免留一个恒空的容器。 */

/* ==================== v0.9.86：影视刮削入口（系统设置内） ====================
   客户要求：「影视界面中展示了很大的一个刮削按钮，给他迁移到
   系统设置 / 媒体库 / 已添加的媒体库 中进行自动 / 手动逐项扫描」。
   实现：
     · ⚡ 自动扫描 —— 整库逐项走既有刮削状态机（已成功/已放弃的项自动跳过）；
     · ▤ 逐项扫描 —— 弹窗列出条目，可单条刮削，或编辑名称 / 年份后重刮。
   进度写进 libraryScanState，库列表与弹窗都读它。
   ============================================================================ */
const libraryScanState = {};
function libraryScanStateOf(libId) { return libraryScanState[String(libId)] || null; }
function isScannableLibrary(lib) { return !!lib && (lib.type === "movie" || lib.type === "series"); }
/* 库列表「刮削」列的胶囊：影视库显示真实扫描状态，其它库保持原样。 */
function libraryScanPillHtml(lib) {
  if (!isScannableLibrary(lib)) return `<span class="pill info">按需读取</span>`;
  const st = libraryScanStateOf(lib.id);
  if (!st) return `<span class="pill info">待扫描</span>`;
  if (st.running) return `<span class="pill warn">扫描中 ${Number(st.done || 0)}/${Number(st.total || 0) || "?"}</span>`;
  if (st.message) return `<span class="pill bad" title="${esc(st.message)}">扫描失败</span>`;
  const parts = [`成功 ${Number(st.ok || 0)}`];
  if (st.failed) parts.push(`失败 ${st.failed}`);
  if (st.skip) parts.push(`跳过 ${st.skip}`);
  return `<span class="pill ${st.failed ? "warn" : "ok"}" title="共 ${Number(st.total || 0)} 项">${parts.join(" · ")}</span>`;
}
/* 取整库文件：影视库的刮削对象（含原盘片段合并）。 */
async function libraryScanLoadFiles(libId) {
  const lib = findMediaLibrary(libId);
  const res = await fetch(`/api/media/files?id=${encodeURIComponent(libId)}&offset=0&limit=500`, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const first = await res.json();
  let files = await fetchAllLibraryFiles(libId, first, 0);
  files = files.filter(file => supportedLocalMediaFile("movie", lib, String(file.path)));
  if (lib && lib.type !== "series") files = collapseDiscFragments(files);
  return files;
}
async function autoScanLibrary(libId) {
  const lib = findMediaLibrary(libId);
  if (!lib) { toast("⚠️ 媒体库不存在"); return; }
  if (!isScannableLibrary(lib)) { toast("该媒体库不是影视库，暂不支持刮削扫描"); return; }
  const prev = libraryScanStateOf(libId);
  if (prev && prev.running) { toast("该媒体库正在扫描中，请稍候"); return; }
  libraryScanState[libId] = { running: true, done: 0, total: 0, ok: 0, failed: 0, skip: 0, at: Date.now() };
  if (typeof renderHomeLibTable === "function") renderHomeLibTable();
  const savedCtx = movieScrapeContext;
  try {
    const files = await libraryScanLoadFiles(libId);
    const st = libraryScanState[libId];
    st.total = files.length;
    if (!files.length) { st.running = false; st.message = ""; toast("该媒体库暂无支持的影视文件"); return; }
    if (typeof renderHomeLibTable === "function") renderHomeLibTable();
    toast(`⚡ 自动扫描开始：${lib.name} · ${files.length} 项`);
    /* host 传 null：不在库页渲染，只走状态机 + 顶栏通知。 */
    await scrapeMovieMetadata(null, lib, files);
    const s = movieScrapeStats(files);
    Object.assign(libraryScanState[libId], { running: false, done: files.length, total: files.length, ok: s.ok, failed: s.failed, skip: s.skip, message: "" });
    toast(`✅ ${lib.name} 扫描完成：成功 ${s.ok} · 失败 ${s.failed} · 跳过 ${s.skip}`);
  } catch (e) {
    libraryScanState[libId] = { ...(libraryScanState[libId] || {}), running: false, message: e.message || "扫描失败" };
    toast("⚠️ 扫描失败：" + (e.message || e));
  } finally {
    movieScrapeContext = savedCtx;
    if (typeof renderHomeLibTable === "function") renderHomeLibTable();
    if (libraryItemScan.libId && String(libraryItemScan.libId) === String(libId)) renderLibraryItemScanBody();
    if (typeof refreshHomeData === "function") setTimeout(refreshHomeData, 800);
  }
}
/* ---------- 逐项扫描弹窗 ---------- */
const libraryItemScan = { libId: "", files: [], busy: "" };
function libraryItemScanTitle(path) {
  const meta = movieMetadataFor(path);
  return (meta && (meta.user_title || meta.title)) || movieTitleFromPath(path) || String(path).split("/").pop();
}
function libraryItemScanStateLabel(path) {
  const state = movieMetaState(movieMetadataFor(path));
  if (state === "ok") return "已刮削";
  if (state === "failed") return "上次失败（可重试）";
  if (state === "review") return "待确认（识别字符占比不足，可改名后重刮）";
  if (state === "skip") return "文件名无可用标题";
  return "待刮削";
}
async function openLibraryItemScan(libId) {
  const lib = findMediaLibrary(libId);
  if (!lib) { toast("⚠️ 媒体库不存在"); return; }
  if (!isScannableLibrary(lib)) { toast("该媒体库不是影视库，暂不支持逐项扫描"); return; }
  libraryItemScan.libId = String(libId);
  libraryItemScan.files = [];
  libraryItemScan.busy = "";
  const host = document.getElementById("libItemScanList");
  if (host) host.innerHTML = `<div class="empty-tip">正在读取媒体条目…</div>`;
  const hint = document.getElementById("libItemScanHint");
  if (hint) hint.textContent = `${lib.name} · 读取中…`;
  openModal("libItemScanModal");
  try {
    /* v0.9.88：逐项扫描前先合并服务端刮削结果，列表状态与库页一致。 */
    await hydrateMovieMetadataFromServer(libId);
    libraryItemScan.files = await libraryScanLoadFiles(libId);
  } catch (e) {
    if (host) host.innerHTML = `<div class="media-error">读取失败：${esc(e.message)}</div>`;
    return;
  }
  renderLibraryItemScanBody();
}
function renderLibraryItemScanBody() {
  const host = document.getElementById("libItemScanList");
  if (!host) return;
  const lib = findMediaLibrary(libraryItemScan.libId);
  const files = libraryItemScan.files || [];
  const hint = document.getElementById("libItemScanHint");
  if (hint) hint.textContent = `${lib ? lib.name : ""} · 共 ${files.length} 项 · 可单条「刮削」，或「✎ 编辑名称/年份」后重刮`;
  const stat = document.getElementById("libItemScanStat");
  if (stat) stat.textContent = movieScrapeSummary(files);
  if (!files.length) { host.innerHTML = `<div class="empty-tip">该媒体库暂无支持的影视文件</div>`; return; }
  host.innerHTML = files.map(file => {
    const path = String(file.path);
    const meta = movieMetadataFor(path);
    const state = movieMetaState(meta);
    const sub = [meta.year || "", libraryItemScanStateLabel(path)].filter(Boolean).join(" · ");
    const busy = libraryItemScan.busy === path;
    return `<div class="lib-scan-row${busy ? " busy" : ""}" data-scan-path="${esc(path)}" data-scan-state="${esc(state)}">
      <div class="lib-scan-name"><b>${esc(libraryItemScanTitle(path))}</b><small>${esc(sub)} · ${esc(path)}</small></div>
      <div class="row-acts">
        <button class="icon-btn" type="button" title="刮削此项" ${busy ? "disabled" : ""} onclick="scanLibraryEntry(${jsAttrArg(libraryItemScan.libId)},${jsAttrArg(path)})">${busy ? "…" : "🔍"}</button>
        <button class="icon-btn" type="button" title="编辑名称 / 年份后重刮" onclick="editLibraryEntry(${jsAttrArg(libraryItemScan.libId)},${jsAttrArg(path)})">✎</button>
      </div>
    </div>`;
  }).join("");
}
/* 单条刮削：清掉该条的刮削状态，保证用最新名称重走一遍。 */
async function scanLibraryEntry(libId, path) {
  const lib = findMediaLibrary(libId);
  if (!lib) return;
  const files = libraryItemScan.files || [];
  const file = files.find(f => String(f.path) === String(path)) || { path };
  const all = readMovieMetadata();
  if (all[path]) {
    all[path].scrape_attempts = 0;
    all[path].last_attempt = 0;
    delete all[path].scrape_state;
    delete all[path].reason;
    writeMovieMetadata(all);
  }
  libraryItemScan.busy = String(path);
  renderLibraryItemScanBody();
  try {
    await scrapeOneMovie(lib, files, file);
    if (typeof flushMovieMetadata === "function") flushMovieMetadata();
    /* v0.9.88：用户显式重刮单条 → replace=true（允许用新的结果覆盖服务端旧结果）。 */
    pushMovieScrapeResults(libId, [path], { replace: true });
  } catch (e) {
    toast("⚠️ 刮削失败：" + (e.message || e));
  } finally {
    libraryItemScan.busy = "";
    renderLibraryItemScanBody();
  }
}
/* 编辑名称 / 年份（复用媒体信息编辑弹窗），保存后自动按新名称重刮一次。 */
function editLibraryEntry(libId, path) {
  closeModal("libItemScanModal");
  openMediaMetadataEditor(libId, path);
}
/* v0.9.85：刮削信息进顶栏喇叭（通知中心）—— 开始 / 结果汇总 + 失败明细。 */
function notifyScrapeStart(lib, files, queued) {
  if (typeof pushNotification !== "function" || !queued) return;
  pushNotification({
    level: "info",
    title: typeof tf === "function" ? tf("notifyScrapeStart", { n: queued }) : `开始刮削 ${queued} 项`,
    detail: `${lib ? lib.name : "媒体库"} · ${movieScrapeSummary(files)}`,
    action: { view: "movie" }
  });
}
function notifyScrapeResult(lib, files, opts) {
  if (typeof pushNotification !== "function") return;
  const s = movieScrapeStats(files);
  /* 没有排队、也没有失败/跳过 → 不打扰用户。 */
  if (!(opts && opts.queued) && !s.failed && !s.skip) return;
  const all = readMovieMetadata();
  const details = [];
  files.forEach((file) => {
    const meta = all[String(file.path)];
    const state = movieMetaState(meta);
    if (state !== "failed" && state !== "skip") return;
    const title = (meta && meta.title) || String(file.path).split("/").pop();
    const reason = (meta && meta.reason) || (state === "skip" ? "文件名无可用标题" : "未命中（可重试）");
    details.push(typeof tf === "function" ? tf("notifyScrapeFailItem", { title, reason }) : `${title}：${reason}`);
  });
  pushNotification({
    level: details.length ? "warn" : "ok",
    title: typeof tf === "function" ? tf("notifyScrapeDone", { ok: s.ok, fail: s.failed, skip: s.skip }) : `刮削完成 ${s.ok}/${s.total}`,
    detail: (details.slice(0, 5).join("；") || "全部条目刮削成功") + (details.length > 5 ? `；（共 ${details.length} 条失败/跳过）` : ""),
    action: { view: "movie" }
  });
}
/* 节流渲染：只重建海报网格，保留分页与库标题（旧实现每条都重建整页）。 */
function scheduleMovieRender(delay) {
  if (movieRenderTimer) return;
  movieRenderTimer = setTimeout(() => {
    movieRenderTimer = null;
    renderMovieScrapeProgress();
  }, Number(delay) || MOVIE_RENDER_THROTTLE_MS);
}
function renderMovieScrapeProgress() {
  const ctx = movieScrapeContext;
  if (!ctx) return;
  const { host, lib, files } = ctx;
  if (!host) return;
  const grid = host.querySelector ? host.querySelector(".media-poster-grid") : null;
  if (grid && lib && lib.type !== "series") grid.innerHTML = files.map(file => renderMoviePoster(lib, file)).join("");
  else renderMovieLibraryContent(host, lib, files);
  updateMovieScrapeStatus(files);
}
/* ==================== v0.9.88：TMDB 标题匹配阈值（最低识别字符占比） ====================
   客户要求：「TMDB 刮削配置优化，无需对标题进行全量刮削（最低识别字符数量为 70%，
   如有异常后续进行手动调整命名进行辅助优化）」。
   旧实现是 `results.find(x => x.poster_path || x.overview || x.title || x.name)` ——
   压根不做比对，直接取 TMDB 返回的第一条带海报/简介的候选。中文库里
   「[发布组]Some.Movie.2021.WEB-DL」经常被对到同名短片、预告或另一部片，
   用户看到的就是「刮削信息不对」，实际根因是没有匹配判定。
   现在：对每个候选按「字符覆盖率 + 词元 + 二元组」打分，取 ≥ 阈值（默认 70%）的最高分；
   不到阈值就明确记「匹配度不足 n% ＜ 阈值」，用户在「逐项扫描 → ✎ 编辑名称」里
   手动补名后重刮（override 文件跨设备持久化）。
   评分对 title / original_title / name / original_name 取最大值 —— 切地区后 TMDB
   返回的是当地语言标题，原名往往才是资源名的来源。
   ============================================================================ */
const DEFAULT_SCRAPE_MIN_MATCH = 0.7;
function scrapeMinMatchThreshold() {
  const v = Number((scraperStatus && scraperStatus.scrape_min_match) || 0);
  if (!Number.isFinite(v) || v <= 0) return DEFAULT_SCRAPE_MIN_MATCH;
  return Math.min(1, Math.max(0.3, v));
}
/* 归一化：NFKC（全角→半角）、去发布规格噪声与年份、只留字母/数字/中日韩字符。 */
function titleNormalized(value) {
  let s = String(value == null ? "" : value);
  try { s = s.normalize("NFKC"); } catch (e) { /* 老浏览器不支持 NFKC：原样处理 */ }
  return s.toLowerCase()
    .replace(MOVIE_NOISE_RE, " ")
    .replace(/(19|20)\d{2}/g, " ")
    .replace(/[^0-9a-z\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function titleTokens(value) {
  const n = titleNormalized(value);
  if (!n) return [];
  /* 纯中文/日文标题没有词边界，按单字切；拉丁标题按空格切。 */
  return /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(n) && !n.includes(" ") ? n.split("") : n.split(" ");
}
function titleBigrams(value) {
  const s = titleNormalized(value).replace(/\s+/g, "");
  const out = new Set();
  for (let i = 0; i + 1 < s.length; i++) out.add(s.slice(i, i + 2));
  if (!out.size && s) out.add(s);
  return out;
}
function titleCharSet(value) { return new Set(titleNormalized(value).replace(/\s+/g, "").split("").filter(Boolean)); }
function setDice(a, b) {
  if (!a.size || !b.size) return 0;
  let hit = 0;
  a.forEach(x => { if (b.has(x)) hit++; });
  return (2 * hit) / (a.size + b.size);
}
function setCoverage(query, cand) {
  if (!query.size) return 0;
  let hit = 0;
  query.forEach(c => { if (cand.has(c)) hit++; });
  return hit / query.size;
}
/* 打分：0.50 × 双向字符覆盖率 + 0.20 × 词元 Dice + 0.30 × 二元组 Dice。
   · 覆盖率取双向最大：资源名带「第二部 / Part Two / 剧场版」等后缀时也应命中正片；
   · 词元 Dice 同时按「按字切」与「按空格切」算，取较大值 —— 中文标题没有词边界，
     只按一种切法会把「阿凡达」对「阿凡达：水之道」判成低分（实测 0.62 会误杀）；
   · 覆盖率权重最高，是因为「70% 字符能对上」正是客户要的语义。 */
/* v0.9.89（客户：「本功能原意即用于辅助刮削和优化刮削体验」）：
   打分同时给出两个量 —— coverage（识别字符占比）与 score（综合分）。
   命中判据以 coverage 为主口径（= 客户说的「最低识别字符数量 70%」），
   综合分只用于在多个候选里挑更好的那个，不再当第二道卡死条件；
   两者任一达标即视为命中 —— 阈值因此是「辅助」而不是「阻塞」。 */
function titleMatchDetail(query, candidate) {
  const qc = titleCharSet(query), cc = titleCharSet(candidate);
  if (!qc.size || !cc.size) return { score: 0, coverage: 0 };
  const coverage = Math.max(setCoverage(qc, cc), setCoverage(cc, qc));
  const spaceDice = setDice(new Set(titleTokens(query)), new Set(titleTokens(candidate)));
  const charDice = setDice(qc, cc);
  const tokenDice = Math.max(spaceDice, charDice);
  const bigramDice = setDice(titleBigrams(query), titleBigrams(candidate));
  const score = 0.50 * coverage + 0.20 * tokenDice + 0.30 * bigramDice;
  return { score: Math.max(0, Math.min(1, score)), coverage: Math.max(0, Math.min(1, coverage)) };
}
function titleMatchScore(query, candidate) {
  return titleMatchDetail(query, candidate).score;
}
function itemTitleForms(item) {
  if (!item) return [];
  return [item.title, item.original_title, item.name, item.original_name]
    .map(v => String(v == null ? "" : v).trim()).filter(Boolean);
}
function itemYear(item) {
  const raw = (item && (item.release_date || item.first_air_date || item.year)) || "";
  const m = String(raw).match(/(19|20)\d{2}/);
  return m ? m[0] : "";
}
function queryYear(query, fallback) {
  const m = String(query || "").match(/(19|20)\d{2}/);
  return m ? m[0] : String(fallback || "");
}
/* 候选打分：返回 {item, score, threshold, matched}；没有可用候选时返回 null。 */
function pickTitleMatch(results, query, opts) {
  const list = Array.isArray(results) ? results : [];
  const threshold = Number((opts && opts.threshold) || 0) || scrapeMinMatchThreshold();
  const wantYear = queryYear(query, opts && opts.year);
  let best = null;
  list.forEach((item) => {
    const forms = itemTitleForms(item);
    if (!forms.length) return;
    let detail = { score: 0, coverage: 0 };
    forms.forEach((f) => {
      const d = titleMatchDetail(query, f);
      if (d.coverage > detail.coverage || (d.coverage === detail.coverage && d.score > detail.score)) detail = d;
    });
    let score = detail.score;
    /* 年份是稳定的纠偏信号：同年 +5%，差一年以上 -15%（同名不同年代的作品）。 */
    const year = itemYear(item);
    if (wantYear && year) {
      if (year === wantYear) score += 0.05;
      else if (Math.abs(Number(year) - Number(wantYear)) > 1) score -= 0.15;
    }
    score = Math.max(0, Math.min(1, score));
    if (!best || score > best.score) best = { item, score, coverage: detail.coverage, name: forms[0] };
  });
  if (!best) return null;
  return { ...best, threshold, matched: best.coverage >= threshold || best.score >= threshold };
}
/* 失败原因带上最高匹配度：用户一眼分清是「标题对不上」还是「网络/凭据」问题。 */
/* v0.9.89：未命中的原因按「有没有可比对的候选」分开写，不再出现
   「最高 0%」这种让人以为程序坏了的文案（0% 其实是「候选与资源名毫无共同字符」）。 */
function titleMatchReason(best, threshold) {
  const need = Math.round((threshold || scrapeMinMatchThreshold()) * 100);
  if (!best) return `未命中：TMDB 没有返回候选 · 已按文件名展示`;
  const cov = Math.round(Number(best.coverage || 0) * 100);
  if (cov <= 0) return `未命中：候选标题与资源名没有共同字符 · 已按文件名展示 · 可在「逐项扫描 → ✎ 编辑名称」后重刮`;
  return `识别字符占比 ${cov}%（＜ ${need}%）· 未采用，已按文件名展示 · 可在「逐项扫描 → ✎ 编辑名称」后重刮`;
}

/* v0.9.89：刮削没拿到结果时，区分「网络/凭据问题」（failed，可自动重试）
   与「匹配度不足」（review，等用户手动改名或调阈值 —— 客户要的辅助模式）。
   旧实现一律记 failed，于是整库匹配不上时通知栏一片「待重试」。 */
function movieScrapeRecordedReason(path) {
  const rec = readMovieMetadata()[path];
  return String((rec && rec.reason) || "");
}
function movieFallbackState(path) {
  const reason = movieScrapeRecordedReason(path);
  return /请求失败|凭据|网络|超时|HTTP 5|HTTP 4/.test(reason) ? "failed" : "review";
}
function movieFallbackReason(path) {
  const reason = movieScrapeRecordedReason(path);
  if (reason) return reason;
  return "未命中：已按文件名展示 · 可在「逐项扫描 → ✎ 编辑名称」后重刮";
}

/* ================= v0.9.89：刮削结果本地化（NFO + 图片落盘） =================
   客户第 2、3 项：刮削拿到完整元数据后先把数据本地化，再展示给界面；
   此后任何一次进库（含换设备、清缓存、重建索引）都直接读媒体目录里的
   NFO 与本地图片，不再整库联网重复刮削。
   · 图片：POST /api/media/cover {role} → 落到媒体目录（读取端认得的 sidecar 名）；
   · NFO：POST /api/media/nfo → Kodi / Emby / Jellyfin 通用 XML 写到媒体文件旁边；
   · 串行执行 + 每条只做一次（localized_at 标记）；失败不影响刮削结果本身。 */
const MOVIE_LOCALIZE_ROLES = ["poster", "fanart", "backdrop", "logo"];
let movieLocalizeQueue = [];
let movieLocalizeBusy = false;
function queueMovieLocalization(lib, path) {
  if (!lib || !lib.id || !path) return;
  const meta = readMovieMetadata()[String(path)];
  if (meta && meta.localized_at && meta.nfo) return; // 已本地化过，不重复写盘
  const key = `${lib.id}|${path}`;
  if (movieLocalizeQueue.some((x) => x.key === key)) return;
  movieLocalizeQueue.push({ key, lib, path: String(path) });
  pumpMovieLocalization();
}
/* v0.9.89：已刮削条目的本地化回填。
   客户库里的历史刮削结果（服务端结果库存量几百条）本版之前没有本地化产物，
   如果只对新刮削的条目做本地化，老库要重刮一次才生效 —— 所以进库时把
   「已刮削但还没有 NFO/本地图」的条目排队补做，每条只做一次（localized_at 标记）。
   串行执行 + 单次进库限量，避免一口气写上千个文件把磁盘和界面拖住。 */
const MOVIE_LOCALIZE_BACKLOG_PER_VISIT = 60;
function queueLocalizationBacklog(lib, files) {
  if (!lib || !lib.id) return 0;
  const all = readMovieMetadata();
  let queued = 0;
  for (const file of files || []) {
    if (queued >= MOVIE_LOCALIZE_BACKLOG_PER_VISIT) break;
    const path = String((file && file.path) || file);
    const meta = all[path];
    if (!meta) continue;
    if (movieMetaState(meta) !== "ok") continue;
    if (meta.localized_at && meta.nfo) continue;
    queueMovieLocalization(lib, path);
    queued++;
  }
  return queued;
}
async function pumpMovieLocalization() {
  if (movieLocalizeBusy) return;
  movieLocalizeBusy = true;
  try {
    while (movieLocalizeQueue.length) {
      const job = movieLocalizeQueue.shift();
      try { await localizeMovieEntry(job.lib, job.path); } catch (e) { console.info("[scrape] 本地化失败：", job.path, e); }
      scheduleMovieRender(MOVIE_RENDER_THROTTLE_MS);
    }
  } finally { movieLocalizeBusy = false; }
}
/* 额外 NFO 目标：剧集写 show 根 tvshow.nfo（上一层）；电影写 movie.nfo（同目录）。
   读取端候选顺序是 <文件名>.nfo → movie.nfo / tvshow.nfo，写这两处即可被读回。 */
function movieNFOExtras(lib, path) {
  if (lib && lib.type === "series") return [{ name: "tvshow.nfo", up: 1 }];
  return [{ name: "movie.nfo", up: 0 }];
}
async function localizeMovieEntry(lib, path) {
  const all = readMovieMetadata();
  const meta = all[path] || movieBaseMetadata(path);
  if (movieMetaState(meta) !== "ok") return;
  const stored = {};
  for (const role of MOVIE_LOCALIZE_ROLES) {
    const url = String(meta[role] || "");
    if (!url || url.startsWith("/api/media/")) continue; // 已经是站内本地图，不用再下
    try {
      const res = await fetch("/api/media/cover", {
        method: "POST", credentials: "same-origin", cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: lib.id, path, url, role }),
      });
      if (!res.ok) continue;
      const data = await res.json();
      if (data && data.url) stored[role] = data.url;
    } catch (e) { /* 单张图失败不影响其它角色与 NFO */ }
  }
  let nfo = "";
  try {
    const res = await fetch("/api/media/nfo", {
      method: "POST", credentials: "same-origin", cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: lib.id, path: path, extras: movieNFOExtras(lib, path),
        meta: {
          title: meta.user_title || meta.title || movieTitleFromPath(path),
          original_title: meta.original_title || "",
          show_title: meta.show_title || "",
          year: String(meta.year || ""),
          overview: meta.overview || "",
          rating: Number(meta.rating || 0),
          runtime: Number(meta.runtime || 0),
          genres: Array.isArray(meta.genres) ? meta.genres : [],
          cast: Array.isArray(meta.cast) ? meta.cast.slice(0, 40) : [],
          tmdb_id: meta.tmdb_id != null ? String(meta.tmdb_id) : "",
          tvdb_id: meta.tvdb_id != null ? String(meta.tvdb_id) : "",
          poster: stored.poster || meta.poster || "",
          fanart: stored.fanart || meta.fanart || "",
          backdrop: stored.backdrop || meta.backdrop || "",
          logo: stored.logo || meta.logo || "",
        },
      }),
    });
    if (res.ok) { const data = await res.json(); nfo = String((data && data.nfo) || ""); }
  } catch (e) { /* NFO 写失败（只读挂载等）不影响展示 */ }
  const fresh = readMovieMetadata();
  const merged = { ...(fresh[path] || meta), original_path: String(path), localized_at: Date.now() };
  MOVIE_LOCALIZE_ROLES.forEach((role) => { if (stored[role]) merged[role] = stored[role]; });
  if (nfo) merged.nfo = nfo;
  fresh[path] = merged;
  writeMovieMetadata(fresh);
}

/* v0.9.90：剧集条目的「分集名」取文件名解析结果（show_title 存在时 title 视为分集名）。
   修「刮削后仍显示文件名解析出的剧名」问题的配套函数。 */
function seriesEpisodeTitleOf(path) {
  try {
    const parsed = parseSeriesEpisode(path);
    return String((parsed && parsed.title) || "").trim();
  } catch (e) { return ""; }
}
/* 单条刮削：返回是否成功。所有请求用 no-store —— 空结果不再被浏览器缓存成永久失败。 */
async function scrapeOneMovie(lib, files, file) {
  const all = readMovieMetadata();
  const path = String(file.path);
  const base = all[path] || movieBaseMetadata(path);
  /* v0.9.86：用户在「编辑媒体信息」里填的名称优先当搜索词（辅助刮削），
     没有手工名称时才回落到解析/刮削出来的标题。 */
  const title = base.user_title || base.title || movieTitleFromPath(path);
  const mediaType = lib && lib.type === "series" ? "series" : "movie";
  const attempts = Number(base.scrape_attempts || 0) + 1;
  const mode = scraperStatus.scraper_mode || scraperStatus.default || "auto";
  const mark = (patch) => {
    all[path] = { ...base, ...patch, scrape_attempts: attempts, last_attempt: Date.now() };
    writeMovieMetadata(all);
    /* v0.9.89：命中即本地化 —— 图片落盘 + 写 NFO，让下一次进库（含换设备/换浏览器）
       直接读媒体目录里的本地元数据，不再整库联网刮削。串行队列，避免并发写盘风暴。 */
    if (patch.scrape_state === "ok") queueMovieLocalization(lib, path);
    return patch.scrape_state === "ok";
  };
  /* 文件名没有任何可识别标题（原盘片段、音轨编号等）→ 不发请求，标记 skip，
     但要把它列为「无可识别标题」而不是假装刮过。 */
  if (!scrapableMovieTitle(title)) {
    return mark({ provider: base.provider || "文件名展示", scrape_state: "skip", reason: "文件名无可用标题" });
  }
  const note = (reason) => { const c = readMovieMetadata(); c[path] = { ...(c[path] || base), reason, scrape_attempts: attempts, last_attempt: Date.now() }; writeMovieMetadata(c); };
  if (mediaType === "series" && mode === "auto" && scraperStatus.tvdb_enabled) {
    try {
      const tvdb = await fetch(`/api/media/tvdb?query=${encodeURIComponent(title)}`, { cache: "no-store", credentials: "same-origin" });
      if (tvdb.status === 401 || tvdb.status === 403) note("TVDB 凭据无效");
      const tvdbList = tvdb.ok ? (((await tvdb.json()) || {}).results || []) : [];
      const tvdbBest = pickTitleMatch(tvdbList, title, { year: base.year });
      const item = tvdbBest && tvdbBest.matched ? tvdbBest.item : null;
      if (!item && tvdbList.length) note(titleMatchReason(tvdbBest, scrapeMinMatchThreshold()));
      if (item) {
        const tvdbName = String(item.name || item.title || "").trim();
        return mark({
          tvdb_id: item.id, media_type: mediaType,
          /* v0.9.90：剧集把「当前选中语言」刮到的剧名写入 show_title ——
             剧集卡片与播放器标题优先用它，不再回落到文件名解析值
             （例如「康熙王朝.Kang.Xi.Kingdom.S01E01…」旧显示「康熙王朝 Kang Xi Kingdom」，
             现在显示 TMDB 中文命名「康熙王朝」）。 */
          show_title: mediaType === "series" ? (tvdbName || base.show_title || "") : (base.show_title || ""),
          title: (mediaType === "series" ? (seriesEpisodeTitleOf(path) || tvdbName) : tvdbName) || title,
          year: String(item.first_air_date || base.year).slice(0, 4),
          poster: item.poster_path || "", overview: item.overview || "",
          provider: "TVDB · 剧集", checkedAt: Date.now(), scrape_state: "ok", reason: "",
        });
      }
    } catch (e) { note("TVDB 请求失败"); }
  }
  if ((mode === "auto" || mode === "tmdb") && scraperStatus.tmdb_enabled) {
    try {
      const tmdb = await fetch(`/api/media/tmdb?query=${encodeURIComponent(title)}&type=${encodeURIComponent(mediaType)}&lang=${tmdbLangTag()}`, { cache: "no-store", credentials: "same-origin" });
      if (tmdb.status === 401 || tmdb.status === 403) note("TMDB 凭据无效（系统设置 → 刮削里换成 v3 Key 或 v4 Token）");
      const data = tmdb.ok ? await tmdb.json() : null;
      const candidates = data && Array.isArray(data.results)
        ? data.results.filter(x => x && (x.poster_path || x.overview || x.title || x.name)) : [];
      const best = pickTitleMatch(candidates, title, { year: base.year });
      const item = best && best.matched ? best.item : null;
      if (item) {
        const imgBase = scraperStatus.tmdb_image_base || "https://image.tmdb.org/t/p";
        /* v0.9.90：剧名取当前语言（tmdbLangTag()）的 TMDB 命名，写入 show_title。 */
        const tmdbName = String(item.name || item.title || "").trim();
        return mark({
          tmdb_id: item.id, media_type: mediaType,
          show_title: mediaType === "series" ? (tmdbName || base.show_title || "") : (base.show_title || ""),
          original_title: String(item.original_name || item.original_title || base.original_title || "").trim(),
          title: (mediaType === "series" ? (seriesEpisodeTitleOf(path) || tmdbName) : (item.title || item.name)) || title,
          year: String(item.release_date || item.first_air_date || base.year).slice(0, 4),
          poster: item.poster_path ? `${imgBase}/w342${item.poster_path}` : "",
          backdrop: item.backdrop_path ? `${imgBase}/w1280${item.backdrop_path}` : "",
          overview: item.overview || "", rating: Number(item.vote_average || 0),
          provider: mediaType === "series" ? "TMDB · 剧集" : "TMDB · 电影",
          tmdb_title: best ? String(best.name || "").slice(0, 200) : "",
          match_score: best ? Math.round(best.score * 100) / 100 : 0,
          checkedAt: Date.now(), scrape_state: "ok", reason: "",
        });
      }
      /* v0.9.88：有候选但都低于阈值 → 记「匹配度不足 n%」，而不是笼统的「未命中」；
         完全没有候选才是真的未命中。这条 later 会被下面的 mark() 原样保留。 */
      if (candidates.length) note(titleMatchReason(best, scrapeMinMatchThreshold()));
      else note("TMDB 未命中该标题");
    } catch (e) { note("TMDB 请求失败：" + (e && e.message ? e.message : "网络错误")); }
  } else if (mode === "auto" || mode === "tmdb") {
    note("未配置 TMDB 凭据");
  }
  if (mode === "tmdb" || mode === "filename") {
    return mark({ provider: "文件名展示", scrape_state: movieFallbackState(path), reason: movieFallbackReason(path) });
  }
  try {
    const douban = await fetch(`https://movie.douban.com/j/subject_suggest?q=${encodeURIComponent(title)}`, { cache: "no-store" });
    const item = douban.ok ? (await douban.json())?.[0] : null;
    if (item) {
      const doubanName = String(item.title || "").trim();
      return mark({
        show_title: mediaType === "series" ? (doubanName || base.show_title || "") : (base.show_title || ""),
        title: (mediaType === "series" ? (seriesEpisodeTitleOf(path) || doubanName) : doubanName) || title,
        year: item.year || base.year, poster: item.img || "", provider: "豆瓣", checkedAt: Date.now(), scrape_state: "ok", reason: "",
      });
    }
  } catch (e) { /* 豆瓣无 CORS，浏览器直连基本必失败 → 记失败原因，交给下次重试 */ }
  return mark({ provider: "文件名展示", scrape_state: movieFallbackState(path), reason: movieFallbackReason(path) });
}
async function scrapeMovieMetadata(host, lib, files) {
  await loadScraperStatus();
  movieScrapeContext = { host, lib, files };
  /* v0.9.88：先吃服务端持久化的刮削结果 —— 换浏览器/换设备/重复进库都不会
     再把已刮削的条目重新排进队列（这正是「多次批量重复读取」的来源）。 */
  let hydrated = false;
  if (lib && lib.id) hydrated = await hydrateMovieMetadataFromServer(lib.id);
  const all = readMovieMetadata();
  if (hydrated) { renderMovieScrapeProgress(); }
  /* v0.9.89：把历史刮削结果补做本地化（图片 + NFO），不必整库重刮。 */
  const backfilled = queueLocalizationBacklog(lib, files);
  if (backfilled) console.info(`[scrape] 本地化回填：${backfilled} 条已刮削条目排队写 NFO / 本地图`);
  const localPaths = new Set();
  const applyLocal = (path, local) => {
    if (!local || !(local.nfo || local.poster || local.logo || local.fanart || local.backdrop || local.tags?.length || local.watched || local.subtitles?.length)) return;
    all[path] = {
      ...movieBaseMetadata(path), ...(all[path] || {}), ...local,
      title: local.title || (all[path] && all[path].title) || movieBaseMetadata(path).title,
      provider: local.provider || "本地元数据",
      media_type: lib?.type === "series" ? "series" : "movie",
      checkedAt: Date.now(), scrape_state: "ok", reason: "",
    };
    /* v0.9.92：本地 NFO 只有 title（旧口径）时补出剧名，卡片才显示刮削名而不是文件名。 */
    repairSeriesShowTitle(lib?.id, all[path], path);
    localPaths.add(path);
  };
  /* v0.9.90：本地元数据水合由「每个文件一次串行请求」改为批量（200 条/次）。
     旧实现进一次影视库要发 1000+ 次请求，是「链接大媒体库后非常慢」的主因之一。 */
  const allPaths = files.map(file => String(file.path));
  for (let i = 0; i < allPaths.length; i += 200) {
    const batch = allPaths.slice(i, i + 200);
    let items = null;
    try {
      const res = await fetch("/api/media/metadata/batch", {
        method: "POST", cache: "no-store", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: lib.id, paths: batch }),
      });
      if (res.ok) items = (await res.json()).items || null;
    } catch (e) { /* 批量接口异常 → 回落到逐条 */ }
    if (!items) {
      for (const path of batch) {
        try {
          const res = await fetch(`/api/media/metadata?id=${encodeURIComponent(lib.id)}&path=${encodeURIComponent(path)}`, { cache: "no-store" });
          applyLocal(path, res.ok ? await res.json() : null);
        } catch (e) { /* 本地元数据缺失不是错误：继续走在线刮削 */ }
      }
      continue;
    }
    Object.entries(items).forEach(([path, local]) => applyLocal(path, local));
  }
  writeMovieMetadata(all);
  if (localPaths.size) renderMovieScrapeProgress();
  /* 待刮队列：没有记录、或上次失败且还在重试窗口内（attempts<3、间隔≥10 分钟）。
     旧实现把「没有记录」当唯一条件，一次失败即永久放弃，这里改成可重试状态机。 */
  const now = Date.now();
  const pending = files.filter((file) => {
    const path = String(file.path);
    if (localPaths.has(path)) return false;
    const meta = all[path];
    if (!meta) return true;
    const state = movieMetaState(meta);
    /* v0.9.89：review（待确认）不自动重试 —— 客户要的是「异常时手动改名辅助」，
       否则整库匹配不上时会反复批量联网（正是要避免的重复刮削）。 */
    if (state === "ok" || state === "skip" || state === "review") return false;
    const attempts = Number(meta.scrape_attempts || 0);
    const last = Number(meta.last_attempt || 0);
    return attempts < MOVIE_SCRAPE_MAX_ATTEMPTS && (now - last) >= MOVIE_SCRAPE_RETRY_MS;
  });
  updateMovieScrapeStatus(files);
  if (!pending.length) { notifyScrapeResult(lib, files, { queued: 0 }); return; }
  notifyScrapeStart(lib, files, pending.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < pending.length) {
      const file = pending[cursor++];
      try { await scrapeOneMovie(lib, files, file); } catch (e) { console.warn("[scrape] 单条刮削失败", file && file.path, e); }
      scheduleMovieRender(MOVIE_RENDER_THROTTLE_MS);
    }
  };
  await Promise.all(Array.from({ length: Math.min(MOVIE_SCRAPE_CONCURRENCY, pending.length) }, worker));
  if (movieRenderTimer) { clearTimeout(movieRenderTimer); movieRenderTimer = null; }
  renderMovieScrapeProgress();
  flushMovieMetadata();
  updateMovieScrapeStatus(files);
  /* v0.9.88：整批结果一次性写回服务端（批量一条请求，而不是每条一次）。 */
  pushMovieScrapeResults(lib && lib.id, pending.map(file => String(file.path)));
  /* v0.9.85：刮削结束写一条通知（含失败/跳过明细），顶栏喇叭可见。 */
  notifyScrapeResult(lib, files, { queued: pending.length });
}
/* v0.9.17：媒体库标题只展示添加媒体库时填写的库名称，
   不再显示「电影 / 电视剧集 / 电子书 / 漫画 / 音乐与 MV」这类预设大类名。 */
function mediaLibraryHeading(lib, badge, extra = "") {
  const name = String(lib?.name || "").trim() || t("libNavEmpty");
  return `<div class="content-section-heading"><div><span class="eyebrow">我的媒体库</span><h3>${esc(name)}</h3></div>${extra}${badge ? `<span class="badge">${esc(badge)}</span>` : ""}</div>`;
}
function renderMovieLibraryContent(host, lib, files) {
  if (lib?.type === "series") return renderSeriesLibraryContent(host, lib, files);
  const body = `<div class="media-poster-grid">${files.map(file => renderMoviePoster(lib, file)).join("")}</div>`;
  host.innerHTML = `<section class="content-collection">${mediaLibraryHeading(lib, `${files.length} 部`)}${body}</section>`;
}
function renderSeriesLibraryContent(host, lib, files) {
  const shows = buildSeriesShows(files); shows.forEach(show => rememberSeriesShow(lib.id, show));
  const body = shows.length ? `<div class="series-show-grid">${shows.map(show => renderSeriesShowCard(lib, show)).join("")}</div>` : '<div class="empty-tip">该电视剧库暂无支持的剧集文件</div>';
  host.innerHTML = `<section class="content-collection">${mediaLibraryHeading(lib, `${shows.length} 部剧 · ${files.length} 集`)}${body}</section>`;
}
/* v0.9.83：剧集详情读的是缓存态结构（seriesShowCacheShape 只保留首个文件用于定位），
   因此集数、集路径一律以 seasonList 汇总，避免详情里出现「共1集」这种明显错数，
   也避免只给第一集写评分 / 简介元数据。 */
function seriesShowEpisodePaths(show) {
  const out = [];
  ((show && Array.isArray(show.seasonList)) ? show.seasonList : []).forEach(s => {
    ((s && Array.isArray(s.episodes)) ? s.episodes : []).forEach(ep => { const p = ep && ep.path ? String(ep.path) : ""; if (p) out.push(p); });
  });
  if (!out.length) ((show && Array.isArray(show.files)) ? show.files : []).forEach(f => { const p = f && f.path ? String(f.path) : ""; if (p) out.push(p); });
  return out;
}
function seriesShowEpisodeCount(show) { return seriesShowEpisodePaths(show).length; }
function seriesShowSeasonCount(show) {
  const n = (show && Array.isArray(show.seasonList)) ? show.seasonList.length : 0;
  if (n) return n;
  return seriesShowEpisodePaths(show).length ? 1 : 0;
}
function renderSeriesShowCard(lib, show) { const art=show.poster?`<img src="${esc(coverThumbUrl(show.poster, 320))}" alt="${esc(show.title)}" loading="lazy" decoding="async">`:`<span>${esc(show.title)}</span>`; const seasons=show.seasonList?.length||0, episodes=show.files?.length||0; return `<article class="media-poster-card series-show-card" data-series-show="${esc(show.key)}" onclick="openSeriesDetails(${jsAttrArg(lib.id)},${jsAttrArg(show.key)})"><div class="media-poster-art" style="${show.poster?"":`background:${coverGradient(show.title)}`}">${art}</div><div class="media-poster-info"><strong>${esc(show.title)}</strong><small>${esc([show.year, seasons?`${seasons} 季`:"", episodes?`共${episodes}集`:""].filter(Boolean).join(" · "))}</small></div></article>`; }
/* v0.9.56：影视详情右上角关闭按钮按语境返回 ——
   剧集详情/电影详情下显示「返回媒体库」；单集详情查看时显示「返回详情」（回到剧集详情页）。 */
let activeSeriesDetail = null;  // 最近一次打开的剧集详情 {libId, showKey}
let seriesEpisodeReturn = null; // 单集详情返回目标（返回详情 = 回到该剧集详情页）
function movieDetailCloseButton() {
  const ep = seriesEpisodeReturn;
  const arrow = '<svg class="vc-svg" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M19 12H5m6-6-6 6 6 6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  /* v0.9.57：圆形按钮放不下「✕ 返回媒体库」长文案，文字溢出穿模 →
     改为横向药丸（返回箭头 + 中文），宽度随内容自适应，圆角胶囊样式。 */
  return ep
    ? `<button class="movie-return-pill" title="返回剧集详情" onclick="closeEpisodeDetail()">${arrow}返回详情</button>`
    : `<button class="movie-return-pill" title="关闭并返回媒体库" onclick="closeMovieDetails()">${arrow}返回媒体库</button>`;
}
function openEpisodeDetails(libId, path) {
  const s = activeSeriesDetail;
  seriesEpisodeReturn = s && s.libId === libId ? { libId: s.libId, showKey: s.showKey } : null;
  /* v0.9.80 单集详情网格：定位该单集所在季，把同季其它集以「X排Y列」网格展示集略缩图。 */
  try {
    if (s && s.libId === libId) {
      const show = readSeriesShow(libId, s.showKey);
      const p = parseSeriesEpisode(path);
      const season = (show?.seasonList||[]).find(se => se.season === p.season);
      const posters = show?.poster || show?.fanart || "";
      window.__activeEpisodeCtx = {
        libId, showKey: s.showKey, showTitle: show?.title||"", seasonNum: p.season,
        path, episodes: (season?.episodes||[]).map(ep => ({ path: ep.path, label: ep.parsed?.label || ep.label || String(ep.path).split("/").pop(), title: (ep.meta?.title||ep.parsed?.title)||null, thumb: posters||(ep.meta?.poster||"") }))
      };
    } else { window.__activeEpisodeCtx = null; }
  } catch(e) { window.__activeEpisodeCtx = null; }
  openMovieDetails(libId, path);
}
function closeEpisodeDetail() {
  const target = seriesEpisodeReturn;
  seriesEpisodeReturn = null;
  closeMovieDetails();
  if (target) openSeriesDetails(target.libId, target.showKey);
}
async function openSeriesDetails(libId, showKey) { enterMovieDetailSidebarMode(); const lib=findMediaLibrary(libId), viewer=document.getElementById("local-media-viewer-movie"); if(!lib||!viewer)return; const show=readSeriesShow(libId,showKey); if(!show)return; activeSeriesDetail={libId, showKey}; seriesEpisodeReturn=null; const hero={title:show.title,overview:seriesHeroOverview(show),scrape_ok:hasScrapedInfo(show),poster:show.poster,logo:show.logo,fanart:show.fanart,backdrop:show.backdrop,year:show.year,provider:show.provider,watched:show.watched,media_type:"series"}; /* v0.9.51：进入剧集详情即把该剧的分集按季/集顺序设为播放队列，
     这样播放器的「上一个 / 下一个 / 播放列表」走的是同一部剧而不是整库。 */
  setVideoPlaylist(libId, (show.seasonList||[]).flatMap(season=>(season.episodes||[]).map(ep=>({path:ep.path}))));
  const firstPath = show.files?.[0]?.path || "";
  /* v0.9.81：剧集详情顺序 —— 视频介绍(hero) → 演职人员(网格头像) → 视频推荐(网格略缩图) → 季度(网格集数) → 视频信息(底部)。 */
  const renderPage = (extras) => {
    const meta = { ...hero, ...(extras||{}) };
    const seasons = (show.seasonList||[]).map(season => renderSeriesSeasonCard(lib, show, season)).join("");
    viewer.innerHTML = `<div class="media-reader-overlay movie-detail-page series-detail-page media-detail-backdrop" style="${esc(detailBackdropStyle(meta))}"><div class="movie-detail-scroll">${movieDetailCloseButton()}${renderMovieHero(lib,firstPath,meta)}${renderCastPanel(meta)}${renderRecPanel(meta)}<section><h3>季度</h3></section>${seasons}${renderSeriesInfoPanel(show, meta.rating)}</div></div>`;
    scrollViewerIntoView(viewer);
  };
  renderPage();
  /* v0.9.81：异步补齐剧集 TMDB 评分 / 演职人员 / 视频推荐，并回写元数据缓存。 */
  try {
    const srv = await fetch(`/api/media/metadata?id=${encodeURIComponent(lib.id)}&path=${encodeURIComponent(firstPath)}`,{cache:"no-store"});
    const sdata = srv.ok ? await srv.json() : null;
    const extras = {};
    const sRating = Number(sdata && (sdata.rating||sdata.vote_average)) || 0;
    if (sRating) extras.rating = sRating;
    let tid = show.tmdb_id || (sdata && sdata.tmdb_id) || "";
    const imgBase = scraperStatus.tmdb_image_base || "https://image.tmdb.org/t/p";
    if (!tid && scraperStatus.tmdb_enabled && show.title) {
      const q = await fetch(`/api/media/tmdb?query=${encodeURIComponent(show.title)}&type=series&lang=${tmdbLangTag()}`,{cache:"force-cache"});
      if (q.ok) { const found=(await q.json())?.results||[]; const hit=found.find(x=>x.poster_path||x.overview||x.name); if (hit) { tid=hit.id; if(Number(hit.vote_average)) extras.rating=Number(hit.vote_average); if(!hero.overview && hit.overview) extras.overview=hit.overview; if(!hero.poster && hit.poster_path) extras.poster=`${imgBase}/w342${hit.poster_path}`; } }
    }
    if (tid) {
      let d = null;
      try { const dres = await fetch(`/api/media/tmdb?id=${encodeURIComponent(tid)}&type=tv&lang=${tmdbLangTag()}`,{cache:"force-cache"}); if (dres.ok) d = await dres.json(); } catch(e) {}
      if (d) {
        if (!extras.overview && d.overview) extras.overview = d.overview;
        if (Number(d.vote_average)) extras.rating = Number(d.vote_average);
        if (!hero.poster && d.poster_path) extras.poster = `${imgBase}/w342${d.poster_path}`;
        extras.genres = (d.genres||[]).map(x=>x.name);
        extras.cast = (d.credits?.cast||[]).slice(0,12);
        extras.recommendations = movieRecommendationsFor(d, { ...hero, rating: extras.rating || Number(hero.rating) || 0 });
      }
    }
    if (Object.keys(extras).length) {
      show.rating = Number(extras.rating) || show.rating;
      try { const all=readMovieMetadata(); seriesShowEpisodePaths(show).forEach(p=>{ all[p]={...(all[p]||{}), rating:show.rating, overview:extras.overview||(all[p]&&all[p].overview)||""}; }); writeMovieMetadata(all); } catch(e) {}
      renderPage(extras);
    }
  } catch(e){}
}
function renderMovieLibrary(lib, files) { const host = document.createElement("div"); renderMovieLibraryContent(host, lib, files); return host.innerHTML; }
function renderMovieRow(lib, file) { const path=String(file.path), meta=movieMetadataFor(path); return `<div class="media-file-row"><div class="media-file-name" title="${esc(path)}"><b>${esc(meta.title)}</b><small>${esc([meta.year, meta.provider].filter(Boolean).join(" · "))}</small></div><span class="media-file-meta">${esc(fileExt(path).toUpperCase())} · ${formatFileSize(file.size)}</span><div class="media-actions"><button class="btn" data-media-group="movie" data-media-library="${esc(lib.id)}" data-media-path="${esc(path)}" onclick="openLocalMediaButton(this)">▶ 播放</button></div></div>`; }
function movieStateKey(kind, libId, path) { return `vaulthub_movie_${kind}_${libId}_${path}`; }
function movieFlag(kind, libId, path) { try { return localStorage.getItem(movieStateKey(kind,libId,path)) === "1"; } catch(e) { return false; } }

function toggleMovieFavorite(libId,path,button){
  const next=!movieFlag("favorite",libId,path);
  try{localStorage.setItem(movieStateKey("favorite",libId,path),next?"1":"0");}catch(e){}
  if(button){button.textContent=next?"♥ 已收藏":"♡ 收藏";button.setAttribute("aria-pressed",next?"true":"false");}
  toast(next?"♥ 已加入收藏":"♡ 已取消收藏");
}
/* v0.9.76：把十分制评分写进 media override（服务端持久化），失败只提示不阻断。 */
async function saveMovieUserRating(libId, path, value) {
  try {
    const meta = movieMetadataFor(path);
    const data = await saveMovieMetadataOverride(libId, path, { poster: meta.poster || "", logo: meta.logo || "", fanart: meta.fanart || "", backdrop: meta.backdrop || "", tags: meta.tags || [], watched: !!meta.watched, user_rating: Number(value) || 0 });
    const saved = Number(data.user_rating);
    const all = readMovieMetadata();
    all[path] = { ...(all[path] || {}), ...meta, user_rating: Number.isFinite(saved) && saved > 0 ? saved : Number(value) };
    writeMovieMetadata(all);
    /* 详情页正打开着就按服务端返回值刷新控件（多端一致：另一台机器刷新后同分）。 */
    const widget = [...document.querySelectorAll(".movie-rating-widget")].find(w => String(w.dataset.ratePath) === String(path));
    if (widget) {
      const valueNow = Number(all[path].user_rating) || 0;
      const stars = widget.querySelector(".movie-stars");
      if (stars) stars.innerHTML = movieStarsFor(valueNow);
      const label = widget.querySelector(".movie-rating-value");
      if (label) label.textContent = valueNow ? "我的评分 " + valueNow.toFixed(1) : "未评分";
    }
  } catch (e) { toast("⚠️ 评分同步失败：" + e.message); }
}
async function saveMovieMetadataOverride(libId,path,values){const res=await fetch(`/api/media/metadata/override?id=${encodeURIComponent(libId)}&path=${encodeURIComponent(path)}`,{method:"PUT",headers:sessionWriteHeaders(true),body:JSON.stringify(values)});const data=await res.json();if(!res.ok)throw new Error(data.error||`HTTP ${res.status}`);return data;}
async function toggleMovieWatched(libId,path,button){const meta=movieMetadataFor(path),next=!(meta.watched||movieFlag("watched",libId,path));try{const data=await saveMovieMetadataOverride(libId,path,{poster:meta.poster||"",logo:meta.logo||"",fanart:meta.fanart||"",backdrop:meta.backdrop||"",tags:meta.tags||[],watched:next});meta.watched=!!data.watched;const all=readMovieMetadata();all[path]=meta;writeMovieMetadata(all);localStorage.setItem(movieStateKey("watched",libId,path),next?"1":"0");if(button)button.textContent=next?"✓ 已观看":"○ 未观看";}catch(e){toast("⚠️ 状态保存失败："+e.message);}}
async function openMediaMetadataEditor(libId,path){const meta=movieMetadataFor(path);document.getElementById("mediaEditLibId").value=libId;document.getElementById("mediaEditPath").value=path;
  /* v0.9.89：刮削完成后，原文件名退到「媒体信息编辑」里展示（只读）——
     一级标题是刮削出来的 NFO 标题，二级信息（原始文件名）在这里可查。 */
  const origInput=document.getElementById("mediaEditOriginalName");if(origInput)origInput.value=String(path).split("/").pop();
  /* v0.9.86（客户要求「增加影视媒体编辑功能辅助完成刮削（媒体名称、年份）」）：
     名称回填优先级 —— 手工设置过的名称 > 当前展示名；年份同理。 */
  const titleInput=document.getElementById("mediaEditTitle"),yearInput=document.getElementById("mediaEditYear");
  if(titleInput)titleInput.value=meta.user_title||meta.title||"";
  if(yearInput)yearInput.value=meta.year||"";for(const role of ["Poster","Logo","Fanart","Backdrop"])document.getElementById(`mediaEdit${role}Url`).value=meta[role.toLowerCase()]||"";document.getElementById("mediaEditTags").value=(meta.tags||[]).join(", ");const host=document.getElementById("mediaEditArtworkChoices");host.innerHTML="正在读取媒体目录图片…";openModal("mediaMetadataEditorModal");try{const res=await fetch(`/api/media/metadata/artwork?id=${encodeURIComponent(libId)}&path=${encodeURIComponent(path)}`,{cache:"no-store"});const data=await res.json();if(!res.ok)throw new Error(data.error||`HTTP ${res.status}`);host.innerHTML=(data.items||[]).map(item=>`<button class="artwork-choice" type="button" onclick="chooseMediaArtwork(${jsAttrArg(item.url)})"><img src="${esc(item.url)}" alt=""><span>${esc(item.name)}</span></button>`).join("")||"该目录没有可选图片";}catch(e){host.textContent="图片读取失败："+e.message;}}
function chooseMediaArtwork(url){const role=document.getElementById("mediaEditArtworkRole").value;document.getElementById(`mediaEdit${role}Url`).value=url;}
async function saveMediaMetadataEditor(){
  const libId=document.getElementById("mediaEditLibId").value,path=document.getElementById("mediaEditPath").value,meta=movieMetadataFor(path);
  const titleInput=document.getElementById("mediaEditTitle");
  const userTitle=titleInput?titleInput.value.trim():"";
  const values={title:userTitle,year:(document.getElementById("mediaEditYear")||{}).value?document.getElementById("mediaEditYear").value.trim():"",poster:document.getElementById("mediaEditPosterUrl").value.trim(),logo:document.getElementById("mediaEditLogoUrl").value.trim(),fanart:document.getElementById("mediaEditFanartUrl").value.trim(),backdrop:document.getElementById("mediaEditBackdropUrl").value.trim(),tags:document.getElementById("mediaEditTags").value.split(/[,，]/).map(x=>x.trim()).filter(Boolean),watched:!!meta.watched};
  const titleChanged=!!userTitle&&userTitle!==(meta.user_title||meta.title||"");
  try{
    const saved=await saveMovieMetadataOverride(libId,path,values),all=readMovieMetadata();
    /* v0.9.86：手工名称/年份写进缓存，并把刮削状态复位 —— 下一次刮削（手动或自动）
       就会用新名称去搜，这就是「辅助完成刮削」。 */
    all[path]={...meta,...saved,
      title:saved.title||meta.title,
      user_title:saved.title||"",
      year:saved.year||meta.year||"",
      scrape_attempts:0,last_attempt:0,scrape_state:"pending",reason:""};
    writeMovieMetadata(all);
    if(typeof flushMovieMetadata==="function")flushMovieMetadata();
    closeModal("mediaMetadataEditorModal");
    if(typeof libraryItemScan!=="undefined"&&libraryItemScan.libId&&String(libraryItemScan.libId)===String(libId)){
      /* 从逐项扫描弹窗进来：保存后直接按新名称重刮这一条，再刷回弹窗列表。 */
      const lib=findMediaLibrary(libId),file={path};
      libraryItemScan.busy=String(path);
      await openLibraryItemScanFresh(libId,path,lib,file);
      toast("✅ 已保存名称/年份，并按新名称重刮");
      return;
    }
    await openMovieDetails(libId,path);
    if(titleChanged&&findMediaLibrary(libId)){
      const lib=findMediaLibrary(libId);
      libraryScanState[libId]={...(libraryScanState[libId]||{}),running:false};
      toast("✅ 已保存，正在按新名称重刮…");
      scrapeOneMovie(lib,[{path}],{path}).then(()=>{if(typeof flushMovieMetadata==="function")flushMovieMetadata();openMovieDetails(libId,path);}).catch(()=>{});
      return;
    }
    toast("✅ 媒体信息已保存");
  }catch(e){toast("⚠️ 保存失败："+e.message);}
}
/* 逐项扫描弹窗内的「保存后重刮」：重刮单条并把结果刷回弹窗。 */
async function openLibraryItemScanFresh(libId,path,lib,file){
  try{
    if(lib)await scrapeOneMovie(lib,libraryItemScan.files&&libraryItemScan.files.length?libraryItemScan.files:[file],file);
  }catch(e){toast("⚠️ 重刮失败："+(e.message||e));}
  libraryItemScan.busy="";
  openLibraryItemScan(libId);
}
/* 逐项扫描弹窗的「仅重试失败项」：对这些条目复位刮削状态后逐条重刮。 */
async function libraryItemScanRetryFailed(){
  const libId=libraryItemScan.libId,lib=findMediaLibrary(libId);
  const files=libraryItemScan.files||[];
  if(!lib||!files.length)return;
  const targets=files.filter(file=>{const st=movieMetaState(movieMetadataFor(String(file.path)));return st==="failed"||st==="pending";});
  if(!targets.length){toast("没有需要重试的条目");return;}
  const all=readMovieMetadata();
  targets.forEach(file=>{const path=String(file.path);if(all[path]){all[path].scrape_attempts=0;all[path].last_attempt=0;delete all[path].scrape_state;delete all[path].reason;}});
  writeMovieMetadata(all);
  toast(`↻ 重试失败项：${targets.length} 项`);
  for(const file of targets){
    libraryItemScan.busy=String(file.path);
    renderLibraryItemScanBody();
    try{await scrapeOneMovie(lib,files,file);}catch(e){}
  }
  libraryItemScan.busy="";
  if(typeof flushMovieMetadata==="function")flushMovieMetadata();
  /* v0.9.88：重试结果批量写回服务端。 */
  pushMovieScrapeResults(libId, targets.map(file => String(file.path)));
  renderLibraryItemScanBody();
}
/* v0.9.75：十分制五星图示评分（半星步进 0.5），鼠标悬停跟踪预览、点击落定；
   不再用 prompt 输入。评分存 localStorage（vaulthub_movie_rating_*）。 */
/* ==================== v0.9.76 视频推荐 ====================
   规则（用户定义）：
   · 默认用 TMDB recommendations（同类型/同系列），过滤出
     TMDB 评分 >= (当前视频评分 × 1.05) 的条目 —— 「评分+5%」为推荐线；
   · 当前视频接近满分（≥9.5，与满分差距 <5%）时放宽为
     「同评分（±5%）优先，其后同演职人员作品（按评分接近排序）」；
   · 本地刮削失败时按文件名/同目录回落，推荐等级标记展示。 */
function movieRecommendationsFor(detail, meta) {
  const raw = (detail.recommendations && detail.recommendations.results || []).slice();
  const cur = Number(detail.vote_average || meta.rating || 0);
  const nearMax = cur >= 9.5;
  const floor = cur * 1.05;
  const base = scraperStatus.tmdb_image_base || "https://image.tmdb.org/t/p";
  const pick = x => ({ title: x.title || x.name || "", year: String(x.release_date || x.first_air_date || "").slice(0, 4), rating: Number(x.vote_average || 0), poster: x.poster_path ? `${base}/w342${x.poster_path}` : (x.backdrop_path ? `${base}/w780${x.backdrop_path}` : ""), backdrop: x.backdrop_path ? `${base}/w780${x.backdrop_path}` : (x.poster_path ? `${base}/w342${x.poster_path}` : ""), overview: x.overview || "", id: x.id || "", media_type: x.title ? "movie" : "tv", reason: "" });
  const scored = raw.map(pick).filter(x => x.title);
  let out = [];
  if (nearMax) {
    /* 近满分：同评分(±5%)在前，其余按差距升序 */
    const band = scored.filter(x => Math.abs(x.rating - cur) <= cur * 0.05).sort((a, b) => b.rating - a.rating);
    const rest = scored.filter(x => !band.includes(x)).sort((a, b) => Math.abs(b.rating - cur) - Math.abs(a.rating - cur));
    out = band.concat(rest);
  } else {
    out = scored.filter(x => x.rating >= floor).sort((a, b) => b.rating - a.rating);
    /* 不足 8 条时用同演职人员/次级推荐补位（TMDB recommendations 本身已含关联作品） */
    if (out.length < 8) out = out.concat(scored.filter(x => !out.includes(x)));
  }
  /* v0.9.80 本地优先：若服务器上有该标题的资源则排在前面并可用点击播放（详见 movieRecStripHTML）。 */
  return out.slice(0, 20);
}
/* v0.9.80 本地资源索引：把已刮削的媒体路径按标题小写化映射，用于判断某推荐是否已在服务器内。 */
/* v0.9.77：把 TMDB 的 status_message 翻成能照着做的中文提示。
   此前 401（密钥无效）/未刮削 都被 catch(e){} 吞掉，页面只显示「暂无视频推荐」，
   用户完全看不出是密钥问题还是没刮削 —— 这就是「TMDB 推荐不生效」的可见症状。 */
function movieTMDBErrorText(err, status) {
  const msg = String((err && (err.status_message || err.error)) || "");
  if (status === 401 || /invalid api key|unauthorized/i.test(msg)) {
    return "TMDB 凭据无效：系统设置 → 刮削里的密钥需为 v3 API Key 或 v4 Read Access Token（v0.9.77 起两种都支持）";
  }
  if (status === 404) return "TMDB 没有这条记录（id " + msg + "）";
  if (!msg) return "TMDB 读取失败（HTTP " + status + "）";
  return "TMDB 读取失败：" + msg;
}
/* v0.9.82：本地资源标题索引改为「懒加载 + 记忆化」。
   旧实现在脚本解析阶段就同步遍历整库元数据建索引 —— 库大时首屏白屏/卡顿的来源之一。
   现在只有真的渲染视频推荐时才建，之后复用同一份；元数据写入后失效重算。 */
let movieLocalTitleIndexCache = null;
function movieLocalTitleIndex() {
  if (movieLocalTitleIndexCache) return movieLocalTitleIndexCache;
  let map = {};
  try {
    const all = readMovieMetadata();
    for (const path in all) { const title = String(all[path].title || "").toLowerCase(); if (title) (map[title] = map[title] || []).push({ path }); }
  } catch (e) { map = {}; }
  movieLocalTitleIndexCache = map;
  return map;
}
function movieRecLocalHit(title){ return (movieLocalTitleIndex()[String(title||"").toLowerCase()]||[])[0] || null; }
/* v0.9.80 jsObjArg：把任意对象安全地内联进 onclick 引号参数（esc 后 JSON）。 */
function jsObjArg(value) { return esc(JSON.stringify(value)); }
/* v0.9.82：本地封面按展示尺寸取缩略图（远程访问提速）。
   本地 sidecar 封面可能是 1–3 MB 的原图，海报墙一屏几十张时 WAN 带宽被瞬间打满。
   服务端 /api/media/cover 现在支持 &w=，命中磁盘缓存后是十几 KB 的 JPEG；
   仅对本站同源封面 URL 追加参数，TMDB 等外链原样返回（它们自带尺寸段）。 */
function coverThumbUrl(url, width) {
  const raw = String(url || "");
  if (!raw || !width || raw.indexOf("/api/media/cover") !== 0) return raw;
  /* v0.9.84：画面清晰度档位统一收紧「卡片类」封面取图尺寸（请求宽度 ≤640 的封面/海报）。
     原画/高清档不收紧，流畅 200px、极省 140px —— 换档后 URL 宽度随之变化，
     浏览器必然重新取图，因此从低档切回高档能立刻恢复原图（旧实现缺这条回退路径）。 */
  const capped = Number(width) <= 640 && typeof qualityCoverWidth === "function" ? qualityCoverWidth(Number(width)) : Number(width);
  if (/[?&]w=\d/.test(raw)) return raw;
  return raw + (raw.indexOf("?") >= 0 ? "&" : "?") + "w=" + capped;
}
/* v0.9.82：整库索引的会话级缓存。
   影视/剧集/书刊都要「整库索引」才能正确排序与聚合，旧实现每次切库、切视图、
   重新进入都把所有分页重新拉一遍（大库是几 MB 的 WAN 流量 + 重新解析 + 重建整墙
   DOM），这是「资源多了以后操作迟缓」的主因。现在会话内复用整库索引；
   缓存过期时只发一个 limit=1 的探测请求比对服务端索引版本（行数 + 最大 mtime），
   版本一致就继续用本地索引，不一致才重新拉全量。 */
const libraryIndexSession = {};
const LIBRARY_INDEX_TTL_MS = 120000;
/* v0.9.90：整库索引分块大小（大库少打来回）与书刊架单次渲染窗口。
   18.4 万条的电子书库按 2000/块 = 93 次请求（旧实现 500/块 = 370 次）；
   渲染窗口保证「整库可见」的同时不会一次往 DOM 里塞十几万张卡。 */
const LIBRARY_INDEX_CHUNK = 2000;
const BOOK_SHELF_RENDER_WINDOW = 600;
/* 这个规模以内一次性全量渲染（保持「整库可见」原样）；超过才按窗口渐进渲染。 */
const BOOK_SHELF_AUTO_MAX = 3000;
function libraryIndexSessionGet(libId, group) {
  const entry = libraryIndexSession[libId];
  if (!entry || entry.group !== group || !Array.isArray(entry.files) || !entry.files.length) return null;
  return entry;
}
function libraryIndexSessionClear(libId) {
  if (libId) delete libraryIndexSession[libId];
  else Object.keys(libraryIndexSession).forEach(key => delete libraryIndexSession[key]);
}
/* ================= v0.9.92：长会话内存治理 =================
   客户反馈「页面打开时间较长后，媒体及页面失去响应」。

   此前每个打开过的媒体库都把重型缓存常驻内存：整库文件索引（电子书库一个库 18.4 万条
   文件对象）、书架可见列表、阅读状态索引（按库构建的大对象）、整库统计。在库之间来回
   切换几次后，标签页内存持续上涨，浏览器 GC 抖动加剧，最终表现为操作失去响应。

   策略：只保留「当前正在看的那个库」的重型缓存，其余库进入时释放并按需重建
   （重建成本已由 v0.9.90 的分块拉取 + 首屏先渲染压到可接受范围）。 */
function releaseMediaHeavyCaches(keepLibId) {
  const keep = String(keepLibId || "");
  let freed = 0;
  [libraryIndexSession, bookShelfIndexCache, bookShelfCountsCache].forEach((store) => {
    if (!store) return;
    Object.keys(store).forEach((id) => {
      if (id === keep) return;
      delete store[id];
      freed++;
    });
  });
  if (typeof readingStateIndexRelease === "function") freed += readingStateIndexRelease(keep);
  /* 书架可见列表只在看的就是这个库时保留。 */
  if (String(localMediaSelection.comic || "") !== keep) bookShelfVisibleCache = [];
  return freed;
}
async function libraryIndexVersionProbe(lib) {
  try {
    const res = await fetch(`/api/media/files?id=${encodeURIComponent(lib.id)}&offset=0&limit=1`, { cache: "no-store" });
    if (!res.ok) return "";
    const data = await res.json();
    return String((data && data.version) || "");
  } catch (e) { return ""; }
}
/* v0.9.80 推荐卡：横版略缩图 + 标题；服务器内有资源时显示播放按钮并可点击，优先排在前面；
   无资源时点击卡片弹「视频信息」窗口，展示 TMDB 信息，失败/日漫回落 Bangumi。 */
function movieRecStripHTML(meta) {
  const list = (meta.recommendations || []).slice();
  if (!list.length) {
    if (meta.tmdb_error) return `<div class="empty-tip movie-rec-error">视频推荐不可用：${esc(meta.tmdb_error)}</div>`;
    return '<div class="empty-tip">暂无视频推荐</div>';
  }
  const withLocal = list.map(x => ({ ...x, local: movieRecLocalHit(x.title) ? { path: movieRecLocalHit(x.title).path } : null }));
  withLocal.sort((a, b) => (b.local?1:0) - (a.local?1:0)); /* 有本地资源的优先 */
  return withLocal.slice(0, 8).map(x => {
    const art = x.poster ? `<img src="${esc(x.poster)}" alt="${esc(x.title)}" loading="lazy">` : `<span class="movie-rec-fallback">${esc((x.title||"?").slice(0,1))}</span>`;
    /* v0.9.82：播放按钮移到略缩图之上（hover / 键盘聚焦时显示），不再占一行挤在标题下。 */
    const play = x.local ? `<button class="movie-rec-play" type="button" title="播放" aria-label="播放 ${esc(x.title)}" onclick="event.stopPropagation();openMovieDetails(${jsAttrArg(scraperStatus._recLibId||"")},${jsAttrArg(x.local.path)})"><span aria-hidden="true">▶</span><em>播放</em></button>` : "";
    const badge = x.local ? '<span class="movie-rec-badge is-local">本地可播</span>' : `<span class="movie-rec-badge">${esc(movieRecBadge(x, meta))}</span>`;
    const onClick = x.local ? `openMovieDetails(${jsAttrArg(scraperStatus._recLibId||"")},${jsAttrArg(x.local.path)})` : `showRecInfo(${jsObjArg(x)})`;
    return `<article class="movie-rec-card" onclick="${onClick}" title="${esc(x.title)}">${badge}<div class="movie-rec-poster">${art}${play}</div><div class="movie-rec-meta"><b>${esc(x.title)}</b><small>${esc(String(x.year||""))}${x.rating?` · ⭐ ${x.rating.toFixed(1)}`:""}</small></div></article>`;
  }).join("");
}
/* v0.9.82：无本地资源 → 「视频信息」窗口（客户反馈「依旧没有修复」，根因有两层）：
   1) 旧实现只展示推荐条目自带的 stub（年份/评分/简介），类型、时长等字段全是「--」，
      看起来就是「信息不全」；
   2) 16:9 画框里塞的是 TMDB 的 2:3 竖版海报，被裁成一条，视觉上仍是坏的。
   现在：画框优先用 backdrop（TMDB backdrop 天然 16:9），没有才回退 poster；
   打开后按 id 异步取 TMDB 完整详情补齐 类型/时长/评分/简介，失败或日漫回落 Bangumi。 */
function recInfoBase() { return scraperStatus.tmdb_image_base || "https://image.tmdb.org/t/p"; }
function recInfoArtUrl(item) {
  const base = recInfoBase();
  const backdrop = item.backdrop || (item.backdrop_path ? `${base}/w780${item.backdrop_path}` : "");
  return backdrop || item.poster || "";
}
/* v0.9.83：左侧图集 —— 主图（优先 backdrop，16:9）+ 若干张剧照。
   简介较长时右侧文字很高，只放一张图会让左栏显得空，这里多渲染几张图自适应填充。 */
function recInfoShotUrls(item) {
  const out = [];
  const push = u => { if (u && out.indexOf(u) < 0) out.push(u); };
  push(recInfoArtUrl(item));
  const extras = Array.isArray(item.shots) ? item.shots : [];
  extras.forEach(push);
  return out.slice(0, 4);
}
function recInfoShotHTML(url, alt) {
  return `<img class="rec-info-shot" src="${esc(url)}" alt="${esc(alt)}" loading="lazy" decoding="async">`;
}
function fillRecInfoShots(item) {
  const shots = recInfoShotUrls(item);
  const main = document.getElementById("recInfoPoster");
  if (main) { main.src = shots[0] || ""; main.style.display = shots[0] ? "" : "none"; main.alt = item.title || ""; }
  const wrap = document.getElementById("recInfoShots");
  if (!wrap) return;
  const rest = shots.slice(1, 4);
  wrap.innerHTML = rest.map((u, i) => recInfoShotHTML(u, `${item.title || ""} 剧照 ${i + 2}`)).join("");
  wrap.hidden = !rest.length;
  /* 只有一张图时让主图撑满左栏高度（简介很长时不再留一片空白）。 */
  const art = document.getElementById("recInfoArt");
  if (art) art.classList.toggle("has-shots", rest.length > 0);
}
function recInfoBodyHTML(item, opts) {
  const extra = (opts && opts.extra) || {};
  const source = (opts && opts.source) || "TMDB";
  const rows = [
    ["年份", extra.year || item.year || ""],
    ["类型", (extra.genres || []).join(" / ")],
    ["时长", extra.runtime ? `${extra.runtime} 分钟` : ""],
    ["评分", item.rating ? Number(item.rating).toFixed(1) : ""],
    ["来源", source],
  ].filter(row => row[1]);
  const dl = rows.length ? `<dl class="movie-meta-list">${rows.map(row => `<dt>${esc(row[0])}</dt><dd>${esc(String(row[1]))}</dd>`).join("")}</dl>` : "";
  return `${dl}<p class="rec-info-overview"><b>简介：</b>${esc(extra.overview || item.overview || "暂无简介")}</p><p class="hint">服务器内暂无该资源；以上信息来自 ${esc(source)}。</p>`;
}
async function showRecInfo(item) {
  const win = document.getElementById("recInfoModal") || buildRecInfoModal();
  const titleEl = document.getElementById("recInfoTitle"), body = document.getElementById("recInfoBody");
  fillRecInfoShots(item);
  if (titleEl) titleEl.textContent = item.title || "";
  if (body) body.innerHTML = recInfoBodyHTML(item);
  openModal("recInfoModal");
  const kind = item.media_type === "tv" || item.media_type === "series" ? "tv" : "movie";
  /* 异步补齐 TMDB 完整详情：让「视频信息」里的类型 / 时长不再是「--」。 */
  if (item.id) {
    try {
      const res = await fetch(`/api/media/tmdb?type=${kind}&id=${encodeURIComponent(item.id)}&lang=${tmdbLangTag()}`, { cache: "no-store", credentials: "same-origin" });
      if (res.ok) {
        const detail = await res.json();
        if (detail && !detail.status_code) {
          const base = recInfoBase();
          const full = Object.assign({}, item, {
            title: detail.title || detail.name || item.title,
            year: String(detail.release_date || detail.first_air_date || item.year || "").slice(0, 4),
            rating: Number(detail.vote_average || item.rating || 0),
            overview: detail.overview || item.overview || "",
            poster: detail.poster_path ? `${base}/w342${detail.poster_path}` : item.poster,
            backdrop: detail.backdrop_path ? `${base}/w780${detail.backdrop_path}` : item.backdrop,
            shots: ((detail.images && detail.images.backdrops) || [])
            .filter(x => x.file_path && x.width && x.height && x.width / x.height >= 1.5 && x.width / x.height <= 1.9)
            .map(x => `${base}/w780${x.file_path}`),
          });
          const el = document.getElementById("recInfoBody");
          if (el) el.innerHTML = recInfoBodyHTML(full, { extra: { genres: (detail.genres || []).map(x => x.name), runtime: detail.runtime || (detail.episode_run_time || [])[0] } });
          const t2 = document.getElementById("recInfoTitle");
          if (t2) t2.textContent = full.title;
          fillRecInfoShots(full);
          return;
        }
      }
    } catch (e) { /* TMDB 详情拉取失败：保留 stub 信息，仍可阅读，不阻塞弹窗 */ }
  }
  /* v0.9.80/v0.9.82 兜底：TMDB 不可用、或剧集（日漫多为剧集）时回落 Bangumi。 */
  if ((kind === "tv" || !item.overview) && item.title) {
    fetch("https://api.bgm.tv/v0/search/subjects", { method:"POST", headers:{ "Content-Type":"application/json", "User-Agent":"VaultHub/0.9.83 (https://github.com/q807738511/vaulthub)" }, body: JSON.stringify({ keyword: item.title, sort:"match", filter:{ type:[2], nsfw:false } }) })
      .then(r => r.json()).then(d => {
        const hit = (d?.data||[]).find(x => x.name || x.name_cn);
        if (!hit) return;
        const b = document.getElementById("recInfoBody");
        if (!b) return;
        const pic = hit.images?.large || hit.images?.common || "";
        const p2 = document.getElementById("recInfoPoster");
        if (p2 && pic) { p2.src = pic; p2.style.display = ""; }
        /* Bangumi 只给一张封面：清空剧照网格，避免留下上一部作品的多图。 */
        const sw = document.getElementById("recInfoShots");
        if (sw) { sw.innerHTML = ""; sw.hidden = true; }
        b.innerHTML = recInfoBodyHTML({ year: String(hit.date || "").slice(0, 4), rating: Number(hit.rating?.score || 0), overview: String(hit.summary || "").split("\n")[0] }, { source: "Bangumi（bgm.tv）" });
      })
      .catch(() => {});
  }
}
function buildRecInfoModal() {
  const div=document.createElement("div"); div.className="modal-mask"; div.id="recInfoModal";
  div.innerHTML=`<div class="modal rec-info-modal"><h3>视频信息<button class="close" onclick="closeModal('recInfoModal')">✕</button></h3><div class="rec-info-grid"><div class="rec-info-art" id="recInfoArt"><img id="recInfoPoster" alt=""><div class="rec-info-shots" id="recInfoShots" hidden></div></div><div class="rec-info-main"><div id="recInfoTitle" class="rec-info-title"></div><div id="recInfoBody" class="rec-info-body"></div></div></div></div>`;
  document.body.appendChild(div); return div;
}
function movieRecBadge(item, meta) {
  const cur = Number(meta.rating || 0);
  const d = item.rating - cur;
  if (cur >= 9.5 && Math.abs(d) <= cur * 0.05) return "同评分";
  if (d >= cur * 0.05) return "评分+5%";
  return "相关";
}
/* v0.9.76：评分以服务端 override（meta.user_rating）为准，多端同步；
   localStorage 只作为离线回退缓存。 */
function movieUserRating(libId, path) {
  try { const meta = readMovieMetadata()[path]; const srv = Number(meta && meta.user_rating); if (Number.isFinite(srv) && srv > 0) return srv; } catch (e) {}
  const n = Number(localStorage.getItem(movieStateKey("rating", libId, path))); return Number.isFinite(n) && n > 0 ? n : 0;
}
function movieStarsFor(value) {
  const v = Math.max(0, Math.min(10, Number(value) || 0));
  let html = "";
  for (let i = 1; i <= 5; i++) {
    const fill = v >= i * 2 ? 1 : (v >= i * 2 - 1 ? 0.5 : 0);
    html += `<span class="movie-star" data-star="${i}"><span class="movie-star-fill" style="width:${fill * 100}%">★</span>★</span>`;
  }
  return html;
}
function movieRatingWidget(libId, path) {
  const mine = movieUserRating(libId, path);
  return `<span class="movie-rating-widget" data-rate-lib="${esc(libId)}" data-rate-path="${esc(path)}" title="点击星星评分（每颗星十分制半星步进）">`
    + `<span class="movie-stars" onmousemove="movieStarHover(event,this)" onmouseleave="movieStarLeave(this)" onclick="movieStarClick(event,this)">${movieStarsFor(mine)}</span>`
    + `<span class="movie-rating-value">${mine ? "我的评分 " + mine.toFixed(1) : "未评分"}</span></span>`;
}
function movieStarValue(target) {
  const rect = target.getBoundingClientRect();
  const rel = Math.max(0, Math.min(0.999, (event.clientX - rect.left) / rect.width));
  return (Number(target.dataset.star) * 2 - 1) + (rel > 0.5 ? 1 : 0);
}
function movieStarHover(event, host) {
  const star = event.target.closest(".movie-star");
  if (!star) return;
  const value = movieStarValue(star);
  host.querySelectorAll(".movie-star").forEach((el, idx) => {
    const fill = value >= (idx + 1) * 2 ? 1 : (value >= (idx + 1) * 2 - 1 ? 0.5 : 0);
    el.querySelector(".movie-star-fill").style.width = fill * 100 + "%";
  });
  host.parentElement.querySelector(".movie-rating-value").textContent = "评分 " + value.toFixed(1);
}
function movieStarLeave(host) {
  const widget = host.parentElement;
  const libId = widget.dataset.rateLib, path = widget.dataset.ratePath;
  const mine = movieUserRating(libId, path);
  host.innerHTML = movieStarsFor(mine);
  widget.querySelector(".movie-rating-value").textContent = mine ? "我的评分 " + mine.toFixed(1) : "未评分";
}
function movieStarClick(event, host) {
  const star = event.target.closest(".movie-star");
  if (!star) return;
  const widget = host.parentElement;
  const libId = widget.dataset.rateLib, path = widget.dataset.ratePath;
  const value = movieStarValue(star);
  /* v0.9.77 修复：先把值写进本机媒体元数据缓存再重绘。
     此前只写 localStorage 就调 movieStarLeave 重绘，而 movieUserRating 优先读
     meta.user_rating —— 缓存里还是旧值（或没有），于是星星/文案立刻弹回原样，
     用户看到的就是「点了只有一声提示、页面上留不住」。 */
  try {
    const all = readMovieMetadata();
    all[path] = { ...movieMetadataFor(path), ...(all[path] || {}), user_rating: value };
    writeMovieMetadata(all);
    localStorage.setItem(movieStateKey("rating", libId, path), String(value));
  } catch (e) { /* 缓存写失败不影响服务端持久化 */ }
  movieStarLeave(host);
  /* v0.9.76：同步写服务端 override，其它设备刷新后也能看到同一评分。 */
  saveMovieUserRating(libId, path, value);
  toast(`★ 已评分 ${value.toFixed(1)} / 10`);
}
/* v0.9.75：分享修复 —— http 非安全上下文下 navigator.share 与 navigator.clipboard 都不可用，
   旧实现抛错后 catch(e){} 静默吞掉，表现为「点了没反应」。改为三级降级，每级都有可见反馈。 */
function copyTextFallback(text) {
  const ta = document.createElement("textarea");
  ta.value = text; ta.setAttribute("readonly", "");
  ta.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
  document.body.appendChild(ta); ta.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch(e) { ok = false; }
  ta.remove();
  return ok;
}
function shareBaseURL() {
  /* v0.9.75：内网分享默认用当前访问的 IP:端口（location.origin）；
     系统设置里配置了外网地址（share_public_base，IP 或域名）则优先用它。 */
  return (scraperStatus.share_public_base || "").replace(/\/+$/, "") || location.origin;
}
async function verifyShareReachable(base) {
  /* 分享前校验配置的外网地址可达（不带凭据的 HEAD 探测，2 秒超时）。
     不可达只提示、不阻断分享（对方网络可能与本机不同）。 */
  try {
    const probe = base.replace(/\/+$/, "") + "/healthz";
    const res = await fetch(probe, { method: "GET", cache: "no-store", signal: AbortSignal.timeout(2000) });
    return res.ok || res.status === 401;
  } catch(e) { return false; }
}
/* v0.9.75：分享面板 —— 浏览器 clipboard 权限/非安全上下文下都可能不可用，
   面板把链接直接摆在可选中输入框里，并给一个用户手势触发的「复制链接」按钮，
   保证任何环境都有可用分享方式。 */
function closeShareDialog() {
  const el = document.getElementById("shareDialog");
  if (el && typeof el.remove === "function") el.remove();
}
function openShareDialog(info) {
  closeShareDialog();
  const host = document.createElement("div");
  host.id = "shareDialog";
  host.className = "share-dialog-mask";
  host.setAttribute("data-share-url", info.url);
  host.innerHTML = `<div class="share-dialog" role="dialog" aria-label="分享">
    <h4>分享「${esc(info.title)}」</h4>
    <p class="share-dialog-hint">${info.external
      ? (info.reachable ? "使用系统设置中的外网地址（已探测可达）" : "⚠️ 外网地址暂不可达，请确认域名解析与端口放行后重试")
      : "内网分享：使用当前访问的 IP:端口，仅同一局域网可打开"}</p>
    <input id="shareLinkInput" class="share-link" type="text" readonly value="${esc(info.url)}">
    <div class="share-dialog-actions">
      <button class="btn btn-primary" type="button" onclick="copyShareLink(this)">⧉ 复制链接</button>
      <button class="btn" type="button" onclick="copyShareText(this)">⧉ 复制标题+链接</button>
      <button class="btn" type="button" onclick="closeShareDialog()">关闭</button>
    </div>
  </div>`;
  document.body.appendChild(host);
  const input = document.getElementById("shareLinkInput");
  if (input && typeof input.select === "function") { try { input.select(); } catch(e) {} }
  return host;
}
function copyShareLink(button) {
  const input = document.getElementById("shareLinkInput");
  const text = input ? String(input.value || "") : "";
  if (!text) return;
  if (copyTextFallback(text)) { toast("✅ 分享链接已复制"); return; }
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(() => toast("✅ 分享链接已复制")).catch(() => toast("⚠️ 请手动复制链接框里的地址"));
    return;
  }
  toast("⚠️ 浏览器拒绝自动复制，请手动选中链接框里的地址");
}
function copyShareText(button) {
  const input = document.getElementById("shareLinkInput");
  const title = document.querySelector("#shareDialog h4") ? document.querySelector("#shareDialog h4").textContent : "";
  const text = (title ? "【" + title.replace(/^分享「|」$/g, "") + "】" : "") + (input ? String(input.value || "") : "");
  if (copyTextFallback(text)) toast("✅ 标题与链接已复制");
  else toast("⚠️ 浏览器拒绝自动复制，请手动选中链接框里的地址");
}
async function shareMovie(libId, path, title) {
  const base = shareBaseURL();
  const external = base !== location.origin;
  const url = base + location.pathname
    + "?media=movie&lib=" + encodeURIComponent(libId) + "&path=" + encodeURIComponent(path);
  const reachable = external ? await verifyShareReachable(base) : true;
  const text = `【${title}】来自 VaultHub 的分享：${url}`;
  /* https + 支持系统分享时优先用系统分享（微信/邮件/隔空投送等）。 */
  if (navigator.share && window.isSecureContext) {
    try { await navigator.share({ title, text, url }); return; } catch(e) { if (e && e.name === "AbortError") return; }
  }
  openShareDialog({ libId, path, title, url, external, reachable });
}
async function openMovieDetails(libId,path){enterMovieDetailSidebarMode();const lib=findMediaLibrary(libId),viewer=document.getElementById("local-media-viewer-movie");if(!lib||!viewer)return;try{scraperStatus._recLibId = libId;}catch(e){}let meta=movieMetadataFor(path);/* v0.9.85：演职人员/推荐缓存是「某一种语言」的结果，界面语言变了必须重取。 */if(meta.cast_lang && meta.cast_lang!==tmdbLangTag()){meta={...meta,cast:undefined,recommendations:undefined,cast_lang:undefined};}activeMovieDetail={libId,path};viewer.innerHTML=renderMovieDetails(lib,path,meta);try{const res=await fetch(`/api/media/metadata?id=${encodeURIComponent(lib.id)}&path=${encodeURIComponent(path)}`,{cache:"no-store"});if(res.ok){const local=await res.json();if(local.nfo||local.poster||local.logo||local.fanart||local.backdrop||local.tags?.length||local.watched||local.user_rating||local.subtitles?.length){meta={...meta,...local,title:local.title||meta.title,year:local.year||meta.year};const all=readMovieMetadata();all[path]=meta;writeMovieMetadata(all);viewer.innerHTML=renderMovieDetails(lib,path,meta);}}}catch(e){}/* v0.9.78：修复「影视按 TMDB 评分推荐依旧无法生效」——
   旧逻辑只在 meta.tmdb_id 存在且非「本地 NFO」时才调 TMDB 详情接口，
   而默认豆瓣/文件名刮削的影片没有 tmdb_id → 推荐与 TMDB 评分整段被跳过，
   用户看到的就是「推荐永远不生效」。
   现在无论刮削来源（TMDB/豆瓣/文件名/本地 NFO）都先解析出一个 TMDB id：
   优先用已存 tmdb_id；没有则按标题搜索拿第一条命中，再取详情
   （detail 含 vote_average + credits.cast 头像 profile_path + recommendations）。 */
const tid = meta.tmdb_id || "";
const tmdbType = encodeURIComponent(meta.media_type||lib.type);
if (tid || (scraperStatus.tmdb_enabled && (meta.title||meta.name))) {
  try {
    let detail = null, tidRes = tid;
    if (!tidRes) {
      const q = await fetch(`/api/media/tmdb?query=${encodeURIComponent(meta.title||meta.name||"")}&type=${encodeURIComponent(meta.media_type||lib.type)}&lang=${tmdbLangTag()}`, {cache:"force-cache"});
      if (q.ok) {
        const found = (await q.json())?.results || [];
        const hit = found.find(x => x.poster_path || x.overview || (x.profile_path!==undefined));
        if (hit) { tidRes = hit.id; meta = {...meta, tmdb_id: hit.id}; }
      }
    }
    if (tidRes) {
      const res = await fetch(`/api/media/tmdb?id=${encodeURIComponent(tidRes)}&type=${tmdbType}&lang=${tmdbLangTag()}`,{cache:"force-cache"});
      if (res.ok){const detail=await res.json();meta={...meta,overview:detail.overview||meta.overview,rating:Number(detail.vote_average||meta.rating||0),runtime:detail.runtime||detail.episode_run_time?.[0],genres:(detail.genres||[]).map(x=>x.name),cast:(detail.credits?.cast||[]).slice(0,12),cast_lang:tmdbLangTag(),recommendations:movieRecommendationsFor(detail,meta),tmdb_error:""};viewer.innerHTML=renderMovieDetails(lib,path,meta);}
      else{const err=await res.json().catch(()=>({}));meta={...meta,tmdb_error:movieTMDBErrorText(err,res.status)};viewer.innerHTML=renderMovieDetails(lib,path,meta);}
    } else {
      meta={...meta,tmdb_error:"TMDB 未命中《'+(meta.title||meta.name||'')+'》，无法取推荐与 TMDB 评分"};viewer.innerHTML=renderMovieDetails(lib,path,meta);
    }
  } catch(e){meta={...meta,tmdb_error:"TMDB 请求失败："+e.message};viewer.innerHTML=renderMovieDetails(lib,path,meta);}
}
scrollViewerIntoView(viewer);}
/* v0.9.85：语言切换后刷新已打开的影视详情 —— 让演职人员姓名/角色名跟随系统语言
   （TMDB language 参数随之变化）。只重开当前详情，不动其它状态。 */
let activeMovieDetail = null;
function refreshDetailLanguage() {
  const ctx = activeMovieDetail;
  /* 剧集详情同样把演职人员/推荐缓存写进元数据，语言切换后重开一次即可换语言。 */
  if (typeof activeSeriesDetail !== "undefined" && activeSeriesDetail && typeof openSeriesDetails === "function") {
    const seriesCtx = { ...activeSeriesDetail };
    const sv = document.getElementById("local-media-viewer-movie");
    if (sv && sv.innerHTML.trim()) {
      try {
        const all = readMovieMetadata();
        Object.keys(all).forEach(p => { if (all[p] && all[p].cast) { delete all[p].cast; delete all[p].recommendations; delete all[p].cast_lang; } });
        writeMovieMetadata(all);
      } catch (e) {}
      openSeriesDetails(seriesCtx.libId, seriesCtx.showKey);
    }
  }
  if (!ctx) return;
  const viewer = document.getElementById("local-media-viewer-movie");
  if (!viewer || !viewer.innerHTML.trim()) { activeMovieDetail = null; return; }
  try {
    const all = readMovieMetadata();
    const m = all && all[ctx.path];
    if (m) { delete m.cast; delete m.recommendations; delete m.cast_lang; writeMovieMetadata(all); }
  } catch (e) {}
  openMovieDetails(ctx.libId, ctx.path);
}
function closeMovieDetails(){seriesEpisodeReturn=null;activeMovieDetail=null;const viewer=document.getElementById("local-media-viewer-movie");if(viewer)viewer.innerHTML="";leaveMovieDetailSidebarMode();}
/* esc() 只做 HTML 实体转义，浏览器解析 style 属性时会把 &#39; 还原成单引号，
   足以闭合 url('…') 并注入任意 CSS 声明。海报地址可能来自本地 NFO、TMDB 或豆瓣，
   都属于外部内容，因此进 CSS 前必须先剔除引号、反斜杠、括号与换行。 */
function cssUrlValue(url) { return String(url || "").replace(/[\u0000-\u001f"'()\\]/g, "").trim(); }
function movieHeroArt(meta) { const pick = (url) => coverThumbUrl(url, 1280); if (meta?.fanart) return { kind:"fanart-art", url:pick(meta.fanart) }; if (meta?.backdrop) return { kind:"backdrop-art", url:pick(meta.backdrop) }; if (meta?.poster) return { kind:"poster-art", url:pick(meta.poster) }; return { kind:"no-art", url:"" }; }
/* ==================== v0.9.80 剧集/季/集/推荐 ====================
   1) 剧集 TMDB 评分在进入剧集详情时补齐（search tv 命中后取 vote_average）。
   2) 多季剧集详情默认先展示「季度」卡片（季度信息 + 季度略缩图），点击展开该季集列表。
   3) 单集详情底部用「X 排 Y 列」网格展示同季所有集略缩图，点图即播。
   5) 详情里演职人员 / 视频推荐 / 视频信息三栏统一。
   6) 视频推荐改成「略缩图 + 标题」横版卡片；服务器内有资源可点击播放，本地资源优先排前。
   7) 视频推荐含本地资源时点卡片直接播放；无资源时点卡片弹出 TMDB（或 bangumi 兜底）信息。
   */
/* 记录当前正在查看的剧集，供单集详情定位同季集网格用。 */
let activeEpisodeShow = null; // {libId, showKey, seasonNum, episodes:[{path,label,thumb,title}]}
function episodeGridHTML(lib, meta) {
  const ctx = window.__activeEpisodeCtx || null;
  if (!ctx || ctx.libId !== lib?.id) return "";
  const eps = (ctx.episodes || []).filter(e => String(e.path) !== String(meta && meta.__path || ctx.path));
  if (!eps.length) return "";
  const cards = eps.map(e => `<figure class="ep-grid-card" onclick="openLocalMedia('movie',${jsAttrArg(lib.id)},${jsAttrArg(e.path)})" title="${esc(e.title||e.label)}">${e.thumb?`<img src="${esc(e.thumb)}" alt="${esc(e.label)}" loading="lazy">`:`<span class="ep-grid-fallback">${esc(e.label)}</span>`}<figcaption>${esc(e.label)}</figcaption></figure>`).join("");
  return `<section class="episode-grid-section"><h3>${esc(ctx.showTitle||"")} 第${esc(ctx.seasonNum)}季 · 单集</h3><div class="episode-grid">${cards}</div></section>`;
}
function renderSeriesEpisodeRow(lib, ep, artUrl) {
  /* v0.9.81：季度集数改为「网格展示」——删除「详情」按钮，格子内同时显示集号与集标题。 */
  const path = String(ep.path), meta = ep.meta || movieMetadataFor(path), parsed = ep.parsed || parseSeriesEpisode(path);
  const safeArt = cssUrlValue(coverThumbUrl(ep.thumb || artUrl || meta.poster || "", 320));
  const style = safeArt ? `style="background-image:url('${esc(safeArt)}')"` : "";
  const label = parsed.label || `S${String(parsed.season||1).padStart(2,"0")}E${String(parsed.episode||0).padStart(2,"0")}`;
  const epTitle = String(meta.title || parsed.title || "").trim();
  return `<article class="series-episode-row series-episode-card" data-series-episode="${esc(path)}" onclick="openLocalMedia('movie',${jsAttrArg(lib.id)},${jsAttrArg(path)})" title="${esc(path)}"><div class="series-episode-thumb" ${style}><span class="series-episode-label">${esc(label)}</span></div><div class="series-episode-title"><b>${esc(label)}</b>${epTitle ? `<small title="${esc(epTitle)}">${esc(epTitle)}</small>` : ""}</div></article>`;
}
function renderSeriesSeasonCard(lib, show, season) {
  const idx = show.seasonList.findIndex(s => s.season === season.season);
  const isFirst = idx === 0;
  const epCount = (season.episodes||[]).length;
  const epBody = (season.episodes||[]).map(ep => renderSeriesEpisodeRow(lib, ep, ep.thumb || show.poster || show.fanart || "")).join("");
  const listClass = isFirst ? 'class="series-episode-list"' : 'class="series-episode-list is-collapsed"';
  const listStyle = isFirst ? "" : "display:none";
  return `<section class="series-season-block" data-season="${esc(season.season)}"><h3 class="series-season-head" onclick="toggleSeriesSeason(this)"><span class="series-season-chev">${isFirst?"▾":"▸"}</span>${esc(show.title)} 第${esc(season.season)}季 <small>共${epCount}集</small></h3><div ${listClass} style="${listStyle}">${epBody}</div></section>`;
}
function toggleSeriesSeason(head){ const list=head.parentElement.querySelector(".series-episode-list"); if(!list)return; const open=list.classList.contains("is-collapsed"); list.classList.toggle("is-collapsed",!open); list.style.display=open?"":"none"; const ch=head.querySelector(".series-season-chev"); if(ch)ch.textContent=open?"▾":"▸"; }

function renderMovieHero(lib,path,meta) { const heroArt = movieHeroArt(meta); const safeArt = cssUrlValue(heroArt.url); const style = safeArt ? `--movie-hero-art:url('${esc(safeArt)}')` : ""; const logo=meta.logo?`<img class="movie-detail-logo" src="${esc(meta.logo)}" alt="${esc(meta.title)} Logo">`:`<h1>${esc(meta.title)}</h1>`; /* v0.9.87：剧集在「无刮削信息且无简介」时整段不渲染（客户要求）；电影保持原有兜底文案。 */
  const heroText = String(meta.overview || "").trim() || (meta.media_type === "series" ? "" : "暂无电影介绍；可在系统设置中配置 TMDB API 进行刮削。");
  return `<header class="movie-detail-hero ${heroArt.kind}" style="${style}">${logo}${heroText ? `<p>${esc(heroText)}</p>` : ""}<div class="movie-detail-actions"><button class="btn btn-primary" onclick="openLocalMedia('movie',${jsAttrArg(lib.id)},${jsAttrArg(path)})">▶ 播放</button><button class="btn" onclick="shareMovie(${jsAttrArg(lib.id)},${jsAttrArg(path)},${jsAttrArg(meta.title)})">↗ 分享</button><button class="btn" onclick="toggleMovieFavorite(${jsAttrArg(lib.id)},${jsAttrArg(path)},this)">${movieFlag("favorite",lib.id,path)?"♥ 已收藏":"♡ 收藏"}</button>${movieRatingWidget(lib.id,path)}<span class="movie-tmdb-rating" title="TMDB 评分">${meta.rating ? `<b>⭐ ${meta.rating.toFixed(1)}</b><small>TMDB</small>` : ""}</span><button class="btn" onclick="toggleMovieWatched(${jsAttrArg(lib.id)},${jsAttrArg(path)},this)">${meta.watched||movieFlag("watched",lib.id,path)?"✓ 已观看":"○ 未观看"}</button><button class="btn" onclick="openMediaMetadataEditor(${jsAttrArg(lib.id)},${jsAttrArg(path)})">✎ 编辑</button></div></header>`; }
/* v0.9.81：演职人员改为「网格排序的头像展示」（auto-fill 网格，头像 + 名称 + 角色，长文本省略防穿模）。 */
/* v0.9.85：TMDB 请求语言跟随界面语言（演职人员姓名/角色名随之本地化）。
   zh-CN 是 media-go 的历史默认值，保持兼容。 */
/* v0.9.87：刮削地区优先于界面语言 —— 中/日/美 决定 TMDB language。
   auto（默认）时沿用 v0.9.85 的「跟随界面语言」。 */
function scrapeRegionLangTag(region) {
  const r = String(region || "").toLowerCase();
  if (r === "cn") return "zh-CN";
  if (r === "jp") return "ja-JP";
  if (r === "us") return "en-US";
  return "";
}
function tmdbLangTag() {
  const byRegion = scrapeRegionLangTag((typeof scraperStatus === "object" && scraperStatus) ? scraperStatus.scrape_region : "");
  if (byRegion) return byRegion;
  if (curLang === "en") return "en-US";
  if (curLang === "zh-TW") return "zh-TW";
  return "zh-CN";
}
/* v0.9.85：动画类作品的角色是「配音」，其余是「饰演」；标签随系统语言切换。 */
function castRoleLabel(meta) {
  const genres = (meta && meta.genres) || [];
  const animated = genres.some(g => /动画|動畫|Animation|Anime/i.test(String(g)));
  return t(animated ? "castVoiceAs" : "castAs");
}
function renderCastPanel(meta) {
  const roleLabel = castRoleLabel(meta);
  const cast = (meta.cast||[]).map(x => {
    const face = x.profile_path ? `<img class="movie-cast-avatar" src="/api/media/cast/avatar?person=${encodeURIComponent(x.profile_path)}" alt="${esc(x.name||"")}" loading="lazy">` : `<span class="movie-cast-avatar movie-cast-avatar-fallback">${esc((x.name||"?").slice(0,1))}</span>`;
    /* 第一行姓名，第二行饰演/配音角色（同一段本地化标签 + TMDB 本地化角色名）。 */
    const role = String(x.character || "").trim();
    const roleText = role ? `${roleLabel} ${role}` : "";
    return `<article class="movie-cast-card">${face}<b title="${esc(x.name||"")}">${esc(x.name||"")}</b>${roleText ? `<small title="${esc(roleText)}">${esc(roleText)}</small>` : ""}</article>`;
  }).join("") || `<div class="empty-tip">${esc(t("castEmpty"))}</div>`;
  return `<section><h3>${esc(t("castTitle"))}</h3><div class="movie-detail-strip movie-cast-strip">${cast}</div></section>`;
}
/* v0.9.81：视频推荐改为「网格展示」，限制文字穿模并优化观看（宽卡横排略缩图 + 标题/年份/评分）。 */
function renderRecPanel(meta) {
  return `<section><h3>视频推荐</h3><div class="movie-rec-grid">${movieRecStripHTML(meta)}</div></section>`;
}
function renderVideoInfoPanel(path, meta) {
  return `<section><h3>视频信息</h3><dl class="movie-meta-list"><dt>文件</dt><dd>${esc(path)}</dd><dt>年份</dt><dd>${esc(meta.year||"--")}</dd><dt>类型</dt><dd>${esc((meta.genres||[]).join(" / ")||"--")}</dd><dt>时长</dt><dd>${meta.runtime?esc(meta.runtime+" 分钟"):"--"}</dd><dt>TMDB 评分</dt><dd>${meta.rating?esc(Number(meta.rating).toFixed(1)):"--"}</dd><dt>来源</dt><dd>${esc(meta.provider||"文件名")}</dd></dl></section>`;
}
/* v0.9.81：剧集版「视频信息」（移至详情底部）。 */
function renderSeriesInfoPanel(show, rating) {
  const r = Number(rating || show.rating) || 0;
  return `<section><h3>视频信息</h3><dl class="movie-meta-list"><dt>剧名</dt><dd>${esc(show.title)}</dd><dt>年份</dt><dd>${esc(show.year||"--")}</dd><dt>季度</dt><dd>${esc(seriesShowSeasonCount(show))} 季 · 共${esc(seriesShowEpisodeCount(show))}集</dd><dt>TMDB 评分</dt><dd>${r?esc(r.toFixed(1)):"--"}</dd><dt>来源</dt><dd>${esc(show.provider||"文件名")}</dd></dl></section>`;
}

function renderMovieDetails(lib,path,meta){try{meta={...meta,__path:path};}catch(e){}
/* v0.9.81：详情顺序统一为 —— 视频介绍(hero) → 演职人员(网格头像) → 视频推荐(网格略缩图) → 单集网格 → 视频信息(底部)。 */
return `<div class="media-reader-overlay movie-detail-page movie-detail-backdrop" style="${esc(detailBackdropStyle(meta))}"><div class="movie-detail-scroll">${movieDetailCloseButton()}${renderMovieHero(lib,path,meta)}${renderCastPanel(meta)}${renderRecPanel(meta)}${episodeGridHTML(lib)}${renderVideoInfoPanel(path,meta)}</div></div>`;}
function renderMoviePoster(lib, file) { const path=String(file.path), meta=movieMetadataFor(path), watched=!!meta.watched||movieFlag("watched",lib.id,path), art=meta.poster ? `<img src="${esc(coverThumbUrl(meta.poster, 320))}" alt="${esc(meta.title)}" loading="lazy" decoding="async">` : `<span>${esc(meta.title)}</span>`; /* v0.9.89：一级标题 = 刮削标题（卡片大字）；原文件名作为二级信息收进
     tooltip 与「媒体信息编辑」弹窗，不再占用卡片版面。 */
  return `<article class="media-poster-card ${watched?"is-read":""}" title="原文件：${esc(path)}" data-media-group="movie" data-media-library="${esc(lib.id)}" data-media-path="${esc(path)}" onclick="openMovieDetails(${jsAttrArg(lib.id)},${jsAttrArg(path)})"><div class="media-poster-art" style="${meta.poster ? "" : `background:${coverGradient(meta.title)}`}" >${art}<button class="movie-poster-settings" data-movie-settings title="观看状态" onclick="event.stopPropagation();toggleMovieWatched(${jsAttrArg(lib.id)},${jsAttrArg(path)},this)">${watched?"✓ 已观看":"○ 未观看"}</button></div><div class="media-poster-info"><strong>${esc(meta.title)}</strong><small>${esc(moviePosterSubtitle(meta, path, file))}</small></div></article>`; }
/* v0.9.85：媒体库海报只展示片名 + 换行年份（取消元数据来源/分辨率等）：电影=年份，
   剧集=年份 · N 季 · 共M集，原盘合并条目保留「原盘 · N 个片段」提示。 */
function moviePosterSubtitle(meta, path, file) {
  return [meta.year, file && file.disc ? discSubtitle(file) : ""].filter(Boolean).join(" · ") || fileExt(path).toUpperCase();
}
/* v0.9.88：原盘形态提示 —— 纯镜像标注 ISO；目录 + 镜像并存标注「ISO + BDMV」；
   BDMV 目录标注片段数。让用户一眼看出这条到底是什么形态。 */
function discSubtitle(file) {
  const n = Number((file && file.disc_fragments) || 1);
  const kind = String((file && file.disc_kind) || "bdmv");
  if (kind === "iso") return n > 1 ? `原盘 · ISO · ${n} 个镜像` : "原盘 · ISO";
  if (file && file.iso_path) return `原盘 · ISO + BDMV · ${n} 个片段`;
  return `原盘 · ${n} 个片段`;
}
function scrapeSeriesMetadata(host, lib, files) { return scrapeMovieMetadata(host, lib, files); }
function toggleMediaResourceView(group) { mediaResourceView = mediaResourceView === "poster" ? "list" : "poster"; try { localStorage.setItem("vaulthub_media_resource_view",mediaResourceView); } catch(e) {} const lib=findMediaLibrary(localMediaSelection[group]); if(lib) loadLocalFiles(group,lib,group === "audio" ? audioCursor : 0); }
/* v0.9.84：重新刮削入口（旧实现是没绑定任何按钮的死代码）。
   scope = "all"：清掉本库所有条目的刮削状态，整库重刮；
   scope = "failed"：只把失败/未命中的条目放回队列（不动已成功的），命中即可修复。 */
function refreshMovieMetadata(scope) {
  const lib = findMediaLibrary(localMediaSelection.movie);
  const all = readMovieMetadata();
  const files = (movieScrapeContext && movieScrapeContext.files) || [];
  const paths = new Set(files.map(file => String(file.path)));
  let cleared = 0;
  if (scope === "failed") {
    Object.keys(all).forEach((path) => {
      if (paths.size && !paths.has(path)) return;
      const state = movieMetaState(all[path]);
      if (state === "failed" || state === "pending") { all[path].scrape_attempts = 0; all[path].last_attempt = 0; cleared++; }
    });
  } else {
    files.forEach((file) => { const path = String(file.path); if (all[path]) { delete all[path]; cleared++; } });
  }
  movieMetadataMemory = all;
  writeMovieMetadata(all);
  flushMovieMetadata();
  libraryIndexSessionClear();
  if (lib) loadLocalFiles("movie", lib, 0);
  toast(scope === "failed" ? `🔄 正在重试 ${cleared} 条未刮削成功的影视条目` : `🔄 正在整库重新刮削影视信息（重置 ${cleared} 条）`);
  /* v0.9.85：重试/整库重刮也在顶栏喇叭里留一条通知（明细写清范围与条数）。 */
  if (typeof pushNotification === "function") {
    pushNotification({
      level: "info",
      title: typeof tf === "function" ? tf("notifyScrapeRetry", { n: cleared }) : `重试失败项：${cleared} 项`,
      detail: `${lib ? lib.name : "媒体库"} · ${scope === "failed" ? "仅重试失败/未命中项" : "整库重新刮削"}`,
      action: { view: "movie" }
    });
  }
}

function mediaStateKey(libId, path) { return `vaulthub_reading_${libId}_${path}`; }
/* v0.9.30：阅读进度改为服务端持久化（/api/media/reading/progress）。
   localStorage 仍然写一份，用于换页/离线时的即时渲染，但真正的权威值来自
   服务端；否则换浏览器或清缓存后进度全丢，表现为「关闭后回到第一页」。
   渲染路径（renderBookCard 等）是同步的，所以服务端值先拉进内存缓存。 */
const readingProgressCache = {};   // v0.9.67: libId -> { path: {progress, page, total} }
const readingProgressLoaded = {};  // libId -> Promise
let readingProgressFlushTimer = null;
const readingProgressPending = new Map(); // `${libId}\n${path}` -> progress
/* v0.9.90：大库性能 —— 阅读进度改「按库一次性建索引」。
   旧实现每条文件一次 JSON.parse(localStorage)：18.4 万条书刊的统计 + 筛选两趟
   约 37 万次主线程解析，书架 / 历史阅读 / 喜欢 三个标签都会卡死。
   索引懒加载一次，写入与删除就地更新。 */
const readingStateIndex = {};       // libId -> { path: {progress,page,total,updatedAt} }
const readingStateIndexBuilt = {};  // libId -> bool
function readingStateIndexFor(libId) {
  const lib = String(libId);
  if (!readingStateIndexBuilt[lib]) {
    const prefix = `vaulthub_reading_${lib}_`;
    const idx = {};
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key || key.indexOf(prefix) !== 0) continue;
        try { idx[key.slice(prefix.length)] = JSON.parse(localStorage.getItem(key)) || {}; } catch (e) {}
      }
    } catch (e) {}
    readingStateIndex[lib] = idx;
    readingStateIndexBuilt[lib] = true;
  }
  return readingStateIndex[lib] || {};
}
function readingStateLocal(libId, path) {
  const item = readingStateIndexFor(libId)[String(path)];
  return item && typeof item === "object" ? item : {};
}
function readingStateInvalidate(libId) { delete readingStateIndexBuilt[String(libId)]; }
/* v0.9.92：释放非当前库的阅读状态索引（按库构建的大对象；电子书库一个库 18.4 万条）。 */
function readingStateIndexRelease(keepLibId) {
  const keep = String(keepLibId || "");
  let freed = 0;
  Object.keys(readingStateIndex).forEach((id) => {
    if (id === keep) return;
    delete readingStateIndex[id];
    delete readingStateIndexBuilt[id];
    freed++;
  });
  return freed;
}
/* v0.9.90 修复：跨标签页一致性。另一个标签页改了收藏 / 阅读进度 / 书架偏好时，
   localStorage 会派发 storage 事件；此前没有任何监听，本页的内存索引会一直用旧的
   （表现为「别的窗口收藏了，这边刷新不出来」）。storage 事件不触发时本函数也不做事。 */
if (typeof window !== "undefined" && window.addEventListener) {
  window.addEventListener("storage", (ev) => {
    const key = ev && typeof ev.key === "string" ? ev.key : "";
    if (!key || key === BOOK_FAVORITES_KEY) bookFavoritesCache.map = null;
    if (!key || key === BOOK_SHELF_PREFS_KEY) bookShelfPrefsCache = null;
    if (!key || key.indexOf("vaulthub_reading_") === 0) {
      Object.keys(readingStateIndexBuilt).forEach((id) => {
        delete readingStateIndexBuilt[id];
        delete readingStateIndex[id];
      });
    }
  });
}
function readingState(libId, path) {
  /* v0.9.67：进度同时保留百分比与页码。页码是漫画阅读器的权威值
     （百分比在页数变化、不同设备字号下会漂移）；旧数据没有 page 时由调用方按
     total 换算，详见 comicResumePage()。 */
  const local = readingStateLocal(libId, path);
  const remote = readingProgressCache[libId];
  const item = remote && Object.prototype.hasOwnProperty.call(remote, path) ? remote[path] : null;
  const src = item && typeof item === "object" ? item : local;
  return {
    progress: Number(src.progress) || 0,
    page: Number(src.page) || 0,
    total: Number(src.total) || 0
  };
}
async function loadReadingProgress(libId, force = false) {
  if (!libId) return {};
  if (!force && readingProgressLoaded[libId]) return readingProgressLoaded[libId];
  readingProgressLoaded[libId] = (async () => {
    try {
      const res = await fetch(`/api/media/reading/progress?id=${encodeURIComponent(libId)}`, { cache: "no-store", credentials: "same-origin" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const map = {};
      for (const [path, item] of Object.entries(data.items || {})) {
        map[path] = {
          progress: Number(item && item.progress) || 0,
          page: Number(item && item.page) || 0,
          total: Number(item && item.total) || 0
        };
      }
      readingProgressCache[libId] = map;
      return map;
    } catch (e) {
      /* 服务端不可用时保留已有内存值，读取仍能回落 localStorage。 */
      return readingProgressCache[libId] || {};
    }
  })();
  return readingProgressLoaded[libId];
}
function flushReadingProgress() {
  readingProgressFlushTimer = null;
  const items = [...readingProgressPending.entries()];
  readingProgressPending.clear();
  for (const [key, entry] of items) {
    const [libId, path] = key.split("\n");
    fetch(`/api/media/reading/progress?id=${encodeURIComponent(libId)}&path=${encodeURIComponent(path)}`, {
      method: "PUT",
      headers: sessionWriteHeaders(true),
      credentials: "same-origin",
      body: JSON.stringify(entry)
    }).catch(() => {});
  }
}
function saveReadingProgress(libId, path, progress, page, total) {
  const value = Math.max(0, Math.min(100, Number(progress) || 0));
  const prev = readingState(libId, path);
  const entry = {
    progress: value,
    page: Number(page) > 0 ? Number(page) : prev.page,
    total: Number(total) > 0 ? Number(total) : prev.total
  };
  const stored = Object.assign({}, entry, { updatedAt: Date.now() });
  try { localStorage.setItem(mediaStateKey(libId, path), JSON.stringify(stored)); } catch (e) {}
  readingStateIndexFor(libId)[String(path)] = stored;
  if (!readingProgressCache[libId]) readingProgressCache[libId] = {};
  readingProgressCache[libId][path] = entry;
  /* 滚动会高频触发，合并 800ms 内的写入，避免刷爆后端。 */
  readingProgressPending.set(`${libId}\n${path}`, entry);
  if (!readingProgressFlushTimer) readingProgressFlushTimer = setTimeout(flushReadingProgress, 800);
  return value;
}
/* v0.9.73：释放历史阅读。
   用户报告「已读收藏释放依旧故障」，根因有两条，缺一不可：
     ① 服务端进度库只有 PUT，没有删除入口 —— 任何释放都只能写 progress=0，
        条目仍留在库里，书架与服务端统计继续把它算作已读；
     ② 只清服务端会留下 localStorage 旧值，下一次读取又把它当已读（跨设备更明显）。
   所以这里三处一起清：服务端 DELETE、内存缓存、localStorage，并撤掉尚未落盘的待写项
   （否则 800ms 合并窗口里那个 progress=100 会把刚释放的状态又写回去）。 */
async function releaseReadingState(libId, path) {
  const lib = String(libId), rel = String(path);
  try {
    const res = await fetch(`/api/media/reading/progress?id=${encodeURIComponent(lib)}&path=${encodeURIComponent(rel)}`, {
      method: "DELETE", headers: sessionWriteHeaders(), credentials: "same-origin"
    });
    if (!await handleProtectedResponse(res)) throw new Error("会话已失效，请重新登录");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json().catch(() => ({}));
    if (data && data.ok === false) throw new Error(data.error || "服务端未删除该条目");
  } catch (e) {
    toast("⚠️ 释放失败：" + e.message);
    return false;
  }
  readingProgressPending.delete(`${lib}\n${rel}`);
  if (readingProgressCache[lib]) delete readingProgressCache[lib][rel];
  try { localStorage.removeItem(mediaStateKey(lib, rel)); } catch (e) {}
  if (readingStateIndex[String(lib)]) delete readingStateIndex[String(lib)][String(rel)];
  return true;
}
function flushReadingProgressNow() {
  if (readingProgressFlushTimer) { clearTimeout(readingProgressFlushTimer); readingProgressFlushTimer = null; }
  if (readingProgressPending.size) flushReadingProgress();
}
function setComicShelfView(view) {
  /* v0.9.74：历史阅读成为书刊页的一个标签（未读 / 喜欢 / 历史阅读 / 全部），
     入口保留原函数名，行为交给 setBookShelfTab，避免两套视图状态打架。 */
  setBookShelfTab(view === "completed" ? "completed" : "shelf");
}
function setMediaPageSize(size) {
  mediaPageSize = [20, 50, 100].includes(Number(size)) ? Number(size) : 20;
  const lib = findMediaLibrary(localMediaSelection.comic);
  if (lib) loadLocalFiles("comic", lib, 0);
}
function setAudioPageSize(size) {
  audioPageSize = [20, 50, 100].includes(Number(size)) ? Number(size) : 20;
  const lib = findMediaLibrary(localMediaSelection.audio);
  if (lib) loadLocalFiles("audio", lib, 0);
}
function setAudioView(view) {
  audioView = ["albums", "artists", "files", "favorites", "playlists", "tracks"].includes(view) ? view : "albums";
  if (view !== "tracks") { audioTrackTitle = ""; audioArtistFilter = ""; audioPlaylistFilter = ""; audioGroupLock = null; }
  const lib = findMediaLibrary(localMediaSelection.audio);
  if (lib) loadLocalFiles("audio", lib, 0);
}
let mediaLibraryConfigGroup = "comic";
function mediaTypesForGroup(group) { return group === "comic" ? ["comic","book"] : group === "movie" ? ["movie","series"] : ["audio","musicvideo"]; }
function mediaTypeForGroup(group) { return mediaTypesForGroup(group)[0]; }
/* 子类型名称走 i18n（typeAudio/typeComic/…），未知类型回落原值。 */
function mediaTypeName(type) { const k = "type" + String(type).charAt(0).toUpperCase() + String(type).slice(1); const v = t(k); return v === k ? type : v; }
const MEDIA_FORMATS = {
  comic: ["epub","mobi","zip","cbz","pdf","rar","cbr","7z","cb7","jpg","jpeg","png","webp","gif","bmp","avif","cpg","lzh","cbl","tar","cbt"],
  book: ["epub","pdf","mobi","azw","azw3","chm","exe","umd","jar","jad","caj","pdg","djvu","djv","ceb","doc","docx","xps","txt"],
  audio: ["mp3","flac","m4a","ogg","wav","aac","ape","opus"],
  movie: ["mp4","mkv","avi","mov","m4v","webm","ts","m2ts","wmv","flv","mpg","mpeg","rmvb","iso"]
};
/* v0.9.92（需求）：封面/海报 sidecar 只作为封面出现，不进任何列表。
   与服务端 isMediaSidecarImage（media-go/cover_persist.go）保持同一套规则：
    <媒体名>.cover.<图片扩展名>            （v0.9.56 封面落盘）
    <媒体名>-poster|-fanart|-backdrop|-logo.<图片扩展名>（v0.9.89 角色图落盘）
   裸 cover.jpg / poster.jpg（媒体库级封面）不算。 */
const MEDIA_SIDECAR_IMAGE_EXTS = ["jpg", "jpeg", "png", "webp", "gif", "bmp", "avif"];
function isMediaSidecarImage(path) {
  const base = String(path || "").split("/").pop().toLowerCase();
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return false;
  if (!MEDIA_SIDECAR_IMAGE_EXTS.includes(base.slice(dot + 1))) return false;
  const stem = base.slice(0, dot);
  if (stem.endsWith(".cover")) return stem.slice(0, -".cover".length) !== "";
  return ["-poster", "-fanart", "-backdrop", "-logo"].some(role =>
    stem.endsWith(role) && stem.slice(0, -role.length) !== "");
}
function supportedLocalMediaFile(group, lib, path) {
  const ext = fileExt(path);
  if (!ext) return false;
  /* 客户反馈：电子书栏目里 xxx.cover.jpg 出现在目录列表中。 */
  if (isMediaSidecarImage(path)) return false;
  // 电子书与漫画库统一接受可阅读的电子书/漫画格式；库类型只影响展示标题。
  if (group === "comic") return [...new Set([...MEDIA_FORMATS.book, ...MEDIA_FORMATS.comic])].includes(ext);
  if (group === "audio") return (lib?.type === "musicvideo" ? MEDIA_FORMATS.movie : MEDIA_FORMATS.audio).includes(ext);
  return (MEDIA_FORMATS[group] || []).includes(ext);
}
function sessionWriteHeaders(json = false) { return json ? { "Content-Type": "application/json" } : {}; }
function jsArg(value) { return JSON.stringify(String(value)); }
function jsAttrArg(value) { return esc(jsArg(value)); }
function mediaFileUrl(lib, path) {
  const query = `id=${encodeURIComponent(String(lib.id))}&path=${encodeURIComponent(String(path))}`;
  return `/api/media/file?${query}`;
}
function mediaCompatUrl(lib, path) {
  const query = `id=${encodeURIComponent(String(lib.id))}&path=${encodeURIComponent(String(path))}&hw=${encodeURIComponent(settings.hardwareAcceleration || "auto")}`;
  return `/api/media/compat?${query}`;
}
function mediaProbeUrl(lib, path) {
  const query = `id=${encodeURIComponent(String(lib.id))}&path=${encodeURIComponent(String(path))}`;
  return `/api/media/probe?${query}`;
}
function browserPlaybackCapabilities() {
  const video = document.createElement("video");
  const mse = typeof MediaSource !== "undefined";
  const supported = mime => !!video.canPlayType(mime) || (mse && typeof MediaSource.isTypeSupported === "function" && MediaSource.isTypeSupported(mime));
  return {
    mse,
    mp4: supported('video/mp4'),
    h264: supported('video/mp4; codecs="avc1.42E01E,mp4a.40.2"'),
    hevc: supported('video/mp4; codecs="hvc1.1.6.L93.B0"'),
    vp9: supported('video/webm; codecs="vp09.00.10.08"'),
    aac: supported('audio/mp4; codecs="mp4a.40.2"'),
    opus: supported('audio/webm; codecs="opus"')
  };
}
/* v0.9.92：解/转码风向标。
   off = 服务端不做任何转码/重封装，原文件直出、由播放设备本地解码 ——
   服务器 CPU 算力弱时用它，避免转码把整机（连 WebUI 一起）打满。 */
function serverTranscodeDisabled() { return (settings.serverTranscode || "auto") === "off"; }
function serverTranscodePolicy() { return serverTranscodeDisabled() ? "off" : "auto"; }
function videoDecodePathText(plan) {
  let text = tf("vpDecodePath", { path: (plan && plan.hardware === "client") ? t("stCompassClient") : t("stCompassServer") });
  /* v0.9.91 审查修复：禁用服务端转码后画质上限不再生效，此前只在 toast 里说一次，
     面板上仍长期显示「720p」，与实际原画直出不符。这里做成常驻标注。 */
  if (plan && plan.hardware === "client" && serverTranscodeDisabled()) text += t("vpCapOff");
  return text;
}
/* 画质控件上标出「当前不生效」，避免与上方解码路径口径打架。 */
function markQualityCapInactive(root, quality) {
  if (!root) return;
  const host = root.querySelector("[data-video-quality-options]");
  if (!host) return;
  const capped = !!quality && quality !== "auto" && quality !== "original";
  host.classList.toggle("cap-inactive", capped && serverTranscodeDisabled());
  host.setAttribute("data-cap-inactive", (capped && serverTranscodeDisabled()) ? "1" : "0");
}
function setVideoDecodePath(root, text) {
  const el = root && root.querySelector("[data-video-decode]");
  if (!el) return;
  el.textContent = text || "";
  el.classList.toggle("show", !!text);
}
async function requestPlaybackPlan(lib, path, quality = "auto") {
  /* v0.9.51：播放计划请求必须带超时 —— 之前没有 AbortController，
     后端探测/转码服务异常时「正在准备播放…」会永远卡住，视频点不开。 */
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch("/api/media/playback/plan", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ library_id: String(lib.id), path: String(path), quality, hardware: settings.hardwareAcceleration || "auto", network_bps: Number(weakNetworkState().speedBps) || 0, client: browserPlaybackCapabilities(), server_transcode: serverTranscodePolicy() }),
      signal: controller.signal
    });
    if (!response.ok) {
      /* v0.9.92：把后端的原因带出来（例如禁用服务端转码后点原盘镜像会被如实拒绝）。 */
      let detail = "";
      try { const body = await response.clone().json(); detail = body && body.error ? "：" + body.error : ""; } catch (e) { /* 非 JSON 响应 */ }
      throw new Error(`播放计划 HTTP ${response.status}${detail}`);
    }
    return await response.json();
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("播放计划请求超时（20s），已转用本地降级策略");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
function playbackModeLabel(plan) {
  /* v0.9.92：禁用服务端转码时后端把 hardware 标成 client —— 界面直接说明是本地解码。 */
  if (plan && plan.hardware === "client") return "本机设备解码 · 原画直放";
  const labels = { direct: "Direct Play 原画直放", remux: "Smart Stream · Remux", audio_transcode: "Smart Stream · 仅音频转码", full_transcode: "Smart Stream · 完整转码" };
  return `${labels[plan?.mode] || "Smart Stream"}${plan?.hardware && plan.mode === "full_transcode" ? ` · ${plan.hardware.toUpperCase()}` : ""}`;
}
function mediaLegacyFileUrl(lib, path) {
  return `/api/media/file/${encodeURIComponent(lib.id)}/${String(path).split("/").map(encodeURIComponent).join("/")}`;
}
function normalizeLibraryPayload(data) {
  const libs = Array.isArray(data) ? data : (data?.libraries || data?.items || []);
  return libs.map((lib, idx) => ({
    id: String(lib.id || `library-${idx + 1}`),
    name: String(lib.name || lib.id || `媒体库 ${idx + 1}`),
    type: String(lib.type || "audio"),
    path: String(lib.path || ""),
    paths: Array.isArray(lib.paths) ? lib.paths.map(String).filter(Boolean) : [],
    files: Array.isArray(lib.files) ? lib.files : null
  }));
}
async function refreshMediaLibraries(notify) {
  try {
    const res = await fetch("/api/media/libraries", { headers: sessionWriteHeaders(), cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    localMediaLibraries = normalizeLibraryPayload(await res.json());
    /* v0.9.74：媒体库列表变化后，书刊页的整库索引与统计缓存一并失效。 */
    bookShelfIndexCache = {};
    bookShelfCountsCache = {};
    /* 媒体库列表变化后，系统设置里的表格、侧栏条目和顶栏统计都要跟着更新。 */
    if (typeof renderHomeLibTable === "function") renderHomeLibTable();
    if (typeof renderHomeLibraryNav === "function") renderHomeLibraryNav();
    if (typeof renderHomeCount === "function") renderHomeCount();
    ["comic", "movie", "audio"].forEach(group => renderLocalMedia(group));
    if (notify) toast("✅ 本地媒体库已刷新");
  } catch (err) {
    ["comic", "movie", "audio"].forEach(group => {
      const host = document.getElementById("media-wide-" + group);
      if (host) host.innerHTML = `<div class="media-error">无法读取本地媒体库：${esc(err.message)}</div>`;
    });
    if (notify) toast("⚠️ 无法读取媒体库配置");
  }
}
function librariesForGroup(group) {
  return localMediaLibraries.filter(lib => mediaTypesForGroup(group).includes(lib.type));
}
function renderLocalMedia(group) {
  const host = document.getElementById("media-wide-" + group);
  if (!host) return;
  const libs = librariesForGroup(group);
  if (!libs.length) {
    host.innerHTML = `<div class="media-empty"><div class="big">▤</div><h3>暂无已扫描资源</h3><p>请由管理员在系统设置的媒体库管理中添加并扫描目录。</p></div>`;
    return;
  }
  let selected = libs.find(lib => lib.id === localMediaSelection[group]) || libs[0];
  localMediaSelection[group] = selected.id;
  host.innerHTML = `<div class="local-media">
    <div id="local-media-content-${esc(group)}"><div class="empty-tip">${esc(t("homeLoading"))}</div></div>
    <div id="local-media-viewer-${esc(group)}"></div>
  </div>`;
  loadLocalFiles(group, selected);
}
function selectLocalLibrary(group, id) {
  localMediaSelection[group] = id;
  renderLocalMedia(group);
}

/* ================= 媒体搜索（v0.9.17） =================
   侧栏「媒体搜索」不再打开系统设置，而是切到 #view-search 页面并
   直接检索所有已索引媒体库的文件名，命中结果可直接打开播放/阅读。 */
let mediaSearchTimer = null;
let mediaSearchToken = 0;
function openMediaSearch() {
  switchView("search");
  const box = document.getElementById("mediaSearchInput");
  if (box) { box.focus(); if (box.value.trim()) runMediaSearch(); }
}
function scheduleMediaSearch() {
  clearTimeout(mediaSearchTimer);
  mediaSearchTimer = setTimeout(runMediaSearch, 320);
}
function clearMediaSearch() {
  clearTimeout(mediaSearchTimer);
  const box = document.getElementById("mediaSearchInput");
  if (box) { box.value = ""; box.focus(); }
  const badge = document.getElementById("mediaSearchBadge");
  if (badge) badge.textContent = t("searchIdle");
  const host = document.getElementById("mediaSearchResults");
  if (host) host.innerHTML = "";
}
function mediaSearchGroupOfLibrary(lib) {
  return ["comic", "movie", "audio"].find(group => mediaTypesForGroup(group).includes(lib.type)) || "movie";
}
function mediaSearchDisplayTitle(group, path) {
  if (group === "audio") return audioMetadataFor(String(path)).title || displayBookTitle(path);
  if (group === "movie") return movieMetadataFor(String(path)).title || displayBookTitle(path);
  return displayBookTitle(path);
}
async function runMediaSearch() {
  clearTimeout(mediaSearchTimer);
  const box = document.getElementById("mediaSearchInput");
  const host = document.getElementById("mediaSearchResults");
  const badge = document.getElementById("mediaSearchBadge");
  if (!box || !host) return;
  const query = String(box.value || "").trim();
  if (!query) { clearMediaSearch(); return; }
  const token = ++mediaSearchToken;
  if (badge) badge.textContent = t("searchRunning");
  host.innerHTML = `<div class="empty-tip">${esc(t("searchRunning"))}</div>`;
  const libs = (localMediaLibraries || []).slice();
  if (!libs.length) {
    host.innerHTML = `<div class="empty-tip">${esc(t("searchNoLibrary"))}</div>`;
    if (badge) badge.textContent = t("searchNoLibrary");
    return;
  }
  const groups = [];
  let total = 0;
  for (const lib of libs) {
    let files = [];
    try {
      const res = await fetch(`/api/media/files?id=${encodeURIComponent(lib.id)}&q=${encodeURIComponent(query)}&limit=500`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      files = normalizeFilePayload(data);
    } catch (err) { files = []; }
    if (token !== mediaSearchToken) return;
    const group = mediaSearchGroupOfLibrary(lib);
    const hits = files.filter(file => supportedLocalMediaFile(group, lib, String(file.path))).slice(0, 200);
    if (!hits.length) continue;
    total += hits.length;
    groups.push({ lib, group, hits });
  }
  if (token !== mediaSearchToken) return;
  if (!total) {
    host.innerHTML = `<div class="empty-tip">${esc(tf("searchEmpty", { q: query }))}</div>`;
    if (badge) badge.textContent = tf("searchHits", { n: 0 });
    return;
  }
  host.innerHTML = groups.map(({ lib, group, hits }) => {
    const rows = hits.map(file => {
      const path = String(file.path);
      return `<div class="media-file-row"><div class="media-file-name" title="${esc(path)}"><b>${esc(mediaSearchDisplayTitle(group, path))}</b><small>${esc(lib.name)} · ${esc(path)}</small></div>`
        + `<span class="media-file-meta">${esc(fileExt(path).toUpperCase())}</span>`
        + `<div class="media-actions"><button class="btn" onclick="openMediaSearchHit(${jsAttrArg(group)},${jsAttrArg(lib.id)},${jsAttrArg(path)})">${group === "audio" ? "▶ 播放" : group === "movie" ? "▶ 打开" : "📖 阅读"}</button></div></div>`;
    }).join("");
    return `<section class="content-collection"><div class="content-section-heading"><div><span class="eyebrow">${esc(lib.name)}</span><h3>${esc(mediaTypeName(lib.type))}</h3></div><span class="badge">${hits.length}</span></div><div class="media-file-list">${rows}</div></section>`;
  }).join("");
  if (badge) badge.textContent = tf("searchHits", { n: total });
}
function openMediaSearchHit(group, libId, path) {
  selectLocalLibrary(group, libId);
  switchView(group, libId);
  if (group === "audio") { playAudioFile(libId, path); return; }
  setTimeout(() => openLocalMedia(group, libId, path), 60);
}
function audioHasActivePlayback() { return !!activeAudio; }

/* ---------- v0.9.92：跨页「正在播放」入口的媒体侧实现（状态在 01-state.js） ---------- */
/* 播放面是否已经可见 —— 可见时不需要浮标入口。 */
function playbackSurfaceVisible(cur) {
  if (!cur) return false;
  const view = document.getElementById("view-" + (cur.group || "audio"));
  if (!view || !view.classList.contains("active")) return false;
  if (cur.kind === "audio") {
    const bar = document.getElementById("audio-bottom-player");
    return !!bar && bar.classList.contains("show");
  }
  const overlay = view.querySelector(".media-reader-overlay.movie-player");
  return !!overlay && overlay.offsetParent !== null;
}
function activePlaybackPlaying(cur) {
  if (!cur) return false;
  if (cur.kind === "audio") {
    const player = document.getElementById("audioPlayerElement");
    return !!(player && player.src && !player.paused);
  }
  const video = liveActiveVideoElement(cur);
  return !!(video && !video.paused);
}
/* 仍然活着的视频元素：切视图只是 display:none，元素没被销毁 —— 这种情况下
   「回到播放」是真正的续播（不重新建立流）。 */
function liveActiveVideoElement(cur) {
  if (!cur || cur.kind !== "video") return null;
  const wantPath = String(cur.path || ""), wantLib = String(cur.libId || "");
  const nodes = document.querySelectorAll("video[data-movie-player]");
  for (const video of nodes) {
    const root = video.closest(".media-video-body");
    if (!root) continue;
    if (wantPath && String(root.dataset.path || "") !== wantPath) continue;
    if (wantLib && String(root.dataset.library || "") !== wantLib) continue;
    return video;
  }
  return null;
}
function markVideoActivePlayback(root, video) {
  if (!root) return;
  const path = String(root.dataset.path || "");
  if (!path) return;
  const heading = root.querySelector("[data-video-title]");
  const title = String((heading && heading.textContent) || "").trim() || displayBookTitle(path);
  setActivePlayback({ kind: "video", group: "movie", libId: root.dataset.library || "", path, title, paused: !!(video && video.paused) });
}
/* 点「回到播放」：优先复用活着的元素，其次按保存的进度重开（不是从 0 起播）。 */
function resumeActivePlayback(cur) {
  if (!cur) return false;
  if (cur.kind === "audio") {
    switchView("audio", cur.libId);
    const bar = document.getElementById("audio-bottom-player");
    if (audioHasActivePlayback()) {
      if (bar) bar.classList.add("show");
      updatePlaybackDock();
      return true;
    }
    if (typeof playAudioFile === "function" && findMediaLibrary(cur.libId)) { playAudioFile(cur.libId, cur.path); return true; }
    return false;
  }
  const video = liveActiveVideoElement(cur);
  if (video) {
    switchView("movie", cur.libId);
    const overlay = video.closest(".media-reader-overlay");
    if (overlay) overlay.classList.remove("video-minimized", "video-controller-docked");
    video.closest(".media-video-body")?.querySelector(".video-chrome")?.classList.remove("video-chrome-minimized");
    expandVideoPlayer(video);
    if (video.paused) video.play().catch(() => {});
    updatePlaybackDock();
    return true;
  }
  if (findMediaLibrary(cur.libId)) {
    /* 元素已被销毁（例如重新进过库）：重开播放器，restoreVideoPlaybackState 会按
       localStorage 里的进度续播，不会从 0 开始。 */
    openLocalMedia("movie", cur.libId, cur.path).catch(() => {});
    return true;
  }
  return false;
}
function returnToActivePlayback() {
  const cur = typeof activePlayback === "function" ? activePlayback() : null;
  if (!cur) return;
  if (resumeActivePlayback(cur)) return;
  switchView(cur.group || "movie", cur.libId);
}
/* 浮标上的播放/暂停：直接作用于当前播放元素，不重开流。 */
function toggleActivePlayback() {
  const cur = typeof activePlayback === "function" ? activePlayback() : null;
  if (!cur) return;
  if (cur.kind === "audio") { audioTogglePause(); return; }
  const video = liveActiveVideoElement(cur);
  if (!video) { resumeActivePlayback(cur); return; }
  if (video.paused) video.play().catch(() => {}); else video.pause();
}
/* 浮标上的 ✕：停止播放并收起入口。 */
function stopActivePlayback() {
  const cur = typeof activePlayback === "function" ? activePlayback() : null;
  if (!cur) return;
  if (cur.kind === "audio") { audioStop(); return; }
  const video = liveActiveVideoElement(cur);
  if (video) { try { video.pause(); } catch (e) {} }
  clearActivePlayback("video");
}
function normalizeFilePayload(data) {
  const files = Array.isArray(data) ? data : (data?.files || data?.items || []);
  return files.map(item => typeof item === "string" ? { path: item } : item).filter(item => item?.path);
}
/* v0.9.90：整库索引改为「大块 + 让出主线程」拉取。
   旧实现对 18.4 万条的库要顺序发 370 次 limit=500，且过程中从不归还事件循环，
   远程访问时表现为长时间无响应。 */
function libraryIndexYield() { return new Promise(resolve => setTimeout(resolve, 0)); }
async function fetchAllLibraryFiles(libId, firstPage, firstOffset = 0, opts = {}) {
  const chunk = Math.max(500, Number(opts.chunk) || LIBRARY_INDEX_CHUNK);
  const files = normalizeFilePayload(firstPage);
  let offset = firstOffset + files.length;
  while (firstPage.has_more) {
    const res = await fetch(`/api/media/files?id=${encodeURIComponent(libId)}&offset=${offset}&limit=${chunk}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const page = await res.json();
    const list = normalizeFilePayload(page);
    files.push(...list);
    if (typeof opts.onProgress === "function") {
      try { opts.onProgress(files.length, page); }
      catch (e) { if (typeof console !== "undefined") console.debug("索引进度回调异常（不影响拉取）", e); }
    }
    if (!page.has_more || !list.length) break;
    const nextOffset = offset + list.length;
    if (nextOffset <= offset) throw new Error("媒体列表分页游标未前进");
    offset = nextOffset;
    firstPage = page;
    /* 归还一次事件循环：大库拉取期间页面依然可点、可滚动。 */
    await libraryIndexYield();
  }
  return files;
}
/* 影视库和剧集聚合统一加载全部索引，不显示固定数量分页。 */
async function fetchRemainingLibraryFiles(libId, startOffset) {
  return { files: await fetchAllLibraryFiles(libId, { has_more: true }, startOffset), truncated: false };
}
/* v0.9.90：书刊架（含电子书大库）独立成函数 —— 索引未到齐时可先出首屏，
   到齐后再重绘。筛选 / 排序 / 统计 / 翻页仍在本地做，保持「整库可见」语义。 */
function renderComicShelf(lib, index, offset, opts = {}) {
  const target = document.getElementById("local-media-content-comic");
  if (!target) return;
  const prefs = bookShelfPrefs();
  const cached = bookShelfIndexCache[lib.id];
  const fresh = opts.force === true || (offset === 0 || !cached || (Date.now() - Number(cached.at || 0)) > 60000);
  const files = (fresh || !cached) ? index.slice() : cached.files.slice();
  if (fresh && !opts.preview) bookShelfIndexCache[lib.id] = { at: Date.now(), files };
  if ((fresh || opts.preview) && opts.keepCount !== true) {
    const counts = { shelf: 0, like: 0, completed: 0, all: files.length };
    /* v0.9.90：readingState / isBookFavorite 已是 O(1) 内存索引，
       18.4 万条也只是几次线性遍历（旧实现是 37 万次 localStorage 解析）。 */
    files.forEach(file => {
      const path = String(file.path);
      const progress = Number(readingState(lib.id, path).progress || 0);
      if (progress >= COMPLETED_PROGRESS) counts.completed++; else counts.shelf++;
      if (isBookFavorite(lib.id, path)) counts.like++;
    });
    if (!opts.preview) bookShelfCountsCache[lib.id] = counts;
  }
  /* v0.9.92：keepCount=true（下滑翻页 / 「继续加载」只放大渲染窗口）时沿用上次统计 ——
     窗口扩张不改变整库统计，没必要对 18.4 万条再跑一遍全量遍历。 */
  bookShelfTab = BOOK_SHELF_TABS.some(x => x.id === bookShelfTab) ? bookShelfTab : (prefs.tab || "shelf");
  comicShelfView = bookShelfTab === "completed" ? "completed" : "shelf";
  const visible = bookSortFiles(files.filter(file => {
    const path = String(file.path);
    const progress = Number(readingState(lib.id, path).progress || 0);
    /* v0.9.74：「全部」标签移除 —— 扫描到的文件统一先进「书架」，
       书架/历史阅读之外不再提供整库视图；counts.all 仅作为页头全库计数保留。 */
    if (bookShelfTab === "like") return isBookFavorite(lib.id, path);
    if (bookShelfTab === "completed") return progress >= COMPLETED_PROGRESS;
    return progress < COMPLETED_PROGRESS;
  }), prefs.sort);
  const size = Math.max(1, Number(prefs.pageSize) || mediaPageSize || 20);
  const pages = Math.max(1, Math.ceil(visible.length / size));
  bookShelfPage = Math.min(Math.max(0, Number(bookShelfPage) || 0), pages - 1);
  bookShelfOffset = bookShelfPage * size;
  bookShelfVisibleCache = visible;
  /* v0.9.90：不分页视图按窗口渐进渲染（整库仍可达，只是分批进 DOM）。
     旧写法把 18.4 万张卡一次性塞进 DOM，浏览器直接假死。 */
  /* 中小库一次全部渲染（与旧版行为一致）；超过 BOOK_SHELF_AUTO_MAX 才走窗口。 */
  const slice = bookShelfWindowSlice(visible, prefs);
  const pageFiles = slice.pageFiles, more = slice.more;
  const head = opts.notice ? `<div class="shelf-loading">${esc(opts.notice)}</div>` : "";
  target.innerHTML = head + bookShelfPageHtml(lib, pageFiles || [], bookShelfCountsCache[lib.id], visible.length) + more;
  scrapeVisibleBookCovers(target);
  /* v0.9.92：下滑自动翻页状态（more 为空 = 整库已渲染完，不再翻页）。 */
  mediaPagingSet({ mode: more ? "window" : "", group: "comic", libId: String(lib.id), offset: 0, pageSize: size, hasMore: !!more });
}
/* 「继续加载」按钮：不动索引与筛选结果，只把渲染窗口再放大一屏。 */
function bookShelfLoadMore() {
  const lib = findMediaLibrary(localMediaSelection.comic);
  if (!lib) return;
  bookShelfRenderLimit = Math.max(BOOK_SHELF_RENDER_WINDOW, Number(bookShelfRenderLimit) || 0) + BOOK_SHELF_AUTO_MAX;
  const cached = bookShelfIndexCache[lib.id];
  if (!cached) return;
  renderComicShelf(lib, cached.files.slice(), 0, { force: true, keepCount: true });
}

/* ===================== v0.9.92：下滑自动翻页 =====================
   客户要求：「聚焦鼠标操作或者键盘操作下滑自动进入下一页（从第一页开始加速渲染，
   每下滑一下就滑动一页）」。

   设计：
   1) 只有一份全局监听器（滚轮 + 键盘），不在每次渲染时挂载 —— 长会话不会累积监听器。
   2) 两种翻页模式共用同一入口 mediaAutoPage()：
      · mode="window"：书刊架渐进渲染窗口，下滑 = 再展开一屏（等价「继续加载」）；
      · mode="offset"：服务端分页视图（音乐库 / 文件列表），下滑 = 取下一页 offset。
   3) 「每滑一下就翻一页」：翻页后进入冷却窗口，且必须真的处于「到底 / 到顶」才触发，
      一次惯性滚动不会连翻数页。
   4) 「从第一页开始加速渲染」：第一页先落 DOM（书刊架首屏预览渲染已存在），
      窗口模式再展开时数据都在内存里，直接同步渲染 —— 每次翻页都是即时可见的。
   ============================================================================ */
const MEDIA_SCROLL_TRIGGER_PX = 160;  /* 距底/顶多少像素内算「到底 / 到顶」 */
const MEDIA_SCROLL_SETTLE_MS = 700;   /* 翻页后的冷却，防惯性滚动连翻 */
const MEDIA_SCROLL_FAIL_COOLDOWN_MS = 4000; /* v0.9.92：翻页失败后的冷静期（防连发重试） */
const mediaPagingState = { mode: "", group: "", libId: "", offset: 0, pageSize: 0, hasMore: false, busy: false, at: 0 };
function mediaPagingSet(state) { Object.assign(mediaPagingState, state || {}, { busy: false }); }
function mediaPagingReset() { mediaPagingSet({ mode: "", group: "", libId: "", offset: 0, pageSize: 0, hasMore: false }); }
/* 当前是否停在媒体库视图里（媒体库视图是整页滚动）。 */
function mediaPagingHost() {
  const host = document.querySelector(".media-wide-host.show");
  return host && host.offsetParent !== null ? host : null;
}
/* 到底 / 到顶判定：优先看在滚动的那个容器，媒体库通常是整页滚动。 */
function mediaPagingEdge(host) {
  const inner = host && mediaPagingState.group
    ? host.querySelector("#local-media-content-" + mediaPagingState.group) : null;
  if (inner && inner.scrollHeight > inner.clientHeight + 40) {
    return {
      atBottom: inner.scrollTop + inner.clientHeight >= inner.scrollHeight - MEDIA_SCROLL_TRIGGER_PX,
      atTop: inner.scrollTop <= MEDIA_SCROLL_TRIGGER_PX,
    };
  }
  const doc = document.documentElement;
  return {
    atBottom: (window.innerHeight + window.scrollY) >= (doc.scrollHeight - MEDIA_SCROLL_TRIGGER_PX),
    atTop: window.scrollY <= MEDIA_SCROLL_TRIGGER_PX,
  };
}
/* 翻页：direction 1 = 下一页 / 再展开一屏；-1 = 上一页。返回是否真的翻动了。 */
function mediaAutoPage(direction) {
  const st = mediaPagingState;
  if (st.busy || !st.mode) return false;
  const now = Date.now();
  if (now - Number(st.at || 0) < MEDIA_SCROLL_SETTLE_MS) return false;
  if (now < Number(st.blockUntil || 0)) return false;
  if (direction > 0 && !st.hasMore) return false;
  if (direction < 0 && !(st.mode === "offset" && st.offset > 0)) return false;
  st.busy = true;
  st.at = now;
  /* v0.9.92（审查发现的低危项）：翻页请求失败时进入更长的冷却窗口。
     旧实现 120ms 后就清 busy，而 loadLocalFiles 失败不会推进 offset/hasMore，
     用户停在底部继续滚就会把同一个失败请求打成连发。 */
  const finish = (ok) => {
    if (!ok) mediaPagingState.blockUntil = Date.now() + MEDIA_SCROLL_FAIL_COOLDOWN_MS;
    setTimeout(() => { mediaPagingState.busy = false; }, ok ? 120 : 0);
  };
  try {
    if (direction > 0 && st.mode === "window") {
      /* 「继续加载」把渲染窗口再放大一屏；新卡片接在末尾，翻完顺势往下带一屏。 */
      bookShelfLoadMore();
      const step = Math.max(240, Math.round(window.innerHeight * 0.9));
      try { window.scrollBy({ top: step, behavior: reducedMotionOn() ? "auto" : "smooth" }); } catch (e) { window.scrollBy(0, step); }
      finish(true);
      return true;
    }
    const lib = findMediaLibrary(st.libId);
    if (!lib) { finish(false); return false; }
    const nextOffset = direction > 0 ? st.offset + st.pageSize : Math.max(0, st.offset - st.pageSize);
    /* busy 保持到这一页真正取回来：请求失败时进入冷静期，成功才 120ms 后解锁。 */
    const pending = loadLocalFiles(st.group, lib, nextOffset);
    if (pending && typeof pending.then === "function") {
      pending.then(() => finish(true)).catch(() => finish(false));
    } else {
      finish(true);
    }
    /* 下一页回顶部、上一页贴底，保持「继续滑一下就是再翻一页」的手感。 */
    try {
      window.scrollTo({ top: direction > 0 ? 0 : document.documentElement.scrollHeight, behavior: "auto" });
    } catch (e) { window.scrollTo(0, direction > 0 ? 0 : document.documentElement.scrollHeight); }
    return true;
  } finally {
    /* 兜底：任何没走 finish() 的异常路径都不会把 busy 永久钉住。 */
    setTimeout(() => { if (mediaPagingState.busy && Date.now() - Number(mediaPagingState.at || 0) > 8000) mediaPagingState.busy = false; }, 8000);
  }
}
function mediaPagingKeyTargetBlocked(target) {
  if (!target) return false;
  const tag = String(target.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  if (target.isContentEditable) return true;
  /* 播放器/阅读器自己有键盘语义（空格播放暂停、左右切集、翻页），不要抢键。 */
  if (target.closest && (target.closest("[data-video-panel]") || target.closest(".media-video-body") ||
      target.closest(".media-viewer-doc") || target.closest(".comic-reader"))) return true;
  return false;
}
function installMediaScrollPaging() {
  if (installMediaScrollPaging.done) return;
  installMediaScrollPaging.done = true;
  document.addEventListener("wheel", (event) => {
    if (!mediaPagingState.mode || mediaPagingKeyTargetBlocked(event.target)) return;
    const host = mediaPagingHost();
    if (!host || !event.target || !event.target.closest || !event.target.closest(".media-wide-host")) return;
    const delta = Number(event.deltaY) || 0;
    if (Math.abs(delta) < 2) return;
    const edge = mediaPagingEdge(host);
    const down = delta > 0;
    if (down ? !edge.atBottom : !edge.atTop) return;
    mediaAutoPage(down ? 1 : -1);
  }, { passive: true });
  document.addEventListener("keydown", (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (!mediaPagingState.mode || mediaPagingKeyTargetBlocked(event.target)) return;
    const downKeys = ["PageDown", "ArrowDown", " "];
    const upKeys = ["PageUp", "ArrowUp"];
    const down = downKeys.includes(event.key), up = upKeys.includes(event.key);
    if (!down && !up) return;
    const host = mediaPagingHost();
    if (!host) return;
    const edge = mediaPagingEdge(host);
    if (down ? !edge.atBottom : !edge.atTop) return;
    if (!mediaAutoPage(down ? 1 : -1)) return;
    event.preventDefault();
  });
}
function reducedMotionOn() {
  return typeof settings !== "undefined" && !!settings.reduceMotion;
}
installMediaScrollPaging();

async function loadLocalFiles(group, lib, offset = 0) {
  const target = document.getElementById("local-media-content-" + group);
  if (!target) return;
  /* v0.9.92：切库即释放其它库的重型缓存（整库索引 / 书架列表 / 阅读状态索引）。 */
  if (lib && lib.id) releaseMediaHeavyCaches(lib.id);
  try {
    /* v0.9.70：已读/未读筛选必须基于完整索引。
       旧实现给已读视图发送 limit=100000，服务端会按安全上限截断，导致已读书籍
       重新打开后偶尔显示空白且无法展开。先按正常分页游标拉完，再在本地筛选，
       同时让两种视图共享同一份完整索引。 */
    /* v0.9.86：音乐库改为整库展开（不再分页），首屏请求直接按 500 一页取，
   其余分页在下面一次性补完 —— 大库少打几个来回。 */
    const pageSize = group === "comic" ? mediaPageSize : group === "audio" ? 500 : group === "movie" ? 500 : 100;
    /* v0.9.82：整库索引的会话级复用（远程访问提速的关键）。
       命中缓存时不再请求任何分页；缓存过期只发一个 limit=1 的小请求比对服务端索引版本。 */
    let data = null, files = null, fromSession = false;
    const session = libraryIndexSessionGet(lib.id, group);
    if (session) {
      let reuse = (Date.now() - Number(session.at || 0)) <= LIBRARY_INDEX_TTL_MS;
      if (!reuse) {
        const version = await libraryIndexVersionProbe(lib);
        reuse = !!version && version === session.version;
      }
      if (reuse) {
        session.at = Date.now();
        data = { status: session.status, total: session.total, version: session.version, has_more: false, files: [] };
        files = session.files.slice();
        fromSession = true;
      }
    }
    if (!files) {
      const res = await fetch(`/api/media/files?id=${encodeURIComponent(lib.id)}&offset=${offset}&limit=${pageSize}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      data = await res.json();
      files = normalizeFilePayload(data);
      if (group === "comic" && data.status !== "indexing") {
        /* v0.9.90：先拿第一页立刻出画面，整库索引随后分块补齐再重绘。
           旧写法要等 18.4 万条全部到手才渲染，期间页面一片空白且频繁无响应。 */
        if (data.has_more && files.length) {
          bookShelfRenderLimit = 0;
          renderComicShelf(lib, files.slice(), offset, { preview: true, notice: t("shelfLoadingIndex") });
        }
        files = await fetchAllLibraryFiles(lib.id, data, offset, {
          chunk: LIBRARY_INDEX_CHUNK,
          onProgress: (count) => {
            const el = document.querySelector("#local-media-content-comic .shelf-loading");
            if (el) el.textContent = tf("shelfLoadingIndexN", { n: count, total: Number(data.total) || 0 });
          },
        });
        data.has_more = false;
      }
    }
    files = files.sort((a, b) => String(a.path).localeCompare(String(b.path), "zh-CN"));
    files = files.filter(file => supportedLocalMediaFile(group, lib, String(file.path)));
    if (data.status === "indexing") {
      /* 旧版本只显示一句「请稍后刷新」，用户无法判断卡住还是仍在扫描。
         现在渲染一个能监测的进度块，并启动 /api/media/index/status 轮询。 */
      target.innerHTML = buildProgressHtml(lib);
      startBuildProgressWatch(group, lib);
      return;
    }
    stopBuildProgressWatch(group);
    /* v0.9.30：书刊书架要按服务端保存的阅读进度分「未读 / 已读收藏」，
       所以过滤前必须先把该库的持久化进度拉回来，否则清缓存后全部回到未读。 */
    if (group === "comic") await loadReadingProgress(lib.id);
    /* 影视库统一补齐全部索引，电影和电视剧均不再显示分页或截断提示。 */
    let mediaTruncated = false;
    /* v0.9.86（客户要求）：音乐库取消分页限制 —— 与影视一样一次拉完整库索引，
       页面上不再出现「上一页 / 下一页 / 每页 N」。追加时保持服务端返回顺序，
       不做二次排序，避免打乱「最近入库」的既有次序。 */
    if (group === "audio" && data.has_more && !fromSession) {
      const rest = await fetchRemainingLibraryFiles(lib.id, offset + normalizeFilePayload(data).length);
      files = files.concat(rest.files.filter(file => supportedLocalMediaFile(group, lib, String(file.path))));
      data.has_more = false;
      audioCursor = 0;
    }
    if (group === "movie" && data.has_more && !fromSession) {
      const rest = await fetchRemainingLibraryFiles(lib.id, offset + normalizeFilePayload(data).length);
      const extra = rest.files.filter(file => supportedLocalMediaFile(group, lib, String(file.path)));
      files = files.concat(extra).sort((a, b) => String(a.path).localeCompare(String(b.path), "zh-CN"));
      mediaTruncated = rest.truncated;
      data.has_more = false;
    }
    /* v0.9.84：整库索引补齐后，先把蓝光原盘的片段合并成一条再往下走 ——
       否则「一部原盘 = 600+ 个无元数据影片」，列表不可用、刮削也无从命中。 */
    if (group === "movie") {
      const beforeCollapse = files.length;
      files = collapseDiscFragments(files);
      if (files.length !== beforeCollapse) { data.total = files.length; mediaTruncated = false; }
    }
    /* v0.9.82：影视 / 书刊都是「整库索引」语义 —— 缓存给本会话后续切库、切视图复用。 */
    if (!fromSession && (group === "movie" || group === "comic" || group === "audio") && data.status !== "indexing") {
      libraryIndexSession[lib.id] = { at: Date.now(), group, version: String(data.version || ""), total: Number(data.total) || files.length, status: data.status, files: files.slice() };
    }
    /* v0.9.90：书刊架的计算与渲染已抽到 renderComicShelf()（首屏/重绘复用）。 */
    const prev = offset > 0 ? `<button class="btn" onclick="loadLocalFiles('${esc(group)}',findMediaLibrary('${esc(lib.id)}'),${Math.max(0, offset - pageSize)})">← 上一页</button>` : "";
    const next = data.has_more ? `<button class="btn" onclick="loadLocalFiles('${esc(group)}',findMediaLibrary('${esc(lib.id)}'),${offset + pageSize})">下一页 →</button>` : "";
    /* 过滤后可能一条不剩（例如整页都是已读，或整页都是不支持的扩展名）。
       此时旧写法会算出「1-0 / 848」这种不成立的区间，改为显式提示本页为空。 */
    const total = Number(data.total) || files.length;
    const range = files.length ? `${offset + 1}-${offset + files.length}` : "本页无匹配";
    const seriesAllLoaded = group === "movie";
    const pager = seriesAllLoaded
      ? `<div class="media-actions"><span class="media-file-meta">已加载全部 ${files.length} / ${total} 项${mediaTruncated ? "（加载未完成）" : ""}</span></div>`
      : `<div class="media-actions">${prev}<span class="media-file-meta">${range} / ${total}</span>${next}${data.has_more ? `<span class="page-scroll-hint">${esc(t("pagerScrollHint"))}</span>` : ""}</div>`;
    if (group === "comic") {
      /* v0.9.74：书刊展示页 = 页头（库名 / 条目 / 路径 / 扫描时间）
         + 工具栏（书架视图分段标签 + 排序 + 网格密度 + 视图设置）+ 封面网格 + 分页。 */
      bookShelfRenderLimit = 0;
      renderComicShelf(lib, files, offset, { force: true });
    } else if (group === "audio") {
      /* v0.9.57：专辑/歌手分组播放时（audioGroupLock 活跃）挂起 audioFiles 覆盖 ——
         歌手刮削完成等异步重载如果无条件重赋分页列表，会把「播放队列=该专辑/歌手」冲回整库；
         列表展示仍按当前分页数据渲染，仅播放队列保持分组。setAudioView 切换页签即释放锁。 */
      if (!audioGroupLock) { audioFiles = files; audioCursor = offset; }
      target.innerHTML = renderAudioLibrary(lib, files, data);
      /* v0.9.73：整页/整专辑重载会替换 audioFiles（队列真相），面板要同步重建。 */
      refreshAudioPlaylistPanel();
      scrapeAudioMetadata(target, lib, files);
    } else if (group === "movie") {
      target.innerHTML = renderMovieLibrary(lib, files, data) + pager;
      /* v0.9.51：播放器的「上一个 / 下一个 / 播放列表」用这批已排序的文件作为队列。 */
      setVideoPlaylist(lib.id, files);
      if (lib?.type === "series") scrapeSeriesMetadata(target, lib, files);
      else scrapeMovieMetadata(target, lib, files);
    } else {
      target.innerHTML = `${files.length ? `<div class="media-file-list">${files.map(file => renderLocalFileRow(group, lib, file)).join("")}</div>` : '<div class="empty-tip">该媒体库中暂无支持的文件</div>'}${pager}`;
    }
    /* v0.9.92：下滑自动翻页状态。书刊架由 renderComicShelf / renderBookShelfPage 自己登记
       （窗口模式）；其余分组走服务端分页（offset 模式）。整库已加载完则关闭翻页。 */
    if (group !== "comic") {
      if (!seriesAllLoaded && data.has_more) {
        mediaPagingSet({ mode: "offset", group, libId: String(lib.id), offset, pageSize, hasMore: true });
      } else {
        mediaPagingReset();
      }
    }
  } catch (err) {
    target.innerHTML = `<div class="media-error">文件列表读取失败：${esc(err.message)}</div>`;
  }
}

/* ================= 索引构建进度（v0.7.0 修复「构建卡加载无法监测」） =================
   后端 /api/media/index/status 现在返回 percent / scanned / total / elapsed，
   前端据此渲染真实进度条并每 2 秒轮询；构建结束后自动加载文件列表。 */
const buildWatchTimers = {};
function formatBuildElapsed(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60), r = s % 60;
  if (m < 60) return m + "m" + String(r).padStart(2, "0") + "s";
  return Math.floor(m / 60) + "h" + String(m % 60).padStart(2, "0") + "m";
}
function buildProgressHtml(lib, st) {
  const scanned = Number(st?.scanned || 0);
  const total = Number(st?.total || 0);
  const pct = Number(st?.percent || 0);
  const elapsed = Number(st?.elapsed || 0);
  const known = total > 0;
  return `<div class="build-progress" data-build-lib="${esc(lib.id)}">
    <div class="bp-head">
      <strong>⏳ ${esc(t("buildProgress"))}</strong>
      <span class="bp-pct">${known ? pct + "%" : esc(t("buildWaiting"))}</span>
    </div>
    <div class="bp-bar ${known ? "" : "indeterminate"}"><i style="width:${known ? pct : 100}%"></i></div>
    <div class="bp-meta">
      <span>${esc(tf("buildScanned", { n: scanned.toLocaleString(curLang === "en" ? "en-US" : "zh-CN") }))}${known ? " / " + total.toLocaleString(curLang === "en" ? "en-US" : "zh-CN") : ""}</span>
      <span>${esc(tf("buildElapsed", { sec: formatBuildElapsed(elapsed) }))}</span>
    </div>
    <div class="media-actions">
      <button class="btn" type="button" onclick="refreshBuildProgress(${jsAttrArg(lib.id)})">↻ ${esc(t("buildRefresh"))}</button>
      <button class="btn btn-danger" type="button" onclick="cancelLibraryBuild(${jsAttrArg(lib.id)})">■ ${esc(t("buildCancel"))}</button>
    </div>
  </div>`;
}
async function fetchBuildStatus(libId) {
  try {
    const res = await fetch("/api/media/index/status", { cache: "no-store" });
    if (!res.ok) return null;
    const data = await res.json();
    return (data.libraries || []).find(x => x.lib === libId) || null;
  } catch (e) { return null; }
}
function stopBuildProgressWatch(group) {
  if (buildWatchTimers[group]) { clearInterval(buildWatchTimers[group]); delete buildWatchTimers[group]; }
}
function startBuildProgressWatch(group, lib) {
  stopBuildProgressWatch(group);
  buildWatchTimers[group] = setInterval(async () => {
    const host = document.getElementById("local-media-content-" + group);
    const block = host?.querySelector(`[data-build-lib="${CSS.escape(lib.id)}"]`);
    if (!host || !block) { stopBuildProgressWatch(group); return; }
    const st = await fetchBuildStatus(lib.id);
    if (!st) return;
    if (!st.running && (st.state === "ready" || st.state === "error" || st.state === "cancelled")) {
      stopBuildProgressWatch(group);
      if (st.state === "ready") toast("✅ " + t("buildDone"));
      else if (st.state === "cancelled") toast("■ " + t("buildCancelled"));
      /* v0.9.82：扫描刚写入/取消过索引 —— 必须丢掉会话缓存再重载，否则会显示旧索引。 */
      libraryIndexSessionClear(lib.id);
      loadLocalFiles(group, lib, 0);
      return;
    }
    block.outerHTML = buildProgressHtml(lib, st);
  }, 2000);
}
async function refreshBuildProgress(libId) {
  const lib = findMediaLibrary(libId);
  if (!lib) return;
  const group = homeGroupOfType(lib.type);
  loadLocalFiles(group, lib, 0);
}
async function cancelLibraryBuild(libId) {
  try {
    const res = await fetch(`/api/media/index/cancel?id=${encodeURIComponent(libId)}`, { method: "POST", headers: sessionWriteHeaders(), credentials: "same-origin" });
    if (!await handleProtectedResponse(res)) { toast("⚠️ " + t("caddySaveBlocked")); return; }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    toast("■ " + t("buildCancelled"));
  } catch (err) { toast("⚠️ " + err.message); }
}
function fileExt(path) { const match = String(path).toLowerCase().match(/\.([^.\/]+)$/); return match ? match[1] : ""; }
function formatFileSize(size) {
  const n = Number(size);
  if (!Number.isFinite(n) || n < 0) return "--";
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}
function readAudioMetadata() {
  if (audioMetadataMemory) return audioMetadataMemory;
  audioMetadataMemory = vaultStoreJSON(audioMetadataCache, {});
  return audioMetadataMemory;
}
function writeAudioMetadata(data) {
  audioMetadataMemory = data || {};
  /* v0.9.82：统一走 vaultStoreSet —— 失败时先清理可重建缓存再重试一次，仍失败才退化为
     内存缓存，并按真实原因（配额已满 / 站点禁止写入）提示一次。服务端 sqlite 缓存仍是
     权威来源，重开页面会自动回灌。 */
  vaultStoreSet(audioMetadataCache, audioMetadataMemory);
}
/* v0.9.56：封面写入媒体库持久化 —— 刮削/手动设置封面后自动 POST 到后端，
   存成媒体文件同目录 sidecar（<名>.cover.jpg/png/webp/gif），展示走同源本地 URL，
   换浏览器/清缓存后封面仍在；媒体目录只读时静默回退远端直链，不影响展示。 */
const coverPersistAttempted = new Set(); // 会话级：每个文件每会话最多尝试一次落盘
function coverIsLocal(url) { return String(url || "").indexOf("/api/media/cover") === 0; }
async function persistCoverToLibrary(libId, path, coverUrl) {
  if (!libId || !path || !coverUrl || coverIsLocal(coverUrl)) return coverUrl;
  const key = `${libId}\n${path}`;
  if (coverPersistAttempted.has(key)) return coverUrl;
  coverPersistAttempted.add(key);
  try {
    const res = await fetch("/api/media/cover", { method: "POST", headers: sessionWriteHeaders(true), credentials: "same-origin", body: JSON.stringify({ id: libId, path: String(path), url: coverUrl }) });
    const data = res.ok ? await res.json() : null;
    return data && data.url ? data.url : coverUrl;
  } catch (e) { return coverUrl; }
}
async function localizeAudioCover(libId, path) {
  const meta = audioMetadataFor(path);
  if (!meta || !meta.cover || coverIsLocal(meta.cover)) return;
  const local = await persistCoverToLibrary(libId, path, meta.cover);
  if (local !== meta.cover) {
    const all = readAudioMetadata();
    all[path] = { ...(all[path] || {}), cover: local };
    writeAudioMetadata(all);
    syncActiveAudioCover(path);
  }
}
function syncActiveAudioCover(path) {
  if (!activeAudio || String(activeAudio.path) !== String(path)) return;
  const meta = audioMetadataFor(path);
  const coverEl = document.getElementById("audioCover");
  if (coverEl && meta.cover) { coverEl.src = coverThumbUrl(meta.cover, 320); coverEl.style.background = ""; }
  updateAudioExpandArt(meta);
  /* v0.9.62：封面更新后同步更新背景虚化 */
  if (meta.cover) setPlaybackBg(meta.cover);
}
function audioBaseMetadata(path) {
  /* 先用原始文件名解析「歌手 - 歌名」，displayBookTitle 会把连字符换成空格，
     直接拿它切分会丢掉歌手信息。
     v0.9.71：分隔符扩展到日文/全角常见写法（－ − — ― ／ ｜），并把全角数字折成半角 ——
     「アーティスト－タイトル」「０１ 曲名」这类命名此前会解析成「未知歌手」，
     歌手名进不了刮削查询，日语曲目因此更难命中。字母保持原样（不改变展示）。 */
  const raw = String(path).split("/").pop().replace(/\.[^.]+$/, "").trim();
  const normalized = raw
    .replace(/\u3000/g, " ")
    .replace(/[\uFF10-\uFF19]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/[－−—―–]/g, "-")
    .replace(/[／｜]/g, "/");
  /* 去掉开头的音轨号：必须是「前导零」（01）或带分隔符（1. / 1- / 1_），
     否则「24 Hours」这类正常标题会被削掉数字。 */
  const withoutTrack = normalized
    .replace(/^\s*0\d{1,2}\s*[.\-_]?\s+/, "")
    .replace(/^\s*\d{1,3}\s*[.\-_]\s*/, "");
  const parts = withoutTrack.split(/\s+-\s+|\s*-\s*|\s*\/\s*/).map(x => x.trim()).filter(Boolean);
  const stem = displayBookTitle(path);
  if (parts.length > 1) {
    return { title: parts.slice(1).join(" - "), artist: parts[0], album: "未知专辑", cover: "", lyrics: "" };
  }
  return { title: withoutTrack || stem, artist: "未知歌手", album: "未知专辑", cover: "", lyrics: "" };
}

function audioMetadataFor(path, cache) {
  const all = cache || readAudioMetadata();
  return { ...audioBaseMetadata(path), ...(all[path] || {}) };
}

/* v0.9.56：歌手刮削 —— 歌手维度独立于单曲元数据。
   localStorage 缓存结构：{ [artist]: { name, cover, provider, collaborators:[], checkedAt } }
   会话内已尝试过的歌手不再重复请求；刮削失败（无 provider）保持文字/渐变占位。 */
const audioArtistCache = "vaulthub_audio_artists_v1";
const audioArtistAttemptedSession = new Set();
function readAudioArtistCache() { return vaultStoreJSON(audioArtistCache, {}); }
function writeAudioArtistCache(data) { vaultStoreSet(audioArtistCache, data); }
function audioArtistInfoFor(artist) {
  const all = readAudioArtistCache();
  return all[String(artist)] || null;
}
async function scrapeAudioArtists(host, lib, files) {
  /* 与歌曲刮削共用 audioScrapeChain：artists 视图渲染/视图切换并发触发多轮
     歌手刮削时，交错读写会互相覆盖刚写入的歌手缓存条目（同类竞态歌曲侧已由
     同一串行链解决）。串行后 in-flight 去重由 audioArtistAttemptedSession 兜住。 */
  const run = audioScrapeChain.then(() => scrapeAudioArtistsInner(host, lib, files));
  audioScrapeChain = run.catch(() => {});
  return run;
}
async function scrapeAudioArtistsInner(host, lib, files) {
  const pending = new Set();
  files.forEach(file => {
    const meta = audioMetadataFor(String(file.path));
    const artist = (meta && meta.artist) || "未知歌手";
    if (artist === "未知歌手" || pending.has(artist) || audioArtistAttemptedSession.has(artist)) return;
    const cached = audioArtistInfoFor(artist);
    if (cached && cached.cover) return; // 已有头像不再重复拉
    pending.add(artist);
  });
  let updated = false;
  for (const artist of pending) {
    try {
      const response = await fetch(`/api/media/audio/artist?name=${encodeURIComponent(artist)}`, { cache: "force-cache" });
      const item = response.ok ? await response.json() : null;
      const all = readAudioArtistCache();
      if (item && item.provider) {
        all[artist] = { name: item.name || artist, cover: item.cover || "", provider: item.provider, collaborators: Array.isArray(item.collaborators) ? item.collaborators : [artist], checkedAt: Date.now() };
        updated = true;
      } else {
        /* 刮削失败（404/两源都没命中）：记一条 provider 为空的缓存 —— 卡片保持
           文件名解析出的歌手名文字占位，且刷新后不再反复请求同一歌手。 */
        all[artist] = { name: artist, cover: "", provider: "", collaborators: [artist], checkedAt: Date.now() };
      }
      writeAudioArtistCache(all);
    } catch (e) { /* 网络异常：保持占位，会话内不再重试 */ }
    audioArtistAttemptedSession.add(artist);
  }
  if (updated && host && lib) {
    const target = document.getElementById("local-media-content-audio");
    if (target) loadLocalFiles("audio", lib, audioCursor);
  }
}
function refreshAudioArtistScrape() {
  try { localStorage.removeItem(audioArtistCache); } catch (e) {}
  audioArtistAttemptedSession.clear();
  const lib = findMediaLibrary(localMediaSelection.audio);
  if (lib) loadLocalFiles("audio", lib, audioCursor);
  toast("🔄 正在重新刮削歌手信息");
}
/* MusicBrainz 的 /recording 检索永远会返回「最像」的一条，哪怕相关度很低。
   之前无条件采纳 recordings[0]，导致「周杰伦 - 七里香.mp3」被刮成标题
   “周杰倫”、歌手“王泰翔 2000wtx”，「五月天 - 倔强.flac」被刮成
   “倔强- 五月天”。这里改成结构化查询 + 打分与文本双重校验：
   只有 score 足够高、且标题或歌手能和文件名解析结果对上，才覆盖本地元数据；
   否则保留文件名解析结果并记下 checkedAt，避免反复请求。 */
const AUDIO_MB_MIN_SCORE = 88;
function audioNorm(s) {
  return String(s || "").toLowerCase().replace(/[\s._\-–—'"`·、,，:：!！?？()（）\[\]]/g, "");
}
function audioMatchAcceptable(fallback, item) {
  if (Number(item.score || 0) < AUDIO_MB_MIN_SCORE) return false;
  const wantTitle = audioNorm(fallback.title);
  const gotTitle = audioNorm(item.title);
  const titleOk = !!wantTitle && !!gotTitle
    && (gotTitle === wantTitle || gotTitle.includes(wantTitle) || wantTitle.includes(gotTitle));
  const wantArtist = audioNorm(fallback.artist);
  const credits = (item["artist-credit"] || []).map(c => audioNorm(c && c.name)).filter(Boolean);
  const artistOk = !wantArtist || wantArtist === audioNorm("未知歌手")
    || credits.some(c => c === wantArtist || c.includes(wantArtist) || wantArtist.includes(c));
  /* 标题必须对上；歌手在文件名没给出时不作要求。 */
  return titleOk && artistOk;
}
/* v0.9.56：每页面会话内每首歌最多自动刮一次（成功/失败都记），刷新页面即重新尝试 ——
   既避免同一会话内反复请求（旧逻辑会把失败的文件名兜底永久留在 localStorage，
   刷新后永不重刮；5 分钟时间窗又让「刚失败想立即刷新重试」的用户干等）。 */
const audioScrapeAttemptedSession = new Set();
/* v0.9.88：服务端已记过「未命中/失败」的曲目，在重试窗口内不再联网查询 ——
   音乐本来就有服务端持久化（v0.9.67 sidecar + SQLite + /api/media/audio/cache），
   但以前只把成功的曲目当「已刮削」，not_found/failed 的每次进库、每换一个浏览器
   都会把整库失败曲目重新查一遍，正是客户说的「多次批量重复读取」。
   窗口 10 分钟与影视刮削的重试窗口一致：既不做无意义重查，也不会让刚失败想重试
   的用户干等太久（超窗后进库即重试）。 */
const AUDIO_SCRAPE_RETRY_MS = 10 * 60 * 1000;
/* v0.9.56：刮削串行链 —— 首页「最近入库」、音乐库视图、周期刷新会并发触发多次
   scrapeAudioMetadata；并行整表/交错写会把刚本地化的封面冲回远端。链式串行后，
   后发调用等前一轮完成，pending 过滤自然为空（已有 provider 不再刮）。 */
let audioScrapeChain = Promise.resolve();
function scrapeAudioMetadata(host, lib, files) {
  const run = audioScrapeChain.then(() => scrapeAudioMetadataInner(host, lib, files));
  audioScrapeChain = run.catch(() => {});
  return run;
}
async function scrapeAudioMetadataInner(host, lib, files) {
  /* v0.9.67：先吃服务端缓存（sqlite，绑定 size+mtime 失效）——
     换浏览器/清缓存后无需重新联网刮削，上千首也是毫秒级。 */
  await loadAudioServerCache(lib.id);
  const all = readAudioMetadata();
  const pending = files.filter(file => {
    const path = String(file.path);
    if (audioScrapeAttemptedSession.has(path)) return false;
    const meta = all[path];
    if (!meta) return true;
    if (meta.provider) return false; // 已成功（iTunes/MusicBrainz）或手动编辑（manual）都不再自动覆盖
    /* v0.9.88：服务端已记过未命中/失败且在重试窗口内 → 不重复联网。 */
    const status = String(meta.status || "");
    const checkedAt = Number(meta.checkedAt || 0);
    if ((status === "not_found" || status === "failed") && checkedAt && Date.now() - checkedAt < AUDIO_SCRAPE_RETRY_MS) return false;
    return true;
  });
  let updated = false;
  for (const file of pending) {
    const path = String(file.path), fallback = audioBaseMetadata(path);
    const known = fallback.artist && fallback.artist !== "未知歌手";
    try {
      const response = await fetch(`/api/media/audio/metadata?title=${encodeURIComponent(fallback.title)}&artist=${encodeURIComponent(known?fallback.artist:"")}`, { cache: "force-cache" });
      const item = response.ok ? await response.json() : null;
      if (item) {
        /* v0.9.67：成功结果写入服务端缓存，供下次直接读取（不重复联网）。 */
        /* v0.9.72：先把封面落到源目录，再统一提交元数据与真实状态；
           服务端 sidecar + SQLite 都成功才算 persisted。 */
        let localizedCover = item.cover || "";
        if (localizedCover) localizedCover = await persistCoverToLibrary(lib.id, path, localizedCover);
        const committed = await commitAudioMetadata({ id:lib.id, path,
          title:item.title||fallback.title, artist:item.artist||fallback.artist, album:item.album||fallback.album,
          cover:localizedCover, provider:item.provider||"MusicBrainz", status:"succeeded", source:item.provider||"auto",
          query_title:fallback.title, query_artist:known?fallback.artist:"", country:"AUTO" });
        item.cover = localizedCover;
        item.persisted = !!committed.persisted;
        /* v0.9.56：单路径合并写，不再基于旧快照整表覆写 —— 音乐库视图与首页「最近入库」
           可能并发触发多次刮削，整表写会把另一路刚本地化的封面冲回远端。 */
        const cur = readAudioMetadata();
        cur[path] = {
          ...(cur[path] || fallback),
          title: item.title || fallback.title,
          artist: item.artist || fallback.artist,
          album: item.album || fallback.album,
          cover: item.cover || fallback.cover || "",
          provider: item.provider || "MusicBrainz",
          persisted: !!item.persisted,
          checkedAt: Date.now(),
        };
        writeAudioMetadata(cur);
        // 封面写入媒体库持久化（每路径独立合并写，落盘失败自动回退远端直链）
        await localizeAudioCover(lib.id, path);
        updated = true;
      } else {
        await commitAudioMetadata({id:lib.id,path,title:fallback.title,artist:fallback.artist,album:fallback.album,status:"not_found",error_code:"no_reliable_match",source:"auto",query_title:fallback.title,query_artist:known?fallback.artist:"",country:"AUTO"});
        markAudioScrapeMiss(path, fallback, "not_found", "no_reliable_match");
      }
    } catch (e) {
      try { await commitAudioMetadata({id:lib.id,path,title:fallback.title,artist:fallback.artist,album:fallback.album,status:"failed",error_code:"scrape_unavailable",source:"auto",query_title:fallback.title,query_artist:known?fallback.artist:"",country:"AUTO"}); } catch (_) {}
      markAudioScrapeMiss(path, fallback, "failed", "scrape_unavailable");
    }
    audioScrapeAttemptedSession.add(path); // 无论成败，本会话内不再重复请求该曲
  }
  if (updated && host && lib) renderAudioLibraryContent(host, lib, files);
}
/* v0.9.88：单路径合并写「未命中/失败」状态 —— 与成功路径同一套合并写法，
   不做整表覆写（音乐库视图与首页最近入库可能并发触发刮削）。 */
function markAudioScrapeMiss(path, fallback, status, errorCode) {
  try {
    const cur = readAudioMetadata();
    cur[path] = {
      ...(cur[path] || fallback || audioBaseMetadata(path)),
      title: (cur[path] && cur[path].title) || fallback.title,
      artist: (cur[path] && cur[path].artist) || fallback.artist,
      album: (cur[path] && cur[path].album) || fallback.album,
      status: String(status || ""),
      error_code: String(errorCode || ""),
      checkedAt: Date.now()
    };
    writeAudioMetadata(cur);
  } catch (e) { /* 本地状态写失败不影响服务端已记录的结果 */ }
}
/* ================= v0.9.56 专辑/歌手批量编辑 =================
   需求：「允许编辑专辑或者歌手」—— 专辑/歌手卡片上的 ✎ 打开批量编辑弹窗，
   改名与封面一次写入该专辑/歌手下的全部曲目（localStorage 元数据层，
   与手动适配单曲同一存储），provider 记为 manual 后自动刮削不再覆盖。
   注意：分组曲目要按整库拉取（fetchAllLibraryFiles），只用当前页会漏改后面几页。 */
async function audioGroupFilesAll(kind, key) {
  const target = String(key), lib = findMediaLibrary(localMediaSelection.audio);
  let pool = audioFiles || [];
  if (lib) {
    try {
      const all = await fetchAllLibraryFiles(lib.id, { has_more: true }, 0);
      const audioOnly = all.filter(file => supportedLocalMediaFile("audio", lib, String(file.path)));
      if (audioOnly.length) pool = audioOnly;
    } catch (e) { /* 整库拉取失败：退回当前页，至少不阻塞编辑 */ }
  }
  return pool.filter(file => {
    const meta = audioMetadataFor(String(file.path));
    return kind === "artist" ? meta.artist === target : meta.album === target;
  });
}
async function openAudioGroupEdit(kind, key) {
  const isArtist = kind === "artist";
  const files = await audioGroupFilesAll(kind, key);
  const meta = files.length ? audioMetadataFor(String(files[0].path)) : { cover: "" };
  document.getElementById("audioGroupEditKind").value = isArtist ? "artist" : "album";
  document.getElementById("audioGroupEditKey").value = String(key);
  document.getElementById("audioGroupEditTitle").innerHTML = `编辑${isArtist ? "歌手" : "专辑"}<button class="close" onclick="closeModal('audioGroupEditModal')">✕</button>`;
  document.getElementById("audioGroupEditNameLabel").textContent = isArtist ? "歌手名" : "专辑名";
  document.getElementById("audioGroupEditName").value = String(key);
  document.getElementById("audioGroupEditCover").value = isArtist ? ((audioArtistInfoFor(key) || {}).cover || "") : (meta.cover || "");
  document.getElementById("audioGroupEditHint").textContent = `将同时更新该${isArtist ? "歌手" : "专辑"}下的 ${files.length} 首曲目信息。`;
  openModal("audioGroupEditModal");
}
async function saveAudioGroupEdit() {
  const kind = document.getElementById("audioGroupEditKind").value;
  const key = document.getElementById("audioGroupEditKey").value;
  const name = document.getElementById("audioGroupEditName").value.trim();
  const cover = document.getElementById("audioGroupEditCover").value.trim();
  if (!name) { toast("⚠️ 名称不能为空"); return; }
  const files = await audioGroupFilesAll(kind, key);
  if (!files.length) { toast("⚠️ 该分组下没有曲目"); return; }
  const all = readAudioMetadata();
  files.forEach(file => {
    const path = String(file.path), base = audioBaseMetadata(path), cur = all[path] || base;
    all[path] = {
      ...cur,
      artist: kind === "artist" ? name : (cur.artist || base.artist),
      album: kind === "album" ? name : (cur.album || base.album),
      cover: cover || cur.cover || "",
      provider: "manual",
      checkedAt: Date.now(),
    };
  });
  writeAudioMetadata(all);
  if (kind === "artist") {
    // 歌手改名/换头像：同步歌手缓存，避免卡片仍显示旧头像；
    // 保留此前刮削解析出的合作演唱参与者（collaborators），不以 [name] 覆盖。
    const artistCache = readAudioArtistCache();
    const prev = artistCache[String(key)];
    delete artistCache[String(key)];
    artistCache[name] = { name, cover: cover || (prev && prev.cover) || "", provider: "manual",
      collaborators: (prev && Array.isArray(prev.collaborators) && prev.collaborators.length && prev.collaborators[0] !== name)
        ? prev.collaborators : [name], checkedAt: Date.now() };
    writeAudioArtistCache(artistCache);
    audioArtistAttemptedSession.add(name);
  }
  if (audioArtistFilter === String(key)) audioArtistFilter = name;
  if (audioTrackTitle === String(key)) audioTrackTitle = name;
  closeModal("audioGroupEditModal");
  toast(`✅ 已更新 ${files.length} 首曲目`);
  const lib = findMediaLibrary(localMediaSelection.audio);
  if (lib) loadLocalFiles("audio", lib, audioCursor);
}

function audioCoverData(meta, title) {
  /* v0.9.56 修复：onerror 里原来直接插 JSON.stringify(title)，其双引号会提前闭合
     HTML 属性 —— 封面加载失败时抛 SyntaxError: Unexpected end of input，
     文字占位反而不生效。改用 jsAttrArg（JSON 串再做 HTML 转义）。 */
  return meta.cover ? `<img src="${esc(coverThumbUrl(meta.cover, 320))}" alt="${esc(title)}" loading="lazy" decoding="async" onerror="this.replaceWith(Object.assign(document.createElement('span'),{textContent:${jsAttrArg(title)}}))">` : esc(title);
}
function renderAudioAlbums(lib, files) {
  const groups = new Map();
  files.forEach(file => { const meta = audioMetadataFor(String(file.path)); const key = meta.album || "未知专辑"; if (!groups.has(key)) groups.set(key, { meta, files: [] }); groups.get(key).files.push(file); });
  /* v0.9.56：卡片整卡点击 → 该专辑全部曲目。
     v0.9.57：新增「▶ 播放」—— 不进入列表，直接播放该专辑全部歌曲（队列即专辑）。
     v0.9.66：移除卡片上的 ✎ 编辑按钮 —— 它与「点击海报进入曲目列表」功能重复，
     专辑/歌手信息编辑统一放在曲目列表头部（openAudioGroupEdit）。 */
  return `<div class="audio-album-grid">${[...groups.entries()].map(([album, group]) => `<article class="audio-album-card" onclick="openAudioTracks('${esc(lib.id)}','album',${esc(JSON.stringify(album))})"><div class="audio-album-cover" style="background:${coverGradient(album)}">${audioCoverData(group.meta, album)}</div><div class="audio-album-info"><strong>${esc(album)}</strong><small>${esc(group.meta.artist)} · ${group.files.length} 首</small><div class="media-actions"><button class="btn" title="直接播放该专辑全部歌曲" onclick="event.stopPropagation();playAudioGroup('${esc(lib.id)}','album',${esc(JSON.stringify(album))})">▶ 播放</button><button class="btn" title="喜欢专辑" onclick="event.stopPropagation();toggleAudioFavorite(${jsAttrArg(lib.id)},${jsAttrArg(group.files[0].path)})">${isAudioFavorite(lib.id, group.files[0].path) ? "♥" : "♡"}</button></div></div></article>`).join("")}</div>`;
}
function renderAudioArtists(lib, files) {
  const groups = new Map();
  files.forEach(file => { const meta = audioMetadataFor(String(file.path)); const key = meta.artist || "未知歌手"; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(file); });
  /* v0.9.56：歌手卡片封面优先用歌手刮削头像（localStorage 缓存），
     未刮削/失败时回落渐变首字。
     v0.9.57：新增「▶ 播放」—— 直接播放该歌手全部歌曲（队列即歌手）。
     v0.9.66：同专辑卡片，移除重复的 ✎ 编辑按钮。 */
  return `<div class="audio-album-grid audio-artist-grid">${[...groups.entries()].map(([artist, songs]) => { const artistMeta = audioArtistInfoFor(artist); const cover = artistMeta && artistMeta.cover ? `<img class="audio-artist-avatar" src="${esc(coverThumbUrl(artistMeta.cover, 320))}" alt="${esc(artist)}" loading="lazy" onerror="this.parentElement.classList.add('audio-artist-avatar-fallback');this.remove()">` : ""; return `<article class="audio-album-card audio-artist-card" onclick="openAudioTracks('${esc(lib.id)}','artist',${esc(JSON.stringify(artist))})"><div class="audio-album-cover audio-artist-cover" style="${cover ? "" : `background:${coverGradient(artist)}`}">${cover || esc(artist)}</div><div class="audio-album-info"><strong>${esc(artist)}</strong><small>${songs.length} 首歌曲${artistMeta && artistMeta.collaborators && artistMeta.collaborators.length > 1 ? " · 合作演唱" : ""}</small><div class="media-actions"><button class="btn" title="直接播放该歌手全部歌曲" onclick="event.stopPropagation();playAudioGroup('${esc(lib.id)}','artist',${esc(JSON.stringify(artist))})">▶ 播放</button><button class="btn" title="喜欢歌手" onclick="event.stopPropagation();toggleAudioFavorite(${jsAttrArg(lib.id)},${jsAttrArg(songs[0].path)})">${isAudioFavorite(lib.id, songs[0].path) ? "♥" : "♡"}</button></div></article>`; }).join("")}</div>`;
}
let audioArtistFilter = "";
/* v0.9.56：点击专辑/歌手卡片 → 展示该专辑/歌手全部曲目。
   之前沿用 loadLocalFiles 分页只取第一页、tracks 视图又隐藏翻页器，
   曲目较多的专辑/歌手只能看到前 N 首；现改为整单拉取（与歌单 loadPlaylistTracks
   同款），并把 audioFiles 设为该集合 —— 点击任一曲目播放后，上一首/下一首/
   自动连播都在该专辑/歌手内，满足「点击曲目直接播放歌手/专辑」。 */
async function audioGroupFiles(libId, kind, key) {
  const lib = findMediaLibrary(libId);
  if (!lib) return [];
  const all = await fetchAllLibraryFiles(lib.id, { has_more: true }, 0);
  return all
    .filter(file => supportedLocalMediaFile("audio", lib, String(file.path)))
    .filter(file => { const meta = audioMetadataFor(String(file.path)); return kind === "artist" ? meta.artist === key : meta.album === key; })
    .sort((a, b) => String(a.path).localeCompare(String(b.path), "zh-CN"));
}
/* v0.9.57：分组播放队列锁 —— playAudioGroup / openAudioTracks 设置，
   刮削完成/分页等异步 loadLocalFiles 不再覆盖 audioFiles（保持「队列=专辑/歌手」），
   用户切换音乐页签（setAudioView）即释放。 */
let audioGroupLock = null;
/* v0.9.57：一键直接播放专辑/歌手全部歌曲（不进曲目列表），
   队列即该分组 —— 上一首/下一首/自动连播都在分组内。 */
function playAudioGroup(libId, kind, key) {
  audioGroupFiles(libId, kind, String(key)).then(files => {
    if (!files.length) { toast("⚠️ 该分组暂无歌曲"); return; }
    audioFiles = files;
    audioCursor = 0;
    audioGroupLock = { kind, key: String(key) };
    playAudioFile(libId, files[0].path);
  }).catch(() => toast("⚠️ 拉取分组歌曲失败"));
}
async function openAudioTracks(libId, kind, key) {
  audioArtistFilter = String(key);
  audioPlaylistFilter = "";
  audioTrackTitle = String(key);
  audioView = "tracks";
  audioTracksBack = kind === "artist" ? "artists" : "albums";
  const lib = findMediaLibrary(libId);
  const host = document.getElementById("local-media-content-audio");
  if (!lib || !host) return;
  try {
    const files = await audioGroupFiles(lib.id, kind, String(key));
    audioFiles = files;
    audioCursor = 0;
    audioGroupLock = { kind, key: String(key) };
    if (!files.length) { audioTrackTitle = ""; audioArtistFilter = ""; audioView = audioTracksBack; audioGroupLock = null; }
    renderAudioLibraryContent(host, lib, files);
  } catch (e) {
    loadLocalFiles("audio", lib, 0); // 拉取失败回退分页视图
  }
}
let audioTracksBack = "albums"; // 曲目列表「← 返回」目标：albums | artists | playlists
function renderAudioTrackList(lib, files) {
  /* v0.9.56：曲目列表头部不再放播放模式按钮（随机/列表循环/顺序），
     循环模式只在播放器底部按钮中体现（cycleAudioLoop）。
     v0.9.57：专辑/歌手分组曲目列表头部增加「▶ 播放全部」——
     点击直接播放当前分组全部歌曲（队列即该专辑/歌手）。 */
  const back = audioTracksBack === "artists" ? "artists" : audioTracksBack === "playlists" ? "playlists" : "albums";
  const groupPlay = (back === "artists" || back === "albums")
    ? `<button class="btn audio-play-all" title="直接播放当前${back === "artists" ? "歌手" : "专辑"}全部歌曲" onclick="playAudioGroup('${esc(lib.id)}','${back === "artists" ? "artist" : "album"}',${esc(JSON.stringify(audioTrackTitle))})">▶ 播放全部</button>`
    : "";
  /* v0.9.66：编辑入口从海报卡片移到曲目列表头部 —— 海报卡片本身点击即可进入本列表，
     编辑按钮放这里既保留 v0.9.56「可编辑专辑/歌手」能力，又消除功能重复。 */
  const groupEdit = (back === "artists" || back === "albums")
    ? `<button class="btn" title="编辑当前${back === "artists" ? "歌手" : "专辑"}名称与封面" onclick="openAudioGroupEdit('${back === "artists" ? "artist" : "album"}',${jsAttrArg(audioTrackTitle)})">✎ 编辑</button>`
    : "";
  return `<div class="audio-track-head">${groupPlay}${groupEdit}<button class="btn" onclick="audioTrackTitle='';audioArtistFilter='';audioPlaylistFilter='';setAudioView('${back}')">← 返回</button><strong>${esc(audioTrackTitle)}</strong><span class="media-file-meta">${files.length} 首</span></div>${files.length ? `<div class="media-file-list">${files.map(file => renderAudioRow(lib, file)).join("")}</div>` : '<div class="empty-tip">该列表下暂无歌曲</div>'}`;
}
function renderAudioLibraryContent(host, lib, files, data) {
  const latest = [...files].sort((a, b) => Number(b.mtime || 0) - Number(a.mtime || 0)).slice(0, 8);
  /* v0.9.86：音乐库取消「上一页 / 下一页 / 每页 N」——
     整库一次展示，这里只留一行「已展开全部 N 首」的统计。 */
  const total = Number((data && data.total) || files.length) || files.length;
  const pager = `<div class="media-actions"><span class="media-file-meta">已展开全部 ${files.length} 首${total > files.length ? ` / ${total}` : ""} · 音乐库不再分页</span></div>`;
  const visibleFiles = audioPlaylistFilter ? files : audioArtistFilter ? files.filter(file => { const meta = audioMetadataFor(String(file.path)); return meta.artist === audioArtistFilter || meta.album === audioArtistFilter; }) : files;
  let body = audioView === "tracks" ? renderAudioTrackList(lib, visibleFiles) : audioView === "artists" ? renderAudioArtists(lib, files) : audioView === "playlists" ? renderAudioPlaylists(lib) : audioView === "favorites" ? renderAudioFavorites(lib) : renderAudioAlbums(lib, files);
  const latestGrid = audioView === "albums" && latest.length ? `<section class="content-collection latest-music"><div class="content-section-heading"><div><span class="eyebrow">最新音乐</span><h3>最近识别与入库</h3></div></div><div class="audio-latest-grid">${latest.map(file => renderAudioLatestCard(lib, file)).join("")}</div></section>` : "";
  const audioTabs = `<div class="audio-view-tabs"><button class="${audioView === "albums" ? "active" : ""}" onclick="setAudioView('albums')">专辑</button><button class="${audioView === "artists" ? "active" : ""}" onclick="setAudioView('artists')">歌手</button><button class="${audioView === "playlists" || (audioView === "tracks" && audioPlaylistFilter) ? "active" : ""}" onclick="setAudioView('playlists')">♫ 歌单</button><button class="${audioView === "favorites" ? "active" : ""}" onclick="setAudioView('favorites')">♥ 喜欢</button></div>`;
  host.innerHTML = `<section class="content-collection">${mediaLibraryHeading(lib, "", audioTabs)}${body}${audioView === "favorites" || audioView === "tracks" || audioView === "playlists" ? "" : pager}</section>${latestGrid}`;
  /* v0.9.56：歌手视图渲染后异步刮削歌手头像（成功后自动重渲染刷新封面）。
   刮削失败（两源都没命中）时把 provider 留空写进缓存，卡片走「文件名/歌手名文字占位」，
   即用户要求的「刮削失败则以文件名展示」。 */
  if (audioView === "artists") scrapeAudioArtists(host, lib, files);
}
function renderAudioLatestCard(lib, file) { const path=String(file.path), meta=audioMetadataFor(path); return `<article class="audio-latest-card" onclick="playAudioFile(${jsAttrArg(lib.id)},${jsAttrArg(path)})"><div class="audio-latest-cover" style="background:${coverGradient(meta.title)}">${audioCoverData(meta, meta.title)}</div><div><strong>${esc(meta.title)}</strong><small>${esc(meta.artist)}</small></div><button class="btn" title="喜欢" onclick="event.stopPropagation();toggleAudioFavorite(${jsAttrArg(lib.id)},${jsAttrArg(path)})">${isAudioFavorite(lib.id,path)?"♥":"♡"}</button></article>`; }
function renderAudioLibrary(lib, files, data) { const host = document.createElement("div"); renderAudioLibraryContent(host, lib, files, data); return host.innerHTML; }
function renderAudioRow(lib, file) { const path = String(file.path), meta = audioMetadataFor(path); return `<div class="media-file-row audio-row-click" data-audio-path="${esc(path)}" onclick="playAudioFile(${jsAttrArg(lib.id)},${jsAttrArg(path)})"><div class="media-file-name" title="${esc(path)}"><b>${esc(meta.title)}</b><small>${esc(meta.artist)} · ${esc(meta.album)}</small></div><span class="media-file-meta">${esc(fileExt(path).toUpperCase())}</span><div class="media-actions"><button class="btn" title="播放" onclick="event.stopPropagation();playAudioFile(${jsAttrArg(lib.id)},${jsAttrArg(path)})">▶</button><button class="btn" title="喜欢" onclick="event.stopPropagation();toggleAudioFavorite(${jsAttrArg(lib.id)},${jsAttrArg(path)})">${isAudioFavorite(lib.id, path) ? "♥" : "♡"}</button><button class="btn" title="加入歌单" onclick="event.stopPropagation();openAudioPlaylistPicker(${jsAttrArg(lib.id)},${jsAttrArg(path)})">♫</button><button class="btn" title="编辑歌曲信息" onclick="event.stopPropagation();openAudioMetadata(${jsAttrArg(path)})">✎</button></div></div>`; }
function refreshAudioMetadata() { audioMetadataMemory=null; try { localStorage.removeItem(audioMetadataCache); } catch (e) {} audioScrapeAttemptedSession.clear(); const lib = findMediaLibrary(localMediaSelection.audio); if (lib) loadLocalFiles("audio", lib, 0); toast("🔄 正在重新刮削音乐信息"); }
function openAudioMetadata(path) {
  const meta = audioMetadataFor(path);
  const value = (id, v) => { const el=document.getElementById(id); if(el) el.value=v||""; };
  value("audioMetadataPath", path); value("audioMetadataTitle", meta.title); value("audioMetadataArtist", meta.artist);
  value("audioMetadataAlbum", meta.album); value("audioMetadataCover", meta.cover); value("audioMetadataLyrics", meta.lyrics);
  value("audioMetadataQueryTitle", meta.query_title); value("audioMetadataQueryArtist", meta.query_artist);
  value("audioMetadataCountry", meta.country||"AUTO"); value("audioMetadataSource", meta.source||"auto");
  for (const [id,key] of [["audioLockTitle","lock_title"],["audioLockArtist","lock_artist"],["audioLockAlbum","lock_album"],["audioLockCover","lock_cover"],["audioLockLyrics","lock_lyrics"]]) {
    const el=document.getElementById(id); if(el) el.checked=!!meta[key];
  }
  const hint=document.getElementById("audioMetadataPersistHint"); if(hint) hint.textContent=meta.persisted===false?"⚠ 上次仅缓存到服务器，源目录不可写":"保存后会同时缓存到服务器和音频源目录";
  openModal("audioMetadataModal");
}
function manualAudioMetadata(path) { openAudioMetadata(path); }
function audioEditorPayload(status="manual") {
  const path=document.getElementById("audioMetadataPath").value, base=audioBaseMetadata(path);
  return { id:String(localMediaSelection.audio||""), path,
    title:document.getElementById("audioMetadataTitle").value.trim()||base.title,
    artist:document.getElementById("audioMetadataArtist").value.trim()||"未知歌手",
    album:document.getElementById("audioMetadataAlbum").value.trim()||"未知专辑",
    cover:document.getElementById("audioMetadataCover").value.trim(), lyrics:document.getElementById("audioMetadataLyrics").value,
    provider:status==="manual"?"manual":"", status, source:document.getElementById("audioMetadataSource").value||"auto",
    query_title:document.getElementById("audioMetadataQueryTitle").value.trim(), query_artist:document.getElementById("audioMetadataQueryArtist").value.trim(), country:document.getElementById("audioMetadataCountry").value||"AUTO",
    lock_title:document.getElementById("audioLockTitle").checked, lock_artist:document.getElementById("audioLockArtist").checked,
    lock_album:document.getElementById("audioLockAlbum").checked, lock_cover:document.getElementById("audioLockCover").checked, lock_lyrics:document.getElementById("audioLockLyrics").checked };
}
async function commitAudioMetadata(payload) {
  const res=await fetch("/api/media/audio/metadata/commit",{method:"POST",headers:sessionWriteHeaders(true),credentials:"same-origin",body:JSON.stringify(payload)});
  const data=await res.json(); if(!res.ok) throw new Error(data.error||`HTTP ${res.status}`); return data;
}
async function saveManualAudioMetadata() {
  const payload=audioEditorPayload("manual"), all=readAudioMetadata();
  try {
    const saved=await commitAudioMetadata(payload); all[payload.path]={...payload,provider:"manual",checkedAt:Date.now(),persisted:!!saved.persisted}; writeAudioMetadata(all);
    if(payload.cover) await localizeAudioCover(payload.id,payload.path); syncActiveAudioCover(payload.path); closeModal("audioMetadataModal");
    toast(saved.persisted?"✅ 已保存并写入音频源目录":"⚠️ 已保存到服务器缓存，但音频源目录不可写");
    const lib=findMediaLibrary(payload.id); if(lib) loadLocalFiles("audio",lib,audioCursor);
  } catch(e) { toast("⚠️ 保存失败："+e.message); }
}
async function rescrapeAudioFromEditor() {
  const payload=audioEditorPayload("running"), queryTitle=payload.query_title||payload.title, queryArtist=payload.query_artist||payload.artist;
  const hint=document.getElementById("audioMetadataPersistHint"); if(hint) hint.textContent="正在使用校正参数刮削…";
  try {
    const qs=new URLSearchParams({title:queryTitle,artist:queryArtist,country:payload.country,source:payload.source});
    const res=await fetch("/api/media/audio/metadata?"+qs,{cache:"no-store"}); const item=await res.json(); if(!res.ok) throw new Error(item.error||`HTTP ${res.status}`);
    if(!payload.lock_title) document.getElementById("audioMetadataTitle").value=item.title||payload.title;
    if(!payload.lock_artist) document.getElementById("audioMetadataArtist").value=item.artist||payload.artist;
    if(!payload.lock_album) document.getElementById("audioMetadataAlbum").value=item.album||payload.album;
    if(!payload.lock_cover) document.getElementById("audioMetadataCover").value=item.cover||payload.cover;
    if(hint) hint.textContent=`候选已命中：${item.provider||"未知来源"}，确认后点“保存适配”`;
  } catch(e) { if(hint) hint.textContent="未找到可靠候选："+e.message; }
}
let audioLoopMode = "sequence";
let audioExpandPage = "poster"; // 展开播放器当前页：poster | lyrics（v0.9.56）
let lastLyricActiveIndex = -1;  // 歌词高亮切换检测（避免重复滚动）
function setAudioExpandPage(page) {
  if (page !== "poster" && page !== "lyrics") page = "poster";
  audioExpandPage = page;
  const shell = document.getElementById("audioExpand");
  if (shell) shell.dataset.page = page;
  const posterTab = document.getElementById("audioExpandPosterTab"), lyricsTab = document.getElementById("audioExpandLyricsTab");
  if (posterTab) posterTab.classList.toggle("active", page === "poster");
  if (lyricsTab) lyricsTab.classList.toggle("active", page === "lyrics");
  if (page === "lyrics") scrollActiveLyricIntoView();
}
function updateAudioExpandArt(meta) {
  const big = document.getElementById("audioBigPoster"), bg = document.getElementById("audioLyricsBg"), fb = document.getElementById("audioBigPosterFallback");
  if (!big) return;
  const src = meta.cover || "", title = meta.title || "";
  if (src) { big.src = src; if (bg) bg.src = src; }
  else { big.removeAttribute("src"); if (bg) bg.removeAttribute("src"); }
  if (fb) { fb.textContent = title; fb.style.display = src ? "none" : "flex"; }
  /* v0.9.66：音乐海报容器用虚化封面填充黑边区域（通过 CSS 变量驱动 ::before） */
  document.querySelectorAll(".audio-poster-frame, .audio-fullscreen-poster, .audio-fullscreen-overlay").forEach(el => {
    el.style.setProperty("--poster-blur-bg", src ? `url('${cssUrlValue(src)}')` : "none");
  });
}
const AUDIO_LOOP_ORDER = ["sequence", "list", "single", "random"];
const AUDIO_LOOP_LABEL = { sequence: "顺序", list: "列表循环", single: "单曲循环", random: "随机播放" };
function setAudioLoop(mode) {
  audioLoopMode = AUDIO_LOOP_ORDER.includes(mode) ? mode : "sequence";
  const button = document.getElementById("audioLoopButton");
  if (button) {
    button.title = "播放模式：" + AUDIO_LOOP_LABEL[audioLoopMode];
    button.innerHTML = audioIcon(audioLoopMode === "single" ? "repeatOne" : audioLoopMode === "random" ? "repeat" : "repeat");
  }
  const lib = findMediaLibrary(localMediaSelection.audio);
  if (lib && audioView === "tracks") loadLocalFiles("audio", lib, audioCursor);
}
function cycleAudioLoop() { setAudioLoop(AUDIO_LOOP_ORDER[(AUDIO_LOOP_ORDER.indexOf(audioLoopMode) + 1) % AUDIO_LOOP_ORDER.length]); toast("🔁 " + AUDIO_LOOP_LABEL[audioLoopMode]); }

/* ==================== v0.9.73 播放列表（播放队列） ====================
   用户诉求：播放器上的「歌词详情」按钮改成播放列表，并加入播放列表功能。
   队列的唯一真相就是 audioFiles + activeAudio.index（连播、上一首/下一首、
   专辑/歌手/歌单分组播放全都基于它），面板只做可视化，不再另存一份队列，
   否则会出现「面板里删掉的歌下次又回来」这类双份状态缺陷。 */
function audioQueueLibId() { return activeAudio ? String(activeAudio.libId) : String(localMediaSelection.audio || ""); }
function audioQueueEntries() { return (audioFiles || []).map((file, index) => ({ index, path: String(file.path) })); }
function audioPlaylistPanelEl() { return document.getElementById("audioPlaylistPanel"); }
function audioPlaylistPanelOpen() { const p = audioPlaylistPanelEl(); return !!(p && p.classList.contains("open")); }
function renderAudioPlaylistPanel() {
  const host = document.getElementById("audioPlaylistList");
  if (!host) return;
  const list = audioQueueEntries();
  const count = document.getElementById("audioPlaylistCount");
  if (count) count.textContent = list.length ? `${list.length} 首` : "队列为空";
  if (!list.length) {
    host.innerHTML = '<div class="apl-empty">播放队列为空 —— 在曲目列表里点任意歌曲即会建立队列。</div>';
    return;
  }
  const current = activeAudio ? Number(activeAudio.index) : -1;
  host.innerHTML = list.map(({ index, path }) => {
    const meta = audioMetadataFor(path), active = index === current;
    return `<div class="apl-row${active ? " active" : ""}" data-queue-index="${index}" onclick="playAudioQueueIndex(${index})" title="${esc(path)}">
      <span class="apl-idx">${active ? "♪" : index + 1}</span>
      <span class="apl-info"><b>${esc(meta.title)}</b><small>${esc(meta.artist)} · ${esc(meta.album)}</small></span>
      <span class="apl-act">
        <button type="button" title="歌曲详情与歌词" onclick="event.stopPropagation();audioQueueDetails(${index})">ⓘ</button>
        <button type="button" title="移出播放列表" onclick="event.stopPropagation();removeAudioQueueIndex(${index})">✕</button>
      </span>
    </div>`;
  }).join("");
  const activeRow = host.querySelector(".apl-row.active");
  /* 只在本行不在可视区时才滚动，避免每次 timeupdate 式重渲染抖动。
     与阅读器同一防御风格：滚动调用必须 typeof 守卫，避免环境缺该方法时
     把整块面板渲染带崩。 */
  if (activeRow) {
    const box = host.getBoundingClientRect(), row = activeRow.getBoundingClientRect();
    if (row.top < box.top || row.bottom > box.bottom) {
      if (typeof activeRow.scrollIntoView === "function") activeRow.scrollIntoView({ block: "nearest" });
    }
  }
}
function openAudioPlaylistPanel() {
  const p = audioPlaylistPanelEl();
  if (!p) return;
  renderAudioPlaylistPanel();
  p.classList.add("open");
  document.getElementById("audioPlaylistButton")?.setAttribute("aria-expanded", "true");
}
function closeAudioPlaylistPanel() {
  audioPlaylistPanelEl()?.classList.remove("open");
  document.getElementById("audioPlaylistButton")?.setAttribute("aria-expanded", "false");
}
function toggleAudioPlaylistPanel() { audioPlaylistPanelOpen() ? closeAudioPlaylistPanel() : openAudioPlaylistPanel(); }
function refreshAudioPlaylistPanel() { if (audioPlaylistPanelOpen()) renderAudioPlaylistPanel(); }
function playAudioQueueIndex(index) {
  const entry = (audioFiles || [])[index];
  if (!entry) return;
  playAudioFile(audioQueueLibId(), String(entry.path));
  refreshAudioPlaylistPanel();
}
function removeAudioQueueIndex(index) {
  if (index < 0 || index >= (audioFiles || []).length) return;
  const removed = audioFiles.splice(index, 1)[0];
  /* 删的是当前曲目之前的行 → 当前位置左移一位，否则连播会跳过一首。 */
  if (activeAudio && Number(activeAudio.index) > index) activeAudio.index = Number(activeAudio.index) - 1;
  toast(`🗑 已移出播放列表：${audioMetadataFor(String(removed.path)).title}`);
  renderAudioPlaylistPanel();
}
function clearAudioQueue() {
  const count = (audioFiles || []).length;
  if (!count) { toast("ℹ️ 播放队列已经是空的"); return; }
  audioFiles = [];
  if (activeAudio) activeAudio.index = -1;
  toast(`🗑 已清空播放列表（${count} 首）`);
  renderAudioPlaylistPanel();
}
function audioQueueDetails(index) {
  const entry = (audioFiles || [])[index];
  if (!entry) return;
  if (!activeAudio || Number(activeAudio.index) !== index) playAudioFile(audioQueueLibId(), String(entry.path));
  showAudioDetails();
}
function saveAudioQueueAsPlaylist() {
  if (!(audioFiles || []).length) { toast("⚠️ 播放队列为空，先播放一首歌再保存"); return; }
  const libId = audioQueueLibId();
  if (!libId) { toast("⚠️ 没有可用的媒体库上下文"); return; }
  const name = (window.prompt("歌单名称（已存在则覆盖为当前队列）", "") || "").trim();
  if (!name) return;
  const list = readAudioPlaylists();
  const keys = audioFiles.map(file => audioFavoriteKey(libId, String(file.path)));
  const found = list.find(p => p.name === name);
  if (found) found.songs = keys;
  else list.push({ name, songs: keys });
  writeAudioPlaylists(list);
  toast(`✅ 已保存歌单「${name}」（${keys.length} 首）`);
}
function parseLyrics(lrc) {
  const lines = [];
  String(lrc || "").split(/\r?\n/).forEach(line => {
    const match = line.match(/\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]\s*(.*)/);
    if (!match) return;
    const seconds = (+match[1]) * 60 + (+match[2]) + (+(match[3] || 0)) / 1000;
    if (match[4].trim()) lines.push({ time: seconds, text: match[4].trim() });
  });
  return lines;
}
/* v0.9.71：歌词容器登记。底部展开面板与放大视图歌词层共用同一套「渲染 / 高亮 / 居中滚动」
   逻辑（此前只有展开面板一套；放大视图另写一套必然随时间漂移）。
   lines 持有 .lyric-line，scroller 是可滚动祖先：展开面板两者合一，
   放大视图的 scroller 是外层 .audio-fs-lyrics、lines 是内层 .audio-fs-lyrics-inner。 */
function lyricHosts() {
  const hosts = [];
  const panel = document.getElementById("audioPlayerLyrics");
  if (panel) hosts.push({ lines: panel, scroller: panel, emptyClass: "audio-lyric-empty", id: "audioPlayerLyrics" });
  const inner = document.getElementById("audioFullscreenLyricsInner"), outer = document.getElementById("audioFullscreenLyrics");
  if (inner && outer) hosts.push({ lines: inner, scroller: outer, emptyClass: "audio-fs-empty", id: "audioFullscreenLyricsInner" });
  return hosts;
}
/* 渲染歌词行：有带时间轴的 LRC 就逐行渲染（可点击跳转），否则给出可操作的空状态提示。 */
function renderLyricLinesInto(el, meta, emptyText) {
  if (!el) return;
  const lines = parseLyrics(meta && meta.lyrics);
  el.dataset.lastLyricIndex = "-1";
  if (lines.length) {
    el.classList.remove("audio-lyric-empty");
    el.innerHTML = lines.map((line, i) => `<span class="lyric-line" data-time="${line.time}" data-index="${i}">${esc(line.text)}</span>`).join("\n");
  } else {
    el.innerHTML = `<span class="${el.classList.contains("audio-fs-lyrics-inner") ? "audio-fs-empty" : "audio-lyric-empty"}">${esc(emptyText)}</span>`;
  }
}
function renderPlayerLyrics(meta) {
  const el = document.getElementById("audioPlayerLyrics"); if (!el) return;
  renderLyricLinesInto(el, meta, "暂无歌词信息。可在音乐文件/曲目行的「✎ 编辑歌曲信息」中粘贴 LRC 歌词，每行形如 [00:12.50] 歌词文本，播放时即可同步高亮。");
  lastLyricActiveIndex = -1;
  /* 放大视图歌词层与面板同源：曲目/歌词变化时同步刷新（函数由 03-audio-zoom.js 提供）。 */
  if (typeof refreshAudioFullscreenLyrics === "function") refreshAudioFullscreenLyrics();
}
function seekLyric(event) {
  const line = event.target.closest("[data-time]");
  const player = document.getElementById("audioPlayerElement");
  if (line && player && Number.isFinite(Number(line.dataset.time))) player.currentTime = Number(line.dataset.time);
}
/* 歌词跟随播放时间同步：高亮当前行并把该行滚到歌词区中部。
   target 省略时更新全部歌词容器；放大视图拖动歌词期间会暂停自动滚动（见 03-audio-zoom.js）。 */
function scrollActiveLyricIntoView(target) {
  const hosts = target ? lyricHosts().filter(host => host.lines === target || host.scroller === target) : lyricHosts();
  hosts.forEach(host => {
    if (!host.scroller.offsetParent) return;
    /* 放大视图拖动歌词期间（含释放后 6 秒）暂停自动滚动，避免和用户手势打架；
       判定函数由 03-audio-zoom.js 提供，未加载时按「不暂停」处理。 */
    if (typeof lyricFollowPaused === "function" && lyricFollowPaused(host)) return;
    const active = host.lines.querySelector(".lyric-line.active");
    if (!active) return;
    const top = active.offsetTop - host.scroller.clientHeight / 2 + active.clientHeight / 2;
    if (Math.abs(host.scroller.scrollTop - top) > 6) host.scroller.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
  });
}
function updateLyricHighlightIn(host) {
  const player = document.getElementById("audioPlayerElement");
  if (!player) return;
  const lines = host.lines.querySelectorAll(".lyric-line");
  if (!lines.length) return;
  const current = player.currentTime || 0;
  let activeIndex = -1;
  lines.forEach((line, i) => { if (Number(line.dataset.time) <= current) activeIndex = i; });
  lines.forEach((line, i) => line.classList.toggle("active", i === activeIndex));
  /* 每个容器各自记录上次高亮行，互不干扰（旧版用一个全局变量，多容器会互相打断滚动）；
     底部面板同时写回旧全局 lastLyricActiveIndex（保持 v0.9.56 契约语义）。 */
  if (host.id === "audioPlayerLyrics") lastLyricActiveIndex = activeIndex;
  if (String(activeIndex) !== host.lines.dataset.lastLyricIndex) {
    host.lines.dataset.lastLyricIndex = String(activeIndex);
    if (host.scroller.offsetParent) scrollActiveLyricIntoView(host.lines);
  }
}
function updateLyricHighlight() { lyricHosts().forEach(updateLyricHighlightIn); }
/* ================= v0.9.71：弱网模式（参考 Plex/Emby/Navidrome 的通行做法）=================
   1) 下行探测：GET /api/media/weak/probe?kb=256（服务端返回不可压缩随机数据），
      用传输耗时算真实下行速率，按档位归类 fast / medium / slow；
   2) 档位联动：slow → 音频走服务端 96k 转码流、漫画省流模式自动开启；
      medium → 音频 160k；fast → 原文件直出（LAN 场景零额外开销）；
   3) 用户可显式指定：音质（原文件/自动/320k/192k/128k/96k）与弱网模式（自动/始终/关闭），
      显式选择优先于自动判定；
   4) 服务端转码流带 Range 与 1 天私有缓存，重播不再重复转码；转码队列拥塞会返回 503，
      前端自动回落原文件直出。
   Plex/Emby 用「自动质量 + 自适应码率」，Navidrome 用「客户端选码率 + 服务端转码」，
   这里有浏览器 <audio> 的限制，采用后者：档位由前端选、转码由服务端做、结果落盘复用。 */
const WEAK_NETWORK_KEY = "vaulthub_weak_network_v1";
const AUDIO_QUALITY_KEY = "vaulthub_audio_quality_v1";
const WEAK_PROBE_TTL = 30 * 60 * 1000;   // 探测结果 30 分钟内复用
const WEAK_SLOW_BPS = 400 * 1024;        // < 400 KiB/s ≈ 3.2 Mbps 视为弱网
const WEAK_MEDIUM_BPS = 1500 * 1024;     // < 1.5 MiB/s ≈ 12 Mbps 视为中等
const AUDIO_QUALITY_LABEL = { original: "原文件", auto: "自动" };

function weakNetworkState() {
  const def = { mode: "auto", speedBps: 0, measuredAt: 0, level: "" };
  try { return Object.assign(def, JSON.parse(localStorage.getItem(WEAK_NETWORK_KEY) || "{}") || {}); } catch (e) { return def; }
}
function saveWeakNetworkState(patch) {
  const next = Object.assign(weakNetworkState(), patch || {});
  try { localStorage.setItem(WEAK_NETWORK_KEY, JSON.stringify(next)); } catch (e) { console.warn("[weak] 无法写入弱网设置（localStorage 受限）", e); }
  syncWeakNetworkSettings();
  /* v0.9.84：测速结果会改变「自动」档的清晰度（弱网 → 高清/省流），
     这里同步刷新档位呈现，避免面板与实际取图档位不一致。 */
  if (typeof applyQualityLevel === "function") applyQualityLevel();
  return next;
}
/* v0.9.77：音质档位不再有手动按钮 —— 始终「自动」，由后台测速（当天首次打开 +
   30 分钟过期重测）决定是否走服务端限码率转码流。保留读取旧值做迁移：旧版本存过
   320/192/128/96 的用户，落到自动档而不是继续钉在手动档位。 */
function audioQualityChoice() {
  try {
    const legacy = String(localStorage.getItem(AUDIO_QUALITY_KEY) || "");
    if (legacy && legacy !== "auto") localStorage.removeItem(AUDIO_QUALITY_KEY);
  } catch (e) { /* localStorage 受限时忽略 */ }
  return "auto";
}
function weakNetworkLevel(speedBps) {
  if (!speedBps || speedBps <= 0) return "";
  if (speedBps < WEAK_SLOW_BPS) return "slow";
  if (speedBps < WEAK_MEDIUM_BPS) return "medium";
  return "fast";
}
/* 弱网是否生效：显式「开启」优先；「关闭」直接否；「自动」看探测结果与浏览器网络提示。 */
function weakNetworkActive() {
  const state = weakNetworkState();
  if (state.mode === "on") return true;
  if (state.mode === "off") return false;
  if (state.level === "slow") return true;
  const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (c && (c.saveData || /(^|-)2g$/.test(String(c.effectiveType || "")))) return true;
  return false;
}
/* 自动档位对应的码率：弱网 96k、中等 160k、良好不限（原文件）。 */
function autoAudioKbps() {
  const state = weakNetworkState();
  if (state.mode === "off") return 0;
  if (state.level === "slow") return 96;
  if (state.mode === "on") return weakNetworkActive() ? 96 : 0;
  if (state.level === "medium") return 160;
  return 0;
}
/* 当前实际生效的码率（0 = 原文件直出）。 */
function effectiveAudioKbps() {
  /* v0.9.84：显式「画面清晰度」档位同时决定音频码率（流畅 128k / 极省 96k），
     自动档返回 null → 交回后台测速判定（原行为不变）。 */
  if (typeof qualityAudioKbps === "function") {
    const explicit = qualityAudioKbps();
    if (explicit !== null) return Number(explicit) || 0;
  }
  const choice = audioQualityChoice();
  if (choice === "original") return 0;
  if (choice === "auto") return autoAudioKbps();
  const n = Number(choice);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
function audioQualityLabel() {
  const choice = audioQualityChoice();
  if (choice === "auto") {
    const kbps = autoAudioKbps();
    return kbps ? `自动（${kbps}k）` : "自动（原文件）";
  }
  return AUDIO_QUALITY_LABEL[choice] || `${choice}k`;
}
function audioStreamUrl(lib, path, kbps) {
  const q = new URLSearchParams();
  q.set("id", String(lib.id));
  q.set("path", String(path));
  q.set("bitrate", `${kbps}k`);
  return `/api/media/audio/stream?${q.toString()}`;
}
/* 探测下行速率：小样本 1 次 + 依据耗时归类；失败保持原状态（不误判为弱网）。 */
async function probeWeakNetwork(options = {}) {
  const kb = Number(options.kb) || 256;
  if (typeof performance === "undefined" || !performance.now) return weakNetworkState();
  const started = performance.now();
  try {
    const res = await fetch(`/api/media/weak/probe?kb=${kb}`, { cache: "no-store", credentials: "same-origin" });
    if (!res.ok) return weakNetworkState();
    const buf = await res.arrayBuffer();
    const seconds = Math.max(0.001, (performance.now() - started) / 1000);
    const speedBps = Math.round(buf.byteLength / seconds);
    const next = saveWeakNetworkState({ speedBps, measuredAt: Date.now(), level: weakNetworkLevel(speedBps) });
    if (options.toast) toast(`📶 下行约 ${(speedBps / 1024 / 1024).toFixed(2)} MiB/s（${next.level === "slow" ? "弱网" : next.level === "medium" ? "中等" : "良好"}）`);
    return next;
  } catch (e) {
    console.warn("[weak] 探测失败，沿用上一次结果", e);
    return weakNetworkState();
  }
}
/* ==================== v0.9.77：当日首次打开自动测速 ====================
   用户诉求：WEBUI 当天第一次打开时自动做一次网络测速（本地网络到容器的延迟 +
   到容器的下行带宽），结果喂给后台自动切换（音频限码率、漫画省流、视频自动画质）。
   · 每天只自动跑一次（留当天日期戳）；可在设置页关掉或手动「立即测速」；
   · 延迟：多次 1 KiB 小请求取中位数（排除首包/抖动单点）；
   · 带宽：复用 /api/media/weak/probe 的不可压缩样本（1 MiB）；
   · 结果写入 weakNetworkState（speedBps / level / latencyMs / day / measuredAt）。 */
const SPEEDTEST_DAY_KEY = "vaulthub_speedtest_day_v1";
const AUTO_SPEEDTEST_KEY = "vaulthub_auto_speedtest_v1";
const SPEEDTEST_SAMPLE_KB = 1024;

function todayStamp() {
  const d = new Date();
  const pad = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function autoSpeedTestEnabled() {
  try { return localStorage.getItem(AUTO_SPEEDTEST_KEY) !== "0"; } catch (e) { return true; }
}
function setAutoSpeedTest(on) {
  try { localStorage.setItem(AUTO_SPEEDTEST_KEY, on ? "1" : "0"); } catch (e) { /* 受限时忽略 */ }
  toast(on ? "📶 已开启：每天首次打开自动测速" : "📶 已关闭自动测速（可在设置里手动测速）");
}
function speedTestDay() {
  try { return String(localStorage.getItem(SPEEDTEST_DAY_KEY) || ""); } catch (e) { return ""; }
}
function markSpeedTestDay(day) {
  try { localStorage.setItem(SPEEDTEST_DAY_KEY, day); } catch (e) { /* 受限时忽略 */ }
}
/* 本地网络 → 容器的往返延迟（ms，中位数）。失败返回 0（不误判）。 */
async function measureContainerLatency(samples = 4) {
  if (typeof performance === "undefined" || !performance.now) return 0;
  const rtts = [];
  for (let i = 0; i < samples; i++) {
    const t0 = performance.now();
    try {
      const res = await fetch(`/api/media/weak/probe?kb=1&lat=${i}`, { cache: "no-store", credentials: "same-origin" });
      if (!res.ok) continue;
      await res.arrayBuffer();
      rtts.push(performance.now() - t0);
    } catch (e) { /* 单次失败继续 */ }
  }
  if (!rtts.length) return 0;
  rtts.sort((a, b) => a - b);
  // 去掉最慢的一次（首包/TLS/代理抖动），其余取中位数
  const trimmed = rtts.length > 2 ? rtts.slice(0, rtts.length - 1) : rtts;
  return Math.round(trimmed[Math.floor(trimmed.length / 2)]);
}
async function runDailySpeedTest(options = {}) {
  const today = todayStamp();
  if (!options.force) {
    if (!autoSpeedTestEnabled()) return weakNetworkState();
    if (speedTestDay() === today) return weakNetworkState();
  }
  const latencyMs = await measureContainerLatency();
  const state = await probeWeakNetwork({ kb: options.kb || SPEEDTEST_SAMPLE_KB });
  const next = saveWeakNetworkState({ latencyMs, day: today, auto: !options.force });
  markSpeedTestDay(today);
  if (!options.silent) {
    const mbps = next.speedBps ? (next.speedBps * 8 / 1000 / 1000).toFixed(1) : "0";
    toast(`📶 当日测速：延迟 ${latencyMs || "--"} ms · 下行约 ${(next.speedBps / 1024 / 1024).toFixed(2)} MiB/s（${mbps} Mbps）· 档位已按结果自动切换`);
  }
  syncWeakNetworkSettings();
  updateAudioQualityButton();
  return next;
}
/* 自动档位下：没有新鲜探测结果就后台补一次（不阻塞首屏）。 */
function ensureWeakNetworkProbe() {
  const state = weakNetworkState();
  if (state.mode === "off") return;
  if (state.measuredAt && Date.now() - state.measuredAt < WEAK_PROBE_TTL) return;
  const run = () => { probeWeakNetwork().then(() => updateAudioQualityButton()); };
  if (typeof requestIdleCallback === "function") requestIdleCallback(run, { timeout: 4000 });
  else setTimeout(run, 1200);
}
/* v0.9.77：音质按钮已移除，这里只同步设置页的状态文案（后台档位对外可见）。 */
function updateAudioQualityButton() {
  const status = document.getElementById("audioQualityStatus");
  if (!status) return;
  const kbps = effectiveAudioKbps();
  status.textContent = kbps
    ? `当前档位：${typeof qualityChoice === "function" && qualityChoice() !== "auto" ? qualityProfile().label + " · " : "自动限码率 "}${kbps}k`
    : "当前档位：原文件直出";
}
/* 选择播放源：弱网/显式档位 → 服务端转码流；其余 → 原文件。
   转码流失败（503 拥塞、ffmpeg 缺失等）自动回落原文件，不让播放卡死。 */
function applyAudioSource(lib, path, player, options = {}) {
  const kbps = effectiveAudioKbps();
  if (options.keepTime && player.currentTime) {
    try { player.dataset.resumeAt = String(options.keepTime); } catch (e) { /* 忽略 */ }
  }
  player.dataset.streamFallback = "";
  if (!kbps) {
    player.dataset.streamKbps = "";
    player.src = mediaFileUrl(lib, path);
    return 0;
  }
  player.dataset.streamKbps = String(kbps);
  player.src = audioStreamUrl(lib, path, kbps);
  return kbps;
}
/* 弱网模式设置面板（系统设置里的「弱网与省流」区块）。 */
function saveWeakNetworkMode() {
  const value = document.getElementById("weakNetworkMode")?.value;
  const mode = ["auto", "on", "off"].includes(value) ? value : "auto";
  const next = saveWeakNetworkState({ mode });
  toast(mode === "on" ? "📶 弱网模式：始终开启（音频按 96k 转码、漫画省流开启）" : mode === "off" ? "📶 弱网模式：关闭（原文件与原图直出）" : "📶 弱网模式：自动（按探测结果决定）");
  if (mode !== "off") probeWeakNetwork();
  updateAudioQualityButton();
  return next;
}
function syncWeakNetworkSettings() {
  const state = weakNetworkState();
  const select = document.getElementById("weakNetworkMode");
  if (select) select.value = ["auto", "on", "off"].includes(state.mode) ? state.mode : "auto";
  const status = document.getElementById("weakNetworkStatus");
  if (status) {
    const speed = state.speedBps ? `${(state.speedBps / 1024 / 1024).toFixed(2)} MiB/s` : "未测速";
    const level = state.level === "slow" ? "弱网" : state.level === "medium" ? "中等" : state.level === "fast" ? "良好" : "未知";
    const lat = state.latencyMs ? `延迟 ${state.latencyMs} ms · ` : "";
    const day = state.day ? `（${state.day} 自动测速）` : "（未自动测速）";
    status.textContent = `最近测速：${lat}${speed}（判定 ${level}）${day} · 当前生效：${weakNetworkActive() ? "弱网档位（音频限码率 / 省流开启）" : "标准档位（原文件直出）"}`;
  }
}
async function probeWeakNetworkFromSettings() {
  const status = document.getElementById("weakNetworkStatus");
  if (status) status.textContent = "正在测速（延迟 + 下行带宽）…";
  await runDailySpeedTest({ force: true, kb: 512 });
  const box = document.getElementById("autoSpeedTestToggle");
  if (box) box.checked = autoSpeedTestEnabled();
}
function playAudioFile(libId, path) {
  const lib = findMediaLibrary(libId), player = document.getElementById("audioPlayerElement"); if (!lib || !player) return;
  claimExclusivePlayback("audio");
  const index = audioFiles.findIndex(file => String(file.path) === String(path));
  activeAudio = { libId, path, index: index < 0 ? 0 : index };
  const meta = audioMetadataFor(path);
  /* v0.9.92：登记进跨页「正在播放」，离开音乐页后仍能一键回来。 */
  if (typeof setActivePlayback === "function") setActivePlayback({ kind: "audio", group: "audio", libId, path, title: meta.title || displayBookTitle(path) });
  /* v0.9.71：按音质档位/弱网模式选源（0 = 原文件直出，>0 = 服务端限码率转码流）。 */
  applyAudioSource(lib, path, player);
  player.onerror = () => {
    /* 转码流不可用（转码队列拥塞 503、ffmpeg 异常、网络中断）→ 回落原文件直出一次。 */
    if (player.dataset.streamKbps && player.dataset.streamFallback !== "1") {
      const at = player.currentTime || 0;
      player.dataset.streamFallback = "1";
      player.dataset.streamKbps = "";
      player.src = mediaFileUrl(lib, path);
      if (at) { try { player.dataset.resumeAt = String(at); } catch (e) { /* 忽略 */ } }
      toast("📶 转码流不可用，已回落原文件直出");
      player.play().catch(() => {});
      return;
    }
    toast("⚠️ 无法加载音频：文件不存在或路径含特殊字符");
    document.getElementById("audioPlayerMeta").textContent = "加载失败，请检查文件路径";
  };
  player.onloadedmetadata = () => {
    /* 切换音质/回落时保持播放位置。 */
    const resume = Number(player.dataset.resumeAt || 0);
    if (Number.isFinite(resume) && resume > 0) {
      try { player.currentTime = resume; } catch (e) { /* 忽略不可 seek 的流 */ }
      player.dataset.resumeAt = "";
    }
    updateAudioQualityButton();
  };
  player.play().catch(() => {});
  const bar = document.getElementById("audio-bottom-player");
  bar.classList.add("show");
  bar.classList.toggle("show", document.getElementById("view-audio")?.classList.contains("active"));
  document.getElementById("audioPlayerTitle").textContent = meta.title;
  document.getElementById("audioPlayerMeta").textContent = `${meta.artist} · ${meta.album}`;
  const cover = document.getElementById("audioCover");
  cover.src = meta.cover || ""; cover.alt = `${meta.title} 海报`; cover.style.background = meta.cover ? "" : coverGradient(meta.title);
  /* v0.9.62：播放音乐时用专辑封面作为主区域背景虚化 */
  setPlaybackBg(meta.cover || "");
  audioSetPauseIcon(true);
  renderPlayerLyrics(meta);
  updateAudioExpandArt(meta);
  /* v0.9.73：切曲后播放面板要跟着换「正在播放」高亮，否则面板显示的仍是上一首。 */
  refreshAudioPlaylistPanel();
  /* v0.9.67：播放时若本曲没有歌词，自动按「本地识别 → 在线源链」补一次并落盘 .lrc。 */
  ensureAudioLyrics(lib.id, path, meta);
  localizeAudioCover(lib.id, path); // v0.9.56：远端封面顺带落盘持久化（只读媒体库自动回退）
  updateAudioFavoriteButton();
}
function audioSetPauseIcon(paused) {
  const btn = document.getElementById("audioPauseButton"); if (!btn) return;
  btn.innerHTML = paused
    ? '<svg class="vc-svg audio-svg" viewBox="0 0 24 24" aria-hidden="true"><rect x="6.6" y="5" width="4.1" height="14" rx="1.5" fill="currentColor"/><rect x="13.3" y="5" width="4.1" height="14" rx="1.5" fill="currentColor"/></svg>'
    : '<svg class="vc-svg audio-svg" viewBox="0 0 24 24" aria-hidden="true"><path d="M8.2 5.6v12.8a.9.9 0 0 0 1.37.77l10.2-6.4a.9.9 0 0 0 0-1.54L9.57 4.83A.9.9 0 0 0 8.2 5.6Z" fill="currentColor"/></svg>';
}
function audioTogglePause() { const player=document.getElementById("audioPlayerElement"); if(!player?.src) return; if(player.paused) { claimExclusivePlayback("audio"); player.play().catch(() => {}); audioSetPauseIcon(true); } else { player.pause(); audioSetPauseIcon(false); } if (typeof setActivePlaybackPaused === "function") setActivePlaybackPaused(player.paused); }
function audioStop() { const player=document.getElementById("audioPlayerElement"); if(!player) return; player.pause(); player.currentTime=0; player.removeAttribute("src"); player.load(); activeAudio=null; if (typeof clearActivePlayback === "function") clearActivePlayback("audio"); document.getElementById("audio-bottom-player")?.classList.remove("show"); audioSetPauseIcon(false); stopAudioSessionKeepAlive(); clearPlaybackBg(); if (typeof closeAudioCoverZoom === "function") closeAudioCoverZoom(); }
/* v0.9.61：音频播放会话保活别名（实现见 01-state.js 的 mediaKeepAlive*）。 */
function startAudioSessionKeepAlive() { mediaKeepAliveStart("audio"); }
function stopAudioSessionKeepAlive() { mediaKeepAliveStop("audio"); }
function audioPrevious() { if(!activeAudio || !audioFiles.length) return; const index=(activeAudio.index-1+audioFiles.length)%audioFiles.length; playAudioFile(activeAudio.libId,audioFiles[index].path); }
function audioNext() {
  if(!activeAudio || !audioFiles.length) return;
  const player = document.getElementById("audioPlayerElement");
  if (audioLoopMode === "single") { player.currentTime = 0; player.play().catch(() => {}); return; }
  if (audioLoopMode === "random") { let index = Math.floor(Math.random() * audioFiles.length); if (audioFiles.length > 1 && index === activeAudio.index) index = (index + 1) % audioFiles.length; playAudioFile(activeAudio.libId, audioFiles[index].path); return; }
  const nextIndex = activeAudio.index + 1;
  if (audioLoopMode === "sequence" && nextIndex >= audioFiles.length) { audioStop(); return; }
  playAudioFile(activeAudio.libId, audioFiles[nextIndex % audioFiles.length].path);
}
function showAudioDetails() { if(!activeAudio) return; const meta=audioMetadataFor(activeAudio.path); const modal=document.getElementById("audioDetailsModal"); if(modal){modal.classList.add("audio-detail-backdrop","media-detail-backdrop");modal.setAttribute("style", detailBackdropStyle(meta));} document.getElementById("audioDetailsContent").innerHTML=`<h4>${esc(meta.title)}</h4><p>${esc(meta.artist)} · ${esc(meta.album)}</p>${meta.lyrics ? `<pre class="audio-lyrics">${esc(meta.lyrics)}</pre>` : '<div class="empty-tip">暂无歌词，可通过“文件”视图的手动适配填写。</div>'}`; openModal("audioDetailsModal"); }
document.getElementById("audioPlayerElement")?.addEventListener("play", startAudioSessionKeepAlive);
document.getElementById("audioPlayerElement")?.addEventListener("ended", audioNext);
document.getElementById("audioPlayerElement")?.addEventListener("error", stopAudioSessionKeepAlive);
document.getElementById("audioPlayerElement")?.addEventListener("timeupdate", updateLyricHighlight);

function renderLocalFileRow(group, lib, file) {
  const path = String(file.path);
  const ext = fileExt(path);
  const viewable = ["mp3","flac","m4a","ogg","wav","jpg","jpeg","png","webp","gif","txt","pdf","mp4","m4v","webm","mov"].includes(ext);
  const archiveLike = [...MEDIA_FORMATS.comic, ...MEDIA_FORMATS.book].includes(ext);
  /* v0.9.56：清除下载权限 —— 不可在线预览的格式不再提供下载按钮，
     文件读取端点（/api/media/file 等）也已要求登录会话。 */
  const action = group === "movie" && MEDIA_FORMATS.movie.includes(ext) ? "播放" : viewable ? "查看" : (archiveLike ? "打开" : "不可预览");
  const disabled = action === "不可预览" ? " disabled" : "";
  return `<div class="media-file-row"><div class="media-file-name" title="${esc(path)}">${esc(path)}</div><span class="media-file-meta">${esc(ext.toUpperCase() || "FILE")} · ${formatFileSize(file.size)}</span>${disabled ? `<span class="media-file-note">该格式不支持在线预览</span>` : `<button class="btn" data-media-group="${esc(group)}" data-media-library="${esc(lib.id)}" data-media-path="${esc(path)}" onclick="openLocalMediaButton(this)">${action}</button>`}</div>`;
}
function displayBookTitle(path) {
  return String(path).split("/").pop().replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim() || "未命名书籍";
}
function coverGradient(title) {
  let hash = 0; for (const char of title) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  const hue = Math.abs(hash) % 360, hue2 = (hue + 55) % 360;
  return `linear-gradient(145deg,hsl(${hue} 58% 38%),hsl(${hue2} 68% 24%))`;
}
const coverScrapeCache = "vaulthub_cover_scrape_v1";
function readCoverCache() { return vaultStoreJSON(coverScrapeCache, {}); }
function writeCoverCache(cache) { vaultStoreSet(coverScrapeCache, cache); }
function coverSearchTitle(title) {
  /* v0.9.56：封面搜索词清洗增强 —— 除「全本/卷册部」外再清尾部 v01/Vol.3/第1话 等编号，
     提升 Bangumi/AniList 命中率（One Piece v01 → One Piece）。 */
  return String(title).replace(/[（(][^）)]*(?:全本|未删节|完结|全集|简体|繁体|中文|日文|双页)[^）)]*[）)]/g, " ")
    .replace(/第?\s*\d+\s*[卷册部话集]/g, " ")
    .replace(/(?:[vV](?:ol\.?)?|volume|chapter|ch\.?|ep\.?|part|pt\.?|book|no\.?)[-_. ]?\s*\d+\b/gi, " ")
    .replace(/\b\d{1,3}\s*(?:of\s*\d+)?\s*$/i, " ")
    .replace(/[-_.]+\s*$/, " ")
    .replace(/\s+/g, " ").trim();
}
function bookCoverFallback(img) {
  /* 本地 sidecar 封面缺失（如用户删了文件）时清掉缓存键，下次渲染可重新刮削。 */
  const card = img.closest("[data-media-library]");
  if (card) {
    try {
      const cache = readCoverCache();
      const key = coverCacheKey(card.dataset.mediaLibrary || "", card.dataset.mediaPath || "");
      if (cache[key]) { delete cache[key]; writeCoverCache(cache); }
    } catch (e) {}
  }
  img.removeAttribute("src"); img.classList.remove("loaded"); img.hidden = true;
}
/* v0.9.56：封面缓存键改为「库 + 文件」—— 同一标题的书在不同媒体库/路径下
   各自持久化本地 sidecar 封面，互不串用。 */
function coverCacheKey(libId, path) { return (libId ? libId + "\n" : "") + String(path || "").toLowerCase(); }
/* v0.9.56：漫画/书籍封面刮削多源化。
   刮削只看文件名解析出的标题，与封装格式无关（cbz/cbr/zip/pdf/epub… 全部生效）；
   Bangumi 负责中文漫画，AniList（GraphQL，无需密钥）负责日漫/全球漫画高清封面，
   Google Books / OpenLibrary 兜底实体书。每源独立 6s 超时（AbortController），
   避免某个源不可达时整张封面永久转圈；两档竞速：漫画档优先，失败才走书目档。 */
const COMIC_COVER_TIMEOUT = 6000;
const COMIC_COVER_FAIL_RETRY = 3600000; // 全源失败后 1 小时重试（此前失败缓存 1 天太久）
async function coverFetchJson(url, options, timeoutMs = COMIC_COVER_TIMEOUT) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) { return null; } finally { clearTimeout(timer); }
}
async function bangumiCover(title) {
  const data = await coverFetchJson("https://api.bgm.tv/v0/search/subjects", {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "VaultHub/0.9.56 (https://github.com/q807738511/vaulthub)" },
    body: JSON.stringify({ keyword: title, sort: "match", filter: { type: [1], nsfw: false } })
  });
  const item = data?.data?.find(entry => entry?.images?.large || entry?.images?.common || entry?.images?.medium);
  return item?.images?.large || item?.images?.common || item?.images?.medium || "";
}
async function anilistCover(title) {
  const data = await coverFetchJson("https://graphql.anilist.co", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify({
      query: "query($s:String){Page(perPage:5){media(search:$s,type:MANGA){title{romaji english native} coverImage{extraLarge large}}}}",
      variables: { s: title }
    })
  });
  const media = data?.data?.Page?.media || [];
  const m = media.find(entry => entry?.coverImage?.extraLarge || entry?.coverImage?.large);
  return m?.coverImage?.extraLarge || m?.coverImage?.large || "";
}
async function googleBookCover(title) {
  const data = await coverFetchJson(`https://www.googleapis.com/books/v1/volumes?q=intitle:${encodeURIComponent(title)}&maxResults=3&printType=books`);
  const links = data?.items?.map(item => item?.volumeInfo?.imageLinks).find(Boolean);
  if (!links) return "";
  const url = links?.thumbnail || links?.smallThumbnail || "";
  return url ? url.replace(/^http:/, "https:").replace(/&zoom=\d/, "&zoom=2") : "";
}
async function openLibraryCover(title) {
  const data = await coverFetchJson(`https://openlibrary.org/search.json?title=${encodeURIComponent(title)}&fields=cover_i,title&limit=3`);
  const coverId = data?.docs?.find(doc => doc.cover_i)?.cover_i;
  return coverId ? `https://covers.openlibrary.org/b/id/${coverId}-L.jpg` : "";
}
function firstCover(factories) {
  return new Promise(resolve => {
    let pending = factories.length, done = false;
    const finish = (url) => { if (!done) { done = true; resolve(url); } };
    factories.forEach(fn => {
      Promise.resolve().then(fn).then(url => { if (url) finish(url); else if (--pending === 0) finish(""); })
        .catch(() => { if (--pending === 0) finish(""); });
    });
    setTimeout(() => finish(""), COMIC_COVER_TIMEOUT * 2 + 1500); // 兜底：绝不让调用方无限等待
  });
}
async function scrapeBookCover(img) {
  const title = coverSearchTitle(img.dataset.coverTitle || ""); if (!title) return;
  const card = img.closest("[data-media-library]");
  const libId = card?.dataset.mediaLibrary || "", mediaPath = card?.dataset.mediaPath || "";
  const cache = readCoverCache(), key = coverCacheKey(libId, mediaPath), cached = cache[key];
  if (cached?.url) { img.hidden = false; img.src = cached.url; return; }
  if (cached?.checkedAt && Date.now() - cached.checkedAt < COMIC_COVER_FAIL_RETRY) return;
  /* 漫画档（Bangumi 中文 + AniList 日漫/全球）优先，书目档（Google/OpenLibrary）兜底。 */
  const tier1 = await firstCover([() => bangumiCover(title), () => anilistCover(title)]);
  const coverUrl = tier1 || await firstCover([() => googleBookCover(title), () => openLibraryCover(title)]);
  /* v0.9.56：命中后写入媒体库同目录（<名>.cover.*），展示改为本地持久化 URL；
     只读媒体库/落盘失败自动回退远端直链。 */
  const local = libId && mediaPath && coverUrl ? await persistCoverToLibrary(libId, mediaPath, coverUrl) : coverUrl;
  cache[key] = { url: local || "", checkedAt: Date.now() }; writeCoverCache(cache);
  if (local) { img.hidden = false; img.src = local; }
  /* v0.9.88：封面刮削结果写回服务端 —— 换浏览器/换设备不必把整架书重刮一遍。 */
  pushBookScrapeResult(libId, mediaPath, title, local || coverUrl);
}
/* 书籍/漫画的刮削结果（标题 + 封面）同样进服务端刮削结果库。 */
function pushBookScrapeResult(libId, mediaPath, title, coverUrl) {
  if (!libId || !mediaPath || !coverUrl) return;
  try {
    const items = {};
    items[mediaPath] = {
      title: String(title || "").slice(0, 200), poster: String(coverUrl).slice(0, 2048),
      provider: "封面刮削", kind: "book", scrape_state: "ok", checked_at: Date.now()
    };
    fetch("/api/media/scrape-cache", {
      method: "POST", headers: sessionWriteHeaders(true), credentials: "same-origin",
      body: JSON.stringify({ id: String(libId), items })
    }).catch(() => { /* 服务端不可用：本地封面缓存仍生效 */ });
  } catch (e) {}
}
/* 进书架前先把服务端存过的封面灌回本地封面缓存，避免重复联网刮削。 */
async function hydrateBookCoversFromServer(libId) {
  if (!libId) return false;
  try {
    const res = await fetch(`/api/media/scrape-cache?id=${encodeURIComponent(libId)}`, { cache: "no-store", credentials: "same-origin" });
    if (!res.ok) return false;
    const items = ((await res.json()) || {}).items || {};
    const cache = readCoverCache();
    let changed = false;
    Object.keys(items).forEach((path) => {
      const item = items[path];
      if (!item || !item.poster) return;
      const key = coverCacheKey(libId, path);
      const at = Number(item.checked_at || 0);
      const cur = cache[key];
      if (cur && cur.url && Number(cur.checkedAt || 0) >= at) return;
      cache[key] = { url: String(item.poster), checkedAt: at || Date.now() };
      changed = true;
    });
    if (changed) writeCoverCache(cache);
    return changed;
  } catch (e) { return false; }
}
function refreshBookCovers() {
  try { localStorage.removeItem(coverScrapeCache); } catch (e) {}
  const target=document.getElementById("local-media-content-comic");
  if (target) { target.querySelectorAll(".book-cover-image").forEach(bookCoverFallback); scrapeVisibleBookCovers(target); }
  toast("🔄 正在重新刮削封面");
}
function scrapeVisibleBookCovers(host) {
  /* v0.9.88：先灌服务端已存的封面，再对真正缺封面的条目联网刮削。 */
  const card = host.querySelector("[data-media-library]");
  const libId = card && card.dataset.mediaLibrary;
  if (libId) hydrateBookCoversFromServer(libId).then((changed) => {
    if (!changed) return;
    host.querySelectorAll("img[data-cover-title]").forEach((img) => {
      const el = img.closest("[data-media-library]");
      const key = el ? coverCacheKey(el.dataset.mediaLibrary, el.dataset.mediaPath) : "";
      const cached = key ? readCoverCache()[key] : null;
      if (cached && cached.url && !img.src) { img.hidden = false; img.src = cached.url; }
    });
  });
  const images = [...host.querySelectorAll("img[data-cover-title]")];
  let cursor=0; const worker=async()=>{ while(cursor<images.length) await scrapeBookCover(images[cursor++]); };
  Promise.all(Array.from({length:Math.min(4,images.length)},worker));
}
function renderBookCard(group, lib, file) {
  const path = String(file.path), title = displayBookTitle(path), ext = fileExt(path).toUpperCase() || "BOOK";
  const progress = Number(readingState(lib.id, path).progress || 0);
  const prefs = bookShelfPrefs();
  /* v0.9.67：漫画归档（zip/cbz）直接用「第一页缩略图」当封面（服务端 w=320，
     命中磁盘缓存；省掉此前外网刮削既慢又常失败的问题）。刮削仍可选覆盖。 */
  const archiveCover = group === "comic" && ["ZIP", "CBZ"].includes(ext) ? comicCoverUrl(lib, path, 320) : "";
  /* v0.9.73：历史阅读视图里每张卡自带「↩ 释放」，不必进阅读器才能移出。 */
  const releaseBtn = group === "comic" && comicShelfView === "completed"
    ? `<button class="book-card-release" type="button" title="从历史阅读释放这本书" onclick="event.stopPropagation();releaseBookFromHistory(${jsAttrArg(lib.id)},${jsAttrArg(path)})">↩ 释放</button>`
    : "";
  /* v0.9.74：封面上加「喜欢」按钮（与音乐收藏同一套本地存储），
     卡片元信息行加一个「阅读 / 继续读」入口；两者都 stopPropagation，
     避免顺带触发整张卡的打开动作。 */
  const favKey = bookFavoriteKey(lib.id, path);
  const favOn = isBookFavorite(lib.id, path);
  const favBtn = prefs.showFav
    ? `<button class="book-card-fav ${favOn ? "on" : ""}" type="button" data-fav-key="${esc(favKey)}" aria-pressed="${favOn}"`
      + ` title="${favOn ? "从喜欢移除" : "加入喜欢"}" aria-label="${favOn ? "从喜欢移除" : "加入喜欢"}"`
      + ` onclick="event.stopPropagation();toggleBookFavorite(${jsAttrArg(lib.id)},${jsAttrArg(path)})">${favOn ? "♥" : "♡"}</button>`
    : "";
  const sizeTxt = Number(file.size) > 0 ? formatFileSize(file.size) : (ext || "BOOK");
  return `<article class="book-card" data-media-group="${esc(group)}" data-media-library="${esc(lib.id)}" data-media-path="${esc(path)}" onclick="openLocalMediaButton(this)">${releaseBtn}${favBtn}<div class="book-cover" style="background:${coverGradient(title)}"><span class="book-cover-title">${esc(title)}</span>${archiveCover
      ? `<img class="book-cover-image" src="${esc(archiveCover)}" alt="${esc(title)} 封面" loading="lazy" onload="this.classList.add('loaded')" onerror="bookCoverFallback(this)">`
      : `<img class="book-cover-image" data-cover-title="${esc(title)}" alt="${esc(title)} 封面" hidden onload="this.hidden=false;this.classList.add('loaded')" onerror="bookCoverFallback(this)">`}</div><div class="book-card-title" title="${esc(path)}">${esc(title)}</div><div class="book-card-meta"><span>${esc(sizeTxt)}</span><span>${progress ? progress.toFixed(1) + "%" : "新入书架"}</span><button class="book-card-open" type="button" onclick="event.stopPropagation();openLocalMediaButton(this.closest('.book-card'))">${progress >= COMPLETED_PROGRESS ? "重读 ›" : progress ? "继续读 ›" : "阅读 ›"}</button></div><div class="book-progress"><span style="width:${Math.min(100, progress)}%"></span></div></article>`;
}
function openLocalMediaButton(button) {
  openLocalMedia(button.dataset.mediaGroup, button.dataset.mediaLibrary, button.dataset.mediaPath);
}
function findMediaLibrary(id) { return localMediaLibraries.find(lib => lib.id === id); }
function readerThemeClass() {
  /* v0.9.73：阅读器主题跟随「明暗」层的解析结果（dark|light，auto 已按系统偏好解析）。
     旧版把「自定义背景」当成第三种主题，导致亮色 + 自定义背景时正文被强制按暗色渲染。 */
  const mode = typeof resolvedThemeMode === "function" ? resolvedThemeMode() : (settings.theme === "light" ? "light" : "dark");
  return mode === "light" ? "reader-theme-light" : "reader-theme-dark";
}
function viewerShell(group, lib, path, body, url, opts = {}) {
  const chapters = opts.chapters || [];
  const chapterHtml = chapters.length ? `<aside class="ebook-chapters"><h4>目录 · ${chapters.length} 章</h4>${chapters.map((ch, i) => `<button data-chapter="${i}" onclick="jumpEbookChapter(${i})">${esc(ch.title)}</button>`).join("")}</aside>` : "";
  const toolbar = opts.ebook ? `<span class="ebook-toolbar"><button title="减小字号" onclick="changeEbookFontSize(-1)">A-</button><button title="增大字号" onclick="changeEbookFontSize(1)">A+</button><button id="ebookFontStyleButton" title="正体/斜体" onclick="toggleEbookFontStyle()">正体</button></span>` : "";
  const video = group === "movie";
  /* v0.9.51：真正的视频播放器（opts.player）不再渲染外层标题条与 ✕ —— 标题已移入
     播放器左上角 ⌄ 右侧（vc-heading），关闭统一走底部控制栏的 ✕。movie 组里的
     PDF/图片等非视频浏览仍保留外层头（标题 + ✕ 关闭）。文档/音频类阅读器同理。 */
  /* v0.9.73：同一个按钮承担「标记已读 / 释放」两态（已读时显示 ↩ 释放），
     文案按该书真实进度渲染，不再永远显示「标记已读」。 */
  const readDone = Number(readingState(lib.id, path).progress || 0) >= COMPLETED_PROGRESS;
  const head = opts.player ? "" : `<div class="media-reader-head"><strong class="media-reader-title" title="${esc(path)}">${esc(displayBookTitle(path))}</strong><div class="media-actions">${toolbar}<button class="btn" id="readerReadToggle" onclick="markReaderCompleted()" title="${readDone ? "从历史阅读释放这本书" : "标记为已读，归档到历史阅读"}">${readDone ? "↩ 释放" : "✓ 标记已读"}</button><button class="media-reader-close" title="关闭并返回书架" onclick="closeLocalViewer('${esc(group)}')">✕</button></div></div>`;
  /* v0.9.30：文档类阅读器（TXT 正文、ZIP 漫画整页）标记 reader-doc，
     让正文区改成内容驱动高度并跟随主题上色，避免纸张只有一屏、
     其余正文落在深色底上，以及漫画页左右露出下层底色。
     PDF/图片/音频仍用固定一屏高度（iframe 需要 height:100%）。 */
  const doc = !opts.player && opts.doc === true;
  /* v0.9.92（需求）：播放影视媒体时自动占满整个窗口 —— 旧布局是
     top:var(--topbar-h); left:var(--sidebar-w)，右侧永远留一列侧栏、
     上方留一条顶栏。player-fullbleed 把浮层拉到 inset:0（CSS 里定义），
     全屏按钮（浏览器全屏）仍然保留，二者互不冲突。 */
  return `<div class="media-reader-overlay ${readerThemeClass()}${doc ? " reader-doc" : ""}${opts.player ? " movie-player player-fullbleed" : ""}">${head}<div class="media-reader-body" data-reader-scroll onscroll="trackReaderProgress(this)">${chapterHtml}<div class="media-reader-wrap">${body}</div></div></div>`;
}
/* v0.9.30：重新打开文档时必须回到上次的阅读位置。
   之前只写进度、从不回填 scrollTop，所以关闭再打开永远从第一页开始，
   而第一屏的滚动事件又会把进度覆盖成 0 —— 进度看起来「保存不了」。
   漫画页是 lazy 图片，scrollHeight 会持续增长，所以按重试逐步逼近目标。 */
let readerRestoring = false;
function restoreReaderProgress(viewer, libId, path, tries = 24) {
  const scroller = viewer?.querySelector(".media-reader-body[data-reader-scroll]");
  if (!scroller) return;
  const target = Number(readingState(libId, path).progress || 0);
  if (!(target > 0) || target >= COMPLETED_PROGRESS) return;
  readerRestoring = true;
  let left = tries;
  const tick = () => {
    const max = scroller.scrollHeight - scroller.clientHeight;
    if (max > 2) scroller.scrollTop = Math.round(max * target / 100);
    if (--left > 0) { setTimeout(tick, 120); return; }
    /* 全部重试结束后才解除抑制，中途的滚动事件不会把进度改写成 0。 */
    readerRestoring = false;
  };
  tick();
}
let ebookFontSize = 17;
let ebookFontItalic = false;
function changeEbookFontSize(delta) {
  ebookFontSize = Math.max(12, Math.min(32, ebookFontSize + delta));
  document.documentElement.style.setProperty("--ebook-font-size", ebookFontSize + "px");
}
function toggleEbookFontStyle() {
  ebookFontItalic = !ebookFontItalic;
  document.documentElement.style.setProperty("--ebook-font-style", ebookFontItalic ? "italic" : "normal");
  const button = document.getElementById("ebookFontStyleButton");
  if (button) button.textContent = ebookFontItalic ? "斜体" : "正体";
}
function buildEbookChapters(text) {
  const chapters = [];
  const pattern = /(^|\n)\s*(第\s*[0-9一二三四五六七八九十百千万零两]+\s*[章卷回节部集篇]|Chapter\s+\d+|CHAPTER\s+\d+|[0-9]+\s*[\.、]\s*\S{2,30})/g;
  let match;
  while ((match = pattern.exec(text))) {
    chapters.push({ title: match[2] || match[1].trim(), offset: match.index + (match[1] === "\n" ? 1 : 0) });
  }
  if (!chapters.length) chapters.push({ title: "全文", offset: 0 });
  return chapters;
}
function jumpEbookChapter(index) {
  const scroller = document.querySelector(".media-reader-body[data-reader-scroll]");
  const chapters = window.__ebookChapters || [];
  const chapter = chapters[index];
  if (!scroller || !chapter || !chapters.length) return;
  const max = scroller.scrollHeight - scroller.clientHeight;
  /* v0.9.70 复审修复：EPUB 章节由服务端按 spine 生成，没有 TXT 那样的字符偏移，
     旧实现用 undefined 偏移算出 NaN → 下拉选择后不跳转（或跳回顶部）。
     现在优先按章节标题元素精确定位（EPUB 与任何分段渲染都适用），
     只有拿不到标题元素（TXT 单块正文）时才退回字符偏移比例，且偏移必须是有限值。 */
  const headings = scroller.querySelectorAll ? scroller.querySelectorAll(".ebook-chapter-title") : [];
  if (headings && headings.length && headings[Math.min(index, headings.length - 1)]) {
    const target = headings[Math.min(index, headings.length - 1)];
    const base = Number(target.offsetTop) || 0;
    scroller.scrollTop = Math.max(0, Math.min(max, base - 8));
  } else if (Number.isFinite(Number(chapter.offset))) {
    const textLen = window.__ebookTextLength || 1;
    scroller.scrollTop = Math.max(0, Math.min(max, Number(chapter.offset) / textLen * max));
  } else {
    scroller.scrollTop = 0;
  }
  scroller.querySelectorAll(".ebook-chapters button").forEach(b => b.classList.toggle("active", Number(b.dataset.chapter) === index));
}
function trackReaderProgress(scroller) {
  if (!activeReader) return;
  /* 正在恢复上次位置时不要记录：此刻 scrollTop 还是 0，
     记下来会立刻把已保存的进度覆盖成 0。 */
  if (readerRestoring) return;
  const max = scroller.scrollHeight - scroller.clientHeight;
  if (max <= 2) return;
  const progress = Math.min(100, scroller.scrollTop / max * 100);
  saveReadingProgress(activeReader.libId, activeReader.path, progress);
}
/* v0.9.73：两态入口 —— 未读时标记已读，已读时释放出历史阅读。 */
function markReaderCompleted() {
  if (!activeReader) return;
  const libId = String(activeReader.libId), path = String(activeReader.path);
  if (Number(readingState(libId, path).progress || 0) >= COMPLETED_PROGRESS) { releaseBookFromHistory(libId, path); return; }
  saveReadingProgress(libId, path, 100);
  syncReaderReadToggle();
  toast("✅ 已移入历史阅读");
}
function syncReaderReadToggle() {
  const button = document.getElementById("readerReadToggle");
  if (!button || !activeReader) return;
  const done = Number(readingState(activeReader.libId, activeReader.path).progress || 0) >= COMPLETED_PROGRESS;
  button.textContent = done ? "↩ 释放" : "✓ 标记已读";
  button.title = done ? "从历史阅读释放这本书" : "标记为已读，归档到历史阅读";
}
async function releaseBookFromHistory(libId, path) {
  const ok = await releaseReadingState(libId, path);
  if (!ok) return;
  syncReaderReadToggle();
  toast("↩ 已从历史阅读释放");
  /* 书架可能正停在历史阅读视图（关闭阅读器也保持该视图），必须重渲染，
     否则被释放的书仍然挂在列表上 —— 这正是用户看到的「释放没生效」。 */
  const lib = findMediaLibrary(String(libId));
  if (lib) loadLocalFiles(String(activeReader ? activeReader.group : "comic"), lib, 0);
}


/* ==================== v0.9.67 音乐歌词与元数据缓存 ====================
   用户诉求：① 增加刮削源提高命中率 ② 歌词能刮削并自动填充
             ③ 「独立做媒体库写入来缓存，预备下次读取」。

   实测结论（从生产容器直连）：
     LRCLIB /api/get 200/0.85s（含时间轴）← 主源；/api/search 偶发 503 需退避
     lyrics.ovh 英文可用、中文 404；NetEase 未公开接口最快但默认关闭
     （api.synclrc.com 实测不可达、Deezer 从 NAS 超时 —— 均未采纳）
   歌词落盘策略：写媒体库同目录 <名>.lrc（原子写、可回滚、行业通用），
   不改音频文件内嵌标签（重写原文件风险高）。 */
const AUDIO_SERVER_CACHE = {};        // libId -> { path: entry }
const AUDIO_SERVER_CACHE_LOADED = {}; // libId -> Promise
const audioLyricsAttempted = new Set(); // 本次会话已尝试过的曲目（含失败）

async function loadAudioServerCache(libId, force = false) {
  if (!libId) return {};
  if (!force && AUDIO_SERVER_CACHE_LOADED[libId]) return AUDIO_SERVER_CACHE_LOADED[libId];
  AUDIO_SERVER_CACHE_LOADED[libId] = (async () => {
    try {
      /* v0.9.70：显式带上限；服务端会返回 truncated 标记（超过上限的尾部条目本次不加载）。 */
      const res = await fetch(`/api/media/audio/cache?id=${encodeURIComponent(libId)}&limit=5000`, { cache: "no-store", credentials: "same-origin" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const items = data.items || {};
      if (data.truncated) {
        try { toast("ℹ️ 服务端元数据缓存较大，本次仅载入前 " + (data.limit || 5000) + " 条"); } catch (e) {}
      }
      AUDIO_SERVER_CACHE[libId] = items;
      applyAudioServerCache(libId, items);
      return items;
    } catch (e) {
      AUDIO_SERVER_CACHE[libId] = AUDIO_SERVER_CACHE[libId] || {};
      return AUDIO_SERVER_CACHE[libId];
    }
  })();
  return AUDIO_SERVER_CACHE_LOADED[libId];
}
/* 服务端缓存 → 本地元数据层：仅在本地没有「手动/已刮削」记录时补齐，
   避免覆盖用户手动适配的内容。 */
function applyAudioServerCache(libId, items) {
  const all = readAudioMetadata();
  let changed = false;
  for (const [path, entry] of Object.entries(items || {})) {
    const cur = all[path];
    if (cur && (cur.provider === "manual")) continue;
    if (cur && cur.provider && String(cur.lyrics || "").trim()) continue;
    const merged = Object.assign({}, cur || audioBaseMetadata(path), {
      title: entry.title || (cur && cur.title) || audioBaseMetadata(path).title,
      artist: entry.artist || (cur && cur.artist) || "未知歌手",
      album: entry.album || (cur && cur.album) || "未知专辑",
      cover: (cur && cur.cover) || entry.cover || "",
      lyrics: (cur && cur.lyrics) || entry.lyrics || "",
      lyrics_source: (cur && cur.lyrics_source) || entry.lyrics_source || "",
      provider: (cur && cur.provider) || entry.provider || "",
      /* v0.9.88：未命中的曲目也要有状态，否则每次进库都会被当成新曲重查。 */
      status: (cur && cur.status) || entry.status || "",
      error_code: (cur && cur.error_code) || entry.error_code || "",
      checkedAt: entry.checked_at ? entry.checked_at * 1000 : Date.now()
    });
    all[path] = merged;
    changed = true;
  }
  if (changed) writeAudioMetadata(all);
}
function saveAudioServerCache(libId, path, patch) {
  if (!libId || !path) return;
  try {
    const body = Object.assign({ path }, patch || {});
    fetch(`/api/media/audio/cache?id=${encodeURIComponent(libId)}`, {
      method: "POST",
      headers: sessionWriteHeaders(true),
      credentials: "same-origin",
      body: JSON.stringify(body)
    }).catch(() => { /* 缓存写入失败不影响当前会话展示 */ });
    const store = AUDIO_SERVER_CACHE[libId] || (AUDIO_SERVER_CACHE[libId] = {});
    store[path] = Object.assign({ path }, store[path] || {}, patch || {});
  } catch (e) {}
}
/* 歌词刮削：本地识别优先（服务端会先读同名 .lrc 与内嵌标签），命中后落盘 sidecar。 */
async function fetchAudioLyrics(libId, path, opts = {}) {
  const meta = audioMetadataFor(path);
  const q = new URLSearchParams();
  q.set("id", libId);
  q.set("path", path);
  q.set("title", opts.title || meta.title || "");
  q.set("artist", opts.artist || (meta.artist && meta.artist !== "未知歌手" ? meta.artist : ""));
  if (opts.save !== false) q.set("save", "1");
  if (opts.force) q.set("force", "1");
  const res = await fetch(`/api/media/audio/lyrics?${q.toString()}`, { cache: "no-store", credentials: "same-origin" });
  if (!res.ok) return null;
  const data = await res.json();
  if (!data || !data.found || !data.lyrics) return null;
  const all = readAudioMetadata();
  const base = all[path] || audioBaseMetadata(path);
  all[path] = Object.assign({}, base, {
    lyrics: data.lyrics,
    lyrics_source: data.lyrics_source || "online",
    checkedAt: Date.now()
  });
  writeAudioMetadata(all);
  saveAudioServerCache(libId, path, {
    title: all[path].title, artist: all[path].artist, album: all[path].album,
    cover: all[path].cover, lyrics: data.lyrics,
    lyrics_source: data.lyrics_source || "online", provider: all[path].provider
  });
  return data;
}
function audioLyricsSourceLabel(path) {
  const meta = audioMetadataFor(path) || {};
  const src = String(meta.lyrics_source || "");
  if (!src) return String(meta.lyrics || "").trim() ? "手动" : "";
  return ({
    "local-lrc": "本地 .lrc",
    "local-id3": "内嵌标签",
    "local-vorbis": "内嵌标签",
    "local-mp4": "内嵌标签",
    "LRCLIB": "LRCLIB",
    "lyrics.ovh": "lyrics.ovh",
    "NetEase": "网易云",
    "manual": "手动"
  })[src] || src;
}
/* 播放时自动补歌词（本次会话每曲只尝试一次；失败静默，不打扰阅读）。 */
async function ensureAudioLyrics(libId, path, meta) {
  if (!libId || !path) return;
  const current = meta || audioMetadataFor(path);
  if (current && String(current.lyrics || "").trim()) return;
  if (audioLyricsAttempted.has(path)) return;
  audioLyricsAttempted.add(path);
  try {
    const data = await fetchAudioLyrics(libId, path, {});
    if (!data) return;
    const active = activeAudio && String(active.path) === String(path);
    if (active) {
      renderPlayerLyrics(audioMetadataFor(path));
      updateAudioExpandArt(audioMetadataFor(path));
    }
    toast(`🎵 已自动填充歌词（${audioLyricsSourceLabel(path) || "在线"}）`);
    const lib = findMediaLibrary(libId);
    if (lib && audioView) loadLocalFiles("audio", lib, audioCursor);
  } catch (e) { /* 取歌词失败不影响播放 */ }
}
/* 弹窗内「在线刮削歌词」按钮：把结果回填到文本框，用户确认后再保存。 */
async function scrapeLyricsForOpenEditor() {
  const path = document.getElementById("audioMetadataPath")?.value || "";
  const lib = findMediaLibrary(localMediaSelection.audio);
  if (!path || !lib) return;
  /* v0.9.71：清掉本次会话的「已尝试」标记，让服务端全新的检索阶梯
     （去修饰变体 → 结构化检索 → 自由文本兜底，含日语/特殊字符策略）真正跑一遍。 */
  audioLyricsAttempted.delete(path);
  const box = document.getElementById("audioMetadataLyrics");
  toast("🎵 正在刮削歌词…");
  try {
    const data = await fetchAudioLyrics(lib.id, path, {
      title: document.getElementById("audioMetadataTitle")?.value || "",
      artist: document.getElementById("audioMetadataArtist")?.value || "",
      force: true
    });
    if (!data) { toast("⚠️ 未找到歌词（可换关键字后重试）"); return; }
    if (box) box.value = data.lyrics;
    toast(`🎵 已获取歌词（${audioLyricsSourceLabel(path) || data.lyrics_source}），点「保存适配」写入`);
  } catch (e) { toast("⚠️ 歌词刮削失败：" + (e.message || e)); }
}
/* 批量：当前库里还没有歌词的曲目，每批最多 50 首（服务端串行节流，避免触发限流）。 */
async function scrapeAllAudioLyrics() {
  const lib = findMediaLibrary(localMediaSelection.audio);
  if (!lib) { toast("⚠️ 请先选择音乐库"); return; }
  let pool = audioFiles || [];
  try {
    const all = await fetchAllLibraryFiles(lib.id, { has_more: true }, 0);
    const audioOnly = all.filter(file => supportedLocalMediaFile("audio", lib, String(file.path)));
    if (audioOnly.length) pool = audioOnly;
  } catch (e) { /* 整库拉取失败就用当前页 */ }
  const targets = pool.filter(file => !String((audioMetadataFor(String(file.path)) || {}).lyrics || "").trim()).slice(0, 50);
  if (!targets.length) { toast("✅ 当前曲目都已有歌词"); return; }
  toast(`🎵 正在刮削 ${targets.length} 首曲目的歌词…`);
  try {
    const res = await fetch(`/api/media/audio/lyrics/batch?id=${encodeURIComponent(lib.id)}`, {
      method: "POST",
      headers: sessionWriteHeaders(true),
      credentials: "same-origin",
      body: JSON.stringify({
        save: true,
        items: targets.map(file => {
          const meta = audioMetadataFor(String(file.path)) || {};
          return { path: String(file.path), title: meta.title || "", artist: (meta.artist && meta.artist !== "未知歌手") ? meta.artist : "" };
        })
      })
    });
    if (res.status === 429) throw new Error("已有歌词刮削任务在进行中，请稍后重试");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    await loadAudioServerCache(lib.id, true);
    const l = findMediaLibrary(lib.id);
    if (l) loadLocalFiles("audio", l, audioCursor);
    toast(`🎵 歌词刮削完成：命中 ${data.hits || 0} / ${data.total || 0} 首`);
  } catch (e) { toast("⚠️ 批量歌词刮削失败：" + (e.message || e)); }
}

/* ==================== v0.9.67 漫画阅读器 ====================
   用户诉求（2026-09）：阅读太慢（像在用浏览器自带 PDF 阅读器）、希望有单页/双页/条漫与
   阅读方向、按页码记进度、书架有封面。

   实测定位（真实 4K 掃圖組 归档）：服务端解压 33ms/页并不是瓶颈，瓶颈是
   「每页 1.5–3.8MB 原图 + 零预取 + 缓存仅 1 小时」。且归档内 95% 是 PNG 无损存档。
   因此本模块做两件事：
     ① 预取窗口（默认前后各 3 页）—— 翻页不再等网络，纯前端收益、零成本；
     ② 可选「省流模式」—— 走服务端按页转码 /page?w=1600（JPEG，体积约 39%–56%，
        内容寻址磁盘缓存 + immutable，只付一次成本）。LAN/4g 下默认关闭（原图直出更快），
        仅在 saveData / 2g-3g 或用户显式开启时启用。
   不引入任何第三方阅读器组件：StPageFlip 之类只提供翻页动画，解决不了单页 3.5MB 的传输问题。 */
const COMIC_PREFS_KEY = "vaulthub_comic_prefs";
const COMIC_PREFETCH_AHEAD = 3;
const COMIC_DEFAULT_WIDTH = 1600;
let comicState = null;
let comicToolbarTimer = null;

function comicPrefs() {
  const def = { saveData: "auto", mode: "single", rtl: true, fit: "width", width: COMIC_DEFAULT_WIDTH };
  try { return Object.assign(def, JSON.parse(localStorage.getItem(COMIC_PREFS_KEY) || "{}") || {}); } catch (e) { return def; }
}
function saveComicPrefs(patch) {
  const next = Object.assign(comicPrefs(), patch || {});
  try { localStorage.setItem(COMIC_PREFS_KEY, JSON.stringify(next)); } catch (e) {}
  return next;
}
function comicSaveDataActive() {
  const mode = String(comicPrefs().saveData || "auto");
  if (mode === "on") return true;
  if (mode === "off") return false;
  /* v0.9.71：弱网模式（测速判定为弱网）也视同省流 —— 与音频 96k 档位同一套判定。 */
  if (typeof weakNetworkActive === "function" && weakNetworkActive()) return true;
  const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (!c) return false;
  if (c.saveData) return true;
  return /^(slow-)?2g$|^3g$/.test(String(c.effectiveType || ""));
}
function comicTranscodeWidth() {
  /* v0.9.84：页面清晰度以「画面清晰度」档位为准 —— 显式档位（原画 0 / 高清 1600 /
     流畅 1200 / 极省 900）直接生效；「自动」档返回 null，交回 v0.9.71 的省流判定
     （保持既有契约：自动 + 无弱网信息 = 原图直出、弱网/saveData = 1600）。 */
  if (typeof qualityPageWidth === "function") {
    const explicit = qualityPageWidth();
    if (explicit !== null) return Number(explicit) || 0;
  }
  return comicSaveDataActive() ? (Number(comicPrefs().width) || COMIC_DEFAULT_WIDTH) : 0;
}
/* v0.9.84：阅读器工具栏按钮的文案 —— 显式档位显示档位名，自动档显示「画质·自动」。 */
function comicQualityHint() {
  if (typeof qualityLabelText !== "function") return "";
  const p = typeof qualityProfile === "function" ? qualityProfile() : null;
  return p ? `${qualityLabelText()}（${p.sub}）` : qualityLabelText();
}
function comicPageUrl(lib, path, entry, width) {
  const raw = String((entry && (entry.raw || entry.name)) || entry || "");
  /* v0.9.77：PDF 的「条目」就是页码，服务端渲染成 JPEG 后同样进页缓存。 */
  const isPDF = !!(entry && entry.pdf);
  let u = isPDF
    ? "/api/media/pdf/page?id=" + encodeURIComponent(lib.id) + "&path=" + encodeURIComponent(path) + "&page=" + encodeURIComponent(raw)
    : "/api/media/archive/zip/page?id=" + encodeURIComponent(lib.id) + "&path=" + encodeURIComponent(path) + "&entry=" + encodeURIComponent(raw);
  if (Number(width) > 0) u += "&w=" + encodeURIComponent(width);
  return u;
}
function comicCoverUrl(lib, path, width) {
  /* v0.9.84：书架封面尺寸跟随「画面清晰度」档位（原画/高清 320，流畅 200，极省 140）。 */
  const requested = Number(width) || 320;
  const w = typeof qualityCoverWidth === "function" ? qualityCoverWidth(requested) : requested;
  /* v0.9.77：PDF 封面 = 第 1 页小图（服务端渲染），避免书架用浏览器 PDF 缩略图。 */
  const m = String(path).toLowerCase().match(/\.([^.\\/]+)$/);
  if (m && m[1] === "pdf") {
    return "/api/media/pdf/cover?id=" + encodeURIComponent(lib.id) + "&path=" + encodeURIComponent(path) + "&w=" + w;
  }
  return "/api/media/archive/zip/cover?id=" + encodeURIComponent(lib.id) + "&path=" + encodeURIComponent(path) + "&w=" + w;
}
function comicPageUrlAt(state, page) {
  const entry = state.entries[page - 1];
  return entry ? comicPageUrl(state.lib, state.path, entry, comicTranscodeWidth()) : "";
}
function comicFitLabel(fit) { return fit === "height" ? "适高" : fit === "native" ? "原始" : "适宽"; }
function comicModeLabel(mode) { return mode === "double" ? "双页" : mode === "scroll" ? "条漫" : "单页"; }
function comicSaveLabel() {
  /* v0.9.84：该按钮由「省流开关」升级为「画面清晰度」档位（原画/高清/流畅/极省/自动）。
     没有载入档位模块时（如契约测试的隔离沙箱）退回旧的省流文案，保持向后兼容。 */
  if (typeof qualityLabelText === "function") return qualityLabelText();
  const m = String(comicPrefs().saveData || "auto");
  return m === "on" ? "省流·开" : m === "off" ? "省流·关" : "省流·自动";
}
function comicReaderHtml(state) {
  return `<div class="comic-reader fit-${esc(state.fit)}" data-mode="${esc(state.mode)}" data-rtl="${state.rtl ? "1" : "0"}">
<div class="comic-toolbar" data-comic-toolbar>
<button class="comic-tool" type="button" data-act="prev" title="上一页（←）">‹</button>
<span class="comic-page-box"><input class="comic-page-input" data-comic-page-input value="${state.page}" inputmode="numeric" aria-label="页码"> / <span data-comic-page-total>${state.total}</span></span>
<button class="comic-tool" type="button" data-act="next" title="下一页（→）">›</button>
<span class="comic-sep"></span>
<button class="comic-tool" type="button" data-act="mode" data-value="single" title="单页模式">单页</button>
<button class="comic-tool" type="button" data-act="mode" data-value="double" title="双页模式">双页</button>
<button class="comic-tool" type="button" data-act="mode" data-value="scroll" title="条漫模式（连续滚动）">条漫</button>
<span class="comic-sep"></span>
<button class="comic-tool" type="button" data-act="rtl" title="切换阅读方向：右起（日漫）/ 左起">${state.rtl ? "右起" : "左起"}</button>
<button class="comic-tool" type="button" data-act="fit" title="切换适应方式">${comicFitLabel(state.fit)}</button>
<button class="comic-tool comic-tool-save" type="button" data-act="save" title="画面清晰度：原画 → 高清 → 流畅 → 极省（最低档无色彩）；档位越高越清晰、色彩越完整">${comicSaveLabel()}</button>
<span class="comic-hint">${esc(comicModeLabel(state.mode))} · 左右半屏点击翻页 · Esc 关闭</span>
</div>
<div class="comic-stage" data-comic-stage>
<div class="comic-slot"><img class="comic-img" data-slot="0" alt=""></div>
<div class="comic-slot"><img class="comic-img" data-slot="1" alt=""></div>
</div>
</div>`;
}
/* 页码进度：新值优先；旧数据只有百分比时按 total 换算。 */
function comicResumePage(state, saved) {
  const total = state.total || 1;
  const page = Number(saved && saved.page) || 0;
  if (page > 0 && (!saved.total || Number(saved.total) === total)) return Math.max(1, Math.min(total, page));
  const pct = Number(saved && saved.progress) || 0;
  /* 先乘后除：pct/100*total 在 28.5% 这类取值上会得到 28.499…，四舍五入后差一页。 */
  if (pct > 0) return Math.max(1, Math.min(total, Math.round(pct * total / 100) || 1));
  return 1;
}
function mountComicReader(viewer, lib, path, entries, url, options = {}) {
  const prefs = comicPrefs();
  const state = {
    viewer, lib, path, entries, total: entries.length,
    /* v0.9.77：PDF 源（页由服务端 pdftoppm 光栅化），页 URL 走 /api/media/pdf/page。 */
    pdf: !!options.pdf,
    mode: ["single", "double", "scroll"].includes(prefs.mode) ? prefs.mode : "single",
    rtl: !!prefs.rtl,
    fit: ["width", "height", "native"].includes(prefs.fit) ? prefs.fit : "width",
    page: 1, prefetched: new Set(), observer: null, keyHandler: null
  };
  state.page = comicResumePage(state, readingState(lib.id, path));
  comicState = state;
  viewer.innerHTML = viewerShell("comic", lib, path, comicReaderHtml(state), url, { doc: true });
  comicBind(state);
  comicRenderStage(state, true);
  comicRecordProgress(state);
}
function comicScroller(state) {
  return state.viewer.querySelector(".media-reader-body") || null;
}
function comicShowToolbar(root) {
  if (!root) return;
  const bar = root.querySelector("[data-comic-toolbar]");
  if (!bar) return;
  bar.classList.remove("toolbar-hidden");
  if (comicToolbarTimer) clearTimeout(comicToolbarTimer);
  comicToolbarTimer = setTimeout(() => { bar.classList.add("toolbar-hidden"); }, 3000);
}
function comicUpdateIndicator(state) {
  const root = state.viewer.querySelector(".comic-reader");
  if (!root) return;
  const input = root.querySelector("[data-comic-page-input]");
  if (input && document.activeElement !== input) input.value = String(state.page);
  const total = root.querySelector("[data-comic-page-total]");
  if (total) total.textContent = String(state.total);
  root.querySelectorAll("[data-act='mode']").forEach(b => b.classList.toggle("active", b.dataset.value === state.mode));
  const rtlBtn = root.querySelector("[data-act='rtl']");
  if (rtlBtn) rtlBtn.textContent = state.rtl ? "右起" : "左起";
  const fitBtn = root.querySelector("[data-act='fit']");
  if (fitBtn) fitBtn.textContent = comicFitLabel(state.fit);
  const saveBtn = root.querySelector("[data-act='save']");
  if (saveBtn) {
    saveBtn.textContent = comicSaveLabel();
    saveBtn.classList.toggle("saving", comicSaveDataActive());
  }
  const hint = root.querySelector(".comic-hint");
  if (hint) hint.textContent = `${comicModeLabel(state.mode)} · 左右半屏点击翻页 · Esc 关闭`;
}
function comicRenderStage(state, rebuild) {
  const root = state.viewer.querySelector(".comic-reader");
  if (!root) return;
  const stage = root.querySelector("[data-comic-stage]");
  if (!stage) return;
  root.dataset.mode = state.mode;
  root.dataset.rtl = state.rtl ? "1" : "0";
  root.dataset.fit = state.fit;
  stage.classList.toggle("comic-rtl", !!state.rtl);
  stage.classList.toggle("is-scroll", state.mode === "scroll");
  if (state.observer) { try { state.observer.disconnect(); } catch (e) {} state.observer = null; }
  if (state.mode === "scroll") {
    const wrap = stage.querySelector(".comic-archive-pages");
    if (rebuild || !wrap) {
      const html = state.entries.map((entry, i) => `<img class="comic-img" loading="lazy" decoding="async" data-page="${i + 1}" src="${esc(comicPageUrl(state.lib, state.path, entry, comicTranscodeWidth()))}" alt="第 ${i + 1} 页">`).join("");
      stage.innerHTML = `<div class="comic-archive-pages">${html}</div>`;
    } else {
      wrap.querySelectorAll(".comic-img[data-page]").forEach(img => {
        const page = Number(img.dataset.page) || 1;
        const next = comicPageUrlAt(state, page);
        if (next && img.getAttribute("src") !== next) img.setAttribute("src", next);
      });
    }
    comicObserveScroll(state, stage);
    comicUpdateIndicator(state);
    return;
  }
  const slots = stage.querySelectorAll(".comic-slot");
  if (!slots.length) return;
  const pages = state.mode === "double" ? [state.page, state.page + 1].filter(p => p <= state.total) : [state.page];
  slots.forEach((slot, idx) => {
    const img = slot.querySelector(".comic-img");
    const page = pages[idx];
    if (!page) {
      slot.hidden = true;
      if (img) { img.removeAttribute("src"); img.alt = ""; delete img.dataset.page; }
      return;
    }
    slot.hidden = false;
    if (!img) return;
    const next = comicPageUrlAt(state, page);
    if (next && img.getAttribute("src") !== next) img.setAttribute("src", next);
    img.alt = `第 ${page} 页`;
    img.dataset.page = String(page);
  });
  if (state.mode === "single" && slots[1]) slots[1].hidden = true;
  comicPrefetch(state);
  comicUpdateIndicator(state);
}
function comicObserveScroll(state, stage) {
  if (typeof IntersectionObserver !== "function") return;
  const images = stage.querySelectorAll(".comic-img[data-page]");
  if (!images.length) return;
  state.observer = new IntersectionObserver(entries => {
    let best = 0;
    entries.forEach(en => {
      if (!en.isIntersecting) return;
      const p = Number(en.target.dataset.page) || 1;
      if (p > best) best = p;
    });
    if (!best || best === state.page) return;
    state.page = Math.min(state.total, best);
    comicRecordProgress(state);
    comicUpdateIndicator(state);
  }, { root: comicScroller(state), rootMargin: "-40% 0px -40% 0px", threshold: 0 });
  images.forEach(img => state.observer.observe(img));
}
function comicPrefetch(state) {
  if (state.mode === "scroll" || !state.total) return;
  const ahead = state.mode === "double" ? COMIC_PREFETCH_AHEAD * 2 : COMIC_PREFETCH_AHEAD;
  const list = [state.page - 1];
  for (let d = 1; d <= ahead; d++) list.push(state.page + d);
  list.forEach(page => {
    if (page < 1 || page > state.total) return;
    const url = comicPageUrlAt(state, page);
    if (!url || state.prefetched.has(url)) return;
    state.prefetched.add(url);
    try {
      const img = new Image();
      img.decoding = "async";
      img.fetchPriority = "low";
      img.src = url;
    } catch (e) { /* 预取失败不影响当前页阅读 */ }
  });
}
function comicRecordProgress(state) {
  if (!state) return;
  const total = state.total || 1;
  const percent = total > 1 ? (state.page - 1) / (total - 1) * 100 : 100;
  saveReadingProgress(state.lib.id, state.path, percent, state.page, total);
}
function comicSetPage(state, page, opts) {
  if (!state) return;
  const o = opts || {};
  const next = Math.max(1, Math.min(state.total || 1, Number(page) || 1));
  state.page = next;
  comicRenderStage(state, !!o.rebuild);
  if (state.mode === "scroll" && o.scroll) {
    /* 用相对位移设置 scrollTop，而不用浏览器的滚动定位 API：后者会连带滚动外层文档，
       在读者视图里表现为「翻页把整页顶走」（既有契约只允许 scrollViewerIntoView 调用它）。 */
    const scroller = comicScroller(state);
    const target = state.viewer.querySelector(`.comic-img[data-page="${next}"]`);
    if (scroller && target) {
      const delta = target.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      if (Number.isFinite(delta)) scroller.scrollTop = Math.max(0, scroller.scrollTop + delta);
    }
  }
  comicRecordProgress(state);
  comicShowToolbar(state.viewer.querySelector(".comic-reader"));
}
function comicStep(state, delta) {
  if (!state) return;
  comicSetPage(state, state.page + Number(delta || 0), { rebuild: false, scroll: state.mode === "scroll" });
}
function comicGoto(state, value) {
  if (!state) return;
  comicSetPage(state, Number(value), { rebuild: false, scroll: state.mode === "scroll" });
}
function comicSetMode(state, mode) {
  if (!state || !["single", "double", "scroll"].includes(mode)) return;
  state.mode = mode;
  saveComicPrefs({ mode });
  comicRenderStage(state, true);
  toast(`📖 已切换${comicModeLabel(mode)}模式`);
}
function comicBind(state) {
  const root = state.viewer.querySelector(".comic-reader");
  if (!root) return;
  const bar = root.querySelector("[data-comic-toolbar]");
  if (bar) {
    bar.addEventListener("click", ev => {
      const btn = ev.target.closest("button[data-act]");
      if (!btn) return;
      ev.preventDefault();
      const act = btn.dataset.act;
      const stepSize = state.mode === "double" ? 2 : 1;
      if (act === "prev") comicStep(state, -stepSize);
      else if (act === "next") comicStep(state, stepSize);
      else if (act === "mode") comicSetMode(state, btn.dataset.value);
      else if (act === "rtl") {
        state.rtl = !state.rtl;
        saveComicPrefs({ rtl: state.rtl });
        comicRenderStage(state, true);
        toast(state.rtl ? "📕 右起（日漫）" : "📗 左起");
      } else if (act === "fit") {
        const order = ["width", "height", "native"];
        state.fit = order[(order.indexOf(state.fit) + 1) % order.length];
        saveComicPrefs({ fit: state.fit });
        comicRenderStage(state, false);
      } else if (act === "save") {
        /* v0.9.84：循环「画面清晰度」档位（自动 → 原画 → 高清 → 流畅 → 极省）。
           换档 = 清晰的清晰度 + 色彩一起变；最低档无色彩，切回高档立即恢复。 */
        if (typeof cycleQualityLevel === "function") {
          const next = cycleQualityLevel({ rerender: false });
          const profile = typeof qualityProfile === "function" ? qualityProfile() : null;
          const label = typeof qualityLabelText === "function" ? qualityLabelText() : "画质";
          state.prefetched = new Set();
          saveComicPrefs({ saveData: next === "auto" ? "auto" : next === "original" ? "off" : "on" });
          comicRenderStage(state, true);
          toast(`🖼 ${label}${profile ? " · " + profile.sub : ""}`);
        } else {
          const order = ["auto", "on", "off"];
          const next = order[(order.indexOf(String(comicPrefs().saveData || "auto")) + 1) % order.length];
          saveComicPrefs({ saveData: next });
          state.prefetched = new Set();
          comicRenderStage(state, true);
          toast(next === "on" ? "🪶 省流模式：开（按页转码，单页体积约降到一半）" : next === "off" ? "🖼️ 省流模式：关（原图直出）" : "🪶 省流模式：自动（弱网才开）");
        }
      }
    });
  }
  const input = root.querySelector("[data-comic-page-input]");
  if (input) {
    input.addEventListener("change", () => comicGoto(state, input.value));
    input.addEventListener("keydown", ev => {
      if (ev.key === "Enter") { ev.preventDefault(); comicGoto(state, input.value); input.blur(); }
    });
  }
  const stage = root.querySelector("[data-comic-stage]");
  if (stage) {
    stage.addEventListener("click", ev => {
      if (ev.target.closest("input,button,a")) return;
      if (state.mode === "scroll") return;
      const rect = stage.getBoundingClientRect();
      if (!rect.width) return;
      const leftHalf = ev.clientX - rect.left < rect.width / 2;
      /* 右起（日漫）时左半屏才是「下一页」。 */
      const forward = state.rtl ? leftHalf : !leftHalf;
      comicStep(state, (state.mode === "double" ? 2 : 1) * (forward ? 1 : -1));
    });
  }
  state.keyHandler = ev => {
    /* 自愈条件必须包含「阅读器 DOM 仍在」：closeLocalViewer() 只清空 innerHTML，
       视图容器本身仍 isConnected —— 只判 isConnected 会让监听在阅读器关闭后继续
       响应方向键，静默改动「已关闭」这本书的进度。
       清理时**只动自己**：不能调用 closeComicReader()（它清的是模块级当前状态），
       否则旧阅读器的残留 handler 会把「刚打开的新阅读器」一起废掉（错位清理）。 */
    const alive = state.viewer.isConnected && state.viewer.querySelector(".comic-reader");
    if (comicState !== state || !alive) {
      document.removeEventListener("keydown", state.keyHandler);
      state.keyHandler = null;
      if (state.observer) { try { state.observer.disconnect(); } catch (e) {} state.observer = null; }
      if (comicState === state) comicState = null;
      return;
    }
    const t = ev.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    const stepSize = state.mode === "double" ? 2 : 1;
    /* 工具栏提示写了「Esc 关闭」，就必须真的能关：此前只有音乐海报遮罩绑定了 Esc，
       漫画阅读器只能点右上角 ✕，文案与实际不符。 */
    if (ev.key === "Escape") {
      ev.preventDefault();
      closeLocalViewer("comic");
      return;
    }
    if (ev.key === "ArrowRight" || ev.key === "PageDown" || (ev.key === " " && state.mode !== "scroll")) {
      ev.preventDefault();
      comicStep(state, state.rtl ? -stepSize : stepSize);
    } else if (ev.key === "ArrowLeft" || ev.key === "PageUp") {
      ev.preventDefault();
      comicStep(state, state.rtl ? stepSize : -stepSize);
    } else if (ev.key === "Home") {
      ev.preventDefault();
      comicSetPage(state, 1, { rebuild: false, scroll: true });
    } else if (ev.key === "End") {
      ev.preventDefault();
      comicSetPage(state, state.total, { rebuild: false, scroll: true });
    }
  };
  document.addEventListener("keydown", state.keyHandler);
  root.addEventListener("mousemove", () => comicShowToolbar(root));
  root.addEventListener("touchstart", () => comicShowToolbar(root), { passive: true });
  comicShowToolbar(root);
}
/* 关闭/切走时释放 IntersectionObserver 与全局键盘监听，避免切书后重复响应。 */
function closeComicReader() {
  const state = comicState;
  if (comicToolbarTimer) { clearTimeout(comicToolbarTimer); comicToolbarTimer = null; }
  comicState = null;
  if (!state) return;
  if (state.observer) { try { state.observer.disconnect(); } catch (e) {} state.observer = null; }
  if (state.keyHandler) { document.removeEventListener("keydown", state.keyHandler); state.keyHandler = null; }
}

const VIDEO_ENGINE_NATIVE = "native";
const VIDEO_ENGINE_COMPAT = "compat";
const VIDEO_ENGINE_WASM = "wasm";
const VIDEO_ENGINE_LABELS = { native: "浏览器原生", compat: "FFmpeg 兼容流", wasm: "WebAssembly SIMD" };
const WASM_INPUT_LIMIT = 256 * 1024 * 1024;
function detectWasmSimd() {
  if (typeof WebAssembly !== "object" || typeof WebAssembly.validate !== "function") return false;
  // Minimal module containing v128.const; validation proves SIMD instructions compile.
  return WebAssembly.validate(new Uint8Array([0,97,115,109,1,0,0,0,1,5,1,96,0,1,123,3,2,1,0,10,22,1,20,0,253,12,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,11]));
}
function setVideoEngine(root, engine, detail) {
  if (!root) return;
  root.dataset.videoEngine = engine;
  root.querySelectorAll("[data-engine-choice]").forEach(button => button.classList.toggle("active", button.dataset.engineChoice === engine));
  /* v0.9.51：状态行不再向用户暴露「浏览器原生 / FFmpeg 兼容流 / WebAssembly」引擎标签，
     只显示对用户有意义的原因文案（播放计划 / 转码模式 / 降级原因）。 */
  if (detail) setMovieCompatStatus(root, detail);
}
function terminateWasmVideo(root) {
  if (root?.__wasmWorker) { root.__wasmWorker.terminate(); root.__wasmWorker = null; }
  if (root?.__wasmObjectUrl) { URL.revokeObjectURL(root.__wasmObjectUrl); root.__wasmObjectUrl = ""; }
}
async function startWasmVideoFallback(root, video, direct) {
  if (!detectWasmSimd()) throw new Error("当前浏览器不支持 WebAssembly SIMD");
  setVideoEngine(root, VIDEO_ENGINE_WASM, "加载原片并启动软件解码");
  const response = await fetch(direct, { cache: "no-store" });
  if (!response.ok) throw new Error(`原片读取失败 HTTP ${response.status}`);
  const size = Number(response.headers.get("Content-Length") || 0);
  if (size > WASM_INPUT_LIMIT) {
    response.body?.cancel?.();
    throw new Error("文件超过 256 MB，浏览器软件解码为保护内存已停止");
  }
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > WASM_INPUT_LIMIT) throw new Error("文件超过 256 MB，浏览器软件解码为保护内存已停止");
  terminateWasmVideo(root);
  /* Worker 脚本同样要带版本号：它是我们自己的代码，不带版本时浏览器只会按
     max-age=300 复用，升级后 5 分钟内仍可能执行旧 Worker。 */
  const worker = new Worker(`/web/vendor/ffmpeg/worker.js?v=${encodeURIComponent(VAULTHUB_SCRIPT_VERSION)}`);
  root.__wasmWorker = worker;
  const id = Date.now().toString(36);
  let output;
  try {
    output = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("WASM 软件解码超时")), 180000);
      worker.onmessage = event => {
        const message = event.data || {};
        if (message.id !== id) return;
        if (message.type === "done") { clearTimeout(timeout); resolve(message.bytes); }
        if (message.type === "error") { clearTimeout(timeout); reject(new Error(message.error || "WASM 解码失败")); }
      };
      worker.onerror = event => { clearTimeout(timeout); reject(new Error(event.message || "WASM Worker 启动失败")); };
      worker.postMessage({ type: "transcode", id, bytes, start: 0, duration: 60 }, [bytes]);
    });
  } catch (error) {
    terminateWasmVideo(root);
    throw error;
  }
  worker.terminate();
  root.__wasmWorker = null;
  const objectUrl = URL.createObjectURL(new Blob([output], { type: "video/mp4" }));
  root.__wasmObjectUrl = objectUrl;
  switchMovieSource(video, objectUrl);
  setVideoEngine(root, VIDEO_ENGINE_WASM, "软件解码完成 · 当前为前 60 秒兼容片段");
}
async function probeVideoFileSize(direct, timeoutMs = 10000) {
  /* v0.9.51：降级前先轻量探测原片大小（Range 请求，不下载正文），
     超过浏览器软件解码上限就不再启动注定失败的 WASM 全量下载。 */
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(direct, { method: "GET", headers: { Range: "bytes=0-0" }, cache: "no-store", signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) return 0;
    const match = /\/\s*(\d+)\s*$/.exec(response.headers.get("Content-Range") || "");
    if (match) return Number(match[1]);
    return Number(response.headers.get("Content-Length") || 0);
  } catch (e) { return 0; }
}
/* v0.9.51：播放中断后的自动恢复 —— 重新请求播放计划并建立全新 task 会话。
   放大/缩小/关闭/切换页面后再回来，旧转码任务多半已被服务端回收，
   继续用旧 URL 只会反复报「转码流暂不可用」。此函数重建会话并切流，
   由 advanceVideoEngine 在死局前调用一次，或由用户点击画面再次触发。 */
async function retryPlaybackPlanOnce(videoRoot, lib, path, direct, useCompat, useDirect) {
  const video = videoRoot?.querySelector("video[data-movie-player]");
  if (!video || !lib || !path) return false;
  try {
    const plan = await requestPlaybackPlan(lib, path, videoRoot.dataset.videoQuality || "auto");
    videoRoot.dataset.videoMetadata = formatVideoMetadata(plan.media);
    videoRoot.dataset.playbackMode = plan.mode || "auto";
    setMovieCompatStatus(videoRoot, `${playbackModeLabel(plan)} · ${plan.reason || "自动重试"}`);
    const sessionID = await createVideoPlaybackSession(videoRoot, lib, path, plan.mode);
    const plannedURL = plan.url && sessionID && plan.mode !== "direct" ? `${plan.url}&task=${encodeURIComponent(sessionID)}` : (plan.url || mediaCompatUrl(lib, path));
    if (plan.mode === "direct") useDirect("原片直连 · 自动重试成功");
    else useCompat("转码流 · 自动重试成功", plannedURL);
    return true;
  } catch (error) {
    return false;
  }
}
async function advanceVideoEngine(root, video, context) {
  const engine = root.dataset.videoEngine || VIDEO_ENGINE_NATIVE;
  if (engine === VIDEO_ENGINE_NATIVE) { context.useCompat("原片直连不可用，已自动切换转码兼容流"); return; }
  if (engine === VIDEO_ENGINE_COMPAT) {
    /* v0.9.51：计划流（带 task 会话）失败时，先用不带会话的基础兼容流重试一次 ——
       很多「第一次打不开、点第二次能播」的异常来自转码会话尚未就绪。 */
    const current = video.dataset.currentSrc || "";
    const usingPlanURL = current.includes("task=") || /\/api\/media\/playback\/stream\?/.test(current);
    if (usingPlanURL) {
      setMovieCompatStatus(root, "智能转码流暂不可用，切换基础兼容流重试");
      context.useCompat("智能转码流暂不可用，已切换基础兼容流");
      return;
    }
    const size = await probeVideoFileSize(context.direct);
    if (size > WASM_INPUT_LIMIT) {
      /* v0.9.51：基础兼容流也失败且原片超过软解上限时，不再直接宣告死局 ——
         先自动重建一次播放计划（新 task 会话、服务端重新起转码）；
         仍失败才落到死局提示，并允许点击画面重试。 */
      if (context.retryPlan && !root.dataset.playbackRetried) {
        root.dataset.playbackRetried = "1";
        if (await context.retryPlan()) return;
      }
      setMovieCompatStatus(root, "转码流暂不可用，原片过大无法在浏览器软解");
      updateVideoStatus(root, video, "播放中断，点击画面重新加载");
      root.dataset.videoDeadEnd = "1";
      return;
    }
    try { await startWasmVideoFallback(root, video, context.direct); }
    catch (error) { updateVideoStatus(root, video, "播放异常，请重试或更换片源"); setMovieCompatStatus(root, `${error.message}；可重新打开或更换片源重试`); }
  }
}
function movieMimeForExt(ext) {
  if (ext === "mp4" || ext === "m4v") return "video/mp4";
  if (ext === "webm") return "video/webm";
  if (ext === "ogv" || ext === "ogg") return "video/ogg";
  if (ext === "mov") return "video/quicktime";
  return "";
}
function movieExtensionNeedsCompat(path) {
  const ext = fileExt(path);
  return ["mkv","avi","rmvb","rm","wmv","flv","ts","m2ts","mts","vob","iso"].includes(ext);
}
function browserSaysVideoContainerUnsupported(path) {
  const mime = movieMimeForExt(fileExt(path));
  if (!mime) return true;
  const video = document.createElement("video");
  return !video.canPlayType(mime);
}
function setMovieCompatStatus(root, text) {
  /* v0.9.90：转码 / 限档提示不再压在画面上，改为「获取信息」面板里的独立一行
     （客户要求：放到播放器的获取信息栏目中查看）。保留 .movie-compat-status 类名，
     既有样式与回归测试仍可定位该节点。 */
  const el = root?.querySelector("[data-video-compat]") || root?.querySelector(".movie-compat-status");
  if (el) {
    el.textContent = text || "";
    el.classList.toggle("show", !!text);
  }
  /* 面板收起时也能看出「有转码提示」：信息按钮加一个小圆点。 */
  const btn = root?.querySelector(".video-info-button");
  if (btn) btn.classList.toggle("has-note", !!text);
}
function formatMediaTime(value) {
  if (!Number.isFinite(value)) return "--:--";
  const sec=Math.max(0,Math.floor(value)), m=Math.floor(sec/60), s=sec%60;
  return `${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
}
function formatVideoMetadata(info) {
  if (!info) return "媒体元数据待识别";
  const parts=[info.container || info.format_name, info.video_codec && `视频 ${info.video_codec}`, info.audio_codec && `音频 ${info.audio_codec}`, info.width && info.height && `${info.width}×${info.height}`, info.bit_rate && `${Math.round(Number(info.bit_rate)/1000)} kbps`];
  return parts.filter(Boolean).join(" · ") || "媒体元数据待识别";
}
function updateVideoStatus(root, video, state) {
  const main=root?.querySelector("[data-video-status]"); const detail=root?.querySelector("[data-video-detail]");
  if (!main || !detail || !video) return;
  main.textContent=state;
  /* v0.9.51：信息面板也不再显示「引擎」字段，只保留分辨率与媒体元数据。 */
  const size=video.videoWidth ? `${video.videoWidth}×${video.videoHeight}` : "分辨率待获取";
  detail.textContent=`${formatMediaTime(video.currentTime)} / ${formatMediaTime(video.duration)} · ${size} · ${root.dataset.videoMetadata || "媒体元数据待识别"}`;
}
function toggleVideoStatusPanel(button) {
  const root = button?.closest(".media-video-body");
  const panel = root?.querySelector(".video-status-panel");
  if (!panel) return;
  const open = panel.classList.toggle("show");
  button.setAttribute("aria-expanded", String(open));
}
/* ================= v0.9.51 视频播放器悬浮控制栏 =================
   触发规则：播放中滑动鼠标（pointermove）唤出控制栏，3 秒内没有任何操作重新隐藏。
   暂停、控制栏内悬停、任一浮层（更多/设置/播放列表/声音）打开时都不隐藏，
   否则用户刚点开设置就被收走。手动折叠（左上 ⌄）是显式意图，鼠标移动不再唤出，
   只能点左下角的 ⌃ 恢复。 */
const VIDEO_CHROME_HIDE_MS = 3000;
function videoChromeCollapsed(root) { return root?.dataset.videoChromeCollapsed === "true"; }
function videoChromeLocked(root) {
  if (!root) return false;
  if (root.querySelector("video")?.paused) return true;
  if (root.querySelector("[data-video-panel].show")) return true;
  if (root.querySelector(".video-status-panel.show")) return true;
  return root.dataset.videoChromeHover === "true";
}
function hideVideoChrome(root) {
  if (!root) return;
  root.classList.remove("video-controls-visible");
  root.dataset.videoControlsVisible = "false";
  closeVideoPanels(root);
  const panel = root.querySelector(".video-status-panel");
  const button = root.querySelector(".video-info-button");
  panel?.classList.remove("show");
  button?.setAttribute("aria-expanded", "false");
}
function scheduleVideoChromeHide(root) {
  if (!root) return;
  clearTimeout(root.__videoChromeTimer);
  if (videoChromeCollapsed(root)) return;
  root.classList.add("video-controls-visible");
  root.dataset.videoControlsVisible = "true";
  root.__videoChromeTimer = setTimeout(() => {
    if (!videoChromeLocked(root)) hideVideoChrome(root);
    else scheduleVideoChromeHide(root);
  }, VIDEO_CHROME_HIDE_MS);
}
function videoRootOf(el) { return el?.closest(".media-video-body") || null; }
function videoElementOf(el) { return videoRootOf(el)?.querySelector("video[data-movie-player]") || null; }
/* v0.9.66 左上角 ⌄：播放器停靠到控制器最下面一排，控制器持续显示，
   视频画面缩到控制器左下角；⌃ 恢复完整播放器。 */
function minimizeVideoPlayer(el) {
  const root = videoRootOf(el);
  if (!root) return;
  /* v0.9.51：全屏状态下点最小化会同时处于「浏览器全屏 + 小窗」两种布局，
     小窗被全屏容器约束会错位。先退出全屏再缩成小窗。 */
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  const overlay = root.closest(".media-reader-overlay.movie-player");
  if (overlay) overlay.classList.add("video-minimized", "video-controller-docked");
  clearTimeout(root.__videoChromeTimer);
  root.dataset.videoChromeCollapsed = "false";
  root.classList.add("video-controls-visible");
  root.dataset.videoControlsVisible = "true";
  closeVideoPanels(root);
  root.querySelector(".video-chrome")?.classList.add("video-chrome-minimized");
}
function expandVideoPlayer(el) {
  const root = videoRootOf(el);
  if (!root) return;
  const overlay = root.closest(".media-reader-overlay.movie-player");
  if (overlay) overlay.classList.remove("video-minimized", "video-controller-docked");
  root.querySelector(".video-chrome")?.classList.remove("video-chrome-minimized");
  root.dataset.videoChromeCollapsed = "false";
  scheduleVideoChromeHide(root);
}
/* 右上角全屏：优先整块播放区全屏（控制栏一起进全屏），浏览器拒绝时回落到 video 元素。 */
async function toggleVideoFullscreen(el) {
  const root = videoRootOf(el);
  if (!root) return;
  const button = root.querySelector(".vc-fullscreen");
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else if (root.requestFullscreen) await root.requestFullscreen();
    else if (root.querySelector("video")?.webkitEnterFullscreen) root.querySelector("video").webkitEnterFullscreen();
  } catch (e) {
    try { await root.querySelector("video")?.requestFullscreen?.(); } catch (err) { toast("⚠️ " + t("vpFsDenied")); }
  }
  const active = !!document.fullscreenElement;
  button?.setAttribute("aria-pressed", String(active));
  if (button) { button.innerHTML = videoIcon(active ? "fullscreenExit" : "fullscreen"); button.title = active ? t("vpFullscreenExit") : t("vpFullscreen"); }
  scheduleVideoChromeHide(root);
}
function videoTogglePlay(el) {
  const video = videoElementOf(el);
  if (!video) return;
  if (video.paused) { claimExclusivePlayback("video", video); video.play().catch(() => {}); } else video.pause();
  syncVideoChromeState(videoRootOf(el), video);
  scheduleVideoChromeHide(videoRootOf(el));
}
function videoSkip(el, seconds) {
  const video = videoElementOf(el);
  if (!video || !Number.isFinite(video.currentTime)) return;
  const limit = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : Infinity;
  video.currentTime = Math.max(0, Math.min(limit, video.currentTime + Number(seconds || 0)));
  saveVideoPlaybackState(video);
  updateVideoTimeline(video);
  scheduleVideoChromeHide(videoRootOf(el));
}
function closeVideoPlayer(el) {
  const root = videoRootOf(el);
  const group = root?.dataset.mediaGroup || "movie";
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  closeLocalViewer(group);
}
/* ---------- 浮层（更多 / 设置 / 播放列表 / 声音）---------- */
function closeVideoPanels(root, keep) {
  root?.querySelectorAll("[data-video-panel]").forEach(panel => {
    if (panel.dataset.videoPanel === keep) return;
    panel.classList.remove("show");
  });
  root?.querySelectorAll("[data-video-panel-button]").forEach(button => {
    if (button.dataset.videoPanelButton === keep) return;
    button.setAttribute("aria-expanded", "false");
  });
}
function toggleVideoPanel(el, name) {
  const root = videoRootOf(el);
  const panel = root?.querySelector(`[data-video-panel="${name}"]`);
  if (!panel) return;
  const open = !panel.classList.contains("show");
  closeVideoPanels(root, open ? name : undefined);
  panel.classList.toggle("show", open);
  el?.setAttribute("aria-expanded", String(open));
  if (open && name === "playlist") renderVideoPlaylist(root);
  scheduleVideoChromeHide(root);
}
/* 旧入口保留：字幕/音轨菜单现在就是设置浮层。 */
function toggleVideoTrackMenu(button) { toggleVideoPanel(button, "settings"); }
/* ---------- 重复 / 随机 ---------- */
const VIDEO_REPEAT_ORDER = ["off", "one", "all"];
function videoRepeatLabel(mode) { return t(mode === "one" ? "vpRepeatOne" : mode === "all" ? "vpRepeatAll" : "vpRepeatOff"); }
const VIDEO_REPEAT_ICON = { off: "🔁", one: "🔂", all: "🔁" };
function videoRepeatMode(root) { return VIDEO_REPEAT_ORDER.includes(root?.dataset.videoRepeat) ? root.dataset.videoRepeat : "off"; }
function cycleVideoRepeat(el) {
  const root = videoRootOf(el);
  if (!root) return;
  const next = VIDEO_REPEAT_ORDER[(VIDEO_REPEAT_ORDER.indexOf(videoRepeatMode(root)) + 1) % VIDEO_REPEAT_ORDER.length];
  root.dataset.videoRepeat = next;
  const video = root.querySelector("video");
  if (video) video.loop = next === "one";
  const button = root.querySelector("[data-video-repeat-button]");
  if (button) {
    button.innerHTML = videoIcon(next === "one" ? "repeatOne" : "repeat");
    button.title = `${t("vpRepeat")}：${videoRepeatLabel(next)}`;
    button.classList.toggle("on", next !== "off");
  }
  toast(`🔁 ${videoRepeatLabel(next)}`);
  scheduleVideoChromeHide(root);
}
function videoShuffleOn(root) { return root?.dataset.videoShuffle === "on"; }
function toggleVideoShuffle(el) {
  const root = videoRootOf(el);
  if (!root) return;
  const next = videoShuffleOn(root) ? "off" : "on";
  root.dataset.videoShuffle = next;
  const button = root.querySelector("[data-video-shuffle-button]");
  if (button) { button.title = `${t("vpShuffle")}：${t(next === "on" ? "vpShuffleOn" : "vpShuffleOff")}`; button.classList.toggle("on", next === "on"); }
  toast(`🔀 ${t(next === "on" ? "vpShuffleOn" : "vpShuffleOff")}`);
  scheduleVideoChromeHide(root);
}
/* ---------- 声音 ---------- */
function setVideoVolume(el, value) {
  const root = videoRootOf(el);
  const video = root?.querySelector("video");
  if (!video) return;
  const level = Math.max(0, Math.min(100, Number(value) || 0));
  video.volume = level / 100;
  video.muted = level === 0;
  syncVideoVolumeUI(root, video);
  scheduleVideoChromeHide(root);
}
/* v0.9.51：右下角静音按钮已删除 —— 音量滑条移入设置浮层，滑到 0 即静音，
   不再提供单独的一键静音按钮。 */
function syncVideoVolumeUI(root, video) {
  if (!root || !video) return;
  const level = video.muted ? 0 : Math.round((video.volume || 0) * 100);
  const range = root.querySelector("[data-video-volume]");
  const label = root.querySelector("[data-video-volume-label]");
  if (range && document.activeElement !== range) range.value = String(level);
  if (label) label.textContent = `${level}%`;
}
/* ---------- 转码质量 ---------- */
function setVideoQuality(el, quality) {
  const root = videoRootOf(el);
  if (!root) return;
  root.dataset.videoQuality = quality;
  root.querySelectorAll("[data-quality]").forEach(button => button.classList.toggle("active", button.dataset.quality === quality));
  const lib = findMediaLibrary(root.dataset.library);
  if (lib && root.dataset.path) applyVideoQuality(root, lib, root.dataset.path, quality);
  scheduleVideoChromeHide(root);
}
async function applyVideoQuality(root, lib, path, quality) {
  const video = root.querySelector("video[data-movie-player]");
  if (!video) return;
  const resume = Number.isFinite(video.currentTime) ? video.currentTime : 0;
  try {
    const plan = await requestPlaybackPlan(lib, path, quality);
    root.dataset.videoMetadata = formatVideoMetadata(plan.media);
    root.dataset.playbackMode = plan.mode || "auto";
    setMovieCompatStatus(root, `${playbackModeLabel(plan)} · ${plan.reason || "智能选择"}`);
    /* v0.9.92：画质切换同样要标注解码路径，并在服务端转码被禁用时如实提示限制未生效。 */
    setVideoDecodePath(root, videoDecodePathText(plan));
    markQualityCapInactive(root, quality);
    if (plan.warn) toast("⚠️ " + plan.warn);
    const sessionID = await createVideoPlaybackSession(root, lib, path, plan.mode);
    const url = plan.url && sessionID && plan.mode !== "direct" ? `${plan.url}&task=${encodeURIComponent(sessionID)}` : (plan.url || mediaCompatUrl(lib, path));
    setVideoEngine(root, plan.mode === "direct" ? VIDEO_ENGINE_NATIVE : VIDEO_ENGINE_COMPAT, `${playbackModeLabel(plan)} · ${plan.reason || "画质切换"}`);
    switchMovieSource(video, url);
    /* 切流后必须自己回填进度：switchMovieSource 只在旧 currentTime > 2 时恢复，
       而这里的 URL 变化会重置 currentTime，所以显式带上 resume。 */
    video.addEventListener("loadedmetadata", () => { if (resume > 2) video.currentTime = Math.min(resume, video.duration || resume); }, { once: true });
  } catch (error) { toast("⚠️ " + t("vpQualityFail") + "：" + error.message); }
}
/* ---------- 播放列表 ---------- */
let videoPlaylist = [];
function setVideoPlaylist(libId, files) {
  videoPlaylist = (files || []).map(file => ({ libId: String(libId), path: String(file.path || file) })).filter(item => item.path);
}
function videoPlaylistIndex(libId, path) { return videoPlaylist.findIndex(item => item.libId === String(libId) && item.path === String(path)); }
function videoPlaylistLabel(item) {
  const parsed = parseSeriesEpisode(item.path);
  const meta = movieMetadataFor(item.path);
  const lib = findMediaLibrary(item.libId);
  if (lib?.type === "series") return `${parsed.label} · ${meta.title || parsed.title}`;
  return meta.title || displayBookTitle(item.path);
}
function renderVideoPlaylist(root) {
  const host = root?.querySelector("[data-video-playlist]");
  if (!host) return;
  if (!videoPlaylist.length) { host.innerHTML = `<div class="empty-tip">${esc(t("vpPlaylistEmpty"))}</div>`; return; }
  const current = videoPlaylistIndex(root.dataset.library, root.dataset.path);
  host.innerHTML = videoPlaylist.map((item, index) => `<button type="button" class="${index === current ? "active" : ""}" onclick="playVideoFromPlaylist(${index})">${esc(String(index + 1).padStart(2, "0"))} · ${esc(videoPlaylistLabel(item))}</button>`).join("");
}
function playVideoFromPlaylist(index) {
  const item = videoPlaylist[index];
  if (!item) return;
  openLocalMedia("movie", item.libId, item.path);
}
function videoPlayNeighbour(el, step) {
  const root = videoRootOf(el);
  if (!root) return;
  if (!videoPlaylist.length) { toast("⚠️ " + t("vpPlaylistNone")); return; }
  const current = videoPlaylistIndex(root.dataset.library, root.dataset.path);
  let next;
  if (videoShuffleOn(root) && videoPlaylist.length > 1) {
    do { next = Math.floor(Math.random() * videoPlaylist.length); } while (next === current);
  } else {
    next = current < 0 ? 0 : current + Number(step || 1);
    if (next < 0 || next >= videoPlaylist.length) {
      if (videoRepeatMode(root) !== "all") { toast("⚠️ " + t(next < 0 ? "vpFirstItem" : "vpLastItem")); return; }
      next = (next + videoPlaylist.length) % videoPlaylist.length;
    }
  }
  playVideoFromPlaylist(next);
}
function videoPlaybackEnded(root, video) {
  if (!root) return;
  const mode = videoRepeatMode(root);
  if (mode === "one") { video.currentTime = 0; video.play().catch(() => {}); return; }
  if (mode === "all" || videoShuffleOn(root)) { videoPlayNeighbour(root, 1); return; }
  /* v0.9.51：只有电视剧集类型播放才自动连播下一集 —— 单部电影播完停在结尾，
     不再自动跳到库里下一部（电影模式也不展示播放列表按钮）。 */
  if (root.dataset.videoPlaylistEligible !== "true") return;
  const current = videoPlaylistIndex(root.dataset.library, root.dataset.path);
  if (current >= 0 && current + 1 < videoPlaylist.length) videoPlayNeighbour(root, 1);
}
/* ---------- 左下角标题：剧集显示集数 + 分集标题，电影显示年份 ---------- */
function videoChromeTitle(lib, path) {
  const meta = movieMetadataFor(path);
  const parsed = parseSeriesEpisode(path);
  /* 剧集判定不能只看库类型：电影库里混放的 S01E02 也应显示集数。
     分集标题优先用 NFO/TMDB 的 title（show_title 存在说明这是分集条目），
     否则回落文件名解析出的标题，最后兜底「第 N 集」。 */
  const isEpisode = lib?.type === "series" || (!!parsed.episode && /[sS]\d{1,2}[eE]\d{1,3}|\d{1,2}x\d{1,3}|第\s*\d+\s*集/.test(String(path)));
  if (isEpisode) {
    const episodeTitle = (meta.show_title ? meta.title : "") || parsed.title || `第 ${parsed.episode || "?"} 集`;
    return { main: `${meta.show_title || parsed.show} · ${parsed.label}`, sub: episodeTitle };
  }
  return { main: meta.title || displayBookTitle(path), sub: meta.year ? `(${meta.year})` : "" };
}
function applyVideoChromeTitle(root, lib, path) {
  const info = videoChromeTitle(lib, path);
  const title = root?.querySelector("[data-video-title]");
  const sub = root?.querySelector("[data-video-meta-line]");
  if (title) { title.textContent = info.main; title.title = String(path); }
  if (sub) sub.textContent = info.sub;
}
function syncVideoChromeState(root, video) {
  if (!root || !video) return;
  const button = root.querySelector("[data-video-play]");
  if (button) { button.innerHTML = videoPlayPauseIcon(video.paused); button.title = video.paused ? t("vpPlay") : t("vpPause"); }
  syncVideoVolumeUI(root, video);
}
function openVideoDetailsFromPlayer(el) {
  const root = videoRootOf(el);
  if (!root?.dataset.library || !root.dataset.path) return;
  const libId = root.dataset.library, path = root.dataset.path;
  closeLocalViewer(root.dataset.mediaGroup || "movie");
  openMovieDetails(libId, path);
}
async function copyVideoPlaybackInfo(el) {
  const root = videoRootOf(el);
  const video = root?.querySelector("video");
  if (!root || !video) return;
  const text = [
    `文件：${root.dataset.path || ""}`,
    `媒体库：${findMediaLibrary(root.dataset.library)?.name || root.dataset.library || ""}`,
    `播放模式：${root.dataset.playbackMode || "auto"}`,
    `画质选择：${root.dataset.videoQuality || "auto"}`,
    `解码信息：${root.dataset.videoMetadata || "媒体元数据待识别"}`,
    `分辨率：${video.videoWidth ? `${video.videoWidth}×${video.videoHeight}` : "待获取"}`,
    `进度：${formatMediaTime(video.currentTime)} / ${formatMediaTime(video.duration)}`,
  ].join("\n");
  try { await navigator.clipboard.writeText(text); toast("✅ " + t("vpDiagOk")); }
  catch (e) { toast("⚠️ " + t("vpDiagFail")); }
}
async function createVideoPlaybackSession(root, lib, path, mode) {
  try {
    const response = await fetch('/api/media/playback/sessions', { method:'POST', credentials:'same-origin', headers:{'Content-Type':'application/json'}, body:JSON.stringify({library_id:String(lib.id),path:String(path),mode:String(mode||'auto')}) });
    if (!response.ok) return '';
    const session = await response.json(); root.dataset.playbackSession = session.id || ''; return root.dataset.playbackSession;
  } catch(e) { return ''; }
}
function reportVideoPlaybackSession(root, video, state) {
  const id=root?.dataset.playbackSession; if(!id)return;
  fetch(`/api/media/playback/sessions/${encodeURIComponent(id)}/progress`,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({position_ms:Math.round((video.currentTime||0)*1000),duration_ms:Math.round((video.duration||0)*1000),state:state||(!video.paused?'playing':'paused')}),keepalive:true}).catch(()=>{});
}
function stopVideoPlaybackSession(root) {
  mediaKeepAliveStop("video");
  const id=root?.dataset.playbackSession; if(!id)return;
  fetch(`/api/media/playback/sessions/${encodeURIComponent(id)}/stop`,{method:'POST',credentials:'same-origin',keepalive:true}).catch(()=>{}); root.dataset.playbackSession='';
}
function bindVideoStatus(root, video) {
  [["loadstart","正在连接"],["waiting","正在缓冲"],["playing","正在播放"],["pause","已暂停"],["ended","播放完成"],["stalled","网络等待"],["error","播放错误"]].forEach(([ev,label])=>video.addEventListener(ev,()=>{updateVideoStatus(root,video,label);if(['pause','ended'].includes(ev))reportVideoPlaybackSession(root,video,ev);}));
  /* v0.9.61：视频实际开始播放时启用会话保活；暂停仍保留播放上下文，只有结束、
     报错或关闭播放器才停止。具名 source 让切流时重复 play 保持幂等。 */
  video.addEventListener("playing", () => mediaKeepAliveStart("video"));
  video.addEventListener("ended", () => mediaKeepAliveStop("video"));
  video.addEventListener("error", () => mediaKeepAliveStop("video"));
  video.addEventListener("timeupdate",()=>{ updateVideoStatus(root,video,video.paused?"已暂停":"正在播放"); updateVideoTimeline(video); saveVideoPlaybackState(video); if(!root.__sessionReportAt||Date.now()-root.__sessionReportAt>10000){root.__sessionReportAt=Date.now();reportVideoPlaybackSession(root,video);} });
  ["progress","loadedmetadata","durationchange","canplay"].forEach(ev=>video.addEventListener(ev,()=>{ updateVideoTimeline(video); if(ev==='loadedmetadata')restoreVideoPlaybackState(video); }));
  video.addEventListener('keydown',e=>handleVideoKeyboard(e,video));
  video.tabIndex=0;
  /* v0.9.51：滑动鼠标触发识别。pointermove 是唯一的「滑动」信号，click/mouseenter
     一并唤出；控制栏自身 hover 时打标记，避免 3 秒到点把鼠标下的按钮收走。 */
  ["pointermove","mouseenter","click","touchstart"].forEach(ev => root.addEventListener(ev, () => scheduleVideoChromeHide(root), { passive:true }));
  /* hover 锁只绑在真正的顶部/底部条上：控制层是全屏铺满的，绑在它上面会让
     「鼠标停在画面中央」也被当成停在控制栏上，3 秒定时器永远不触发隐藏。 */
  root.querySelectorAll(".vc-top,.vc-bottom,[data-video-panel]").forEach(bar => {
    bar.addEventListener("pointerenter", () => { root.dataset.videoChromeHover = "true"; }, { passive:true });
    bar.addEventListener("pointerleave", () => { root.dataset.videoChromeHover = "false"; scheduleVideoChromeHide(root); }, { passive:true });
  });
  /* 暂停时控制栏常驻（videoChromeLocked 保证不会被定时器收走）。 */
  video.addEventListener("pause", () => { syncVideoChromeState(root, video); markVideoActivePlayback(root, video); if (typeof setActivePlaybackPaused === "function") setActivePlaybackPaused(true); if (!videoChromeCollapsed(root)) { root.classList.add("video-controls-visible"); root.dataset.videoControlsVisible = "true"; } });
  video.addEventListener("play", () => { claimExclusivePlayback("video", video); syncVideoChromeState(root, video); scheduleVideoChromeHide(root); markVideoActivePlayback(root, video); });
  video.addEventListener("volumechange", () => syncVideoVolumeUI(root, video));
  video.addEventListener("ended", () => { videoPlaybackEnded(root, video); if (typeof clearActivePlayback === "function") clearActivePlayback("video"); });
  video.addEventListener("loadedmetadata", () => syncVideoChromeState(root, video));
  /* 点画面切换播放/暂停，与主流播放器一致；控制栏内的点击不冒泡到这里。 */
  video.addEventListener("click", () => { if (video.paused) video.play().catch(()=>{}); else video.pause(); });
  /* 只拦控制条与浮层内的点击；画面本身的点击必须落到 video 上。 */
  root.querySelectorAll(".vc-top,.vc-bottom,[data-video-panel],.vc-restore").forEach(el => el.addEventListener("click", event => event.stopPropagation()));
  document.addEventListener("fullscreenchange", () => {
    const button = root.querySelector(".vc-fullscreen");
    const active = document.fullscreenElement === root || root.contains(document.fullscreenElement);
    button?.setAttribute("aria-pressed", String(active));
    if (button) button.title = active ? t("vpFullscreenExit") : t("vpFullscreen");
  });
  syncVideoChromeState(root, video);
}
function formatVideoTime(value) { return formatMediaTime(value); }
function videoPlaybackKey(lib, path) { return `vaulthub_video_${lib.id}_${path}`; }
function saveVideoPlaybackState(video) {
  const root=video?.closest('.media-video-body'); const libId=root?.dataset.library, mediaPath=root?.dataset.path;
  if (!root || !libId || !mediaPath || !Number.isFinite(video.currentTime)) return;
  try { localStorage.setItem(`vaulthub_video_${libId}_${mediaPath}`, JSON.stringify({time:video.currentTime, updatedAt:Date.now()})); } catch(e) {}
}
function restoreVideoPlaybackState(video) {
  const root=video?.closest('.media-video-body'); if(!root) return;
  try { const saved=JSON.parse(localStorage.getItem(`vaulthub_video_${root.dataset.library}_${root.dataset.path}`)||'null'); if(saved && Number.isFinite(saved.time) && saved.time>2 && saved.time<video.duration-2) video.currentTime=saved.time; } catch(e) {}
}
function updateVideoTimeline(video) {
  const root=video?.closest('.media-video-body'); if(!root) return;
  const duration=Number.isFinite(video.duration)&&video.duration>0?video.duration:0;
  const played=duration?video.currentTime/duration*100:0;
  const buffered=duration&&video.buffered?.length?video.buffered.end(video.buffered.length-1)/duration*100:0;
  const p=root.querySelector('.video-played-range'), b=root.querySelector('.video-buffered-range'), label=root.querySelector('.video-time-label');
  if(p)p.style.width=`${Math.min(100,played)}%`; if(b)b.style.width=`${Math.min(100,buffered)}%`;
  /* v0.9.51：进度点跟着已播比例走，让用户看得出可以拖动。 */
  const knob=root.querySelector('.video-progress-knob');
  if(knob)knob.style.left=`${Math.min(100,Math.max(0,played))}%`;
  const shell=root.querySelector('.video-progress-shell');
  if(shell)shell.setAttribute('aria-valuenow',String(Math.round(Math.min(100,Math.max(0,played)))));
  /* v0.9.51：左下角只显示「当前时间 / 视频时长」，缓冲量移到「获取信息」面板。 */
  if(label)label.textContent=`${formatVideoTime(video.currentTime)} / ${formatVideoTime(video.duration)}`;
}
/* v0.9.51：进度条支持点击定位与按住拖动；键盘左右键也能移动，便于无鼠标操作。 */
function videoSeekRatio(event, shell) { const r=shell.getBoundingClientRect(); if(!(r.width>0))return 0; return Math.max(0,Math.min(1,(event.clientX-r.left)/r.width)); }
function seekVideoTimeline(event, shell) {
  const root=shell.closest('.media-video-body');
  const video=root?.querySelector('video');
  if(!video||!Number.isFinite(video.duration)||video.duration<=0)return;
  video.currentTime=videoSeekRatio(event,shell)*video.duration;
  saveVideoPlaybackState(video);
  updateVideoTimeline(video);
  scheduleVideoChromeHide(root);
}
function bindVideoTimelineDrag(root) {
  const shell=root?.querySelector('.video-progress-shell');
  const video=root?.querySelector('video');
  if(!shell||!video)return;
  let dragging=false;
  const apply=event=>{ if(!Number.isFinite(video.duration)||video.duration<=0)return; video.currentTime=videoSeekRatio(event,shell)*video.duration; updateVideoTimeline(video); };
  shell.addEventListener('pointerdown',event=>{ dragging=true; shell.setPointerCapture?.(event.pointerId); apply(event); });
  shell.addEventListener('pointermove',event=>{ if(dragging)apply(event); });
  const finish=()=>{ if(!dragging)return; dragging=false; saveVideoPlaybackState(video); scheduleVideoChromeHide(root); };
  shell.addEventListener('pointerup',finish);
  shell.addEventListener('pointercancel',finish);
  shell.addEventListener('keydown',event=>{
    if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
    event.preventDefault();
    const limit=Number.isFinite(video.duration)&&video.duration>0?video.duration:0;
    if(!limit)return;
    if(event.key==='Home')video.currentTime=0;
    else if(event.key==='End')video.currentTime=Math.max(0,limit-1);
    else video.currentTime=Math.max(0,Math.min(limit,video.currentTime+(event.key==='ArrowRight'?5:-5)));
    saveVideoPlaybackState(video);
    updateVideoTimeline(video);
  });
}
function handleVideoKeyboard(event, video) {
  if(!video || event.target.matches('input,textarea,select,button')) return;
  if(event.repeat) return;
  if(['ArrowLeft','ArrowRight',' ','k','K'].includes(event.key)) { event.preventDefault(); if(event.key==='ArrowLeft')video.currentTime=Math.max(0,video.currentTime-10); else if(event.key==='ArrowRight')video.currentTime=Math.min(video.duration||Infinity,video.currentTime+10); else video.paused?video.play().catch(()=>{}):video.pause(); saveVideoPlaybackState(video); }
}
function selectVideoAudioTrack(video, index) { const root=video.closest('.media-video-body'); const lib={id:root.dataset.library}; const path=root.dataset.path; const url=mediaCompatUrl(lib,path)+`&audio_track=${encodeURIComponent(index)}`; const time=video.currentTime; const paused=video.paused; video.src=url; video.dataset.currentSrc=url; video.load(); video.addEventListener('loadedmetadata',()=>{video.currentTime=Math.min(time,video.duration||time); if(!paused)video.play().catch(()=>{});},{once:true}); }
function attachVideoSubtitle(video, url, label) { let track=[...video.textTracks].find(t=>t.label===label); if(track)track.mode='showing'; else { const el=document.createElement('track'); el.kind='subtitles'; el.label=label||'外挂字幕'; el.srclang='und'; el.src=url; el.default=true; video.appendChild(el); } [...video.textTracks].forEach(t=>{t.mode=t.label===label?'showing':'disabled';}); }
async function searchVideoSubtitles(button) { const root=button.closest('.media-video-body'); const box=root.querySelector('[data-video-subtitle-options]'); box.textContent='搜索中...'; try { const res=await fetch(`/api/media/subtitles/search?id=${encodeURIComponent(root.dataset.library)}&path=${encodeURIComponent(root.dataset.path)}`,{cache:'no-store'}); const data=await res.json(); box.innerHTML=(data.items||[]).map((x,i)=>`<button type="button" onclick="attachVideoSubtitle(this.closest('.media-video-body').querySelector('video'), '${esc(x.url)}', '${esc(x.label||`字幕 ${i+1}`)}')">${esc(x.label||`字幕 ${i+1}`)}</button>`).join('')||'没有找到字幕'; } catch(e) { box.textContent='字幕搜索失败'; } }
function populateVideoTracks(root, video, info) {
  const audio = root.querySelector('[data-video-audio-options]');
  const tracks = info?.audio_tracks || [];
  if (audio) audio.innerHTML = (tracks.length ? tracks : [{ index: 0, label: '默认音源' }]).map((x, i) => `<button type="button" class="${i === 0 ? 'active' : ''}" onclick="selectVideoAudioTrack(this.closest('.media-video-body').querySelector('video'),${Number(x.index ?? i)})">${esc(x.label || `音源 ${i + 1}`)}</button>`).join('');
  // Embedded (in-container) text subtitle tracks extracted to WebVTT.
  const subBox = root.querySelector('[data-video-subtitle-options]');
  const subs = info?.subtitle_tracks || [];
  if (subBox && subs.length) {
    subBox.innerHTML = subs.map((s, i) => `<button type="button" onclick="attachVideoSubtitle(this.closest('.media-video-body').querySelector('video'), '${esc(s.url)}', '${esc(s.label || `内嵌字幕 ${i + 1}`)}')">${esc(s.label || `内嵌字幕 ${i + 1}`)}</button>`).join('');
  }
}
function switchMovieSource(video, url, { autoplay = true } = {}) {
  if (!video || video.dataset.currentSrc === url) return;
  claimExclusivePlayback("video", video);
  const first = !video.dataset.currentSrc;
  const wasPaused = video.paused;
  const time = Number.isFinite(video.currentTime) ? video.currentTime : 0;
  video.dataset.currentSrc = url;
  video.src = url;
  video.load();
  video.addEventListener('loadedmetadata',()=>{ if(time>2 && time<video.duration-2) video.currentTime=time; if(!wasPaused||first&&autoplay) video.play().catch(()=>{}); },{once:true});
  video.muted = false;
  video.volume = 1;
  /* v0.9.51：初次点击打开播放器后立即尝试自动播放。若被浏览器自动播放
     策略拦截（需要用户手势），状态提示用户点击画面开始播放。 */
  if (first && autoplay) {
    const root = video.closest('.media-video-body');
    video.play().then(() => { if (root) updateVideoStatus(root, video, "正在播放"); }).catch(() => { if (root) updateVideoStatus(root, video, "点击画面开始播放"); });
  }
}
async function initMovieCompatPlayer(root, lib, path) {
  const video = root?.querySelector("video[data-movie-player]");
  if (!video) return;
  const videoRoot = video.closest('.media-video-body');
  videoRoot.dataset.library=String(lib.id); videoRoot.dataset.path=String(path);
  /* v0.9.51：关闭播放要知道自己属于哪个媒体分组；标题/剧集信息与播放列表在这里绑定。 */
  videoRoot.dataset.mediaGroup="movie";
  /* v0.9.51：播放列表面板只在电视剧集类型播放时展示 —— 电影单文件播放隐藏按钮，
     避免把「电影库整批文件」当成一部电影的播放列表。判定与左下角标题一致：
     series 库，或任意库中按 SxxExx/第N集 命名的分集文件。 */
  const parsedEpisode = parseSeriesEpisode(path);
  const episodeContext = lib?.type === "series" || (!!parsedEpisode?.episode && /[sS]\d{1,2}[eE]\d{1,3}|\d{1,2}x\d{1,3}|第\s*\d+\s*集/.test(String(path)));
  videoRoot.dataset.videoPlaylistEligible = episodeContext ? "true" : "false";
  if (!episodeContext) {
    const libIndex = videoPlaylist.findIndex(item => item.libId === String(lib.id) && item.path === String(path));
    if (libIndex < 0) videoPlaylist = [];
  }
  applyVideoChromeTitle(videoRoot, lib, path);
  renderVideoPlaylist(videoRoot);
  bindVideoTimelineDrag(videoRoot);
  /* v0.9.62：播放视频时立即用当前已知的最佳海报作为背景虚化 */
  { const _initMeta = movieMetadataFor(path); const _heroArt = movieHeroArt(_initMeta); if (_heroArt.url) setPlaybackBg(_heroArt.url); }
  fetch(`/api/media/metadata?id=${encodeURIComponent(lib.id)}&path=${encodeURIComponent(path)}`,{cache:'no-store'}).then(r=>r.ok?r.json():null).then(meta=>{if(meta&&(meta.title||meta.year||meta.show_title)){const all=readMovieMetadata();all[path]={...movieMetadataFor(path),...meta};writeMovieMetadata(all);applyVideoChromeTitle(videoRoot,lib,path);}if(meta?.subtitles?.length){const box=videoRoot.querySelector('[data-video-subtitle-options]');if(box)box.innerHTML=meta.subtitles.map((s,i)=>`<button type="button" onclick="attachVideoSubtitle(this.closest('.media-video-body').querySelector('video'),${jsAttrArg(s.url)},${jsAttrArg(s.label||`本地字幕 ${i+1}`)})">${esc(s.label||`本地字幕 ${i+1}`)}</button>`).join('');}/* v0.9.62：API 元数据返回后，用更丰富的海报（fanart/backdrop）更新背景 */
if(meta){const _merged=movieMetadataFor(path);const _hero=movieHeroArt(_merged);if(_hero.url)setPlaybackBg(_hero.url);}}).catch(()=>{});
  const direct = mediaFileUrl(lib, path);
  const compat = mediaCompatUrl(lib, path);
  /* v0.9.51 修复：以前这里传的是外层 viewer，于是 .video-controls-visible
     被加到 viewer 上，而 CSS 选择器是 .media-video-body.video-controls-visible，
     永远不匹配 —— 这就是悬浮控制栏/进度条一直不出现的根因。 */
  bindVideoStatus(videoRoot, video);
  scheduleVideoChromeHide(videoRoot);
  const useDirect = (reason="原片直连") => { terminateWasmVideo(videoRoot); setVideoEngine(videoRoot, VIDEO_ENGINE_NATIVE, reason); switchMovieSource(video, direct); };
  /* v0.9.91 解/转码风向标：禁用服务端转/解码时，一切「切兼容流」的回退都必须拒绝 ——
     否则服务器还是会被拉去起 ffmpeg 转码，「禁用」形同虚设。这里如实告知用户。 */
  const useCompat = (reason, url=compat) => {
    if (serverTranscodeDisabled()) {
      const why = reason || "该片源需要服务端转码";
      videoRoot.dataset.videoDeadEnd = "1";
      setMovieCompatStatus(videoRoot, `已禁用服务端转/解码：${why}`);
      updateVideoStatus(videoRoot, video, "无法本机直接播放，请在设置里重新开启服务端转/解码");
      setVideoDecodePath(videoRoot, tf("vpDecodePath", { path: t("stCompassClient") }));
      toast("⚠️ " + t("stOff") + "：" + why);
      return;
    }
    terminateWasmVideo(videoRoot); setVideoEngine(videoRoot, VIDEO_ENGINE_COMPAT, reason || `Smart Stream · ${settings.hardwareAcceleration}`); switchMovieSource(video, url);
  };
  /* v0.9.51：设置浮层不再暴露「三层播放」手动引擎选择 —— 引擎自动判定与自动降级保留。 */
  video.addEventListener("loadedmetadata", () => { video.muted = false; video.volume = 1; restoreVideoPlaybackState(video); bindVideoDriftMonitor(videoRoot, video); fetch(`/api/media/streams?id=${encodeURIComponent(lib.id)}&path=${encodeURIComponent(path)}`,{cache:'no-store'}).then(r=>r.ok?r.json():null).then(info=>{populateVideoTracks(videoRoot,video,info);updateVideoStatus(videoRoot,video,video.paused?"已暂停":"正在播放");}).catch(()=>{}); });
  let engineFailurePending = false;
  const retryPlan = () => retryPlaybackPlanOnce(videoRoot, lib, path, direct, useCompat, useDirect);
  video.addEventListener("error", async () => {
    if (engineFailurePending || (video.dataset.currentSrc || "").startsWith("blob:")) return;
    engineFailurePending = true;
    try { await advanceVideoEngine(videoRoot, video, { direct, useCompat, retryPlan }); }
    finally { setTimeout(() => { engineFailurePending = false; }, 1000); }
  });
  /* v0.9.51：死局（转码/基础流全失败且原片过大）时点击画面重新发起一次完整
     播放计划；成功即继续播，失败恢复死局提示。 */
  video.addEventListener("click", () => {
    if (videoRoot.dataset.videoDeadEnd !== "1") return;
    delete videoRoot.dataset.videoDeadEnd;
    videoRoot.dataset.playbackRetried = "0";
    video.dataset.currentSrc = "";
    setMovieCompatStatus(videoRoot, "正在重新连接转码流…");
    updateVideoStatus(videoRoot, video, "正在重新连接…");
    retryPlan().then(ok => {
      if (!ok) { videoRoot.dataset.videoDeadEnd = "1"; updateVideoStatus(videoRoot, video, "自动恢复失败，请关闭后重新打开"); }
    }).catch(() => { videoRoot.dataset.videoDeadEnd = "1"; });
  });
  try {
    /* v0.9.51：画质选择（设置 → 转码质量）决定播放计划，默认仍是 auto。 */
    const plan = await requestPlaybackPlan(lib, path, videoRoot.dataset.videoQuality || "auto");
    videoRoot.dataset.videoMetadata = formatVideoMetadata(plan.media);
    videoRoot.dataset.playbackMode = plan.mode || "auto";
    setMovieCompatStatus(videoRoot, `${playbackModeLabel(plan)} · ${plan.reason || "智能选择"}`);
    /* v0.9.92：在「获取信息」面板里标注当前解码路径（服务端转码 / 本机设备解码）。 */
    setVideoDecodePath(videoRoot, videoDecodePathText(plan));
    markQualityCapInactive(videoRoot, videoRoot.dataset.videoQuality || "auto");
    if (plan.warn) toast("⚠️ " + plan.warn);
    const sessionID = await createVideoPlaybackSession(videoRoot, lib, path, plan.mode);
    const plannedURL = plan.url && sessionID && plan.mode !== "direct" ? `${plan.url}&task=${encodeURIComponent(sessionID)}` : (plan.url || compat);
    if (plan.mode === "direct") useDirect(`${playbackModeLabel(plan)} · ${plan.reason}`);
    else useCompat(`${playbackModeLabel(plan)} · ${plan.reason}`, plannedURL);
  } catch (error) {
    const extRule = movieExtensionNeedsCompat(path) || browserSaysVideoContainerUnsupported(path);
    /* v0.9.92：禁用服务端转码时不允许再按容器规则降级到兼容流 —— 直接原画直出并说明。 */
    if (serverTranscodeDisabled()) {
      useDirect(`禁用服务端转码，按原画直出：${error.message}`);
      createVideoPlaybackSession(videoRoot, lib, path, "direct");
      toast("⚠️ " + error.message);
      return;
    }
    if (extRule) useCompat(`播放计划不可用，按容器规则降级：${error.message}`); else useDirect(`播放计划不可用，尝试原画：${error.message}`);
    createVideoPlaybackSession(videoRoot, lib, path, extRule ? "full_transcode" : "direct");
  }
}
const TXT_CHUNK_BYTES = 1024 * 1024;
async function fetchCompleteTextFile(url) {
  const first = await fetch(url, { headers: { Range: `bytes=0-${TXT_CHUNK_BYTES - 1}` }, cache: "no-store" });
  if (!first.ok && first.status !== 206) throw new Error(`HTTP ${first.status}`);
  const firstBytes = new Uint8Array(await first.arrayBuffer());
  const range = first.headers.get("Content-Range") || "";
  const match = range.match(/\/([0-9]+)$/);
  const total = match ? Number(match[1]) : (first.status === 206 ? 0 : firstBytes.byteLength);
  if (!total || first.status !== 206 || firstBytes.byteLength >= total) return firstBytes;
  const chunks = [firstBytes];
  for (let offset = firstBytes.byteLength; offset < total; offset += TXT_CHUNK_BYTES) {
    const end = Math.min(total - 1, offset + TXT_CHUNK_BYTES - 1);
    const res = await fetch(url, { headers: { Range: `bytes=${offset}-${end}` }, cache: "no-store" });
    if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status}`);
    chunks.push(new Uint8Array(await res.arrayBuffer()));
  }
  const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}
/* v0.9.56 TXT 编码识别修复 —— 旧实现只有「UTF-8 严格解码失败就当 GB18030」两条路，
   于是 Windows 记事本存的 UTF-16（"Unicode" 选项）、繁体 Big5、日文 Shift-JIS 全被
   按 GB18030 解出乱码（实测 UTF-16 正文夹大量 U+0000，Big5 变成「材彻 代刚彻竊」）。
   现在按 BOM → UTF-16 零字节特征 → UTF-8 严格 → 多候选打分 的顺序判定。 */
const TEXT_DECODE_CANDIDATES = ["gb18030", "big5", "shift-jis", "euc-kr", "utf-16le", "utf-16be"];
/* 高频汉字表（简体 + 繁体）：给候选编码打分用 —— 编码猜错时解出的汉字多为生僻字，
   命中率会显著低于正确编码。 */
const TEXT_COMMON_CJK = new Set(
  ("的一是不了在人有我他这中大来上国个到说们为子和你地出道时年得就那要下以生会自着去之过家学对可她里后小么心多天而能好都然没日于起还发成事只作当想看文无开手十用主行方又如前所本见经头面公同三已老从动两长知民样第些现使部真才等次将女并平点几高" +
   "话说读写听问题体长为万医声图东语测试章节内容验证编码破折号僻字书名包含标点段落文本行列表页题目字数十百千万亿" +
   "话這來時們個過還後說國學會沒對開間問題經體長爲兩實現變頭萬醫聲書寫圖東語測試章節讀聽內容驗證編碼標點").split("")
);
function scoreDecodedText(text) {
  if (!text) return -Infinity;
  let score = 0, cjk = 0;
  const limit = Math.min(text.length, 4000);
  for (let i = 0; i < limit; i++) {
    const ch = text[i], code = text.charCodeAt(i);
    if (ch === "\uFFFD") { score -= 8; continue; }                       // 非法字节
    if (code < 32 && ch !== "\n" && ch !== "\r" && ch !== "\t") { score -= 8; continue; } // 控制字符/NUL
    if (code >= 0xFF61 && code <= 0xFF9F) { score -= 4; continue; }      // 半角片假名：GBK 文本被误判成 Shift-JIS 的典型产物
    if (code >= 0xE000 && code <= 0xF8FF) { score -= 4; continue; }      // 私用区
    if (code >= 0x4E00 && code <= 0x9FFF) { cjk++; score += TEXT_COMMON_CJK.has(ch) ? 4 : -1; continue; } // 汉字
    if (code >= 0x3040 && code <= 0x30FF) { score += 1; continue; }      // 平/片假名（日文正文合法）
    if (code >= 0xAC00 && code <= 0xD7A3) { score += 1; continue; }      // 韩文音节
    if (code >= 0x3000 && code <= 0x303F) { score += 2; continue; }      // 中文标点（、。《》——）
    if (code >= 0xFF01 && code <= 0xFF60) { score += 1; continue; }      // 全角 ASCII/标点
    if (code >= 32 && code < 127) { score += 1; continue; }              // ASCII 可打印
  }
  return score + (cjk ? 0 : -5);
}
function decodeWithEncoding(bytes, encoding) {
  try { return new TextDecoder(encoding).decode(bytes); } catch (e) { return ""; }
}
/* v0.9.56 边界补强：无 BOM 的纯 CJK UTF-16（无换行/ASCII 时零字节密度趋近 0）
   会漏过上面的零字节特征，若全部字节对又恰好构成合法 UTF-8 序列，还会被严格
   UTF-8 分支抢先解成乱码。这里用「奇偶字节位汉字高字节占比」探测 UTF-16 配对
   结构：UTF-16LE 的奇数位字节（两字节单元的高 8 位）绝大多数落在 0x4E–0x9F，
   偶数位（低 8 位）近似均匀分布；UTF-16BE 恰好相反。GB18030/Big5/Shift-JIS/
   EUC-KR/UTF-8 的字节分布与此特征相斥（高字节多 >0x9F 或 <0x4E），不会误报。 */
function probeUtf16Pairing(src) {
  const n = src.length & ~1;
  if (n < 32) return null;
  let odd = 0, even = 0, hiOdd = 0, hiEven = 0;
  for (let i = 0; i < n; i += 2) {
    const lo = src[i], hi = src[i + 1];
    odd++; even++;
    if (hi >= 0x4E && hi <= 0x9F) hiOdd++;
    if (lo >= 0x4E && lo <= 0x9F) hiEven++;
  }
  const rOdd = hiOdd / odd, rEven = hiEven / even;
  if (rOdd >= 0.8 && rEven <= 0.45) return "utf-16le";
  if (rEven >= 0.8 && rOdd <= 0.45) return "utf-16be";
  return null;
}
function decodeTextBytes(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  // 1) BOM 明示（TextDecoder 自动吃掉 BOM 字符）
  if (view.length >= 3 && view[0] === 0xEF && view[1] === 0xBB && view[2] === 0xBF) return decodeWithEncoding(view, "utf-8");
  if (view.length >= 2 && view[0] === 0xFF && view[1] === 0xFE) return decodeWithEncoding(view, "utf-16le");
  if (view.length >= 2 && view[0] === 0xFE && view[1] === 0xFF) return decodeWithEncoding(view, "utf-16be");
  // 2) 无 BOM 的 UTF-16：ASCII 主导的正文里每隔一字节就是 0x00
  const probe = Math.min(view.length, 4096);
  let zeroEven = 0, zeroOdd = 0;
  for (let i = 0; i < probe; i++) {
    if (view[i] !== 0) continue;
    if (i % 2 === 0) zeroEven++; else zeroOdd++;
  }
  if (probe >= 16 && (zeroEven + zeroOdd) / probe > 0.15) {
    return decodeWithEncoding(view, zeroOdd >= zeroEven ? "utf-16le" : "utf-16be");
  }
  // 3) 无 BOM 且零字节密度低：用奇偶位配对结构探测纯 CJK UTF-16。
  //    命中后与「严格 UTF-8 结果」和「打分流全部候选」全量择优 —— 既能救回
  //    合法 UTF-8 字节串伪装下的 UTF-16（严格分支会解出零散字符，得分偏低），
  //    也杜绝把真正的 GBK/Big5/UTF-8 文本误判成 UTF-16（那些解码的得分更高）。
  const pairing = probeUtf16Pairing(view);
  if (pairing) {
    const u16 = decodeWithEncoding(view, pairing);
    if (u16) {
      let best = u16, bestScore = scoreDecodedText(u16);
      for (const enc of TEXT_DECODE_CANDIDATES) {
        if (enc === pairing) continue;
        const t = decodeWithEncoding(view, enc);
        if (!t) continue;
        const s = scoreDecodedText(t);
        if (s > bestScore) { best = t; bestScore = s; }
      }
      try {
        const s8 = scoreDecodedText(new TextDecoder("utf-8", { fatal: true }).decode(view));
        if (s8 > bestScore) { best = new TextDecoder("utf-8", { fatal: true }).decode(view); bestScore = s8; }
      } catch (e) { /* 非法 UTF-8 */ }
      return best;
    }
  }
  // 4) 合法 UTF-8 优先（严格模式：非法字节序列直接抛错）
  try { return new TextDecoder("utf-8", { fatal: true }).decode(view); } catch (e) { /* 继续猜测 */ }
  // 5) 多候选打分：常用汉字/标点/ASCII 加分，替换符、控制字符、半角片假名扣分
  let best = "", bestScore = -Infinity;
  for (const encoding of TEXT_DECODE_CANDIDATES) {
    const text = decodeWithEncoding(view, encoding);
    if (!text) continue;
    const score = scoreDecodedText(text);
    if (score > bestScore) { best = text; bestScore = score; }
  }
  return best || new TextDecoder("gb18030").decode(view);
}

/* ================= v0.9.52 播放器内联 SVG 图标集 =================
   旧版用 Unicode 字形/emoji（冉 ⏮ 🔁 ⚙ …），各平台渲染差异大且不能按
   主题换肤。v0.9.51 起全部按钮图标改为 24 视口内联 SVG：描边型走
   currentColor（可随 Apple 皮肤换色），实心型自带 fill。
   v0.9.52：修复 SVG stroke-width 缺失导致的图标显示异常，
   统一添加 stroke-width=2 stroke-linecap=round stroke-linejoin=round。 */
const AUDIO_ICON_SVG = {
  prev: '<path d="M5.8 5.4v13.2" stroke="currentColor"/><path d="M18.6 6.3 10.4 12l8.2 5.7Z" fill="currentColor"/>',
  play: '<path d="M8.2 5.6v12.8a.9.9 0 0 0 1.37.77l10.2-6.4a.9.9 0 0 0 0-1.54L9.57 4.83A.9.9 0 0 0 8.2 5.6Z" fill="currentColor"/>',
  pause: '<rect x="6.6" y="5" width="4.1" height="14" rx="1.5" fill="currentColor"/><rect x="13.3" y="5" width="4.1" height="14" rx="1.5" fill="currentColor"/>',
  stop: '<rect x="6.6" y="6.6" width="10.8" height="10.8" rx="2" fill="currentColor"/>',
  next: '<path d="M18.2 5.4v13.2" stroke="currentColor"/><path d="M5.4 6.3l8.2 5.7-8.2 5.7Z" fill="currentColor"/>',
  repeat: '<path d="m17 2.4 4 4-4 4"/><path d="M21 6.4H8.5a4.5 4.5 0 0 0-4.5 4.5v.6"/><path d="m7 21.6-4-4 4-4"/><path d="M3 17.6h12.5a4.5 4.5 0 0 0 4.5-4.5v-.6"/>',
  repeatOne: '<path d="m17 2.4 4 4-4 4"/><path d="M21 6.4H8.5a4.5 4.5 0 0 0-4.5 4.5v.6"/><path d="m7 21.6-4-4 4-4"/><path d="M3 17.6h12.5a4.5 4.5 0 0 0 4.5-4.5v-.6"/><text x="12.05" y="16.6" font-size="5.6" font-weight="700" text-anchor="middle" fill="currentColor">1</text>',
  heart: '<path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>',
  heartFill: '<path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" fill="currentColor"/>',
  shuffle: '<path d="m16 3.2 4.8.1-.1 4.8"/><path d="M4.2 19.8 20.6 3.4"/><path d="m20.6 16.2.1 4.8-4.8-.1"/><path d="m14.8 14.8 5.8 5.8"/><path d="M4.2 4.2l5.6 5.6"/>',
  expand: '<path d="M4 9.6V4h5.6"/><path d="M20 9.6V4h-5.6"/><path d="M4 14.4V20h5.6"/><path d="M20 14.4V20h-5.6"/>',
  restore: '<path d="M9.6 4v5.6H4"/><path d="M14.4 4v5.6H20"/><path d="M9.6 20v-5.6H4"/><path d="M14.4 20v-5.6H20"/>',
  info: '<circle cx="12" cy="12" r="8.4"/><path d="M12 11.2v4.6"/><circle cx="12" cy="7.7" r="1.05" fill="currentColor"/>',
};
function audioIcon(name) {
  const body = AUDIO_ICON_SVG[name];
  if (!body) return "";
  return `<svg class="vc-svg audio-svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${body}</svg>`;
}

/* v0.9.51 播放器内联 SVG 图标集 —— 视频播放器专用。
   v0.9.52：添加 stroke-width=2 stroke-linecap=round stroke-linejoin=round
   修复各主题下图标显示为空/异常的问题。 */
const VIDEO_ICON_SVG = {
  collapse: '<path d="M12 3.2v10.6"/><path d="m7.6 9.6 4.4 4.2 4.4-4.2"/><path d="M4 20.6h16"/>',
  restore: '<path d="M12 20.8V10.2"/><path d="m7.6 14.4 4.4-4.2 4.4 4.2"/><path d="M4 3.4h16"/>',
  fullscreen: '<path d="M4 9.6V4h5.6"/><path d="M20 9.6V4h-5.6"/><path d="M4 14.4V20h5.6"/><path d="M20 14.4V20h-5.6"/>',
  fullscreenExit: '<path d="M9.6 4v5.6H4"/><path d="M14.4 4v5.6H20"/><path d="M9.6 20v-5.6H4"/><path d="M14.4 20v-5.6H20"/>',
  play: '<path d="M8.2 5.6v12.8a.9.9 0 0 0 1.37.77l10.2-6.4a.9.9 0 0 0 0-1.54L9.57 4.83A.9.9 0 0 0 8.2 5.6Z" fill="currentColor" stroke="none"/>',
  pause: '<rect x="6.6" y="5" width="4.1" height="14" rx="1.5" fill="currentColor" stroke="none"/><rect x="13.3" y="5" width="4.1" height="14" rx="1.5" fill="currentColor" stroke="none"/>',
  prev: '<path d="M5.8 5.4v13.2" stroke="currentColor"/><path d="M18.6 6.3 10.4 12l8.2 5.7Z" fill="currentColor" stroke="none"/>',
  next: '<path d="M18.2 5.4v13.2" stroke="currentColor"/><path d="M5.4 6.3l8.2 5.7-8.2 5.7Z" fill="currentColor" stroke="none"/>',
  back10: '<path d="M12.9 4.2 9.4 5.2l1-3.5"/><path d="M13.4 4.5a8 8 0 1 1-7.9 8.6"/><path d="M4.2 9V4.6h4.4" stroke="currentColor"/>',
  fwd10: '<path d="m11.1 4.2 3.5 1-1-3.5"/><path d="M10.6 4.5a8 8 0 1 0 7.9 8.6"/><path d="M19.8 9V4.6h-4.4" stroke="currentColor"/>',
  repeat: '<path d="m17 2.4 4 4-4 4"/><path d="M21 6.4H8.5a4.5 4.5 0 0 0-4.5 4.5v.6"/><path d="m7 21.6-4-4 4-4"/><path d="M3 17.6h12.5a4.5 4.5 0 0 0 4.5-4.5v-.6"/>',
  repeatOne: '<path d="m17 2.4 4 4-4 4"/><path d="M21 6.4H8.5a4.5 4.5 0 0 0-4.5 4.5v.6"/><path d="m7 21.6-4-4 4-4"/><path d="M3 17.6h12.5a4.5 4.5 0 0 0 4.5-4.5v-.6"/><text x="12.05" y="16.6" font-size="5.6" font-weight="700" text-anchor="middle" fill="currentColor" stroke="none">1</text>',
  shuffle: '<path d="m16 3.2 4.8.1-.1 4.8"/><path d="M4.2 19.8 20.6 3.4"/><path d="m20.6 16.2.1 4.8-4.8-.1"/><path d="m14.8 14.8 5.8 5.8"/><path d="M4.2 4.2l5.6 5.6"/>',
  settings: '<circle cx="12" cy="12" r="2.9" fill="currentColor" stroke="none"/><path d="M12 2.8v2.3M12 18.9v2.3M2.8 12h2.3M18.9 12h2.3M5.8 5.8l1.6 1.6M16.6 16.6l1.6 1.6M18.2 5.8l-1.6 1.6M7.4 16.6l-1.6 1.6"/>',
  playlist: '<path d="M3.4 6h13.2M3.4 12h13.2M3.4 18h13.2"/><path d="M20 10.2 17.4 12v-6"/>',
  more: '<circle cx="5.2" cy="12" r="1.9" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.9" fill="currentColor" stroke="none"/><circle cx="18.8" cy="12" r="1.9" fill="currentColor" stroke="none"/>',
  info: '<circle cx="12" cy="12" r="8.4"/><path d="M12 11.2v4.6"/><circle cx="12" cy="7.7" r="1.05" fill="currentColor" stroke="none"/>',
  details: '<rect x="2.8" y="3.8" width="18.4" height="16.4" rx="2.2"/><path d="M8 3.8v16.4M14.5 12H20.6"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M15 4.6V4a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h1.6"/>',
  close: '<path d="m6.2 6.2 11.6 11.6M17.8 6.2 6.2 17.8"/>',
};
function videoIcon(name) {
  const body = VIDEO_ICON_SVG[name];
  if (!body) return "";
  return `<svg class="vc-svg video-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${body}</svg>`;
}
function videoPlayPauseIcon(paused) { return videoIcon(paused ? "play" : "pause"); }

/* ================= v0.9.51 音画同步漂移监控 =================
   转码流通过 pipe 实时推送，HTMLVideoElement 的 currentTime 与
   实际解码/渲染位置之间可能出现累积漂移。此函数每隔 2 秒比较
   视频时钟与系统实时时钟的差值，超过阈值时自动微调 playbackRate，
   在用户无感知的前提下修正音画不同步。   参考 Emby/Plex 在 NAS 转码流场景下的播放同步策略：
   · Emby 通过 FFmpeg 输出时钟对齐 + 客户端时钟锚定实现同步
   · Plex 采用自适应 bitRate + 客户端缓冲窗口管理
   本实现采用轻量级的 browser-side 时钟校准。 */
function bindVideoDriftMonitor(root, video) {
  if (!video || !root) return;
  if (root.__driftMonitorRAF) cancelAnimationFrame(root.__driftMonitorRAF);
  root.__driftMonitorTimer = null;
  const DRIFT_CHECK_INTERVAL_MS = 2000;
  const DRIFT_HARD_THRESHOLD_S = 0.4;
  const DRIFT_SOFT_THRESHOLD_S = 0.15;
  const RATE_ADJUST_STEP = 0.002;
  const MAX_RATE_ADJUST = 0.02;
  let lastWallClock = 0;
  let lastVideoTime = 0;
  let rateAdjustment = 0;
  let consecutiveGoodReadings = 0;
  function check() {
    if (video.paused || video.ended || video.readyState < 2) {
      lastWallClock = 0;
      root.__driftMonitorTimer = setTimeout(check, DRIFT_CHECK_INTERVAL_MS);
      return;
    }
    const wallNow = performance.now() / 1000;
    const videoNow = video.currentTime;
    if (lastWallClock === 0) { lastWallClock = wallNow; lastVideoTime = videoNow; root.__driftMonitorTimer = setTimeout(check, DRIFT_CHECK_INTERVAL_MS); return; }
    const elapsedWall = wallNow - lastWallClock;
    const elapsedVideo = videoNow - lastVideoTime;
    lastWallClock = wallNow;
    lastVideoTime = videoNow;
    if (elapsedWall < 0.5 || elapsedVideo < 0.5) { root.__driftMonitorTimer = setTimeout(check, DRIFT_CHECK_INTERVAL_MS); return; }
    const drift = elapsedVideo - elapsedWall;
    if (Math.abs(drift) > DRIFT_HARD_THRESHOLD_S) {
      video.currentTime += drift > 0 ? -0.05 : 0.05;
      rateAdjustment = 0;
      consecutiveGoodReadings = 0;
    } else if (Math.abs(drift) > DRIFT_SOFT_THRESHOLD_S) {
      const targetStep = drift > 0 ? -RATE_ADJUST_STEP : RATE_ADJUST_STEP;
      rateAdjustment = Math.max(-MAX_RATE_ADJUST, Math.min(MAX_RATE_ADJUST, rateAdjustment + targetStep));
      video.playbackRate = 1 + rateAdjustment;
      consecutiveGoodReadings = 0;
    } else {
      consecutiveGoodReadings++;
      if (consecutiveGoodReadings > 3 && rateAdjustment !== 0) {
        rateAdjustment *= 0.5;
        if (Math.abs(rateAdjustment) < 0.0005) rateAdjustment = 0;
        video.playbackRate = 1 + rateAdjustment;
      }
    }
    root.__driftMonitorTimer = setTimeout(check, DRIFT_CHECK_INTERVAL_MS);
  }
  video.addEventListener("play", () => { if (!root.__driftMonitorTimer) check(); });
  video.addEventListener("pause", () => { clearTimeout(root.__driftMonitorTimer); root.__driftMonitorTimer = null; rateAdjustment = 0; video.playbackRate = 1; });
  video.addEventListener("seeked", () => { lastWallClock = 0; consecutiveGoodReadings = 0; });
  check();
}

function scrollViewerIntoView(viewer) {
  const overlay = viewer && viewer.querySelector(".media-reader-overlay");
  if (!overlay) return;
  try {
    if (typeof overlay.scrollIntoView === "function") overlay.scrollIntoView({ block: "start" });
  } catch (e) { /* 滚动不是关键路径，失败不影响已渲染的内容 */ }
}

async function openLocalMedia(group, libId, path) {
  const lib = findMediaLibrary(libId);
  const viewer = document.getElementById("local-media-viewer-" + group);
  if (!lib || !viewer) return;
  /* v0.9.51：直接打开另一个媒体（播放列表切集、书架换片等）会整体覆盖
     viewer.innerHTML —— 旧 video 元素被移除前先停掉转码会话与 WASM 解码，
     否则服务端转码任务泄漏空转，且旧 blob/会话 URL 挂在已删除的 video 上。 */
  viewer.querySelectorAll(".media-video-body").forEach(root => { stopVideoPlaybackSession(root); terminateWasmVideo(root); });
  closeComicReader();
  const ext = fileExt(path);
  const url = mediaFileUrl(lib, path);
  activeReader = { group, libId, path };
  let body = "";
  if ((group === "comic" || group === "movie" || group === "audio") && ["zip","cbz"].includes(ext)) {
    viewer.innerHTML = viewerShell(group, lib, path, '<div class="empty-tip">正在读取压缩包图片...</div>', url, { doc: true });
    try {
      const res = await fetch(`/api/media/archive/zip?id=${encodeURIComponent(lib.id)}&path=${encodeURIComponent(path)}`, { cache:"no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const entries = data.entries || data.items || [];
      if (!entries.length) {
        viewer.innerHTML = viewerShell(group, lib, path, '<div class="media-error">压缩包中没有可读取的图片</div>', url, { doc: true });
        return;
      }
      /* v0.9.67：改用漫画阅读器（单页/双页/条漫 + 右起/左起 + 省流转码 + 预取 + 页码进度）。
         旧的「一次性铺 261 个 lazy <img>」既无预取也无模式切换，只保留为条漫模式的内部实现。 */
      mountComicReader(viewer, lib, path, entries, url);
      return;
    } catch (err) { viewer.innerHTML = viewerShell(group, lib, path, `<div class="media-error">ZIP 漫画读取失败：${esc(err.message)}</div>`, url, { doc: true }); return; }
  }
  /* v0.9.77：PDF 改走应用内阅读器（单页/双页/条漫 + 右起/左起 + 省流转码 + 预取 + 进度）。
     此前是 <iframe src="...pdf">，等于把 PDF 交给浏览器内置 PDF 阅读器 —— 客户反馈的问题。 */
  if (ext === "pdf" && (group === "comic" || group === "book")) {
    viewer.innerHTML = viewerShell(group, lib, path, '<div class="empty-tip">正在解析 PDF 页面...</div>', url, { doc: true });
    try {
      const res = await fetch(`/api/media/pdf/info?id=${encodeURIComponent(lib.id)}&path=${encodeURIComponent(path)}`, { cache: "no-store", credentials: "same-origin" });
      const info = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(info.error || `HTTP ${res.status}`);
      const total = Number(info.pages) || 0;
      if (!total) throw new Error("PDF 页数为 0");
      if (info.encrypted) toast("⚠️ 该 PDF 已加密，部分页面可能无法渲染");
      const entries = [];
      for (let i = 1; i <= total; i++) entries.push({ raw: String(i), name: String(i), pdf: true });
      mountComicReader(viewer, lib, path, entries, url, { pdf: true });
      return;
    } catch (err) {
      viewer.innerHTML = viewerShell(group, lib, path, `<div class="media-error">PDF 读取失败：${esc(err.message)}</div>`, url, { doc: true });
      return;
    }
  }
  if (["mp3","flac","m4a","ogg","wav"].includes(ext)) body = `<div class="media-viewer-body"><audio controls autoplay preload="metadata" src="${esc(url)}"></audio></div>`;
  else if (MEDIA_FORMATS.movie.includes(ext)) body = `<div class="media-viewer-body media-video-body" data-video-controls-visible="true" data-video-engine="native" data-video-chrome-collapsed="false" data-video-repeat="off" data-video-shuffle="off" data-video-quality="${typeof qualityVideoPreset === "function" ? qualityVideoPreset() : "auto"}">
<video data-movie-player playsinline preload="metadata" onloadedmetadata="this.muted=false;this.volume=1" onvolumechange="this.dataset.volume=String(this.volume)"></video>
<div class="video-chrome" data-video-chrome>
<div class="vc-top">
<button class="vc-icon vc-collapse" type="button" title="${esc(t("vpMinimize"))}" aria-label="${esc(t("vpMinimize"))}" onclick="minimizeVideoPlayer(this)">${videoIcon("collapse")}</button>
<div class="vc-heading"><strong class="vc-title" data-video-title>${esc(t("vpTitleLoading"))}</strong><span class="vc-sub" data-video-meta-line></span></div>
<button class="vc-icon vc-fullscreen" type="button" title="${esc(t("vpFullscreen"))}" aria-label="${esc(t("vpFullscreen"))}" aria-pressed="false" onclick="toggleVideoFullscreen(this)">${videoIcon("fullscreen")}</button>
</div>
<div class="vc-bottom">
<div class="video-timeline">
<div class="video-progress-shell" role="slider" aria-label="${esc(t("vpProgress"))}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" tabindex="0" onclick="seekVideoTimeline(event,this)"><span class="video-buffered-range"></span><span class="video-played-range"></span><span class="video-progress-knob"></span></div>
</div>
<div class="vc-bar">
<div class="vc-left">
<span class="video-time-label">00:00 / 00:00</span>
</div>
<div class="vc-center">
<button class="vc-icon" type="button" title="${esc(t("vpPrev"))}" aria-label="${esc(t("vpPrev"))}" onclick="videoPlayNeighbour(this,-1)">${videoIcon("prev")}</button>
<button class="vc-icon" type="button" title="${esc(t("vpRewind"))}" aria-label="${esc(t("vpRewind"))}" onclick="videoSkip(this,-10)">${videoIcon("back10")}</button>
<button class="vc-icon vc-play" type="button" title="${esc(t("vpPlayPause"))}" aria-label="${esc(t("vpPlayPause"))}" data-video-play onclick="videoTogglePlay(this)">${videoIcon("play")}</button>
<button class="vc-icon" type="button" title="${esc(t("vpForward"))}" aria-label="${esc(t("vpForward"))}" onclick="videoSkip(this,10)">${videoIcon("fwd10")}</button>
<button class="vc-icon" type="button" title="${esc(t("vpNext"))}" aria-label="${esc(t("vpNext"))}" onclick="videoPlayNeighbour(this,1)">${videoIcon("next")}</button>
<button class="vc-icon vc-stop" type="button" title="${esc(t("vpClose"))}" aria-label="${esc(t("vpClose"))}" onclick="closeVideoPlayer(this)">${videoIcon("close")}</button>
</div>
<div class="vc-right">
<button class="vc-icon" type="button" title="${esc(t("vpMore"))}" aria-label="${esc(t("vpMore"))}" aria-expanded="false" data-video-panel-button="more" onclick="toggleVideoPanel(this,'more')">${videoIcon("more")}</button>
<button class="vc-icon" type="button" title="${esc(t("vpRepeat") + "：" + t("vpRepeatOff"))}" aria-label="${esc(t("vpRepeat"))}" data-video-repeat-button onclick="cycleVideoRepeat(this)">${videoIcon("repeat")}</button>
<button class="vc-icon" type="button" title="${esc(t("vpShuffle") + "：" + t("vpShuffleOff"))}" aria-label="${esc(t("vpShuffle"))}" data-video-shuffle-button onclick="toggleVideoShuffle(this)">${videoIcon("shuffle")}</button>
<button class="vc-icon" type="button" title="${esc(t("vpSettings"))}" aria-label="${esc(t("vpSettings"))}" aria-expanded="false" data-video-panel-button="settings" onclick="toggleVideoPanel(this,'settings')">${videoIcon("settings")}</button>
<button class="vc-icon vc-playlist-toggle" type="button" title="${esc(t("vpPlaylist"))}" aria-label="${esc(t("vpPlaylist"))}" aria-expanded="false" data-video-panel-button="playlist" onclick="toggleVideoPanel(this,'playlist')">${videoIcon("playlist")}</button>
</div>
</div>
</div>
</div>
<button class="vc-restore" type="button" title="${esc(t("vpExpand"))}" aria-label="${esc(t("vpExpand"))}" onclick="expandVideoPlayer(this)">${videoIcon("restore")}</button>
<div class="vc-panel vc-panel-more" data-video-panel="more">
<h4>${esc(t("vpMore"))}</h4>
<button class="video-info-button" type="button" title="播放及媒体元数据" aria-label="播放及媒体元数据" aria-expanded="false" onclick="toggleVideoStatusPanel(this)"><span class="vc-panel-ic">${videoIcon("info")}</span>${esc(t("vpInfo"))}</button>
<button type="button" onclick="openVideoDetailsFromPlayer(this)"><span class="vc-panel-ic">${videoIcon("details")}</span>${esc(t("vpDetails"))}</button>
<button type="button" onclick="copyVideoPlaybackInfo(this)"><span class="vc-panel-ic">${videoIcon("copy")}</span>${esc(t("vpDiag"))}</button>
</div>
<div class="vc-panel vc-panel-settings video-track-menu video-audio-menu" data-video-panel="settings" data-video-track-menu>
<h4>${esc(t("vpQuality"))}</h4>
<div class="video-quality-options" data-video-quality-options><button type="button" class="active" data-quality="auto" onclick="setVideoQuality(this,'auto')">${esc(t("vpQualityAuto"))}</button><button type="button" data-quality="original" onclick="setVideoQuality(this,'original')">${esc(t("vpQualityOriginal"))}</button><button type="button" data-quality="1080p" onclick="setVideoQuality(this,'1080p')">1080p</button><button type="button" data-quality="720p" onclick="setVideoQuality(this,'720p')">720p</button><button type="button" data-quality="480p" onclick="setVideoQuality(this,'480p')">480p</button></div>
<h4>${esc(t("vpAudioStream"))}</h4>
<div class="video-audio-options" data-video-audio-options>${esc(t("vpAudioLoading"))}</div>
<h4>${esc(t("vpSubtitle"))}</h4>
<div class="video-subtitle-menu" data-video-subtitle-options>${esc(t("vpSubtitleNone"))}</div>
<button type="button" onclick="searchVideoSubtitles(this)">${esc(t("vpSubtitleSearch"))}</button>
<h4>${esc(t("vpVolume"))}</h4>
<div class="vc-volume-row"><input class="vc-volume-range" type="range" min="0" max="100" step="1" value="100" aria-label="${esc(t("vpVolume"))}" data-video-volume oninput="setVideoVolume(this,this.value)"><span class="vc-volume-label" data-video-volume-label>100%</span></div>
</div>
<div class="vc-panel vc-panel-playlist" data-video-panel="playlist">
<h4>${esc(t("vpPlaylist"))}</h4>
<div class="video-playlist-items" data-video-playlist>${esc(t("vpPlaylistLoading"))}</div>
</div>
<div class="video-status-panel"><span class="status-main" data-video-status>准备播放</span><span class="status-detail" data-video-detail>--:-- / --:-- · 媒体元数据待识别</span><span class="status-compat movie-compat-status" data-video-compat></span><span class="status-decode" data-video-decode></span></div>
</div>`;
  else if (["jpg","jpeg","png","webp","gif","bmp","avif"].includes(ext)) body = `<img src="${esc(url)}" alt="${esc(path)}">`;
  /* v0.9.77：PDF 的 iframe 分支已移除 —— 任何库里的 PDF 都由上面的应用内阅读器处理，
     不再交给浏览器内置 PDF 查看器（客户反馈）。 */

  else if (ext === "epub") {
    /* v0.9.70：EPUB 由服务端按 spine 解析成章节纯文本（容器内自解析，无第三方依赖），
       复用 TXT 电子书阅读器的章节下拉与进度恢复；此前只显示「不支持直接解析」。 */
    viewer.innerHTML = viewerShell(group, lib, path, '<div class="empty-tip">正在解析 EPUB 电子书...</div>', url, { doc: true });
    try {
      const res = await fetch(`/api/media/document/epub?id=${encodeURIComponent(lib.id)}&path=${encodeURIComponent(path)}`, { cache: "no-store", credentials: "same-origin" });
      if (!res.ok) {
        let detail = "";
        try { detail = (await res.json()).error || ""; } catch (e) {}
        throw new Error(detail || `HTTP ${res.status}`);
      }
      const data = await res.json();
      /* 除标题/正文外补一个累计字符偏移：EPUB 的章节位置由服务端给出，
         这里按「前序章节正文长度」累计，供按比例定位的消费者使用
         （阅读器跳转本身优先用章节标题元素精确定位，见 jumpEbookChapter）。 */
      let ebookOffset = 0;
      const chapters = (data.chapters || []).map((c, i) => {
        const item = { title: c.title || ("第 " + (i + 1) + " 章"), text: c.text || "", offset: ebookOffset };
        ebookOffset += (c.text || "").length + (c.title || "").length;
        return item;
      }).filter(c => c.text.trim());
      if (!chapters.length) throw new Error("这本 EPUB 没有可读正文");
      window.__ebookChapters = chapters;
      window.__ebookTextLength = chapters.reduce((n, c) => n + c.text.length, 0);
      body = chapters.map(c => `<h3 class="ebook-chapter-title">${esc(c.title)}</h3><pre class="media-text">${esc(c.text)}</pre>`).join("");
      if (data.truncated) toast("ℹ️ 本书较长，本次已加载前 " + chapters.length + " 章");
      viewer.innerHTML = viewerShell(group, lib, path, body, url, { chapters, ebook: true, doc: true });
    } catch (err) {
      body = `<div class="media-error">EPUB 解析失败：${esc(err.message)}</div>`;
      viewer.innerHTML = viewerShell(group, lib, path, body, url, { doc: true });
      return;
    }
    scrollViewerIntoView(viewer);
    restoreReaderProgress(viewer, lib.id, path);
    return;
  } else if (ext === "txt") {
    viewer.innerHTML = viewerShell(group, lib, path, '<div class="empty-tip">正在读取文本...</div>', url, { doc: true });
    try {
      const bytes = await fetchCompleteTextFile(url);
      const text = decodeTextBytes(bytes);
      const chapters = buildEbookChapters(text);
      window.__ebookChapters = chapters;
      window.__ebookTextLength = text.length;
      body = `<pre class="media-text" id="ebookText">${esc(text)}</pre>`;
      viewer.innerHTML = viewerShell(group, lib, path, body, url, { chapters, ebook: true, doc: true });
    } catch (err) {
      body = `<div class="media-error">文本读取失败：${esc(err.message)}</div>`;
      viewer.innerHTML = viewerShell(group, lib, path, body, url, { doc: true });
      return;
    }
    /* 滚动定位放在 try 之外：它失败只是没滚到位，不能被报成「文本读取失败」，
       否则正文其实已经渲染好了，用户却看到一条读取失败的红字。 */
    scrollViewerIntoView(viewer);
    /* v0.9.30：电子书同样恢复上次阅读位置。 */
    restoreReaderProgress(viewer, lib.id, path);
    return;
  } else {
    /* v0.9.56：清除下载权限 —— 不可预览格式不再提供「新窗口直开原文件」的链接
       （该链接等于绕过播放器直接下载原文件），仅提示不支持。 */
    const note = MEDIA_FORMATS.comic.includes(ext) ? "该漫画/压缩格式已加入书架，但当前浏览器不能直接解析。" : MEDIA_FORMATS.book.includes(ext) ? "该电子书格式已加入书架，但当前浏览器不支持直接解析。" : "该格式不支持在线预览。";
    body = `<div class="reader-book-fallback"><div class="book-cover" style="max-width:220px;margin:0 auto 24px;background:${coverGradient(displayBookTitle(path))}"><span class="book-cover-title">${esc(displayBookTitle(path))}</span></div><p>${note}</p></div>`;
  }
  const isVideoPlayer = group === "movie" && MEDIA_FORMATS.movie.includes(ext);
  viewer.innerHTML = viewerShell(group, lib, path, body, url, { player: isVideoPlayer });
  if (isVideoPlayer) initMovieCompatPlayer(viewer, lib, path);
  scrollViewerIntoView(viewer);
}
