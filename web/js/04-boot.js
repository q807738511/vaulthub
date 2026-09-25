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

/* v0.9.73：主题初始化收敛到 06-theme.js 的 initTheme() —— 它负责把
   调色板/明暗/强调色落到 <html>、渲染外观面板里的真预览卡片、同步阅读器主题类。
   必须用 typeof 守卫：升级瞬间可能命中「新 04-boot.js + 旧 06-theme.js（缓存里还没有）」，
   裸调用会 ReferenceError 让整个前端白屏。 */
if (typeof initTheme === "function") initTheme();
else {
  document.body.dataset.theme = settings.theme === "light" ? "light" : "dark";
  document.body.classList.toggle("custom-bg", settings.theme === "custom");
  applyBgImage();
}

/* v0.9.74：顶栏导航（媒体库标签 / 全局搜索 / 头像菜单 / 布局模式）初始化。
   同样用 typeof 守卫：升级瞬间新 04-boot.js 可能配着缓存里的旧脚本集。 */
if (typeof initTopNav === "function") initTopNav();

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
/* v0.9.71：弱网与音质状态初始化 —— 面板文案同步 + 音质药丸 + 后台补一次下行测速
   （自动档位 30 分钟内的结果直接复用，不重复打探测接口）。 */
if (typeof syncWeakNetworkSettings === "function") syncWeakNetworkSettings();
if (typeof updateAudioQualityButton === "function") updateAudioQualityButton();
/* v0.9.77：当天第一次打开 WEBUI 自动测速（延迟 + 下行带宽），
   结果直接喂给后台自动切换；同一天重复打开不重复打探测接口。
   自动测速关掉时退回「30 分钟内复用结果」的老行为。 */
document.getElementById("autoSpeedTestToggle") && typeof autoSpeedTestEnabled === "function" && (document.getElementById("autoSpeedTestToggle").checked = autoSpeedTestEnabled());
if (typeof runDailySpeedTest === "function") {
  runDailySpeedTest({ silent: true }).catch(() => {
    if (typeof ensureWeakNetworkProbe === "function") ensureWeakNetworkProbe();
  });
} else if (typeof ensureWeakNetworkProbe === "function") ensureWeakNetworkProbe();
/* 首页四栏（服务器监控 / 正在进行 / 最近入库）在媒体库拉取完成后渲染 */
refreshMediaLibraries(false).then(initHome);
}
