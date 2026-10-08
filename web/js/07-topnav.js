/* ==================== v0.9.74 顶栏导航 ====================
   原型：VaultHub-TopNav-Emerald。这一层只做「导航壳」：

     顶栏        品牌 · 一级导航（首页/媒体搜索/PT）· 媒体库标签 · 全局搜索 · 头像菜单
     媒体库标签  直接读 localMediaLibraries / externalServices，与首页监控同一份数据源，
                 点击走的还是 openHomeLibrary / openExternalService，不复制业务逻辑
     全局搜索    边输入边过滤当前媒体库已渲染的条目（[data-media-path] / 行 / 卡片），
                 回车把关键词交给已有的「媒体搜索」页做全库检索
     头像菜单    系统设置 / 外观主题 / 自定义模块 / 账户与登录 / 退出登录 →
                 全部落回已有的 openSettingsPage(tab) 与 logoutVaultHub()
     布局        只有顶栏一种（v0.9.93 起侧栏已彻底移除，settings.layout 不再被读取）

   同组媒体库（漫画 / 电子书都落在 comic 视图）靠 data-nav-key 区分，
   与 switchView 的高亮规则一致，避免「点了电子书却高亮漫画」。 */

const TOPNAV_TYPE_ICON = {
  audio: "🎵", music: "🎵", mv: "🎬", podcast: "🎙", audiobook: "🎧",
  comic: "📚", comic_book: "📚", book: "📖", ebook: "📖", novel: "📖",
  movie: "🎞", series: "📺", tv: "📺", anime: "🎞", documentary: "🎞"
};
let topNavSearchQuery = "";

function topNavIconForType(type) {
  const key = String(type || "").toLowerCase();
  return TOPNAV_TYPE_ICON[key] || "📁";
}

/* ---------- 布局模式 ----------
   v0.9.93：侧栏已彻底移除（结构 + 样式 + 交互），布局只剩顶栏一种。
   这里保留 applyLayoutMode 作为「把顶栏布局落到 body 上」的唯一样板，
   并且仍然兼容旧调用点 —— 旧参数（"sidebar"）一律按顶栏处理。 */
function applyLayoutMode() {
  document.body.classList.add("layout-topnav");
  return "topnav";
}
/* 兼容历史调用点：布局模式恒为顶栏。 */
function currentLayoutMode() { return "topnav"; }

/* ---------- 媒体库标签 ---------- */
function renderTopLibTabs() {
  const host = document.getElementById("topLibTabs");
  if (!host) return;
  const rows = [];
  const libs = (typeof localMediaLibraries !== "undefined" && localMediaLibraries) || [];
  libs.forEach(lib => {
    const group = homeGroupOfType(lib.type);
    /* v0.9.82：顶栏标签只保留库名（客户要求去掉后缀的媒体数量展示）。 */
    rows.push(`<button class="libtab" type="button" role="tab" aria-current="false"`
      + ` data-view="${esc(group)}" data-lib-id="${esc(lib.id)}" data-nav-key="${esc(group + ":" + lib.id)}"`
      + ` title="${esc(lib.name)}${lib.path ? " · " + esc(lib.path) : ""}"`
      + ` onclick="openHomeLibrary('${esc(group)}',${jsAttrArg(lib.id)})">`
      + `<span class="ic">${topNavIconForType(lib.type)}</span>${esc(lib.name)}`
      + `</button>`);
  });
  if (typeof externalServices !== "undefined" && externalServices) {
    externalServices.forEach(svc => {
      rows.push(`<button class="libtab" type="button" role="tab" aria-current="false"`
        + ` data-view="${esc(svc.group)}" data-lib-id="${esc(svc.id)}" data-nav-key="${esc(svc.group + ":" + svc.id)}"`
        + ` title="${esc(svc.name)} · 外连服务"`
        + ` onclick="openExternalService(${jsAttrArg(svc.id)})">`
        + `<span class="ic">🔗</span>${esc(svc.name)}<span class="cnt">↗</span>`
        + `</button>`);
    });
  }
  host.innerHTML = rows.length ? rows.join("") : `<div class="nav-empty">${esc(t("libNavEmpty"))}</div>`;
  syncTopLibTabs(window.vaultHubActiveNavKey || "");
}

/* 高亮按 data-nav-key 精确匹配（同组媒体库靠它区分），并把选中的标签滚进可视区。 */
function syncTopLibTabs(navKey) {
  const key = navKey || window.vaultHubActiveNavKey || "";
  document.querySelectorAll("#topLibTabs .libtab").forEach(tab => {
    const on = !!key && tab.dataset.navKey === key;
    tab.setAttribute("aria-current", on ? "true" : "false");
    if (on && typeof tab.scrollIntoView === "function") tab.scrollIntoView({ block: "nearest", inline: "nearest" });
  });
}

