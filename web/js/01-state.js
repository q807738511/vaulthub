/* VaultHub frontend — split from index.html in phase 4.
   Plain ordered classic scripts (no bundler): global functions remain global
   so the ~131 inline on*= handlers keep working. Load order is fixed by the
   <script> tags in index.html and MUST be preserved. */

const VAULTHUB_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
let vaultHubAuthenticated = false;
let vaultHubIdleTimer = null;
function showVaultHubLogin() { document.getElementById('authMask')?.classList.remove('hidden'); }
function markVaultHubActivity() {
  if (!vaultHubAuthenticated) return;
  clearTimeout(vaultHubIdleTimer);
  vaultHubIdleTimer=setTimeout(async()=>{ vaultHubAuthenticated=false; try { await fetch('/api/logout',{method:'POST',credentials:'same-origin'}); } catch (_) {} showVaultHubLogin(); }, VAULTHUB_IDLE_TIMEOUT_MS);
}
['click','keydown','pointerdown','touchstart','scroll'].forEach(type=>document.addEventListener(type,markVaultHubActivity,{passive:true}));
function handleVaultHubAuthResult(logged) { vaultHubAuthenticated=!!logged; document.getElementById('authMask')?.classList.toggle('hidden',!logged); if(logged) markVaultHubActivity(); else clearTimeout(vaultHubIdleTimer); return !!logged; }

async function vaultHubLogin() {
  const username=document.getElementById('vaultHubUsername').value.trim();
  const password=document.getElementById('vaultHubPassword').value;
  const error=document.getElementById('authError');
  error.textContent='';
  try {
    const res=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password})});
    const data=await res.json();
    if(!res.ok||!data.ok){error.textContent=data.error||'登录失败';return;}
    handleVaultHubAuthResult(true);
    document.getElementById('vaultHubPassword').value='';
  } catch (_) { error.textContent='登录服务不可用'; }
}
async function requireVaultHubLogin() {
  try {
    const res=await fetch('/api/system/runtime',{cache:'no-store'});
    const logged=res.ok;
    return handleVaultHubAuthResult(logged);
  } catch (_) {
    handleVaultHubAuthResult(false);
    return false;
  }
}
async function handleProtectedResponse(res) { if (res.status === 401) { handleVaultHubAuthResult(false); return false; } markVaultHubActivity(); return true; }
function guardProtectedAction(fn) { return async (...args)=>{if(vaultHubAuthenticated || await requireVaultHubLogin()) return fn(...args);}; }

