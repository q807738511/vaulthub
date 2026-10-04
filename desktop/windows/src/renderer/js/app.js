/* ============================================================================
   应用外壳：启动流程（连接 → 登录 → 主界面）、侧栏、路由、全局会话处理
   ========================================================================= */

import * as api from './api.js';
import {
  state, loadConfig, setConfig, applyTheme, themeFromServer, vaultStore,
} from './state.js';
import {
  initQualityLevel, cycleQualityLevel, qualityProfile, qualityChoice,
  qualityStatusText, applyQualityLevel,
} from './quality.js';
import { icon, libIcon, toast, lazyImg, modal } from './ui.js';
import { escapeHtml, fmtBytes, coverUrl, isVideo, cleanTitle, applyEbookFontPref } from './util.js';
import { registerPaths } from './paths.js';
import { LibraryBrowser, renderSearchView } from './views/browse.js';
import { renderSeriesDetail } from './views/series.js';
import { renderAudioLibrary } from './views/audio.js';
import { renderSettings } from './views/settings.js';
import * as player from './views/player.js';
import * as reader from './views/reader.js';
import { stopAudio } from './views/audio.js';

/* ---------------------------------------------------------------- DOM 骨架 */

const root = document.getElementById('root');
let currentBrowser = null;
let searchView = null;

/* ================================================================ 启动 */

async function boot() {
  await loadConfig();
  state.appInfo = await window.vhHost.appInfo();
  applyTheme(state.config.palette || 'emerald', state.config.mode || 'dark');
  // 「画面清晰度」档位与电子书字号（对齐服务端 v0.9.88）
  initQualityLevel();
  applyEbookFontPref();
  paintQualityButton();
  window.vhHost.log(`renderer boot v${state.appInfo.appVersion} electron=${state.appInfo.electron}`);

  api.on('unauthorized', () => {
    if (document.querySelector('.gate')) return;
    // 首次进入时还没有会话，不要说“已过期”，避免误导
    const wasReady = document.getElementById('app')?.classList.contains('ready');
    showLogin(wasReady ? '会话已过期，请重新登录' : '');
  });
  api.on('error', (e) => {
    if (String(e.message).includes('无法连接 VaultHub')) toast(`连接服务端失败：${escapeHtml(e.message)}`, 'err', 6000);
  });

  window.addEventListener('vh:need-relogin', () => showLogin('服务器或会话已变更，请重新登录'));

  if (!state.config.serverBase) return showConnect();

  // 探测服务器
  const t = await window.vhHost.testServer(state.config.serverBase, state.config.allowSelfSigned);
  state.server.online = !!t.ok;
  state.server.health = t.healthz || '';
  if (!t.ok) return showConnect(t.error, t.hint);

  // ⚠ 不能用 /api/media/libraries 判断登录态：实测它「免登录」也返回 200
  // （交接包 docs/03 实测矩阵 + §8.2 明确警告客户端不要依赖这些端点做鉴权判断）。
  // /api/media/settings 需要登录会话：无 Cookie → 401，有 Cookie → 200，用它探测最可靠。
  // 进不去主界面时有三种情况，分开提示，避免把「服务端后端掉线」误报成「地址填错」：
  //   /healthz 通 + /api/media/* 5xx  → media-go 未就绪（Caddy 502），地址是对的
  //   /healthz 通 + 401               → 需要登录
  //   连不上                          → 地址/网络问题
  try {
    await api.settings();
    return enterApp();
  } catch (err) {
    if (err.status === 401) {
      // open 模式（无密码）自动登录
      try {
        const am = await api.authMode();
        if (am && am.has_password === false) {
          await api.login(am.username || 'admin', '');
          return enterApp();
        }
      } catch {
        /* 落到登录页 */
      }
      return showLogin('');
    }
    if (err.status >= 500) {
      return showConnect(
        `服务器已响应，但媒体后端不可用（HTTP ${err.status}）`,
        '这不是地址问题：Caddy 已通，但容器内的 media-go(:9100) 没起来。请检查服务端容器状态后重试。'
      );
    }
    return showConnect(err.message);
  }
}

