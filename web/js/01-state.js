/* VaultHub frontend — split from index.html in phase 4.
   Plain ordered classic scripts (no bundler): global functions remain global
   so the ~131 inline on*= handlers keep working. Load order is fixed by the
   <script> tags in index.html and MUST be preserved. */

/* v0.9.85 持续登录：会话默认保持 30 天（登录页勾选「保持登录 60 天」则为 60 天）。
   服务端把会话表落盘（/data/sessions.json），cookie 是持久 cookie，
   因此容器重建/升级后仍然登录。此前前端有 30 分钟无操作就主动 /api/logout 把自己
   踢下线的逻辑，与「持续登录」直接冲突 —— 现在只记录活动时间用于状态展示，
   不再自动登出（会话保活仍按节流请求受保护端点滑动服务端会话）。 */
const VAULTHUB_SESSION_DEFAULT_DAYS = 30;
const VAULTHUB_SESSION_LONG_DAYS = 60;
const VAULTHUB_SESSION_KEEPALIVE_MS = 10 * 60 * 1000;
let vaultHubSessionDays = VAULTHUB_SESSION_DEFAULT_DAYS;
let vaultHubLastActivityAt = 0;
let vaultHubSessionPingedAt = 0;
/* 脚本自带版本号，必须与 index.html 里的 window.VAULTHUB_ASSET_VERSION 相同。
   历史故障：v0.8.3→v0.8.5 的前端修改在服务端已生效，但浏览器仍执行缓存里的
   旧 02-media.js，用户看到「没有更新」。现在入口页 no-store、静态资源带 ?v=，
   并在启动时做一次一致性自查，不一致就绕过缓存强制重载一次。 */
const VAULTHUB_SCRIPT_VERSION = "0.9.94";
function ensureFreshAssets() {
  /* expected 为空 = 浏览器执行的 index.html 早于 v0.8.6（旧版本入口页没有声明
     版本号），同样属于"页面是旧的"，也需要换 URL 重新取一次。 */
  const expected = String(window.VAULTHUB_ASSET_VERSION || "");
  const url = new URL(location.href);
  if (expected === VAULTHUB_SCRIPT_VERSION) {
    /* 版本已对齐：清掉守卫标记，并把重载用的 _vh 参数从地址栏抹掉，
       避免用户复制到带内部参数的链接。 */
    try { sessionStorage.removeItem("vaulthub_asset_reload"); } catch (e) {}
    if (url.searchParams.has("_vh")) {
      url.searchParams.delete("_vh");
      try { history.replaceState(null, "", url.toString()); } catch (e) {}
    }
    return false;
  }
  const marker = expected || "legacy-entry";
  /* 双重守卫，缺一不可：
     - URL 上的 _vh：sessionStorage 被浏览器禁用（隐私模式/策略）时仍然有效，
       否则 setItem 静默失败会导致无限重载；
     - sessionStorage：用户手动去掉 _vh 后再次进入时也不会反复刷新。 */
  const urlGuard = String(url.searchParams.get("_vh") || "").startsWith(VAULTHUB_SCRIPT_VERSION + ".");
  let storageGuard = false;
  try { storageGuard = (sessionStorage.getItem("vaulthub_asset_reload") || "") === marker; } catch (e) {}
  if (urlGuard || storageGuard) {
    console.warn(`VaultHub 资源版本仍不一致（页面 ${expected || "旧版本"} / 脚本 ${VAULTHUB_SCRIPT_VERSION}），请按 Ctrl+Shift+R 强制刷新一次。`);
    return false;
  }
  try { sessionStorage.setItem("vaulthub_asset_reload", marker); } catch (e) {}
  /* 换一个查询串即换一个缓存键，浏览器必须回源取新的 index.html，
     新入口页再带 ?v= 拉取新脚本。URL 对象会保留原有 query 和 hash。 */
  url.searchParams.set("_vh", VAULTHUB_SCRIPT_VERSION + "." + Date.now());
  location.replace(url.toString());
  return true;
}
let vaultHubAuthenticated = false;
let vaultHubIdleTimer = null;
/* 每次显式登录/退出都推进一次 epoch。启动探测和 60 秒轮询是异步的，
   如果一次慢响应在用户已经登录之后才回来，就会用过期结果把遮罩重新弹出来。
   带 epoch 的探测结果只在 epoch 未变时才允许写入状态。 */
let vaultHubAuthEpoch = 0;
function showVaultHubLogin() { document.getElementById('authMask')?.classList.remove('hidden'); }
/* v0.9.85：不再有「30 分钟无操作自动登出」。markVaultHubActivity 只做两件事：
   记录最后活动时间（状态展示用），并按 10 分钟节流请求一次受保护端点把服务端会话
   滑动续期 —— 长期开着的控制台页面不会被自己踢下线。 */
function markVaultHubActivity() {
  vaultHubLastActivityAt = Date.now();
  if (!vaultHubAuthenticated) return;
  if (Date.now() - vaultHubSessionPingedAt < VAULTHUB_SESSION_KEEPALIVE_MS) return;
  vaultHubSessionPingedAt = Date.now();
  try {
    fetch('/api/system/runtime', { cache: 'no-store', credentials: 'same-origin' })
      .then(res => { if (res.status === 401) handleVaultHubAuthResult(false); })
      .catch(() => {});
  } catch (_) {}
}
['click','keydown','pointerdown','touchstart','scroll'].forEach(type=>document.addEventListener(type,markVaultHubActivity,{passive:true}));

/* v0.9.61：媒体播放期间会话保活。
   问题：markVaultHubActivity 只监听用户交互事件，长时间被动听歌/看片无操作时，
   30 分钟 idle 计时器到期会主动 fetch('/api/logout') 杀掉自己的会话，随后文件列表
   等接口返回 401。这里在媒体持续播放时每 5 分钟刷新一次前端 idle 计时器，并请求
   受保护的 runtime 端点滑动服务端会话。具名 Set 保证反复切歌/切流幂等，不会因
   start 次数累积而泄漏定时器；音频与视频也可以各自启停。 */
let mediaKeepAliveTimer = null;
const mediaKeepAliveSources = new Set();
const MEDIA_KEEPALIVE_MS = 5 * 60 * 1000;
async function mediaKeepAliveTick() {
  if (!vaultHubAuthenticated || mediaKeepAliveSources.size === 0) return;
  markVaultHubActivity();
  try {
    const res = await fetch('/api/system/runtime', { cache: 'no-store', credentials: 'same-origin' });
    await handleProtectedResponse(res);
  } catch (_) { /* 短时断网不终止播放器；下一周期自动重试。 */ }
}
function mediaKeepAliveStart(source) {
  const key = String(source || 'media');
  mediaKeepAliveSources.add(key);
  markVaultHubActivity();
  if (!mediaKeepAliveTimer) mediaKeepAliveTimer = setInterval(mediaKeepAliveTick, MEDIA_KEEPALIVE_MS);
}
function mediaKeepAliveStop(source) {
  mediaKeepAliveSources.delete(String(source || 'media'));
  if (mediaKeepAliveSources.size === 0 && mediaKeepAliveTimer) { clearInterval(mediaKeepAliveTimer); mediaKeepAliveTimer = null; }
}
/* 已登录时给遮罩加上 .hidden（CSS 里 .auth-mask.hidden{display:none}），
   未登录时移除，遮住页面要求登录。 */
function handleVaultHubAuthResult(logged) { vaultHubAuthenticated=!!logged; document.getElementById('authMask')?.classList.toggle('hidden',!!logged); if(logged) markVaultHubActivity(); else clearTimeout(vaultHubIdleTimer); return !!logged; }

async function vaultHubLogin() {
  const username=document.getElementById('vaultHubUsername').value.trim();
  const password=document.getElementById('vaultHubPassword').value;
  /* v0.9.85：登录页「保持登录 60 天」勾选决定会话保持时长（未勾选 = 默认 30 天）。 */
  const keep60=!!document.getElementById('vaultHubKeep60')?.checked;
  const keepDays=keep60?VAULTHUB_SESSION_LONG_DAYS:VAULTHUB_SESSION_DEFAULT_DAYS;
  const error=document.getElementById('authError');
  error.textContent='';
  try {
    const res=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password,keep_days:keepDays})});
    const data=await res.json();
    if(!res.ok||!data.ok){error.textContent=data.error||'登录失败';return;}
    vaultHubAuthEpoch++;
    vaultHubSessionDays=Number(data.session_days)||keepDays;
    handleVaultHubAuthResult(true);
    renderSessionStatus(true, tf('sessionOkHintDays',{ days: vaultHubSessionDays }));
    document.getElementById('vaultHubPassword').value='';
    /* v0.9.58：用一次性初始随机密码登录 → 强制改密（服务端会话同时受限）。 */
    if (data.must_change) { vaultHubMustChange = true; showForcedPasswordChange(password); }
  } catch (_) { error.textContent='登录服务不可用'; }
}
async function requireVaultHubLogin() {
  const epoch = vaultHubAuthEpoch;
  /* 开放模式：无密码屏障，会话丢失时静默自动登录（不发登录遮罩）。 */
  if (vaultHubAuthMode === "open") {
    await vaultHubAutoLogin();
    if (epoch !== vaultHubAuthEpoch) return vaultHubAuthenticated;
    return handleVaultHubAuthResult(true);
  }
  try {
    const res=await fetch('/api/system/runtime',{cache:'no-store'});
    const logged=res.ok;
    /* 期间用户已经登录/退出过：这次探测的结果已经过期，丢弃。 */
    if (epoch !== vaultHubAuthEpoch) return vaultHubAuthenticated;
    return handleVaultHubAuthResult(logged);
  } catch (_) {
    if (epoch !== vaultHubAuthEpoch) return vaultHubAuthenticated;
    handleVaultHubAuthResult(false);
    return false;
  }
}
async function handleProtectedResponse(res) {
  /* v0.9.58：受限会话（未改密）访问受保护端点被服务端 403 → 重新弹强制改密框。 */
  if (res.status === 403 && vaultHubMustChange) { showForcedPasswordChange(); return false; }
  if (res.status === 401) { if (vaultHubAuthMode === "open") { await vaultHubAutoLogin(); handleVaultHubAuthResult(true); markVaultHubActivity(); return true; } handleVaultHubAuthResult(false); renderSessionStatus(false); return false; } markVaultHubActivity(); renderSessionStatus(true); return true; }
function guardProtectedAction(fn) { return async (...args)=>{if(vaultHubAuthenticated || await requireVaultHubLogin()) return fn(...args);}; }

/* ---------- v0.9.56 鉴权模式（开放模式 / 密码模式） ---------- */
/* /api/auth/mode 是公共端点：启动时先探测当前模式。密码模式维持原登录遮罩流程；
   开放模式（无密码）自动登录一次拿到会话 Cookie，全程不出现登录遮罩，
   会话因 30 分钟空闲失效后也会在探测/写操作时静默恢复。 */
let vaultHubAuthMode = "password";
/* v0.9.56：系统是否曾设置过密码（auth.json 里有 hash 凭据）。开放模式若曾设置过
   密码，账户变更（改密/切回密码模式）仍需验证原密码；纯开放模式则不需要。 */
let vaultHubHasPassword = false;
/* v0.9.58：系统是否处于「一次性初始随机密码待改密」状态。用该密码登录后
   强制弹出改密框，服务端会话同时受限（除改密外一律 403）。 */
let vaultHubMustChange = false;
async function vaultHubFetchAuthMode() {
  try {
    const res = await fetch("/api/auth/mode", { cache: "no-store" });
    if (res.ok) {
      const data = await res.json();
      vaultHubAuthMode = data.mode === "open" ? "open" : "password";
      vaultHubHasPassword = !!data.has_password;
      vaultHubMustChange = !!data.must_change;
      if (typeof loadAccountCredentialsUI === "function") loadAccountCredentialsUI();
    }
  } catch (e) { /* 服务未就绪时保持默认密码模式，稍后探测会重试 */ }
  return vaultHubAuthMode;
}
async function vaultHubAutoLogin() {
  try {
    const res = await fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "", password: "" }) });
    const data = await res.json();
    return !!(res.ok && data.ok);
  } catch (e) { return false; }
}
async function initVaultHubAuth() {
  await vaultHubFetchAuthMode();
  if (vaultHubAuthMode !== "open") {
    const logged = await requireVaultHubLogin();
    /* v0.9.58：受限会话（用初始随机密码登录、尚未改密）在页面重载后仍要强制改密。 */
    if (logged && vaultHubMustChange) showForcedPasswordChange();
    return logged;
  }
  const ok = await vaultHubAutoLogin();
  handleVaultHubAuthResult(true); // 开放模式永不显示登录遮罩
  renderSessionStatus(ok, ok ? t('sessionOkHint') : '开放模式自动登录失败，将自动重试');
  if (!ok) {
    setTimeout(async () => {
      if (await vaultHubAutoLogin()) { vaultHubAuthenticated = true; refreshSessionStatus(false); }
    }, 15000);
  }
  return vaultHubAuthenticated;
}

/* ---------- 退出登录 ---------- */
/* 主动退出：先让服务端销毁 Session，再复位前端状态并显示登录遮罩。
   本地界面偏好（主题/语言）保留，不做清理。 */
