/* VaultHub frontend — split from index.html in phase 4.
   Plain ordered classic scripts (no bundler): global functions remain global
   so the ~131 inline on*= handlers keep working. Load order is fixed by the
   <script> tags in index.html and MUST be preserved. */
function closeLocalViewer(group) {
  const prior = activeReader;
  const el = document.getElementById("local-media-viewer-" + group);
  if (el) el.innerHTML = "";
  activeReader = null;
  if (group === "comic") {
    setComicShelfView("shelf");
    if (prior && readingState(prior.libId, prior.path).progress >= COMPLETED_PROGRESS) toast("📚 已读文档已移入收藏");
  }
}
function showMediaLibraryConfig(group) {
  mediaLibraryConfigGroup = group;
  const modal = document.getElementById("mediaLibraryModal");
  const type = document.getElementById("mediaLibType");
  if (type) { const allowed = mediaTypesForGroup(group); type.innerHTML = allowed.map(x => `<option value="${esc(x)}">${esc(mediaTypeName(x))}</option>`).join(""); type.value = allowed[0]; }
  const token = document.getElementById("mediaAdminToken");
  try { if (token) token.value = localStorage.getItem("dwu_media_admin_token") || ""; } catch (e) {}
  renderMediaLibraryConfigList();
  modal?.classList.add("show");
}
function addMediaPath(value = "") {
  const host = document.getElementById("mediaLibPaths");
  if (!host) return;
  const row = document.createElement("div");
  row.className = "media-path-row";
  row.innerHTML = `<input type="text" class="media-lib-path" placeholder="/books 或 /mnt/music" value="${esc(value)}"><button class="icon-btn" type="button" title="删除路径" onclick="removeMediaPath(this)">✕</button>`;
  host.appendChild(row);
}
function removeMediaPath(button) {
  const host = document.getElementById("mediaLibPaths");
  button.closest(".media-path-row")?.remove();
  if (host && !host.children.length) addMediaPath();
}
function libraryId(name, type, path, index) {
  const raw = `${type}-${name}-${path}-${index}`.toLowerCase();
  let hash = 2166136261;
  for (let i = 0; i < raw.length; i++) { hash ^= raw.charCodeAt(i); hash = Math.imul(hash, 16777619); }
  const slug = String(name || type).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 28) || type;
  return `${slug}-${(hash >>> 0).toString(36)}`;
}
async function saveMediaLibraries() {
  const name = document.getElementById("mediaLibName")?.value.trim();
  const type = document.getElementById("mediaLibType")?.value;
  const paths = [...document.querySelectorAll(".media-lib-path")].map(el => el.value.trim().replace(/\/$/, "")).filter(Boolean);
  const token = document.getElementById("mediaAdminToken")?.value.trim() || "";
  if (!name || !type || !paths.length) { toast("⚠️ 请填写库名称、类型和至少一个路径"); return; }
  if (paths.some(path => !path.startsWith("/"))) { toast("⚠️ 路径必须是容器内已挂载的绝对路径"); return; }
  try { localStorage.setItem("dwu_media_admin_token", token); } catch (e) {}
  try {
    let saved = 0;
    let skipped = 0;
    for (let i = 0; i < paths.length; i++) {
      const body = { id: libraryId(name, type, paths[i], i), name: paths.length > 1 ? `${name} ${i + 1}` : name, type, path: paths[i] };
      const res = await fetch("/api/media/libraries", { method: "POST", headers: { "Content-Type": "application/json", ...mediaAdminHeaders() }, credentials: "same-origin", body: JSON.stringify(body) });
      if (!await handleProtectedResponse(res)) { toast("⚠️ 会话已过期，请重新登录后再保存"); return; }
      if (!res.ok) {
        let detail = "";
        try { detail = (await res.json()).error || ""; } catch (e) {}
        if (/id already exists/i.test(detail)) { skipped++; continue; }
        throw new Error(detail || `HTTP ${res.status}`);
      }
      saved++;
    }
    document.getElementById("mediaLibName").value = "";
    document.getElementById("mediaLibPaths").innerHTML = "";
    addMediaPath();
    await refreshMediaLibraries(false);
    if (saved && skipped) toast(`✅ 已保存 ${saved} 个路径，跳过 ${skipped} 个已存在路径`);
    else if (skipped && !saved) toast("✅ 这些媒体路径已经添加，无需重复保存");
    else toast("✅ 本地媒体库已保存");
  } catch (err) { toast("⚠️ 保存失败：" + err.message); }
}
function renderMediaLibraryConfigList() {
  const host = document.getElementById("mediaLibraryConfigList");
  if (!host) return;
  const visibleLibraries = localMediaLibraries.filter(lib => mediaTypesForGroup(mediaLibraryConfigGroup).includes(lib.type));
  if (!visibleLibraries.length) { host.innerHTML = '<div class="empty-tip">当前栏目尚未配置本地媒体库</div>'; return; }
  host.innerHTML = `<div class="media-file-list">${visibleLibraries.map(lib => `<div class="media-file-row"><div class="media-file-name"><strong>${esc(lib.name)}</strong><div class="hint">${esc((lib.paths || []).join(" · ") || lib.path)}</div></div><span class="badge">${esc(mediaTypeName(lib.type))}</span><button class="btn btn-danger" onclick="deleteMediaLibrary('${esc(lib.id)}')">删除</button></div>`).join("")}</div>`;
}
async function deleteMediaLibrary(id) {
  if (!confirm("确定删除这个本地媒体库配置？媒体文件不会被删除。")) return;
  try {
    const res = await fetch(`/api/media/libraries?id=${encodeURIComponent(id)}`, { method: "DELETE", headers: mediaAdminHeaders(), credentials: "same-origin" });
    if (!await handleProtectedResponse(res)) { toast("⚠️ 会话已过期，请重新登录后再删除"); return; }
    if (!res.ok) { let detail = ""; try { detail = (await res.json()).error || ""; } catch (e) {} throw new Error(detail || `HTTP ${res.status}`); }
    await refreshMediaLibraries(false);
    toast("✅ 媒体库配置已删除");
  } catch (err) { toast("⚠️ 删除失败：" + err.message); }
}

