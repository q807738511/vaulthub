/* VaultHub frontend — split from index.html in phase 4.
   Plain ordered classic scripts (no bundler): global functions remain global
   so the ~131 inline on*= handlers keep working. Load order is fixed by the
   <script> tags in index.html and MUST be preserved. */
loadSettings();
loadBoards();
loadHiddenModules();
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
updateAddr("comic"); updateAddr("movie"); updateAddr("audio");
renderDocker();
renderCustomNav();
initMediaLogin();
renderPtLoginState();
renderPtMock();
tickMetrics();
setInterval(tickMetrics, 5000);