/* ================================================================ 连接向导 */

function showConnect(errorMsg, hint) {
  document.getElementById('app')?.classList.remove('ready');
  clearGates();
  const gate = document.createElement('div');
  gate.className = 'gate';
  gate.innerHTML = `
    <div class="gate-card">
      <div class="gate-head">
        <div class="gate-logo">V</div>
        <h1>连接 VaultHub</h1>
        <p>填写你的 VaultHub 服务器地址（唯一入口 :8088）</p>
      </div>
      ${errorMsg ? `<div class="alert err">连接失败：${escapeHtml(errorMsg)}${hint ? `<br/>${escapeHtml(hint)}` : ''}</div>` : ''}
      <div class="form-row">
        <label>服务器地址</label>
        <input class="field" data-role="base" placeholder="http://192.168.1.10:8088" value="${escapeHtml(state.config.serverBase || '')}" autofocus />
        <div class="form-hint">生产环境请使用 HTTPS 反代域名，不要在客户端硬编码内网 IP。</div>
      </div>
      <label class="toggle" style="margin-bottom:14px">
        <input type="checkbox" data-role="ss" ${state.config.allowSelfSigned ? 'checked' : ''}/>
        <span>允许自签名证书</span>
      </label>
      <button class="btn primary block" data-role="go">连接</button>
      <div data-role="out" style="margin-top:12px"></div>
    </div>`;
  document.body.appendChild(gate);

  const baseEl = gate.querySelector('[data-role="base"]');
  const ssEl = gate.querySelector('[data-role="ss"]');
  const out = gate.querySelector('[data-role="out"]');

  const connect = async () => {
    const base = baseEl.value.trim().replace(/\/+$/, '');
    if (!base) return toast('请填写服务器地址', 'err');
    out.innerHTML = `<div class="alert info"><span class="spinner" style="display:inline-block;vertical-align:-3px"></span> 正在连接 ${escapeHtml(base)} …</div>`;
    const r = await window.vhHost.testServer(base, ssEl.checked);
    if (!r.ok) {
      out.innerHTML = `<div class="alert err">${escapeHtml(r.error || '连接失败')}${r.hint ? `<br/>${escapeHtml(r.hint)}` : ''}</div>`;
      return;
    }
    await setConfig({ serverBase: base, allowSelfSigned: ssEl.checked });
    state.server.online = true;
    state.server.health = r.healthz || '';
    window.vhHost.log(`connect ok base=${base} healthz=${r.healthz}`);
    out.innerHTML = `<div class="alert ok">已连接：/healthz → ${escapeHtml(String(r.healthz || 'ok'))}</div>`;
    setTimeout(() => {
      clearGates();
      showLogin();
    }, 500);
  };

  gate.querySelector('[data-role="go"]').addEventListener('click', connect);
  baseEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') connect();
  });
  baseEl.focus();
}

/* ================================================================ 登录 */