function openCaddyModal() {
  loadCaddyConfig();
  openModal('caddyModal');
}
function caddyApiHeaders() {
  const tok = (document.getElementById('caddyToken')?.value || '').trim();
  return tok ? { 'X-VaultHub-Token': tok } : {};
}
async function loadCaddyConfig() {
  const res = await fetch('/api/admin/caddyfile', { cache: 'no-store' });
  if (!await handleProtectedResponse(res)) return;
  const data = await res.json();
  if (data.ok) document.getElementById('caddyFile').value = data.caddyfile || '';
}
async function saveCaddyConfig() {
  const caddyfile = document.getElementById('caddyFile').value;
  const res = await fetch('/api/admin/caddyfile', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...caddyApiHeaders() },
    body: JSON.stringify({ caddyfile })
  });
  if (!await handleProtectedResponse(res)) return;
  const data = await res.json();
  if (data.ok) toast('✅ Caddy 配置已保存并应用');
  else toast('⚠️ ' + (data.error || '保存失败'));
}
/* ================= i18n ================= */
const I18N = {
  "zh-CN": {
    caddySettings: "Caddy 配置", caddyOrigin: "WebUI 外部域名", caddyAdminToken: "管理令牌", caddyFile: "Caddyfile", caddySave: "保存并应用", caddyReload: "重新载入", caddyHint: "保存后会校验并热加载容器内的 Caddy 配置；失败时会回滚。", superComicTitle: "Komga / Kavita / Calibre-Web · 统一书库", appName: "蜀鼠之家", appSub: "VaultHub · 家庭 NAS 控制台 · 预览版",
    navGroupMain: "主导航", navHome: "首页", navPt: "PT 管理",
    navGroupMedia: "媒体", navComic: "超漫画", navMovie: "影视", navAudio: "音频",
    navGroupSys: "系统", navDocker: "容器管理",
    navGroupCustom: "自定义", addBoardNav: "添加模块",
    settings: "系统设置", about: "关于",
    secNas: "NAS 监控", cpu: "CPU", memory: "内存", network: "网络", diskTemp: "硬盘温度",
    used: "使用率", cores: "核心数", load: "负载", temp: "温度",
    memUsed: "已用", memTotal: "总计", swap: "交换",
    netDownLbl: "↓ 下行", netUpLbl: "↑ 上行",
    secDisk: "硬盘容量",
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
    embyHint: "提示：Emby 回调 MP 时填写 https://mp.enged.top/api/v1/webhook?token=…",
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
    testConnecting: "⏳ 正在验证…"
  },
  "zh-TW": {
    caddySettings: "Caddy 設定", caddyOrigin: "WebUI 外部網域", caddyAdminToken: "管理權杖", caddyFile: "Caddyfile", caddySave: "儲存並套用", caddyReload: "重新載入", caddyHint: "儲存後會驗證並熱載入容器內的 Caddy 設定；失敗時會回滾。", superComicTitle: "Komga / Kavita / Calibre-Web · 統一書庫", appName: "蜀鼠之家", appSub: "VaultHub · 家庭 NAS 控制台 · 預覽版",
    navGroupMain: "主導覽", navHome: "首頁", navPt: "PT 管理",
    navGroupMedia: "媒體", navComic: "超漫畫", navMovie: "影視", navAudio: "音訊",
    navGroupSys: "系統", navDocker: "容器管理",
    navGroupCustom: "自訂", addBoardNav: "新增模組",
    settings: "系統設定", about: "關於",
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
    embyHint: "提示：Emby 回呼 MP 時填寫 https://mp.enged.top/api/v1/webhook?token=…",
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
    testConnecting: "⏳ 正在驗證…"
  },
  "en": {
    caddySettings: "Caddy Config", caddyOrigin: "WebUI public domain", caddyAdminToken: "Admin token", caddyFile: "Caddyfile", caddySave: "Save & apply", caddyReload: "Reload", caddyHint: "Save will validate and hot-reload the container Caddy config; failures roll back.", superComicTitle: "Komga / Kavita / Calibre-Web · Unified Library", appName: "VaultHub", appSub: "VaultHub · Home NAS console · Preview",
    navGroupMain: "Main", navHome: "Home", navPt: "PT Manager",
    navGroupMedia: "Media", navComic: "Super Comics", navMovie: "Movies", navAudio: "Audio",
    navGroupSys: "System", navDocker: "Containers",
    navGroupCustom: "Custom", addBoardNav: "Add Module",
    settings: "Settings", about: "About",
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
    embyHint: "Tip: Emby webhook to MP: https://mp.enged.top/api/v1/webhook?token=…",
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
    testConnecting: "⏳ Verifying…"
  }
};

let curLang = "zh-CN";
const t = k => (I18N[curLang] && I18N[curLang][k]) || I18N["zh-CN"][k] || k;

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
  document.body.classList.toggle("topbar-hidden", willHide);
  const btn = document.querySelector(".chrome-toggle");
  if (btn) {
    btn.title = willHide ? "边栏显示" : "边栏隐藏";
    btn.setAttribute("aria-label", btn.title);
  }
}

/* ================= 状态持久化 ================= */
const LS_SETTINGS = "dwu_settings";
const LS_BOARDS = "dwu_boards";
const LS_BG = "dwu_bgimg";

let settings = {
  theme: "dark",
  hardwareAcceleration: "auto",
  /* 容器版默认经同源 Caddy 代理；外部浏览器无需直连 192.168.x.x */
  mp: { mpUrl: "/api/mp", username: "", password: "", token: "", tokenUser: "" }
};

