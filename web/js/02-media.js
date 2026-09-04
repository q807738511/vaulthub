/* VaultHub frontend — split from index.html in phase 4.
   Plain ordered classic scripts (no bundler): global functions remain global
   so the ~131 inline on*= handlers keep working. Load order is fixed by the
   <script> tags in index.html and MUST be preserved. */
const MEDIA_VIEWS = ["comic", "movie", "audio"];

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
let mediaResourceView = (() => { try { return localStorage.getItem("vaulthub_media_resource_view") === "list" ? "list" : "poster"; } catch(e) { return "poster"; } })();
let mediaPageSize = 20;
let audioPageSize = 20;
let audioView = "albums";
let audioFiles = [];
let audioCursor = 0;
let audioTrackTitle = "";
let activeAudio = null;
const audioMetadataCache = "vaulthub_audio_metadata_v1";
const audioFavoritesCache = "vaulthub_audio_favorites_v1";
let activeReader = null;
function readAudioFavorites() { try { return JSON.parse(localStorage.getItem(audioFavoritesCache) || "[]") || []; } catch (e) { return []; } }
function audioFavoriteKey(libId, path) { return `${libId}\n${path}`; }
function isAudioFavorite(libId, path) { return readAudioFavorites().includes(audioFavoriteKey(libId, path)); }
function toggleAudioFavorite(libId, path) {
  const key = audioFavoriteKey(libId, path), values = readAudioFavorites(), index = values.indexOf(key);
  if (index >= 0) values.splice(index, 1); else values.push(key);
  try { localStorage.setItem(audioFavoritesCache, JSON.stringify(values)); } catch (e) {}
  updateAudioFavoriteButton();
  const lib = findMediaLibrary(localMediaSelection.audio); if (lib) loadLocalFiles("audio", lib, audioCursor);
}
function toggleActiveAudioFavorite() { if (activeAudio) toggleAudioFavorite(activeAudio.libId, activeAudio.path); }
function updateAudioFavoriteButton() { const button = document.getElementById("audioFavoriteButton"); if (button) button.textContent = activeAudio && isAudioFavorite(activeAudio.libId, activeAudio.path) ? "♥" : "♡"; }
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

const movieMetadataCache = "vaulthub_movie_metadata_v1";
let scraperStatus = { default: "douban", tmdb_enabled: false };
function readMovieMetadata() { try { return JSON.parse(localStorage.getItem(movieMetadataCache) || "{}") || {}; } catch (e) { return {}; } }
function writeMovieMetadata(data) { try { localStorage.setItem(movieMetadataCache, JSON.stringify(data)); } catch (e) {} }
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
  try { localStorage.setItem(seriesShowStoreKey(libId, show.key), JSON.stringify(seriesShowCacheShape(show))); }
  catch(e) { /* 配额不足时退化为内存缓存，详情页仍能从本次渲染的数据打开 */ seriesShowMemory[seriesShowStoreKey(libId, show.key)] = seriesShowCacheShape(show); }
}
/* JSON.stringify 会把 seasons(Map) 序列化成 {}，因此读回后只有数组 seasonList 与 files 可用；
   openSeriesDetails 必须只依赖这两个字段，并对旧缓存缺字段的情况回落空数组。 */
function readSeriesShow(libId, showKey) { const key = seriesShowStoreKey(libId, showKey); try { const show = JSON.parse(localStorage.getItem(key) || "null") || seriesShowMemory[key] || null; if (!show) return null; if (!Array.isArray(show.seasonList)) show.seasonList = []; if (!Array.isArray(show.files)) show.files = []; return show; } catch(e) { return null; } }

