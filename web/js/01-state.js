/* VaultHub frontend — split from index.html in phase 4.
   Plain ordered classic scripts (no bundler): global functions remain global
   so the ~131 inline on*= handlers keep working. Load order is fixed by the
   <script> tags in index.html and MUST be preserved. */

const VAULTHUB_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
/* 脚本自带版本号，必须与 index.html 里的 window.VAULTHUB_ASSET_VERSION 相同。
   历史故障：v0.8.3→v0.8.5 的前端修改在服务端已生效，但浏览器仍执行缓存里的
   旧 02-media.js，用户看到「没有更新」。现在入口页 no-store、静态资源带 ?v=，
   并在启动时做一次一致性自查，不一致就绕过缓存强制重载一次。 */
const VAULTHUB_SCRIPT_VERSION = "0.9.53";
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
function markVaultHubActivity() {
  if (!vaultHubAuthenticated) return;
  clearTimeout(vaultHubIdleTimer);
  vaultHubIdleTimer=setTimeout(async()=>{ vaultHubAuthenticated=false; try { await fetch('/api/logout',{method:'POST',credentials:'same-origin'}); } catch (_) {} showVaultHubLogin(); }, VAULTHUB_IDLE_TIMEOUT_MS);
}
['click','keydown','pointerdown','touchstart','scroll'].forEach(type=>document.addEventListener(type,markVaultHubActivity,{passive:true}));
/* 已登录时给遮罩加上 .hidden（CSS 里 .auth-mask.hidden{display:none}），
   未登录时移除，遮住页面要求登录。 */
function handleVaultHubAuthResult(logged) { vaultHubAuthenticated=!!logged; document.getElementById('authMask')?.classList.toggle('hidden',!!logged); if(logged) markVaultHubActivity(); else clearTimeout(vaultHubIdleTimer); return !!logged; }