/* ================= 内置系统监控 ================= */

async function fetchJson(url, timeout = 4000, headers = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: "no-store", headers });
    clearTimeout(timer);
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.json();
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

let previousNetworkSample = null;
async function tickMetrics() {
  let ok = false;
  try {
    const data = await fetchJson("/api/system/metrics");
    if (data.enabled === false) throw new Error("monitoring disabled");
    const mem = data.memory || {};
    const total = Number(mem.total || 0), used = Number(mem.used || 0);
    const pct = total ? Math.round(used * 100 / total) : 0;
    const cpu = data.cpu || {};
    const net = data.network || {};
    const cores = cpu.cores != null && Number(cpu.cores) > 0 ? String(cpu.cores) : "--";
    const cpuTemp = Number(cpu.temp) > 0 ? Number(cpu.temp).toFixed(0) + "°C" : "--";
    setCpu(Number(cpu.percent || 0), cores, cpu.load1 != null ? Number(cpu.load1).toFixed(2) : "--", cpuTemp);
    const swapUsed = Number(mem.swap_used || 0);
    setMem(pct, (used / 1073741824).toFixed(1), (total / 1073741824).toFixed(1), (swapUsed / 1073741824).toFixed(1));
    const now = performance.now();
    let down = 0, up = 0;
    if (previousNetworkSample) {
      const seconds = Math.max((now - previousNetworkSample.time) / 1000, 0.001);
      down = Math.max(0, Number(net.rx_bytes || 0) - previousNetworkSample.rx) / seconds / 1048576;
      up = Math.max(0, Number(net.tx_bytes || 0) - previousNetworkSample.tx) / seconds / 1048576;
    }
    previousNetworkSample = { rx: Number(net.rx_bytes || 0), tx: Number(net.tx_bytes || 0), time: now };
    setNet(down, up);
    const netLabel = document.getElementById("netInterface");
    if (netLabel) netLabel.textContent = net.interface ? net.interface : "";
    renderDiskTemps(data.disk_temperatures, data.temperatures);
    const disks = data.filesystems || [];
    document.getElementById("diskCard").innerHTML = disks.map(d => {
      const p = Math.min(Number(d.percent || 0), 100);
      const free = Math.max(0, Number(d.total || 0) - Number(d.used || 0));
      return `<div class="disk-row"><div class="disk-top"><span class="name">${esc(d.path)}</span><span>${fmtSize(d.used)} / ${fmtSize(d.total)} · ${esc(t("diskFreeShort"))} ${fmtSize(free)} · ${p}%</span></div><div class="bar"><i class="${p > 90 ? "hot" : p > 75 ? "warn" : ""}" style="width:${p}%"></i></div></div>`;
    }).join("") || `<div class="empty-tip">${esc(t("noVolumes"))}</div>`;
    document.getElementById("diskSource").textContent = t("diskSourceReal");
    /* 首页第一栏「硬盘使用率」卡内的容量剩余汇总 */
    if (typeof renderHomeDiskSummary === "function") renderHomeDiskSummary(disks);
    ok = true;
  } catch (e) {
    setCpu(0, "--", "--", "--");
    setMem(0, "--", "--", "--");
    setNet(0, 0);
    renderDiskTemps([], []);
    if (typeof renderHomeDiskSummary === "function") renderHomeDiskSummary([]);
    document.getElementById("diskSource").textContent = t("diskSourceOffline");
  }

  setNasBadge(ok);
}

// renderDiskTemps fills the disk-temperature card. It prefers real drive/NVMe
// sensors; when the host exposes none (common on NAS boxes without drivetemp),
// it falls back to the hottest available sensor (usually the CPU package) so
// the card shows a live reading instead of a permanent "--".
function renderDiskTemps(diskTemps, allTemps) {
  const main = document.getElementById("tempMain");
  const list = document.getElementById("tempList");
  if (!main || !list) return;
  let entries = Array.isArray(diskTemps) ? diskTemps.slice() : [];
  let usingFallback = false;
  if (!entries.length && Array.isArray(allTemps) && allTemps.length) {
    entries = allTemps.slice().sort((a, b) => Number(b.temp) - Number(a.temp));
    usingFallback = true;
  }
  if (!entries.length) { main.textContent = "--"; list.innerHTML = ""; return; }
  const hottest = entries.reduce((m, x) => Number(x.temp) > Number(m.temp) ? x : m, entries[0]);
  main.textContent = Number(hottest.temp).toFixed(0);
  list.innerHTML = entries.slice(0, 6).map(x => `<div class="temp-item"><span>${esc(x.name)}</span><b>${Number(x.temp).toFixed(0)}°C</b></div>`).join("")
    + (usingFallback ? `<div class="hint" style="margin-top:6px;">${curLang === "en" ? "No dedicated drive sensor; showing system sensors." : "未检测到独立硬盘温度传感器，显示系统传感器读数。"}</div>` : "");
}

