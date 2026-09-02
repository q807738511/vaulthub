/* VaultHub 首页（V4 Plex 风格）—— 四栏内容渲染。
   依赖 01-state.js / 02-media.js 里的全局函数（t、esc、localMediaLibraries、
   mediaTypesForGroup、mediaTypeName、coverGradient、displayBookTitle、
   movieMetadataFor、audioMetadataFor、readingState、findMediaLibrary…），
   因此必须在它们之后加载。 */

const HOME_GROUPS = ["comic", "movie", "audio"];
/* 大类名称走 i18n：这里只保留「分组 → i18n 键」的映射，实际文案在渲染时取，
   否则语言切换后表格与占位文案仍是中文。 */
const HOME_GROUP_I18N = { comic: "navGroupBook", movie: "navGroupVideo", audio: "navGroupAudio" };
const homeGroupLabel = group => t(HOME_GROUP_I18N[group] || group);
const HOME_GROUP_ICON = { comic: "📖", movie: "🎬", audio: "🎵" };
const HOME_TYPE_ICON = { book: "📖", comic: "📚", movie: "🎬", series: "📺", audio: "🎵", musicvideo: "🎤" };
const HOME_FILTER_GROUPS = { all: HOME_GROUPS, book: ["comic"], video: ["movie"], audio: ["audio"] };
let homeFilter = "all";
let homeIndexStatus = {};

function homeGroupOfType(type) {
  if (type === "comic" || type === "book") return "comic";
  if (type === "movie" || type === "series") return "movie";
  return "audio";
}

/* ---------- 侧栏：一个扁平的媒体库列表 ----------
   v0.7.0：不再按「电子书刊 / 影视作品 / 音视作品」三个大类各起一节，
   也不再重复出现大类本身的入口。侧栏只显示媒体库创建时填写的名称
   （本地媒体库 + 外连服务），大类只在系统设置的媒体库配置里出现。 */
function renderHomeLibraryNav() {
  const host = document.getElementById("libNavAll");
  if (!host) return;
  const rows = [];
  (localMediaLibraries || []).forEach(lib => {
    const group = homeGroupOfType(lib.type);
    const count = Number(homeIndexStatus[lib.id]?.total || 0);
    /* data-nav-key 唯一标识一个媒体库条目。漫画与电子书都落在 data-view="comic"，
       只靠 data-view 无法区分，switchView 会永远高亮排在前面的那一个。 */
    rows.push(`<div class="nav-item" data-view="${esc(group)}" data-lib-id="${esc(lib.id)}" `
      + `data-nav-key="${esc(group + ":" + lib.id)}" `
      + `onclick="openHomeLibrary('${esc(group)}',${jsAttrArg(lib.id)})" title="${esc(lib.name)}">`
      + `<span class="ic">${HOME_TYPE_ICON[lib.type] || "📄"}</span>`
      + `<span class="txt">${esc(lib.name)}</span>`
      + `<span class="cnt">${count ? formatHomeCount(count) : ""}</span></div>`);
  });
  if (typeof externalServices !== "undefined") {
    externalServices.forEach(svc => {
      rows.push(`<div class="nav-item" data-view="${esc(svc.group)}" data-lib-id="${esc(svc.id)}" `
        + `data-nav-key="${esc(svc.group + ":" + svc.id)}" `
        + `onclick="openExternalService(${jsAttrArg(svc.id)})" title="${esc(svc.name)}">`
        + `<span class="ic">🔗</span><span class="txt">${esc(svc.name)}</span>`
        + `<span class="cnt">↗</span></div>`);
    });
  }
  host.innerHTML = rows.length ? rows.join("")
    : `<div class="nav-empty">${esc(t("libNavEmpty"))}</div>`;
  /* 这里每 5 秒被 initHome 的定时器整体重建一次（为了刷新计数与索引进度）。
     重建出来的节点都是新的、都不带 active，因此必须按 switchView 记下的
     选中键重新套用高亮，否则用户点完媒体库 5 秒后侧栏就什么都不亮了。 */
  const activeKey = window.vaultHubActiveNavKey;
  if (activeKey) {
    const keep = [...host.querySelectorAll(".nav-item[data-nav-key]")]
      .find(n => n.dataset.navKey === activeKey);
    if (keep) keep.classList.add("active");
  }
}
function openHomeLibrary(group, libId) {
  /* 先把当前媒体库切过去再切视图，并把 libId 传给 switchView，
     否则同组的漫画与电子书无法区分，侧栏高亮会停在排在前面的那一个。 */
  selectLocalLibrary(group, libId);
  switchView(group, libId);
}
function formatHomeCount(n) {
  const v = Number(n) || 0;
  return v >= 1000 ? (v / 1000).toFixed(1).replace(/\.0$/, "") + "k" : String(v);
}