async function vaultHubLogin() {
  const username=document.getElementById('vaultHubUsername').value.trim();
  const password=document.getElementById('vaultHubPassword').value;
  const error=document.getElementById('authError');
  error.textContent='';
  try {
    const res=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password})});
    const data=await res.json();
    if(!res.ok||!data.ok){error.textContent=data.error||'登录失败';return;}
    vaultHubAuthEpoch++;
    handleVaultHubAuthResult(true);
    renderSessionStatus(true, t('sessionOkHint'));
    document.getElementById('vaultHubPassword').value='';
  } catch (_) { error.textContent='登录服务不可用'; }
}
async function requireVaultHubLogin() {
  const epoch = vaultHubAuthEpoch;
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
async function handleProtectedResponse(res) { if (res.status === 401) { handleVaultHubAuthResult(false); renderSessionStatus(false); return false; } markVaultHubActivity(); renderSessionStatus(true); return true; }
function guardProtectedAction(fn) { return async (...args)=>{if(vaultHubAuthenticated || await requireVaultHubLogin()) return fn(...args);}; }

/* ---------- 退出登录 ---------- */
/* 主动退出：先让服务端销毁 Session，再复位前端状态并显示登录遮罩。
   本地界面偏好（主题/语言/侧栏宽度）保留，不做清理。 */
async function logoutVaultHub() {
  vaultHubAuthEpoch++;
  try { await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' }); } catch (_) {}
  clearTimeout(vaultHubIdleTimer);
  vaultHubAuthenticated = false;
  renderSessionStatus(false);
  closeCaddyPage();
  closeModal('avatarModal');
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

    setModuleSub: "侧栏不再放「添加模块」按钮，模块的显隐与自定义网页在这里管理", setModuleOpen: "打开模块设置",

    /* ---- v0.7.0：媒体库优先导航、账户菜单、头像、构建进度 ---- */
    navGroupLibrary: "媒体库", navManage: "管理 ›",
    accountMenu: "账户与设置", avatarSettings: "头像设置",
    avatarLead: "头像仅保存在本浏览器 localStorage，不上传服务器。可用文字缩写、emoji 或上传图片。",
    avatarPreview: "预览效果", avatarText: "显示文字（1-2 个字符或 emoji）", avatarColor: "背景色",
    avatarUpload: "上传头像图片（可选）", avatarReset: "恢复默认", avatarSaved: "头像已保存",
    avatarTooLarge: "图片过大，无法保存到 localStorage", avatarResetDone: "头像已恢复默认",
    setLibrary: "媒体库", setLibExisting: "已添加的媒体库",
    setLibExistingHint: "侧边栏只展示这里创建时填写的库名称。每个库都可以单独重新扫描、打开或删除。",
    setLibAdd: "媒体库增加",
    setLibAddHint: "先选来源：本地媒体库使用容器内已挂载的绝对路径；外连服务接入 Emby / Navidrome / Komga 等现成服务器。",
    libSrcLocal: "本地媒体库", libSrcExternal: "外连服务",
    libPathHint: "路径必须是容器内已挂载且存在的绝对目录；库名称会直接作为侧边栏与刮削标识。",
    extLibName: "服务名称", extLibLan: "内网地址", extLibProxy: "反代 / 外网域名（可选）",
    extLibAdd: "添加外连服务", extLibList: "已添加的外连服务",
    extLibHint: "内网访问自动走内网地址，外网访问自动走反代域名；添加后会在侧边栏媒体库中出现。",
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
    settings: "系统设置", about: "关于", settingsLead: "系统设置现在是独立配置页（不再是弹窗）：媒体库、外观主题、刮削与硬件都在这里；账户与登录页内含登录状态、关于和 Caddy 反向代理入口。",
    navMediaSearch: "媒体搜索", searchTitle: "媒体搜索", searchIdle: "输入关键词搜索媒体库",
    searchPlaceholder: "搜索媒体库中的影视、书籍、音乐文件名", searchRun: "搜索", searchClear: "清空",
    searchRunning: "正在搜索媒体库…", searchNoLibrary: "还没有已添加的媒体库，请先在系统设置中添加。",
    searchEmpty: "没有找到与「{q}」匹配的媒体文件。", searchHits: "命中 {n} 个文件",
    setAboutHint: "应用版本、技术栈和监控组件说明。", setAboutOpen: "查看关于信息",
    settingsPageBadge: "独立配置页", settingsClose: "返回上一页",
    /* ---- v0.9.51：视频播放器悬浮控制栏 ---- */
    vpCollapse: "最小化整个播放器",
    vpExpand: "还原播放器",
    vpPreparing: "正在准备播放…",
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
    vpDetails: "打开详情页",
    vpDiag: "复制播放诊断",
    vpDiagOk: "播放诊断已复制",
    vpDiagFail: "剪贴板不可用，信息已在「获取信息」面板中",
    vpRepeat: "重复播放",
    vpRepeatOff: "不重复",
    vpRepeatOne: "单集循环",
    vpRepeatAll: "列表循环",
    vpShuffle: "随机播放",
    vpShuffleOn: "随机播放已开启",
    vpShuffleOff: "随机播放已关闭",
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
    setLook: "外观主题", setScrape: "刮削与硬件", caddyRoutes: "反向代理服务域名",
    setAccount: "账户与登录", setAccountTitle: "当前登录状态", sessionChecking: "正在检查登录状态…", sessionRefresh: "刷新状态",
    sessionHint: "会话在最后一次操作后 30 分钟空闲自动失效；增删媒体库等写操作需要有效登录。",
    setLogoutTitle: "退出登录", setLogout: "退出登录", setLogoutHint: "退出后会立即失效服务端会话并返回登录页，本机保存的界面偏好不会被清除。",
    caddyOpenPage: "打开 Caddy 配置页面", caddyPageHint: "Caddyfile 内容较长，单独占用一整页编辑，避免在弹窗里挤成一团。",
    caddyPageTitle: "Caddy 反向代理配置", caddyPageClose: "关闭",
    caddyRoutesHint: "维护服务域名与内网上游地址的映射，保存后由内置 Caddy 校验并热加载，失败会自动回滚。",
    setSidebar: "侧栏", setSidebarMem: "侧栏宽度记忆", setSidebarMemSub: "拖拽侧栏右边缘调整宽度，自动写入本浏览器", setSidebarReset: "恢复默认宽度",
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
    secNow: "正在进行中的操作", nowEmpty: "当前没有正在播放的视频或音乐",
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
    themeLbl: "主题", themeDark: "晚上（暗色）", themeLight: "白天（亮色）", themeCustom: "自定义（上传背景图片）",
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
    setLibExistingHint: "側邊欄只顯示這裡建立時填寫的庫名稱。每個庫都可以單獨重新掃描、開啟或刪除。",
    setLibAdd: "媒體庫新增",
    setLibAddHint: "先選來源：本地媒體庫使用容器內已掛載的絕對路徑；外連服務接入 Emby / Navidrome / Komga 等現成伺服器。",
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
    setAccount: "帳戶與登入", setAccountTitle: "目前登入狀態", sessionChecking: "正在檢查登入狀態…", sessionRefresh: "重新檢查",
    sessionHint: "工作階段在最後一次操作後 30 分鐘閒置自動失效；新增或刪除媒體庫等寫入操作需要有效登入。",
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
    themeLbl: "主題", themeDark: "晚上（暗色）", themeLight: "白天（亮色）", themeCustom: "自訂（上傳背景圖片）",
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
    settingsLead: "系統設定現在是獨立設定頁（不再是彈窗）：媒體庫、外觀主題、刮削與硬體都在這裡；帳戶與登入頁內含登入狀態、關於與 Caddy 反向代理入口。",
    navMediaSearch: "媒體搜尋", searchTitle: "媒體搜尋", searchIdle: "輸入關鍵字搜尋媒體庫",
    searchPlaceholder: "搜尋媒體庫中的影視、書籍、音樂檔名", searchRun: "搜尋", searchClear: "清空",
    searchRunning: "正在搜尋媒體庫…", searchNoLibrary: "還沒有已新增的媒體庫，請先在系統設定中新增。",
    searchEmpty: "找不到與「{q}」相符的媒體檔案。", searchHits: "命中 {n} 個檔案",
    setAboutHint: "應用版本、技術棧與監控元件說明。", setAboutOpen: "查看關於資訊",
    settingsPageBadge: "獨立設定頁", settingsClose: "返回上一頁",
    /* ---- v0.9.51：视频播放器悬浮控制栏 ---- */
    vpCollapse: "最小化整個播放器",
    vpExpand: "還原播放器",
    vpPreparing: "正在準備播放…",
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
    vpDetails: "開啟詳情頁",
    vpDiag: "複製播放診斷",
    vpDiagOk: "播放診斷已複製",
    vpDiagFail: "剪貼簿不可用，資訊已在「取得資訊」面板中",
    vpRepeat: "重複播放",
    vpRepeatOff: "不重複",
    vpRepeatOne: "單集循環",
    vpRepeatAll: "列表循環",
    vpShuffle: "隨機播放",
    vpShuffleOn: "隨機播放已開啟",
    vpShuffleOff: "隨機播放已關閉",
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
    setLook: "外觀主題", setScrape: "刮削與硬體",
    caddyRoutes: "反向代理服務網域",
    caddyRoutesHint: "維護服務網域與內網上游位址的對應，儲存後由內建 Caddy 校驗並熱載入，失敗會自動回滾。",
    setSidebar: "側欄", setSidebarMem: "側欄寬度記憶",
    setSidebarMemSub: "拖曳側欄右邊緣調整寬度，自動寫入本瀏覽器",
    setSidebarReset: "恢復預設寬度",
    setScrapeSrc: "刮削來源",
    setScrapeHint: "媒體庫按大類使用不同刮削源：電子書刊用 Google Books / Bangumi，影視作品用 TMDB / 豆瓣，音視作品用 MusicBrainz / 網易雲。",
    setHw: "顯卡加速", setHwLbl: "視訊相容流硬體加速", setHwDetect: "偵測顯卡",
    setHwHint: "需要在 Docker Compose 中透傳 /dev/dri 或設定 NVIDIA Container Toolkit。硬體不可用時會自動回退 CPU，不影響播放。",
    secServer: "伺服器監控",
    cpuUsage: "CPU 使用率", memUsage: "記憶體使用率", netSpeed: "網路速度", diskUsage: "硬碟使用率",
    avgTemp: " °C 均溫", diskFree: "容量剩餘",
    secNow: "正在進行中的操作", nowEmpty: "目前沒有正在播放的影片或音樂",
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

    setModuleSub: "The sidebar no longer has an Add Module button; module visibility and custom pages live here", setModuleOpen: "Open module settings",

    navGroupLibrary: "Libraries", navManage: "Manage ›",
    accountMenu: "Account & settings", avatarSettings: "Avatar settings",
    avatarLead: "The avatar is stored in this browser's localStorage only, never uploaded. Use initials, an emoji or an image.",
    avatarPreview: "Preview", avatarText: "Display text (1-2 characters or emoji)", avatarColor: "Background colour",
    avatarUpload: "Upload avatar image (optional)", avatarReset: "Reset to default", avatarSaved: "Avatar saved",
    avatarTooLarge: "Image too large for localStorage", avatarResetDone: "Avatar reset to default",
    setLibrary: "Libraries", setLibExisting: "Existing libraries",
    setLibExistingHint: "The sidebar shows only the library names you enter here. Each library can be rescanned, opened or removed.",
    setLibAdd: "Add a library",
    setLibAddHint: "Pick a source: local libraries use absolute paths mounted inside the container; external services connect to Emby / Navidrome / Komga and friends.",
    libSrcLocal: "Local library", libSrcExternal: "External service",
    libPathHint: "The path must be an absolute directory mounted inside the container; the library name is used in the sidebar and for scraping.",
    extLibName: "Service name", extLibLan: "LAN address", extLibProxy: "Reverse-proxy / public domain (optional)",
    extLibAdd: "Add external service", extLibList: "Existing external services",
    extLibHint: "LAN visitors use the LAN address, external visitors use the proxy domain. Added services show up in the sidebar libraries.",
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
    setAccount: "Account & Sign-in", setAccountTitle: "Current session", sessionChecking: "Checking session…", sessionRefresh: "Refresh",
    sessionHint: "Sessions expire after 30 minutes of inactivity; adding or removing libraries requires a valid sign-in.",
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
    themeLbl: "Theme", themeDark: "Night (dark)", themeLight: "Day (light)", themeCustom: "Custom (upload background)",
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
    settingsLead: "Settings is now a dedicated page (no longer a modal): libraries, appearance and scraping/hardware live here; Account & Sign-in holds the session state, About and the Caddy reverse-proxy entry.",
    navMediaSearch: "Media search", searchTitle: "Media search", searchIdle: "Type a keyword to search your libraries",
    searchPlaceholder: "Search movie, book and music file names in your libraries", searchRun: "Search", searchClear: "Clear",
    searchRunning: "Searching libraries…", searchNoLibrary: "No library added yet — add one in system settings first.",
    searchEmpty: "No media file matches \"{q}\".", searchHits: "{n} files matched",
    setAboutHint: "App version, tech stack and monitoring components.", setAboutOpen: "Open About",
    settingsPageBadge: "Dedicated page", settingsClose: "Back",
    /* ---- v0.9.51：视频播放器悬浮控制栏 ---- */
    vpCollapse: "Minimize player",
    vpExpand: "Restore player",
    vpPreparing: "Preparing playback…",
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
    vpDetails: "Open details page",
    vpDiag: "Copy playback diagnostics",
    vpDiagOk: "Playback diagnostics copied",
    vpDiagFail: "Clipboard unavailable; see the Playback info panel",
    vpRepeat: "Repeat",
    vpRepeatOff: "No repeat",
    vpRepeatOne: "Repeat one",
    vpRepeatAll: "Repeat all",
    vpShuffle: "Shuffle",
    vpShuffleOn: "Shuffle on",
    vpShuffleOff: "Shuffle off",
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
    setLook: "Appearance", setScrape: "Scraping & hardware",
    caddyRoutes: "Reverse proxy hostnames",
    caddyRoutesHint: "Maintain hostname to LAN upstream mappings. Saving validates and hot-reloads the built-in Caddy; failures roll back automatically.",
    setSidebar: "Sidebar", setSidebarMem: "Sidebar width memory",
    setSidebarMemSub: "Drag the sidebar's right edge to resize; the width is stored in this browser",
    setSidebarReset: "Reset to default width",
    setScrapeSrc: "Scraping sources",
    setScrapeHint: "Each category uses its own scrapers: Books & Comics via Google Books / Bangumi, Movies & TV via TMDB / Douban, Music & MV via MusicBrainz / NetEase.",
    setHw: "GPU acceleration", setHwLbl: "Hardware acceleration for compat streams", setHwDetect: "Detect GPU",
    setHwHint: "Requires passing /dev/dri through Docker Compose or configuring the NVIDIA Container Toolkit. Falls back to CPU automatically when unavailable, playback still works.",
    secServer: "Server monitoring",
    cpuUsage: "CPU usage", memUsage: "Memory usage", netSpeed: "Network speed", diskUsage: "Disk usage",
    avgTemp: " °C average", diskFree: "Free space",
    secNow: "Operations in progress", nowEmpty: "No video or music is playing right now",
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
function toggleBars() {
  const willHide = !document.body.classList.contains("sidebar-hidden");
  document.body.classList.toggle("sidebar-hidden", willHide);
  const btn = document.getElementById("sidebarCollapseButton");
  if (btn) {
    btn.textContent = willHide ? "⇥" : "⇤";
    btn.title = willHide ? "展开侧栏" : "折叠侧栏";
    btn.setAttribute("aria-label", btn.title);
  }
  try { localStorage.setItem("vaulthub_sidebar_rail", willHide ? "1" : "0"); } catch (e) {}
}
function loadSidebarRail() {
  let rail = false;
  try { rail = localStorage.getItem("vaulthub_sidebar_rail") === "1"; } catch (e) {}
  document.body.classList.toggle("sidebar-hidden", rail);
  const btn = document.getElementById("sidebarCollapseButton");
  if (btn) btn.textContent = rail ? "⇥" : "⇤";
}


/* ================= 状态持久化 ================= */
const LS_SETTINGS = "dwu_settings";
const LS_BOARDS = "dwu_boards";
const LS_BG = "dwu_bgimg";

let settings = {
  theme: "dark",
  hardwareAcceleration: "auto",
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
    if (["auto","cpu","vaapi","qsv","cuda"].includes(s.hardwareAcceleration)) settings.hardwareAcceleration = s.hardwareAcceleration;
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

/* ================= 主题 ================= */
function setTheme(th) {
  settings.theme = th;
  saveSettings();
  document.body.dataset.theme = (th === "light") ? "light" : "dark";
  document.body.classList.toggle("custom-bg", th === "custom");
  document.getElementById("customBgWrap").style.display = th === "custom" ? "block" : "none";
  document.querySelectorAll(".theme-opt").forEach(el => el.classList.toggle("on", el.dataset.themeOpt === th));
  document.querySelectorAll(".media-reader-overlay").forEach(el => {
    el.classList.remove("reader-theme-dark", "reader-theme-light", "reader-theme-custom");
    el.classList.add(readerThemeClass());
  });
  if (th === "custom") applyBgImage();
}
function applyBgImage() {
  const img = localStorage.getItem(LS_BG);
  if (img) document.body.style.setProperty("--bgImg", `url(${img})`);
  else document.body.style.removeProperty("--bgImg");
}
function uploadBg(input) {
  const f = input.files && input.files[0];
  if (!f) return;
  const reader = new FileReader();
  reader.onload = e => {
    try {
      localStorage.setItem(LS_BG, e.target.result);
      applyBgImage();
      toast("✅ " + (curLang === "en" ? "Background saved" : "背景已保存"));
    } catch (err) {
      toast("⚠️ " + (curLang === "en" ? "Image too large for localStorage" : "图片过大，无法保存到 localStorage"));
    }
  };
  reader.readAsDataURL(f);
}
function clearBg() {
  localStorage.removeItem(LS_BG);
  applyBgImage();
  toast("🗑 " + (curLang === "en" ? "Background cleared" : "背景已清除"));
}

function saveHardwareAcceleration() {
  const value = document.getElementById("hardwareAcceleration")?.value;
  settings.hardwareAcceleration = ["auto","cpu","vaapi","qsv","cuda"].includes(value) ? value : "auto";
  saveSettings();
  refreshHardwareStatus();
  toast("✅ 显卡加速设置已保存");
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
  } catch (e) {
    badge.textContent = t("hwBadgeFail");
    badge.className = "badge red";
    if (detail) detail.textContent = tf("hwProbeError", { error: e.message });
    if (notify) toast("⚠️ " + tf("hwProbeError", { error: e.message }));
  }
}

/* ================= 导航 =================
   v0.7.0：顶栏不再有「首页 / 资料库」按钮，侧边栏也不再重复展示三个资源大类。
   媒体视图由侧边栏的媒体库条目驱动，大类只在系统设置的媒体库配置里出现。
   （v0.9.16 删掉了 titleMap：顶栏标题去掉后它已无任何引用点。） */

function switchView(v, libId) {
  const items = [...document.querySelectorAll(".nav-item[data-view]")];
  items.forEach(n => n.classList.remove("active"));
  /* 漫画与电子书同属 data-view="comic"，音乐与 MV 同属 "audio"。
     旧写法 querySelector('.nav-item[data-view="comic"]') 永远命中排在前面的那一个，
     于是点「电子书」后侧栏高亮仍停在「漫画」，看起来像是又跳回了漫画。
     侧栏条目现在带唯一的 data-nav-key，这里按它精确匹配；
     直接比较 dataset 而不是拼接选择器，媒体库名或 id 含引号时也不会选歪。

     未显式传 libId 时（首页「更多 ›」、侧栏事件委托等旧调用点）回落到该视图
     当前选中的媒体库，避免高亮与页面内容对不上。
     选中态还要记到 window 上：侧栏每 5 秒整体重绘一次，只把 active 打在 DOM
     节点上会在重绘后丢失，表现为「点完 5 秒后侧栏什么都不亮」。 */
  let navKey = "";
  if (libId) {
    navKey = v + ":" + libId;
  } else if (typeof localMediaSelection !== "undefined" && localMediaSelection[v]) {
    navKey = v + ":" + localMediaSelection[v];
  }
  window.vaultHubActiveNavKey = navKey;
  const navItem = (navKey && items.find(n => n.dataset.navKey === navKey))
    || items.find(n => n.dataset.view === v && !n.dataset.libId)
    || items.find(n => n.dataset.view === v);
  if (navItem) navItem.classList.add("active");
  document.querySelectorAll(".view").forEach(s => s.classList.remove("active"));
  const view = document.getElementById("view-" + v);
  if (view) view.classList.add("active");
  /* v0.9.30：系统设置是独立配置页，侧栏底部的设置按钮要跟着高亮，
     否则进入设置后侧栏没有任何选中态，用户不知道自己在哪一页。 */
  document.getElementById("sidebarSettingsButton")?.classList.toggle("active", v === "settings");
  /* 音乐播放器只在音视作品视图显示，出现方式为屏幕居中浮层。 */
  const player = document.getElementById("audio-bottom-player");
  if (player) player.classList.toggle("show", v === "audio" && typeof audioHasActivePlayback === "function" && audioHasActivePlayback());
  window.scrollTo(0, 0);
}

/* 侧边栏媒体库条目是 JS 注入的，用事件委托绑定，避免注入后丢事件。 */
document.addEventListener("click", event => {
  const item = event.target.closest("#mainNav .nav-item[data-view]");
  if (!item || event.target.closest(".nav-tools, .del")) return;
  const v = item.dataset.view;
  if (!v) return;
  if (v.startsWith("custom-")) { openCustomBoard(v); return; }
  if (item.dataset.libId) return; /* 媒体库条目自己有 onclick */
  switchView(v);
});

/* ---------- 账户与登录：v0.9.17 起登录状态 / 关于 / 退出登录都在
   系统设置 → 账户与登录 里，顶栏 logo 不再是菜单按钮 ---------- */
let movieDetailSidebarWasHidden = null;
function enterMovieDetailSidebarMode() {
  if (movieDetailSidebarWasHidden === null) movieDetailSidebarWasHidden = document.body.classList.contains("sidebar-hidden");
  document.body.classList.add("sidebar-hidden");
}
function leaveMovieDetailSidebarMode() {
  if (movieDetailSidebarWasHidden === null) return;
  document.body.classList.toggle("sidebar-hidden", movieDetailSidebarWasHidden);
  movieDetailSidebarWasHidden = null;
}
function openSettingsModalFromSidebar() { openSettingsPage(); }
/* 打开系统设置并直接跳到账户与登录页（登录状态 / Caddy / 关于 / 退出登录）。 */
function openAccountSettings() { openSettingsPage("account"); }
/* v0.9.30：系统设置改为独立配置页 #view-settings。
   settingsReturnView 记住进入设置前所在的视图，关闭时回到那里而不是硬跳首页。 */
let settingsReturnView = "home";
function openSettingsPage(tab) {
  const current = document.querySelector(".view.active");
  if (current && current.id !== "view-settings") settingsReturnView = current.id.replace(/^view-/, "");
  switchView("settings");
  switchSetTab(tab || currentSetTab || "library");
}
function closeSettingsPage() {
  const back = settingsReturnView && document.getElementById("view-" + settingsReturnView) ? settingsReturnView : "home";
  switchView(back);
}
function settingsPageOpen() { return !!document.getElementById("view-settings")?.classList.contains("active"); }

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

/* ================= 侧栏宽度：拖拽自适应 + 记忆 ================= */
const LS_SIDEBAR_W = "vaulthub_sidebar_w";
const SIDEBAR_DEFAULT_W = 236;
const SIDEBAR_MIN_W = 62;
const SIDEBAR_MAX_W = 340;
function applySidebarWidth(px) {
  const w = Math.min(SIDEBAR_MAX_W, Math.max(SIDEBAR_MIN_W, Number(px) || SIDEBAR_DEFAULT_W));
  document.documentElement.style.setProperty("--sidebar-w", w + "px");
  return w;
}
function loadSidebarWidth() {
  try {
    const saved = localStorage.getItem(LS_SIDEBAR_W);
    if (saved) applySidebarWidth(saved);
  } catch (e) {}
}
function resetSidebarWidth() {
  applySidebarWidth(SIDEBAR_DEFAULT_W);
  try { localStorage.removeItem(LS_SIDEBAR_W); } catch (e) {}
  document.body.classList.remove("sidebar-hidden");
  toast("✅ 侧栏宽度已恢复默认");
}
function initSidebarResizer() {
  const bar = document.getElementById("sidebarResizer");
  const side = document.getElementById("sidebar");
  if (!bar || !side) return;
  let dragging = false;
  const move = e => {
    if (!dragging) return;
    const x = e.touches ? e.touches[0].clientX : e.clientX;
    applySidebarWidth(x);
  };
  const stop = () => {
    if (!dragging) return;
    dragging = false;
    side.classList.remove("dragging");
    const w = parseInt(getComputedStyle(document.documentElement).getPropertyValue("--sidebar-w"), 10);
    try { localStorage.setItem(LS_SIDEBAR_W, String(w)); } catch (e) {}
  };
  const start = e => { dragging = true; side.classList.add("dragging"); e.preventDefault(); };
  bar.addEventListener("mousedown", start);
  bar.addEventListener("touchstart", start, { passive: false });
  window.addEventListener("mousemove", move);
  window.addEventListener("touchmove", move, { passive: true });
  window.addEventListener("mouseup", stop);
  window.addEventListener("touchend", stop);
}

/* ================= 系统设置配置页内的标签页（含 Caddy 配置入口） ================= */
let currentSetTab = "library";
function switchSetTab(key) {
  currentSetTab = key;
  document.querySelectorAll(".settab[data-settab]").forEach(el => el.classList.toggle("on", el.dataset.settab === key));
  document.querySelectorAll(".setpanel").forEach(el => el.classList.toggle("on", el.id === "setpanel-" + key));
  if (key === "scrape") { refreshHardwareStatus(); if (typeof loadMediaRuntimeSettings === "function") loadMediaRuntimeSettings(false); }
  /* v0.9.17：账户与登录页同时承载登录状态、Caddy 反向代理入口和关于，
     所以进入该页时既要刷新会话状态，也要把 Caddyfile 读回来更新路由计数。 */
  if (key === "account") { refreshSessionStatus(false); loadCaddyConfig(); }
  /* 媒体库标签页：把已添加的库和外连服务都刷新一遍，避免看到上一次的旧列表。 */
  if (key === "library") {
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