/* 一级导航项高亮 + 过滤态重建（切库后搜索词仍然生效）。 */
function syncTopNavView(view) {
  const current = String(view || "").replace(/^view-/, "");
  document.querySelectorAll(".tn-item[data-topnav]").forEach(item => {
    item.classList.toggle("active", item.dataset.topnav === current);
  });
  applyTopSearchFilter();
}

/* ---------- 全局搜索 ---------- */
function topNavSearchBox() { return document.getElementById("topSearch"); }
function onTopSearchInput() {
  const box = topNavSearchBox();
  topNavSearchQuery = box ? box.value.trim() : "";
  applyTopSearchFilter();
}
function onTopSearchKey(event) {
  if (event.key === "Enter") {
    event.preventDefault();
    runTopSearchGo();
    return;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    const box = topNavSearchBox();
    if (box) { box.value = ""; box.blur(); }
    topNavSearchQuery = "";
    applyTopSearchFilter();
  }
}
/* 过滤当前视图已渲染的条目：书刊卡片、列表行、影视海报都带 media-path 或行类名。 */
function topNavSearchTargets(root) {
  const scope = root || document.querySelector(".view.active") || document;
  return [...scope.querySelectorAll("[data-media-path], .book-card, .media-file-row, .movie-poster, .movie-row, .audio-album-card")]
    .filter((el, idx, arr) => arr.indexOf(el) === idx);
}
function applyTopSearchFilter() {
  const q = topNavSearchQuery.toLowerCase();
  const targets = topNavSearchTargets();
  let hidden = 0;
  targets.forEach(el => {
    const hay = (el.textContent || "").toLowerCase() + " " + String(el.dataset.mediaPath || "").toLowerCase();
    const hit = !q || hay.includes(q);
    el.classList.toggle("tn-search-hidden", !hit);
    if (!hit) hidden++;
  });
  return { total: targets.length, hidden };
}
function runTopSearchGo() {
  const q = (topNavSearchBox() ? topNavSearchBox().value : "").trim();
  if (!q) return;
  const box = document.getElementById("mediaSearchInput");
  if (box) box.value = q;
  if (typeof openMediaSearch === "function") openMediaSearch();
}

/* ---------- 右上角头像菜单 ---------- */
function topNavMenuEl() { return document.getElementById("topUserMenu"); }
function closeTopUserMenu() {
  const menu = topNavMenuEl();
  if (menu) menu.classList.remove("open");
  const btn = document.getElementById("topUserButton");
  if (btn) btn.setAttribute("aria-expanded", "false");
}
function fillTopUserMenu() {
  const nameEl = document.getElementById("topUserName");
  const metaEl = document.getElementById("topUserMeta");
  const themeK = document.getElementById("topMenuTheme");
  const avatarEl = document.getElementById("topUserAvatar");
  const buttonEl = document.getElementById("topUserButton");
  const acc = document.getElementById("accountName");
  const raw = ((acc && acc.textContent) || "").trim();
  /* 账户与登录页里的名字默认写着应用名（VaultHub），它不是用户名；
     这种情况下退回「管理员」，避免头像按钮上出现一个无意义的 V。 */
  const name = (!raw || raw === "VaultHub" || raw === "蜀鼠之家") ? "管理员" : raw;
  const initial = name.slice(0, 1).toUpperCase();
  if (nameEl) nameEl.textContent = name;
  if (avatarEl) avatarEl.textContent = initial;
  if (buttonEl) buttonEl.textContent = initial;
  if (metaEl) {
    const version = window.VAULTHUB_ASSET_VERSION || "";
    metaEl.textContent = version ? "v" + version : "";
  }
  if (themeK && typeof settings !== "undefined" && settings) {
    const palette = typeof themePaletteDef === "function" ? themePaletteDef(settings.palette) : null;
    const modeLabel = settings.mode === "auto" ? "跟随系统" : settings.mode === "light" ? "亮色" : "暗色";
    const accent = typeof themeAccentDef === "function" ? themeAccentDef(settings.accent) : null;
    themeK.textContent = "当前：" + ((palette && palette.zh) || "青瓷") + " · " + modeLabel + (accent && accent.id !== "theme" ? " · " + accent.zh : "");
  }
}
function toggleTopUserMenu(event) {
  if (event) event.stopPropagation();
  const menu = topNavMenuEl();
  const btn = document.getElementById("topUserButton");
  if (!menu) return;
  const willOpen = !menu.classList.contains("open");
  closeTopUserMenu();
  if (!willOpen) return;
  fillTopUserMenu();
  menu.classList.add("open");
  if (btn) btn.setAttribute("aria-expanded", "true");
}
/* v0.9.93：侧栏移除后，自定义模块的管理入口落在头像菜单（原侧栏「自定义 › 管理」）。 */
function topUserMenuModules() {
  closeTopUserMenu();
  if (typeof openModuleModal === "function") openModuleModal();
}
function topUserMenuGo(tab) {
  closeTopUserMenu();
  if (typeof openSettingsPage === "function") openSettingsPage(tab);
}
function topUserMenuLogout() {
  closeTopUserMenu();
  if (typeof logoutVaultHub === "function") logoutVaultHub();
}