/* ---------- 筛选条与统计 ---------- */
function initHomeFilters() {
  document.querySelectorAll(".fchip[data-home-filter]").forEach(chip => {
    chip.addEventListener("click", () => {
      homeFilter = chip.dataset.homeFilter || "all";
      document.querySelectorAll(".fchip[data-home-filter]").forEach(x => x.classList.toggle("on", x === chip));
      applyHomeFilter();
      renderHomeRecent();
    });
  });
}
function applyHomeFilter() {
  const show = HOME_FILTER_GROUPS[homeFilter] || HOME_GROUPS;
  const map = { comic: ["recentBook"], movie: ["recentVideo"], audio: ["recentAudio"] };
  HOME_GROUPS.forEach(group => {
    const visible = show.includes(group);
    map[group].forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      el.style.display = visible ? "" : "none";
      /* 同时隐藏它上方紧邻的区块标题 */
      const title = el.previousElementSibling;
      if (title && title.classList.contains("section-title")) title.style.display = visible ? "" : "none";
    });
  });
}
function renderHomeCount() {
  const el = document.getElementById("homeCount");
  const libs = localMediaLibraries || [];
  const items = libs.reduce((sum, lib) => sum + Number(homeIndexStatus[lib.id]?.total || 0), 0);
  const text = libs.length
    ? tf("homeCountFmt", { items: items.toLocaleString(curLang === "en" ? "en-US" : "zh-CN"), libs: libs.length })
    : t("homeCountEmpty");
  if (el) el.textContent = text;
  /* 顶栏只保留正在构建索引和播放状态，不再重复展示媒体库总数。 */
  const topScan = document.getElementById("topScanStat");
  if (topScan) {
    const scanning = Object.values(homeIndexStatus).filter(s => s && (s.running || s.state === "scanning"));
    topScan.textContent = scanning.length ? "⏳ " + tf("buildScanned", { n: scanning.reduce((n, s) => n + Number(s.scanned || 0), 0) }) : "";
  }
  const setCount = document.getElementById("setLibCount");
  if (setCount) setCount.textContent = tf("libCountBadge", { n: libs.length });
  HOME_GROUPS.forEach(group => {
    const cnt = document.getElementById("kindCount" + group.charAt(0).toUpperCase() + group.slice(1));
    if (cnt) cnt.textContent = tf("libCountFmt", { n: (librariesForGroup(group) || []).length });
  });
}

/* ---------- 第一栏补充：硬盘剩余容量（复用 /api/system/metrics 的 disks） ---------- */
function renderHomeDiskSummary(disks) {
  const text = document.getElementById("diskFreeText");
  const bar = document.getElementById("diskFreeBar");
  if (!text || !bar) return;
  const list = Array.isArray(disks) ? disks : [];
  if (!list.length) { text.textContent = "--"; bar.style.width = "0%"; return; }
  let total = 0, used = 0;
  list.forEach(d => { total += Number(d.total || 0); used += Number(d.used || 0); });
  if (total <= 0) { text.textContent = "--"; bar.style.width = "0%"; return; }
  const free = total - used;
  const pct = Math.round(used / total * 100);
  text.textContent = `${formatHomeBytes(free)} / ${formatHomeBytes(total)}`;
  bar.style.width = pct + "%";
  bar.className = pct >= 90 ? "hot" : pct >= 75 ? "warn" : "";
}
function formatHomeBytes(n) {
  const v = Number(n) || 0;
  if (v >= 1099511627776) return (v / 1099511627776).toFixed(1) + " TB";
  if (v >= 1073741824) return (v / 1073741824).toFixed(1) + " GB";
  if (v >= 1048576) return (v / 1048576).toFixed(0) + " MB";
  return v + " B";
}