async function logoutVaultHub() {
  vaultHubAuthEpoch++;
  try { await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' }); } catch (_) {}
  clearTimeout(vaultHubIdleTimer);
  vaultHubAuthenticated = false;
  renderSessionStatus(false);
  closeCaddyPage();
  closeModal('avatarModal');
  if (vaultHubAuthMode === "open") {
    /* 开放模式无密码屏障：退出后立即静默恢复会话，不展示登录遮罩。 */
    await vaultHubAutoLogin();
    handleVaultHubAuthResult(true);
    toast('🚪 ' + t('loggedOutToast') + '（开放模式已自动恢复）');
    return;
  }
  showVaultHubLogin();
  const pass = document.getElementById('vaultHubPassword');
  if (pass) pass.value = '';
  toast('🚪 ' + t('loggedOutToast'));
}

/* ---------- 登录状态监测 ---------- */
/* 服务端会话是唯一权威来源：/api/system/runtime 需要有效 Session，
   200 = 已登录，401 = 会话失效。增删媒体库前会调用它给出明确提示，
   避免用户点了按钮却只看到静默失败。 */
function renderSessionStatus(logged, note) {
  const badge = document.getElementById('sessionStatusBadge');
  const hint = document.getElementById('sessionStatusHint');
  if (badge) {
    badge.textContent = logged ? '✅ ' + t('sessionOk') : '⚠️ ' + t('sessionBad');
    badge.className = logged ? 'badge green' : 'badge red';
  }
  if (hint && note) hint.textContent = note;
  const dot = document.getElementById('sessionDot');
  if (dot) dot.classList.toggle('red', !logged);
  /* 账户头像菜单里同样显示登录状态，避免必须打开系统设置才能看到。 */
  const state = document.getElementById('accountState');
  if (state) {
    state.textContent = logged ? t('sessionOk') : t('sessionBad');
    state.className = logged ? 'am-state ok' : 'am-state bad';
  }
}
async function refreshSessionStatus(notify) {
  const epoch = vaultHubAuthEpoch;
  let logged = false;
  try {
    const res = await fetch('/api/system/runtime', { cache: 'no-store' });
    logged = res.ok;
  } catch (_) { logged = false; }
  /* 同上：登录/退出发生在探测期间时，不用旧结果覆盖新状态。 */
  if (epoch !== vaultHubAuthEpoch) return vaultHubAuthenticated;
  /* 开放模式：会话失效（空闲超时/重启）时静默自动登录恢复，不发遮罩。 */
  if (!logged && vaultHubAuthMode === "open") {
    await vaultHubAutoLogin();
    try {
      const res = await fetch('/api/system/runtime', { cache: 'no-store' });
      logged = res.ok;
    } catch (_) { logged = false; }
    if (logged && notify) toast('✅ 开放模式会话已自动恢复');
  }
  vaultHubAuthenticated = logged;
  renderSessionStatus(logged, t(logged ? 'sessionOkHint' : 'sessionBadHint'));
  if (notify) toast(logged ? '✅ ' + t('sessionOk') : '⚠️ ' + t('sessionReloginToast'));
  return logged;
}
/* 写操作前的守卫：状态异常时给出明确 toast 并弹出登录遮罩，返回 false 让调用方中止。 */
async function ensureSessionForWrite(action) {
  if (await refreshSessionStatus(false)) return true;
  toast('⚠️ ' + tf('sessionWriteBlocked', { action: action || '' }));
  showVaultHubLogin();
  return false;
}

/* ---------- Caddy 配置：独立整页 ---------- */
/* 从系统设置的 Caddy 标签页进入，铺满视口编辑 Caddyfile。 */
function openCaddyPage() {
  document.getElementById('caddyPage')?.classList.add('show');
  loadCaddyConfig();
}
function closeCaddyPage() { document.getElementById('caddyPage')?.classList.remove('show'); }
/* Caddy 入口：v0.9.17 起反向代理入口在「账户与登录」页里，
   保留 openCaddyModal() 作为兼容入口，直接打开该页。 */
function openCaddyModal() {
  openSettingsPage('account');
}
async function loadCaddyConfig() {
  const box = document.getElementById('caddyFile');
  if (!box) return;
  const status = document.getElementById('caddyPageStatus');
  if (status) status.textContent = t('caddyLoading');
  try {
    const res = await fetch('/api/admin/caddyfile', { cache: 'no-store' });
    if (!await handleProtectedResponse(res)) {
      if (status) status.textContent = t('sessionBad');
      return;
    }
    const data = await res.json();
    if (data.ok) {
      box.value = data.caddyfile || '';
      updateCaddyRouteCount(box.value);
      if (status) status.textContent = tf('caddyLines', { n: box.value.split('\n').length });
    }
  } catch (_) {
    if (status) status.textContent = t('caddyBackendDown');
  }
}
/* 统计 handle 块数量，作为"已配置多少条路由"的粗略提示 */
function updateCaddyRouteCount(text) {
  const badge = document.getElementById('caddyRouteCount');
  if (!badge) return;
  const routes = (String(text || '').match(/^\s*handle(_path)?\b/gm) || []).length;
  badge.textContent = routes ? tf('caddyRouteFmt', { n: routes }) : '--';
}

async function saveCaddyConfig() {
  const caddyfile = document.getElementById('caddyFile').value;
  const res = await fetch('/api/admin/caddyfile', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ caddyfile })
  });
  if (!await handleProtectedResponse(res)) { toast('⚠️ ' + t('caddySaveBlocked')); return; }
  const data = await res.json();
  if (data.ok) { toast('✅ ' + t('caddySavedToast')); updateCaddyRouteCount(caddyfile); }
  else toast('⚠️ ' + (data.error || t('caddySaveFail')));
}
/* ================= i18n ================= */
const I18N = {
  "zh-CN": {
    mpToken: "MoviePilot API Token",

    setModuleSub: "导航里不再放「添加模块」按钮，模块的显隐与自定义网页在这里管理", setModuleOpen: "打开模块设置",

    /* ---- v0.7.0：媒体库优先导航、账户菜单、头像、构建进度 ---- */
    navGroupLibrary: "媒体库", navManage: "管理 ›",
    accountMenu: "账户与设置", avatarSettings: "头像设置",
    avatarLead: "头像仅保存在本浏览器 localStorage，不上传服务器。可用文字缩写、emoji 或上传图片。",
    avatarPreview: "预览效果", avatarText: "显示文字（1-2 个字符或 emoji）", avatarColor: "背景色",
    avatarUpload: "上传头像图片（可选）", avatarReset: "恢复默认", avatarSaved: "头像已保存",
    avatarTooLarge: "图片过大，无法保存到 localStorage", avatarResetDone: "头像已恢复默认",
    setLibrary: "媒体库", setLibExisting: "已添加的媒体库",
    /* v0.9.88：标题匹配阈值（最低识别字符占比，默认 70%）。 */
    scrapeMinMatchLabel: "标题匹配阈值（最低识别字符占比）",
    scrapeMinMatchHint: "默认 70%：标题无需完全一致，70% 字符能对上即算命中；没命中的条目会在通知里给出匹配度，可到「逐项扫描 → ✎ 编辑名称」补名后重刮。",
    /* v0.9.87：刮削地区（中/日/美）—— 决定 TMDB 请求 language。 */
    scrapeRegionLabel: "刮削地区（TMDB 语言）",
    scrapeRegionAuto: "跟随界面语言",
    scrapeRegionCn: "中国（中文简体 · zh-CN）",
    scrapeRegionJp: "日本（日文 · ja-JP）",
    scrapeRegionUs: "美国（英文 · en-US）",
    scrapeRegionHint: "刮削与详情页的 TMDB 请求按该地区语言查询：选「日本」查日文原名、选「美国」查英文原名，可避免中文界面下查不到日/美作品而回落成资源名（文件名展示）。",
    notifyScrapeQueue: "刮削队列 {ok}/{total}",
    libScanAuto: "自动扫描（整库逐项刮削）",
    libScanItem: "逐项扫描（手动选择条目）",
    libScanTitle: "逐项扫描",
    libScanAll: "自动扫描整库",
    libScanRetryFailed: "仅重试失败项",
    editTitleLabel: "媒体名称（用于刮削搜索）",
    editYearLabel: "年份",
    /* v0.9.94（需求9）：剧集分季刮削的标签写法说明。 */
    editSeasonHint: "剧集分季：标签里写「剧名S01 / 剧名S04」表示这一季按该剧的第 1 / 第 4 季刮削。自动刮削分不清哪一季时，用它手工指定即可（同一部剧的不同季会归到同一张剧集卡，卡内按季分开）。",
    editScrapeHint: "名称与年份会作为刮削搜索词：保存后立即按新名称重刮一次，跨设备一致。",
    setLibExistingHint: "顶栏只展示这里创建时填写的库名称。每个库都可以单独重新扫描、打开或删除。",
    setLibAdd: "媒体库增加",
    setLibAddHint: "先选来源：本地媒体库使用容器内已挂载的绝对路径；外连服务接入 Emby / Navidrome / Komga 等现成服务器。",
    setLibCustomModule: "自定义模块",
    setLibCustomModuleHint: "自定义模块用于添加媒体库：选「通用网页」接入任意 Web 服务；选漫画 / 影视 / 音频则等价于新增一个对应大类的媒体库。",
    setLibCustomModuleOpen: "打开自定义模块",
    setLibCustomModuleTip: "模块的显示 / 隐藏与删除都在模块设置里管理。",
    footerAboutHint: "版本与「系统设置 → 账户与登录 → 关于」中的版本参数保持一致",
    libSrcLocal: "本地媒体库", libSrcExternal: "外连服务",
    libPathHint: "路径必须是容器内已挂载且存在的绝对目录；库名称会直接作为顶栏标签与刮削标识。",
    extLibName: "服务名称", extLibLan: "内网地址", extLibProxy: "反代 / 外网域名（可选）",
    extLibAdd: "添加外连服务", extLibList: "已添加的外连服务",
    extLibHint: "内网访问自动走内网地址，外网访问自动走反代域名；添加后会在顶栏媒体库标签中出现。",
    extLibEmpty: "尚未添加外连服务", extLibNeed: "请填写服务名称与内网地址",
    extLibAdded: "外连服务「{name}」已添加", extLibRemoved: "外连服务已删除",
    libNavEmpty: "尚未添加媒体库", libCountBadge: "{n} 个媒体库",
    buildProgress: "正在建立索引", buildScanned: "已扫描 {n} 项",
    buildElapsed: "已用 {sec}", buildCancel: "取消构建",
    buildCancelled: "已取消索引构建", buildDone: "索引构建完成",
    buildWaiting: "正在统计文件数量…", buildRefresh: "手动刷新",
    homeOpenFail: "无法打开：媒体库或文件不存在",

    caddySettings: "Caddy 配置", caddyOrigin: "WebUI 外部域名", caddyAdminToken: "管理令牌", caddyFile: "Caddyfile", caddySave: "保存并应用", caddyReload: "重新载入", caddyHint: "保存后会校验并热加载容器内的 Caddy 配置；失败时会回滚。", superComicTitle: "Komga / Kavita / Calibre-Web · 统一书库", appName: "蜀鼠之家", appSub: "VaultHub · 家庭 NAS 控制台",
    navGroupMain: "主导航", navHome: "首页", navPt: "PT 管理", navMore: "更多 ›",
    navGroupMedia: "媒体", navComic: "电子书刊", navMovie: "影视作品", navAudio: "音视作品",
    navGroupBook: "电子书刊", navGroupVideo: "影视作品", navGroupAudio: "音视作品",
    navGroupSys: "系统",
    navGroupCustom: "自定义",
    settings: "系统设置", about: "关于", settingsLead: "系统设置现在是独立配置页（不再是弹窗）：媒体库、外观主题、刮削配置与硬件配置分开；账户与登录页内含登录状态、关于和 Caddy 反向代理入口。",
    navMediaSearch: "媒体搜索", searchTitle: "媒体搜索", searchIdle: "输入关键词搜索媒体库",
    /* v0.9.94（需求2）：搜索已改为顶栏放大镜弹窗，这一页是旧链接的落点页。 */
    searchLead: "媒体搜索已改为顶栏的放大镜按钮：点一下弹出搜索弹窗，不离开当前页面即可搜索整个媒体库。",
    searchPlaceholder: "搜索媒体库中的影视、书籍、音乐文件名", searchRun: "搜索", searchClear: "清空",
    searchRunning: "正在搜索媒体库…", searchNoLibrary: "还没有已添加的媒体库，请先在系统设置中添加。",
    searchEmpty: "没有找到与「{q}」匹配的媒体文件。", searchHits: "命中 {n} 个文件",
    setAboutHint: "应用版本、技术栈和监控组件说明。", setAboutOpen: "查看关于信息",
    settingsPageBadge: "独立配置页", settingsClose: "返回上一页",
    /* ---- v0.9.51：视频播放器悬浮控制栏 ---- */
    vpCollapse: "最小化整个播放器",
    vpExpand: "还原播放器",
    vpPreparing: "正在准备播放…",
    shelfLoadingIndex: "正在加载完整索引…",
    shelfLoadingIndexN: "正在加载完整索引：{n} / {total} 条",
    vpFullscreen: "全屏切换",
    vpFullscreenExit: "退出全屏",
    vpPrev: "上一个",
    vpNext: "下一个",
    vpRewind: "快退 10 秒",
    vpForward: "快进 10 秒",
    vpPlayPause: "暂停或播放",
    vpPlay: "播放",
    vpPause: "暂停",
    vpClose: "关闭播放",
    vpMore: "更多操作",
    vpInfo: "获取信息",
    editOriginalNameLabel: "原文件名称",
    editOriginalNameHint: "媒体库里未被改动的原始文件名（只读，用于核对刮削结果）",
    vpDetails: "打开详情页",
    vpDiag: "复制播放诊断",
    vpDiagOk: "播放诊断已复制",
    vpDiagFail: "剪贴板不可用，信息已在「获取信息」面板中",
    vpSettings: "设置：转码质量、音频流与字幕",
    vpQuality: "转码质量",
    vpQualityAuto: "自动（推荐）",
    vpQualityOriginal: "原画直放",
    vpQualityFail: "画质切换失败",
    vpEngine: "播放引擎",
    vpAudioStream: "音频流",
    vpAudioLoading: "读取音源中…",
    vpSubtitle: "字幕",
    vpSubtitleNone: "暂无外挂字幕",
    vpSubtitleSearch: "搜索并挂载字幕",
    vpPlaylist: "播放列表",
    vpPlaylistLoading: "正在读取播放列表…",
    vpPlaylistEmpty: "当前媒体库没有可排队的视频。",
    vpPlaylistNone: "播放列表为空",
    vpFirstItem: "已经是第一个",
    vpLastItem: "已经是最后一个",
    vpVolume: "声音",
    vpMute: "静音切换",
    vpProgress: "播放进度",
    vpTitleLoading: "正在载入…",
    vpFsDenied: "浏览器拒绝了全屏请求",
    setLook: "外观主题", setScrape: "刮削与硬件", setScrapeTab: "刮削配置", setHwTab: "硬件配置", caddyRoutes: "反向代理服务域名",
    setAccount: "账户管理", setAccountTitle: "当前登录状态", sessionChecking: "正在检查登录状态…", sessionRefresh: "刷新状态",
    sessionHint: "登录状态默认保持 30 天（登录页勾选「保持登录 60 天」后为 60 天），容器重建或升级后依然有效；增删媒体库等写操作需要有效登录。",
    sessionOkHintDays: "已保持登录 {days} 天；增删媒体库等写操作可直接执行。",
    loginKeep60: "保持登录 60 天（默认 30 天）",
    notifyTitle: "通知",
    notifyEmpty: "暂无通知",
    notifyClear: "清空",
    notifyMarkRead: "全部已读",
    notifyScrapeStart: "开始刮削 {n} 项",
    notifyScrapeDone: "刮削完成：成功 {ok} · 失败 {fail} · 跳过 {skip}",
    notifyScrapeRetry: "重试失败项：{n} 项",
    notifyScrapeFailItem: "刮削失败：{title}（{reason}）",
    notifyOpenLibrary: "查看媒体库",
    castAs: "饰演",
    castTitle: "演职人员",
    castVoiceAs: "配音",
    castEmpty: "暂无演职人员信息",
    nowResume: "继续播放",
    nowPlay: "继续播放",
    netDisksTitle: "硬盘和网络",
    diskTempShort: "硬盘温度",
    netNic: "网卡",
    setLogoutTitle: "退出登录", setLogout: "退出登录", setLogoutHint: "退出后会立即失效服务端会话并返回登录页，本机保存的界面偏好不会被清除。",
    caddyOpenPage: "打开 Caddy 配置页面", caddyPageHint: "Caddyfile 内容较长，单独占用一整页编辑，避免在弹窗里挤成一团。",
    caddyPageTitle: "Caddy 反向代理配置", caddyPageClose: "关闭",
    caddyRoutesHint: "维护服务域名与内网上游地址的映射，保存后由内置 Caddy 校验并热加载，失败会自动回滚。",
    setScrapeSrc: "刮削来源", setScrapeHint: "媒体库按大类使用不同刮削源：电子书刊用 Google Books / Bangumi，影视作品用 TMDB / 豆瓣，音视作品用 MusicBrainz / 网易云。",
    setHw: "显卡加速", setHwLbl: "视频兼容流硬件加速", setHwDetect: "检测显卡",
    setHwHint: "需要在 Docker Compose 中透传 /dev/dri 或配置 NVIDIA Container Toolkit。硬件不可用时会自动回退 CPU，不影响播放。",
    secServer: "服务器监控", secNas: "NAS 监控", cpu: "CPU", memory: "内存", network: "网络", diskTemp: "硬盘温度",
    cpuUsage: "CPU 使用率", memUsage: "内存使用率", netSpeed: "网络速度", diskUsage: "硬盘使用率",
    avgTemp: " °C 均温", diskFree: "容量剩余",
    used: "使用率", cores: "核心数量", load: "负载", temp: "温度",
    memUsed: "已用", memTotal: "总计", swap: "交换",
    netDownLbl: "↓ 下行", netUpLbl: "↑ 上行",
    secDisk: "硬盘容量",
    secNow: "正在播放", nowEmpty: "当前没有正在播放的视频或音乐",
    secRecentBook: "最近入库 · 电子书刊", secRecentBookSub: "电子书 / 漫画",
    secRecentVideo: "最近入库 · 影视作品", secRecentVideoSub: "电视剧集 / 电影",
    secRecentAudio: "最近入库 · 音视作品", secRecentAudioSub: "音乐 / 音乐 MV",
    filterAll: "全部",
    kindBookDesc: "子类型：电子书 / 漫画 · 刮削源 Google Books、Bangumi",
    kindVideoDesc: "子类型：电视剧集 / 电影 · 刮削源 TMDB、豆瓣",
    kindAudioDesc: "子类型：音乐 / 音乐 MV · 刮削源 MusicBrainz、网易云",
    libKind: "媒体大类", libSubType: "子类型", libPath: "媒体路径（容器内绝对路径）", libExtraPath: "附加存储路径（可选，每行一个）", libName: "库名称（手动命名，用于刮削）",
    libAdd: "添加媒体库", libRefresh: "刷新", libRescanAll: "全部重新扫描",
    colLibName: "库名称", colLibKind: "大类 / 子类型", colLibPath: "媒体路径", colLibItems: "项目", colLibState: "扫描状态", colLibActs: "操作",
    libEmpty: "尚未添加媒体库，填写上方表单即可开始刮削",

    secPt: "PT 管理", ptRefresh: "刷新", mpConn: "MoviePilot 登录", mpSettings: "设置",
    mpAddr: "MoviePilot 访问地址", mpUser: "登录账号", mpPass: "登录密码",
    btnLogin: "登录并获取数据", btnLogout: "退出",
    ptNotLoggedIn: "未登录",
    ptSubNav: "子页面", ptSubSites: "站点管理", ptSubGuard: "PT 监护室",
    ptSiteList: "已添加站点", colCookie: "Cookie", colPri: "优先级",
    colSite: "站点", colDomain: "域名", colStatus: "状态",
    colYear: "成立年份", colAnniv: "站庆", colMp: "MP 同步", ptSiteData: "站点数据",
    guardPlugin: "插件状态", guardInstalled: "是否安装", guardEnabled: "是否启用", guardVersion: "版本",
    guardWork: "工作状态", guardFetch: "数据源", guardFetched: "上次获取", guardCron: "定时推送", guardNotify: "公告通知",
    guardSummary: "快照统计", guardTotal: "站点总数", guardHealthy: "正常", guardCritical: "病危", guardClosed: "已关站", guardOwned: "已接入 MP",
    guardSiteSync: "站点获取状态同步", guardSyncBadge: "同步",
    guardPluginMissing: "Savept 插件接口不可用 — 请在 MoviePilot 插件市场安装「Vue-PT监护室 (Savept)」",
    ptUp: "上传", ptDown: "下载", ptRatio: "分享率", ptSeed: "做种", ptMagic: "魔力", ptLevel: "等级",
    ptOk: "✅ 已连接 · 自动辅种中", ptErr: "⚠️ Cookie 失效 · 需重新签到",
    stHealthy: "运行中", stCritical: "病危", stClosed: "已关站", stUnknown: "未知",
    mpOwned: "已接入", mpAvailable: "可接入", mpUnsupported: "不支持",
    alertTitle: "公告",
    secComic: "超漫画", secMovie: "影视服务器", secAudio: "音频服务器",
    movieSupport: "支持 Plex / Emby / Jellyfin", audioSupport: "支持 道理鱼 / Navidrome",
    lblLan: "内网 IP 地址", lblProxy: "反代 / 代理域名",
    lblAutoSwitch: "访问地址自动切换", lblAutoSwitchSub: "内网自动走内网 IP，外网自动走反代域名",
    curAddr: "当前访问地址", btnTest: "测试连接", btnSave: "保存",
    mediaUser: "服务账号", mediaPass: "服务密码", btnMediaLogin: "进入媒体服务", btnOpenExternal: "新窗口打开", mediaAccess: "服务访问",
    mediaLoginNote: "填写或选择上方访问地址后，点击「进入媒体服务」会在当前栏目内打开对应服务登录页；账号密码在媒体服务页面里手动填写。",
    mediaEmptyTitle: "暂无资源", mediaEmptyDesc: "当前栏目还没有配置媒体服务器。请先配置服务器访问地址，保存后这里会作为资源访问页展示。", mediaCfgBtn: "配置服务器", mediaHideCfg: "收起配置", mediaConfigured: "已配置",
    testOk: "✅ 连接成功 · 服务可达", saved: "💾 配置已保存",
    comicHint: "提示：Kavita 中文阅读体验更佳；Komga 刮削能力更强（Comic Vine）。",
    kavitaHint: "提示：Kavita 内建阅读器，支持书架管理。",
    ebookHint: "提示：可搭配 Calibre-Web Automated 实现 PT 下载后自动刮削入库。",
    plexHint: "提示：Plex 需关闭「要求安全连接」或配置自定义域名访问。",
    embyHint: "提示：Emby 回调 MP 时填写 https://mp.example.com/api/v1/webhook?token=…",
    jellyfinHint: "提示：Jellyfin 开源免费，无数量限制。",
    ndHint: "提示：Navidrome 走 Cloudflare Tunnel 若播放卡顿，关闭 HTTP/3 并强制 cloudflared http2。",
    dlyHint: "提示：道理鱼为本地音乐服务，反代域名需在 DNS 解析至 Tunnel。",
    secDocker: "Docker 容器", searchPh: "🔍 搜索容器名称 / 镜像 / 状态…",
    colName: "名称", colImage: "镜像", colStatus: "状态", colPorts: "端口", colHealth: "健康",
    settingsTitle: "系统设置", langLbl: "界面语言",
    themeLbl: "外观主题", themeDark: "暗色", themeLight: "亮色", themeCustom: "自定义背景（上传图片）",
    themeModeLbl: "明暗", themePaletteLbl: "调色板", themeAccentLbl: "强调色",
    accentTheme: "跟随主题", themeAccentHint: "只换主色，不改明暗",
    themeModeSaved: "显示模式已切换", themePaletteSaved: "调色板已切换", themeAccentSaved: "强调色已切换",
    themeReduceMotion: "减弱动效", themeReduceMotionSub: "对动画敏感或老设备：过渡与动画压到 1ms",
    themeCustomBg: "使用自定义背景图片", themeCustomBgSub: "独立背景层，图片只存在本浏览器",
    bgEnabled: "已启用自定义背景", bgDisabled: "已关闭自定义背景",
    themeNote: "主题 = 调色板 × 明暗 × 强调色 三层叠加；每套调色板自带圆角、阴影、标题字族与动效节奏，选择只保存在本浏览器。",
    bgUpload: "上传背景图片", bgClear: "清除自定义背景", bgHint: "提示：图片仅保存在本浏览器 localStorage，不经过服务器。",
    monitoringLbl: "NAS 监控（内置读取）", monitoringHint: "监控参数由 Compose 环境变量和只读挂载配置。",
    nasOnline: "内置监控 · 每 5s 刷新", nasOffline: "内置监控不可用",
    diskSourceReal: "内置监控 · statvfs", diskSourceOffline: "内置监控不可用",
    boardTitle: "模块设置", boardExisting: "已有模块", boardAddNew: "手动添加模块",
    boardName: "模块名称", boardIcon: "图标（emoji）", boardType: "功能类型",
    boardAddr: "服务器 IP 或域名", boardPort: "端口（可选）", boardProto: "协议",
    boardUser: "账号（可选）", boardPass: "密码（可选）",
    btWeb: "通用网页", btComic: "漫画", btEbook: "电子书", btMovie: "影视", btAudio: "音频", btPt: "PT 管理（MoviePilot）",
    btnVerify: "验证并添加", btnAddDirect: "直接添加",
    boardHint: "提示：验证会尝试访问该服务器（跨域或内网不可达时验证会失败，可改用「直接添加」）。媒体类型（漫画/电子书/影视/音频）添加后自动跳转到对应的内置功能页面；通用网页类型打开内嵌页面。",
    verifyOk: "✅ 验证通过 · 服务可达", verifyFail: "⚠️ 无法从浏览器直连（跨域或不可达），可点「直接添加」",
    boardAdded: "✅ 模块已添加并切换到新页面", boardDeleted: "🗑 模块已删除",
    boardEmpty: "暂无自定义模块，点击下方「手动添加模块」",
    builtinBoard: "内置", customBoard: "自定义", ptInstance: "PT 实例",
    openNew: "在新窗口打开", saveFirst: "请先填写模块名称与地址",
    moduleHide: "隐藏", moduleShow: "显示",
    aboutTitle: "关于", aboutName: "应用名称", aboutVer: "版本", aboutStack: "技术栈",
    aboutMon: "监控组件", aboutPt: "PT 插件", aboutAuthor: "生成",
    aboutNote: "系统指标由内置接口读取只读挂载的宿主机信息；MoviePilot 与媒体服务继续使用各自接口。",
    up: "运行中", stopped: "已停止", restarting: "重启中",
    healthy: "healthy", unhealthy: "unhealthy",
    ptConnSaved: "✅ MoviePilot 连接已保存", ptReal: "MoviePilot API", ptMock: "模拟数据（API 不可达）",
    testConnecting: "⏳ 正在验证…",
    /* v0.6.30.Branch-update：首页动态文案的模板键，供 05-home.js 使用 */
    homeCountFmt: "共 {items} 项 · {libs} 个媒体库", homeCountEmpty: "尚未添加媒体库",
    libCountFmt: "{n} 个库",
    stateWait: "待扫描", stateScraping: "扫描中", stateFail: "失败",
    stateCancelled: "已取消", stateDone: "已完成",
    homeEmptyLib: "尚未添加{kind}媒体库", homeLoading: "正在读取最近入库…",
    homeNoIndexed: "该分类暂无已索引的媒体文件",
    actRescan: "重新扫描", actOpenLib: "打开媒体库", actRemove: "移除",
    nowBadge: "视频 / 音乐播放 · 含刮削信息",
    /* 媒体子类型名称，供 mediaTypeName() 使用 */
    typeAudio: "音乐", typeMusicvideo: "音乐视频（歌曲 MV）", typeComic: "漫画",
    typeBook: "电子书", typeMovie: "电影", typeSeries: "电视剧集",
    hwAuto: "自动选择（推荐）", hwCpu: "CPU", hwVaapi: "VAAPI（Intel/AMD）",
    /* ---- v0.9.92：解/转码风向标 + 下滑翻页 ---- */
    setSt: "服务端转/解码", setStLbl: "解/转码风向标（服务器算力弱时禁用）",
    stAuto: "自动（服务端按需转码）", stOff: "禁用（本机设备解码）",
    stSaved: "✅ 服务端转/解码策略已保存",
    stCompassServer: "服务端转码", stCompassClient: "本机设备解码",
    stCompassFmt: "解/转码风向标：{path}",
    stWeak: "服务器算力偏弱（{cores} 核 · 仅软件编码），建议改为「禁用（本机设备解码）」",
    stHint: "禁用后服务端不做任何转码或重封装：原文件直出、由播放设备解码，服务器 CPU 不再被转码占满。原盘镜像（ISO/BDMV）与浏览器不支持的编码将无法播放。",
    vpDecodePath: "解码路径：{path}",
    vpCapOff: " · 画质上限不生效",
    dockPlaying: "正在播放", dockPaused: "已暂停", dockReturn: "回到播放",
    dockHint: "离开播放页后仍可一键回到正在播放的视频/音乐（不重新起播）",
    vpDecodeWarn: "⚠ {msg}",
    pagerScrollHint: "下滑自动翻页 · 每滑一次翻一页",
    pagerLoading: "正在载入第 {n} 页…",
    pagerPrefetched: "下一页已就绪",
    hwQsv: "Intel QSV", hwCuda: "NVIDIA CUDA/NVENC",
    diskFreeShort: "剩余", noVolumes: "未配置监控卷",
    hwBadgeFmt: "当前：{selected} · 可用：{available}", hwBadgeFail: "后端检测不可用 · 播放时回退 CPU",
    hwDrmFound: "DRM 设备：{device}", hwDrmMissing: "未检测到 /dev/dri 渲染节点",
    hwNvidiaFound: "已检测到 NVIDIA 设备节点", hwNvidiaMissing: "未检测到 NVIDIA 设备节点",
    hwEncoders: "FFmpeg 编码器：{list}", hwEncodersFail: "无法枚举 FFmpeg 编码器",
    hwFallbackNote: "硬件不可用时自动回退 CPU，不影响播放。",
    hwNoneToast: "未检测到可用显卡加速，将使用 CPU", hwFoundToast: "检测到 {selected} 硬件加速",
    hwProbeError: "显卡检测失败：{error}",
    sessionOk: "登录状态正常", sessionBad: "登录状态异常",
    sessionOkHint: "服务端会话有效，可以执行增删媒体库等写操作。",
    sessionBadHint: "服务端会话已失效或不存在，请重新登录后再执行写操作。",
    sessionReloginToast: "登录状态异常，请重新登录", sessionWriteBlocked: "登录状态异常，请重新登录后再{action}",
    loggedOutToast: "已退出登录", caddySavedToast: "Caddy 配置已保存并应用", caddySaveFail: "保存失败",
    caddyLoading: "正在载入…", caddyLines: "{n} 行", caddyRouteFmt: "{n} 条路由", caddyBackendDown: "后端不可用",
    writeAddLibrary: "添加媒体库", writeDeleteLibrary: "删除媒体库", caddySaveBlocked: "登录状态异常，请重新登录后再保存"
  },
  "zh-TW": {
    mpToken: "MoviePilot API Token",

    setModuleSub: "側欄不再放「新增模組」按鈕，模組的顯隱與自訂網頁在這裡管理", setModuleOpen: "開啟模組設定",

    navGroupLibrary: "媒體庫", navManage: "管理 ›",
    accountMenu: "帳戶與設定", avatarSettings: "頭像設定",
    avatarLead: "頭像僅保存在本瀏覽器 localStorage，不會上傳伺服器。可用文字縮寫、emoji 或上傳圖片。",
    avatarPreview: "預覽效果", avatarText: "顯示文字（1-2 個字元或 emoji）", avatarColor: "背景色",
    avatarUpload: "上傳頭像圖片（可選）", avatarReset: "恢復預設", avatarSaved: "頭像已保存",
    avatarTooLarge: "圖片過大，無法保存到 localStorage", avatarResetDone: "頭像已恢復預設",
    setLibrary: "媒體庫", setLibExisting: "已新增的媒體庫",
    /* v0.9.88 */
    scrapeMinMatchLabel: "標題匹配閾值（最低識別字元佔比）",
    scrapeMinMatchHint: "預設 70%：標題無需完全一致，70% 字元對得上即算命中；未命中的條目會在通知裡給出匹配度，可到「逐項掃描 → ✎ 編輯名稱」補名後重刮。",
    scrapeRegionLabel: "刮削地區（TMDB 語言）",
    scrapeRegionAuto: "跟隨介面語言",
    scrapeRegionCn: "中國（中文簡體 · zh-CN）",
    scrapeRegionJp: "日本（日文 · ja-JP）",
    scrapeRegionUs: "美國（英文 · en-US）",
    scrapeRegionHint: "刮削與詳情頁的 TMDB 請求依該地區語言查詢：選「日本」查日文原名、選「美國」查英文原名，可避免中文介面查不到日/美作品而回落成資源名（檔名展示）。",
    notifyScrapeQueue: "刮削隊列 {ok}/{total}",
    libScanAuto: "自動掃描（整庫逐項刮削）",
    libScanItem: "逐項掃描（手動選擇條目）",
    libScanTitle: "逐項掃描",
    libScanAll: "自動掃描整庫",
    libScanRetryFailed: "僅重試失敗項",
    editTitleLabel: "媒體名稱（用於刮削搜尋）",
    editYearLabel: "年份",
    editSeasonHint: "劇集分季：標籤裡寫「劇名S01 / 劇名S04」表示這一季依該劇的第 1 / 第 4 季刮削。自動刮削分不清哪一季時，用它手工指定即可（同一部劇的不同季會歸到同一張劇集卡，卡內依季分開）。",
    editScrapeHint: "名稱與年份會作為刮削搜尋詞：儲存後立即依新名稱重刮一次，跨裝置一致。",
    setLibExistingHint: "側邊欄只顯示這裡建立時填寫的庫名稱。每個庫都可以單獨重新掃描、開啟或刪除。",
    setLibAdd: "媒體庫新增",
    setLibAddHint: "先選來源：本地媒體庫使用容器內已掛載的絕對路徑；外連服務接入 Emby / Navidrome / Komga 等現成伺服器。",
    setLibCustomModule: "自訂模組",
    setLibCustomModuleHint: "自訂模組用於新增媒體庫：選「通用網頁」接入任意 Web 服務；選漫畫 / 影視 / 音訊則等同於新增一個對應大類的媒體庫。",
    setLibCustomModuleOpen: "開啟自訂模組",
    setLibCustomModuleTip: "模組的顯示 / 隱藏與刪除都在模組設定裡管理。",
    footerAboutHint: "版本與「系統設定 → 帳戶與登入 → 關於」中的版本參數保持一致",
    libSrcLocal: "本地媒體庫", libSrcExternal: "外連服務",
    libPathHint: "路徑必須是容器內已掛載且存在的絕對目錄；庫名稱會直接作為側邊欄與刮削識別。",
    extLibName: "服務名稱", extLibLan: "內網位址", extLibProxy: "反代 / 外網網域（可選）",
    extLibAdd: "新增外連服務", extLibList: "已新增的外連服務",
    extLibHint: "內網存取自動走內網位址，外網存取自動走反代網域；新增後會在側邊欄媒體庫中出現。",
    extLibEmpty: "尚未新增外連服務", extLibNeed: "請填寫服務名稱與內網位址",
    extLibAdded: "外連服務「{name}」已新增", extLibRemoved: "外連服務已刪除",
    libNavEmpty: "尚未新增媒體庫", libCountBadge: "{n} 個媒體庫",
    buildProgress: "正在建立索引", buildScanned: "已掃描 {n} 項",
    buildElapsed: "已用 {sec}", buildCancel: "取消建立",
    buildCancelled: "已取消索引建立", buildDone: "索引建立完成",
    buildWaiting: "正在統計檔案數量…", buildRefresh: "手動重新整理",
    homeOpenFail: "無法開啟：媒體庫或檔案不存在",

    caddySettings: "Caddy 設定", caddyOrigin: "WebUI 外部網域", caddyAdminToken: "管理權杖", caddyFile: "Caddyfile", caddySave: "儲存並套用", caddyReload: "重新載入", caddyHint: "儲存後會驗證並熱載入容器內的 Caddy 設定；失敗時會回滾。", superComicTitle: "Komga / Kavita / Calibre-Web · 統一書庫", appName: "蜀鼠之家", appSub: "VaultHub · 家庭 NAS 控制台",
    navGroupMain: "主導覽", navHome: "首頁", navPt: "PT 管理",
    navGroupMedia: "媒體", navComic: "超漫畫", navMovie: "影視", navAudio: "音訊",
    navGroupSys: "系統",
    navGroupCustom: "自訂",
    settings: "系統設定", about: "關於",
    setAccount: "帳戶管理", setAccountTitle: "目前登入狀態", sessionChecking: "正在檢查登入狀態…", sessionRefresh: "重新檢查",
    sessionHint: "登入狀態預設保持 30 天（登入頁勾選「保持登入 60 天」後為 60 天），容器重建或升級後依然有效；新增或刪除媒體庫等寫入操作需要有效登入。",
    sessionOkHintDays: "已保持登入 {days} 天；新增或刪除媒體庫等寫入操作可直接執行。",
    loginKeep60: "保持登入 60 天（預設 30 天）",
    notifyTitle: "通知",
    notifyEmpty: "暫無通知",
    notifyClear: "清空",
    notifyMarkRead: "全部已讀",
    notifyScrapeStart: "開始刮削 {n} 項",
    notifyScrapeDone: "刮削完成：成功 {ok} · 失敗 {fail} · 跳過 {skip}",
    notifyScrapeRetry: "重試失敗項：{n} 項",
    notifyScrapeFailItem: "刮削失敗：{title}（{reason}）",
    notifyOpenLibrary: "查看媒體庫",
    castAs: "飾演",
    castTitle: "演職人員",
    castVoiceAs: "配音",
    castEmpty: "暫無演職人員資訊",
    nowResume: "繼續播放",
    nowPlay: "繼續播放",
    netDisksTitle: "硬碟與網路",
    diskTempShort: "硬碟溫度",
    netNic: "網卡",
    setLogoutTitle: "登出", setLogout: "登出", setLogoutHint: "登出後會立即失效伺服器工作階段並回到登入頁，本機儲存的介面偏好不會被清除。",
    caddyOpenPage: "開啟 Caddy 設定頁面", caddyPageHint: "Caddyfile 內容較長，單獨佔用一整頁編輯。",
    caddyPageTitle: "Caddy 反向代理設定", caddyPageClose: "關閉",
    secNas: "NAS 監控", cpu: "CPU", memory: "記憶體", network: "網路", diskTemp: "硬碟溫度",
    used: "使用率", cores: "核心數", load: "負載", temp: "溫度",
    memUsed: "已用", memTotal: "總計", swap: "交換",
    netDownLbl: "↓ 下行", netUpLbl: "↑ 上行",
    secDisk: "硬碟容量",
    secPt: "PT 管理", ptRefresh: "重新整理", mpConn: "MoviePilot 登入", mpSettings: "設定",
    mpAddr: "MoviePilot 存取位址", mpUser: "登入帳號", mpPass: "登入密碼",
    btnLogin: "登入並取得資料", btnLogout: "登出",
    ptNotLoggedIn: "未登入",
    ptSubNav: "子頁面", ptSubSites: "站點管理", ptSubGuard: "PT 監護室",
    ptSiteList: "已新增站點", colCookie: "Cookie", colPri: "優先順序",
    colSite: "站點", colDomain: "網域", colStatus: "狀態",
    colYear: "成立年份", colAnniv: "站慶", colMp: "MP 同步", ptSiteData: "站點資料",
    guardPlugin: "外掛狀態", guardInstalled: "是否安裝", guardEnabled: "是否啟用", guardVersion: "版本",
    guardWork: "工作狀態", guardFetch: "資料源", guardFetched: "上次取得", guardCron: "定時推送", guardNotify: "公告通知",
    guardSummary: "快照統計", guardTotal: "站點總數", guardHealthy: "正常", guardCritical: "病危", guardClosed: "已關站", guardOwned: "已接入 MP",
    guardSiteSync: "站點取得狀態同步", guardSyncBadge: "同步",
    guardPluginMissing: "Savept 外掛介面不可用 — 請在 MoviePilot 外掛市場安裝「Vue-PT監護室 (Savept)」",
    ptUp: "上傳", ptDown: "下載", ptRatio: "分享率", ptSeed: "做種", ptMagic: "魔力", ptLevel: "等級",
    ptOk: "✅ 已連線 · 自動輔種中", ptErr: "⚠️ Cookie 失效 · 需重新簽到",
    stHealthy: "運行中", stCritical: "病危", stClosed: "已關站", stUnknown: "未知",
    mpOwned: "已接入", mpAvailable: "可接入", mpUnsupported: "不支援",
    alertTitle: "公告",
    secComic: "超漫畫", secMovie: "影視伺服器", secAudio: "音訊伺服器",
    movieSupport: "支援 Plex / Emby / Jellyfin", audioSupport: "支援 道理魚 / Navidrome",
    lblLan: "內網 IP 位址", lblProxy: "反向代理 / 代理網域",
    lblAutoSwitch: "存取位址自動切換", lblAutoSwitchSub: "內網自動走內網 IP，外網自動走代理網域",
    curAddr: "目前存取位址", btnTest: "測試連線", btnSave: "儲存",
    mediaUser: "服務帳號", mediaPass: "服務密碼", btnMediaLogin: "進入媒體服務", btnOpenExternal: "新視窗開啟", mediaAccess: "服務訪問",
    mediaLoginNote: "填寫或選擇上方存取位址後，點擊「進入媒體服務」會在目前欄目內打開對應服務登入頁；帳號密碼在媒體服務頁面裡手動填寫。",
    mediaEmptyTitle: "暫無資源", mediaEmptyDesc: "目前欄目還沒有設定媒體伺服器。請先設定伺服器存取位址，儲存後這裡會作為資源訪問頁展示。", mediaCfgBtn: "設定伺服器", mediaHideCfg: "收起設定", mediaConfigured: "已設定",
    testOk: "✅ 連線成功 · 服務可達", saved: "💾 設定已儲存",
    comicHint: "提示：Kavita 中文閱讀體驗更佳；Komga 刮削能力更強（Comic Vine）。",
    kavitaHint: "提示：Kavita 內建閱讀器，支援書架管理。",
    ebookHint: "提示：可搭配 Calibre-Web Automated 實現 PT 下載後自動刮削入庫。",
    plexHint: "提示：Plex 需關閉「要求安全連線」或設定自訂網域存取。",
    embyHint: "提示：Emby 回呼 MP 時填寫 https://mp.example.com/api/v1/webhook?token=…",
    jellyfinHint: "提示：Jellyfin 開源免費，無數量限制。",
    ndHint: "提示：Navidrome 走 Cloudflare Tunnel 若播放卡頓，關閉 HTTP/3 並強制 cloudflared http2。",
    dlyHint: "提示：道理魚為本地音樂服務，代理網域需在 DNS 解析至 Tunnel。",
    secDocker: "Docker 容器", searchPh: "🔍 搜尋容器名稱 / 映像 / 狀態…",
    colName: "名稱", colImage: "映像", colStatus: "狀態", colPorts: "連接埠", colHealth: "健康",
    settingsTitle: "系統設定", langLbl: "介面語言",
    themeLbl: "外觀主題", themeDark: "暗色", themeLight: "亮色", themeCustom: "自訂背景（上傳圖片）",
    themeModeLbl: "明暗", themePaletteLbl: "調色板", themeAccentLbl: "強調色",
    accentTheme: "跟隨主題", themeAccentHint: "只換主色，不改明暗",
    themeModeSaved: "顯示模式已切換", themePaletteSaved: "調色板已切換", themeAccentSaved: "強調色已切換",
    themeReduceMotion: "減弱動效", themeReduceMotionSub: "對動畫敏感或舊機器：過渡與動畫壓到 1ms",
    themeCustomBg: "使用自訂背景圖片", themeCustomBgSub: "獨立背景層，圖片只存在本瀏覽器",
    bgEnabled: "已啟用自訂背景", bgDisabled: "已關閉自訂背景",
    themeNote: "主題 = 調色板 × 明暗 × 強調色 三層疊加；每套調色板自帶圓角、陰影、標題字族與動效節奏，選擇只存在本瀏覽器。",
    bgUpload: "上傳背景圖片", bgClear: "清除自訂背景", bgHint: "提示：圖片僅保存在本瀏覽器 localStorage，不經過伺服器。",
    monitoringLbl: "NAS 監控（內建讀取）", monitoringHint: "監控參數由 Compose 環境變數和唯讀掛載設定。",
    nasOnline: "內建監控 · 每 5s 重新整理", nasOffline: "內建監控不可用",
    diskSourceReal: "內建監控 · statvfs", diskSourceOffline: "內建監控不可用",
    boardTitle: "模組設定", boardExisting: "既有模組", boardAddNew: "手動新增模組",
    boardName: "模組名稱", boardIcon: "圖示（emoji）", boardType: "功能類型",
    boardAddr: "伺服器 IP 或網域", boardPort: "連接埠（選填）", boardProto: "協定",
    boardUser: "帳號（選填）", boardPass: "密碼（選填）",
    btWeb: "通用網頁", btComic: "漫畫", btEbook: "電子書", btMovie: "影視", btAudio: "音訊", btPt: "PT 管理（MoviePilot）",
    btnVerify: "驗證並新增", btnAddDirect: "直接新增",
    boardHint: "提示：驗證會嘗試存取該伺服器（跨域或內網不可達時驗證會失敗，可改用「直接新增」）。媒體類型（漫畫/電子書/影視/音訊）新增後自動跳轉到對應的內建功能頁面；通用網頁類型開啟內嵌頁面。",
    verifyOk: "✅ 驗證通過 · 服務可達", verifyFail: "⚠️ 無法從瀏覽器直連（跨域或不可達），可點「直接新增」",
    boardAdded: "✅ 模組已新增並切換到新頁面", boardDeleted: "🗑 模組已刪除",
    boardEmpty: "暫無自訂模組，點擊下方「手動新增模組」",
    builtinBoard: "內建", customBoard: "自訂", ptInstance: "PT 實例",
    openNew: "在新視窗開啟", saveFirst: "請先填寫模組名稱與位址",
    moduleHide: "隱藏", moduleShow: "顯示",
    aboutTitle: "關於", aboutName: "應用名稱", aboutVer: "版本", aboutStack: "技術棧",
    aboutMon: "監控元件", aboutPt: "PT 外掛", aboutAuthor: "產生",
    aboutNote: "系統指標由內建介面讀取唯讀掛載的主機資訊；MoviePilot 與媒體服務繼續使用各自介面。",
    up: "運行中", stopped: "已停止", restarting: "重啟中",
    healthy: "healthy", unhealthy: "unhealthy",
    ptConnSaved: "✅ MoviePilot 連線已儲存", ptReal: "MoviePilot API", ptMock: "模擬資料（API 不可達）",
    testConnecting: "⏳ 正在驗證…",
    /* v0.6.30.Branch-update：Plex 風格改版新增的鍵 */ navMore: "更多 ›",
    navGroupBook: "電子書刊", navGroupVideo: "影視作品", navGroupAudio: "音視作品",
    settingsLead: "系統設定現在是獨立設定頁（不再是彈窗）：媒體庫、外觀主題、刮削設定與硬體設定分開；帳戶與登入頁內含登入狀態、關於與 Caddy 反向代理入口。",
    navMediaSearch: "媒體搜尋", searchTitle: "媒體搜尋", searchIdle: "輸入關鍵字搜尋媒體庫",
    searchLead: "媒體搜尋已改為頂欄的放大鏡按鈕：點一下彈出搜尋彈窗，不必離開當前頁面即可搜尋整個媒體庫。",
    searchPlaceholder: "搜尋媒體庫中的影視、書籍、音樂檔名", searchRun: "搜尋", searchClear: "清空",
    searchRunning: "正在搜尋媒體庫…", searchNoLibrary: "還沒有已新增的媒體庫，請先在系統設定中新增。",
    searchEmpty: "找不到與「{q}」相符的媒體檔案。", searchHits: "命中 {n} 個檔案",
    setAboutHint: "應用版本、技術棧與監控元件說明。", setAboutOpen: "查看關於資訊",
    settingsPageBadge: "獨立設定頁", settingsClose: "返回上一頁",
    /* ---- v0.9.51：视频播放器悬浮控制栏 ---- */
    vpCollapse: "最小化整個播放器",
    vpExpand: "還原播放器",
    vpPreparing: "正在準備播放…",
    shelfLoadingIndex: "正在載入完整索引…",
    shelfLoadingIndexN: "正在載入完整索引：{n} / {total} 條",
    vpFullscreen: "全螢幕切換",
    vpFullscreenExit: "退出全螢幕",
    vpPrev: "上一個",
    vpNext: "下一個",
    vpRewind: "快退 10 秒",
    vpForward: "快進 10 秒",
    vpPlayPause: "暫停或播放",
    vpPlay: "播放",
    vpPause: "暫停",
    vpClose: "關閉播放",
    vpMore: "更多操作",
    vpInfo: "取得資訊",
    editOriginalNameLabel: "原檔案名稱",
    editOriginalNameHint: "媒體庫裡未被改動的原始檔案名稱（唯讀，用於核對刮削結果）",
    vpDetails: "開啟詳情頁",
    vpDiag: "複製播放診斷",
    vpDiagOk: "播放診斷已複製",
    vpDiagFail: "剪貼簿不可用，資訊已在「取得資訊」面板中",
    vpSettings: "設定：轉碼品質、音訊流與字幕",
    vpQuality: "轉碼品質",
    vpQualityAuto: "自動（建議）",
    vpQualityOriginal: "原畫直播放",
    vpQualityFail: "畫質切換失敗",
    vpEngine: "播放引擎",
    vpAudioStream: "音訊流",
    vpAudioLoading: "讀取音源中…",
    vpSubtitle: "字幕",
    vpSubtitleNone: "暫無外掛字幕",
    vpSubtitleSearch: "搜尋並掛載字幕",
    vpPlaylist: "播放列表",
    vpPlaylistLoading: "正在讀取播放列表…",
    vpPlaylistEmpty: "目前媒體庫沒有可排隊的影片。",
    vpPlaylistNone: "播放列表為空",
    vpFirstItem: "已經是第一個",
    vpLastItem: "已經是最後一個",
    vpVolume: "聲音",
    vpMute: "靜音切換",
    vpProgress: "播放進度",
    vpTitleLoading: "正在載入…",
    vpFsDenied: "瀏覽器拒絕了全螢幕請求",
    setLook: "外觀主題", setScrape: "刮削與硬體", setScrapeTab: "刮削設定", setHwTab: "硬體設定",
    caddyRoutes: "反向代理服務網域",
    caddyRoutesHint: "維護服務網域與內網上游位址的對應，儲存後由內建 Caddy 校驗並熱載入，失敗會自動回滾。",
    setScrapeSrc: "刮削來源",
    setScrapeHint: "媒體庫按大類使用不同刮削源：電子書刊用 Google Books / Bangumi，影視作品用 TMDB / 豆瓣，音視作品用 MusicBrainz / 網易雲。",
    setHw: "顯卡加速", setHwLbl: "視訊相容流硬體加速", setHwDetect: "偵測顯卡",
    setHwHint: "需要在 Docker Compose 中透傳 /dev/dri 或設定 NVIDIA Container Toolkit。硬體不可用時會自動回退 CPU，不影響播放。",
    secServer: "伺服器監控",
    cpuUsage: "CPU 使用率", memUsage: "記憶體使用率", netSpeed: "網路速度", diskUsage: "硬碟使用率",
    avgTemp: " °C 均溫", diskFree: "容量剩餘",
    secNow: "正在播放", nowEmpty: "目前沒有正在播放的影片或音樂",
    secRecentBook: "最近入庫 · 電子書刊", secRecentBookSub: "電子書 / 漫畫",
    secRecentVideo: "最近入庫 · 影視作品", secRecentVideoSub: "電視劇集 / 電影",
    secRecentAudio: "最近入庫 · 音視作品", secRecentAudioSub: "音樂 / 音樂 MV",
    filterAll: "全部",
    kindBookDesc: "子類型：電子書 / 漫畫 · 刮削源 Google Books、Bangumi",
    kindVideoDesc: "子類型：電視劇集 / 電影 · 刮削源 TMDB、豆瓣",
    kindAudioDesc: "子類型：音樂 / 音樂 MV · 刮削源 MusicBrainz、網易雲",
    libKind: "媒體大類", libSubType: "子類型",
    libPath: "媒體路徑（容器內絕對路徑）", libExtraPath: "附加儲存路徑（選填，每行一個）", libName: "庫名稱（手動命名，用於刮削）",
    libAdd: "新增媒體庫", libRefresh: "重新整理", libRescanAll: "全部重新掃描",
    colLibName: "庫名稱", colLibKind: "大類 / 子類型", colLibPath: "媒體路徑",
    colLibItems: "項目", colLibState: "掃描狀態", colLibActs: "操作",
    libEmpty: "尚未新增媒體庫，填寫上方表單即可開始刮削",
    homeCountFmt: "共 {items} 項 · {libs} 個媒體庫", homeCountEmpty: "尚未新增媒體庫",
    libCountFmt: "{n} 個庫",
    stateWait: "待掃描", stateScraping: "掃描中", stateFail: "失敗",
    stateCancelled: "已取消", stateDone: "已完成",
    homeEmptyLib: "尚未新增{kind}媒體庫", homeLoading: "正在讀取最近入庫…",
    homeNoIndexed: "該分類暫無已索引的媒體檔案",
    actRescan: "重新掃描", actOpenLib: "開啟媒體庫", actRemove: "移除",
    nowBadge: "影片 / 音樂播放 · 含刮削資訊",
    typeAudio: "音樂", typeMusicvideo: "音樂影片（歌曲 MV）", typeComic: "漫畫",
    typeBook: "電子書", typeMovie: "電影", typeSeries: "電視劇集",
    hwAuto: "自動選擇（推薦）", hwCpu: "CPU", hwVaapi: "VAAPI（Intel/AMD）",
    /* ---- v0.9.92：解/轉碼風向標 + 下滑翻頁 ---- */
    setSt: "服務端轉/解碼", setStLbl: "解/轉碼風向標（伺服器算力弱時停用）",
    stAuto: "自動（服務端按需轉碼）", stOff: "停用（本機裝置解碼）",
    stSaved: "✅ 服務端轉/解碼策略已儲存",
    stCompassServer: "服務端轉碼", stCompassClient: "本機裝置解碼",
    stCompassFmt: "解/轉碼風向標：{path}",
    stWeak: "伺服器算力偏弱（{cores} 核 · 僅軟體編碼），建議改為「停用（本機裝置解碼）」",
    stHint: "停用後服務端不做任何轉碼或重封裝：原始檔直出、由播放裝置解碼，伺服器 CPU 不再被轉碼佔滿。原盤映像（ISO/BDMV）與瀏覽器不支援的編碼將無法播放。",
    vpDecodePath: "解碼路徑：{path}",
    vpCapOff: " · 畫質上限不生效",
    dockPlaying: "正在播放", dockPaused: "已暫停", dockReturn: "回到播放",
    dockHint: "離開播放頁後仍可一鍵回到正在播放的影片/音樂（不重新起播）",
    vpDecodeWarn: "⚠ {msg}",
    pagerScrollHint: "下滑自動翻頁 · 每滑一次翻一頁",
    pagerLoading: "正在載入第 {n} 頁…",
    pagerPrefetched: "下一頁已就緒",
    hwQsv: "Intel QSV", hwCuda: "NVIDIA CUDA/NVENC",
    diskFreeShort: "剩餘", noVolumes: "未設定監控卷",
    hwBadgeFmt: "目前：{selected} · 可用：{available}", hwBadgeFail: "後端偵測不可用 · 播放時回退 CPU",
    hwDrmFound: "DRM 裝置：{device}", hwDrmMissing: "未偵測到 /dev/dri 轉譯節點",
    hwNvidiaFound: "已偵測到 NVIDIA 裝置節點", hwNvidiaMissing: "未偵測到 NVIDIA 裝置節點",
    hwEncoders: "FFmpeg 編碼器：{list}", hwEncodersFail: "無法列舉 FFmpeg 編碼器",
    hwFallbackNote: "硬體不可用時自動回退 CPU，不影響播放。",
    hwNoneToast: "未偵測到可用顯卡加速，將使用 CPU", hwFoundToast: "偵測到 {selected} 硬體加速",
    hwProbeError: "顯卡偵測失敗：{error}",
    sessionOk: "登入狀態正常", sessionBad: "登入狀態異常",
    sessionOkHint: "伺服器工作階段有效，可以執行新增或刪除媒體庫等寫入操作。",
    sessionBadHint: "伺服器工作階段已失效或不存在，請重新登入後再執行寫入操作。",
    sessionReloginToast: "登入狀態異常，請重新登入", sessionWriteBlocked: "登入狀態異常，請重新登入後再{action}",
    loggedOutToast: "已登出", caddySavedToast: "Caddy 設定已儲存並套用", caddySaveFail: "儲存失敗",
    caddyLoading: "正在載入…", caddyLines: "{n} 行", caddyRouteFmt: "{n} 條路由", caddyBackendDown: "後端不可用",
    writeAddLibrary: "新增媒體庫", writeDeleteLibrary: "刪除媒體庫", caddySaveBlocked: "登入狀態異常，請重新登入後再儲存"
  },
  "en": {
    mpToken: "MoviePilot API token",

    setModuleSub: "The nav bar no longer has an Add Module button; module visibility and custom pages live here", setModuleOpen: "Open module settings",

    navGroupLibrary: "Libraries", navManage: "Manage ›",
    accountMenu: "Account & settings", avatarSettings: "Avatar settings",
    avatarLead: "The avatar is stored in this browser's localStorage only, never uploaded. Use initials, an emoji or an image.",
    avatarPreview: "Preview", avatarText: "Display text (1-2 characters or emoji)", avatarColor: "Background colour",
    avatarUpload: "Upload avatar image (optional)", avatarReset: "Reset to default", avatarSaved: "Avatar saved",
    avatarTooLarge: "Image too large for localStorage", avatarResetDone: "Avatar reset to default",
    setLibrary: "Libraries", setLibExisting: "Existing libraries",
    /* v0.9.88 */
    scrapeMinMatchLabel: "Title match threshold (min. recognised characters)",
    scrapeMinMatchHint: "Default 70%: the title does not need to match exactly — 70% of the characters is enough. Misses report their best score in the notification centre; rename the item under Item scan → ✎ Edit name and re-scrape.",
    scrapeRegionLabel: "Scrape region (TMDB language)",
    scrapeRegionAuto: "Follow interface language",
    scrapeRegionCn: "China (Simplified Chinese · zh-CN)",
    scrapeRegionJp: "Japan (Japanese · ja-JP)",
    scrapeRegionUs: "United States (English · en-US)",
    scrapeRegionHint: "TMDB requests for scraping and detail pages use this region's language, so Japanese/US titles are found by their original names instead of falling back to the raw file name.",
    notifyScrapeQueue: "Scrape queue {ok}/{total}",
    libScanAuto: "Auto scan (scrape every item)",
    libScanItem: "Item-by-item scan",
    libScanTitle: "Item-by-item scan",
    libScanAll: "Auto scan whole library",
    libScanRetryFailed: "Retry failed only",
    editTitleLabel: "Title (used as the scrape query)",
    editYearLabel: "Year",
    editScrapeHint: "Title and year are used as the scrape query: saving re-scrapes this item by the new title.",
    editSeasonHint: "Seasonal split: a tag like \"ShowS04\" scrapes this season as season 4 of that show. Use it when auto matching cannot tell seasons apart (seasons of one show stay in one card, split by season).",
    setLibExistingHint: "The top bar shows only the library names you enter here. Each library can be rescanned, opened or removed.",
    setLibAdd: "Add a library",
    setLibAddHint: "Pick a source: local libraries use absolute paths mounted inside the container; external services connect to Emby / Navidrome / Komga and friends.",
    setLibCustomModule: "Custom modules",
    setLibCustomModuleHint: "Custom modules add libraries: pick Web page for any site, or comic / movie / audio to add a library in that category.",
    setLibCustomModuleOpen: "Open custom modules",
    setLibCustomModuleTip: "Show / hide and delete modules in the module settings.",
    footerAboutHint: "Version is kept in sync with 系统设置 → 账户与登录 → 关于",
    libSrcLocal: "Local library", libSrcExternal: "External service",
    libPathHint: "The path must be an absolute directory mounted inside the container; the library name is used as the top-bar tab label and for scraping.",
    extLibName: "Service name", extLibLan: "LAN address", extLibProxy: "Reverse-proxy / public domain (optional)",
    extLibAdd: "Add external service", extLibList: "Existing external services",
    extLibHint: "LAN visitors use the LAN address, external visitors use the proxy domain. Added services show up as top-bar library tabs.",
    extLibEmpty: "No external service added yet", extLibNeed: "Enter a service name and LAN address",
    extLibAdded: "External service \"{name}\" added", extLibRemoved: "External service removed",
    libNavEmpty: "No library added yet", libCountBadge: "{n} libraries",
    buildProgress: "Building index", buildScanned: "{n} items scanned",
    buildElapsed: "elapsed {sec}", buildCancel: "Cancel build",
    buildCancelled: "Index build cancelled", buildDone: "Index build finished",
    buildWaiting: "Counting files…", buildRefresh: "Refresh now",
    homeOpenFail: "Cannot open: library or file is missing",

    caddySettings: "Caddy Config", caddyOrigin: "WebUI public domain", caddyAdminToken: "Admin token", caddyFile: "Caddyfile", caddySave: "Save & apply", caddyReload: "Reload", caddyHint: "Save will validate and hot-reload the container Caddy config; failures roll back.", superComicTitle: "Komga / Kavita / Calibre-Web · Unified Library", appName: "VaultHub", appSub: "VaultHub · Home NAS console",
    navGroupMain: "Main", navHome: "Home", navPt: "PT Manager",
    navGroupMedia: "Media", navComic: "Super Comics", navMovie: "Movies", navAudio: "Audio",
    navGroupSys: "System",
    navGroupCustom: "Custom",
    settings: "Settings", about: "About",
    setAccount: "Account", setAccountTitle: "Current session", sessionChecking: "Checking session…", sessionRefresh: "Refresh",
    sessionHint: "Sign-in is kept for 30 days by default (60 days when you tick \"keep me signed in for 60 days\") and survives container restarts or upgrades; adding or removing libraries requires a valid sign-in.",
    sessionOkHintDays: "Signed in for {days} days; write operations are allowed.",
    loginKeep60: "Keep me signed in for 60 days (30 by default)",
    notifyTitle: "Notifications",
    notifyEmpty: "No notifications yet",
    notifyClear: "Clear",
    notifyMarkRead: "Mark all read",
    notifyScrapeStart: "Scraping {n} item(s)",
    notifyScrapeDone: "Scrape finished: {ok} ok · {fail} failed · {skip} skipped",
    notifyScrapeRetry: "Retrying {n} failed item(s)",
    notifyScrapeFailItem: "Scrape failed: {title} ({reason})",
    notifyOpenLibrary: "Open library",
    castAs: "as",
    castTitle: "Cast",
    castVoiceAs: "voice",
    castEmpty: "No cast information yet",
    nowResume: "Resume",
    nowPlay: "Resume playback",
    netDisksTitle: "Disks & Network",
    diskTempShort: "Disk temp",
    netNic: "NIC",
    setLogoutTitle: "Sign out", setLogout: "Sign out", setLogoutHint: "Signing out invalidates the server session immediately and returns to the login screen. Local UI preferences are kept.",
    caddyOpenPage: "Open Caddy config page", caddyPageHint: "The Caddyfile is long, so it gets a dedicated full page instead of a cramped dialog.",
    caddyPageTitle: "Caddy reverse proxy config", caddyPageClose: "Close",
    secNas: "NAS Monitor", cpu: "CPU", memory: "Memory", network: "Network", diskTemp: "Disk Temp",
    used: "used", cores: "Cores", load: "Load", temp: "Temp",
    memUsed: "Used", memTotal: "Total", swap: "Swap",
    netDownLbl: "↓ Down", netUpLbl: "↑ Up",
    secDisk: "Disk Usage",
    secPt: "PT Manager", ptRefresh: "Refresh", mpConn: "MoviePilot Login", mpSettings: "Settings",
    mpAddr: "MoviePilot URL", mpUser: "Username", mpPass: "Password",
    btnLogin: "Login & fetch data", btnLogout: "Logout",
    ptNotLoggedIn: "Not logged in",
    ptSubNav: "Sections", ptSubSites: "Site Manager", ptSubGuard: "PT Guard",
    ptSiteList: "Added Sites", colCookie: "Cookie", colPri: "Priority",
    colSite: "Site", colDomain: "Domain", colStatus: "Status",
    colYear: "Founded", colAnniv: "Anniv.", colMp: "MP Sync", ptSiteData: "Site Data",
    guardPlugin: "Plugin Status", guardInstalled: "Installed", guardEnabled: "Enabled", guardVersion: "Version",
    guardWork: "Work Status", guardFetch: "Source", guardFetched: "Last fetch", guardCron: "Cron push", guardNotify: "Notices",
    guardSummary: "Snapshot Stats", guardTotal: "Total sites", guardHealthy: "Healthy", guardCritical: "Critical", guardClosed: "Closed", guardOwned: "Linked MP",
    guardSiteSync: "Site Fetch Sync", guardSyncBadge: "sync",
    guardPluginMissing: "Savept plugin API unavailable — install 'Vue-PT监护室 (Savept)' from MoviePilot plugin market",
    ptUp: "Upload", ptDown: "Download", ptRatio: "Ratio", ptSeed: "Seeding", ptMagic: "Magic", ptLevel: "Level",
    ptOk: "✅ Connected · Auto-seeding", ptErr: "⚠️ Cookie expired · Re-checkin",
    stHealthy: "Healthy", stCritical: "Critical", stClosed: "Closed", stUnknown: "Unknown",
    mpOwned: "Linked", mpAvailable: "Available", mpUnsupported: "N/A",
    alertTitle: "Notices",
    secComic: "Super Comics", secMovie: "Media Server", secAudio: "Audio Server",
    movieSupport: "Plex / Emby / Jellyfin", audioSupport: "DLY / Navidrome",
    lblLan: "LAN IP Address", lblProxy: "Reverse Proxy / Domain",
    lblAutoSwitch: "Auto-switch access URL", lblAutoSwitchSub: "LAN uses LAN IP, external uses proxy domain",
    curAddr: "Current address", btnTest: "Test connection", btnSave: "Save",
    mediaUser: "Service username", mediaPass: "Service password", btnMediaLogin: "Enter media service", btnOpenExternal: "Open in new window", mediaAccess: "Service access",
    mediaLoginNote: "Fill or select the access URL above, then enter the media service to open its login page inside this section. Type the username and password on that service page.",
    mediaEmptyTitle: "No resources", mediaEmptyDesc: "No media server is configured for this section yet. Configure the service address first; after saving, this area becomes the resource access page.", mediaCfgBtn: "Configure server", mediaHideCfg: "Hide config", mediaConfigured: "Configured",
    testOk: "✅ Connected · Service reachable", saved: "💾 Config saved",
    comicHint: "Tip: Kavita better for Chinese reading; Komga stronger scraping (Comic Vine).",
    kavitaHint: "Tip: Kavita has built-in reader with bookshelf support.",
    ebookHint: "Tip: Pair with Calibre-Web Automated for auto-scrape after PT download.",
    plexHint: "Tip: Plex: disable 'Secure connections required' or set custom domain.",
    embyHint: "Tip: Emby webhook to MP: https://mp.example.com/api/v1/webhook?token=…",
    jellyfinHint: "Tip: Jellyfin is open-source and unlimited.",
    ndHint: "Tip: If Navidrome stutters via Cloudflare Tunnel, disable HTTP/3 and force cloudflared http2.",
    dlyHint: "Tip: DLY is a local music service; proxy domain must resolve to Tunnel.",
    secDocker: "Docker Containers", searchPh: "🔍 Search name / image / status…",
    colName: "Name", colImage: "Image", colStatus: "Status", colPorts: "Ports", colHealth: "Health",
    settingsTitle: "Settings", langLbl: "Language",
    themeLbl: "Appearance", themeDark: "Dark", themeLight: "Light", themeCustom: "Custom background (upload)",
    themeModeLbl: "Light / dark", themePaletteLbl: "Palette", themeAccentLbl: "Accent",
    accentTheme: "Follow palette", themeAccentHint: "Recolors the primary only",
    themeModeSaved: "Display mode", themePaletteSaved: "Palette", themeAccentSaved: "Accent",
    themeReduceMotion: "Reduce motion", themeReduceMotionSub: "For motion-sensitive or older devices: 1ms transitions",
    themeCustomBg: "Custom background image", themeCustomBgSub: "Independent layer, stored in this browser only",
    bgEnabled: "Custom background on", bgDisabled: "Custom background off",
    themeNote: "Theme = palette × light/dark × accent. Each palette carries its own radius, shadow, heading font and motion tempo; choices stay in this browser.",
    bgUpload: "Upload background image", bgClear: "Clear custom background", bgHint: "Tip: image stays in this browser's localStorage, never sent to a server.",
    monitoringLbl: "NAS Monitor (built in)", monitoringHint: "Configure monitoring with Compose environment variables and read-only mounts.",
    nasOnline: "Built-in monitor · refresh 5s", nasOffline: "Built-in monitor unavailable",
    diskSourceReal: "Built-in monitor · statvfs", diskSourceOffline: "Built-in monitor unavailable",
    boardTitle: "Module Settings", boardExisting: "Existing Modules", boardAddNew: "Add Module Manually",
    boardName: "Module name", boardIcon: "Icon (emoji)", boardType: "Type",
    boardAddr: "Server IP or domain", boardPort: "Port (optional)", boardProto: "Protocol",
    boardUser: "Username (optional)", boardPass: "Password (optional)",
    btWeb: "Generic web", btComic: "Comics", btEbook: "E-books", btMovie: "Movies", btAudio: "Audio", btPt: "PT Manager (MoviePilot)",
    btnVerify: "Verify & add", btnAddDirect: "Add directly",
    boardHint: "Verify probes the server (CORS/LAN unreachable may fail; use 'Add directly' then). Media types (comic/ebook/movie/audio) jump to the built-in feature page on add; generic web opens an embedded page.",
    verifyOk: "✅ Verified · Service reachable", verifyFail: "⚠️ Cannot reach from browser (CORS or unreachable) — use 'Add directly'",
    boardAdded: "✅ Module added, switching to its page", boardDeleted: "🗑 Module deleted",
    boardEmpty: "No custom modules yet — use 'Add Module Manually' below",
    builtinBoard: "Built-in", customBoard: "Custom", ptInstance: "PT instance",
    openNew: "Open in new window", saveFirst: "Fill in name and address first",
    moduleHide: "Hide", moduleShow: "Show",
    aboutTitle: "About", aboutName: "App name", aboutVer: "Version", aboutStack: "Stack",
    aboutMon: "Monitor", aboutPt: "PT plugin", aboutAuthor: "Generated by",
    aboutNote: "System metrics come from the built-in endpoint and read-only host mounts; MoviePilot and media services keep their own APIs.",
    up: "running", stopped: "stopped", restarting: "restarting",
    healthy: "healthy", unhealthy: "unhealthy",
    ptConnSaved: "✅ MoviePilot connection saved", ptReal: "MoviePilot API", ptMock: "Mock (API unreachable)",
    testConnecting: "⏳ Verifying…",
    /* v0.6.30.Branch-update: keys added by the Plex-style redesign */ navMore: "More ›",
    navGroupBook: "Books & Comics", navGroupVideo: "Movies & TV", navGroupAudio: "Music & MV",
    settingsLead: "Settings is now a dedicated page (no longer a modal): libraries, appearance and separate scraping/hardware tabs live here; Account & Sign-in holds the session state, About and the Caddy reverse-proxy entry.",
    navMediaSearch: "Media search", searchTitle: "Media search", searchIdle: "Type a keyword to search your libraries",
    searchLead: "Media search now lives in the magnifier button in the top bar: click it to open the search dialog without leaving the page.",
    searchPlaceholder: "Search movie, book and music file names in your libraries", searchRun: "Search", searchClear: "Clear",
    searchRunning: "Searching libraries…", searchNoLibrary: "No library added yet — add one in system settings first.",
    searchEmpty: "No media file matches \"{q}\".", searchHits: "{n} files matched",
    setAboutHint: "App version, tech stack and monitoring components.", setAboutOpen: "Open About",
    settingsPageBadge: "Dedicated page", settingsClose: "Back",
    /* ---- v0.9.51：视频播放器悬浮控制栏 ---- */
    vpCollapse: "Minimize player",
    vpExpand: "Restore player",
    vpPreparing: "Preparing playback…",
    shelfLoadingIndex: "Loading full library index…",
    shelfLoadingIndexN: "Loading full library index: {n} / {total}",
    vpFullscreen: "Toggle fullscreen",
    vpFullscreenExit: "Exit fullscreen",
    vpPrev: "Previous",
    vpNext: "Next",
    vpRewind: "Back 10s",
    vpForward: "Forward 10s",
    vpPlayPause: "Play or pause",
    vpPlay: "Play",
    vpPause: "Pause",
    vpClose: "Close player",
    vpMore: "More actions",
    vpInfo: "Playback info",
    editOriginalNameLabel: "Original file name",
    editOriginalNameHint: "The untouched original file name in the media library (read-only; for checking scrape results).",
    vpDetails: "Open details page",
    vpDiag: "Copy playback diagnostics",
    vpDiagOk: "Playback diagnostics copied",
    vpDiagFail: "Clipboard unavailable; see the Playback info panel",
    vpSettings: "Settings: quality, audio and subtitles",
    vpQuality: "Transcode quality",
    vpQualityAuto: "Auto (recommended)",
    vpQualityOriginal: "Original",
    vpQualityFail: "Quality switch failed",
    vpEngine: "Playback engine",
    vpAudioStream: "Audio stream",
    vpAudioLoading: "Reading audio streams…",
    vpSubtitle: "Subtitles",
    vpSubtitleNone: "No external subtitles",
    vpSubtitleSearch: "Search and attach subtitles",
    vpPlaylist: "Playlist",
    vpPlaylistLoading: "Loading playlist…",
    vpPlaylistEmpty: "No queueable videos in this library.",
    vpPlaylistNone: "Playlist is empty",
    vpFirstItem: "Already the first item",
    vpLastItem: "Already the last item",
    vpVolume: "Volume",
    vpMute: "Toggle mute",
    vpProgress: "Playback progress",
    vpTitleLoading: "Loading…",
    vpFsDenied: "The browser denied fullscreen",
    setLook: "Appearance", setScrape: "Scraping & hardware", setScrapeTab: "Scraping", setHwTab: "Hardware",
    caddyRoutes: "Reverse proxy hostnames",
    caddyRoutesHint: "Maintain hostname to LAN upstream mappings. Saving validates and hot-reloads the built-in Caddy; failures roll back automatically.",
    setScrapeSrc: "Scraping sources",
    setScrapeHint: "Each category uses its own scrapers: Books & Comics via Google Books / Bangumi, Movies & TV via TMDB / Douban, Music & MV via MusicBrainz / NetEase.",
    setHw: "GPU acceleration", setHwLbl: "Hardware acceleration for compat streams", setHwDetect: "Detect GPU",
    setHwHint: "Requires passing /dev/dri through Docker Compose or configuring the NVIDIA Container Toolkit. Falls back to CPU automatically when unavailable, playback still works.",
    secServer: "Server monitoring",
    cpuUsage: "CPU usage", memUsage: "Memory usage", netSpeed: "Network speed", diskUsage: "Disk usage",
    avgTemp: " °C average", diskFree: "Free space",
    secNow: "Now playing", nowEmpty: "No video or music is playing right now",
    secRecentBook: "Recently added · Books & Comics", secRecentBookSub: "E-books / comics",
    secRecentVideo: "Recently added · Movies & TV", secRecentVideoSub: "TV series / movies",
    secRecentAudio: "Recently added · Music & MV", secRecentAudioSub: "Music / music videos",
    filterAll: "All",
    kindBookDesc: "Subtypes: e-book / comic · scrapers Google Books, Bangumi",
    kindVideoDesc: "Subtypes: TV series / movie · scrapers TMDB, Douban",
    kindAudioDesc: "Subtypes: music / music video · scrapers MusicBrainz, NetEase",
    libKind: "Category", libSubType: "Subtype",
    libPath: "Media path (absolute path inside the container)", libExtraPath: "Extra storage paths (optional, one per line)", libName: "Library name (manual, used for scraping)",
    libAdd: "Add library", libRefresh: "Refresh", libRescanAll: "Rescan all",
    colLibName: "Library", colLibKind: "Category / subtype", colLibPath: "Media path",
    colLibItems: "Items", colLibState: "Scan state", colLibActs: "Actions",
    libEmpty: "No library yet. Fill in the form above to start scraping.",
    homeCountFmt: "{items} items · {libs} libraries", homeCountEmpty: "No library yet",
    libCountFmt: "{n} libraries",
    stateWait: "Pending", stateScraping: "Scanning", stateFail: "Failed",
    stateCancelled: "Cancelled", stateDone: "Done",
    homeEmptyLib: "No {kind} library yet", homeLoading: "Loading recently added…",
    homeNoIndexed: "No indexed media files in this category yet",
    actRescan: "Rescan", actOpenLib: "Open library", actRemove: "Remove",
    nowBadge: "Video / music playback · includes scraped info",
    typeAudio: "Music", typeMusicvideo: "Music video", typeComic: "Comic",
    typeBook: "E-book", typeMovie: "Movie", typeSeries: "TV series",
    hwAuto: "Auto (recommended)", hwCpu: "CPU", hwVaapi: "VAAPI (Intel/AMD)",
    /* ---- v0.9.91: decode/transcode compass + scroll paging ---- */
    setSt: "Server decode/transcode", setStLbl: "Decode/transcode compass (disable when the server CPU is weak)",
    stAuto: "Auto (server transcodes on demand)", stOff: "Disabled (this device decodes)",
    stSaved: "✅ Server decode/transcode policy saved",
    stCompassServer: "server transcode", stCompassClient: "local device decode",
    stCompassFmt: "Decode/transcode: {path}",
    stWeak: "Server CPU looks weak ({cores} cores · software encode only) — consider \"Disabled (this device decodes)\"",
    stHint: "When disabled the server never transcodes or remuxes: the original file is served as-is and the playback device decodes it, so the server CPU is never saturated. Disc images (ISO/BDMV) and codecs the browser cannot play will not play.",
    vpDecodePath: "Decoding: {path}",
    vpCapOff: " · quality cap inactive",
    dockPlaying: "Now playing", dockPaused: "Paused", dockReturn: "Back to playback",
    dockHint: "Leave the player page and come back with one click \u2014 video/music keeps playing",
    vpDecodeWarn: "⚠ {msg}",
    pagerScrollHint: "Scroll down to page · one scroll = one page",
    pagerLoading: "Loading page {n}…",
    pagerPrefetched: "Next page ready",
    hwQsv: "Intel QSV", hwCuda: "NVIDIA CUDA/NVENC",
    diskFreeShort: "free", noVolumes: "No configured volumes",
    hwBadgeFmt: "Active: {selected} · available: {available}", hwBadgeFail: "Backend detection unavailable · falls back to CPU",
    hwDrmFound: "DRM device: {device}", hwDrmMissing: "No /dev/dri render node detected",
    hwNvidiaFound: "NVIDIA device nodes detected", hwNvidiaMissing: "No NVIDIA device nodes detected",
    hwEncoders: "FFmpeg encoders: {list}", hwEncodersFail: "Could not enumerate FFmpeg encoders",
    hwFallbackNote: "Falls back to CPU automatically when hardware is unavailable; playback is unaffected.",
    hwNoneToast: "No usable GPU acceleration detected — using CPU", hwFoundToast: "{selected} hardware acceleration detected",
    hwProbeError: "GPU detection failed: {error}",
    sessionOk: "Signed in", sessionBad: "Session invalid",
    sessionOkHint: "Server session is valid; write operations are allowed.",
    sessionBadHint: "Server session expired or missing — sign in again before writing.",
    sessionReloginToast: "Session invalid — please sign in again", sessionWriteBlocked: "Session invalid — sign in again before you {action}",
    loggedOutToast: "Signed out", caddySavedToast: "Caddy config saved and applied", caddySaveFail: "Save failed",
    caddyLoading: "Loading…", caddyLines: "{n} lines", caddyRouteFmt: "{n} routes", caddyBackendDown: "Backend unavailable",
    writeAddLibrary: "add a library", writeDeleteLibrary: "delete a library", caddySaveBlocked: "Session invalid — sign in again before saving"
  }
};