function preferContainerProxy(url, proxyPath) {
  const raw = String(url || "").trim();
  if (!raw || raw === proxyPath) return proxyPath;
  /* 只迁移本项目历史默认内网地址；用户主动填写的域名或其他地址保持不变 */
  if (/^https?:\/\/192\.168\.112\.3(?::(?:61208|3000))?\/?$/i.test(raw)) return proxyPath;
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
    hiddenModules = saved === null ? ["pt", "docker"] : (JSON.parse(saved) || []);
  } catch (e) { hiddenModules = ["pt", "docker"]; }
  document.body.classList.toggle("module-hidden-pt", hiddenModules.includes("pt"));
  document.body.classList.toggle("module-hidden-docker", hiddenModules.includes("docker"));
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
async function refreshHardwareStatus() {
  const badge = document.getElementById("hardwareStatus");
  if (!badge) return;
  const select = document.getElementById("hardwareAcceleration");
  if (select) select.value = settings.hardwareAcceleration || "auto";
  try {
    const res = await fetch(`/api/media/hardware?hw=${encodeURIComponent(settings.hardwareAcceleration || "auto")}`, { cache: "no-store" });
    const data = await res.json();
    const selected = data.selected || "cpu";
    const available = Object.entries(data.available || {}).filter(([, ok]) => ok).map(([name]) => name).join(" / ");
    badge.textContent = `当前：${selected.toUpperCase()} · 可用：${available || "CPU"}`;
    badge.title = data.vaapi_device || "";
  } catch (e) {
    badge.textContent = "后端检测不可用 · 播放时回退 CPU";
  }
}

/* ================= 导航 ================= */
const titleMap = { home: "navHome", pt: "navPt", comic: "navComic", movie: "navMovie", audio: "navAudio", docker: "navDocker" };

function switchView(v) {
  document.querySelectorAll(".nav-item[data-view]").forEach(n => n.classList.remove("active"));
  const navItem = document.querySelector(`.nav-item[data-view="${v}"]`);
  if (navItem) navItem.classList.add("active");
  document.querySelectorAll(".view").forEach(s => s.classList.remove("active"));
  const view = document.getElementById("view-" + v);
  if (view) view.classList.add("active");
  document.getElementById("pageTitle").textContent = t(titleMap[v] || "navHome");
  const player = document.getElementById("audio-bottom-player");
  if (player) player.classList.toggle("show", v === "audio");
  window.scrollTo(0, 0);
}

document.querySelectorAll(".nav-item[data-view]").forEach(item => {
  item.addEventListener("click", () => {
    const v = item.dataset.view;
    if (v.startsWith("custom-")) { openCustomBoard(v); return; }
    switchView(v);
  });
});

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

/* ================= 内网/反代自动切换 ================= */
function bindSwitches() {
  document.querySelectorAll("[data-switch]").forEach(sw => {
    sw.addEventListener("click", () => {
      sw.classList.toggle("on");
      updateAddr(sw.dataset.switch);
    });
  });
  document.querySelectorAll("[data-lan-input], [data-proxy-input]").forEach(inp => {
    inp.addEventListener("input", () => updateAddr(inp.dataset.lanInput || inp.dataset.proxyInput));
  });
}
function updateAddr(group) {
  const panels = document.querySelectorAll(`#view-comic .tab-panel.active, #view-movie .tab-panel.active, #view-audio .tab-panel.active`);
  panels.forEach(p => {
    const sw = p.querySelector(`[data-switch="${group}"]`);
    const lan = p.querySelector(`[data-lan-input="${group}"]`);
    const proxy = p.querySelector(`[data-proxy-input="${group}"]`);
    const addrEl = p.querySelector(".addr-box .val");
    if (sw && lan && proxy && addrEl) {
      addrEl.textContent = sw.classList.contains("on") ? proxy.value : lan.value;
      const launcher = p.querySelector("[data-media-launch]");
      const host = mediaWideHostForPanel(p);
      if (launcher) launcher.dataset.lastUrl = addrEl.textContent;
      if (launcher && host?.classList.contains("show")) openMediaFrame(launcher.dataset.mediaLaunch, false);
    }
  });
}

/* ================= 媒体服务设置 / 资源页 ================= */