/* ---------- 第二栏：正在进行中的操作（视频 / 音乐播放 + 刮削信息） ---------- */
function renderNowPlaying() {
  const host = document.getElementById("nowPlayingList");
  if (!host) return;
  const rows = [];

  /* 音乐：来自底部播放器的实时状态 */
  const player = document.getElementById("audioPlayerElement");
  if (activeAudio && player && player.src) {
    const lib = findMediaLibrary(activeAudio.libId);
    const meta = audioMetadataFor(activeAudio.path);
    const dur = Number.isFinite(player.duration) ? player.duration : 0;
    const pct = dur ? Math.min(100, player.currentTime / dur * 100) : 0;
    const ext = fileExt(activeAudio.path).toUpperCase() || "AUDIO";
    const isMv = lib?.type === "musicvideo";
    rows.push({
      cls: isMv ? "" : "audio",
      icon: isMv ? "🎤" : "🎵",
      cover: meta.cover || "",
      grad: coverGradient(meta.title || "audio"),
      title: meta.title,
      yr: `${meta.artist} · 《${meta.album}》`,
      meta: `${lib ? lib.name : "音乐库"} · ${ext}${dur ? " · " + formatMediaTime(dur) : ""}`,
      tags: [
        { c: "src", v: isMv ? "音乐 MV" : "MusicBrainz" },
        { c: "lib", v: lib ? lib.name : "音视作品" },
        { c: "", v: ext },
        { c: "", v: meta.lyrics ? "歌词已刮削" : "无歌词" },
        { c: "", v: meta.cover ? "封面已刮削" : "封面待刮削" }
      ],
      plot: meta.lyrics ? String(meta.lyrics).replace(/\[[^\]]*\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120) : "暂无歌词，可在「文件」视图手动适配歌曲信息。",
      pct,
      kind: player.paused ? "♪ 已暂停" : "♪ 音乐播放",
      tm: `${formatMediaTime(player.currentTime)} / ${formatMediaTime(dur)}`,
      note: [isMv ? "音乐 MV 播放" : "Navidrome · 原码直传", lib ? lib.name : ""]
    });
  }

  /* 视频：读取 vaulthub_video_<lib>_<path> 播放进度，取最近 2 条未看完的 */
  const vids = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith("vaulthub_video_")) continue;
      const saved = JSON.parse(localStorage.getItem(key) || "null");
      if (!saved || !Number.isFinite(saved.time) || saved.time < 5) continue;
      const rest = key.slice("vaulthub_video_".length);
      const lib = (localMediaLibraries || []).find(l => rest.startsWith(l.id + "_"));
      if (!lib) continue;
      vids.push({ lib, path: rest.slice(lib.id.length + 1), time: saved.time, at: Number(saved.updatedAt || 0) });
    }
  } catch (e) {}
  vids.sort((a, b) => b.at - a.at);
  vids.slice(0, 2).forEach(v => {
    const meta = movieMetadataFor(v.path);
    const ext = fileExt(v.path).toUpperCase() || "VIDEO";
    rows.push({
      cls: "",
      icon: v.lib.type === "series" ? "📺" : "🎬",
      cover: meta.poster || "",
      grad: coverGradient(meta.title || v.path),
      title: meta.title || displayBookTitle(v.path),
      yr: meta.year ? `(${meta.year})` : "",
      meta: `${v.lib.name} · ${mediaTypeName(v.lib.type)} · ${ext}`,
      tags: [
        meta.rating ? { c: "rate", v: "★ " + meta.rating } : null,
        { c: "src", v: meta.provider || "文件名展示" },
        { c: "lib", v: v.lib.name },
        { c: "", v: ext },
        { c: "", v: meta.poster ? "海报已刮削" : "海报待刮削" }
      ].filter(Boolean),
      plot: meta.overview || "暂无简介，刮削完成后会自动补齐。",
      pct: 0,
      kind: "▶ 视频播放",
      tm: `已看到 ${formatMediaTime(v.time)}`,
      note: ["上次播放位置已记忆", v.lib.name]
    });
  });

  if (!rows.length) {
    host.innerHTML = `<div class="card"><div class="empty-tip">${esc(t("nowEmpty"))}</div></div>`;
    return;
  }
  host.innerHTML = rows.map(r => `<div class="now-row ${r.cls}">
    <div class="now-th" style="background:${r.cover ? "#1b1f28" : r.grad}">
      ${r.cover ? `<img src="${esc(r.cover)}" alt="" onerror="this.remove()">` : `<span>${r.icon}</span>`}
      ${r.pct ? `<div class="prog"><i style="width:${r.pct.toFixed(1)}%"></i></div>` : ""}
    </div>
    <div class="now-body">
      <div class="now-ttl">${esc(r.title)}${r.yr ? `<span class="yr">${esc(r.yr)}</span>` : ""}</div>
      <div class="now-meta">${esc(r.meta)}</div>
      <div class="scrape">${r.tags.map(x => `<span class="${x.c}">${esc(x.v)}</span>`).join("")}</div>
      <div class="plot">${esc(r.plot)}</div>
      <div class="now-line"><i style="width:${(r.pct || 0).toFixed(1)}%"></i></div>
    </div>
    <div class="now-rt">
      <b>${esc(r.kind)}</b>
      <span class="tm">${esc(r.tm)}</span>
      ${r.note.filter(Boolean).map(x => `<span>${esc(x)}</span>`).join("")}
    </div>
  </div>`).join("");
}
function formatMediaTime(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return (h ? h + ":" + String(m).padStart(2, "0") : String(m)) + ":" + String(r).padStart(2, "0");
}