let curLang = "zh-CN";
const t = k => (I18N[curLang] && I18N[curLang][k]) || I18N["zh-CN"][k] || k;
/* tf 用于带占位符的文案：t("homeCountFmt") 取回 "共 {items} 项 · {libs} 个媒体库"，
   再把 {items}/{libs} 替换成实参。这样动态文案也能跟随语言切换，不必在 JS 里
   拼中文字面量。缺失的占位符保持原样，便于发现漏传参数。 */
function tf(key, vars) {
  return String(t(key)).replace(/\{(\w+)\}/g, (m, name) =>
    Object.prototype.hasOwnProperty.call(vars || {}, name) ? String(vars[name]) : m);
}

function applyI18n() {
  document.querySelectorAll("[data-i18n]").forEach(el => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll("[data-i18n-ph]").forEach(el => { el.placeholder = t(el.dataset.i18nPh); });
  document.querySelectorAll(".lang-opt").forEach(el => {
    el.classList.toggle("on", el.dataset.lang === curLang);
  });
  document.querySelectorAll("[data-i18n-ph]").forEach(el => { el.placeholder = t(el.dataset.i18nPh); });
}
/* v0.9.93：侧栏折叠/展开（toggleBars / loadSidebarRail）已随侧栏一并移除。 */


/* ================= 状态持久化 ================= */
const LS_SETTINGS = "dwu_settings";
const LS_BOARDS = "dwu_boards";
const LS_BG = "dwu_bgimg";

let settings = {
  theme: "dark",          /* 兼容字段：始终同步成 dark|light（阅读器与旧 CSS 仍在读它） */
  mode: "dark",           /* 明暗层：dark | light | auto（auto = 跟随系统） */
  palette: "emerald",     /* 调色板层：emerald | plum | neon | clay */
  accent: "theme",        /* 强调色层：theme（跟随调色板）| teal | indigo | rose | amber | violet */
  customBg: false,        /* 背景图层：是否启用自定义背景图片 */
  uiMode: "auto",         /* v0.9.76 UI 设备模式：auto(按设备识别) | phone | tv | pc */       /* v0.9.74 布局层：topnav（媒体库平铺顶栏，默认）| sidebar（v0.9.73 的侧栏） */
  reduceMotion: false,    /* 动效：减弱过渡与动画 */
  hardwareAcceleration: "auto",
  /* v0.9.91 解/转码风向标：auto = 服务端按需转/解码；off = 禁用服务端转/解码，
     改由播放设备本地解码（服务器 CPU 算力弱时用，避免转码把整机打满）。 */
  serverTranscode: "auto",
  /* 容器版默认经同源 Caddy 代理；外部浏览器无需直连家庭内网地址 */
  mp: { mpUrl: "/api/mp", username: "", password: "", token: "", tokenUser: "" }
};

/* v0.9.51 洗版：迁移逻辑不再引用任何具体内网 IP —— 按 RFC1918 网段判定历史
   默认内网 MoviePilot 地址（旧版 localStorage 里保存的 http://<内网IP>:3000 等），
   命中即改走同源代理路径，用户主动填写的域名/其他地址保持不变。 */
function isLegacyMpDefaultUrl(url) {
  try {
    const parsed = new URL(String(url || ""));
    const host = parsed.hostname;
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false;
    const octets = host.split(".").map(Number);
    const a = octets[0], b = octets[1];
    const rfc1918 = a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
    if (!rfc1918) return false;
    const port = parsed.port;
    return port === "" || port === "61208" || port === "3000";
  } catch (e) { return false; }
}
function preferContainerProxy(url, proxyPath) {
  const raw = String(url || "").trim();
  if (!raw || raw === proxyPath) return proxyPath;
  if (isLegacyMpDefaultUrl(raw)) return proxyPath;
  return raw;
}

function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(LS_SETTINGS) || "{}");
    if (s.theme) settings.theme = s.theme;
    /* v0.9.73 迁移：旧版只有 theme = dark|light|custom 一档，
       「custom」= 自定义背景（当年一律按暗色渲染），迁到 明暗层 + 背景层两个字段。 */
    if (["dark", "light", "auto"].includes(s.mode)) settings.mode = s.mode;
    else settings.mode = s.theme === "light" ? "light" : "dark";
    if (["emerald", "plum", "neon", "clay"].includes(s.palette)) settings.palette = s.palette;
    if (["theme", "teal", "indigo", "rose", "amber", "violet"].includes(s.accent)) settings.accent = s.accent;
    if (UI_MODES.includes(s.uiMode)) settings.uiMode = s.uiMode;
    if (s.theme === "custom") settings.customBg = true;
    if (typeof s.customBg === "boolean") settings.customBg = s.customBg;
    settings.reduceMotion = !!s.reduceMotion;
    if (["auto","cpu","vaapi","qsv","cuda"].includes(s.hardwareAcceleration)) settings.hardwareAcceleration = s.hardwareAcceleration;
    if (["auto","off"].includes(s.serverTranscode)) settings.serverTranscode = s.serverTranscode;
    if (s.mp && typeof s.mp === "object") Object.assign(settings.mp, s.mp);
    settings.mp.mpUrl = preferContainerProxy(settings.mp.mpUrl, "/api/mp");
    /* 兼容旧版本 mpInstances 数组 */
    if (Array.isArray(s.mpInstances) && s.mpInstances.length && !s.mp) {
      const first = s.mpInstances[0] || {};
      settings.mp = { mpUrl: preferContainerProxy(first.mpUrl || "", "/api/mp"), username: "", password: "", token: first.apiToken || "", tokenUser: "" };
    }
  } catch (e) {}
}
function saveSettings() {
  try { localStorage.setItem(LS_SETTINGS, JSON.stringify(settings)); } catch (e) {}
}

