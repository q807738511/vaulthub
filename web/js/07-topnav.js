/* ==================== v0.9.74 顶栏导航 ====================
   原型：VaultHub-TopNav-Emerald。这一层只做「导航壳」：

     顶栏        品牌 · 一级导航（首页/媒体搜索/PT）· 媒体库标签 · 全局搜索 · 头像菜单
     媒体库标签  直接读 localMediaLibraries / externalServices，与侧栏同一份数据源，
                 点击走的还是 openHomeLibrary / openExternalService，不复制业务逻辑
     全局搜索    边输入边过滤当前媒体库已渲染的条目（[data-media-path] / 行 / 卡片），
                 回车把关键词交给已有的「媒体搜索」页做全库检索
     头像菜单    系统设置 / 外观主题 / 自定义模块 / 账户与登录 / 退出登录 →
                 全部落回已有的 openSettingsPage(tab) 与 logoutVaultHub()
     布局        顶栏（默认，body.layout-topnav，侧栏让位）或侧栏（v0.9.73 及以前），
                 存在 settings.layout，只影响本浏览器

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

/* ---------- 布局模式（顶栏 / 侧栏） ---------- */
function currentLayoutMode() {
  return (typeof settings !== "undefined" && settings && settings.layout === "sidebar") ? "sidebar" : "topnav";
}
function applyLayoutMode() {
  const mode = currentLayoutMode();
  document.body.classList.toggle("layout-topnav", mode === "topnav");
  renderLayoutChips();
  return mode;
}
function setLayoutMode(mode) {
  const next = mode === "sidebar" ? "sidebar" : "topnav";
  if (typeof settings !== "undefined" && settings) {
    settings.layout = next;
    if (typeof saveSettings === "function") saveSettings();
  }
  applyLayoutMode();
  if (typeof toast === "function") toast(next === "topnav" ? "🧭 已切换为顶部导航" : "🧭 已切换为侧边导航");
}
function renderLayoutChips() {
  const host = document.getElementById("layoutModeChips");
  if (!host) return;
  const mode = currentLayoutMode();
  host.querySelectorAll("button[data-layout]").forEach(btn => {
    btn.setAttribute("aria-pressed", String(btn.dataset.layout === mode));
  });
}

/* ---------- 媒体库标签 ---------- */
function renderTopLibTabs() {
  const host = document.getElementById("topLibTabs");
  if (!host) return;
  const rows = [];
  const libs = (typeof localMediaLibraries !== "undefined" && localMediaLibraries) || [];
  libs.forEach(lib => {
    const group = homeGroupOfType(lib.type);
    const st = (typeof homeIndexStatus !== "undefined" && homeIndexStatus && homeIndexStatus[lib.id]) || null;
    const count = Number((st && st.total) || 0);
    rows.push(`<button class="libtab" type="button" role="tab" aria-current="false"`
      + ` data-view="${esc(group)}" data-lib-id="${esc(lib.id)}" data-nav-key="${esc(group + ":" + lib.id)}"`
      + ` title="${esc(lib.name)}${lib.path ? " · " + esc(lib.path) : ""}"`
      + ` onclick="openHomeLibrary('${esc(group)}',${jsAttrArg(lib.id)})">`
      + `<span class="ic">${topNavIconForType(lib.type)}</span>${esc(lib.name)}`
      + (count ? `<span class="cnt">${esc(formatHomeCount(count))}</span>` : "")
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
    metaEl.textContent = (version ? "v" + version + " · " : "") + (currentLayoutMode() === "topnav" ? "顶部导航" : "侧边导航");
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
function topUserMenuGo(tab) {
  closeTopUserMenu();
  if (typeof openSettingsPage === "function") openSettingsPage(tab);
}
function topUserMenuLogout() {
  closeTopUserMenu();
  if (typeof logoutVaultHub === "function") logoutVaultHub();
}

/* ---------- 初始化 ---------- */
function initTopNav() {
  applyLayoutMode();
  renderTopLibTabs();
  const active = document.querySelector(".view.active");
  syncTopNavView(active ? active.id : "view-home");
  fillTopUserMenu();
  if (!initTopNav.bound) {
    initTopNav.bound = true;
    document.addEventListener("click", event => {
      closeTopUserMenu();
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
      }
    });
  }
}