/* ---------- 第三 / 四栏：最近入库（按 mtime 倒序取每库前 N 条） ---------- */
async function recentFilesForGroup(group, limit) {
  const libs = librariesForGroup(group) || [];
  const out = [];
  for (const lib of libs) {
    try {
      const res = await fetch(`/api/media/files?id=${encodeURIComponent(lib.id)}&sort=mtime&limit=${limit}`, { cache: "no-store" });
      if (!res.ok) continue;
      const data = await res.json();
      (data.files || []).forEach(f => {
        const path = String(f.path || "");
        if (!path || !supportedLocalMediaFile(group, lib, path)) return;
        out.push({ lib, path, mtime: Number(f.mtime || 0), size: Number(f.size || 0) });
      });
    } catch (e) {}
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out.slice(0, limit);
}
function homePosterCard(group, item, square) {
  const { lib, path } = item;
  const isAudioAlbum = lib.type === "audio";
  const isVideoish = lib.type === "movie" || lib.type === "series" || lib.type === "musicvideo";
  const meta = isVideoish ? movieMetadataFor(path) : isAudioAlbum ? audioMetadataFor(path) : null;
  const title = isVideoish ? (meta.title || displayBookTitle(path))
    : isAudioAlbum ? (meta.title || displayBookTitle(path))
    : displayBookTitle(path);
  const cover = isVideoish ? (meta.poster || "") : isAudioAlbum ? (meta.cover || "") : "";
  const ext = fileExt(path).toUpperCase() || "FILE";
  const icon = HOME_TYPE_ICON[lib.type] || "📄";
  const sub = isVideoish && meta.year ? `${mediaTypeName(lib.type)} · ${meta.year}`
    : isAudioAlbum ? `${mediaTypeName(lib.type)} · ${meta.artist || "未知歌手"}`
    : `${mediaTypeName(lib.type)} · ${formatHomeBytes(item.size)}`;
  const prog = Number(readingState(lib.id, path).progress || 0);
  return `<div class="hp ${square ? "sq" : ""}" onclick="openHomeMediaItem('${esc(group)}',${jsAttrArg(lib.id)},${jsAttrArg(path)})" title="${esc(path)}">
    <div class="img" style="${cover ? "" : "background:" + coverGradient(title)}">
      ${cover ? `<img src="${esc(cover)}" alt="" loading="lazy" onerror="this.remove()">` : `<div class="fake">${icon}</div>`}
      <div class="tag">${esc(ext)}</div>
      <div class="lib">${esc(lib.name)}</div>
      <div class="play">▶</div>
      ${prog > 0 && prog < 99.9 ? `<div class="prog"><i style="width:${prog.toFixed(1)}%"></i></div>` : ""}
    </div>
    <div class="nm">${esc(title)}</div>
    <div class="st">${esc(sub)}</div>
  </div>`;
}
/* 首页「最近入库」以前直接调用 openLocalMedia()，但阅读器容器
   #local-media-viewer-<group> 只有在对应媒体库视图渲染之后才存在，
   所以在首页点击等于什么都没发生。现在先切到该库的视图、等容器就绪，
   再打开阅读器/播放器，实现「点击即读取播放」。 */
async function openHomeMediaItem(group, libId, path) {
  const lib = findMediaLibrary(libId);
  if (!lib) { toast("⚠️ " + t("homeOpenFail")); return; }
  openHomeLibrary(group, libId);
  const viewer = await waitForMediaViewer(group);
  if (!viewer) { toast("⚠️ " + t("homeOpenFail")); return; }
  if (group === "audio" && typeof playAudioFile === "function"
      && MEDIA_FORMATS.audio.includes(fileExt(path))) {
    /* 音乐直接进播放器，不需要打开阅读器外壳。 */
    playAudioFile(libId, path);
    return;
  }
  await openLocalMedia(group, libId, path);
}
function waitForMediaViewer(group, tries = 40) {
  return new Promise(resolve => {
    let left = tries;
    const tick = () => {
      const el = document.getElementById("local-media-viewer-" + group);
      if (el) { resolve(el); return; }
      if (--left <= 0) { resolve(null); return; }
      setTimeout(tick, 50);
    };
    tick();
  });
}
async function renderHomeRecent() {
  const show = HOME_FILTER_GROUPS[homeFilter] || HOME_GROUPS;
  const targets = { comic: "recentBook", movie: "recentVideo", audio: "recentAudio" };
  for (const group of HOME_GROUPS) {
    const host = document.getElementById(targets[group]);
    if (!host || !show.includes(group)) continue;
    const libs = librariesForGroup(group) || [];
    if (!libs.length) {
      host.innerHTML = `<div class="card" style="grid-column:1/-1"><div class="empty-tip">${esc(tf("homeEmptyLib", { kind: homeGroupLabel(group) }))}</div></div>`;
      continue;
    }
    host.innerHTML = `<div class="card" style="grid-column:1/-1"><div class="empty-tip">${esc(t("homeLoading"))}</div></div>`;
    const items = await recentFilesForGroup(group, 10);
    host.innerHTML = items.length
      ? items.map(item => homePosterCard(group, item, group === "audio")).join("")
      : `<div class="card" style="grid-column:1/-1"><div class="empty-tip">${esc(t("homeNoIndexed"))}</div></div>`;
  }
}

/* ---------- 媒体库路径管理 ---------- */
/* v0.9.30：子类型/媒体路径/库名称/添加按钮都在大类卡片内，
   每个大类各有一套 id 后缀（homeLibType-comic 等），不再有公共下拉。
   传 group 只同步该大类，不传则三张卡片一起同步。 */
const LIB_KIND_GROUPS = ["comic", "movie", "audio"];
function activeLibKindGroup() {
  const card = document.querySelector(".lib-kind.on[data-lib-group]");
  return card?.dataset.libGroup || mediaLibraryConfigGroup || "comic";
}
function syncHomeLibTypes(group) {
  const groups = group ? [group] : LIB_KIND_GROUPS;
  for (const g of groups) {
    const sel = document.getElementById("homeLibType-" + g);
    if (!sel) continue;
    const keep = sel.value;
    const types = mediaTypesForGroup(g);
    sel.innerHTML = types.map(x => `<option value="${esc(x)}">${esc(mediaTypeName(x))}</option>`).join("");
    if (types.includes(keep)) sel.value = keep;
  }
}
async function addHomeMediaLibrary(group) {
  const g = LIB_KIND_GROUPS.includes(group) ? group : activeLibKindGroup();
  const type = document.getElementById("homeLibType-" + g)?.value || mediaTypeForGroup(g);
  const pathInput = document.getElementById("homeLibPath-" + g);
  const nameInput = document.getElementById("homeLibName-" + g);
  const path = (pathInput?.value || "").trim().replace(/\/$/, "");
  const name = (nameInput?.value || "").trim();
  if (!name || !path) { toast("⚠️ 请填写媒体路径与库名称"); return; }
  if (!path.startsWith("/")) { toast("⚠️ 路径必须是容器内已挂载的绝对路径"); return; }
  /* v0.7.0：新增媒体库是唯一的添加入口（旧弹窗已删除），
     所以写操作前的会话守卫必须在这里，而不是在已经移除的 saveMediaLibraries 里。 */
  if (!await ensureSessionForWrite(t("writeAddLibrary"))) return;
  const body = { id: libraryId(name, type, path, 0), name, type, path };
  try {
    const res = await fetch("/api/media/libraries", {
      method: "POST",
      headers: sessionWriteHeaders(true),
      credentials: "same-origin",
      body: JSON.stringify(body)
    });
    if (!await handleProtectedResponse(res)) { toast("⚠️ " + tf("sessionWriteBlocked", { action: t("writeAddLibrary") })); return; }
    if (!res.ok) {
      let detail = "";
      try { detail = (await res.json()).error || ""; } catch (e) {}
      if (/id already exists/i.test(detail)) { toast("✅ 该媒体路径已添加"); return; }
      throw new Error(detail || `HTTP ${res.status}`);
    }
    document.getElementById("homeLibPath-" + g).value = "";
    document.getElementById("homeLibName-" + g).value = "";
    await refreshMediaLibraries(false);
    await refreshHomeData();
    toast(`✅ 媒体库「${name}」已添加，开始扫描`);
  } catch (err) { toast("⚠️ 添加失败：" + err.message); }
}
async function rebuildAllLibraries() {
  try {
    const res = await fetch("/api/media/index/rebuild", { method: "POST", headers: sessionWriteHeaders(), credentials: "same-origin" });
    if (!await handleProtectedResponse(res)) { toast("⚠️ 会话已过期，请重新登录"); return; }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    toast("🔄 已触发全部媒体库重新扫描");
    setTimeout(refreshHomeData, 1500);
  } catch (err) { toast("⚠️ 触发失败：" + err.message); }
}
async function rebuildOneLibrary(id) {
  try {
    const res = await fetch(`/api/media/index/rebuild?id=${encodeURIComponent(id)}`, { method: "POST", headers: sessionWriteHeaders(), credentials: "same-origin" });
    if (!await handleProtectedResponse(res)) { toast("⚠️ 会话已过期，请重新登录"); return; }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    toast("🔄 已触发重新扫描");
    setTimeout(refreshHomeData, 1500);
  } catch (err) { toast("⚠️ 触发失败：" + err.message); }
}
async function loadHomeIndexStatus() {
  try {
    const res = await fetch("/api/media/index/status", { cache: "no-store" });
    if (!res.ok) return;
    const data = await res.json();
    const map = {};
    (data.libraries || []).forEach(s => { map[s.lib] = s; });
    homeIndexStatus = map;
  } catch (e) {}
}
function homeLibStatePill(st) {
  if (!st) return `<span class="pill info">${esc(t("stateWait"))}</span>`;
  if (st.running || st.state === "scanning") {
    const pct = st.total ? Math.min(99, Math.round(st.scanned / st.total * 100)) : 0;
    return `<span class="pill warn">${esc(t("stateScraping"))}${pct ? " " + pct + "%" : ""}</span>`;
  }
  if (st.state === "error") return `<span class="pill bad" title="${esc(st.message || "")}">${esc(t("stateFail"))}</span>`;
  if (st.state === "cancelled") return `<span class="pill bad">${esc(t("stateCancelled"))}</span>`;
  if (st.state === "ready") return `<span class="pill ok">${esc(t("stateDone"))}</span>`;
  return `<span class="pill info">${esc(t("stateWait"))}</span>`;
}
function renderHomeLibTable() {
  const body = document.getElementById("homeLibBody");
  if (!body) return;
  const libs = localMediaLibraries || [];
  if (!libs.length) {
    body.innerHTML = `<tr><td colspan="6"><div class="empty-tip">${esc(t("libEmpty"))}</div></td></tr>`;
    return;
  }
  body.innerHTML = libs.map(lib => {
    const group = homeGroupOfType(lib.type);
    const st = homeIndexStatus[lib.id];
    const paths = (lib.paths && lib.paths.length ? lib.paths : [lib.path]).filter(Boolean);
    return `<tr>
      <td><div class="lib-name-cell"><span>${HOME_TYPE_ICON[lib.type] || "📄"}</span>${esc(lib.name)}</div></td>
      <td>${esc(homeGroupLabel(group))} · ${esc(mediaTypeName(lib.type))}</td>
      <td class="mono">${paths.map(esc).join("<br>")}</td>
      <td>${st ? Number(st.total || 0).toLocaleString(curLang === "en" ? "en-US" : "zh-CN") : "--"}</td>
      <td>${homeLibStatePill(st)}</td>
      <td><div class="row-acts">
        <button class="icon-btn" title="${esc(t("actRescan"))}" onclick="rebuildOneLibrary('${esc(lib.id)}')">🔄</button>
        <button class="icon-btn" title="${esc(t("actOpenLib"))}" onclick="openHomeLibrary('${esc(group)}','${esc(lib.id)}')">↗</button>
        <button class="icon-btn" title="${esc(t("actRemove"))}" onclick="deleteMediaLibrary('${esc(lib.id)}')">✕</button>
      </div></td>
    </tr>`;
  }).join("");
}
function initLibKindCards() {
  document.querySelectorAll(".lib-kind[data-lib-group]").forEach(card => {
    card.addEventListener("click", event => {
      /* v0.9.30：卡片内含子类型/路径/库名称/添加按钮，点这些控件不能被
         当成「切换大类」，否则输入焦点会在每次点击时被重置。 */
      if (event.target.closest(".lib-kind-form")) return;
      document.querySelectorAll(".lib-kind").forEach(x => x.classList.toggle("on", x === card));
      syncHomeLibTypes(card.dataset.libGroup);
    });
  });
  syncHomeLibTypes();
}

/* ---------- 汇总刷新 ---------- */
async function refreshHomeData() {
  await loadHomeIndexStatus();
  renderHomeCount();
  renderHomeLibraryNav();
  renderHomeLibTable();
  renderNowPlaying();
  await renderHomeRecent();
}
function initHome() {
  syncHomeLibTypes();
  initHomeFilters();
  initLibKindCards();
  applyHomeFilter();
  refreshHomeData();
  /* 播放状态每 5s 跟随监控刷新；索引状态每 20s 拉一次 */
  setInterval(renderNowPlaying, 5000);
  /* 索引状态 5 秒一次：顶栏「正在构建」提示与侧栏计数需要及时反映扫描进度。 */
  setInterval(async () => {
    await loadHomeIndexStatus();
    renderHomeCount();
    renderHomeLibraryNav();
    renderHomeLibTable();
  }, 5000);
}
