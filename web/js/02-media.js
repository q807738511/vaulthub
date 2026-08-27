/* VaultHub frontend — split from index.html in phase 4.
   Plain ordered classic scripts (no bundler): global functions remain global
   so the ~131 inline on*= handlers keep working. Load order is fixed by the
   <script> tags in index.html and MUST be preserved. */
const MEDIA_VIEWS = ["comic", "movie", "audio"];
function initMediaLogin() {
  document.querySelectorAll("#view-comic .tab-panel, #view-movie .tab-panel, #view-audio .tab-panel").forEach((panel, idx) => {
    if (panel.dataset.mediaLoginReady) return;
    const group = panel.querySelector("[data-lan-input]")?.dataset.lanInput;
    if (!group) return;
    const id = panel.id || `${group}-single-${idx}`;
    panel.dataset.mediaLoginReady = "1";
    panel.insertAdjacentHTML("beforeend", `
      <div class="media-login" data-media-launch="${esc(id)}">
        <div class="media-actions">
          <button class="btn btn-primary" onclick="mediaLogin('${esc(id)}')">↗ <span data-i18n="btnMediaLogin">进入媒体服务</span></button>
          <button class="btn" onclick="openMediaExternal('${esc(id)}')">⊞ <span data-i18n="btnOpenExternal">新窗口打开</span></button>
          <button class="btn" onclick="hideMediaConfig('${esc(group)}')">⌃ <span data-i18n="mediaHideCfg">收起配置</span></button>
        </div>
        <div class="media-login-note" data-i18n="mediaLoginNote">填写或选择上方访问地址后，点击进入会在当前栏目内打开媒体服务登录页，账号密码在媒体服务页面里手动填写。</div>
      </div>`);
  });
  MEDIA_VIEWS.forEach(v => {
    const wrap = document.querySelector(`#view-${v} .cfg-wrap`);
    if (wrap) wrap.style.display = "none";
    renderMediaHome(v);
  });
  addMediaPath();
  refreshMediaLibraries(false);
  applyI18n();
}