function fmtSize(bytes) {
  if (!bytes && bytes !== 0) return "--";
  const g = bytes / 1073741824;
  if (g >= 1024) return (g / 1024).toFixed(2) + " TB";
  return g.toFixed(1) + " GB";
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* 仪表半径 29 → 周长 2πr ≈ 182，与 index.html 的 stroke-dasharray 保持一致 */
const GAUGE_CIRCUMFERENCE = 182;
function setCpu(pct, cores, load, temp) {
  document.getElementById("cpuVal").textContent = Math.round(pct) + "%";
  document.getElementById("cpuArc").style.strokeDashoffset = GAUGE_CIRCUMFERENCE - (GAUGE_CIRCUMFERENCE * Math.min(pct, 100) / 100);
  document.getElementById("cpuCores").textContent = cores;
  document.getElementById("cpuLoad").textContent = load;
  document.getElementById("cpuTemp").textContent = temp;
}
function setMem(pct, used, total, swap) {
  document.getElementById("memVal").textContent = pct + "%";
  document.getElementById("memArc").style.strokeDashoffset = GAUGE_CIRCUMFERENCE - (GAUGE_CIRCUMFERENCE * Math.min(pct, 100) / 100);
  document.getElementById("memUsed").textContent = used + " GB";
  document.getElementById("memTotal").textContent = total + " GB";
  document.getElementById("memSwap").textContent = swap + " GB";
}

function setNet(down, up) {
  document.getElementById("netDown").textContent = down.toFixed(1);
  document.getElementById("netUp").textContent = up.toFixed(1);
  const spark = document.getElementById("netSpark");
  if (spark.children.length > 16) spark.removeChild(spark.firstChild);
  const b = document.createElement("i");
  b.style.height = Math.min(100, 15 + down / 2) + "%";
  spark.appendChild(b);
}
function setNasBadge(online) {
  const badge = document.getElementById("nasBadge");
  badge.textContent = online ? t("nasOnline") : t("nasOffline");
  badge.className = "badge" + (online ? " green" : " red");
}


/* ================= PT 管理（登录 + 站点管理 + PT 监护室） ================= */
const MOCK_MP_SITES = [
  { name: "馒头", domain: "m-team.cc", cookie: "*****", is_active: true, pri: 0, success: 3, fail: 0 },
  { name: "堡", domain: "pthome.net", cookie: "*****", is_active: true, pri: 0, success: 3, fail: 0 },
  { name: "天空", domain: "hdsky.me", cookie: "*****", is_active: true, pri: 0, success: 3, fail: 0 },
  { name: "套娃", domain: "hdchina.org", cookie: "*****", is_active: false, pri: 0, success: 0, fail: 3 }
];

const MOCK_PT_SITES = {
  summary: { total: 200, healthy: 190, critical: 2, closed: 3, mp_owned: 4 },
  fetched_at: "2026-08-12 09:30:00",
  alerts: [
    { level: "critical", text: "病危通知：某站（示例）已连续 7 天无法访问，请尽快备份数据。" },
    { level: "info", text: "站庆预告：馒头站将于本周六迎来站庆，双倍魔力活动。" }
  ],
  sites: [
    { name: "馒头", domain: "m-team.cc", status: "healthy", year: "2010", anniversary_text: "站庆还有 3 天", mp_status: "owned" },
    { name: "堡", domain: "pthome.net", status: "healthy", year: "2014", anniversary_text: "", mp_status: "owned" },
    { name: "天空", domain: "hdsky.me", status: "healthy", year: "2011", anniversary_text: "今天站庆 🎉", mp_status: "owned" },
    { name: "套娃", domain: "hdchina.org", status: "critical", year: "2009", anniversary_text: "", mp_status: "owned" },
    { name: "NexusHD", domain: "nexushd.org", status: "healthy", year: "2016", anniversary_text: "", mp_status: "available" }
  ]
};

const MOCK_PT_USERDATA = [
  { domain: "m-team.cc", site: "馒头", upload: "2.4 TB", download: "860 GB", ratio: 2.79, seeding: 327, bonus: 18640, user_level: "Power User", ok: true },
  { domain: "pthome.net", site: "堡", upload: "1.1 TB", download: "620 GB", ratio: 1.77, seeding: 198, bonus: 9320, user_level: "User", ok: true },
  { domain: "hdsky.me", site: "天空", upload: "3.2 TB", download: "1.4 TB", ratio: 2.28, seeding: 412, bonus: 25110, user_level: "Power User", ok: true },
  { domain: "hdchina.org", site: "套娃", upload: "240 GB", download: "180 GB", ratio: 1.33, seeding: 56, bonus: 3040, user_level: "User", ok: false }
];

const PT_ICONS = { "馒头": ["馒", "#3b82f6"], "堡": ["堡", "#ef4444"], "天空": ["天", "#8b5cf6"], "套娃": ["套", "#f59e0b"] };

function mpBase() { return (settings.mp.mpUrl || "").replace(/\/+$/, ""); }
function mpHeaders() {
  const h = { "Content-Type": "application/json" };
  if (settings.mp.token) h["Authorization"] = "Bearer " + settings.mp.token;
  return h;
}

/* MP 专用 fetch：http 失败自动升级 https 重试（Cloudflare 域名 http 会被 301 拦截且无 CORS 头） */
async function mpFetch(url, options = {}, timeout = 6000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } catch (e) {
    if (url.startsWith("http://")) {
      const ctrl2 = new AbortController();
      const timer2 = setTimeout(() => ctrl2.abort(), timeout);
      try {
        return await fetch("https://" + url.slice(7), { ...options, signal: ctrl2.signal });
      } finally { clearTimeout(timer2); }
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function mpFetchJson(url, timeout = 6000) {
  const res = await mpFetch(url, { headers: mpHeaders() }, timeout);
  if (!res.ok) throw new Error("HTTP " + res.status);
  return await res.json();
}

/* 多层容错提取数组：兼容 {data:[...]} / {data:{list:[...]}} / 纯数组 */
function extractList(res) {
  if (Array.isArray(res)) return res;
  if (res && typeof res === "object") {
    for (const k of ["data", "list", "items", "result", "records"]) {
      if (Array.isArray(res[k])) return res[k];
    }
    if (res.data && typeof res.data === "object") {
      for (const k of ["list", "items", "result", "sites", "records"]) {
        if (Array.isArray(res.data[k])) return res.data[k];
      }
    }
  }
  return [];
}

/* 诊断条：显示各接口返回结构摘要，便于定位问题 */
let diag = {};
function setDiag(key, info) {
  diag[key] = info;
  const el = document.getElementById("ptDiag");
  if (!el) return;
  const parts = Object.entries(diag).map(([k, v]) => `${k}: ${v}`);
  el.textContent = parts.join(" · ");
  el.style.display = parts.length ? "block" : "none";
}

function fmtBytes(b) {
  if (b == null) return "--";
  const g = b / 1073741824;
  if (g >= 1024) return (g / 1024).toFixed(2) + " TB";
  return g.toFixed(1) + " GB";
}

async function loginMp() {
  const url = mpBase();
  const user = document.getElementById("mpUser").value.trim();
  const pass = document.getElementById("mpPass").value;
  if (!url || !user || !pass) { toast("⚠️ " + (curLang === "en" ? "Fill address, account and password" : "请填写地址、账号和密码")); return; }
  const btn = document.getElementById("btnMpLogin");
  btn.disabled = true;
  toast(t("testConnecting"));
  try {
    const body = new URLSearchParams();
    body.append("username", user);
    body.append("password", pass);
    const res = await mpFetch(url + "/api/v1/login/access-token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString()
    }, 8000);
    if (res.status === 401 && res.headers.get("X-MFA-Required")) {
      toast("⚠️ " + (curLang === "en" ? "MFA 2FA required — not supported in preview" : "账号开启了二次验证(MFA)，预览版暂不支持"));
      return;
    }
    if (!res.ok) { toast("❌ " + (curLang === "en" ? "Login failed (HTTP " + res.status + ")" : "登录失败（HTTP " + res.status + "）")); return; }
    const data = await res.json();
    if (!data.access_token) { toast("❌ " + (curLang === "en" ? "No token returned" : "未获取到 Token")); return; }
    settings.mp.mpUrl = url;
    settings.mp.username = user;
    settings.mp.password = pass;
    settings.mp.token = data.access_token;
    settings.mp.tokenUser = data.user_name || user;
    saveSettings();
    toast("✅ " + (curLang === "en" ? "Logged in as " : "登录成功：") + (data.user_name || user));
    renderPtLoginState();
    closeModal("mpModal");
    loadPtAll();
  } catch (e) {
    toast("❌ " + (curLang === "en" ? "Cannot reach MoviePilot — use https:// for domains or the LAN IP" : "无法连接 MoviePilot — 域名请带 https://，或改用内网 IP 直连"));
  } finally {
    btn.disabled = false;
  }
}

function mpLogout() {
  settings.mp.token = "";
  settings.mp.tokenUser = "";
  saveSettings();
  renderPtLoginState();
  switchPtSub("sites");
  renderPtMock();
  toast("🚪 " + (curLang === "en" ? "Logged out" : "已退出登录"));
}

function renderPtLoginState() {
  const dot = document.getElementById("mpDot");
  const badge = document.getElementById("ptSourceBadge");
  if (settings.mp.token) {
    dot.classList.remove("red");
    badge.textContent = "✅ " + (settings.mp.tokenUser || settings.mp.username || "已登录");
    badge.className = "badge green";
  } else {
    dot.classList.add("red");
    badge.textContent = t("ptNotLoggedIn");
    badge.className = "badge red";
  }
}

function switchPtSub(sub) {
  document.querySelectorAll(".tab[data-ptsub]").forEach(x => x.classList.toggle("active", x.dataset.ptsub === sub));
  document.querySelectorAll(".ptsub-panel").forEach(p => p.classList.toggle("active", p.id === "ptsub-" + sub));
}

async function refreshPt(force = false) {
  if (!settings.mp.token) { renderPtMock(); return; }
  await loadPtAll();
}

async function loadPtAll() {
  if (!settings.mp.token) { renderPtMock(); return; }
  const results = await Promise.allSettled([loadMpSites(), loadMpUserdata(), loadGuard()]);
  const failed = results.filter(r => r.status === "rejected");
  if (failed.length) {
    toast("⚠️ " + (curLang === "en" ? `Loaded ${3 - failed.length}/3, ${failed.length} API failed — see diagnostic bar` : `已加载 ${3 - failed.length}/3，${failed.length} 个接口失败 — 见顶部诊断条`));
  }
}

async function loadMpSites() {
  try {
    const res = await mpFetchJson(mpBase() + "/api/v1/site", 6000);
    const list = extractList(res);
    setDiag("site", `array[${list.length}] keys:${list.length ? Object.keys(list[0] || {}).join(",") : "empty"}`);
    const body = document.getElementById("ptSiteBody");
    document.getElementById("ptSiteCount").textContent = `${list.length} 站`;
    body.innerHTML = list.map(s => {
      const active = s.is_active !== false;
      return `<tr>
        <td><b>${esc(s.name || "--")}</b></td>
        <td class="mono">${esc(s.domain || s.url || "")}</td>
        <td>${s.cookie ? "🟢 " + (curLang === "en" ? "has cookie" : "已配置") : "🔴 " + (curLang === "en" ? "no cookie" : "无 Cookie")}</td>
        <td><span style="color:${active ? "var(--green)" : "var(--red)"}">${active ? (curLang === "en" ? "Enabled" : "启用") : (curLang === "en" ? "Disabled" : "停用")}</span></td>
        <td class="mono">${s.pri != null ? s.pri : 0}</td>
      </tr>`;
    }).join("");
    if (!list.length) body.innerHTML = `<tr><td colspan="5" style="text-align:center;color:var(--text2);padding:20px;">${curLang === "en" ? "No sites in MoviePilot yet" : "MoviePilot 中暂无站点"}</td></tr>`;
  } catch (e) {
    setDiag("site", "FAIL " + e.message);
    throw e;
  }
}

async function loadMpUserdata() {
  try {
    const res = await mpFetchJson(mpBase() + "/api/v1/site/userdata/latest", 6000);
    const list = extractList(res);
    setDiag("userdata", `array[${list.length}] keys:${list.length ? Object.keys(list[0] || {}).join(",") : "empty"}`);
    const grid = document.getElementById("ptGrid");
    if (!list.length) {
      grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;color:var(--text2);font-size:13px;padding:24px;">${curLang === "en" ? "No site data — refresh userdata in MoviePilot" : "暂无站点数据，请在 MoviePilot 中刷新站点数据"}</div>`;
      return;
    }
    grid.innerHTML = list.map(d => {
      const siteName = d.site || d.domain || "--";
      const icon = PT_ICONS[siteName] || [String(siteName).slice(0, 1), "#64748b"];
      const ratio = d.ratio || 0;
      const ratioColor = ratio >= 1.5 ? "var(--green)" : ratio >= 1 ? "var(--yellow)" : "var(--red)";
      const ok = d.upload != null || d.ratio != null;
      return `<div class="card pt-card">
        <div class="pt-head">
          <span class="pt-name"><span class="pt-ico" style="background:${icon[1]};">${icon[0]}</span>${esc(siteName)}</span>
          <span class="status" style="color:${ok ? "var(--green)" : "var(--red)"};">${ok ? "✓" : "✕"}</span>
        </div>
        <div class="pt-stats">
          <div><span>${t("ptUp")}</span><b>${fmtBytes(d.upload)}</b></div>
          <div><span>${t("ptDown")}</span><b>${fmtBytes(d.download)}</b></div>
          <div><span>${t("ptRatio")}</span><b style="color:${ratioColor}">${(ratio != null && ratio.toFixed) ? ratio.toFixed(2) : (ratio ?? "--")}</b></div>
          <div><span>${t("ptSeed")}</span><b>${d.seeding != null ? d.seeding : "--"}</b></div>
          <div><span>${t("ptMagic")}</span><b>${d.bonus != null ? Number(d.bonus).toLocaleString() : "--"}</b></div>
          <div><span>${t("ptLevel")}</span><b>${esc(d.user_level || "--")}</b></div>
        </div>
        <span class="pt-seed" style="${ok ? "" : "color:var(--red);"}">${ok ? t("ptOk") : t("ptErr")}</span>
      </div>`;
    }).join("");
  } catch (e) {
    setDiag("userdata", "FAIL " + e.message);
    throw e;
  }
}

/* PT 监护室：插件状态 + 工作状态 + 快照 */
async function loadGuard() {
  const base = mpBase();
  const pluginPaths = [
    "/api/v1/plugin/sites",
    "/api/v1/plugin/summary",
    "/api/v1/plugin/Savept/sites",
    "/api/v1/plugin/savept/sites",
    "/api/v2/plugin/Savept/sites",
    "/api/v2/plugin/savept/sites"
  ];
  const configPaths = [
    "/api/v1/plugin/config",
    "/api/v1/plugin/Savept/config",
    "/api/v1/plugin/savept/config",
    "/api/v2/plugin/Savept/config",
    "/api/v2/plugin/savept/config"
  ];
  /* 1. 插件安装/启用状态 */
  let installed = false, enabled = false, version = "--";
  try {
    const plugins = await mpFetchJson(base + "/api/v1/plugin?state=installed", 6000);
    const list = extractList(plugins);
    setDiag("plugin", `array[${list.length}]`);
    const sp = list.find(p => (p.id || "").toLowerCase().includes("savept") || (p.plugin_id || "").toLowerCase().includes("savept") || (p.name || "").toLowerCase().includes("pt监护") || (p.plugin_name || "").toLowerCase().includes("pt监护") || (p.name || "").toLowerCase().includes("savept"));
    if (sp) {
      installed = true;
      enabled = sp.installed !== false && sp.is_active !== false && sp.enabled !== false;
      version = sp.version || sp.local_version || sp.plugin_version || "--";
      setDiag("saveptPlugin", `FOUND keys:${Object.keys(sp).join(",")}`);
    } else {
      setDiag("saveptPlugin", "NOT_FOUND in plugin list");
    }
  } catch (e) {
    setDiag("plugin", "FAIL " + e.message);
  }
  document.getElementById("guardInstalled").textContent = installed ? (curLang === "en" ? "✅ Installed" : "✅ 已安装") : (curLang === "en" ? "❌ Not installed" : "❌ 未安装");
  document.getElementById("guardEnabled").textContent = installed ? (enabled ? (curLang === "en" ? "✅ Enabled" : "✅ 已启用") : (curLang === "en" ? "⏸ Disabled" : "⏸ 未启用")) : "--";
  document.getElementById("guardVersion").textContent = version;
  const gDot = document.getElementById("guardDot");
  gDot.classList.remove("red", "yellow");
  if (!installed) gDot.classList.add("red");
  else if (!enabled) gDot.classList.add("yellow");

  /* 2. 工作状态（插件配置） */
  let cfgHit = "--";
  for (const path of configPaths) {
    try {
      const cfg = await mpFetchJson(base + path, 5000);
      const c = cfg && cfg.data ? cfg.data : cfg;
      cfgHit = path;
      document.getElementById("guardSource").textContent = c.source_url || "--";
      document.getElementById("guardCron").textContent = c.cron || "--";
      document.getElementById("guardNotify").textContent = c.notify ? (curLang === "en" ? "✅ On" : "✅ 开启") : (curLang === "en" ? "Off" : "关闭");
      setDiag("saveptConfig", path);
      break;
    } catch (e) {
      setDiag("saveptConfig", "probing...");
    }
  }
  if (cfgHit === "--") {
    document.getElementById("guardSource").textContent = "--";
    document.getElementById("guardCron").textContent = "--";
    document.getElementById("guardNotify").textContent = "--";
    setDiag("saveptConfig", "NO_MATCH");
  }

  /* 3. 快照（站点状态 + 公告） */
  let snap = null, snapHit = "";
  for (const path of pluginPaths.filter(p => p.endsWith("/sites"))) {
    try {
      const raw = await mpFetchJson(base + path, 6000);
      const data = raw && raw.data ? raw.data : raw;
      if (data && (data.sites || data.summary || data.alerts)) {
        snap = data;
        snapHit = path;
        setDiag("saveptSites", `${path} keys:${Object.keys(data).join(",")}`);
        break;
      }
    } catch (e) {
      setDiag("saveptSites", `try ${path}: ${e.message}`);
    }
  }
  if (!snap) {
    document.getElementById("guardAlerts").innerHTML = `<div class="alert-bar critical">⚠️ ${t("guardPluginMissing")}<br><span class="mono">${curLang === "en" ? "Tried" : "已尝试"}: ${pluginPaths.filter(p => p.endsWith("/sites")).join(" · ")}</span></div>`;
    document.getElementById("guardSiteBody").innerHTML = "";
    document.getElementById("guardSyncBadge").textContent = "--";
    return;
  }
  const s = snap.summary || {};
  document.getElementById("guardTotal").textContent = s.total || (snap.sites || []).length || 0;
  document.getElementById("guardHealthy").textContent = s.healthy || 0;
  document.getElementById("guardCritical").textContent = s.critical || 0;
  document.getElementById("guardClosed").textContent = s.closed || 0;
  document.getElementById("guardOwned").textContent = s.mp_owned || 0;
  document.getElementById("guardFetched").textContent = snap.fetched_at || "--";
  document.getElementById("guardSyncBadge").textContent = `${(snap.sites || []).length} 站同步 · ${snapHit}`;
  document.getElementById("guardAlerts").innerHTML = (snap.alerts || []).map(a =>
    `<div class="alert-bar ${esc(a.level)}">${esc(a.text)}</div>`).join("");
  const body = document.getElementById("guardSiteBody");
  body.innerHTML = (snap.sites || []).slice(0, 40).map(site => {
    const stKey = { healthy: "stHealthy", critical: "stCritical", closed: "stClosed" }[site.status] || "stUnknown";
    const stColor = site.status === "healthy" ? "var(--green)" : site.status === "critical" ? "var(--red)" : "var(--text2)";
    const mpKey = { owned: "mpOwned", available: "mpAvailable", unsupported: "mpUnsupported" }[site.mp_status] || "--";
    const anniv = site.anniversary_text ? (site.anniversary_text.includes("今天") ? `<span style="color:var(--yellow)">🎉 ${esc(site.anniversary_text)}</span>` : esc(site.anniversary_text)) : "--";
    return `<tr>
      <td><b>${esc(site.name)}</b></td>
      <td class="mono">${esc(site.domain || site.url || "")}</td>
      <td><span style="color:${stColor}">● ${t(stKey)}</span></td>
      <td>${esc(site.year || "--")}</td>
      <td>${anniv}</td>
      <td>${t(mpKey)}</td>
    </tr>`;
  }).join("");
  if (!(snap.sites || []).length) body.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--text2);padding:20px;">${curLang === "en" ? "No snapshot — install & enable Savept plugin" : "无快照数据 — 请先安装并启用 Savept(Vue-PT监护室) 插件"}</td></tr>`;
}

function renderPtMock() {
  renderPtLoginState();
  switchPtSub(document.querySelector(".tab[data-ptsub].active")?.dataset.ptsub || "sites");
  /* 站点管理 mock */
  const body = document.getElementById("ptSiteBody");
  document.getElementById("ptSiteCount").textContent = `${MOCK_MP_SITES.length} 站`;
  body.innerHTML = MOCK_MP_SITES.map(s => `
    <tr>
      <td><b>${esc(s.name)}</b></td>
      <td class="mono">${esc(s.domain)}</td>
      <td>🟢 ${curLang === "en" ? "has cookie" : "已配置"}</td>
      <td><span style="color:${s.is_active ? "var(--green)" : "var(--red)"}">${s.is_active ? (curLang === "en" ? "Enabled" : "启用") : (curLang === "en" ? "Disabled" : "停用")}</span></td>
      <td class="mono">${s.pri}</td>
    </tr>`).join("");
  document.getElementById("ptGrid").innerHTML = MOCK_PT_USERDATA.map(d => {
    const icon = PT_ICONS[d.site] || [d.site.slice(0, 1), "#64748b"];
    const ratioColor = d.ratio >= 1.5 ? "var(--green)" : d.ratio >= 1 ? "var(--yellow)" : "var(--red)";
    return `<div class="card pt-card">
      <div class="pt-head">
        <span class="pt-name"><span class="pt-ico" style="background:${icon[1]};">${icon[0]}</span>${esc(d.site)}</span>
        <span class="status" style="color:${d.ok ? "var(--green)" : "var(--red)"};">${d.ok ? "✓" : "✕"}</span>
      </div>
      <div class="pt-stats">
        <div><span>${t("ptUp")}</span><b>${esc(d.upload)}</b></div>
        <div><span>${t("ptDown")}</span><b>${esc(d.download)}</b></div>
        <div><span>${t("ptRatio")}</span><b style="color:${ratioColor}">${d.ratio}</b></div>
        <div><span>${t("ptSeed")}</span><b>${d.seeding}</b></div>
        <div><span>${t("ptMagic")}</span><b>${esc(d.magic)}</b></div>
        <div><span>${t("ptLevel")}</span><b>${esc(d.level)}</b></div>
      </div>
      <span class="pt-seed" style="${d.ok ? "" : "color:var(--red);"}">${d.ok ? t("ptOk") : t("ptErr")}</span>
    </div>`;
  }).join("");
  /* 监护室 mock */
  const s = MOCK_PT_SITES.summary;
  document.getElementById("guardInstalled").textContent = "✅ " + (curLang === "en" ? "Installed" : "已安装");
  document.getElementById("guardEnabled").textContent = "✅ " + (curLang === "en" ? "Enabled" : "已启用");
  document.getElementById("guardVersion").textContent = "v1.1.1";
  document.getElementById("guardSource").textContent = "https://savept.icu/";
  document.getElementById("guardFetched").textContent = MOCK_PT_SITES.fetched_at;
  document.getElementById("guardCron").textContent = "0 9 * * *";
  document.getElementById("guardNotify").textContent = curLang === "en" ? "✅ On" : "✅ 开启";
  document.getElementById("guardTotal").textContent = s.total;
  document.getElementById("guardHealthy").textContent = s.healthy;
  document.getElementById("guardCritical").textContent = s.critical;
  document.getElementById("guardClosed").textContent = s.closed;
  document.getElementById("guardOwned").textContent = s.mp_owned;
  document.getElementById("guardSyncBadge").textContent = `${MOCK_PT_SITES.sites.length} 站同步`;
  document.getElementById("guardDot").classList.remove("red", "yellow");
  document.getElementById("guardAlerts").innerHTML = MOCK_PT_SITES.alerts.map(a =>
    `<div class="alert-bar ${esc(a.level)}">${esc(a.text)}</div>`).join("");
  document.getElementById("guardSiteBody").innerHTML = MOCK_PT_SITES.sites.map(site => {
    const stKey = { healthy: "stHealthy", critical: "stCritical", closed: "stClosed" }[site.status] || "stUnknown";
    const stColor = site.status === "healthy" ? "var(--green)" : site.status === "critical" ? "var(--red)" : "var(--text2)";
    const mpKey = { owned: "mpOwned", available: "mpAvailable", unsupported: "mpUnsupported" }[site.mp_status] || "--";
    const anniv = site.anniversary_text ? (site.anniversary_text.includes("今天") ? `<span style="color:var(--yellow)">🎉 ${esc(site.anniversary_text)}</span>` : esc(site.anniversary_text)) : "--";
    return `<tr>
      <td><b>${esc(site.name)}</b></td>
      <td class="mono">${esc(site.domain)}</td>
      <td><span style="color:${stColor}">● ${t(stKey)}</span></td>
      <td>${esc(site.year || "--")}</td>
      <td>${anniv}</td>
      <td>${t(mpKey)}</td>
    </tr>`;
  }).join("");
}

/* ================= 模块管理 ================= */
const BOARD_TYPE_VIEW = { comic: "view-comic", movie: "view-movie", audio: "view-audio" };
const BOARD_TYPE_NAV = { comic: "navComic", movie: "navMovie", audio: "navAudio" };
const BUILTIN_MODULES = [
  { id: "home", icon: "🏠", type: "web", nameKey: "navHome" },
  { id: "pt", icon: "🌊", type: "pt", nameKey: "navPt" },
  { id: "comic", icon: "📖", type: "comic", nameKey: "navComic" },
  { id: "movie", icon: "🎬", type: "movie", nameKey: "navMovie" },
  { id: "audio", icon: "🎵", type: "audio", nameKey: "navAudio" }
];
const MODULE_GROUP = { home: "main", pt: "main", comic: "book", movie: "video", audio: "audio" };


function openModuleModal(preType) {
  renderBoardList();
  openModal("boardModal");
}

function renderBoardList() {
  const wrap = document.getElementById("boardList");
  const typeLabel = b => b.type === "web" ? t("btWeb") : b.type === "comic" ? t("btComic") : b.type === "movie" ? t("btMovie") : b.type === "audio" ? t("btAudio") : t("btPt");
  const items = customBoards.map(b => `
    <div class="board-item">
      <span class="b-ic">${esc(b.icon)}</span>
      <span class="b-name">${esc(b.name)}</span>
      <span class="b-type">${t("customBoard")} · ${typeLabel(b)}</span>
      <span class="b-url">${esc(b.baseUrl || b.addr)}</span>
      <button class="b-del" onclick="deleteBoard('${b.id}')">🗑</button>
    </div>`).join("");
  const builtinHtml = BUILTIN_MODULES.map(b => {
    const hidden = hiddenModules.includes(b.id);
    return `
    <div class="board-item${hidden ? " hidden-mod" : ""}">
      <span class="b-ic">${b.icon}</span>
      <span class="b-name">${esc(t(b.nameKey))}</span>
      <span class="b-type">${t("builtinBoard")} · ${typeLabel(b)}</span>
      <button class="b-toggle" onclick="toggleModule('${b.id}')">${hidden ? t("moduleShow") : t("moduleHide")}</button>
    </div>`;
  }).join("");
  wrap.innerHTML = builtinHtml + items;
  if (!customBoards.length) wrap.innerHTML += `<div class="empty-tip">${t("boardEmpty")}</div>`;
}

/* 切换内置模块显示/隐藏 */
function toggleModule(id) {
  const idx = hiddenModules.indexOf(id);
  const hiding = idx < 0;
  if (hiding) hiddenModules.push(id); else hiddenModules.splice(idx, 1);
  saveHiddenModules();
  applyModuleVisibility();
  renderBoardList();
  if (hiding) {
    const active = document.querySelector(".nav-item.active[data-view]");
    if (active && active.dataset.module === id) switchView("home");
  }
}

/* 根据隐藏模块列表应用侧边栏可见性 */
function applyModuleVisibility() {
  document.body.classList.toggle("module-hidden-pt", hiddenModules.includes("pt"));
  document.querySelectorAll(".nav-item[data-module]").forEach(item => {
    item.style.display = hiddenModules.includes(item.dataset.module) ? "none" : "";
  });
  ["main", "book", "video", "audio"].forEach(g => {
    const ids = Object.keys(MODULE_GROUP).filter(k => MODULE_GROUP[k] === g);
    const allHidden = ids.length && ids.every(id => hiddenModules.includes(id));
    const header = document.querySelector(`.nav-group[data-nav-group="${g}"]`);
    if (header) header.style.display = allHidden ? "none" : "";
  });
  const customHeader = document.querySelector(`.nav-group[data-nav-group="custom"]`);
  if (customHeader) customHeader.style.display = customBoards.length ? "" : "none";
}


function boardTypeChanged() {
  /* 媒体类型添加时提示将映射到内置功能页面 */
}

function buildBoard() {
  const name = document.getElementById("nbName").value.trim();
  const addr = document.getElementById("nbAddr").value.trim();
  if (!name || !addr) { toast("⚠️ " + t("saveFirst")); return null; }
  const icon = document.getElementById("nbIcon").value.trim() || "🌐";
  const type = document.getElementById("nbType").value;
  const proto = document.getElementById("nbProto").value;
  const port = document.getElementById("nbPort").value.trim();
  let baseUrl = addr;
  if (!/^https?:\/\//i.test(baseUrl)) {
    baseUrl = proto + "://" + baseUrl;
    if (port) baseUrl += ":" + port;
  }
  return {
    id: "custom-" + Date.now().toString(36),
    name, icon, type, addr, port, proto, baseUrl,
    username: document.getElementById("nbUser").value.trim(),
    password: document.getElementById("nbPass").value,
    createdAt: Date.now()
  };
}

async function verifyAndAdd() {
  const b = buildBoard();
  if (!b) return;
  document.getElementById("btnVerify").disabled = true;
  toast(t("testConnecting"));
  let ok = false;
  try {
    const probePath = { web: "/", comic: "/api/v1/libraries", movie: "/System/Info/Public", audio: "/ping" }[b.type] || "/";
    const res = await fetch(b.baseUrl + probePath, { signal: AbortSignal.timeout(5000) });
    ok = res.ok || res.status < 400;
  } catch (e) { ok = false; }
  document.getElementById("btnVerify").disabled = false;
  if (ok) {
    toast(t("verifyOk"));
    addBoard(true, b);
  } else {
    toast(t("verifyFail"));
  }
}

function addBoard(skipBuild, board) {
  const b = board || buildBoard();
  if (!b) return;
  /* 媒体类型：保存配置并跳转到对应内置功能页面 */
  if (BOARD_TYPE_VIEW[b.type]) {
    customBoards.push(b);
    saveBoards();
    renderCustomNav();
    closeModal("boardModal");
    applyBoardToView(b);
    toast(t("boardAdded"));
    return;
  }
  /* 通用网页：iframe 自定义页面 */
  customBoards.push(b);
  saveBoards();
  renderCustomNav();
  closeModal("boardModal");
  openCustomBoard(b.id);
  toast(t("boardAdded"));
}

/* 将自定义媒体模块的服务器地址应用到内置功能页面并跳转 */
function applyBoardToView(b) {
  const viewId = BOARD_TYPE_VIEW[b.type];
  const panel = document.querySelector(`#${viewId} .tab-panel.active`);
  if (panel) {
    const lan = panel.querySelector("[data-lan-input]");
    if (lan) lan.value = b.baseUrl;
    const sw = panel.querySelector("[data-switch]");
    if (sw) sw.classList.add("on");
    const addrEl = panel.querySelector(".addr-box .val");
    if (addrEl) addrEl.textContent = b.baseUrl;
  } else {
    const lan = document.querySelector(`#${viewId} [data-lan-input]`);
    if (lan) lan.value = b.baseUrl;
  }
  updateAddr(b.type);
  switchView(b.type);
}

function deleteBoard(id) {
  customBoards = customBoards.filter(b => b.id !== id);
  saveBoards();
  renderCustomNav();
  renderBoardList();
  const view = document.getElementById("view-" + id);
  if (view) view.remove();
  toast(t("boardDeleted"));
}

/* 自定义模块导航渲染 */
function renderCustomNav() {
  const wrap = document.getElementById("customNav");
  wrap.innerHTML = customBoards.map(b => `
    <div class="nav-item" data-view="${b.id}" onclick="openCustomBoard('${b.id}')">
      <span class="ic">${esc(b.icon)}</span><span class="txt">${esc(b.name)}</span>
      <button class="del" onclick="event.stopPropagation();deleteBoard('${b.id}')">🗑</button>
    </div>`).join("");
  applyModuleVisibility();
}

/* 自定义模块页面：媒体类型 → 内置功能页；通用 → iframe */
function openCustomBoard(id) {
  const b = customBoards.find(x => x.id === id);
  if (!b) return;
  if (BOARD_TYPE_VIEW[b.type]) {
    applyBoardToView(b);
    return;
  }
  document.querySelectorAll(".nav-item[data-view]").forEach(n => n.classList.remove("active"));
  const navItem = document.querySelector(`.nav-item[data-view="${id}"]`);
  if (navItem) navItem.classList.add("active");
  document.querySelectorAll(".view").forEach(s => s.classList.remove("active"));
  let view = document.getElementById("view-" + id);
  if (!view) {
    view = document.createElement("section");
    view.className = "view";
    view.id = "view-" + id;
    document.getElementById("customViews").appendChild(view);
  }
  view.classList.add("active");
  view.innerHTML = `
    <div class="section-title">
      <span>${esc(b.icon)} ${esc(b.name)}</span>
      <span class="badge">${t("customBoard")}</span>
      <button class="btn" style="margin-left:auto;padding:5px 12px;" onclick="window.open('${esc(b.baseUrl)}','_blank')">↗ ${t("openNew")}</button>
    </div>
    <div class="addr-box" style="max-width:640px;">
      <div class="label">${t("curAddr")}</div>
      <div class="val">${esc(b.baseUrl)}${b.username ? " · " + esc(b.username) + " / ••••" : ""}</div>
    </div>
    <div class="frame-box"><iframe src="${esc(b.baseUrl)}" sandbox="allow-scripts allow-same-origin allow-forms allow-popups" loading="lazy"></iframe></div>`;
  window.scrollTo(0, 0);
}

/* ================= 弹窗 / Toast ================= */
function openModal(id) { document.getElementById(id).classList.add("show"); }
function closeModal(id) { document.getElementById(id).classList.remove("show"); }
document.querySelectorAll(".modal-mask").forEach(m => m.addEventListener("click", e => { if (e.target === m) m.classList.remove("show"); }));

let toastTimer;
function toast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2400);
}

function setLang(l) {
  curLang = l;
  applyI18n();
  renderBoardList();
  renderCustomNav();
  /* 首页与媒体库表单里的动态文案（库名列、子类型 option、海报占位、
     最近入库轨）都由 JS 生成，applyI18n 只覆盖静态 data-i18n 节点，
     所以语言切换后必须重跑这些渲染器，否则残留上一个语言。 */
  if (typeof renderHomeLibraryNav === "function") renderHomeLibraryNav();
  if (typeof renderHomeLibTable === "function") renderHomeLibTable();
  if (typeof renderHomeCount === "function") renderHomeCount();
  if (typeof syncHomeLibTypes === "function") syncHomeLibTypes();
  if (typeof renderHomeRecent === "function") renderHomeRecent();
  if (typeof renderNowPlaying === "function") renderNowPlaying();
  /* 硬件徽标文案由 JS 拼装（当前/可用），也要跟随语言重绘。 */
  if (typeof refreshHardwareStatus === "function") refreshHardwareStatus();
  if (settings.mp.token) loadPtAll(); else renderPtMock();
  saveSettings();
}


/* ================= 初始化 ================= */