/* ==================== v0.9.82 浏览器本地缓存的安全写入 ====================
   症状（客户反馈）：用久了会弹「浏览器本地缓存写入失败（可能已满或被隐私模式限制）」，
   而且必须刷新页面甚至重开浏览器才能继续用；资源越多越频繁。
   根因：本站把媒体元数据 / 封面 / 歌手 / 剧集结构等**整份 JSON** 写进 localStorage。
   浏览器给每个源 5 MB 左右配额，一旦写满，setItem 就抛 QuotaExceededError；旧实现
   直接 catch(e){} 或提示一句就放弃 —— 之后每次刮削、收藏、改名都在同一个「已经满了」
   的配额上失败，表现就是「越用越卡、越用越容易失败」。
   服务端始终是权威数据源，本地缓存只是加速层，因此这里统一：
     1) 单键过大（> 1.2 MB）：只保留内存副本，不去挤本就紧张的配额；
     2) 写失败时先清理「可重建」缓存（封面刮削 / 剧集结构 / 播放进度）再重试一次；
     3) 仍失败才退化为内存缓存，并按真实原因提示一次（配额已满 / 站点禁止写入）。
   提示只出现一次，避免每写一次就弹一次把界面刷爆。 */

/* 单键上限 3 MB：localStorage 配额约 5 MB，留出余量给设置/收藏等小键。
   超过上限的键（大库的整份元数据）注定写不进去，直接只留内存副本，
   避免每次操作都抛一次 QuotaExceededError 并弹提示。 */