function showLogin(message) {
  document.getElementById('app')?.classList.remove('ready');
  clearGates();
  const gate = document.createElement('div');
  gate.className = 'gate';
  gate.innerHTML = `
    <div class="gate-card">
      <div class="gate-head">
        <div class="gate-logo">V</div>
        <h1>登录 VaultHub</h1>
        <p>${escapeHtml(state.config.serverBase || '')}</p>
      </div>
      ${message ? `<div class="alert warn">${escapeHtml(message)}</div>` : ''}
      <div data-role="err"></div>
      <div class="form-row">
        <label>用户名</label>
        <input class="field" data-role="u" value="admin" autocomplete="username" />
      </div>
      <div class="form-row">
        <label>密码</label>
        <input class="field" data-role="p" type="password" autocomplete="current-password" />
      </div>
      <button class="btn primary block" data-role="go">登录</button>
      <div style="display:flex;gap:8px;margin-top:10px">
        <button class="btn ghost sm" data-role="back">${icon('back', 13)} 更换服务器</button>
      </div>
    </div>`;
  document.body.appendChild(gate);

  const u = gate.querySelector('[data-role="u"]');
  const p = gate.querySelector('[data-role="p"]');
  const err = gate.querySelector('[data-role="err"]');

  api
    .authMode()
    .then((am) => {
      if (am && am.username) u.value = am.username;
      if (am && am.has_password === false) {
        err.innerHTML = `<div class="alert info">服务端处于 open 模式（无密码），可直接登录。</div>`;
      }
    })
    .catch(() => {});

  const doLogin = async () => {
    err.innerHTML = '';
    const btn = gate.querySelector('[data-role="go"]');
    btn.disabled = true;
    btn.textContent = '登录中…';
    try {
      await api.login(u.value.trim(), p.value);
      window.vhHost.log(`login ok user=${u.value.trim()}`);
      clearGates();
      await enterApp();
    } catch (e) {
      err.innerHTML = `<div class="alert err">${escapeHtml(e.message)}</div>`;
      btn.disabled = false;
      btn.textContent = '登录';
    }
  };

  gate.querySelector('[data-role="go"]').addEventListener('click', doLogin);
  gate.querySelector('[data-role="back"]').addEventListener('click', () => {
    clearGates();
    showConnect();
  });
  [u, p].forEach((el) =>
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') doLogin();
    })
  );
  p.focus();
}

function clearGates() {
  document.querySelectorAll('.gate').forEach((g) => g.remove());
}

/* ================================================================ 主界面 */

async function enterApp() {
  clearGates();
  const app = document.getElementById('app');
  app.classList.add('ready');
  if (state.config.sidebarRail) app.classList.add('rail');

  // 库列表
  const libRes = await api.libraries();
  state.libraries = libRes.libraries || [];
  buildSidebar();

  // 服务端设置（主题）
  try {
    const st = await api.settings();
    const t = themeFromServer(st.theme, state.config.palette);
    if (t && !state.config.themePinned) applyTheme(t.palette, t.mode);
    state.server.version = st.version || '';
  } catch {
    /* settings 不可用时保持本地主题 */
  }

  window.vhHost.log(`enter app libraries=${state.libraries.length}`);
  go('home');
}

function buildSidebar() {
  const nav = document.getElementById('nav');
  const groups = [
    ['video', '影视', ['movie', 'series']],
    ['read', '阅读', ['comic', 'book']],
    ['listen', '音乐', ['audio']],
    ['other', '其它', ['custom', 'other']],
  ];
  const byType = (t) => state.libraries.filter((l) => l.type === t);
  const known = new Set(['movie', 'series', 'comic', 'book', 'audio']);

  let html = `
    <div class="nav-group">
      <button class="nav-item" data-nav="home"><span class="nav-ico">${icon('home', 17)}</span><span class="nav-text">首页</span></button>
      <button class="nav-item" data-nav="search"><span class="nav-ico">${icon('search', 17)}</span><span class="nav-text">搜索</span></button>
    </div>`;

  for (const [key, label, types] of groups) {
    const libs = types.flatMap(byType).concat(key === 'other' ? state.libraries.filter((l) => !known.has(l.type)) : []);
    if (!libs.length) continue;
    html += `<div class="nav-group"><div class="nav-label">${label}</div>`;
    for (const lib of libs) {
      html += `<button class="nav-item" data-lib="${escapeHtml(lib.id)}" title="${escapeHtml(lib.name)} · ${escapeHtml(lib.path || '')}">
        <span class="nav-ico">${libIcon(lib.type)}</span>
        <span class="nav-text">${escapeHtml(lib.name)}</span>
      </button>`;
    }
    html += `</div>`;
  }

  html += `<div class="nav-group"><div class="nav-label">系统</div>
    <button class="nav-item" data-nav="settings"><span class="nav-ico">${icon('settings', 17)}</span><span class="nav-text">设置</span></button>
  </div>`;
  nav.innerHTML = html;

  nav.querySelectorAll('[data-nav]').forEach((b) =>
    b.addEventListener('click', () => go(b.dataset.nav))
  );
  nav.querySelectorAll('[data-lib]').forEach((b) =>
    b.addEventListener('click', () => go('library', { libId: b.dataset.lib }))
  );

  // 服务器状态与版本
  const chip = document.getElementById('serverChip');
  chip.innerHTML = `<span class="dot ${state.server.online ? 'ok' : 'err'}"></span>
    <span class="txt">${escapeHtml(shortHost(state.config.serverBase))}</span>`;
  document.getElementById('footVer').textContent = `v${state.appInfo.appVersion} · 契约 v0.9.83`;
}

