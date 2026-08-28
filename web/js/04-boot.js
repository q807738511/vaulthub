/* VaultHub frontend — split from index.html in phase 4.
   Plain ordered classic scripts (no bundler): global functions remain global
   so the ~131 inline on*= handlers keep working. Load order is fixed by the
   <script> tags in index.html and MUST be preserved. */
loadSettings();
loadBoards();
loadHiddenModules();
loadSidebarWidth();
loadSidebarRail();
requireVaultHubLogin();

document.body.dataset.theme = settings.theme === "light" ? "light" : "dark";
document.body.classList.toggle("custom-bg", settings.theme === "custom");
document.getElementById("customBgWrap").style.display = settings.theme === "custom" ? "block" : "none";
applyBgImage();
document.querySelectorAll(".theme-opt").forEach(el => el.classList.toggle("on", el.dataset.themeOpt === settings.theme));

document.getElementById("mpUrl").value = settings.mp.mpUrl || "";
document.getElementById("mpUser").value = settings.mp.username || "";
document.getElementById("mpPass").value = settings.mp.password || "";
refreshHardwareStatus();

applyI18n();
bindSwitches();
initSidebarResizer();
updateAddr("comic"); updateAddr("movie"); updateAddr("audio");
renderCustomNav();
initMediaLogin();
renderPtLoginState();
renderPtMock();
tickMetrics();
setInterval(tickMetrics, 5000);
/* 首页四栏（服务器监控 / 正在进行 / 最近入库）在媒体库拉取完成后渲染 */
refreshMediaLibraries(false).then(initHome);