function mediaPanel(id) {
  return document.querySelector(`[data-media-launch="${CSS.escape(id)}"]`)?.closest(".tab-panel, .card");
}
function mediaWideHostForPanel(panel) {
  const view = panel?.closest(".view");
  if (!view) return null;
  const group = view.id.replace("view-", "");
  return document.getElementById("media-wide-" + group);
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
function serviceAccessUrl(panel, selectedUrl, pageHostname = location.hostname) {
  let url = normalizeMediaUrl(selectedUrl);
  if (!panel || !url) return url;

  /* 外网浏览器无法直连 192.168.x.x：自动改走同容器的公网 Host 入口。 */
  if (!isPrivateHostname(pageHostname) && isPrivateServiceUrl(url)) {
    const proxy = panel.querySelector("[data-proxy-input]")?.value.trim();
    if (proxy) url = normalizeMediaUrl(proxy);
  }

  /* 飞牛 FPK 版 Navidrome 无 BaseURL 开关，公网 Host 直接使用其真实 /app/ 入口。 */
  if (panel.id === "audio-navidrome") {
    try {
      const parsed = new URL(url);
      if (parsed.pathname === "/") parsed.pathname = "/app/";
      url = parsed.toString();
    } catch (e) {}
  }
  return url;
}
function mediaCurrentUrl(id) {
  const panel = mediaPanel(id);
  const addr = panel?.querySelector(".addr-box .val")?.textContent.trim();
  return serviceAccessUrl(panel, addr || "");
}
function normalizeMediaUrl(url) {
  const raw = String(url || "").trim();
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw)) return raw;
  return "http://" + raw;
}
function rememberMediaUrl(id, url) {
  try { localStorage.setItem("dwu_media_url_" + id, url); } catch (e) {}
}
function activeMediaPanel(group) {
  const view = document.getElementById("view-" + group);
  return view?.querySelector(".tab-panel.active") || view?.querySelector(".card");
}
function activeMediaId(group) {
  const panel = activeMediaPanel(group);
  return panel?.querySelector("[data-media-launch]")?.dataset.mediaLaunch || null;
}
function mediaStoreKey(group) { return "dwu_media_configured_" + group; }
function mediaMode(group) {
  try { return localStorage.getItem("dwu_media_mode_" + group) || "local"; } catch (e) { return "local"; }
}
function setMediaMode(group, mode) {
  try { localStorage.setItem("dwu_media_mode_" + group, mode); } catch (e) {}
  const wrap = document.querySelector(`#view-${group} .cfg-wrap`);
  if (wrap) wrap.style.display = "none";
  renderMediaHome(group);
}
function mediaModeBar(group) {
  const mode = mediaMode(group);
  return `<div class="media-modebar"><div class="media-modes" role="tablist" aria-label="媒体来源">
    <button class="media-mode ${mode === "local" ? "active" : ""}" type="button" onclick="setMediaMode('${esc(group)}','local')">本地媒体库</button>
    <button class="media-mode ${mode === "external" ? "active" : ""}" type="button" onclick="setMediaMode('${esc(group)}','external')">外连服务</button>
  </div><button class="btn" type="button" onclick="showMediaConfig('${esc(group)}')">⚙ 设置</button></div>`;
}
function setMediaConfigured(group, configured) {
  try { localStorage.setItem(mediaStoreKey(group), configured ? "1" : "0"); } catch (e) {}
}
function isMediaConfigured(group) {
  try { return localStorage.getItem(mediaStoreKey(group)) === "1"; } catch (e) { return false; }
}
function showMediaConfig(group) {
  if (mediaMode(group) === "local") {
    showMediaLibraryConfig(group);
    return;
  }
  const wrap = document.querySelector(`#view-${group} .cfg-wrap`);
  if (wrap) wrap.style.display = "block";
  const host = document.getElementById("media-wide-" + group);
  if (host) host.classList.remove("show");
}
function hideMediaConfig(group) {
  const wrap = document.querySelector(`#view-${group} .cfg-wrap`);
  if (wrap) wrap.style.display = "none";
  renderMediaHome(group);
}
function renderMediaHome(group) {
  const host = document.getElementById("media-wide-" + group);
  if (!host) return;
  host.classList.add("show");
  if (mediaMode(group) === "local") {
    renderLocalMedia(group);
    return;
  }
  const configured = isMediaConfigured(group);
  if (!configured) {
    host.innerHTML = `${mediaModeBar(group)}
      <div class="media-empty">
        <div class="big">📭</div>
        <h3 data-i18n="mediaEmptyTitle">暂无资源</h3>
        <p data-i18n="mediaEmptyDesc">当前栏目还没有配置媒体服务器。请先配置服务器访问地址，保存后这里会作为资源访问页展示。</p>
        <button class="btn btn-primary" onclick="showMediaConfig('${esc(group)}')">⚙️ <span data-i18n="mediaCfgBtn">配置服务器</span></button>
      </div>`;
    applyI18n();
    return;
  }
  const id = activeMediaId(group);
  if (id) openMediaFrame(id, false);
}
function openMediaFrame(id, showToast) {
  const panel = mediaPanel(id);
  const url = mediaCurrentUrl(id);
  const host = mediaWideHostForPanel(panel);
  const group = panel?.closest(".view")?.id.replace("view-", "");
  if (!panel || !host || !url || !group) {
    if (!url) toast("⚠️ " + (curLang === "en" ? "Missing service address" : "缺少服务地址"));
    return;
  }
  setMediaConfigured(group, true);
  rememberMediaUrl(id, url);
  const wrap = document.querySelector(`#view-${group} .cfg-wrap`);
  if (wrap) wrap.style.display = "none";
  host.classList.add("show");
  host.innerHTML = `${mediaModeBar(group)}
    <div class="media-frame">
      <iframe src="${esc(url)}" loading="lazy" referrerpolicy="no-referrer" sandbox="allow-scripts allow-same-origin allow-forms allow-popups"></iframe>
    </div>`;
  applyI18n();
  if (showToast) toast("✅ " + (curLang === "en" ? "Opened service page" : "已在当前栏目打开服务页"));
}
function mediaLogin(id) {
  openMediaFrame(id, true);
}
function openMediaExternal(id) {
  const url = mediaCurrentUrl(id);
  if (!url) { toast("⚠️ " + (curLang === "en" ? "Missing service address" : "缺少服务地址")); return; }
  rememberMediaUrl(id, url);
  window.open(url, "_blank", "noopener");
}
function openActiveMediaExternal(group) {
  if (mediaMode(group) === "local") {
    showMediaLibraryConfig(group);
    return;
  }
  const id = activeMediaId(group);
  if (id) openMediaExternal(id);
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
function movieTitleFromPath(path) { return displayBookTitle(path).replace(/\b(19|20)\d{2}\b/g, " ").replace(/[._]+/g, " ").replace(/\s+/g, " ").trim() || displayBookTitle(path); }
function movieYearFromPath(path) { const m = String(path).match(/\b(19|20)\d{2}\b/); return m ? m[0] : ""; }
function movieBaseMetadata(path) { return { title: movieTitleFromPath(path), year: movieYearFromPath(path), poster: "", overview: "", provider: "文件名展示", checkedAt: 0 }; }
function movieMetadataFor(path) { const all = readMovieMetadata(); return { ...movieBaseMetadata(path), ...(all[path] || {}) }; }
async function loadScraperStatus() { try { const res = await fetch("/api/media/scrapers", { cache:"no-store" }); if (res.ok) scraperStatus = await res.json(); } catch(e) {} }
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
    if (scraperStatus.tmdb_enabled) try {
      const tmdb = await fetch(`/api/media/tmdb?query=${encodeURIComponent(title)}&type=${encodeURIComponent(mediaType)}`, { cache:"force-cache" });
      const data = tmdb.ok ? await tmdb.json() : null;
      const item = data?.results?.find(x => x.poster_path || x.overview || x.title || x.name);
      if (item) {
        const base = scraperStatus.tmdb_image_base || "https://image.tmdb.org/t/p";
        all[path] = { ...fallback, title:item.title || item.name || fallback.title, year:String(item.release_date || item.first_air_date || fallback.year).slice(0,4), poster:item.poster_path ? `${base}/w342${item.poster_path}` : "", overview:item.overview || "", provider:mediaType === "series" ? "TMDB · 剧集" : "TMDB · 电影", checkedAt:Date.now() };
        writeMovieMetadata(all); renderMovieLibraryContent(host, lib, files); continue;
      }
    } catch(e) {}
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
  const kindName = lib?.type === "series" ? "电视剧集" : "电影";
  const status = scraperStatus.tmdb_enabled ? `${kindName} · TMDB 刮削已启用` : `${kindName} · TMDB 未配置（设置 TMDB_API_KEY 后启用，当前豆瓣/文件名兜底）`;
  const body = mediaResourceView === "poster" ? `<div class="media-poster-grid">${files.map(file => renderMoviePoster(lib, file)).join("")}</div>` : `<div class="media-file-list">${files.map(file => renderMovieRow(lib, file)).join("")}</div>`;
  host.innerHTML = `<div class="comic-shelf-toolbar"><strong>本地影视库</strong><div class="media-actions"><span class="badge">${esc(status)}</span><button class="btn media-view-toggle" onclick="toggleMediaResourceView('movie')">${mediaResourceView === "poster" ? "☷ 列表视图" : "▦ 海报视图"}</button><button class="btn" onclick="refreshMovieMetadata()">↻ 重新刮削</button></div></div>${body}`;
}
function renderMovieLibrary(lib, files) { const host = document.createElement("div"); renderMovieLibraryContent(host, lib, files); return host.innerHTML; }
function renderMovieRow(lib, file) { const path=String(file.path), meta=movieMetadataFor(path); return `<div class="media-file-row"><div class="media-file-name" title="${esc(path)}"><b>${esc(meta.title)}</b><small>${esc([meta.year, meta.provider].filter(Boolean).join(" · "))}</small></div><span class="media-file-meta">${esc(fileExt(path).toUpperCase())} · ${formatFileSize(file.size)}</span><div class="media-actions"><button class="btn" data-media-group="movie" data-media-library="${esc(lib.id)}" data-media-path="${esc(path)}" onclick="openLocalMediaButton(this)">▶ 播放</button></div></div>`; }
function renderMoviePoster(lib, file) { const path=String(file.path), meta=movieMetadataFor(path), art=meta.poster ? `<img src="${esc(meta.poster)}" alt="${esc(meta.title)}" loading="lazy">` : `<span>${esc(meta.title)}</span>`; return `<article class="media-poster-card" data-media-group="movie" data-media-library="${esc(lib.id)}" data-media-path="${esc(path)}" onclick="openLocalMediaButton(this)"><div class="media-poster-art" style="${meta.poster ? "" : `background:${coverGradient(meta.title)}`}" >${art}</div><div class="media-poster-info"><strong>${esc(meta.title)}</strong><small>${esc([meta.year,meta.provider].filter(Boolean).join(" · ") || fileExt(path).toUpperCase())}</small></div></article>`; }
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
function mediaTypeName(type) { return ({ audio: "音乐", musicvideo: "音乐视频（歌曲 MV）", comic: "漫画", book: "电子书", movie: "电影", series: "电视剧集" })[type] || type; }
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
function mediaAdminHeaders() {
  let token = document.getElementById("mediaAdminToken")?.value.trim() || "";
  if (!token) {
    try { token = localStorage.getItem("dwu_media_admin_token") || ""; } catch (e) {}
  } else {
    try { localStorage.setItem("dwu_media_admin_token", token); } catch (e) {}
  }
  return token ? { "X-VaultHub-Token": token } : {};
}
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
    const res = await fetch("/api/media/libraries", { headers: mediaAdminHeaders(), cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    localMediaLibraries = normalizeLibraryPayload(await res.json());
    renderMediaLibraryConfigList();
    ["comic", "movie", "audio"].forEach(group => { if (mediaMode(group) === "local") renderLocalMedia(group); });
    if (notify) toast("✅ 本地媒体库已刷新");
  } catch (err) {
    ["comic", "movie", "audio"].forEach(group => {
      if (mediaMode(group) !== "local") return;
      const host = document.getElementById("media-wide-" + group);
      if (host) host.innerHTML = `${mediaModeBar(group)}<div class="media-error">无法读取本地媒体库：${esc(err.message)}</div>`;
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
    host.innerHTML = `${mediaModeBar(group)}<div class="media-empty"><div class="big">▤</div><h3>暂无本地媒体库</h3><p>添加容器内已挂载的绝对路径后，即可浏览音乐、漫画、电子书或影视。</p><button class="btn btn-primary" onclick="showMediaLibraryConfig('${esc(group)}')">⚙ 配置媒体库</button></div>`;
    return;
  }
  let selected = libs.find(lib => lib.id === localMediaSelection[group]) || libs[0];
  localMediaSelection[group] = selected.id;
  host.innerHTML = `${mediaModeBar(group)}<div class="local-media">
    <div class="library-strip">${libs.map(lib => `<button class="library-chip ${lib.id === selected.id ? "active" : ""}" onclick="selectLocalLibrary('${esc(group)}','${esc(lib.id)}')">${esc(lib.name)}<small>${esc(mediaTypeName(lib.type))}</small></button>`).join("")}</div>
    <div id="local-media-content-${esc(group)}"><div class="empty-tip">正在读取文件...</div></div>
    <div id="local-media-viewer-${esc(group)}"></div>
  </div>`;
  loadLocalFiles(group, selected);
}
function selectLocalLibrary(group, id) {
  localMediaSelection[group] = id;
  renderLocalMedia(group);
}
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
      target.innerHTML = '<div class="empty-tip">正在后台建立低速索引，请稍后刷新。扫描不会阻塞页面。</div>';
      return;
    }
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
      const toolbar = `<div class="comic-shelf-toolbar"><div class="comic-shelf-tabs"><button class="${comicShelfView === "shelf" ? "active" : ""}" onclick="setComicShelfView('shelf')">📚 书架</button><button class="${comicShelfView === "completed" ? "active" : ""}" onclick="setComicShelfView('completed')">✓ 已读收藏</button></div><div class="media-actions"><button class="btn" onclick="refreshBookCovers()">↻ 重新刮削封面</button><label class="page-size-picker">每页 <select id="mediaPageSize" onchange="setMediaPageSize(this.value)"><option value="20"${pageSize===20?' selected':''}>20</option><option value="50"${pageSize===50?' selected':''}>50</option><option value="100"${pageSize===100?' selected':''}>100</option></select></label></div></div>`;
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
  const stem = displayBookTitle(path);
  const parts = stem.split(" - ");
  return { title: parts.length > 1 ? parts[parts.length - 1].trim() : stem, artist: parts.length > 1 ? parts[0].trim() : "未知歌手", album: "未知专辑", cover: "", lyrics: "" };
}
function audioMetadataFor(path) {
  const all = readAudioMetadata();
  return { ...audioBaseMetadata(path), ...(all[path] || {}) };
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
    const path = String(file.path), fallback = all[path], query = `${fallback.artist} ${fallback.title}`.trim();
    try {
      const response = await fetch(`https://musicbrainz.org/ws/2/recording/?query=${encodeURIComponent(query)}&fmt=json&limit=1`, { headers: { Accept: "application/json" }, cache: "force-cache" });
      const item = response.ok ? (await response.json()).recordings?.[0] : null;
      if (item) {
        all[path] = { ...fallback, title: item.title || fallback.title, artist: item["artist-credit"]?.[0]?.name || fallback.artist, album: item.releases?.[0]?.title || fallback.album, checkedAt: Date.now() };
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
  const pager = `<div class="media-actions"><button class="btn" ${audioCursor <= 0 ? "disabled" : ""} onclick="loadLocalFiles('audio',findMediaLibrary('${esc(lib.id)}'),${Math.max(0,audioCursor-audioPageSize)})">← 上一页</button><span class="media-file-meta">${audioCursor + 1}-${audioCursor + files.length}</span><button class="btn" onclick="loadLocalFiles('audio',findMediaLibrary('${esc(lib.id)}'),${audioCursor + audioPageSize})">下一页 →</button></div>`;
  const visibleFiles = audioArtistFilter ? files.filter(file => { const meta = audioMetadataFor(String(file.path)); return meta.artist === audioArtistFilter || meta.album === audioArtistFilter; }) : files;
  let body = audioView === "tracks" ? renderAudioTrackList(lib, visibleFiles) : audioView === "artists" ? renderAudioArtists(lib, files) : audioView === "favorites" ? renderAudioFavorites(lib) : mediaResourceView === "list" ? `<div class="media-file-list">${visibleFiles.map(file => renderAudioRow(lib, file)).join("")}</div>` : renderAudioAlbums(lib, files);
  host.innerHTML = `<div class="comic-shelf-toolbar"><div class="audio-view-tabs"><button class="${audioView === "albums" ? "active" : ""}" onclick="setAudioView('albums')">专辑</button><button class="${audioView === "artists" ? "active" : ""}" onclick="setAudioView('artists')">歌手</button><button class="${audioView === "favorites" ? "active" : ""}" onclick="setAudioView('favorites')">♥ 喜欢</button></div><div class="media-actions"><button class="btn media-view-toggle" onclick="toggleMediaResourceView('audio')">${mediaResourceView === "poster" ? "☷ 列表视图" : "▦ 海报视图"}</button><button class="btn" onclick="refreshAudioMetadata()">↻ 重新刮削</button><label class="page-size-picker">每页 <select id="audioPageSize" onchange="setAudioPageSize(this.value)"><option value="20"${audioPageSize===20?' selected':''}>20</option><option value="50"${audioPageSize===50?' selected':''}>50</option><option value="100"${audioPageSize===100?' selected':''}>100</option></select></label></div></div>${body}${audioView === "favorites" || audioView === "tracks" ? "" : pager}`;
}
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
function audioStop() { const player=document.getElementById("audioPlayerElement"); if(!player) return; player.pause(); player.currentTime=0; document.getElementById("audioPauseButton").textContent="▶"; }
function audioPrevious() { if(!activeAudio || !audioFiles.length) return; const index=(activeAudio.index-1+audioFiles.length)%audioFiles.length; playAudioFile(activeAudio.libId,audioFiles[index].path); }
function audioNext() {
  if(!activeAudio || !audioFiles.length) return;
  const player = document.getElementById("audioPlayerElement");
  if (audioLoopMode === "single") { player.currentTime = 0; player.play().catch(() => {}); return; }
  if (audioLoopMode === "random") { let index = Math.floor(Math.random() * audioFiles.length); if (audioFiles.length > 1 && index === activeAudio.index) index = (index + 1) % audioFiles.length; playAudioFile(activeAudio.libId, audioFiles[index].path); return; }
  const nextIndex = activeAudio.index + 1;
  if (audioLoopMode === "sequence" && nextIndex >= audioFiles.length) { player.pause(); player.currentTime = 0; document.getElementById("audioPauseButton").textContent="▶"; return; }
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
  const download = `${url}${url.includes("?") ? "&" : "?"}download=1`;
  const chapters = opts.chapters || [];
  const chapterHtml = chapters.length ? `<aside class="ebook-chapters"><h4>目录 · ${chapters.length} 章</h4>${chapters.map((ch, i) => `<button data-chapter="${i}" onclick="jumpEbookChapter(${i})">${esc(ch.title)}</button>`).join("")}</aside>` : "";
  const toolbar = opts.ebook ? `<span class="ebook-toolbar"><button title="减小字号" onclick="changeEbookFontSize(-1)">A-</button><button title="增大字号" onclick="changeEbookFontSize(1)">A+</button><button id="ebookFontStyleButton" title="正体/斜体" onclick="toggleEbookFontStyle()">正体</button></span>` : "";
  return `<div class="media-reader-overlay ${readerThemeClass()}"><div class="media-reader-head"><strong class="media-reader-title" title="${esc(path)}">${esc(displayBookTitle(path))}</strong><div class="media-actions">${toolbar}<button class="btn" title="系统设置" onclick="openModal('settingsModal')">⚙ 设置</button><button class="btn" onclick="markReaderCompleted()">✓ 标记已读</button><a class="btn" href="${esc(download)}" download>↓ 下载</a><button class="media-reader-close" title="关闭并返回书架" onclick="closeLocalViewer('${esc(group)}')">✕</button></div></div><div class="media-reader-body" data-reader-scroll onscroll="trackReaderProgress(this)">${chapterHtml}<div class="media-reader-wrap">${body}</div></div></div>`;
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
function updateVideoStatus(root, video, state) {
  const main=root?.querySelector("[data-video-status]"); const detail=root?.querySelector("[data-video-detail]");
  if (!main || !detail || !video) return;
  main.textContent=state;
  const mode=(video.dataset.currentSrc||"").includes("/api/media/compat") ? `兼容流 · ${settings.hardwareAcceleration}` : "原片直连";
  const size=video.videoWidth ? `${video.videoWidth}×${video.videoHeight}` : "分辨率待获取";
  detail.textContent=`${formatMediaTime(video.currentTime)} / ${formatMediaTime(video.duration)} · ${size} · ${mode}`;
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
  const useDirect = () => { setMovieCompatStatus(root, "直连播放"); switchMovieSource(video, direct); };
  const useCompat = reason => { setMovieCompatStatus(root, reason || "音频兼容流：AAC 输出"); switchMovieSource(video, compat); };
  root.querySelector("[data-movie-direct]")?.addEventListener("click", useDirect);
  root.querySelector("[data-movie-compat]")?.addEventListener("click", () => useCompat("手动切换：音频兼容流"));
  video.addEventListener("loadedmetadata", () => { video.muted = false; video.volume = 1; restoreVideoPlaybackState(video); fetch(`/api/media/streams?id=${encodeURIComponent(lib.id)}&path=${encodeURIComponent(path)}`,{cache:'no-store'}).then(r=>r.ok?r.json():null).then(info=>populateVideoTracks(videoRoot,video,info)).catch(()=>{}); });
  video.addEventListener("error", () => { if (video.dataset.currentSrc !== compat) useCompat("直连失败，已自动切换兼容流"); });
  const extRule = movieExtensionNeedsCompat(path) || browserSaysVideoContainerUnsupported(path);
  if (extRule) { useCompat("自动判定：容器格式可能不兼容，使用 AAC 兼容流"); return; }
  useDirect();
  try {
    const res = await fetch(mediaProbeUrl(lib, path), { cache: "no-store" });
    if (!res.ok) return;
    const info = await res.json();
    if (info && info.compat_recommended && video.dataset.currentSrc !== compat) useCompat(`自动判定：音频 ${info.audio_codec || "未知"} 可能不兼容，使用 AAC 兼容流`);
    else setMovieCompatStatus(root, `直连播放${info.audio_codec ? " · 音频 " + info.audio_codec : ""}`);
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
  else if (MEDIA_FORMATS.movie.includes(ext)) body = `<div class="media-viewer-body media-video-body" data-video-controls-visible="true"><div class="movie-compat-bar"><button class="btn" type="button" data-movie-direct>直连原片</button><button class="btn" type="button" data-movie-compat>音频兼容</button><span class="movie-compat-status">正在判定播放方式...</span></div><button class="video-menu-button" type="button" title="字幕和音轨" aria-label="字幕和音轨" onclick="toggleVideoTrackMenu(this)">☷</button><button class="video-info-button" type="button" title="播放状态信息" aria-label="播放状态信息" aria-expanded="false" onclick="toggleVideoStatusPanel(this)">!</button><video data-movie-player controls playsinline preload="metadata" onloadedmetadata="this.muted=false;this.volume=1" onvolumechange="this.dataset.volume=String(this.volume)"></video><div class="video-timeline"><span class="video-time-label">00:00 / 00:00</span><div class="video-progress-shell" role="slider" aria-label="播放进度" onclick="seekVideoTimeline(event,this)"><span class="video-buffered-range"></span><span class="video-played-range"></span></div></div><div class="video-track-menu video-audio-menu" data-video-track-menu><h4>音源</h4><div class="video-audio-options" data-video-audio-options>读取音源中...</div><h4>字幕</h4><div class="video-subtitle-menu" data-video-subtitle-options>暂无外挂字幕</div><button type="button" onclick="searchVideoSubtitles(this)">搜索并挂载字幕</button></div><div class="video-status-panel"><span class="status-main" data-video-status>准备播放</span><span class="status-detail" data-video-detail>--:-- / --:-- · 分辨率待获取</span></div></div>`;
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
      const overlay = viewer.querySelector(".media-reader-overlay");
      if (overlay) overlay.scrollIntoView({ block: "start" });
      return;
    } catch (err) {
      body = `<div class="media-error">文本读取失败：${esc(err.message)}</div>`;
      viewer.innerHTML = viewerShell(group, lib, path, body, url);
      return;
    }
  } else {
    const note = MEDIA_FORMATS.comic.includes(ext) ? "该漫画/压缩格式已加入书架。当前浏览器不能直接解析时，可下载后用专业阅读器打开。" : MEDIA_FORMATS.book.includes(ext) ? "该电子书格式已加入书架。浏览器不支持直接解析时，可在新窗口打开或下载阅读。" : "该格式可下载或交给浏览器打开。";
    body = `<div class="reader-book-fallback"><div class="book-cover" style="max-width:220px;margin:0 auto 24px;background:${coverGradient(displayBookTitle(path))}"><span class="book-cover-title">${esc(displayBookTitle(path))}</span></div><p>${note}</p><p><a class="btn btn-primary" href="${esc(url)}" target="_blank" rel="noopener">↗ 尝试在浏览器打开</a></p></div>`;
  }
  viewer.innerHTML = viewerShell(group, lib, path, body, url);
  if (group === "movie" && MEDIA_FORMATS.movie.includes(ext)) initMovieCompatPlayer(viewer, lib, path);
  const overlay = viewer.querySelector(".media-reader-overlay");
  if (overlay) overlay.scrollIntoView({ block: "start" });
}