function shortHost(base) {
  try {
    const u = new URL(base);
    return u.host;
  } catch {
    return base || '未配置';
  }
}

/* ================================================================ 路由 */

async function go(view, params = {}) {
  state.view = view;
  if (player.isOpen()) player.close();
  if (reader.isOpen()) reader.close();
  currentBrowser?.destroy();
  currentBrowser = null;

  const content = document.getElementById('content');
  document.querySelectorAll('.nav-item').forEach((n) => n.classList.remove('active'));
  const title = document.getElementById('topTitle');
  const crumb = document.getElementById('topCrumb');

  if (view !== 'settings' && view !== 'search') document.querySelector('.content')?.classList.remove('with-abar');

  if (view === 'home') {
    document.querySelector('[data-nav="home"]')?.classList.add('active');
    title.textContent = '首页';
    crumb.textContent = `${state.libraries.length} 个媒体库`;
    await renderHome(content);
    return;
  }

  if (view === 'search') {
    document.querySelector('[data-nav="search"]')?.classList.add('active');
    title.textContent = '搜索';
    crumb.textContent = '';
    content.innerHTML = '';
    searchView = renderSearchView(content, {
      onOpenItem: (lib, item) => openItem(lib, item, null),
    });
    searchView.setLibraries(state.libraries);
    return;
  }

  if (view === 'settings') {
    document.querySelector('[data-nav="settings"]')?.classList.add('active');
    title.textContent = '设置';
    crumb.textContent = shortHost(state.config.serverBase);
    content.innerHTML = '';
    await renderSettings(content, {
      applyTheme: (p, m) => applyTheme(p, m),
    });
    return;
  }

  if (view === 'library') {
    const lib = state.libraries.find((l) => l.id === params.libId);
    if (!lib) return go('home');
    state.currentLib = lib;
    await setConfig({ lastLibrary: lib.id });
    document.querySelector(`[data-lib="${lib.id}"]`)?.classList.add('active');
    title.textContent = lib.name;
    crumb.textContent = `${typeLabel(lib.type)} · ${lib.path || ''}`;
    content.innerHTML = '';

    if (lib.type === 'audio') {
      // 音频库：先取一页文件构建条目与分组，再交给音频视图
      const mount = document.createElement('div');
      content.appendChild(mount);
      mount.innerHTML = `<div class="empty"><span class="spinner"></span><div class="e-title">正在加载音乐库…</div></div>`;
      try {
        const all = [];
        let offset = 0;
        for (let i = 0; i < 12; i += 1) {
          // limit 上限 500（>500 会被服务端回落到 100）
          const res = await api.files({ id: lib.id, offset, limit: 500 });
          const entries = res.files || [];
          offset += entries.length;
          registerPaths(lib.id, entries.map((e) => e.path));
          all.push(...entries);
          if (!res.has_more || !entries.length || all.filter((e) => /\.(mp3|flac|m4a|aac|wav|ogg|opus|ape|wma|dsf|dff)$/i.test(e.path)).length >= 500) break;
        }
        const { extractItems } = await import('./util.js');
        const { imageIndex, extra } = extractItems('audio', all);
        await renderAudioLibrary(mount, { lib, imageIndex, extra });
      } catch (e) {
        mount.innerHTML = `<div class="empty">${icon('warn', 42)}<div class="e-title">音乐库加载失败</div><div class="e-hint">${escapeHtml(e.message)}</div></div>`;
      }
      return;
    }

    const mount = document.createElement('div');
    content.appendChild(mount);
    currentBrowser = new LibraryBrowser({
      lib,
      mount,
      onOpen: (item, browser) => openItem(lib, item, browser),
    });
    await currentBrowser.init();
    return;
  }

  return go('home');
}

