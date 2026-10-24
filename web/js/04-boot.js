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
/* v0.9.56：先探测鉴权模式 —— 开放模式自动登录（无登录遮罩），密码模式沿用登录探测。 */
initVaultHubAuth();

/* v0.9.73：主题初始化收敛到 06-theme.js 的 initTheme() —— v1.0.6 起它负责把
   界面规格/明暗落到 <html>、铺规格壁纸、渲染外观面板、同步阅读器主题类。
   必须用 typeof 守卫：升级瞬间可能命中「新 04-boot.js + 旧 06-theme.js（缓存里还没有）」，
   裸调用会 ReferenceError 让整个前端白屏。 */
if (typeof initTheme === "function") initTheme();
else {
  document.body.dataset.theme = settings.theme === "light" ? "light" : "dark";
  document.body.classList.remove("custom-bg");
}

/* v0.9.74：顶栏导航（媒体库标签 / 全局搜索 / 头像菜单）初始化；v0.9.93 起为唯一布局。
   同样用 typeof 守卫：升级瞬间新 04-boot.js 可能配着缓存里的旧脚本集。 */
if (typeof initTopNav === "function") initTopNav();
/* v0.9.83：启动时把「关于」里的版本参数同步到页面最下端的页脚。 */
if (typeof syncAppFooterVersion === "function") syncAppFooterVersion();

document.getElementById("mpUrl").value = settings.mp.mpUrl || "";
document.getElementById("mpUser").value = settings.mp.username || "";
document.getElementById("mpPass").value = settings.mp.password || "";

/* v1.0.7：硬件/库列表等接口已收紧为需会话，未登录时跳过启动拉取，
   登录成功后由 handleVaultHubAuthResult 触发补拉（见 01-state.js）。 */
if (typeof vaultHubAuthenticated === "function" && vaultHubAuthenticated()) refreshHardwareStatus();
refreshSessionStatus(false);
/* 登录状态监测：每分钟核对一次服务端会话，写操作前还会再确认一次 */
setInterval(() => refreshSessionStatus(false), 60000);

applyI18n();
renderCustomNav();
initMediaLogin();
renderPtLoginState();
renderPtMock();
tickMetrics();
setInterval(tickMetrics, 5000);
/* v0.9.71：弱网与音质状态初始化 —— 面板文案同步 + 音质药丸 + 后台补一次下行测速
   （自动档位 30 分钟内的结果直接复用，不重复打探测接口）。 */
/* v0.9.84：画面清晰度与色彩档位在启动时先落地，避免首屏按默认档渲染后再跳变。 */
if (typeof initQualityLevel === "function") initQualityLevel();
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
refreshMediaLibraries(false).catch(() => {}).then(() => {
  /* v1.0.7：未登录时 refreshMediaLibraries 会 401，首页先以空库渲染；
     登录成功后 bootAfterLogin() 会重新拉取并刷新首页四栏。 */
  initHome();
  /* v1.0.4（需求7）：媒体库列表就绪后再恢复上次的页面，刷新不会被踢回首页。 */
  if (typeof restoreVaultHubRoute === "function") {
    try { restoreVaultHubRoute(); } catch (e) { console.warn("恢复上次页面失败", e); }
  }
});

/* v1.0.2（需求8）：整页覆盖层（影视详情 / 阅读器 / 播放器 / 设置）打开时锁住背景页滚动
   —— 旧实现下浏览器会同时出现「页面竖滚动条 + 覆盖层内竖滚动条」的多重滚动条。
   用 MutationObserver 观察覆盖层出现/消失，避免在几十处打开/关闭逻辑里逐个挂钩子。 */
(function vhBindOverlayScrollLock() {
  const OVERLAY_SELECTOR = ".media-reader-overlay, .modal-overlay, .setpage, .epub-viewer, .comic-viewer";
  const sync = () => {
    let open = false;
    try { open = !!document.querySelector(OVERLAY_SELECTOR); } catch (e) { open = false; }
    document.documentElement.classList.toggle("vh-overlay-open", open);
  };
  sync();
  try {
    const obs = new MutationObserver(() => sync());
    obs.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style"] });
  } catch (e) { /* 老浏览器没有 MutationObserver：退化为只在启动时算一次 */ }
})();
}


/* v1.0.7：登录成功后的补拉链路（硬件徽章 + 媒体库 + 首页状态轮询）。
   由 01-state.js 的 handleVaultHubAuthResult(logged=true) 调用；
   幂等：重复调用只是多一次拉取，不会叠加轮询定时器（initHome 的轮询有签名去重）。 */
async function bootAfterLogin() {
  try {
    if (typeof refreshHardwareStatus === "function") refreshHardwareStatus();
    await refreshMediaLibraries(false);
    if (typeof loadHomeIndexStatus === "function") await loadHomeIndexStatus();
    if (typeof loadHomeScrapeStatus === "function") await loadHomeScrapeStatus();
    if (typeof renderHomeLibTable === "function") renderHomeLibTable();
  } catch (e) { /* 静默：登录后的补拉失败不阻塞界面 */ }
}