function movieTitleFromPath(path) {
  /* 先在原始文件名上剔除年份与发布规格，再做分隔符归一化：
     displayBookTitle 会把 WEB-DL 这类连字符换成空格，先跑它会导致噪声词漏匹配。 */
  const raw = String(path).split("/").pop().replace(/\.[^.]+$/, "");
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
async function loadScraperStatus() { try { const res = await fetch("/api/media/scrapers", { cache:"no-store" }); if (res.ok) scraperStatus = await res.json(); } catch(e) {} }
async function loadMediaRuntimeSettings(notify = false) {
  const status = document.getElementById("mediaRuntimeStatus");
  try {
    const res = await fetch("/api/media/settings", { cache:"no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const c = await res.json();
    const values = { mediaScraperMode:c.scraper_mode, tmdbApiBase:c.tmdb_api_base, tmdbImageBase:c.tmdb_image_base, tvdbApiBase:c.tvdb_api_base, mediaCacheDir:c.cache_dir, mediaCacheMaxBytes:c.cache_max_bytes, mediaCacheMaxAge:c.cache_max_age_hours, mediaCacheCleanup:c.cache_cleanup_interval_hours };
    Object.entries(values).forEach(([id,value]) => { const el=document.getElementById(id); if(el && value !== undefined) el.value=String(value); });
    const key=document.getElementById("tmdbApiKey"); if(key){ key.value=""; key.placeholder=c.tmdb_api_key_masked ? "已设置；留空保留" : "未设置"; }
    const tvdbKey=document.getElementById("tvdbApiKey"); if(tvdbKey){ tvdbKey.value=""; tvdbKey.placeholder=c.tvdb_api_key_masked ? "已设置；留空保留" : "未设置"; }
    const proxy=document.getElementById("scraperProxy"); if(proxy){ proxy.value=""; proxy.placeholder=c.scraper_proxy_configured ? `已配置 ${c.scraper_proxy_display||"代理"}；留空保留` : "例：http://192.0.2.10:7890"; proxy.dataset.configured=c.scraper_proxy_configured?"1":"0"; }
    if(status) status.textContent="✅ 已载入运行配置";
    if(notify) toast("✅ 已重新载入刮削与缓存设置");
  } catch(e) { if(status) status.textContent=`⚠ ${e.message}`; if(notify) toast("⚠️ 设置读取失败"); }
}
async function saveMediaRuntimeSettings() {
  const value=id=>document.getElementById(id)?.value?.trim() || "";
  const proxyEl=document.getElementById("scraperProxy"), proxyValue=value("scraperProxy");
  const payload={ scraper_mode:value("mediaScraperMode")||"auto", tmdb_api_key:value("tmdbApiKey"), tmdb_api_base:value("tmdbApiBase"), tmdb_image_base:value("tmdbImageBase"), tvdb_api_key:value("tvdbApiKey"), tvdb_api_base:value("tvdbApiBase"), scraper_proxy:proxyValue, scraper_proxy_set:!!proxyValue || proxyEl?.dataset.configured!=="1", cache_dir:value("mediaCacheDir"), cache_max_bytes:Number(value("mediaCacheMaxBytes")), cache_max_age_hours:Number(value("mediaCacheMaxAge")), cache_cleanup_interval_hours:Number(value("mediaCacheCleanup")) };
  const status=document.getElementById("mediaRuntimeStatus"); if(status) status.textContent="保存中…";
  try { const res=await fetch("/api/media/settings",{method:"PUT",headers:sessionWriteHeaders(true),body:JSON.stringify(payload)}); const data=await res.json(); if(!res.ok) throw new Error(data.error||`HTTP ${res.status}`); scraperStatus={...scraperStatus,...data,default:data.scraper_mode}; await loadMediaRuntimeSettings(false); toast("✅ 刮削与缓存设置已立即生效"); }
  catch(e){ if(status)status.textContent=`⚠ ${e.message}`; toast("⚠️ 保存失败："+e.message); }
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
async function scrapeMovieMetadata(host, lib, files) {
  await loadScraperStatus();
  const all = readMovieMetadata();
  const localPaths = new Set();
  for (const file of files) {
    const path=String(file.path);
    try { const res=await fetch(`/api/media/metadata?id=${encodeURIComponent(lib.id)}&path=${encodeURIComponent(path)}`,{cache:"no-store"}); const local=res.ok?await res.json():null; if(local&&(local.nfo||local.poster||local.logo||local.fanart||local.backdrop||local.tags?.length||local.watched||local.subtitles?.length)){all[path]={...movieBaseMetadata(path),...(all[path]||{}),...local,title:local.title||(all[path]?.title)||movieBaseMetadata(path).title,provider:local.provider||"本地元数据",media_type:lib?.type==="series"?"series":"movie",checkedAt:Date.now()};localPaths.add(path);} } catch(e) {}
  }
  writeMovieMetadata(all);
  if (localPaths.size) renderMovieLibraryContent(host, lib, files);
  const pending = files.filter(file => !all[file.path] && !localPaths.has(String(file.path)));
  for (const file of pending) { all[file.path] = { ...movieBaseMetadata(String(file.path)), provider: "文件名展示（等待豆瓣刮削）", checkedAt: Date.now() }; }
  writeMovieMetadata(all); if (pending.length) renderMovieLibraryContent(host, lib, files);
  for (const file of pending) {
    const path = String(file.path), fallback = all[path], title = fallback.title;
    const mediaType = lib?.type === "series" ? "series" : "movie";

    // TMDB 已配置时优先使用官方刮削（电影走 search/movie，剧集走 search/tv），
    // 未配置或无结果时回落豆瓣，最后回落文件名展示。
    const mode = scraperStatus.scraper_mode || scraperStatus.default || "auto";
    if (mediaType === "series" && mode === "auto" && scraperStatus.tvdb_enabled) try {
      const tvdb = await fetch(`/api/media/tvdb?query=${encodeURIComponent(title)}`, { cache:"force-cache" });
      const item = tvdb.ok ? (await tvdb.json())?.results?.[0] : null;
      if (item) { all[path] = { ...fallback, tvdb_id:item.id, media_type:mediaType, title:item.name || fallback.title, year:String(item.first_air_date || fallback.year).slice(0,4), poster:item.poster_path || "", overview:item.overview || "", provider:"TVDB · 剧集", checkedAt:Date.now() }; writeMovieMetadata(all); renderMovieLibraryContent(host, lib, files); continue; }
    } catch(e) {}
    if ((mode === "auto" || mode === "tmdb") && scraperStatus.tmdb_enabled) try {
      const tmdb = await fetch(`/api/media/tmdb?query=${encodeURIComponent(title)}&type=${encodeURIComponent(mediaType)}`, { cache:"force-cache" });
      const data = tmdb.ok ? await tmdb.json() : null;
      const item = data?.results?.find(x => x.poster_path || x.overview || x.title || x.name);
      if (item) {
        const base = scraperStatus.tmdb_image_base || "https://image.tmdb.org/t/p";
        all[path] = { ...fallback, tmdb_id:item.id, media_type:mediaType, title:item.title || item.name || fallback.title, year:String(item.release_date || item.first_air_date || fallback.year).slice(0,4), poster:item.poster_path ? `${base}/w342${item.poster_path}` : "", backdrop:item.backdrop_path ? `${base}/w1280${item.backdrop_path}` : "", overview:item.overview || "", rating:Number(item.vote_average||0), provider:mediaType === "series" ? "TMDB · 剧集" : "TMDB · 电影", checkedAt:Date.now() };
        writeMovieMetadata(all); renderMovieLibraryContent(host, lib, files); continue;
      }
    } catch(e) {}
    if (mode === "tmdb" || mode === "filename") { all[path] = { ...fallback, provider:"文件名展示", checkedAt:Date.now() }; writeMovieMetadata(all); renderMovieLibraryContent(host, lib, files); continue; }
    try {
      const douban = await fetch(`https://movie.douban.com/j/subject_suggest?q=${encodeURIComponent(title)}`, { cache:"force-cache" });
      const item = douban.ok ? (await douban.json())?.[0] : null;
      if (item) { all[path] = { ...fallback, title:item.title || fallback.title, year:item.year || fallback.year, poster:item.img || "", provider:"豆瓣", checkedAt:Date.now() }; writeMovieMetadata(all); renderMovieLibraryContent(host, lib, files); continue; }
    } catch(e) {}
    all[path] = { ...fallback, provider:"文件名展示", checkedAt:Date.now() };
    writeMovieMetadata(all); renderMovieLibraryContent(host, lib, files);
  }
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
function renderSeriesShowCard(lib, show) { const art=show.poster?`<img src="${esc(show.poster)}" alt="${esc(show.title)}" loading="lazy">`:`<span>${esc(show.title)}</span>`; const seasons=show.seasonList?.length||0, episodes=show.files?.length||0; return `<article class="media-poster-card series-show-card" data-series-show="${esc(show.key)}" onclick="openSeriesDetails(${jsAttrArg(lib.id)},${jsAttrArg(show.key)})"><div class="media-poster-art" style="${show.poster?"":`background:${coverGradient(show.title)}`}">${art}</div><div class="media-poster-info"><strong>${esc(show.title)}</strong><small>${esc([show.year, `${seasons} 季`, `${episodes} 集`, show.provider].filter(Boolean).join(" · "))}</small></div></article>`; }
function openSeriesDetails(libId, showKey) { enterMovieDetailSidebarMode(); const lib=findMediaLibrary(libId), viewer=document.getElementById("local-media-viewer-movie"); if(!lib||!viewer)return; const show=readSeriesShow(libId,showKey); if(!show)return; const hero={title:show.title,overview:show.overview||"已按 Plex / Emby 风格根据根目录、Season 01 和 S01E01 规则聚合到同一剧集。",poster:show.poster,logo:show.logo,fanart:show.fanart,backdrop:show.backdrop,year:show.year,provider:show.provider,watched:show.watched,media_type:"series"}; /* v0.9.51：进入剧集详情即把该剧的分集按季/集顺序设为播放队列，
     这样播放器的「上一个 / 下一个 / 播放列表」走的是同一部剧而不是整库。 */
  setVideoPlaylist(libId, (show.seasonList||[]).flatMap(season=>(season.episodes||[]).map(ep=>({path:ep.path}))));
  const seasons=(show.seasonList||[]).map(season=>`<section class="series-season-block"><h3>Season ${String(season.season).padStart(2,"0")}</h3><div class="media-file-list">${season.episodes.map(ep=>renderSeriesEpisodeRow(lib,ep)).join("")}</div></section>`).join(""); viewer.innerHTML=`<div class="media-reader-overlay movie-detail-page series-detail-page"><div class="movie-detail-scroll"><button class="media-reader-close" onclick="closeMovieDetails()">✕</button>${renderMovieHero(lib,show.files?.[0]?.path||"",hero)}<section><h3>剧集列表</h3><div class="hint">按标准命名规则聚合：根目录剧名 / Season 01 / 剧名 S01E01 标题；刮削先锁定主剧集，再将本地多季多集挂载到同一条目。</div></section>${seasons}</div></div>`; scrollViewerIntoView(viewer); }
function renderSeriesEpisodeRow(lib, ep) { const path=String(ep.path), meta=ep.meta||movieMetadataFor(path), parsed=ep.parsed||parseSeriesEpisode(path); return `<div class="media-file-row series-episode-row"><div class="media-file-name" title="${esc(path)}"><b>${esc(parsed.label)} · ${esc(meta.title||parsed.title)}</b><small>${esc([meta.year,meta.provider].filter(Boolean).join(" · "))}</small></div><span class="media-file-meta">${esc(fileExt(path).toUpperCase())} · ${formatFileSize(ep.size)}</span><div class="media-actions"><button class="btn" onclick="openLocalMedia('movie',${jsAttrArg(lib.id)},${jsAttrArg(path)})">▶ 播放</button><button class="btn" onclick="openMovieDetails(${jsAttrArg(lib.id)},${jsAttrArg(path)})">详情</button></div></div>`; }
function renderMovieLibrary(lib, files) { const host = document.createElement("div"); renderMovieLibraryContent(host, lib, files); return host.innerHTML; }
function renderMovieRow(lib, file) { const path=String(file.path), meta=movieMetadataFor(path); return `<div class="media-file-row"><div class="media-file-name" title="${esc(path)}"><b>${esc(meta.title)}</b><small>${esc([meta.year, meta.provider].filter(Boolean).join(" · "))}</small></div><span class="media-file-meta">${esc(fileExt(path).toUpperCase())} · ${formatFileSize(file.size)}</span><div class="media-actions"><button class="btn" data-media-group="movie" data-media-library="${esc(lib.id)}" data-media-path="${esc(path)}" onclick="openLocalMediaButton(this)">▶ 播放</button></div></div>`; }
function movieStateKey(kind, libId, path) { return `vaulthub_movie_${kind}_${libId}_${path}`; }
function movieFlag(kind, libId, path) { try { return localStorage.getItem(movieStateKey(kind,libId,path)) === "1"; } catch(e) { return false; } }

function toggleMovieFavorite(libId,path,button){const next=!movieFlag("favorite",libId,path);try{localStorage.setItem(movieStateKey("favorite",libId,path),next?"1":"0");}catch(e){} if(button)button.textContent=next?"♥ 已收藏":"♡ 收藏";}
async function saveMovieMetadataOverride(libId,path,values){const res=await fetch(`/api/media/metadata/override?id=${encodeURIComponent(libId)}&path=${encodeURIComponent(path)}`,{method:"PUT",headers:sessionWriteHeaders(true),body:JSON.stringify(values)});const data=await res.json();if(!res.ok)throw new Error(data.error||`HTTP ${res.status}`);return data;}
async function toggleMovieWatched(libId,path,button){const meta=movieMetadataFor(path),next=!(meta.watched||movieFlag("watched",libId,path));try{const data=await saveMovieMetadataOverride(libId,path,{poster:meta.poster||"",logo:meta.logo||"",fanart:meta.fanart||"",backdrop:meta.backdrop||"",tags:meta.tags||[],watched:next});meta.watched=!!data.watched;const all=readMovieMetadata();all[path]=meta;writeMovieMetadata(all);localStorage.setItem(movieStateKey("watched",libId,path),next?"1":"0");if(button)button.textContent=next?"✓ 已观看":"○ 未观看";}catch(e){toast("⚠️ 状态保存失败："+e.message);}}
async function openMediaMetadataEditor(libId,path){const meta=movieMetadataFor(path);document.getElementById("mediaEditLibId").value=libId;document.getElementById("mediaEditPath").value=path;for(const role of ["Poster","Logo","Fanart","Backdrop"])document.getElementById(`mediaEdit${role}Url`).value=meta[role.toLowerCase()]||"";document.getElementById("mediaEditTags").value=(meta.tags||[]).join(", ");const host=document.getElementById("mediaEditArtworkChoices");host.innerHTML="正在读取媒体目录图片…";openModal("mediaMetadataEditorModal");try{const res=await fetch(`/api/media/metadata/artwork?id=${encodeURIComponent(libId)}&path=${encodeURIComponent(path)}`,{cache:"no-store"});const data=await res.json();if(!res.ok)throw new Error(data.error||`HTTP ${res.status}`);host.innerHTML=(data.items||[]).map(item=>`<button class="artwork-choice" type="button" onclick="chooseMediaArtwork(${jsAttrArg(item.url)})"><img src="${esc(item.url)}" alt=""><span>${esc(item.name)}</span></button>`).join("")||"该目录没有可选图片";}catch(e){host.textContent="图片读取失败："+e.message;}}
function chooseMediaArtwork(url){const role=document.getElementById("mediaEditArtworkRole").value;document.getElementById(`mediaEdit${role}Url`).value=url;}
async function saveMediaMetadataEditor(){const libId=document.getElementById("mediaEditLibId").value,path=document.getElementById("mediaEditPath").value,meta=movieMetadataFor(path);const values={poster:document.getElementById("mediaEditPosterUrl").value.trim(),logo:document.getElementById("mediaEditLogoUrl").value.trim(),fanart:document.getElementById("mediaEditFanartUrl").value.trim(),backdrop:document.getElementById("mediaEditBackdropUrl").value.trim(),tags:document.getElementById("mediaEditTags").value.split(/[,，]/).map(x=>x.trim()).filter(Boolean),watched:!!meta.watched};try{const saved=await saveMovieMetadataOverride(libId,path,values),all=readMovieMetadata();all[path]={...meta,...saved};writeMovieMetadata(all);closeModal("mediaMetadataEditorModal");await openMovieDetails(libId,path);toast("✅ 媒体信息已保存");}catch(e){toast("⚠️ 保存失败："+e.message);}}
function rateMovie(libId,path){const raw=prompt("请为该视频评分（0-10）",localStorage.getItem(movieStateKey("rating",libId,path))||"");if(raw===null)return;const n=Number(raw);if(!Number.isFinite(n)||n<0||n>10){toast("⚠️ 评分应为 0-10");return;}localStorage.setItem(movieStateKey("rating",libId,path),String(n));document.querySelector("[data-user-rating]")?.replaceChildren(document.createTextNode(`我的评分 ${n.toFixed(1)}`));}
async function shareMovie(title){try{if(navigator.share)await navigator.share({title,text:title,url:location.href});else{await navigator.clipboard.writeText(location.href);toast("✅ 页面链接已复制");}}catch(e){}}
async function openMovieDetails(libId,path){enterMovieDetailSidebarMode();const lib=findMediaLibrary(libId),viewer=document.getElementById("local-media-viewer-movie");if(!lib||!viewer)return;let meta=movieMetadataFor(path);viewer.innerHTML=renderMovieDetails(lib,path,meta);try{const res=await fetch(`/api/media/metadata?id=${encodeURIComponent(lib.id)}&path=${encodeURIComponent(path)}`,{cache:"no-store"});if(res.ok){const local=await res.json();if(local.nfo||local.poster||local.logo||local.fanart||local.backdrop||local.tags?.length||local.watched||local.subtitles?.length){meta={...meta,...local,title:local.title||meta.title,year:local.year||meta.year};const all=readMovieMetadata();all[path]=meta;writeMovieMetadata(all);viewer.innerHTML=renderMovieDetails(lib,path,meta);}}}catch(e){}if(meta.tmdb_id&&meta.provider!=="本地 NFO"){try{const res=await fetch(`/api/media/tmdb?id=${encodeURIComponent(meta.tmdb_id)}&type=${encodeURIComponent(meta.media_type||lib.type)}`,{cache:"force-cache"});if(res.ok){const detail=await res.json();meta={...meta,overview:detail.overview||meta.overview,rating:Number(detail.vote_average||meta.rating||0),runtime:detail.runtime||detail.episode_run_time?.[0],genres:(detail.genres||[]).map(x=>x.name),cast:(detail.credits?.cast||[]).slice(0,12),recommendations:(detail.recommendations?.results||[]).slice(0,8)};viewer.innerHTML=renderMovieDetails(lib,path,meta);}}catch(e){}}scrollViewerIntoView(viewer);}
function closeMovieDetails(){const viewer=document.getElementById("local-media-viewer-movie");if(viewer)viewer.innerHTML="";leaveMovieDetailSidebarMode();}
/* esc() 只做 HTML 实体转义，浏览器解析 style 属性时会把 &#39; 还原成单引号，
   足以闭合 url('…') 并注入任意 CSS 声明。海报地址可能来自本地 NFO、TMDB 或豆瓣，
   都属于外部内容，因此进 CSS 前必须先剔除引号、反斜杠、括号与换行。 */
function cssUrlValue(url) { return String(url || "").replace(/[\u0000-\u001f"'()\\]/g, "").trim(); }
function movieHeroArt(meta) { if (meta?.fanart) return { kind:"fanart-art", url:meta.fanart }; if (meta?.backdrop) return { kind:"backdrop-art", url:meta.backdrop }; if (meta?.poster) return { kind:"poster-art", url:meta.poster }; return { kind:"no-art", url:"" }; }
function renderMovieHero(lib,path,meta) { const heroArt = movieHeroArt(meta); const safeArt = cssUrlValue(heroArt.url); const style = safeArt ? `--movie-hero-art:url('${esc(safeArt)}')` : ""; const logo=meta.logo?`<img class="movie-detail-logo" src="${esc(meta.logo)}" alt="${esc(meta.title)} Logo">`:`<h1>${esc(meta.title)}</h1>`; return `<header class="movie-detail-hero ${heroArt.kind}" style="${style}">${logo}<p>${esc(meta.overview||"暂无电影介绍；可在系统设置中配置 TMDB API 进行刮削。")}</p><div class="movie-detail-actions"><button class="btn btn-primary" onclick="openLocalMedia('movie',${jsAttrArg(lib.id)},${jsAttrArg(path)})">▶ 播放</button><button class="btn" onclick="shareMovie(${jsAttrArg(meta.title)})">↗ 分享</button><button class="btn" onclick="toggleMovieFavorite(${jsAttrArg(lib.id)},${jsAttrArg(path)},this)">${movieFlag("favorite",lib.id,path)?"♥ 已收藏":"♡ 收藏"}</button><button class="btn" onclick="rateMovie(${jsAttrArg(lib.id)},${jsAttrArg(path)})">★ <span data-user-rating>评分</span></button><button class="btn" onclick="toggleMovieWatched(${jsAttrArg(lib.id)},${jsAttrArg(path)},this)">${meta.watched||movieFlag("watched",lib.id,path)?"✓ 已观看":"○ 未观看"}</button><button class="btn" onclick="openMediaMetadataEditor(${jsAttrArg(lib.id)},${jsAttrArg(path)})">✎ 编辑</button></div></header>`; }
function renderMovieDetails(lib,path,meta){const cast=(meta.cast||[]).map(x=>`<article><b>${esc(x.name||"")}</b><small>${esc(x.character||"")}</small></article>`).join("")||'<div class="empty-tip">暂无演职人员信息</div>';const rec=(meta.recommendations||[]).map(x=>`<article><b>${esc(x.title||x.name||"")}</b><small>${esc(String(x.release_date||x.first_air_date||"").slice(0,4))}</small></article>`).join("")||'<div class="empty-tip">暂无视频推荐</div>';return `<div class="media-reader-overlay movie-detail-page"><div class="movie-detail-scroll"><button class="media-reader-close" onclick="closeMovieDetails()">✕</button>${renderMovieHero(lib,path,meta)}<section><h3>演职人员</h3><div class="movie-detail-strip">${cast}</div></section><section><h3>视频推荐</h3><div class="movie-detail-strip">${rec}</div></section><section><h3>视频元数据</h3><dl class="movie-meta-list"><dt>文件</dt><dd>${esc(path)}</dd><dt>年份</dt><dd>${esc(meta.year||"--")}</dd><dt>类型</dt><dd>${esc((meta.genres||[]).join(" / ")||"--")}</dd><dt>时长</dt><dd>${meta.runtime?esc(meta.runtime+" 分钟"):"--"}</dd><dt>TMDB 评分</dt><dd>${meta.rating?esc(meta.rating.toFixed(1)):"--"}</dd><dt>来源</dt><dd>${esc(meta.provider||"文件名")}</dd></dl></section></div></div>`;}
function renderMoviePoster(lib, file) { const path=String(file.path), meta=movieMetadataFor(path), watched=!!meta.watched||movieFlag("watched",lib.id,path), art=meta.poster ? `<img src="${esc(meta.poster)}" alt="${esc(meta.title)}" loading="lazy">` : `<span>${esc(meta.title)}</span>`; return `<article class="media-poster-card ${watched?"is-read":""}" data-media-group="movie" data-media-library="${esc(lib.id)}" data-media-path="${esc(path)}" onclick="openMovieDetails(${jsAttrArg(lib.id)},${jsAttrArg(path)})"><div class="media-poster-art" style="${meta.poster ? "" : `background:${coverGradient(meta.title)}`}" >${art}<button class="movie-poster-settings" data-movie-settings title="观看状态" onclick="event.stopPropagation();toggleMovieWatched(${jsAttrArg(lib.id)},${jsAttrArg(path)},this)">${watched?"✓ 已观看":"○ 未观看"}</button></div><div class="media-poster-info"><strong>${esc(meta.title)}</strong><small>${esc([meta.year,meta.provider].filter(Boolean).join(" · ") || fileExt(path).toUpperCase())}</small></div></article>`; }
function scrapeSeriesMetadata(host, lib, files) { return scrapeMovieMetadata(host, lib, files); }
function toggleMediaResourceView(group) { mediaResourceView = mediaResourceView === "poster" ? "list" : "poster"; try { localStorage.setItem("vaulthub_media_resource_view",mediaResourceView); } catch(e) {} const lib=findMediaLibrary(localMediaSelection[group]); if(lib) loadLocalFiles(group,lib,group === "audio" ? audioCursor : 0); }
function refreshMovieMetadata() { try { localStorage.removeItem(movieMetadataCache); } catch(e) {} const lib=findMediaLibrary(localMediaSelection.movie); if(lib) loadLocalFiles("movie", lib, 0); toast("🔄 正在重新刮削影视信息"); }

function mediaStateKey(libId, path) { return `vaulthub_reading_${libId}_${path}`; }
/* v0.9.30：阅读进度改为服务端持久化（/api/media/reading/progress）。
   localStorage 仍然写一份，用于换页/离线时的即时渲染，但真正的权威值来自
   服务端；否则换浏览器或清缓存后进度全丢，表现为「关闭后回到第一页」。
   渲染路径（renderBookCard 等）是同步的，所以服务端值先拉进内存缓存。 */
const readingProgressCache = {};   // libId -> { path: progress }
const readingProgressLoaded = {};  // libId -> Promise
let readingProgressFlushTimer = null;
const readingProgressPending = new Map(); // `${libId}\n${path}` -> progress
function readingState(libId, path) {
  const remote = readingProgressCache[libId];
  if (remote && Object.prototype.hasOwnProperty.call(remote, path)) return { progress: Number(remote[path]) || 0 };
  try { return JSON.parse(localStorage.getItem(mediaStateKey(libId, path))) || { progress: 0 }; } catch (e) { return { progress: 0 }; }
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
      for (const [path, item] of Object.entries(data.items || {})) map[path] = Number(item?.progress) || 0;
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
  for (const [key, progress] of items) {
    const [libId, path] = key.split("\n");
    fetch(`/api/media/reading/progress?id=${encodeURIComponent(libId)}&path=${encodeURIComponent(path)}`, {
      method: "PUT",
      headers: sessionWriteHeaders(true),
      credentials: "same-origin",
      body: JSON.stringify({ progress })
    }).catch(() => {});
  }
}
function saveReadingProgress(libId, path, progress) {
  const value = Math.max(0, Math.min(100, Number(progress) || 0));
  try { localStorage.setItem(mediaStateKey(libId, path), JSON.stringify({ progress: value, updatedAt: Date.now() })); } catch (e) {}
  if (!readingProgressCache[libId]) readingProgressCache[libId] = {};
  readingProgressCache[libId][path] = value;
  /* 滚动会高频触发，合并 800ms 内的写入，避免刷爆后端。 */
  readingProgressPending.set(`${libId}\n${path}`, value);
  if (!readingProgressFlushTimer) readingProgressFlushTimer = setTimeout(flushReadingProgress, 800);
  return value;
}
function flushReadingProgressNow() {
  if (readingProgressFlushTimer) { clearTimeout(readingProgressFlushTimer); readingProgressFlushTimer = null; }
  if (readingProgressPending.size) flushReadingProgress();
}
function setComicShelfView(view) {
  comicShelfView = view === "completed" ? "completed" : "shelf";
  const lib = findMediaLibrary(localMediaSelection.comic);
  if (lib) loadLocalFiles("comic", lib, 0);
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
  audioView = ["albums", "artists", "files", "favorites", "tracks"].includes(view) ? view : "albums";
  if (view !== "tracks") audioTrackTitle = "";
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
function supportedLocalMediaFile(group, lib, path) {
  const ext = fileExt(path);
  if (!ext) return false;
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
      body: JSON.stringify({ library_id: String(lib.id), path: String(path), quality, hardware: settings.hardwareAcceleration || "auto", client: browserPlaybackCapabilities() }),
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`播放计划 HTTP ${response.status}`);
    return await response.json();
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("播放计划请求超时（20s），已转用本地降级策略");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
function playbackModeLabel(plan) {
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
    paths: Array.isArray(lib.paths) ? lib.paths.map(String) : (lib.path ? [String(lib.path)] : []),
    files: Array.isArray(lib.files) ? lib.files : null
  }));
}
async function refreshMediaLibraries(notify) {
  try {
    const res = await fetch("/api/media/libraries", { headers: sessionWriteHeaders(), cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    localMediaLibraries = normalizeLibraryPayload(await res.json());
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
function normalizeFilePayload(data) {
  const files = Array.isArray(data) ? data : (data?.files || data?.items || []);
  return files.map(item => typeof item === "string" ? { path: item } : item).filter(item => item?.path);
}
async function fetchAllLibraryFiles(libId, firstPage, firstOffset = 0) {
  const files = normalizeFilePayload(firstPage);
  let offset = firstOffset + files.length;
  while (firstPage.has_more) {
    const res = await fetch(`/api/media/files?id=${encodeURIComponent(libId)}&offset=${offset}&limit=500`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const page = await res.json();
    const list = normalizeFilePayload(page);
    files.push(...list);
    if (!page.has_more || !list.length) break;
    const nextOffset = offset + list.length;
    if (nextOffset <= offset) throw new Error("媒体列表分页游标未前进");
    offset = nextOffset;
    firstPage = page;
  }
  return files;
}
/* 影视库和剧集聚合统一加载全部索引，不显示固定数量分页。 */
async function fetchRemainingLibraryFiles(libId, startOffset) {
  return { files: await fetchAllLibraryFiles(libId, { has_more: true }, startOffset), truncated: false };
}
async function loadLocalFiles(group, lib, offset = 0) {
  const target = document.getElementById("local-media-content-" + group);
  if (!target) return;
  try {
    const pageSize = group === "comic" ? (comicShelfView === "completed" ? 100000 : mediaPageSize) : group === "audio" ? audioPageSize : group === "movie" ? 500 : 100;
    const res = await fetch(`/api/media/files?id=${encodeURIComponent(lib.id)}&offset=${offset}&limit=${pageSize}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    let files = normalizeFilePayload(data).sort((a, b) => String(a.path).localeCompare(String(b.path), "zh-CN"));
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
    if (group === "movie" && data.has_more) {
      const rest = await fetchRemainingLibraryFiles(lib.id, offset + normalizeFilePayload(data).length);
      const extra = rest.files.filter(file => supportedLocalMediaFile(group, lib, String(file.path)));
      files = files.concat(extra).sort((a, b) => String(a.path).localeCompare(String(b.path), "zh-CN"));
      mediaTruncated = rest.truncated;
      data.has_more = false;
    }
    if (group === "comic") {
      files = files.filter(file => {
        const progress = Number(readingState(lib.id, String(file.path)).progress || 0);
        return comicShelfView === "completed" ? progress >= COMPLETED_PROGRESS : progress < COMPLETED_PROGRESS;
      });
    }
    const prev = offset > 0 ? `<button class="btn" onclick="loadLocalFiles('${esc(group)}',findMediaLibrary('${esc(lib.id)}'),${Math.max(0, offset - pageSize)})">← 上一页</button>` : "";
    const next = data.has_more ? `<button class="btn" onclick="loadLocalFiles('${esc(group)}',findMediaLibrary('${esc(lib.id)}'),${offset + pageSize})">下一页 →</button>` : "";
    /* 过滤后可能一条不剩（例如整页都是已读，或整页都是不支持的扩展名）。
       此时旧写法会算出「1-0 / 848」这种不成立的区间，改为显式提示本页为空。 */
    const total = Number(data.total) || files.length;
    const range = files.length ? `${offset + 1}-${offset + files.length}` : "本页无匹配";
    const seriesAllLoaded = group === "movie";
    const pager = seriesAllLoaded
      ? `<div class="media-actions"><span class="media-file-meta">已加载全部 ${files.length} / ${total} 项${mediaTruncated ? "（加载未完成）" : ""}</span></div>`
      : `<div class="media-actions">${prev}<span class="media-file-meta">${range} / ${total}</span>${next}</div>`;
    if (group === "comic") {
      const toolbar = mediaLibraryHeading(lib, "", `<div class="comic-shelf-tabs"><button class="${comicShelfView === "completed" ? "active" : ""}" onclick="setComicShelfView(comicShelfView === \"completed\" ? \"shelf\" : \"completed\")">${comicShelfView === "completed" ? "← 返回未读" : "✓ 已读收藏"}</button></div>`);
      const emptyTip = comicShelfView === "completed"
        ? "还没有读完的书；读完的书籍会自动归档到这里。"
        : (data.has_more ? "本页书籍都已读完，点击「下一页 →」继续查看未读书籍。" : "该媒体库暂无未读书籍。");
      target.innerHTML = `${toolbar}${files.length ? `<div class="book-grid">${files.map(file => renderBookCard(group, lib, file)).join("")}</div>` : `<div class="empty-tip">${esc(emptyTip)}</div>`}${pager}`;
      scrapeVisibleBookCovers(target);
    } else if (group === "audio") {
      audioFiles = files;
      audioCursor = offset;
      target.innerHTML = renderAudioLibrary(lib, files, data);
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
  try { return JSON.parse(localStorage.getItem(audioMetadataCache) || "{}") || {}; } catch (e) { return {}; }
}
function writeAudioMetadata(data) {
  try { localStorage.setItem(audioMetadataCache, JSON.stringify(data)); } catch (e) {}
}
function audioBaseMetadata(path) {
  /* 先用原始文件名解析「歌手 - 歌名」，displayBookTitle 会把连字符换成空格，
     直接拿它切分会丢掉歌手信息。 */
  const raw = String(path).split("/").pop().replace(/\.[^.]+$/, "").trim();
  const parts = raw.split(/\s+-\s+|\s*-\s*/).map(x => x.trim()).filter(Boolean);
  const stem = displayBookTitle(path);
  if (parts.length > 1) {
    return { title: parts.slice(1).join(" - "), artist: parts[0], album: "未知专辑", cover: "", lyrics: "" };
  }
  return { title: stem, artist: "未知歌手", album: "未知专辑", cover: "", lyrics: "" };
}

function audioMetadataFor(path) {
  const all = readAudioMetadata();
  return { ...audioBaseMetadata(path), ...(all[path] || {}) };
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
async function scrapeAudioMetadata(host, lib, files) {
  const all = readAudioMetadata();
  const pending = files.filter(file => !all[file.path]);
  for (const file of pending) {
    const meta = audioBaseMetadata(String(file.path));
    meta.checkedAt = Date.now();
    all[file.path] = meta;
  }
  writeAudioMetadata(all);
  if (pending.length) renderAudioLibraryContent(host, lib, files);
  for (const file of pending) {
    const path = String(file.path), fallback = all[path];
    const known = fallback.artist && fallback.artist !== "未知歌手";
    try {
      const response = await fetch(`/api/media/audio/metadata?title=${encodeURIComponent(fallback.title)}&artist=${encodeURIComponent(known?fallback.artist:"")}`, { cache: "force-cache" });
      const item = response.ok ? await response.json() : null;
      if (item) {
        all[path] = {
          ...fallback,
          title: item.title || fallback.title,
          artist: item.artist || fallback.artist,
          album: item.album || fallback.album,
          cover: item.cover || fallback.cover || "",
          provider: item.provider || "MusicBrainz",
          checkedAt: Date.now(),
        };
        writeAudioMetadata(all); renderAudioLibraryContent(host, lib, files);
      }
    } catch (e) { /* Keep filename-derived metadata when scraping is unavailable. */ }
  }
}
function audioCoverData(meta, title) {
  return meta.cover ? `<img src="${esc(meta.cover)}" alt="${esc(title)}" onerror="this.replaceWith(Object.assign(document.createElement('span'),{textContent:${JSON.stringify(title)}}))">` : esc(title);
}
function renderAudioAlbums(lib, files) {
  const groups = new Map();
  files.forEach(file => { const meta = audioMetadataFor(String(file.path)); const key = meta.album || "未知专辑"; if (!groups.has(key)) groups.set(key, { meta, files: [] }); groups.get(key).files.push(file); });
  return `<div class="audio-album-grid">${[...groups.entries()].map(([album, group]) => `<article class="audio-album-card" onclick="openAudioTracks('${esc(lib.id)}','album',${esc(JSON.stringify(album))})"><div class="audio-album-cover" style="background:${coverGradient(album)}">${audioCoverData(group.meta, album)}</div><div class="audio-album-info"><strong>${esc(album)}</strong><small>${esc(group.meta.artist)} · ${group.files.length} 首</small><div class="media-actions"><button class="btn" title="喜欢专辑" onclick="event.stopPropagation();toggleAudioFavorite(${jsAttrArg(lib.id)},${jsAttrArg(group.files[0].path)})">${isAudioFavorite(lib.id, group.files[0].path) ? "♥" : "♡"}</button><button class="btn" title="查看专辑曲目" onclick="event.stopPropagation();openAudioTracks('${esc(lib.id)}','album',${esc(JSON.stringify(album))})">▶ 曲目</button></div></div></article>`).join("")}</div>`;
}
function renderAudioArtists(lib, files) {
  const groups = new Map();
  files.forEach(file => { const meta = audioMetadataFor(String(file.path)); const key = meta.artist || "未知歌手"; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(file); });
  return `<div class="audio-album-grid">${[...groups.entries()].map(([artist, songs]) => `<article class="audio-album-card" onclick="openAudioTracks('${esc(lib.id)}','artist',${esc(JSON.stringify(artist))})"><div class="audio-album-cover" style="background:${coverGradient(artist)}">${esc(artist)}</div><div class="audio-album-info"><strong>${esc(artist)}</strong><small>${songs.length} 首歌曲</small><div class="media-actions"><button class="btn" title="喜欢歌手" onclick="event.stopPropagation();toggleAudioFavorite(${jsAttrArg(lib.id)},${jsAttrArg(songs[0].path)})">${isAudioFavorite(lib.id, songs[0].path) ? "♥" : "♡"}</button><button class="btn" title="查看歌手歌曲" onclick="event.stopPropagation();openAudioTracks('${esc(lib.id)}','artist',${esc(JSON.stringify(artist))})">▶ 曲目</button></div></div></article>`).join("")}</div>`;
}
let audioArtistFilter = "";
function openAudioTracks(libId, kind, key) {
  audioArtistFilter = String(key);
  audioTrackTitle = String(key);
  audioView = "tracks";
  const lib = findMediaLibrary(libId);
  if (lib) loadLocalFiles("audio", lib, 0);
}
function renderAudioTrackList(lib, files) {
  const loopLabel = { sequence: "顺序", list: "循环", single: "单曲", random: "随机" }[audioLoopMode] || "顺序";
  return `<div class="audio-track-head"><button class="btn" onclick="audioTrackTitle='';setAudioView('albums')">← 返回</button><strong>${esc(audioTrackTitle)}</strong><span class="media-file-meta">${files.length} 首</span><div class="audio-view-tabs"><button class="${audioLoopMode === "random" ? "active" : ""}" onclick="setAudioLoop('random')">随机循环</button><button class="${audioLoopMode === "list" ? "active" : ""}" onclick="setAudioLoop('list')">列表循环</button><button class="${audioLoopMode === "sequence" ? "active" : ""}" onclick="setAudioLoop('sequence')">顺序播放</button></div></div><div class="media-file-list">${files.map(file => renderAudioRow(lib, file)).join("")}</div>`;
}
function renderAudioLibraryContent(host, lib, files) {
  const latest = [...files].sort((a, b) => Number(b.mtime || 0) - Number(a.mtime || 0)).slice(0, 8);
  const pager = `<div class="media-actions"><button class="btn" ${audioCursor <= 0 ? "disabled" : ""} onclick="loadLocalFiles('audio',findMediaLibrary('${esc(lib.id)}'),${Math.max(0,audioCursor-audioPageSize)})">← 上一页</button><span class="media-file-meta">${audioCursor + 1}-${audioCursor + files.length}</span><button class="btn" onclick="loadLocalFiles('audio',findMediaLibrary('${esc(lib.id)}'),${audioCursor + audioPageSize})">下一页 →</button></div>`;
  const visibleFiles = audioArtistFilter ? files.filter(file => { const meta = audioMetadataFor(String(file.path)); return meta.artist === audioArtistFilter || meta.album === audioArtistFilter; }) : files;
  let body = audioView === "tracks" ? renderAudioTrackList(lib, visibleFiles) : audioView === "artists" ? renderAudioArtists(lib, files) : audioView === "favorites" ? renderAudioFavorites(lib) : renderAudioAlbums(lib, files);
  const latestGrid = audioView === "albums" && latest.length ? `<section class="content-collection latest-music"><div class="content-section-heading"><div><span class="eyebrow">最新音乐</span><h3>最近识别与入库</h3></div></div><div class="audio-latest-grid">${latest.map(file => renderAudioLatestCard(lib, file)).join("")}</div></section>` : "";
  const audioTabs = `<div class="audio-view-tabs"><button class="${audioView === "albums" ? "active" : ""}" onclick="setAudioView('albums')">专辑</button><button class="${audioView === "artists" ? "active" : ""}" onclick="setAudioView('artists')">歌手</button><button class="${audioView === "favorites" ? "active" : ""}" onclick="setAudioView('favorites')">♥ 喜欢</button><label class="page-size-picker">每页 <select id="audioPageSize" onchange="setAudioPageSize(this.value)"><option value="20"${audioPageSize===20?' selected':''}>20</option><option value="50"${audioPageSize===50?' selected':''}>50</option><option value="100"${audioPageSize===100?' selected':''}>100</option></select></label></div>`;
  host.innerHTML = `<section class="content-collection">${mediaLibraryHeading(lib, "", audioTabs)}${body}${audioView === "favorites" || audioView === "tracks" ? "" : pager}</section>${latestGrid}`;
}
function renderAudioLatestCard(lib, file) { const path=String(file.path), meta=audioMetadataFor(path); return `<article class="audio-latest-card" onclick="playAudioFile(${jsAttrArg(lib.id)},${jsAttrArg(path)})"><div class="audio-latest-cover" style="background:${coverGradient(meta.title)}">${audioCoverData(meta, meta.title)}</div><div><strong>${esc(meta.title)}</strong><small>${esc(meta.artist)}</small></div><button class="btn" title="喜欢" onclick="event.stopPropagation();toggleAudioFavorite(${jsAttrArg(lib.id)},${jsAttrArg(path)})">${isAudioFavorite(lib.id,path)?"♥":"♡"}</button></article>`; }
function renderAudioLibrary(lib, files) { const host = document.createElement("div"); renderAudioLibraryContent(host, lib, files); return host.innerHTML; }
function renderAudioRow(lib, file) { const meta = audioMetadataFor(String(file.path)); return `<div class="media-file-row"><div class="media-file-name" title="${esc(file.path)}"><b>${esc(meta.title)}</b><small>${esc(meta.artist)} · ${esc(meta.album)}</small></div><span class="media-file-meta">${esc(fileExt(file.path).toUpperCase())}</span><div class="media-actions"><button class="btn" onclick="playAudioFile(${jsAttrArg(lib.id)},${jsAttrArg(file.path)})">▶</button><button class="btn" title="喜欢" onclick="toggleAudioFavorite(${jsAttrArg(lib.id)},${jsAttrArg(file.path)})">${isAudioFavorite(lib.id, file.path) ? "♥" : "♡"}</button><button class="btn" onclick="openAudioMetadata(${jsAttrArg(file.path)})">✎</button></div></div>`; }
function refreshAudioMetadata() { try { localStorage.removeItem(audioMetadataCache); } catch (e) {} const lib = findMediaLibrary(localMediaSelection.audio); if (lib) loadLocalFiles("audio", lib, 0); toast("🔄 正在重新刮削音乐信息"); }
function openAudioMetadata(path) { const meta = audioMetadataFor(path); document.getElementById("audioMetadataPath").value=path; document.getElementById("audioMetadataTitle").value=meta.title; document.getElementById("audioMetadataArtist").value=meta.artist; document.getElementById("audioMetadataAlbum").value=meta.album; document.getElementById("audioMetadataCover").value=meta.cover; document.getElementById("audioMetadataLyrics").value=meta.lyrics; openModal("audioMetadataModal"); }
function manualAudioMetadata(path) { openAudioMetadata(path); }
function saveManualAudioMetadata() { const path=document.getElementById("audioMetadataPath").value, all=readAudioMetadata(); all[path]={title:document.getElementById("audioMetadataTitle").value.trim()||audioBaseMetadata(path).title,artist:document.getElementById("audioMetadataArtist").value.trim()||"未知歌手",album:document.getElementById("audioMetadataAlbum").value.trim()||"未知专辑",cover:document.getElementById("audioMetadataCover").value.trim(),lyrics:document.getElementById("audioMetadataLyrics").value}; writeAudioMetadata(all); closeModal("audioMetadataModal"); const lib=findMediaLibrary(localMediaSelection.audio); if(lib) loadLocalFiles("audio",lib,audioCursor); }
let audioLoopMode = "sequence";
let audioMaximized = false;
const AUDIO_LOOP_ORDER = ["sequence", "list", "single", "random"];
const AUDIO_LOOP_LABEL = { sequence: "顺序", list: "列表循环", single: "单曲循环", random: "随机播放" };
function setAudioLoop(mode) {
  audioLoopMode = AUDIO_LOOP_ORDER.includes(mode) ? mode : "sequence";
  const button = document.getElementById("audioLoopButton");
  if (button) { button.title = "播放模式：" + AUDIO_LOOP_LABEL[audioLoopMode]; button.textContent = { sequence: "🔁", list: "🔁", single: "🔂", random: "🔀" }[audioLoopMode]; }
  const lib = findMediaLibrary(localMediaSelection.audio);
  if (lib && audioView === "tracks") loadLocalFiles("audio", lib, audioCursor);
}
function cycleAudioLoop() { setAudioLoop(AUDIO_LOOP_ORDER[(AUDIO_LOOP_ORDER.indexOf(audioLoopMode) + 1) % AUDIO_LOOP_ORDER.length]); toast("🔁 " + AUDIO_LOOP_LABEL[audioLoopMode]); }
function toggleAudioMaximize() {
  const player = document.getElementById("audio-bottom-player"); if (!player) return;
  audioMaximized = !audioMaximized;
  player.classList.toggle("maximized", audioMaximized);
  const button = document.getElementById("audioMaximizeButton");
  if (button) { button.textContent = audioMaximized ? "🗗" : "⛶"; button.title = audioMaximized ? "还原" : "最大化"; }
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
function renderPlayerLyrics(meta) {
  const el = document.getElementById("audioPlayerLyrics"); if (!el) return;
  const lines = parseLyrics(meta.lyrics);
  el.innerHTML = lines.length ? lines.map((line, i) => `<span class="lyric-line" data-time="${line.time}" data-index="${i}">${esc(line.text)}</span>`).join("\n") : "";
}
function seekLyric(event) {
  const line = event.target.closest("[data-time]");
  const player = document.getElementById("audioPlayerElement");
  if (line && player && Number.isFinite(Number(line.dataset.time))) player.currentTime = Number(line.dataset.time);
}
function updateLyricHighlight() {
  const el = document.getElementById("audioPlayerLyrics"), player = document.getElementById("audioPlayerElement");
  if (!el || !player) return;
  const lines = el.querySelectorAll(".lyric-line");
  if (!lines.length) return;
  const current = player.currentTime || 0;
  let activeIndex = -1;
  lines.forEach((line, i) => { if (Number(line.dataset.time) <= current) activeIndex = i; });
  lines.forEach((line, i) => line.classList.toggle("active", i === activeIndex));
}
function playAudioFile(libId, path) {
  const lib = findMediaLibrary(libId), player = document.getElementById("audioPlayerElement"); if (!lib || !player) return;
  const index = audioFiles.findIndex(file => String(file.path) === String(path));
  activeAudio = { libId, path, index: index < 0 ? 0 : index };
  const meta = audioMetadataFor(path);
  player.src = mediaFileUrl(lib, path);
  player.onerror = () => { toast("⚠️ 无法加载音频：文件不存在或路径含特殊字符"); document.getElementById("audioPlayerMeta").textContent = "加载失败，请检查文件路径"; };
  player.play().catch(() => {});
  const bar = document.getElementById("audio-bottom-player");
  bar.classList.add("show");
  bar.classList.toggle("show", document.getElementById("view-audio")?.classList.contains("active"));
  document.getElementById("audioPlayerTitle").textContent = meta.title;
  document.getElementById("audioPlayerMeta").textContent = `${meta.artist} · ${meta.album}`;
  const cover = document.getElementById("audioCover");
  cover.src = meta.cover || ""; cover.alt = `${meta.title} 海报`; cover.style.background = meta.cover ? "" : coverGradient(meta.title);
  document.getElementById("audioPauseButton").textContent = "Ⅱ";
  renderPlayerLyrics(meta);
  updateAudioFavoriteButton();
}
function audioTogglePause() { const player=document.getElementById("audioPlayerElement"); if(!player?.src) return; if(player.paused) { player.play().catch(() => {}); document.getElementById("audioPauseButton").textContent="Ⅱ"; } else { player.pause(); document.getElementById("audioPauseButton").textContent="▶"; } }
function audioStop() { const player=document.getElementById("audioPlayerElement"); if(!player) return; player.pause(); player.currentTime=0; player.removeAttribute("src"); player.load(); activeAudio=null; document.getElementById("audio-bottom-player")?.classList.remove("show"); document.getElementById("audioPauseButton").textContent="▶"; }
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
function showAudioDetails() { if(!activeAudio) return; const meta=audioMetadataFor(activeAudio.path); document.getElementById("audioDetailsContent").innerHTML=`<h4>${esc(meta.title)}</h4><p>${esc(meta.artist)} · ${esc(meta.album)}</p>${meta.lyrics ? `<pre class="audio-lyrics">${esc(meta.lyrics)}</pre>` : '<div class="empty-tip">暂无歌词，可通过“文件”视图的手动适配填写。</div>'}`; openModal("audioDetailsModal"); }
document.getElementById("audioPlayerElement")?.addEventListener("ended", audioNext);
document.getElementById("audioPlayerElement")?.addEventListener("timeupdate", updateLyricHighlight);

function renderLocalFileRow(group, lib, file) {
  const path = String(file.path);
  const ext = fileExt(path);
  const viewable = ["mp3","flac","m4a","ogg","wav","jpg","jpeg","png","webp","gif","txt","pdf","mp4","m4v","webm","mov"].includes(ext);
  const archiveLike = [...MEDIA_FORMATS.comic, ...MEDIA_FORMATS.book].includes(ext);
  const action = group === "movie" && MEDIA_FORMATS.movie.includes(ext) ? "播放" : viewable ? "查看" : (archiveLike ? "打开" : "下载");
  return `<div class="media-file-row"><div class="media-file-name" title="${esc(path)}">${esc(path)}</div><span class="media-file-meta">${esc(ext.toUpperCase() || "FILE")} · ${formatFileSize(file.size)}</span><button class="btn" data-media-group="${esc(group)}" data-media-library="${esc(lib.id)}" data-media-path="${esc(path)}" onclick="openLocalMediaButton(this)">${action}</button></div>`;
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
function readCoverCache() {
  try { return JSON.parse(localStorage.getItem(coverScrapeCache)) || {}; } catch (e) { return {}; }
}
function writeCoverCache(cache) {
  try { localStorage.setItem(coverScrapeCache, JSON.stringify(cache)); } catch (e) {}
}
function coverSearchTitle(title) {
  return String(title).replace(/[（(][^）)]*(?:全本|未删节|完结|全集)[^）)]*[）)]/g, " ").replace(/第?\s*\d+\s*[卷册部]/g, " ").replace(/\s+/g, " ").trim();
}
function bookCoverFallback(img) { img.removeAttribute("src"); img.classList.remove("loaded"); img.hidden = true; }
async function scrapeBookCover(img) {
  const title = coverSearchTitle(img.dataset.coverTitle || ""); if (!title) return;
  const cache = readCoverCache(), key = title.toLowerCase(), cached = cache[key];
  if (cached?.url) { img.hidden=false; img.src=cached.url; return; }
  if (cached?.checkedAt && Date.now()-cached.checkedAt < 86400000) return;
  let coverUrl = "";
  /* 漫画首选国内 Bangumi 元数据源，失败后继续使用国际书目源。 */
  try {
    const bgm = await fetch("https://api.bgm.tv/v0/search/subjects", { method:"POST", headers:{"Content-Type":"application/json","User-Agent":"VaultHub/0.6.9"}, body:JSON.stringify({ keyword:title, sort:"match", filter:{ type:[1], nsfw:false } }), cache:"force-cache" });
    if (bgm.ok) {
      const data = await bgm.json();
      const item = data?.data?.find(entry => entry?.images?.large || entry?.images?.common || entry?.images?.medium);
      coverUrl = item?.images?.large || item?.images?.common || item?.images?.medium || "";
    }
  } catch (e) {}
  try {
    const google = await fetch(`https://www.googleapis.com/books/v1/volumes?q=intitle:${encodeURIComponent(title)}&maxResults=3&printType=books`, { cache:"force-cache" });
    if (google.ok) {
      const data = await google.json();
      const links = data?.items?.map(item => item?.volumeInfo?.imageLinks).find(Boolean);
      coverUrl = links?.thumbnail || links?.smallThumbnail || "";
      if (coverUrl) coverUrl = coverUrl.replace(/^http:/,"https:").replace(/&zoom=\d/,"&zoom=2");
    }
  } catch (e) {}
  if (!coverUrl) try {
    const res = await fetch(`https://openlibrary.org/search.json?title=${encodeURIComponent(title)}&fields=cover_i,title&limit=3`, { cache:"force-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json(), coverId = data?.docs?.find(doc => doc.cover_i)?.cover_i;
    coverUrl = coverId ? `https://covers.openlibrary.org/b/id/${coverId}-L.jpg` : "";
  } catch (e) {}
  cache[key] = { url:coverUrl, checkedAt:Date.now() }; writeCoverCache(cache);
  if (coverUrl) { img.hidden=false; img.src=coverUrl; }
}
function refreshBookCovers() {
  try { localStorage.removeItem(coverScrapeCache); } catch (e) {}
  const target=document.getElementById("local-media-content-comic");
  if (target) { target.querySelectorAll(".book-cover-image").forEach(bookCoverFallback); scrapeVisibleBookCovers(target); }
  toast("🔄 正在重新刮削封面");
}
function scrapeVisibleBookCovers(host) {
  const images = [...host.querySelectorAll("img[data-cover-title]")];
  let cursor=0; const worker=async()=>{ while(cursor<images.length) await scrapeBookCover(images[cursor++]); };
  Promise.all(Array.from({length:Math.min(4,images.length)},worker));
}
function renderBookCard(group, lib, file) {
  const path = String(file.path), title = displayBookTitle(path), ext = fileExt(path).toUpperCase() || "BOOK";
  const progress = Number(readingState(lib.id, path).progress || 0);
  return `<article class="book-card" data-media-group="${esc(group)}" data-media-library="${esc(lib.id)}" data-media-path="${esc(path)}" onclick="openLocalMediaButton(this)"><div class="book-cover" style="background:${coverGradient(title)}"><span class="book-cover-title">${esc(title)}</span><img class="book-cover-image" data-cover-title="${esc(title)}" alt="${esc(title)} 封面" hidden onload="this.hidden=false;this.classList.add('loaded')" onerror="bookCoverFallback(this)"></div><div class="book-card-title" title="${esc(path)}">${esc(title)}</div><div class="book-card-meta"><span>${esc(ext)}</span><span>${progress ? progress.toFixed(1)+"%" : "新入书架"}</span></div><div class="book-progress"><span style="width:${Math.min(100,progress)}%"></span></div></article>`;
}
function openLocalMediaButton(button) {
  openLocalMedia(button.dataset.mediaGroup, button.dataset.mediaLibrary, button.dataset.mediaPath);
}
function findMediaLibrary(id) { return localMediaLibraries.find(lib => lib.id === id); }
function readerThemeClass() {
  return settings.theme === "light" ? "reader-theme-light" : settings.theme === "custom" ? "reader-theme-custom" : "reader-theme-dark";
}
function viewerShell(group, lib, path, body, url, opts = {}) {
  const chapters = opts.chapters || [];
  const chapterHtml = chapters.length ? `<aside class="ebook-chapters"><h4>目录 · ${chapters.length} 章</h4>${chapters.map((ch, i) => `<button data-chapter="${i}" onclick="jumpEbookChapter(${i})">${esc(ch.title)}</button>`).join("")}</aside>` : "";
  const toolbar = opts.ebook ? `<span class="ebook-toolbar"><button title="减小字号" onclick="changeEbookFontSize(-1)">A-</button><button title="增大字号" onclick="changeEbookFontSize(1)">A+</button><button id="ebookFontStyleButton" title="正体/斜体" onclick="toggleEbookFontStyle()">正体</button></span>` : "";
  const video = group === "movie";
  /* v0.9.51：真正的视频播放器（opts.player）不再渲染外层标题条与 ✕ —— 标题已移入
     播放器左上角 ⌄ 右侧（vc-heading），关闭统一走底部控制栏的 ✕。movie 组里的
     PDF/图片等非视频浏览仍保留外层头（标题 + ✕ 关闭）。文档/音频类阅读器同理。 */
  const head = opts.player ? "" : `<div class="media-reader-head"><strong class="media-reader-title" title="${esc(path)}">${esc(displayBookTitle(path))}</strong><div class="media-actions">${toolbar}<button class="btn" onclick="markReaderCompleted()">✓ 标记已读</button><button class="media-reader-close" title="关闭并返回书架" onclick="closeLocalViewer('${esc(group)}')">✕</button></div></div>`;
  /* v0.9.30：文档类阅读器（TXT 正文、ZIP 漫画整页）标记 reader-doc，
     让正文区改成内容驱动高度并跟随主题上色，避免纸张只有一屏、
     其余正文落在深色底上，以及漫画页左右露出下层底色。
     PDF/图片/音频仍用固定一屏高度（iframe 需要 height:100%）。 */
  const doc = !opts.player && opts.doc === true;
  return `<div class="media-reader-overlay ${readerThemeClass()}${doc ? " reader-doc" : ""}${opts.player ? " movie-player" : ""}">${head}<div class="media-reader-body" data-reader-scroll onscroll="trackReaderProgress(this)">${chapterHtml}<div class="media-reader-wrap">${body}</div></div></div>`;
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
  const textLen = window.__ebookTextLength || 1;
  scroller.scrollTop = Math.max(0, Math.min(max, chapter.offset / textLen * max));
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
function markReaderCompleted() {
  if (!activeReader) return;
  saveReadingProgress(activeReader.libId, activeReader.path, 100);
  toast("✅ 已归档到已读收藏");
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
  const el = root?.querySelector(".movie-compat-status");
  if (el) el.textContent = text;
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
/* 左上角 ⌄：将整个播放器最小化为小窗（v0.9.51）。v0.9.51 只折叠控制栏，
   用户期望的是最小化整个播放器 —— 现在折叠态把播放器缩成右下角小窗，
   左下角 ⌃ 用于还原整屏播放器。 */
function minimizeVideoPlayer(el) {
  const root = videoRootOf(el);
  if (!root) return;
  /* v0.9.51：全屏状态下点最小化会同时处于「浏览器全屏 + 小窗」两种布局，
     小窗被全屏容器约束会错位。先退出全屏再缩成小窗。 */
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  const overlay = root.closest(".media-reader-overlay.movie-player");
  if (overlay) overlay.classList.add("video-minimized");
  clearTimeout(root.__videoChromeTimer);
  root.dataset.videoChromeCollapsed = "true";
  hideVideoChrome(root);
  root.querySelector(".video-chrome")?.classList.add("video-chrome-minimized");
}
function expandVideoPlayer(el) {
  const root = videoRootOf(el);
  if (!root) return;
  const overlay = root.closest(".media-reader-overlay.movie-player");
  if (overlay) overlay.classList.remove("video-minimized");
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
  if (video.paused) video.play().catch(() => {}); else video.pause();
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
  const id=root?.dataset.playbackSession; if(!id)return;
  fetch(`/api/media/playback/sessions/${encodeURIComponent(id)}/stop`,{method:'POST',credentials:'same-origin',keepalive:true}).catch(()=>{}); root.dataset.playbackSession='';
}
function bindVideoStatus(root, video) {
  [["loadstart","正在连接"],["waiting","正在缓冲"],["playing","正在播放"],["pause","已暂停"],["ended","播放完成"],["stalled","网络等待"],["error","播放错误"]].forEach(([ev,label])=>video.addEventListener(ev,()=>{updateVideoStatus(root,video,label);if(['pause','ended'].includes(ev))reportVideoPlaybackSession(root,video,ev);}));
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
  video.addEventListener("pause", () => { syncVideoChromeState(root, video); if (!videoChromeCollapsed(root)) { root.classList.add("video-controls-visible"); root.dataset.videoControlsVisible = "true"; } });
  video.addEventListener("play", () => { syncVideoChromeState(root, video); scheduleVideoChromeHide(root); });
  video.addEventListener("volumechange", () => syncVideoVolumeUI(root, video));
  video.addEventListener("ended", () => videoPlaybackEnded(root, video));
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
  fetch(`/api/media/metadata?id=${encodeURIComponent(lib.id)}&path=${encodeURIComponent(path)}`,{cache:'no-store'}).then(r=>r.ok?r.json():null).then(meta=>{if(meta&&(meta.title||meta.year||meta.show_title)){const all=readMovieMetadata();all[path]={...movieMetadataFor(path),...meta};writeMovieMetadata(all);applyVideoChromeTitle(videoRoot,lib,path);}if(meta?.subtitles?.length){const box=videoRoot.querySelector('[data-video-subtitle-options]');if(box)box.innerHTML=meta.subtitles.map((s,i)=>`<button type="button" onclick="attachVideoSubtitle(this.closest('.media-video-body').querySelector('video'),${jsAttrArg(s.url)},${jsAttrArg(s.label||`本地字幕 ${i+1}`)})">${esc(s.label||`本地字幕 ${i+1}`)}</button>`).join('');}}).catch(()=>{});
  const direct = mediaFileUrl(lib, path);
  const compat = mediaCompatUrl(lib, path);
  /* v0.9.51 修复：以前这里传的是外层 viewer，于是 .video-controls-visible
     被加到 viewer 上，而 CSS 选择器是 .media-video-body.video-controls-visible，
     永远不匹配 —— 这就是悬浮控制栏/进度条一直不出现的根因。 */
  bindVideoStatus(videoRoot, video);
  scheduleVideoChromeHide(videoRoot);
  const useDirect = (reason="原片直连") => { terminateWasmVideo(videoRoot); setVideoEngine(videoRoot, VIDEO_ENGINE_NATIVE, reason); switchMovieSource(video, direct); };
  const useCompat = (reason, url=compat) => { terminateWasmVideo(videoRoot); setVideoEngine(videoRoot, VIDEO_ENGINE_COMPAT, reason || `Smart Stream · ${settings.hardwareAcceleration}`); switchMovieSource(video, url); };
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
    const sessionID = await createVideoPlaybackSession(videoRoot, lib, path, plan.mode);
    const plannedURL = plan.url && sessionID && plan.mode !== "direct" ? `${plan.url}&task=${encodeURIComponent(sessionID)}` : (plan.url || compat);
    if (plan.mode === "direct") useDirect(`${playbackModeLabel(plan)} · ${plan.reason}`);
    else useCompat(`${playbackModeLabel(plan)} · ${plan.reason}`, plannedURL);
  } catch (error) {
    const extRule = movieExtensionNeedsCompat(path) || browserSaysVideoContainerUnsupported(path);
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
function decodeTextBytes(bytes) {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch (e) { return new TextDecoder("gb18030").decode(bytes); }
}

/* ================= v0.9.51 播放器内联 SVG 图标集 =================
   旧版用 Unicode 字形/emoji（⌄ ⏮ 🔁 ⚙ …），各平台渲染差异大且不能按
   主题换肤。v0.9.51 起全部按钮图标改为 24 视口内联 SVG：描边型走
   currentColor（可随 PotPlayer/Apple 两套皮肤换色），实心型自带 fill。 */
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
  return `<svg class="vc-svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${body}</svg>`;
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
      body = entries.length ? `<div class="comic-archive-pages">${entries.map((entry,index)=>`<img loading="lazy" src="${esc(entry.url || `/api/media/archive/zip/register?id=${encodeURIComponent(lib.id)}&path=${encodeURIComponent(path)}&entry=${encodeURIComponent(entry.raw || entry.name)}`)}" alt="${esc(entry.name || ("第 " + (index+1) + " 页"))}">`).join("")}</div>` : '<div class="media-error">压缩包中没有可读取的图片</div>';
      viewer.innerHTML = viewerShell(group, lib, path, body, url, { doc: true });
      /* v0.9.30：漫画重新打开必须回到上次页，否则每次都从第一页开始。 */
      if (entries.length) restoreReaderProgress(viewer, lib.id, path);
      return;
    } catch (err) { viewer.innerHTML = viewerShell(group, lib, path, `<div class="media-error">ZIP 漫画读取失败：${esc(err.message)}</div>`, url, { doc: true }); return; }
  }
  if (["mp3","flac","m4a","ogg","wav"].includes(ext)) body = `<div class="media-viewer-body"><audio controls autoplay preload="metadata" src="${esc(url)}"></audio></div>`;
  else if (MEDIA_FORMATS.movie.includes(ext)) body = `<div class="media-viewer-body media-video-body" data-video-controls-visible="true" data-video-engine="native" data-video-chrome-collapsed="false" data-video-repeat="off" data-video-shuffle="off" data-video-quality="auto">
<video data-movie-player playsinline preload="metadata" onloadedmetadata="this.muted=false;this.volume=1" onvolumechange="this.dataset.volume=String(this.volume)"></video>
<div class="video-chrome" data-video-chrome>
<div class="vc-top">
<button class="vc-icon vc-collapse" type="button" title="${esc(t("vpMinimize"))}" aria-label="${esc(t("vpMinimize"))}" onclick="minimizeVideoPlayer(this)">${videoIcon("collapse")}</button>
<div class="vc-heading"><strong class="vc-title" data-video-title>${esc(t("vpTitleLoading"))}</strong><span class="vc-sub" data-video-meta-line></span></div>
<span class="movie-compat-status">${esc(t("vpPreparing"))}</span>
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
<div class="video-status-panel"><span class="status-main" data-video-status>准备播放</span><span class="status-detail" data-video-detail>--:-- / --:-- · 媒体元数据待识别</span></div>
</div>`;
  else if (["jpg","jpeg","png","webp","gif","bmp","avif"].includes(ext)) body = `<img src="${esc(url)}" alt="${esc(path)}">`;
  else if (ext === "pdf") body = `<iframe src="${esc(url)}#view=FitH" title="${esc(path)}"></iframe>`;
  else if (ext === "txt") {
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
    const note = MEDIA_FORMATS.comic.includes(ext) ? "该漫画/压缩格式已加入书架。当前浏览器不能直接解析时，可下载后用专业阅读器打开。" : MEDIA_FORMATS.book.includes(ext) ? "该电子书格式已加入书架。浏览器不支持直接解析时，可在新窗口打开或下载阅读。" : "该格式可下载或交给浏览器打开。";
    body = `<div class="reader-book-fallback"><div class="book-cover" style="max-width:220px;margin:0 auto 24px;background:${coverGradient(displayBookTitle(path))}"><span class="book-cover-title">${esc(displayBookTitle(path))}</span></div><p>${note}</p><p><a class="btn btn-primary" href="${esc(url)}" target="_blank" rel="noopener">↗ 尝试在浏览器打开</a></p></div>`;
  }
  const isVideoPlayer = group === "movie" && MEDIA_FORMATS.movie.includes(ext);
  viewer.innerHTML = viewerShell(group, lib, path, body, url, { player: isVideoPlayer });
  if (isVideoPlayer) initMovieCompatPlayer(viewer, lib, path);
  scrollViewerIntoView(viewer);
}