function typeLabel(t) {
  return { movie: '电影', series: '剧集', comic: '漫画', book: '电子书', audio: '音乐' }[t] || t || '媒体库';
}

/* ================================================================ 打开条目 */

async function openItem(lib, item, browser) {
  const imageIndex = browser?.imageIndex || null;
  if (lib.type === 'comic' || item.kind === 'comic') return reader.open(lib, item);
  if (lib.type === 'book' || item.kind === 'book') return reader.open(lib, item);
  if (lib.type === 'series' && item.show) {
    // 剧集：先进详情页
    const content = document.getElementById('content');
    document.getElementById('topTitle').textContent = item.title;
    document.getElementById('topCrumb').textContent = `${lib.name} · 剧集详情`;
    content.innerHTML = '';
    const mount = document.createElement('div');
    content.appendChild(mount);
    return renderSeriesDetail(mount, {
      lib,
      item,
      imageIndex,
      onPlay: (l, it) => player.open(l, it),
    });
  }
  if (item.kind === 'track' || lib.type === 'audio') {
    const { playTrack } = await import('./views/audio.js');
    return playTrack(lib, item, [item], imageIndex);
  }
  // 电影/其它视频
  return player.open(lib, item);
}

/* ================================================================ 首页 */

async function renderHome(content) {
  content.innerHTML = `<div class="pad">
    <div class="sec">
      <div class="sec-head"><h2>媒体库</h2><span class="sub" data-role="idx"></span></div>
      <div class="lib-grid" data-role="libs"></div>
    </div>
    <div class="sec" data-role="continue-sec" style="display:none">
      <div class="sec-head"><h2>继续观看</h2><span class="sub">本机记录（服务端暂无续播端点）</span></div>
      <div class="grid-posters compact" data-role="continue"></div>
    </div>
    <div class="sec">
      <div class="sec-head"><h2>服务器</h2></div>
      <div class="kv" data-role="srv"></div>
    </div>
  </div>`;

  // 库卡片
  const grid = content.querySelector('[data-role="libs"]');
  for (const lib of state.libraries) {
    const card = document.createElement('button');
    card.className = 'lib-card';
    card.innerHTML = `
      <div class="lc-top">
        <span class="lc-ico">${libIcon(lib.type)}</span>
        <span class="badge">${escapeHtml(lib.type)}</span>
      </div>
      <div class="lc-name">${escapeHtml(lib.name)}</div>
      <div class="lc-meta" data-role="meta">点击进入</div>
      <div class="lc-path">${escapeHtml(lib.path || '')}</div>`;
    card.addEventListener('click', () => go('library', { libId: lib.id }));
    grid.appendChild(card);

    // 异步补条目数
    api
      .files({ id: lib.id, offset: 0, limit: 1 })
      .then((r) => {
        const m = card.querySelector('[data-role="meta"]');
        if (m) m.textContent = `${(r.total || 0).toLocaleString()} 个文件`;
      })
      .catch(() => {});
  }

  // 索引状态
  api
    .indexStatus()
    .then((s) => {
      const el = content.querySelector('[data-role="idx"]');
      if (el) el.textContent = s.running ? '索引重建中…' : '索引就绪';
    })
    .catch(() => {});

  // 服务器信息
  const srv = content.querySelector('[data-role="srv"]');
  if (srv) {
    srv.innerHTML = `
      <div class="k">地址</div><div class="v">${escapeHtml(state.config.serverBase)}</div>
      <div class="k">/healthz</div><div class="v">${escapeHtml(state.server.health || 'ok')}</div>
      <div class="k">网关</div><div class="v">127.0.0.1:${state.appInfo.gatewayPort ?? '-'}</div>
      <div class="k">客户端</div><div class="v">v${escapeHtml(String(state.appInfo.appVersion))} · Electron ${escapeHtml(String(state.appInfo.electron))}</div>`;
  }

  // 继续观看（本机）
  const { listResume } = await import('./state.js');
  const resumes = listResume().slice(0, 12);
  if (resumes.length) {
    const sec = content.querySelector('[data-role="continue-sec"]');
    const box = content.querySelector('[data-role="continue"]');
    sec.style.display = '';
    for (const r of resumes) {
      const lib = state.libraries.find((l) => l.id === r.libId);
      if (!lib) continue;
      const card = document.createElement('button');
      card.className = 'card';
      const pct = r.duration_ms ? Math.min(100, (r.position_ms / r.duration_ms) * 100) : 0;
      card.innerHTML = `
        <div class="thumb" style="position:relative">
          <div class="ph">${icon('film', 30)}</div>
          <div class="tagline" style="opacity:1"><span>${Math.round(pct)}%</span><span>▶</span></div>
        </div>
        <div class="title">${escapeHtml(cleanTitle(r.path))}</div>
        <div class="sub">${escapeHtml(lib.name)}</div>`;
      card.addEventListener('click', () => player.open(lib, { path: r.path, title: cleanTitle(r.path) }));
      box.appendChild(card);
    }
  }
}