const VAULTHUB_LS_SINGLE_LIMIT = 3 * 1024 * 1024;
/* 可重建缓存：丢掉的代价只是「下次要重新拉/重新刮」，不会丢用户的收藏与评分。 */
const VAULTHUB_EVICTABLE_PATTERNS = [
  /^vaulthub_cover_scrape_v1$/,
  /^vaulthub_series_show_/,
  /^vaulthub_video_/,
  /^vaulthub_audio_artists_v1$/,
  /^vaulthub_audio_metadata_v1$/,
  /^vaulthub_movie_metadata_v1$/,
];
const vaulthubMemoryStore = new Map();
let vaulthubStorageWarned = false;

function vaulthubStorageBytes() {
  let total = 0;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i) || "";
      total += key.length + String(localStorage.getItem(key) || "").length;
    }
  } catch (e) { return 0; }
  return total;
}

/* 只清理可重建缓存（protectKey 绝不清理），返回释放出的字符数。 */
function vaulthubReclaimStorage(protectKey) {
  const victims = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i) || "";
      if (!key || key === protectKey) continue;
      if (VAULTHUB_EVICTABLE_PATTERNS.some(re => re.test(key))) victims.push(key);
    }
  } catch (e) { return 0; }
  let freed = 0;
  victims.forEach(key => {
    freed += key.length + String(localStorage.getItem(key) || "").length;
    try { localStorage.removeItem(key); } catch (e) {}
  });
  return freed;
}

