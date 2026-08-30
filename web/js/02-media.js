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
/* 外网浏览器无法直连 192.168.x.x：页面本身在公网时自动改走反代域名。
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
  closeModal("settingsModal");
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
    const values = { mediaScraperMode:c.scraper_mode, tmdbApiBase:c.tmdb_api_base, tmdbImageBase:c.tmdb_image_base, mediaCacheDir:c.cache_dir, mediaCacheMaxBytes:c.cache_max_bytes, mediaCacheMaxAge:c.cache_max_age_hours, mediaCacheCleanup:c.cache_cleanup_interval_hours };
    Object.entries(values).forEach(([id,value]) => { const el=document.getElementById(id); if(el && value !== undefined) el.value=String(value); });
    const key=document.getElementById("tmdbApiKey"); if(key){ key.value=""; key.placeholder=c.tmdb_api_key_masked ? "已设置；留空保留" : "未设置"; }
    if(status) status.textContent="✅ 已载入运行配置";
    if(notify) toast("✅ 已重新载入刮削与缓存设置");
  } catch(e) { if(status) status.textContent=`⚠ ${e.message}`; if(notify) toast("⚠️ 设置读取失败"); }
}
async function saveMediaRuntimeSettings() {
  const value=id=>document.getElementById(id)?.value?.trim() || "";
  const payload={ scraper_mode:value("mediaScraperMode")||"auto", tmdb_api_key:value("tmdbApiKey"), tmdb_api_base:value("tmdbApiBase"), tmdb_image_base:value("tmdbImageBase"), cache_dir:value("mediaCacheDir"), cache_max_bytes:Number(value("mediaCacheMaxBytes")), cache_max_age_hours:Number(value("mediaCacheMaxAge")), cache_cleanup_interval_hours:Number(value("mediaCacheCleanup")) };
  const status=document.getElementById("mediaRuntimeStatus"); if(status) status.textContent="保存中…";
  try { const res=await fetch("/api/media/settings",{method:"PUT",headers:sessionWriteHeaders(true),body:JSON.stringify(payload)}); const data=await res.json(); if(!res.ok) throw new Error(data.error||`HTTP ${res.status}`); scraperStatus={...scraperStatus,...data,default:data.scraper_mode}; await loadMediaRuntimeSettings(false); toast("✅ 刮削与缓存设置已立即生效"); }
  catch(e){ if(status)status.textContent=`⚠ ${e.message}`; toast("⚠️ 保存失败："+e.message); }
}
async function scrapeMovieMetadata(host, lib, files) {
  await loadScraperStatus();
  const all = readMovieMetadata();
  const pending = files.filter(file => !all[file.path]);
  for (const file of pending) { all[file.path] = { ...movieBaseMetadata(String(file.path)), provider: "文件名展示（等待豆瓣刮削）", checkedAt: Date.now() }; }
  writeMovieMetadata(all); if (pending.length) renderMovieLibraryContent(host, lib, files);
  for (const file of pending) {
    const path = String(file.path), fallback = all[path], title = fallback.title;
    const mediaType = lib?.type === "series" ? "series" : "movie";
    // TMDB 已配置时优先使用官方刮削（电影走 search/movie，剧集走 search/tv），
    // 未配置或无结果时回落豆瓣，最后回落文件名展示。
    const mode = scraperStatus.scraper_mode || scraperStatus.default || "auto";
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
function renderMovieLibraryContent(host, lib, files) {
  const body = `<div class="media-poster-grid">${files.map(file => renderMoviePoster(lib, file)).join("")}</div>`;
  host.innerHTML = `<section class="content-collection"><div class="content-section-heading"><div><span class="eyebrow">我的媒体库</span><h3>${lib?.type === "series" ? "电视剧集" : "电影"}</h3></div><span class="badge">${files.length} 部</span></div>${body}</section>`;
}
function renderMovieLibrary(lib, files) { const host = document.createElement("div"); renderMovieLibraryContent(host, lib, files); return host.innerHTML; }
function renderMovieRow(lib, file) { const path=String(file.path), meta=movieMetadataFor(path); return `<div class="media-file-row"><div class="media-file-name" title="${esc(path)}"><b>${esc(meta.title)}</b><small>${esc([meta.year, meta.provider].filter(Boolean).join(" · "))}</small></div><span class="media-file-meta">${esc(fileExt(path).toUpperCase())} · ${formatFileSize(file.size)}</span><div class="media-actions"><button class="btn" data-media-group="movie" data-media-library="${esc(lib.id)}" data-media-path="${esc(path)}" onclick="openLocalMediaButton(this)">▶ 播放</button></div></div>`; }
function movieStateKey(kind, libId, path) { return `vaulthub_movie_${kind}_${libId}_${path}`; }
function movieFlag(kind, libId, path) { try { return localStorage.getItem(movieStateKey(kind,libId,path)) === "1"; } catch(e) { return false; } }
function toggleMovieReadState(button) { const card=button.closest(".media-poster-card"), libId=card.dataset.mediaLibrary, path=card.dataset.mediaPath, next=!movieFlag("read",libId,path); try{localStorage.setItem(movieStateKey("read",libId,path),next?"1":"0");}catch(e){} button.textContent=next?"✓ 已读":"○ 未读"; button.closest(".media-poster-card")?.classList.toggle("is-read",next); }
function toggleMovieFavorite(libId,path,button){const next=!movieFlag("favorite",libId,path);try{localStorage.setItem(movieStateKey("favorite",libId,path),next?"1":"0");}catch(e){} if(button)button.textContent=next?"♥ 已收藏":"♡ 收藏";}
function rateMovie(libId,path){const raw=prompt("请为该视频评分（0-10）",localStorage.getItem(movieStateKey("rating",libId,path))||"");if(raw===null)return;const n=Number(raw);if(!Number.isFinite(n)||n<0||n>10){toast("⚠️ 评分应为 0-10");return;}localStorage.setItem(movieStateKey("rating",libId,path),String(n));document.querySelector("[data-user-rating]")?.replaceChildren(document.createTextNode(`我的评分 ${n.toFixed(1)}`));}
async function shareMovie(title){try{if(navigator.share)await navigator.share({title,text:title,url:location.href});else{await navigator.clipboard.writeText(location.href);toast("✅ 页面链接已复制");}}catch(e){}}
async function openMovieDetails(libId,path){const lib=findMediaLibrary(libId),viewer=document.getElementById("local-media-viewer-movie");if(!lib||!viewer)return;let meta=movieMetadataFor(path);viewer.innerHTML=renderMovieDetails(lib,path,meta);if(meta.tmdb_id){try{const res=await fetch(`/api/media/tmdb?id=${encodeURIComponent(meta.tmdb_id)}&type=${encodeURIComponent(meta.media_type||lib.type)}`,{cache:"force-cache"});if(res.ok){const detail=await res.json();meta={...meta,overview:detail.overview||meta.overview,rating:Number(detail.vote_average||meta.rating||0),runtime:detail.runtime||detail.episode_run_time?.[0],genres:(detail.genres||[]).map(x=>x.name),cast:(detail.credits?.cast||[]).slice(0,12),recommendations:(detail.recommendations?.results||[]).slice(0,8)};viewer.innerHTML=renderMovieDetails(lib,path,meta);}}catch(e){}}scrollViewerIntoView(viewer);}
function closeMovieDetails(){const viewer=document.getElementById("local-media-viewer-movie");if(viewer)viewer.innerHTML="";}
function renderMovieDetails(lib,path,meta){const cast=(meta.cast||[]).map(x=>`<article><b>${esc(x.name||"")}</b><small>${esc(x.character||"")}</small></article>`).join("")||'<div class="empty-tip">暂无演职人员信息</div>';const rec=(meta.recommendations||[]).map(x=>`<article><b>${esc(x.title||x.name||"")}</b><small>${esc(String(x.release_date||x.first_air_date||"").slice(0,4))}</small></article>`).join("")||'<div class="empty-tip">暂无视频推荐</div>';return `<div class="media-reader-overlay movie-detail-page"><div class="movie-detail-scroll"><button class="media-reader-close" onclick="closeMovieDetails()">✕</button><header style="${meta.backdrop?`background-image:linear-gradient(90deg,rgba(0,0,0,.92),rgba(0,0,0,.3)),url('${esc(meta.backdrop)}')`:""}"><h1>${esc(meta.title)}</h1><p>${esc(meta.overview||"暂无电影介绍；可在系统设置中配置 TMDB API 进行刮削。")}</p><div class="movie-detail-actions"><button class="btn btn-primary" onclick="openLocalMedia('movie',${jsAttrArg(lib.id)},${jsAttrArg(path)})">▶ 播放</button><button class="btn" onclick="shareMovie(${jsAttrArg(meta.title)})">↗ 分享</button><button class="btn" onclick="toggleMovieFavorite(${jsAttrArg(lib.id)},${jsAttrArg(path)},this)">${movieFlag("favorite",lib.id,path)?"♥ 已收藏":"♡ 收藏"}</button><button class="btn" onclick="rateMovie(${jsAttrArg(lib.id)},${jsAttrArg(path)})">★ <span data-user-rating>评分</span></button></div></header><section><h3>演职人员</h3><div class="movie-detail-strip">${cast}</div></section><section><h3>视频推荐</h3><div class="movie-detail-strip">${rec}</div></section><section><h3>视频元数据</h3><dl class="movie-meta-list"><dt>文件</dt><dd>${esc(path)}</dd><dt>年份</dt><dd>${esc(meta.year||"--")}</dd><dt>类型</dt><dd>${esc((meta.genres||[]).join(" / ")||"--")}</dd><dt>时长</dt><dd>${meta.runtime?esc(meta.runtime+" 分钟"):"--"}</dd><dt>TMDB 评分</dt><dd>${meta.rating?esc(meta.rating.toFixed(1)):"--"}</dd><dt>来源</dt><dd>${esc(meta.provider||"文件名")}</dd></dl></section></div></div>`;}
function renderMoviePoster(lib, file) { const path=String(file.path), meta=movieMetadataFor(path), read=movieFlag("read",lib.id,path), art=meta.poster ? `<img src="${esc(meta.poster)}" alt="${esc(meta.title)}" loading="lazy">` : `<span>${esc(meta.title)}</span>`; return `<article class="media-poster-card ${read?"is-read":""}" data-media-group="movie" data-media-library="${esc(lib.id)}" data-media-path="${esc(path)}" onclick="openMovieDetails(${jsAttrArg(lib.id)},${jsAttrArg(path)})"><div class="media-poster-art" style="${meta.poster ? "" : `background:${coverGradient(meta.title)}`}" >${art}<button class="movie-poster-settings" data-movie-settings title="阅读状态" onclick="event.stopPropagation();toggleMovieReadState(this)">${read?"✓ 已读":"○ 未读"}</button></div><div class="media-poster-info"><strong>${esc(meta.title)}</strong><small>${esc([meta.year,meta.provider].filter(Boolean).join(" · ") || fileExt(path).toUpperCase())}</small></div></article>`; }
function toggleMediaResourceView(group) { mediaResourceView = mediaResourceView === "poster" ? "list" : "poster"; try { localStorage.setItem("vaulthub_media_resource_view",mediaResourceView); } catch(e) {} const lib=findMediaLibrary(localMediaSelection[group]); if(lib) loadLocalFiles(group,lib,group === "audio" ? audioCursor : 0); }
function refreshMovieMetadata() { try { localStorage.removeItem(movieMetadataCache); } catch(e) {} const lib=findMediaLibrary(localMediaSelection.movie); if(lib) loadLocalFiles("movie", lib, 0); toast("🔄 正在重新刮削影视信息"); }

function mediaStateKey(libId, path) { return `vaulthub_reading_${libId}_${path}`; }
function readingState(libId, path) {
  try { return JSON.parse(localStorage.getItem(mediaStateKey(libId, path))) || { progress: 0 }; } catch (e) { return { progress: 0 }; }
}
function saveReadingProgress(libId, path, progress) {
  const value = Math.max(0, Math.min(100, Number(progress) || 0));
  try { localStorage.setItem(mediaStateKey(libId, path), JSON.stringify({ progress: value, updatedAt: Date.now() })); } catch (e) {}
  return value;
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
  if (group === "comic") return (lib?.type === "book" ? MEDIA_FORMATS.book : MEDIA_FORMATS.comic).includes(ext);
  // 音乐视频（歌曲 MV）库存放的是视频文件，因此按影视扩展名判定。
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
function audioHasActivePlayback() { return !!activeAudio; }
function normalizeFilePayload(data) {
  const files = Array.isArray(data) ? data : (data?.files || data?.items || []);
  return files.map(item => typeof item === "string" ? { path: item } : item).filter(item => item?.path);
}
async function loadLocalFiles(group, lib, offset = 0) {
  const target = document.getElementById("local-media-content-" + group);
  if (!target) return;
  try {
    const pageSize = group === "comic" ? mediaPageSize : group === "audio" ? audioPageSize : group === "movie" ? 50 : 100;
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
    if (group === "comic") {
      files = files.filter(file => {
        const progress = Number(readingState(lib.id, String(file.path)).progress || 0);
        return comicShelfView === "completed" ? progress >= COMPLETED_PROGRESS : progress < COMPLETED_PROGRESS;
      });
    }
    const prev = offset > 0 ? `<button class="btn" onclick="loadLocalFiles('${esc(group)}',findMediaLibrary('${esc(lib.id)}'),${Math.max(0, offset - pageSize)})">← 上一页</button>` : "";
    const next = data.has_more ? `<button class="btn" onclick="loadLocalFiles('${esc(group)}',findMediaLibrary('${esc(lib.id)}'),${offset + pageSize})">下一页 →</button>` : "";
    const pager = `<div class="media-actions">${prev}<span class="media-file-meta">${offset + 1}-${offset + files.length} / ${Number(data.total) || files.length}</span>${next}</div>`;
    if (group === "comic") {
      const toolbar = `<div class="content-section-heading"><div><span class="eyebrow">我的媒体库</span><h3>${lib.type === "book" ? "电子书" : "漫画"}</h3></div><div class="comic-shelf-tabs"><button class="${comicShelfView === "completed" ? "active" : ""}" onclick="setComicShelfView(comicShelfView === \"completed\" ? \"shelf\" : \"completed\")">${comicShelfView === "completed" ? "← 返回未读" : "✓ 已读收藏"}</button></div></div>`;
      target.innerHTML = `${toolbar}${files.length ? `<div class="book-grid">${files.map(file => renderBookCard(group, lib, file)).join("")}</div>` : `<div class="empty-tip">${comicShelfView === "completed" ? "还没有读完的书" : "当前页没有未读书籍"}</div>`}${pager}`;
      scrapeVisibleBookCovers(target);
    } else if (group === "audio") {
      audioFiles = files;
      audioCursor = offset;
      target.innerHTML = renderAudioLibrary(lib, files, data);
      scrapeAudioMetadata(target, lib, files);
    } else if (group === "movie") {
      target.innerHTML = renderMovieLibrary(lib, files, data) + pager;
      scrapeMovieMetadata(target, lib, files);
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
    /* 结构化查询比裸关键词精确得多：歌手未知时只按标题查。 */
    const known = fallback.artist && fallback.artist !== "未知歌手";
    const query = known
      ? `recording:"${fallback.title}" AND artist:"${fallback.artist}"`
      : `recording:"${fallback.title}"`;
    try {
      const response = await fetch(`https://musicbrainz.org/ws/2/recording/?query=${encodeURIComponent(query)}&fmt=json&limit=3`, { headers: { Accept: "application/json" }, cache: "force-cache" });
      const list = response.ok ? ((await response.json()).recordings || []) : [];
      const item = list.find(rec => audioMatchAcceptable(fallback, rec));
      if (item) {
        all[path] = {
          ...fallback,
          title: item.title || fallback.title,
          artist: item["artist-credit"]?.[0]?.name || fallback.artist,
          album: item.releases?.[0]?.title || fallback.album,
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
  host.innerHTML = `<section class="content-collection"><div class="content-section-heading"><div><span class="eyebrow">我的媒体库</span><h3>音乐与 MV</h3></div><div class="audio-view-tabs"><button class="${audioView === "albums" ? "active" : ""}" onclick="setAudioView('albums')">专辑</button><button class="${audioView === "artists" ? "active" : ""}" onclick="setAudioView('artists')">歌手</button><button class="${audioView === "favorites" ? "active" : ""}" onclick="setAudioView('favorites')">♥ 喜欢</button><label class="page-size-picker">每页 <select id="audioPageSize" onchange="setAudioPageSize(this.value)"><option value="20"${audioPageSize===20?' selected':''}>20</option><option value="50"${audioPageSize===50?' selected':''}>50</option><option value="100"${audioPageSize===100?' selected':''}>100</option></select></label></div></div>${body}${audioView === "favorites" || audioView === "tracks" ? "" : pager}</section>${latestGrid}`;
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
  const actions = video ? `<button class="media-reader-close" title="关闭播放器" onclick="closeLocalViewer('${esc(group)}')">✕</button>` : `${toolbar}<button class="btn" title="系统设置" onclick="openModal('settingsModal')">⚙ 设置</button><button class="btn" onclick="markReaderCompleted()">✓ 标记已读</button><button class="media-reader-close" title="关闭并返回书架" onclick="closeLocalViewer('${esc(group)}')">✕</button>`;
  return `<div class="media-reader-overlay ${readerThemeClass()}"><div class="media-reader-head ${video ? "movie-player-head" : ""}"><strong class="media-reader-title" title="${esc(path)}">${esc(displayBookTitle(path))}</strong><div class="media-actions">${actions}</div></div><div class="media-reader-body" data-reader-scroll onscroll="trackReaderProgress(this)">${chapterHtml}<div class="media-reader-wrap">${body}</div></div></div>`;
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
  setMovieCompatStatus(root, `${VIDEO_ENGINE_LABELS[engine] || engine}${detail ? " · " + detail : ""}`);
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
  if (size > WASM_INPUT_LIMIT) throw new Error("文件超过 256 MB，浏览器软件解码为保护内存已停止");
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > WASM_INPUT_LIMIT) throw new Error("文件超过 256 MB，浏览器软件解码为保护内存已停止");
  terminateWasmVideo(root);
  const worker = new Worker("/web/vendor/ffmpeg/worker.js");
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
async function advanceVideoEngine(root, video, context) {
  const engine = root.dataset.videoEngine || VIDEO_ENGINE_NATIVE;
  if (engine === VIDEO_ENGINE_NATIVE) { context.useCompat("原生失败，自动降级到 FFmpeg 兼容流"); return; }
  if (engine === VIDEO_ENGINE_COMPAT) {
    try { await startWasmVideoFallback(root, video, context.direct); }
    catch (error) { setVideoEngine(root, VIDEO_ENGINE_WASM, `降级失败：${error.message}`); updateVideoStatus(root, video, "播放失败"); }
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
  const engine = VIDEO_ENGINE_LABELS[root?.dataset.videoEngine] || "待选择";
  const size=video.videoWidth ? `${video.videoWidth}×${video.videoHeight}` : "分辨率待获取";
  detail.textContent=`${formatMediaTime(video.currentTime)} / ${formatMediaTime(video.duration)} · ${size} · ${engine} · ${root.dataset.videoMetadata || "媒体元数据待识别"}`;
}
function toggleVideoStatusPanel(button) {
  const root = button?.closest(".media-video-body");
  const panel = root?.querySelector(".video-status-panel");
  if (!panel) return;
  const open = panel.classList.toggle("show");
  button.setAttribute("aria-expanded", String(open));
}
function scheduleVideoChromeHide(root) {
  clearTimeout(root.__videoChromeTimer);
  root.classList.add("video-controls-visible");
  root.dataset.videoControlsVisible = "true";
  root.__videoChromeTimer = setTimeout(() => {
    if (!root.querySelector("video")?.paused) {
      root.classList.remove("video-controls-visible");
      root.dataset.videoControlsVisible = "false";
      const panel = root.querySelector(".video-status-panel");
      const button = root.querySelector(".video-info-button");
      panel?.classList.remove("show");
      button?.setAttribute("aria-expanded", "false");
    }
  }, 3000);
}
function bindVideoStatus(root, video) {
  [["loadstart","正在连接"],["waiting","正在缓冲"],["playing","正在播放"],["pause","已暂停"],["ended","播放完成"],["stalled","网络等待"],["error","播放错误"]].forEach(([ev,label])=>video.addEventListener(ev,()=>updateVideoStatus(root,video,label)));
  video.addEventListener("timeupdate",()=>{ updateVideoStatus(root,video,video.paused?"已暂停":"正在播放"); updateVideoTimeline(video); saveVideoPlaybackState(video); });
  ["progress","loadedmetadata","durationchange","canplay"].forEach(ev=>video.addEventListener(ev,()=>{ updateVideoTimeline(video); if(ev==='loadedmetadata')restoreVideoPlaybackState(video); }));
  video.addEventListener('keydown',e=>handleVideoKeyboard(e,video));
  video.tabIndex=0;
  ["pointermove","mouseenter","click"].forEach(ev => root.addEventListener(ev, () => scheduleVideoChromeHide(root), { passive:true }));
  video.addEventListener("pause", () => root.classList.add("video-controls-visible"));
  video.addEventListener("play", () => scheduleVideoChromeHide(root));
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
  const buffered=video.buffered?.length?video.buffered.end(video.buffered.length-1)/duration*100:0;
  const p=root.querySelector('.video-played-range'), b=root.querySelector('.video-buffered-range'), label=root.querySelector('.video-time-label');
  if(p)p.style.width=`${Math.min(100,played)}%`; if(b)b.style.width=`${Math.min(100,buffered)}%`;
  if(label)label.textContent=`${formatVideoTime(video.currentTime)} / ${formatVideoTime(video.duration)}  ·  已读 ${formatVideoTime(video.buffered?.length?video.buffered.end(video.buffered.length-1):0)}`;
}
function seekVideoTimeline(event, shell) { const video=shell.closest('.media-video-body')?.querySelector('video'); if(!video||!video.duration)return; const r=shell.getBoundingClientRect(); video.currentTime=Math.max(0,Math.min(video.duration,(event.clientX-r.left)/r.width*video.duration)); saveVideoPlaybackState(video); }
function handleVideoKeyboard(event, video) {
  if(!video || event.target.matches('input,textarea,select,button')) return;
  if(event.repeat) return;
  if(['ArrowLeft','ArrowRight',' ','k','K'].includes(event.key)) { event.preventDefault(); if(event.key==='ArrowLeft')video.currentTime=Math.max(0,video.currentTime-10); else if(event.key==='ArrowRight')video.currentTime=Math.min(video.duration||Infinity,video.currentTime+10); else video.paused?video.play().catch(()=>{}):video.pause(); saveVideoPlaybackState(video); }
}
function toggleVideoTrackMenu(button) { const root=button?.closest('.media-video-body'); root?.querySelector('[data-video-track-menu]')?.classList.toggle('show'); }
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
function switchMovieSource(video, url) {
  if (!video || video.dataset.currentSrc === url) return;
  const wasPaused = video.paused;
  const time = Number.isFinite(video.currentTime) ? video.currentTime : 0;
  video.dataset.currentSrc = url;
  video.src = url;
  video.load();
  video.addEventListener('loadedmetadata',()=>{ if(time>2 && time<video.duration-2) video.currentTime=time; if(!wasPaused) video.play().catch(()=>{}); },{once:true});
  video.muted = false;
  video.volume = 1;
}
async function initMovieCompatPlayer(root, lib, path) {
  const video = root?.querySelector("video[data-movie-player]");
  if (!video) return;
  const videoRoot = video.closest('.media-video-body');
  videoRoot.dataset.library=String(lib.id); videoRoot.dataset.path=String(path);
  const direct = mediaFileUrl(lib, path);
  const compat = mediaCompatUrl(lib, path);
  bindVideoStatus(root, video);
  const useDirect = () => { terminateWasmVideo(videoRoot); setVideoEngine(videoRoot, VIDEO_ENGINE_NATIVE, "原片直连"); switchMovieSource(video, direct); };
  const useCompat = reason => { terminateWasmVideo(videoRoot); setVideoEngine(videoRoot, VIDEO_ENGINE_COMPAT, reason || `服务端转码 · ${settings.hardwareAcceleration}`); switchMovieSource(video, compat); };
  const useWasm = async () => { try { await startWasmVideoFallback(videoRoot, video, direct); } catch (error) { setVideoEngine(videoRoot, VIDEO_ENGINE_WASM, `启动失败：${error.message}`); } };
  root.querySelector("[data-movie-direct]")?.addEventListener("click", useDirect);
  root.querySelector("[data-movie-compat]")?.addEventListener("click", () => useCompat("手动选择服务端兼容流"));
  root.querySelector("[data-movie-wasm]")?.addEventListener("click", useWasm);
  video.addEventListener("loadedmetadata", () => { video.muted = false; video.volume = 1; restoreVideoPlaybackState(video); fetch(`/api/media/streams?id=${encodeURIComponent(lib.id)}&path=${encodeURIComponent(path)}`,{cache:'no-store'}).then(r=>r.ok?r.json():null).then(info=>{populateVideoTracks(videoRoot,video,info);videoRoot.dataset.videoMetadata=formatVideoMetadata(info);updateVideoStatus(videoRoot,video,video.paused?"已暂停":"正在播放");}).catch(()=>{}); });
  let engineFailurePending = false;
  video.addEventListener("error", async () => {
    if (engineFailurePending || (video.dataset.currentSrc || "").startsWith("blob:")) return;
    engineFailurePending = true;
    try { await advanceVideoEngine(videoRoot, video, { direct, useCompat }); } finally { setTimeout(() => { engineFailurePending = false; }, 1000); }
  });
  const extRule = movieExtensionNeedsCompat(path) || browserSaysVideoContainerUnsupported(path);
  if (extRule) useCompat("容器不兼容，智能选择服务端 FFmpeg");
  else useDirect();
  try {
    const res = await fetch(mediaProbeUrl(lib, path), { cache: "no-store" });
    if (!res.ok) return;
    const info = await res.json();
    if (info) { videoRoot.dataset.videoMetadata=formatVideoMetadata(info); }
    if (info && info.compat_recommended && video.dataset.currentSrc !== compat) useCompat(`音频 ${info.audio_codec || "未知"} 不兼容，智能降级`);
    else setVideoEngine(videoRoot, VIDEO_ENGINE_NATIVE, info.audio_codec ? `音频 ${info.audio_codec}` : "原片直连");
  } catch (e) {}
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
  const ext = fileExt(path);
  const url = mediaFileUrl(lib, path);
  activeReader = { group, libId, path };
  let body = "";
  if ((group === "comic" || group === "movie" || group === "audio") && ["zip","cbz"].includes(ext)) {
    viewer.innerHTML = viewerShell(group, lib, path, '<div class="empty-tip">正在读取压缩包图片...</div>', url);
    try {
      const res = await fetch(`/api/media/archive/zip?id=${encodeURIComponent(lib.id)}&path=${encodeURIComponent(path)}`, { cache:"no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const entries = data.entries || data.items || [];
      body = entries.length ? `<div class="comic-archive-pages">${entries.map((entry,index)=>`<img loading="lazy" src="${esc(entry.url || `/api/media/archive/zip/register?id=${encodeURIComponent(lib.id)}&path=${encodeURIComponent(path)}&entry=${encodeURIComponent(entry.raw || entry.name)}`)}" alt="${esc(entry.name || ("第 " + (index+1) + " 页"))}">`).join("")}</div>` : '<div class="media-error">压缩包中没有可读取的图片</div>';
      viewer.innerHTML = viewerShell(group, lib, path, body, url);
      return;
    } catch (err) { viewer.innerHTML = viewerShell(group, lib, path, `<div class="media-error">ZIP 漫画读取失败：${esc(err.message)}</div>`, url); return; }
  }
  if (["mp3","flac","m4a","ogg","wav"].includes(ext)) body = `<div class="media-viewer-body"><audio controls autoplay preload="metadata" src="${esc(url)}"></audio></div>`;
  else if (MEDIA_FORMATS.movie.includes(ext)) body = `<div class="media-viewer-body media-video-body" data-video-controls-visible="true" data-video-engine="native"><div class="movie-compat-bar"><strong>三重解码</strong><button class="btn" type="button" data-engine-choice="native" data-movie-direct>浏览器原生</button><button class="btn" type="button" data-engine-choice="compat" data-movie-compat>FFmpeg 兼容流</button><button class="btn" type="button" data-engine-choice="wasm" data-movie-wasm>WASM SIMD</button><span class="movie-compat-status">正在探测并智能选择引擎...</span></div><button class="video-menu-button" type="button" title="字幕和音轨" aria-label="字幕和音轨" onclick="toggleVideoTrackMenu(this)">☷</button><button class="video-info-button" type="button" title="播放及媒体元数据" aria-label="播放及媒体元数据" aria-expanded="false" onclick="toggleVideoStatusPanel(this)">!</button><video data-movie-player controls playsinline preload="metadata" onloadedmetadata="this.muted=false;this.volume=1" onvolumechange="this.dataset.volume=String(this.volume)"></video><div class="video-timeline"><span class="video-time-label">00:00 / 00:00</span><div class="video-progress-shell" role="slider" aria-label="播放进度" onclick="seekVideoTimeline(event,this)"><span class="video-buffered-range"></span><span class="video-played-range"></span></div></div><div class="video-track-menu video-audio-menu" data-video-track-menu><h4>音源</h4><div class="video-audio-options" data-video-audio-options>读取音源中...</div><h4>字幕</h4><div class="video-subtitle-menu" data-video-subtitle-options>暂无外挂字幕</div><button type="button" onclick="searchVideoSubtitles(this)">搜索并挂载字幕</button></div><div class="video-status-panel"><span class="status-main" data-video-status>准备播放</span><span class="status-detail" data-video-detail>--:-- / --:-- · 媒体元数据待识别</span></div></div>`;
  else if (["jpg","jpeg","png","webp","gif","bmp","avif"].includes(ext)) body = `<img src="${esc(url)}" alt="${esc(path)}">`;
  else if (ext === "pdf") body = `<iframe src="${esc(url)}#view=FitH" title="${esc(path)}"></iframe>`;
  else if (ext === "txt") {
    viewer.innerHTML = viewerShell(group, lib, path, '<div class="empty-tip">正在读取文本...</div>', url);
    try {
      const bytes = await fetchCompleteTextFile(url);
      const text = decodeTextBytes(bytes);
      const chapters = buildEbookChapters(text);
      window.__ebookChapters = chapters;
      window.__ebookTextLength = text.length;
      body = `<pre class="media-text" id="ebookText">${esc(text)}</pre>`;
      viewer.innerHTML = viewerShell(group, lib, path, body, url, { chapters, ebook: true });
    } catch (err) {
      body = `<div class="media-error">文本读取失败：${esc(err.message)}</div>`;
      viewer.innerHTML = viewerShell(group, lib, path, body, url);
      return;
    }
    /* 滚动定位放在 try 之外：它失败只是没滚到位，不能被报成「文本读取失败」，
       否则正文其实已经渲染好了，用户却看到一条读取失败的红字。 */
    scrollViewerIntoView(viewer);
    return;
  } else {
    const note = MEDIA_FORMATS.comic.includes(ext) ? "该漫画/压缩格式已加入书架。当前浏览器不能直接解析时，可下载后用专业阅读器打开。" : MEDIA_FORMATS.book.includes(ext) ? "该电子书格式已加入书架。浏览器不支持直接解析时，可在新窗口打开或下载阅读。" : "该格式可下载或交给浏览器打开。";
    body = `<div class="reader-book-fallback"><div class="book-cover" style="max-width:220px;margin:0 auto 24px;background:${coverGradient(displayBookTitle(path))}"><span class="book-cover-title">${esc(displayBookTitle(path))}</span></div><p>${note}</p><p><a class="btn btn-primary" href="${esc(url)}" target="_blank" rel="noopener">↗ 尝试在浏览器打开</a></p></div>`;
  }
  viewer.innerHTML = viewerShell(group, lib, path, body, url);
  if (group === "movie" && MEDIA_FORMATS.movie.includes(ext)) initMovieCompatPlayer(viewer, lib, path);
  scrollViewerIntoView(viewer);
}