/* ================================================================ 顶栏交互 */

/* 画面清晰度按钮：显示当前档位，点击循环切换（自动 → 原画 → 高清 → 流畅 → 极省） */
function paintQualityButton() {
  const btn = document.getElementById('btnQuality');
  if (!btn) return;
  const choice = qualityChoice();
  btn.title = `画面清晰度：${qualityStatusText()}（点击切换）`;
  btn.classList.toggle('on', choice !== 'auto' && choice !== 'original');
  btn.dataset.q = choice;
}

function wireTopbar() {
  const search = document.getElementById('topSearch');
  const run = (() => {
    let t = 0;
    return (q) => {
      clearTimeout(t);
      t = setTimeout(() => {
        if (!q.trim()) return;
        go('search');
        setTimeout(() => searchView?.setQuery(q), 60);
      }, 320);
    };
  })();
  search.addEventListener('input', () => run(search.value));
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') run(search.value);
    if (e.key === 'Escape') {
      search.value = '';
      search.blur();
    }
  });

  document.getElementById('btnQuality').addEventListener('click', () => {
    const next = cycleQualityLevel();
    const p = qualityProfile();
    paintQualityButton();
    toast(
      `画面清晰度：${next === 'auto' ? `自动（当前 ${p.label}）` : p.label} · ${p.sub}`,
      'info',
      2600
    );
    // 换档后按新档立即重渲染当前视图（图片按新宽度重取、颜色立即恢复）
    if (state.view === 'library' && state.currentLib) go('library', { libId: state.currentLib.id });
    else go(state.view === 'settings' ? 'settings' : 'home');
  });

  document.getElementById('btnTheme').addEventListener('click', async () => {
    const next = state.theme.mode === 'dark' ? 'light' : 'dark';
    applyTheme(state.theme.palette, next);
    await setConfig({ mode: next, themePinned: true });
  });

  document.getElementById('btnSettings').addEventListener('click', () => go('settings'));

  document.getElementById('btnRail').addEventListener('click', async () => {
    const app = document.getElementById('app');
    const rail = app.classList.toggle('rail');
    await setConfig({ sidebarRail: rail });
  });

  document.getElementById('btnBack').addEventListener('click', () => go('home'));

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      search.focus();
      search.select();
    }
  });

  window.addEventListener('vh:closed-player', () => {
    if (state.currentLib) go('library', { libId: state.currentLib.id });
  });
}

/* ================================================================ 启动 */

// 自动化验收用的入口钩子（端到端自检需要按已知可播放的文件直接驱动播放器）
window.__vhOpenItem = openItem;
window.__vhGo = go;

wireTopbar();
boot().catch((e) => {
  document.body.innerHTML = `<div class="gate"><div class="gate-card">
    <h1>启动失败</h1><pre style="white-space:pre-wrap;font-size:12px">${escapeHtml(e.stack || e.message)}</pre></div></div>`;
});
