/* VaultHub frontend — split from index.html in phase 4.
   Plain ordered classic scripts (no bundler): global functions remain global
   so the ~131 inline on*= handlers keep working. Load order is fixed by the
   <script> tags in index.html and MUST be preserved. */
/* 首要动作：确认浏览器执行的脚本与入口页版本一致。不一致时 ensureFreshAssets()
   会绕过缓存重载页面，这里必须直接跳过后续初始化，避免旧脚本渲染半个界面。

   必须用 typeof 守卫裸调用：升级瞬间浏览器可能命中"新 04-boot.js + 旧
   01-state.js"的混合缓存组合（两者缓存条目独立），此时 ensureFreshAssets 未定义，
   裸调用抛 ReferenceError 会让整个前端瘫痪成白屏，连自查逻辑自己也救不回来。
   函数缺失说明 01-state.js 是旧的，同样按"资源过期"处理，重载一次即可修复。 */
if (typeof ensureFreshAssets !== "function") {
  console.warn("VaultHub 前端资源版本不一致（缺少 ensureFreshAssets），正在重新加载…");
  const staleUrl = new URL(location.href);
  if (!String(staleUrl.searchParams.get("_vh") || "").startsWith("legacy.")) {
    staleUrl.searchParams.set("_vh", "legacy." + Date.now());
    location.replace(staleUrl.toString());
  }
} else if (ensureFreshAssets()) {
  console.info("VaultHub 正在加载新版本前端资源…");
} else {
loadSettings();
loadBoards();
loadHiddenModules();
loadSidebarWidth();
loadSidebarRail();
/* v0.9.56：先探测鉴权模式 —— 开放模式自动登录（无登录遮罩），密码模式沿用登录探测。 */
initVaultHubAuth();

document.body.dataset.theme = settings.theme === "light" ? "light" : "dark";
document.body.classList.toggle("custom-bg", settings.theme === "custom");
document.getElementById("customBgWrap").style.display = settings.theme === "custom" ? "block" : "none";
applyBgImage();
document.querySelectorAll(".theme-opt").forEach(el => el.classList.toggle("on", el.dataset.themeOpt === settings.theme));

document.getElementById("mpUrl").value = settings.mp.mpUrl || "";
document.getElementById("mpUser").value = settings.mp.username || "";
document.getElementById("mpPass").value = settings.mp.password || "";

refreshHardwareStatus();
refreshSessionStatus(false);
/* 登录状态监测：每分钟核对一次服务端会话，写操作前还会再确认一次 */
setInterval(() => refreshSessionStatus(false), 60000);

applyI18n();
initSidebarResizer();
initSidebarNavOverflowWatch();
renderCustomNav();
initMediaLogin();
renderPtLoginState();
renderPtMock();
tickMetrics();
setInterval(tickMetrics, 5000);
/* 首页四栏（服务器监控 / 正在进行 / 最近入库）在媒体库拉取完成后渲染 */
refreshMediaLibraries(false).then(initHome);
}