function vaulthubStorageNotice(err) {
  if (vaulthubStorageWarned) return;
  vaulthubStorageWarned = true;
  const quota = !!err && (err.name === "QuotaExceededError" || err.name === "NS_ERROR_DOM_QUOTA_REACHED" || err.code === 22 || err.code === 1014);
  const used = vaulthubStorageBytes();
  const usedText = used ? `（本站已用约 ${(used / 1048576).toFixed(1)} MB）` : "";
  if (typeof toast === "function") {
    toast(quota
      ? `⚠️ 浏览器本地缓存已满${usedText}：本次改动已暂存内存，服务端数据不受影响；建议清理一次浏览器缓存`
      : `⚠️ 浏览器禁止本站写入本地缓存${usedText}（隐私模式或站点设置）：本次改动仅在当前页面有效`);
  }
  console.warn("[vault-store] 本地缓存写入失败，已退化为内存缓存", err);
}

/* 统一入口：所有「整份 JSON」的本地缓存写入都走这里。返回是否真的写进 localStorage。 */
function vaultStoreSet(key, value) {
  let text;
  try { text = typeof value === "string" ? value : JSON.stringify(value); } catch (e) { return false; }
  if (text == null) return false;
  if (text.length > VAULTHUB_LS_SINGLE_LIMIT) {
    vaulthubMemoryStore.set(key, text);
    return false;
  }
  try {
    localStorage.setItem(key, text);
    vaulthubMemoryStore.delete(key);
    return true;
  } catch (e) {
    if (vaulthubReclaimStorage(key) > 0) {
      try { localStorage.setItem(key, text); vaulthubMemoryStore.delete(key); return true; } catch (e2) { /* 仍然写不进 */ }
    }
    vaulthubMemoryStore.set(key, text);
    vaulthubStorageNotice(e);
    return false;
  }
}