/* ---------- v0.9.85 通知中心（搜索框右侧喇叭：功能通知 + 刮削信息明细） ----------
   设计要点：
     · 纯前端队列，落 localStorage（上限 60 条），刷新/换页不丢；不新增服务端接口。
     · 刮削过程由 02-media.js 的刮削状态机调用 pushNotification() 投递
       （开始 / 完成汇总 / 失败明细 / 重试），点击通知可直接跳到对应媒体库。
     · 徽标 = 未读条数；打开面板即视为已读（并持久化）。 */
const VH_NOTIFY_KEY = "vaulthub_notifications_v1";
const VH_NOTIFY_MAX = 60;
let vhNotifications = (() => {
  try {
    const raw = JSON.parse(localStorage.getItem(VH_NOTIFY_KEY) || "[]");
    return Array.isArray(raw) ? raw.filter(x => x && x.title) : [];
  } catch (e) { return []; }
})();

function vhNotifyPersist() {
  try { localStorage.setItem(VH_NOTIFY_KEY, JSON.stringify(vhNotifications.slice(0, VH_NOTIFY_MAX))); } catch (e) {}
}
function vhNotifyUnread() { return vhNotifications.filter(n => !n.read).length; }
function renderNotifyBadge() {
  const badge = document.getElementById("tnNotifyBadge");
  if (!badge) return;
  const n = vhNotifyUnread();
  badge.hidden = n <= 0;
  badge.textContent = n > 99 ? "99+" : String(n);
}
function notifyIconFor(level) {
  return level === "fail" ? "⛔" : level === "warn" ? "⚠️" : level === "ok" ? "✅" : "🔔";
}
function formatNotifyTime(ts) {
  const d = new Date(Number(ts) || Date.now());
  const p = x => String(x).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function escNotify(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
/* pushNotification：level 取 info/ok/warn/fail；detail 是明细文本；
   action 可选 {view:"movie"} —— 点击通知跳到该视图（落回已有的 switchView）。 */
function pushNotification(entry) {
  const item = {
    id: "n" + Date.now() + Math.random().toString(36).slice(2, 7),
    ts: Date.now(),
    level: String(entry && entry.level || "info"),
    title: String(entry && entry.title || ""),
    detail: String(entry && entry.detail || ""),
    action: entry && entry.action || null,
    read: false
  };
  if (!item.title) return null;
  vhNotifications.unshift(item);
  if (vhNotifications.length > VH_NOTIFY_MAX) vhNotifications = vhNotifications.slice(0, VH_NOTIFY_MAX);
  vhNotifyPersist();
  renderNotifications();
  if (entry && entry.toast && typeof toast === "function") toast(`${notifyIconFor(item.level)} ${item.title}`);
  return item;
}
/* v0.9.87：队列类通知「就地更新」—— 同一个 key 只保留一条（刮削队列每刮一条都会刷新，
   若每条都 push 会瞬间刷屏，并把未读徽标顶到 60 上限）。
   已读状态沿用上一条，不因进度刷新而重新变未读。 */
function upsertNotification(entry) {
  const key = String((entry && entry.key) || "");
  if (!key || typeof pushNotification !== "function") return typeof pushNotification === "function" ? pushNotification(entry) : null;
  const existing = vhNotifications.find(n => n && n.key === key);
  if (!existing) {
    const created = pushNotification(entry);
    if (created) { created.key = key; vhNotifyPersist(); }
    return created;
  }
  existing.title = String(entry.title || existing.title || "");
  if (entry.detail !== undefined) existing.detail = String(entry.detail || "");
  existing.level = String(entry.level || existing.level || "info");
  if (entry.action) existing.action = entry.action;
  existing.ts = Date.now();
  if (entry.unread === true) existing.read = false;
  vhNotifications = [existing].concat(vhNotifications.filter(n => n !== existing));
  vhNotifyPersist();
  renderNotifications();
  return existing;
}
function renderNotifications() {
  renderNotifyBadge();
  const host = document.getElementById("tnNotifyList");
  if (!host) return;
  if (!vhNotifications.length) {
    host.innerHTML = `<div class="tn-notify-empty">${escNotify(t("notifyEmpty"))}</div>`;
    return;
  }
  host.innerHTML = vhNotifications.map(n => `<div class="tn-notify-item ${escNotify(n.level)}${n.read ? "" : " unread"}" data-notify="${escNotify(n.id)}">
    <span class="ic">${notifyIconFor(n.level)}</span>
    <span class="tx"><b>${escNotify(n.title)}</b>${n.detail ? `<small>${escNotify(n.detail)}</small>` : ""}<span class="dt">${escNotify(formatNotifyTime(n.ts))}${n.action && n.action.view ? ` · <a href="javascript:void(0)" onclick="notifyGoto('${escNotify(n.id)}')">${escNotify(t("notifyOpenLibrary"))}</a>` : ""}</span></span>
  </div>`).join("");
}
function notifyGoto(id) {
  const item = vhNotifications.find(n => n.id === id);
  closeNotifyPanel();
  if (item && item.action && item.action.view && typeof switchView === "function") switchView(item.action.view);
}
function notifyPanelOpen() { return !!document.getElementById("tnNotifyPanel")?.classList.contains("open"); }
function closeNotifyPanel() {
  const panel = document.getElementById("tnNotifyPanel"), btn = document.getElementById("tnNotifyBell");
  if (panel) panel.classList.remove("open");
  if (btn) btn.setAttribute("aria-expanded", "false");
}
function toggleNotifyPanel(event) {
  if (event) event.stopPropagation();
  const panel = document.getElementById("tnNotifyPanel"), btn = document.getElementById("tnNotifyBell");
  if (!panel) return;
  const willOpen = !panel.classList.contains("open");
  closeNotifyPanel();
  if (typeof closeTopUserMenu === "function") closeTopUserMenu();
  if (!willOpen) return;
  renderNotifications();
  panel.classList.add("open");
  if (btn) btn.setAttribute("aria-expanded", "true");
  /* 打开即已读：未读徽标清零，但条目保留在列表里可回看明细。 */
  if (vhNotifyUnread()) {
    vhNotifications = vhNotifications.map(n => (n.read ? n : { ...n, read: true }));
    vhNotifyPersist();
    renderNotifyBadge();
  }
}
function markNotificationsRead() {
  vhNotifications = vhNotifications.map(n => (n.read ? n : { ...n, read: true }));
  vhNotifyPersist();
  renderNotifications();
}
function clearNotifications() {
  vhNotifications = [];
  vhNotifyPersist();
  renderNotifications();
}
/* v0.9.85：搜索框快捷键提示按平台显示 —— Windows/Android 上 ⌘ 会渲染成方块乱码。 */
function applySearchKbdLabel() {
  const kbd = document.getElementById("topSearchKbd");
  if (!kbd) return;
  const ua = navigator.userAgent || "";
  const isApple = /Mac|iPhone|iPad|iPod/.test(ua) || /Mac/.test(navigator.platform || "");
  kbd.textContent = isApple ? "⌘K" : "Ctrl K";
}

/* ---------- 初始化 ---------- */
function initTopNav() {
  applyLayoutMode();
  renderTopLibTabs();
  const active = document.querySelector(".view.active");
  syncTopNavView(active ? active.id : "view-home");
  fillTopUserMenu();
  renderNotifications();
  applySearchKbdLabel();
  if (!initTopNav.bound) {
    initTopNav.bound = true;
    document.addEventListener("click", event => {
      closeTopUserMenu();
      /* v0.9.85：点喇叭与其面板以外的地方收起通知面板。 */
      const insideBell = event.target && event.target.closest && event.target.closest("#tnNotifyBell, #tnNotifyPanel");
      if (!insideBell) closeNotifyPanel();
      /* 书刊页的「视图设置」浮层：点面板与触发按钮以外的地方收起。 */
      const inside = event.target && event.target.closest && event.target.closest("#bookViewSet, #bookViewSetButton");
      if (!inside && typeof closeBookViewSettings === "function") closeBookViewSettings();
    });
    document.addEventListener("keydown", event => {
      if ((event.metaKey || event.ctrlKey) && String(event.key).toLowerCase() === "k") {
        const box = topNavSearchBox();
        if (box) { event.preventDefault(); box.focus(); box.select(); }
      } else if (event.key === "Escape") {
        closeTopUserMenu();
        closeNotifyPanel();
      }
    });
  }
}