/* 读取：localStorage 优先，写不进去时回落到内存副本（同一会话仍然一致）。 */
function vaultStoreGet(key) {
  try {
    const stored = localStorage.getItem(key);
    if (stored !== null) return stored;
  } catch (e) { /* 隐私模式读取也可能抛异常 */ }
  return vaulthubMemoryStore.has(key) ? vaulthubMemoryStore.get(key) : null;
}
function vaultStoreJSON(key, fallback) {
  try {
    const raw = vaultStoreGet(key);
    if (raw == null) return fallback;
    const parsed = JSON.parse(raw);
    return parsed == null ? fallback : parsed;
  } catch (e) { return fallback; }
}
function vaultStoreRemove(key) {
  vaulthubMemoryStore.delete(key);
  try { localStorage.removeItem(key); } catch (e) {}
}

let customBoards = [];
function loadBoards() {
  try { customBoards = JSON.parse(localStorage.getItem(LS_BOARDS) || "[]") || []; } catch (e) { customBoards = []; }
}
function saveBoards() {
  try { localStorage.setItem(LS_BOARDS, JSON.stringify(customBoards)); } catch (e) {}
}

let hiddenModules = [];
const LS_HIDDEN_MODULES = "dwu_hidden_modules";
function loadHiddenModules() {
  try {
    const saved = localStorage.getItem(LS_HIDDEN_MODULES);
    hiddenModules = saved === null ? ["pt"] : (JSON.parse(saved) || []);
  } catch (e) { hiddenModules = ["pt"]; }
  /* 容器管理已下线，历史配置里的 docker 项一并丢弃 */
  hiddenModules = hiddenModules.filter(x => x !== "docker");
  document.body.classList.toggle("module-hidden-pt", hiddenModules.includes("pt"));
}

function saveHiddenModules() {
  try { localStorage.setItem(LS_HIDDEN_MODULES, JSON.stringify(hiddenModules)); } catch (e) {}
}

/* ================= 主题 =================
   v0.9.73：主题定义整体搬到 web/js/06-theme.js（调色板 × 明暗 × 强调色 三层叠加，
   方案见该文件顶部注释）。这里只保留与「背景图层」相关的部分：
   背景是独立一层，不再伪装成第三种主题（旧版选「自定义背景」会把正文强行按暗色渲染）。 */
function applyBgImage() {
  const img = localStorage.getItem(LS_BG);
  if (img && settings.customBg) document.body.style.setProperty("--bgImg", `url(${img})`);
  else document.body.style.removeProperty("--bgImg");
}
function uploadBg(input) {
  const f = input.files && input.files[0];
  if (!f) return;
  const reader = new FileReader();
  reader.onload = e => {
    try {
      localStorage.setItem(LS_BG, e.target.result);
      /* v0.9.73：上传即视为要启用背景层（旧版必须先选中「自定义」主题才生效）。 */
      if (!settings.customBg) { settings.customBg = true; saveSettings(); }
      applyBgImage();
      document.body.classList.add("custom-bg");
      if (typeof syncThemeControls === "function") syncThemeControls();
      toast("✅ " + (curLang === "en" ? "Background saved" : "背景已保存"));
    } catch (err) {
      toast("⚠️ " + (curLang === "en" ? "Image too large for localStorage" : "图片过大，无法保存到 localStorage"));
    }
  };
  reader.readAsDataURL(f);
}
function clearBg() {
  localStorage.removeItem(LS_BG);
  settings.customBg = false;
  saveSettings();
  document.body.classList.remove("custom-bg");
  applyBgImage();
  if (typeof syncThemeControls === "function") syncThemeControls();
  toast("🗑 " + (curLang === "en" ? "Background cleared" : "背景已清除"));
}

function saveHardwareAcceleration() {
  const value = document.getElementById("hardwareAcceleration")?.value;
  settings.hardwareAcceleration = ["auto","cpu","vaapi","qsv","cuda"].includes(value) ? value : "auto";
  saveSettings();
  refreshHardwareStatus();
  toast("✅ 显卡加速设置已保存");
}
/* v0.9.78：演职人员图像刮削插件（内置，无需额外容器）——Metashark（豆瓣/TMDB 适配、
   中文文件名解析、演员头像下载器，随镜像内置）与 Plex NFO Agent（XBMCnfo 导入 +
   NFO 导出器生成带 <thumb> 头像字段）。属「刮削配置」。 */
function saveCastScraperPlugin(val) {
  const v = ["metashark","plex","tmdb","off"].includes(val) ? val : "metashark";
  const all = readMovieMetadata();
  const meta = { ...(all.__cast_plugin || {}), plugin: v, setAt: Date.now() };
  all["__cast_plugin"] = meta; writeMovieMetadata(all);
  try { localStorage.setItem("vaulthub_cast_scraper_plugin", v); } catch (e) {}
  toast("👤 演职人员头像刮削插件：已设为 " + v);
  const st = document.getElementById("castPluginStatus");
  if (st) st.textContent = "内置：" + v;
}
/* 显卡检测：后端会枚举 /dev/dri、NVIDIA 设备节点和 ffmpeg 实际编译进的编码器，
   这里把结果显示成"当前 / 可用 / 设备"三段，并在 notify 时给出 toast 反馈，
   避免点了「检测显卡」看不出任何变化。 */
async function refreshHardwareStatus(notify) {
  const badge = document.getElementById("hardwareStatus");
  if (!badge) return;
  const detail = document.getElementById("hardwareDetail");
  const select = document.getElementById("hardwareAcceleration");
  if (select) select.value = settings.hardwareAcceleration || "auto";
  badge.textContent = curLang === "en" ? "Detecting…" : "正在检测…";
  try {
    const res = await fetch(`/api/media/hardware?hw=${encodeURIComponent(settings.hardwareAcceleration || "auto")}`, { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    const selected = data.selected || "cpu";
    const available = Object.entries(data.available || {}).filter(([, ok]) => ok).map(([name]) => name.toUpperCase());
    badge.textContent = tf("hwBadgeFmt", { selected: selected.toUpperCase(), available: available.join(" / ") || "CPU" });
    badge.className = selected === "cpu" ? "badge" : "badge green";
    if (detail) {
      const parts = [];
      parts.push(data.vaapi_device ? tf("hwDrmFound", { device: data.vaapi_device }) : t("hwDrmMissing"));
      parts.push(data.nvidia_device ? t("hwNvidiaFound") : t("hwNvidiaMissing"));
      if (Array.isArray(data.encoders) && data.encoders.length) parts.push(tf("hwEncoders", { list: data.encoders.join(", ") }));
      if (!data.ffmpeg) parts.push(t("hwEncodersFail"));
      parts.push(t("hwFallbackNote"));
      detail.textContent = parts.join(" · ");
    }
    if (notify) toast(selected === "cpu" ? "ℹ️ " + t("hwNoneToast") : "✅ " + tf("hwFoundToast", { selected: selected.toUpperCase() }));
    /* v0.9.92：硬件探测结果同时驱动「解/转码风向标」。 */
    updateTranscodeCompass(data);
  } catch (e) {
    badge.textContent = t("hwBadgeFail");
    badge.className = "badge red";
    if (detail) detail.textContent = tf("hwProbeError", { error: e.message });
    if (notify) toast("⚠️ " + tf("hwProbeError", { error: e.message }));
    updateTranscodeCompass(null);
  }
}

/* v0.9.92：解/转码风向标 —— 显示当前策略（服务端转码 / 本机设备解码）与服务器算力提示。
   服务器 CPU 算力弱（无硬件编码器且核数少）时提示用户改用「禁用（本机设备解码）」。 */
function saveServerTranscode() {
  const value = document.getElementById("serverTranscode")?.value;
  settings.serverTranscode = value === "off" ? "off" : "auto";
  saveSettings();
  updateTranscodeCompass(window.__vhHardwareInfo || null);
  toast(t("stSaved"));
}
function updateTranscodeCompass(info) {
  const select = document.getElementById("serverTranscode");
  if (select) select.value = settings.serverTranscode || "auto";
  const badge = document.getElementById("transcodeCompass");
  if (!badge) return;
  const off = (settings.serverTranscode || "auto") === "off";
  const hw = (info && typeof info === "object") ? info : null;
  if (hw) window.__vhHardwareInfo = hw;
  const path = off ? t("stCompassClient") : t("stCompassServer");
  let extra = "";
  if (hw) {
    const cores = Number(hw.cores || 0);
    if (cores) extra += ` · ${cores} 核`;
    extra += ` · ${String(hw.selected || "cpu").toUpperCase()}`;
  }
  badge.textContent = tf("stCompassFmt", { path }) + extra;
  badge.className = off ? "badge green" : (hw && hw.weak_cpu === true ? "badge warn" : "badge");
  const hint = document.getElementById("transcodeCompassHint");
  if (hint) hint.textContent = (hw && hw.weak_cpu === true && !off) ? tf("stWeak", { cores: Number(hw.cores || 0) }) : t("stHint");
}

/* ================= 导航 =================
   v0.7.0：顶栏不再有「首页 / 资料库」按钮，导航里也不再重复展示三个资源大类。
   v0.9.93：媒体视图由顶栏的媒体库标签驱动（侧栏已移除），大类只在系统设置的媒体库配置里出现。
   （v0.9.16 删掉了 titleMap：顶栏标题去掉后它已无任何引用点。） */

function switchView(v, libId) {
  /* v0.9.93：侧栏已移除 —— 选中态由顶栏媒体库标签（syncTopLibTabs）与一级导航
     （syncTopNavView）承担，这里不再遍历已不存在的 .nav-item。 */
  /* 漫画与电子书同属 data-view="comic"，音乐与 MV 同属 "audio"。
     旧写法 querySelector('.nav-item[data-view="comic"]') 永远命中排在前面的那一个，
     于是点「电子书」后导航高亮仍停在「漫画」，看起来像是又跳回了漫画。
     顶栏标签现在带唯一的 data-nav-key，这里按它精确匹配；
     直接比较 dataset 而不是拼接选择器，媒体库名或 id 含引号时也不会选歪。

     未显式传 libId 时（首页「更多 ›」等旧调用点）回落到该视图
     当前选中的媒体库，避免高亮与页面内容对不上。
     选中态还要记到 window 上：媒体库标签每 5 秒整体重绘一次，只把 active 打在 DOM
     节点上会在重绘后丢失，表现为「点完 5 秒后导航什么都不亮」。 */
  let navKey = "";
  if (libId) {
    navKey = v + ":" + libId;
  } else if (typeof localMediaSelection !== "undefined" && localMediaSelection[v]) {
    navKey = v + ":" + localMediaSelection[v];
  }
  window.vaultHubActiveNavKey = navKey;
  /* v0.9.74：顶栏媒体库标签与一级导航的高亮跟随同一次视图切换
     （同组媒体库靠 navKey 区分，所以必须把 navKey 一起传下去）。 */
  if (typeof syncTopLibTabs === "function") syncTopLibTabs(navKey);
  if (typeof syncTopNavView === "function") syncTopNavView("view-" + v);
  document.querySelectorAll(".view").forEach(s => s.classList.remove("active"));
  const view = document.getElementById("view-" + v);
  if (view) view.classList.add("active");
  /* v0.9.94（需求2）：搜索已是弹窗，旧的 #view-search 落点（书签/旧链接）自动弹窗。 */
  if (v === "search" && typeof openMediaSearchModal === "function") openMediaSearchModal();
  /* v0.9.93：侧栏底部设置按钮已随侧栏移除；设置页的选中态由顶栏头像菜单承接。 */
  /* 音乐播放器只在音视作品视图显示，出现方式为屏幕居中浮层。 */
  const player = document.getElementById("audio-bottom-player");
  if (player) player.classList.toggle("show", v === "audio" && typeof audioHasActivePlayback === "function" && audioHasActivePlayback());
  /* v0.9.92：视图切换后刷新「正在播放」浮标 —— 离开播放页要能一键回去，
     回到播放页要收起提示（播放面可见时浮标不出现）。 */
  if (typeof updatePlaybackDock === "function") updatePlaybackDock();
  /* v0.9.66：离开音乐视图时归一化关闭海报放大态 —— 遮罩在 #view-audio 内会随视图隐藏，
     但 audioCoverZoomed 仍为 true，切回音乐页会「自动又弹一次」全屏海报。
     放在播放器显隐切换「之后」：底栏已隐藏时按钮 offsetParent 为空，
     closeAudioCoverZoom 会跳过归还焦点，不会把焦点抢到即将消失的按钮上。 */
  if (v !== "audio" && typeof closeAudioCoverZoom === "function") closeAudioCoverZoom();
  window.scrollTo(0, 0);
}

/* ================= 跨页「正在播放」入口（v0.9.92）=================
   客户反馈：「离开当前页面后无法快速回到视频/音乐播放当中，需要重新回到
   对应页面重新播放」。音乐元素与视频元素本来都还在 DOM 里（切视图只是
   display:none，不会销毁），但没有任何入口能回去，用户只能重新进库、重点一次。

   这里做一层与播放器解耦的「正在播放」状态：
   - 状态写 localStorage，刷新页面/换设备回来仍在；
   - 浮标只在「播放面不可见」时出现（播放器可见时它只是噪音）；
   - 点「回到播放」优先复用仍然活着的播放元素（真正的续播），
     元素已经销毁才按保存的进度重开（不是从 0 起播）。
   媒体相关的可见性/播放态判定在 02-media.js（playbackSurfaceVisible /
   activePlaybackPlaying），此处只做兜底。 */
const ACTIVE_PLAYBACK_KEY = "vaulthub_active_playback";
let activePlaybackState = null;
function activePlayback() {
  if (!activePlaybackState) {
    try { activePlaybackState = JSON.parse(localStorage.getItem(ACTIVE_PLAYBACK_KEY) || "null"); } catch (e) { activePlaybackState = null; }
  }
  return activePlaybackState;
}
function setActivePlayback(entry) {
  if (!entry || !entry.kind || !entry.path) return;
  const prev = activePlayback();
  activePlaybackState = {
    kind: entry.kind,
    group: entry.group || (entry.kind === "audio" ? "audio" : "movie"),
    libId: String(entry.libId || ""),
    path: String(entry.path || ""),
    title: String(entry.title || (prev && prev.path === entry.path ? prev.title : "") || ""),
    paused: entry.paused === true,
    at: Date.now(),
  };
  try { localStorage.setItem(ACTIVE_PLAYBACK_KEY, JSON.stringify(activePlaybackState)); } catch (e) {}
  updatePlaybackDock();
}
function setActivePlaybackPaused(paused) {
  const cur = activePlayback();
  if (!cur) return;
  cur.paused = paused === true;
  activePlaybackState = cur;
  try { localStorage.setItem(ACTIVE_PLAYBACK_KEY, JSON.stringify(cur)); } catch (e) {}
  updatePlaybackDock();
}
function clearActivePlayback(kind) {
  const cur = activePlayback();
  if (kind && cur && cur.kind !== kind) return;
  activePlaybackState = null;
  try { localStorage.removeItem(ACTIVE_PLAYBACK_KEY); } catch (e) {}
  updatePlaybackDock();
}
function playbackDockEl() { return document.getElementById("playbackDock"); }
function updatePlaybackDock() {
  /* v0.9.93：播放占用（顶栏回缩）与浮标同一时刻刷新，且必须在任何早退之前—— 
     浮标没显示时也要把顶栏还回来。 */
  if (typeof syncPlayerImmersive === "function") syncPlayerImmersive();
  const dock = playbackDockEl();
  if (!dock) return;
  const cur = activePlayback();
  /* v0.9.94（需求1）：迷你播放器「常驻顶栏」—— 只要还有没被主动关闭的播放
     （正在播/暂停中）就显示；只有一种情况不显示：影视播放器正占满窗口
     （body.player-immersive，此时顶栏本身已回缩，chip 跟着一起收起来）。
     点它「回到播放」，✕ 是主动关闭（会清掉这条）。 */
  /* 加可选链：document.body 在极早期调用/测试夹具里可能还不存在，不该因此抛错。 */
  const immersive = !!(document.body && document.body.classList && document.body.classList.contains("player-immersive"));
  const show = !!cur && !immersive;
  dock.classList.toggle("show", show);
  if (!show) return;
  const playing = typeof activePlaybackPlaying === "function" ? !!activePlaybackPlaying(cur) : !cur.paused;
  dock.dataset.kind = cur.kind;
  dock.dataset.playing = playing ? "1" : "0";
  const titleEl = dock.querySelector("[data-dock-title]");
  if (titleEl) titleEl.textContent = cur.title || cur.path;
  const subEl = dock.querySelector("[data-dock-sub]");
  if (subEl) subEl.textContent = (playing ? t("dockPlaying") : t("dockPaused")) + " · " + (cur.kind === "audio" ? "音乐" : "影视");
  const toggleEl = dock.querySelector("[data-dock-toggle]");
  if (toggleEl) toggleEl.textContent = playing ? "⏸" : "▶";
  const returnBtn = dock.querySelector(".pd-return");
  if (returnBtn) returnBtn.textContent = t("dockReturn");
}

/* ---------- 账户与登录：v0.9.17 起登录状态 / 关于 / 退出登录都在
   系统设置 → 账户与登录 里，顶栏 logo 不再是菜单按钮 ---------- */
/* v0.9.93：详情页不再需要「临时收起侧栏」（侧栏已移除）。 */

/* 打开系统设置并直接跳到账户与登录页（登录状态 / Caddy / 关于 / 退出登录）。 */
function openAccountSettings() { openSettingsPage("account"); }
/* v0.9.30：系统设置改为独立配置页 #view-settings。
   settingsReturnView 记住进入设置前所在的视图，关闭时回到那里而不是硬跳首页。 */
let settingsReturnView = "home";
function openSettingsPage(tab) {
  const current = document.querySelector(".view.active");
  if (current && current.id !== "view-settings") settingsReturnView = current.id.replace(/^view-/, "");
  switchView("settings");
  /* v0.9.83：自定义模块入口并入「系统设置 → 媒体库」，旧的 custom 入口
     仍可用（书签 / 旧链接），打开媒体库面板并直接弹出模块设置。 */
  if (tab === "custom") {
    switchSetTab("library");
    if (typeof openModuleModal === "function") openModuleModal();
    return;
  }
  switchSetTab(tab || currentSetTab || "library");
}
function closeSettingsPage() {
  const back = settingsReturnView && document.getElementById("view-" + settingsReturnView) ? settingsReturnView : "home";
  switchView(back);
}
function settingsPageOpen() { return !!document.getElementById("view-settings")?.classList.contains("active"); }

/* ---------- 页脚版本（v0.9.83） ----------
   版本参数只在「系统设置 → 账户与登录 → 关于」维护一处，页面最下端的
   页脚启动时读取同一份文本，避免两处各写一份、发版时漏改一处。 */
function appVersionLabel() {
  const about = document.querySelector(".about-row[data-about-ver] b");
  const text = ((about && about.textContent) || "").trim();
  return text || ("v" + VAULTHUB_SCRIPT_VERSION);
}
function syncAppFooterVersion() {
  const foot = document.getElementById("appFooterVer");
  if (!foot) return;
  const label = appVersionLabel();
  if (label && foot.textContent.trim() !== label) foot.textContent = label;
  foot.title = label;
}
/* 媒体库面板的自定义模块计数：模块本身就是可添加的媒体库入口。 */
function renderLibCustomModuleCount() {
  const el = document.getElementById("libCustomModuleCount");
  if (!el) return;
  const n = (typeof customBoards !== "undefined" && Array.isArray(customBoards)) ? customBoards.length : 0;
  el.textContent = n ? ("已添加 " + n + " 个模块") : "暂无自定义模块";
  el.title = "自定义模块可以像媒体库一样接入站点或资源";
}

/* ---------- 头像设置：文字 / 颜色 / 上传图片，仅存本浏览器 ---------- */
const LS_AVATAR = "vaulthub_avatar_v1";
let avatarConfig = { text: "Q", color: "#3fa7a7", image: "" };
function loadAvatarConfig() {
  try {
    const saved = JSON.parse(localStorage.getItem(LS_AVATAR) || "null");
    if (saved && typeof saved === "object") Object.assign(avatarConfig, saved);
  } catch (e) {}
  applyAvatarConfig();
}
function applyAvatarConfig() {
  const el = document.getElementById("tbAvatar");
  if (!el) return;
  if (avatarConfig.image) {
    el.textContent = "";
    el.style.backgroundImage = `url(${avatarConfig.image})`;
    el.style.backgroundSize = "cover";
    el.style.backgroundPosition = "center";
  } else {
    el.textContent = avatarConfig.text || "Q";
    el.style.backgroundImage = "";
    el.style.background = avatarConfig.color || "#3fa7a7";
  }
}
function openAvatarSettings() {
  const text = document.getElementById("avatarText");
  const color = document.getElementById("avatarColor");
  if (text) text.value = avatarConfig.text || "";
  if (color) color.value = avatarConfig.color || "#3fa7a7";
  previewAvatarSettings();
  openModal("avatarModal");
}
function previewAvatarSettings() {
  const shot = document.getElementById("avatarPreview");
  if (!shot) return;
  const text = (document.getElementById("avatarText")?.value || "Q").slice(0, 4);
  const color = document.getElementById("avatarColor")?.value || "#3fa7a7";
  if (avatarConfig.image) {
    shot.textContent = "";
    shot.style.backgroundImage = `url(${avatarConfig.image})`;
    shot.style.backgroundSize = "cover";
  } else {
    shot.textContent = text;
    shot.style.backgroundImage = "";
    shot.style.background = color;
  }
}
function uploadAvatarImage(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    avatarConfig.image = e.target.result;
    previewAvatarSettings();
  };
  reader.readAsDataURL(file);
}
function saveAvatarSettings() {
  avatarConfig.text = (document.getElementById("avatarText")?.value || "Q").slice(0, 4) || "Q";
  avatarConfig.color = document.getElementById("avatarColor")?.value || "#3fa7a7";
  try { localStorage.setItem(LS_AVATAR, JSON.stringify(avatarConfig)); }
  catch (e) { toast("⚠️ " + t("avatarTooLarge")); return; }
  applyAvatarConfig();
  closeModal("avatarModal");
  toast("✅ " + t("avatarSaved"));
}
function resetAvatarSettings() {
  avatarConfig = { text: "Q", color: "#3fa7a7", image: "" };
  try { localStorage.removeItem(LS_AVATAR); } catch (e) {}
  applyAvatarConfig();
  previewAvatarSettings();
  toast("🗑 " + t("avatarResetDone"));
}

/* v0.9.93：侧栏宽度记忆 / 拖拽 resizer / 移动端侧栏溢出提示（applySidebarWidth、
   loadSidebarWidth、resetSidebarWidth、initSidebarResizer、updateSidebarNavOverflow、
   initSidebarNavOverflowWatch）已随侧栏一并移除；--sidebar-w 恒为 0。 */

/* ================= v0.9.56 系统设置 → 账户与登录：登录凭据与鉴权模式 ================= */
async function loadAccountCredentialsUI() {
  const modeBadge = document.getElementById("accountAuthModeBadge");
  const userEl = document.getElementById("accountAuthUsername");
  const openBtn = document.getElementById("accountOpenModeButton");
  const pwBtn = document.getElementById("accountPasswordModeButton");
  const nameInput = document.getElementById("accountNewUsername");
  if (!modeBadge) return;
  let mode = vaultHubAuthMode, user = "";
  try {
    const res = await fetch("/api/auth/mode", { cache: "no-store" });
    if (res.ok) { const d = await res.json(); mode = d.mode === "open" ? "open" : "password"; user = d.username || ""; vaultHubAuthMode = mode; }
  } catch (e) {}
  modeBadge.textContent = mode === "open" ? "🈳 开放模式（无密码）" : "🔐 密码模式";
  modeBadge.className = "badge " + (mode === "open" ? "blue" : "green");
  if (userEl) userEl.textContent = user || "—";
  if (openBtn) openBtn.style.display = mode === "open" ? "none" : "inline-flex";
  if (pwBtn) pwBtn.style.display = mode === "open" ? "inline-flex" : "none";
  if (nameInput) nameInput.placeholder = "当前用户名：" + (user || "—") + "（留空不变）";
}
function accountCredFields() {
  return { u: document.getElementById("accountNewUsername"), c: document.getElementById("accountCurrentPassword"), n: document.getElementById("accountNewPassword"), n2: document.getElementById("accountNewPassword2") };
}
async function saveAccountCredentials() {
  const f = accountCredFields();
  const username = (f.u && f.u.value || "").trim(), pw = f.n && f.n.value || "", pw2 = f.n2 && f.n2.value || "";
  const curPw = f.c && f.c.value || "";
  /* v0.9.56：系统存在密码凭据（密码模式或开放模式曾设置密码）时，
     修改用户名/密码必须验证当前密码；纯开放模式（从未设密码）首次设置除外。 */
  const needOld = vaultHubHasPassword || vaultHubAuthMode !== "open";
  if (needOld && !curPw) { toast("⚠️ 请输入当前密码后再保存账户信息"); return; }
  if (pw) { const v = validateClientPassword(pw, username); if (v) { toast("⚠️ " + v); return; } }
  if (pw !== pw2) { toast("⚠️ 两次输入的新密码不一致"); return; }
  try {
    const res = await fetch("/api/account", { method: "POST", headers: sessionWriteHeaders(true), credentials: "same-origin", body: JSON.stringify({ old_password: curPw, username, password: pw }) });
    const data = await res.json();
    if (!res.ok || !data.ok) { toast("⚠️ " + (data.error || ("HTTP " + res.status))); return; }
    vaultHubAuthMode = data.mode === "open" ? "open" : "password";
    toast("✅ " + (data.message || "账户信息已保存"));
    loadAccountCredentialsUI();
    if (f.c) f.c.value = ""; if (f.n) f.n.value = ""; if (f.n2) f.n2.value = ""; if (f.u) f.u.value = "";
  } catch (e) { toast("⚠️ 保存失败：" + e.message); }
}
async function switchAccountOpenMode() {
  const f = accountCredFields();
  const curPw = f.c && f.c.value || "";
  /* v0.9.56：启用开放模式必须验证当前密码（v0.9.56 起即如此，保持）。 */
  if (!curPw) { toast("⚠️ 请输入当前密码后再切换开放模式"); return; }
  if (!confirm("切换为开放模式后，任何人都无需密码即可进入系统设置，确定继续？")) return;
  try {
    const res = await fetch("/api/account", { method: "POST", headers: sessionWriteHeaders(true), credentials: "same-origin", body: JSON.stringify({ old_password: curPw, mode: "open" }) });
    const data = await res.json();
    if (!res.ok || !data.ok) { toast("⚠️ " + (data.error || ("HTTP " + res.status))); return; }
    vaultHubAuthMode = "open";
    toast("✅ " + (data.message || "已切换为开放模式"));
    loadAccountCredentialsUI();
    if (f.c) f.c.value = "";
  } catch (e) { toast("⚠️ 切换失败：" + e.message); }
}
async function switchAccountPasswordMode() {
  const f = accountCredFields();
  const username = (f.u && f.u.value || "").trim(), pw = f.n && f.n.value || "", pw2 = f.n2 && f.n2.value || "";
  const curPw = f.c && f.c.value || "";
  /* v0.9.56：系统曾设置过密码（密码模式或开放模式保留凭据）时必须验证原密码；
     从未设置过密码的纯开放模式则直接设置新密码即可。 */
  const needOld = vaultHubHasPassword || vaultHubAuthMode !== "open";
  if (needOld && !curPw) { toast("⚠️ 请输入当前密码后再切回密码模式"); return; }
  if (!pw) { toast("⚠️ 请设置新登录密码（至少 8 位，含字母和数字）"); return; }
  const v = validateClientPassword(pw, username);
  if (v) { toast("⚠️ " + v); return; }
  if (pw !== pw2) { toast("⚠️ 两次输入的新密码不一致"); return; }
  try {
    const res = await fetch("/api/account", { method: "POST", headers: sessionWriteHeaders(true), credentials: "same-origin", body: JSON.stringify({ old_password: curPw, username, password: pw, mode: "password" }) });
    const data = await res.json();
    if (!res.ok || !data.ok) { toast("⚠️ " + (data.error || ("HTTP " + res.status))); return; }
    vaultHubAuthMode = "password";
    toast("✅ 已切回密码模式，下次打开页面需要登录");
    loadAccountCredentialsUI();
    if (f.n) f.n.value = ""; if (f.n2) f.n2.value = ""; if (f.u) f.u.value = ""; if (f.c) f.c.value = "";
  } catch (e) { toast("⚠️ 切换失败：" + e.message); }
}

/* ================= v0.9.58 一次性初始随机密码 → 强制改密 ================= */
/* 客户端镜像服务端增强密码校验（至少 8 位、含字母和数字、非弱口令、不含用户名）。
   返回空串表示通过，否则返回中文错误提示。 */
function validateClientPassword(pw, username) {
  if (!pw || pw.length < 8) return "密码至少 8 位";
  if (!/[a-zA-Z]/.test(pw) || !/[0-9]/.test(pw)) return "密码需同时包含字母和数字";
  const weak = ["admin123","admin1234","password","password1","passw0rd","12345678","123456789","1234567890","88888888","00000000","qwerty123","qwertyuiop","abc123456","iloveyou","letmein","welcome1","admin@123","admin888","vaulthub","rootroot"];
  const low = String(pw).toLowerCase();
  if (weak.includes(low)) return "密码过于常见，请更换更复杂的密码";
  if (username && low.includes(String(username).toLowerCase())) return "密码不能包含用户名";
  return "";
}

/* 用一次性初始随机密码登录成功后弹出的强制改密框（不可通过点遮罩关闭）。 */
function showForcedPasswordChange(oldPw) {
  const cur = document.getElementById("forcedCurrentPassword");
  if (cur && oldPw) cur.value = oldPw;
  const err = document.getElementById("forcedPasswordError");
  if (err) err.textContent = "";
  const n = document.getElementById("forcedNewPassword");
  const n2 = document.getElementById("forcedNewPassword2");
  if (n) n.value = ""; if (n2) n2.value = "";
  openModal("forcedPasswordModal");
}

async function submitForcedPasswordChange() {
  const err = document.getElementById("forcedPasswordError");
  const cur = (document.getElementById("forcedCurrentPassword") || {}).value || "";
  const pw = (document.getElementById("forcedNewPassword") || {}).value || "";
  const pw2 = (document.getElementById("forcedNewPassword2") || {}).value || "";
  if (err) err.textContent = "";
  if (!cur) { if (err) err.textContent = "请输入当前（初始随机）密码"; return; }
  const v = validateClientPassword(pw, "");
  if (v) { if (err) err.textContent = v; return; }
  if (pw !== pw2) { if (err) err.textContent = "两次输入的新密码不一致"; return; }
  try {
    const res = await fetch("/api/account", { method: "POST", headers: sessionWriteHeaders(true), credentials: "same-origin", body: JSON.stringify({ old_password: cur, password: pw }) });
    const data = await res.json();
    if (!res.ok || !data.ok) { if (err) err.textContent = data.error || ("HTTP " + res.status); return; }
    vaultHubMustChange = false;
    vaultHubHasPassword = true;
    closeModal("forcedPasswordModal");
    toast("✅ 初始密码已更新，请使用新密码登录");
    if (typeof loadAccountCredentialsUI === "function") loadAccountCredentialsUI();
  } catch (e) { if (err) err.textContent = "改密失败：" + e.message; }
}

/* ================= 系统设置配置页内的标签页（含 Caddy 配置入口） ================= */
let currentSetTab = "library";
function switchSetTab(key) {
  currentSetTab = key;
  document.querySelectorAll(".settab[data-settab]").forEach(el => el.classList.toggle("on", el.dataset.settab === key));
  document.querySelectorAll(".setpanel").forEach(el => el.classList.toggle("on", el.id === "setpanel-" + key));
  if (key === "scrape") { refreshHardwareStatus(); if (typeof loadMediaRuntimeSettings === "function") loadMediaRuntimeSettings(false); }
  if (key === "hardware") { refreshHardwareStatus(); if (typeof loadMediaRuntimeSettings === "function") loadMediaRuntimeSettings(false); }
  /* v0.9.17：账户与登录页同时承载登录状态、Caddy 反向代理入口和关于，
     所以进入该页时既要刷新会话状态，也要把 Caddyfile 读回来更新路由计数。 */
  if (key === "account") { refreshSessionStatus(false); loadCaddyConfig(); loadAccountCredentialsUI(); }
  /* 媒体库标签页：把已添加的库和外连服务都刷新一遍，避免看到上一次的旧列表。 */
  if (key === "library") {
    if (typeof renderLibCustomModuleCount === "function") renderLibCustomModuleCount();
    if (typeof refreshMediaLibraries === "function") refreshMediaLibraries(false);
    if (typeof renderHomeLibTable === "function") renderHomeLibTable();
    if (typeof renderHomeCount === "function") renderHomeCount();
    if (typeof renderExternalServiceList === "function") renderExternalServiceList();
  }
}


/* ================= Tabs ================= */
document.querySelectorAll(".tab[data-tab]").forEach(tab => {
  tab.addEventListener("click", () => {
    const group = tab.dataset.tab.split("-")[0];
    document.querySelectorAll(`.tab[data-tab^="${group}-"]`).forEach(x => x.classList.remove("active"));
    tab.classList.add("active");
    document.querySelectorAll(`.tab-panel`).forEach(p => p.classList.remove("active"));
    document.getElementById(tab.dataset.tab).classList.add("active");
  });
});

/* ================= 媒体服务设置 / 资源页 ================= */
