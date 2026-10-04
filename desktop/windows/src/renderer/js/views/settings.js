/* ============================================================================
   设置：连接、外观、播放、阅读、账号、数据与关于
   ========================================================================= */

import * as api from '../api.js';
import { fmtBytes, fmtTime, escapeHtml, mapLimit } from '../util.js';
import { state, setConfig, vaultStore, vaultStore as vs, getFavorites, getPlaylists } from '../state.js';
import { icon, toast, modal, confirmDialog } from '../ui.js';

const PALETTES = [
  { id: 'emerald', name: '青瓷', dark: '#0B1413', light: '#F7F8FA', accent: '#2BC4B4' },
  { id: 'plum', name: '午夜紫调', dark: '#0F0D16', light: '#F7F5FF', accent: '#8B5CF6' },
  { id: 'neon', name: '霓虹胶片', dark: '#0B0B0F', light: '#F5F5F8', accent: '#FF4D6D' },
  { id: 'clay', name: '暖陶', dark: '#17130F', light: '#FAF6F1', accent: '#E08A4E' },
];

let tab = 'conn';

export async function renderSettings(mount, ctx) {
  mount.innerHTML = `<div class="pad"><div class="set-grid">
    <div class="set-nav">
      ${[
        ['conn', '连接与服务器', 'settings'],
        ['theme', '外观主题', 'sun'],
        ['quality', '画面清晰度', 'palette'],
        ['play', '播放', 'play'],
        ['read', '阅读', 'book'],
        ['scrape', '刮削与缓存', 'search'],
        ['account', '账号', 'user'],
        ['data', '本地数据', 'folder'],
        ['about', '关于', 'info'],
      ]
        .map(([id, label, ic]) => `<button class="tab" data-tab="${id}">${icon(ic, 15)} ${label}</button>`)
        .join('')}
    </div>
    <div class="set-panel" data-role="panel"></div>
  </div></div>`;

  mount.querySelectorAll('[data-tab]').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === tab);
    b.addEventListener('click', () => {
      tab = b.dataset.tab;
      mount.querySelectorAll('[data-tab]').forEach((x) => x.classList.toggle('active', x.dataset.tab === tab));
      paint(mount, ctx);
    });
  });
  await paint(mount, ctx);
}

async function paint(mount, ctx) {
  const panel = mount.querySelector('[data-role="panel"]');
  panel.innerHTML = `<div class="empty"><span class="spinner"></span></div>`;
  const cfg = state.config;
  const info = state.appInfo;

  if (tab === 'conn') {
    const status = await window.vhHost.sessionStatus();
    panel.innerHTML = `
      <div class="set-sec">
        <h3>服务器</h3>
        <div class="desc">客户端只通过这一个入口访问服务端；内部服务（manager:9099 / media-go:9100 / subtitle-api:9120）不在容器外暴露，客户端不会直连。</div>
        <div class="form-row">
          <label>VaultHub 地址</label>
          <input class="field" data-role="base" value="${escapeHtml(cfg.serverBase || '')}" placeholder="http://192.168.1.10:8088 或 https://你的反代域名" />
          <div class="form-hint">只填到端口或域名，不要带 /api 路径。生产环境建议使用 HTTPS 反代域名。</div>
        </div>
        <label class="toggle" style="margin-bottom:12px">
          <input type="checkbox" data-role="selfsigned" ${cfg.allowSelfSigned ? 'checked' : ''}/>
          <span>允许自签名证书（内网 HTTPS 且证书未受信任时勾选）</span>
        </label>
        <div style="display:flex;gap:8px">
          <button class="btn" data-role="test">${icon('refresh', 14)} 测试连通性</button>
          <button class="btn primary" data-role="save">保存并重连</button>
          <button class="btn danger" data-role="logout">${icon('close', 14)} 退出登录</button>
        </div>
        <div data-role="testout" style="margin-top:12px"></div>
      </div>
      <div class="set-sec">
        <h3>当前会话</h3>
        <div class="kv">
          <div class="k">会话 Cookie</div><div class="v">${status.hasCookie ? 'vh_session 已持有（由宿主进程保存，渲染层不可见）' : '未登录'}</div>
          <div class="k">网关端口</div><div class="v">127.0.0.1:${info.gatewayPort ?? '-'}</div>
          <div class="k">服务端索引</div><div class="v" data-role="idx">读取中…</div>
        </div>
      </div>`;

    const out = panel.querySelector('[data-role="testout"]');
    panel.querySelector('[data-role="test"]').addEventListener('click', async () => {
      const base = panel.querySelector('[data-role="base"]').value.trim();
      const ss = panel.querySelector('[data-role="selfsigned"]').checked;
      out.innerHTML = `<div class="alert info"><span class="spinner" style="display:inline-block;vertical-align:-3px"></span> 正在探测 ${escapeHtml(base)}/healthz …</div>`;
      const r = await window.vhHost.testServer(base, ss);
      if (r.ok) {
        out.innerHTML = `<div class="alert ok">连通成功：<b>/healthz → ${escapeHtml(String(r.healthz || 'ok'))}</b><br/>
          /api/auth/mode → has_password=${r.mode?.has_password} · mode=${escapeHtml(String(r.mode?.mode))} · username=${escapeHtml(String(r.mode?.username))}</div>`;
      } else {
        out.innerHTML = `<div class="alert err">连接失败：${escapeHtml(r.error || '未知错误')}${r.hint ? `<br/>${escapeHtml(r.hint)}` : ''}</div>`;
      }
    });

    panel.querySelector('[data-role="save"]').addEventListener('click', async () => {
      const base = panel.querySelector('[data-role="base"]').value.trim().replace(/\/+$/, '');
      const allowSelfSigned = panel.querySelector('[data-role="selfsigned"]').checked;
      if (!base) return toast('请填写服务器地址', 'err');
      await setConfig({ serverBase: base, allowSelfSigned });
      await window.vhHost.clearSession();
      toast('已保存服务器地址，会话已重置，请重新登录', 'ok');
      window.dispatchEvent(new CustomEvent('vh:need-relogin'));
    });

    panel.querySelector('[data-role="logout"]').addEventListener('click', async () => {
      const ok = await confirmDialog('退出登录', '将清除本机保存的 vh_session 会话，下次需要重新输入账号密码。', '退出登录');
      if (!ok) return;
      await api.logout().catch(() => {});
      await window.vhHost.clearSession();
      window.dispatchEvent(new CustomEvent('vh:need-relogin'));
    });

    // 索引状态
    api
      .indexStatus()
      .then((s) => {
        const rows = (s.libraries || [])
          .map((l) => `${escapeHtml(l.name)}（${escapeHtml(l.lib)}）: ${escapeHtml(l.state)} ${l.percent != null ? l.percent + '%' : ''} · ${l.scanned}/${l.total}`)
          .join('<br/>');
        const el = panel.querySelector('[data-role="idx"]');
        if (el) el.innerHTML = `${s.running ? '<span class="badge warn">重建中</span>' : '<span class="badge ok">就绪</span>'}<br/>${rows}`;
      })
      .catch((e) => {
        const el = panel.querySelector('[data-role="idx"]');
        if (el) el.textContent = `读取失败：${e.message}`;
      });
  }

  if (tab === 'theme') {
    panel.innerHTML = `
      <div class="set-sec">
        <h3>调色板</h3>
        <div class="desc">同一套调色板三端观感一致（令牌取自服务端 v0.9.88 的 main.css）。服务端 <code>GET /api/media/settings</code> 的 theme 会决定默认明暗。</div>
        <div class="palette-row">
          ${PALETTES.map(
            (p) => `<button class="pal-swatch ${state.theme.palette === p.id ? 'on' : ''}" data-pal="${p.id}"
              title="${p.name}"
              style="background:linear-gradient(135deg,${p.dark} 0 50%,${p.light} 50% 100%);color:${p.accent}">A</button>`
          ).join('')}
        </div>
      </div>
      <div class="set-sec">
        <h3>明暗</h3>
        <div style="display:flex;gap:8px">
          <button class="btn ${state.theme.mode === 'dark' ? 'primary' : ''}" data-mode="dark">${icon('moon', 14)} 暗色</button>
          <button class="btn ${state.theme.mode === 'light' ? 'primary' : ''}" data-mode="light">${icon('sun', 14)} 亮色</button>
        </div>
        <div class="form-hint">服务端 theme = custom 时保留本地选择。</div>
      </div>`;
    panel.querySelectorAll('[data-pal]').forEach((b) =>
      b.addEventListener('click', async () => {
        await setConfig({ palette: b.dataset.pal });
        ctx.applyTheme(b.dataset.pal, state.theme.mode);
        paint(mount, ctx);
      })
    );
    panel.querySelectorAll('[data-mode]').forEach((b) =>
      b.addEventListener('click', async () => {
        await setConfig({ mode: b.dataset.mode });
        ctx.applyTheme(state.theme.palette, b.dataset.mode);
        paint(mount, ctx);
      })
    );
  }

  if (tab === 'quality') {
    const { QUALITY_PROFILE, QUALITY_ORDER, qualityChoice, qualityEffectiveId, qualityStatusText, setQualityLevel, weakNetworkActive } =
      await import('../quality.js');
    const cur = qualityChoice();
    const eff = qualityEffectiveId();
    panel.innerHTML = `
      <div class="set-sec">
        <h3>画面清晰度</h3>
        <div class="desc">
          与服务端 Web 端 v0.9.88 完全同一套档位：档位越高画面越清晰、色彩越完整；最低档是「无色彩（灰度）」+ 最低清晰度。
          颜色由档位显式决定，<b>任何档位都能随时切回</b>（只改 CSS 变量与取图宽度，不写任何一次性状态）。
        </div>
        <div class="list">
          ${QUALITY_ORDER.map((id) => {
            const p = id === 'auto' ? null : QUALITY_PROFILE[id];
            const label = id === 'auto' ? `自动（当前 ${QUALITY_PROFILE[eff].label}）` : p.label;
            const sub = id === 'auto'
              ? `弱网判定：${weakNetworkActive() ? '已判定为弱网 → 高清' : '未判定弱网 → 原画'}`
              : p.sub;
            return `<button class="row ${cur === id ? 'active' : ''}" data-q="${id}">
              <span class="r-idx">${cur === id ? '●' : '○'}</span>
              <span class="r-main"><span class="r-title">${escapeHtml(label)}</span>
              <span class="r-sub">${escapeHtml(sub)}</span></span>
              ${p ? `<span class="r-right">封面 ${p.coverW}px</span>` : ''}
            </button>`;
          }).join('')}
        </div>
        <div class="form-hint">当前状态：${escapeHtml(qualityStatusText())}</div>
      </div>
      <div class="set-sec">
        <h3>档位对照</h3>
        <div class="kv">
          <div class="k">阅读页转码宽度</div><div class="v">原画 0（原图）· 高清 1600 · 流畅 1200 · 极省 900</div>
          <div class="k">封面/海报宽度</div><div class="v">原画/高清 320 · 流畅 200 · 极省 140</div>
          <div class="k">视频档位</div><div class="v">原画/高清 auto（服务端按网络决定）· 流畅 720p · 极省 480p</div>
          <div class="k">音频码率</div><div class="v">流畅 128 kbps · 极省 96 kbps（自动档交回测速）</div>
          <div class="k">色彩</div><div class="v">原画/高清 100% · 流畅 70% · 极省 灰度</div>
        </div>
      </div>`;
    panel.querySelectorAll('[data-q]').forEach((b) =>
      b.addEventListener('click', () => {
        const id = b.dataset.q;
        setQualityLevel(id);
        const p = QUALITY_PROFILE[qualityEffectiveId()];
        toast(`画面清晰度：${id === 'auto' ? `自动（当前 ${p.label}）` : p.label} · ${p.sub}`, 'info', 2400);
        paint(mount, ctx);
      })
    );
  }

  if (tab === 'scrape') {
    panel.innerHTML = `<div class="empty"><span class="spinner"></span><div class="e-title">正在读取服务端刮削配置…</div></div>`;
    let c = null;
    try {
      c = await api.settings();
    } catch (e) {
      panel.innerHTML = `<div class="alert err">读取刮削配置失败：${escapeHtml(e.message)}</div>`;
      return;
    }
    const pct = Math.round((Number(c.scrape_min_match) || 0.7) * 100);
    const localCast = vaultStore.get('vh_cast_scraper_plugin', 'metashark');
    panel.innerHTML = `
      <div class="set-sec">
        <h3>刮削来源</h3>
        <div class="desc">
          参数与服务端 Web 端「系统设置 → 刮削配置」一一对应，保存走 <code>PUT /api/media/settings</code>（不是 POST），
          保存后<b>服务端立即生效</b>，三端共用同一份配置。
        </div>
        <div class="alert info">
          密钥类字段（TMDB / TVDB API Key）只显示是否已设置，<b>留空即保留服务端已有值</b>，桌面端不会把密钥落盘。
        </div>
        <div class="form-row">
          <label>刮削地区（TMDB 语言）</label>
          <select class="field" data-role="scrapeRegion">
            ${[['auto', '跟随界面语言'], ['cn', '中国（中文简体 · zh-CN）'], ['jp', '日本（日文 · ja-JP）'], ['us', '美国（英文 · en-US）']]
              .map(([v, l]) => `<option value="${v}" ${String(c.scrape_region) === v ? 'selected' : ''}>${l}</option>`)
              .join('')}
          </select>
          <div class="form-hint">刮削与详情页的 TMDB 请求按该地区语言查询。</div>
        </div>
        <div class="form-row">
          <label>标题匹配阈值（最低识别字符占比）</label>
          <input class="field" type="number" min="30" max="100" step="5" value="${pct}" data-role="scrapeMinMatch"/>
          <div class="form-hint">默认 70%；服务端以 0–1 存储，此处按百分比填写（30–100）。</div>
        </div>
        <div class="form-row">
          <label>刮削方式</label>
          <select class="field" data-role="mediaScraperMode">
            ${[
              ['auto', '自动：电视剧 TVDB → TMDB → 豆瓣 → 文件名'],
              ['tmdb', '仅 TMDB（失败回文件名）'],
              ['douban', '仅豆瓣（失败回文件名）'],
              ['filename', '仅使用文件名'],
            ]
              .map(([v, l]) => `<option value="${v}" ${String(c.scraper_mode) === v ? 'selected' : ''}>${l}</option>`)
              .join('')}
          </select>
        </div>
        <div class="form-row">
          <label>TMDB API Key</label>
          <input class="field" type="password" autocomplete="new-password" data-role="tmdbApiKey"
                 placeholder="${c.tmdb_api_key_masked ? '已设置；留空保留' : '未设置'}"/>
        </div>
        <div class="form-row">
          <label>TMDB API 调用链接</label>
          <input class="field" type="url" value="${escapeHtml(String(c.tmdb_api_base || 'https://api.themoviedb.org/3'))}" data-role="tmdbApiBase"/>
        </div>
        <div class="form-row">
          <label>TMDB 图片调用链接</label>
          <input class="field" type="url" value="${escapeHtml(String(c.tmdb_image_base || 'https://image.tmdb.org/t/p'))}" data-role="tmdbImageBase"/>
        </div>
        <div class="form-row">
          <label>TVDB API Key（电视剧辅助刮削）</label>
          <input class="field" type="password" autocomplete="new-password" data-role="tvdbApiKey"
                 placeholder="${c.tvdb_api_key_masked ? '已设置；留空保留' : '未设置'}"/>
        </div>
        <div class="form-row">
          <label>TVDB API 调用链接</label>
          <input class="field" type="url" value="${escapeHtml(String(c.tvdb_api_base || 'https://api4.thetvdb.com/v4'))}" data-role="tvdbApiBase"/>
        </div>
        <div class="form-row">
          <label>代理访问（HTTP/HTTPS）</label>
          <input class="field" data-role="scraperProxy" data-configured="${c.scraper_proxy_configured ? '1' : '0'}"
                 placeholder="${c.scraper_proxy_configured ? `已配置 ${escapeHtml(String(c.scraper_proxy_display || '代理'))}；留空保留` : '例：http://192.0.2.10:7890'}"/>
          <div class="form-hint">服务端的私网保护会拒绝直连私网目标；本地联调刮削需通过代理走。</div>
        </div>
        <div class="form-row">
          <label>演职人员头像刮削插件</label>
          <select class="field" data-role="castScraperPlugin">
            ${[
              ['metashark', 'Metashark（豆瓣/TMDB 适配 + 头像下载，默认）'],
              ['plex', 'Plex NFO Agent（XBMCnfo 导入 + thumb 头像）'],
              ['tmdb', 'TMDB profile 直连'],
              ['off', '关闭演职人员头像刮削'],
            ]
              .map(([v, l]) => `<option value="${v}" ${localCast === v ? 'selected' : ''}>${l}</option>`)
              .join('')}
          </select>
          <div class="form-hint">该项是 Web 端保存在浏览器本地的插件选择（<code>vaulthub_cast_scraper_plugin</code>），服务端无对应字段，因此这里也只存本机。</div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn primary" data-role="save">保存刮削配置（服务端立即生效）</button>
          <button class="btn" data-role="reload">重新载入</button>
          <button class="btn" data-role="speed">网络测速（TMDB/TVDB 等白名单）</button>
        </div>
        <div data-role="out" style="margin-top:12px"></div>
      </div>

      <div class="set-sec">
        <h3>缓存与扫描</h3>
        <div class="form-row">
          <label>转码缓存目录</label>
          <input class="field" value="${escapeHtml(String(c.cache_dir || '/data/transcode-cache'))}" data-role="cache_dir"/>
        </div>
        <div class="form-row">
          <label>缓存上限（字节）</label>
          <input class="field" type="number" value="${Number(c.cache_max_bytes) || 0}" data-role="cache_max_bytes"/>
        </div>
        <div class="form-row">
          <label>缓存最长保留（小时）</label>
          <input class="field" type="number" value="${Number(c.cache_max_age_hours) || 0}" data-role="cache_max_age_hours"/>
        </div>
        <div class="form-row">
          <label>缓存清理间隔（小时）</label>
          <input class="field" type="number" value="${Number(c.cache_cleanup_interval_hours) || 0}" data-role="cache_cleanup_interval_hours"/>
        </div>
        <div class="form-row">
          <label>页面缓存上限（字节）</label>
          <input class="field" type="number" value="${Number(c.page_cache_max_bytes) || 0}" data-role="page_cache_max_bytes"/>
        </div>
        <div class="form-row">
          <label>扫描最大深度（0 = 不限）</label>
          <input class="field" type="number" value="${Number(c.scan_max_depth) || 0}" data-role="scan_max_depth"/>
        </div>
        <div class="form-row">
          <label>对外分享地址（留空则不启用）</label>
          <input class="field" value="${escapeHtml(String(c.share_public_base || ''))}" data-role="share_public_base"/>
        </div>
      </div>`;

    const out = panel.querySelector('[data-role="out"]');
    const val = (r) => panel.querySelector(`[data-role="${r}"]`)?.value?.trim() ?? '';

    panel.querySelector('[data-role="reload"]').addEventListener('click', () => paint(mount, ctx));

    panel.querySelector('[data-role="speed"]').addEventListener('click', async () => {
      out.innerHTML = `<div class="alert info"><span class="spinner" style="display:inline-block;vertical-align:-3px"></span> 测速中…</div>`;
      try {
        const d = await api.networkSpeed();
        const ok = (d.results || []).filter((x) => x.ok).length;
        out.innerHTML = `<div class="alert ${ok ? 'ok' : 'warn'}">${d.proxy_enabled ? '经代理' : '直连'} · ${ok}/${(d.results || []).length} 可达<br/>
          ${(d.results || []).map((x) => `${escapeHtml(String(x.host))}：${x.ok ? `${x.latency_ms} ms · HTTP ${x.status_code}` : escapeHtml(String(x.error || '失败'))}`).join('<br/>')}</div>`;
      } catch (e) {
        out.innerHTML = `<div class="alert err">测速失败：${escapeHtml(e.message)}</div>`;
      }
    });

    panel.querySelector('[data-role="save"]').addEventListener('click', async () => {
      const proxyEl = panel.querySelector('[data-role="scraperProxy"]');
      const proxyValue = val('scraperProxy');
      const payload = {
        scraper_mode: val('mediaScraperMode') || 'auto',
        scrape_region: val('scrapeRegion') || 'auto',
        // 服务端以 0–1 存储，UI 按百分比显示（30–100，默认 70）
        scrape_min_match: Math.max(30, Math.min(100, Number(val('scrapeMinMatch')) || 70)) / 100,
        tmdb_api_key: val('tmdbApiKey'),
        tmdb_api_base: val('tmdbApiBase'),
        tmdb_image_base: val('tmdbImageBase'),
        tvdb_api_key: val('tvdbApiKey'),
        tvdb_api_base: val('tvdbApiBase'),
        scraper_proxy: proxyValue,
        scraper_proxy_set: !!proxyValue || proxyEl?.dataset.configured !== '1',
        share_public_base: val('share_public_base'),
        share_public_base_set: true,
        cache_dir: val('cache_dir'),
        cache_max_bytes: Number(val('cache_max_bytes')) || 0,
        cache_max_age_hours: Number(val('cache_max_age_hours')) || 0,
        cache_cleanup_interval_hours: Number(val('cache_cleanup_interval_hours')) || 0,
        page_cache_max_bytes: Number(val('page_cache_max_bytes')) || 0,
        scan_max_depth: Number(val('scan_max_depth')) || 0,
      };
      // 客户端本地项：头像刮削插件（服务端无此字段）
      vaultStore.set('vh_cast_scraper_plugin', val('castScraperPlugin') || 'metashark');

      out.innerHTML = `<div class="alert info">保存中…</div>`;
      try {
        await api.settingsPut(payload);
        await api.settings().catch(() => {});
        out.innerHTML = `<div class="alert ok">运行配置已保存并在服务端立即生效。</div>`;
        toast('刮削配置已保存', 'ok');
      } catch (e) {
        out.innerHTML = `<div class="alert err">保存失败：${escapeHtml(e.message)}</div>`;
      }
    });
  }

  if (tab === 'play') {
    panel.innerHTML = `
      <div class="set-sec">
        <h3>播放计划</h3>
        <div class="desc">开播前会调用 <code>POST /api/media/playback/plan</code>（20s 超时），并把本机真实解码能力上报给服务端，由服务端决定直出 / Remux / 仅音频转码 / 完整转码。</div>
        <div class="alert info">
          <b>画质档位由「画面清晰度」统一决定</b>（对齐 v0.9.88）：
          原画/高清 → <code>quality=auto</code>（服务端按网络自行判断）；
          流畅 → <code>720p</code>；极省 → <code>480p</code>。
          请到「画面清晰度」页调整，不再单独设置。
        </div>
        <div class="kv" data-role="qnow"></div>
        <div class="form-row">
          <label>硬件加速</label>
          <select class="field" data-role="hardware">
            ${['auto', 'on', 'off'].map((q) => `<option value="${q}" ${cfg.hardware === q ? 'selected' : ''}>${q}</option>`).join('')}
          </select>
          <div class="form-hint">服务端实测硬件为 cuda 时，转码会走 GPU。</div>
        </div>
        <div class="kv" data-role="caps"></div>
      </div>
      <div class="set-sec">
        <h3>音频</h3>
        <div class="form-row">
          <label>音频流码率（<code>/api/media/audio/stream</code> 的 bitrate 为必填参数）</label>
          <select class="field" data-role="bitrate">
            ${[96, 128, 192, 256, 320].map((b) => `<option value="${b}" ${Number(cfg.audioBitrate) === b ? 'selected' : ''}>${b} kbps</option>`).join('')}
          </select>
        </div>
      </div>`;
    const caps = (await import('../util.js')).detectClientCapabilities();
    panel.querySelector('[data-role="caps"]').innerHTML =
      `<div class="k">上报能力</div><div class="v">${Object.entries(caps).filter(([, v]) => v).map(([k]) => k).join(', ')}</div>`;
    {
      const { qualityVideoPreset, qualityStatusText } = await import('../quality.js');
      panel.querySelector('[data-role="qnow"]').innerHTML =
        `<div class="k">当前档位</div><div class="v">${escapeHtml(qualityStatusText())}</div>
         <div class="k">上报 quality</div><div class="v">${escapeHtml(qualityVideoPreset())}</div>`;
    }
    panel.querySelector('[data-role="hardware"]').addEventListener('change', (e) => setConfig({ hardware: e.target.value }));
    panel.querySelector('[data-role="bitrate"]').addEventListener('change', (e) => setConfig({ audioBitrate: Number(e.target.value) }));
  }

  if (tab === 'read') {
    const { loadEbookFontPref, saveEbookFontPref, EBOOK_FONT_MIN, EBOOK_FONT_MAX } = await import('../util.js');
    const { getComicPrefs, setComicPrefs, COMIC_PREFETCH_AHEAD } = await import('../state.js');
    const pref = loadEbookFontPref();
    const cp = getComicPrefs();
    const sizes = [];
    for (let n = EBOOK_FONT_MIN; n <= EBOOK_FONT_MAX; n += 1) sizes.push(n);
    panel.innerHTML = `
      <div class="set-sec">
        <h3>电子书</h3>
        <div class="desc">字号范围与斜体开关对齐服务端 Web 端 v0.9.88（12–32px，<code>--ebook-font-size</code> / <code>--ebook-font-style</code>）。
          TXT 会按与 Web 端<b>同一套正则</b>切分章节（第X章/卷/回/节/部/集/篇、Chapter N、「1. 标题」），支持目录跳转。</div>
        <div class="form-row">
          <label>正文字号</label>
          <select class="field" data-role="fs">
            ${sizes.map((n) => `<option value="${n}" ${pref.size === n ? 'selected' : ''}>${n}px</option>`).join('')}
          </select>
        </div>
        <label class="toggle" style="margin-bottom:12px">
          <input type="checkbox" data-role="italic" ${pref.italic ? 'checked' : ''}/>
          <span>正文使用斜体</span>
        </label>
        <div class="desc">阅读进度通过 <code>PUT /api/media/reading/progress</code> 写回服务端（0–100，含 page/total），因此 Web 端与安卓端同一账号可见。</div>
      </div>
      <div class="set-sec">
        <h3>漫画</h3>
        <div class="desc">默认值与 Web 端 v0.9.88 的 <code>vaulthub_comic_prefs</code> 一致：单页 / 宽度适应 / <b>右到左（日式）</b> / 预取后 ${COMIC_PREFETCH_AHEAD} 页。</div>
        <div class="form-row">
          <label>阅读模式</label>
          <select class="field" data-role="comicMode">
            ${[['single', '单页'], ['double', '双页'], ['scroll', '连续滚动']]
              .map(([v, l]) => `<option value="${v}" ${cp.mode === v ? 'selected' : ''}>${l}</option>`)
              .join('')}
          </select>
        </div>
        <label class="toggle" style="margin-bottom:12px">
          <input type="checkbox" data-role="comicRtl" ${cp.rtl !== false ? 'checked' : ''}/>
          <span>右到左翻页（日式漫画）</span>
        </label>
        <div class="form-row">
          <label>省流策略（决定「自动」画质档下的取图宽度）</label>
          <select class="field" data-role="comicSaveData">
            ${[['auto', '自动（弱网/saveData 时省流）'], ['on', '始终省流'], ['off', '从不省流']]
              .map(([v, l]) => `<option value="${v}" ${String(cp.saveData) === v ? 'selected' : ''}>${l}</option>`)
              .join('')}
          </select>
          <div class="form-hint">省流开启时按 ${cp.width}px 让服务端转码；关闭则原图直出。显式画质档位优先于此设置。</div>
        </div>
      </div>`;
    panel.querySelector('[data-role="fs"]').addEventListener('change', (e) => saveEbookFontPref({ size: Number(e.target.value) }));
    panel.querySelector('[data-role="italic"]').addEventListener('change', (e) => saveEbookFontPref({ italic: e.target.checked }));
    panel.querySelector('[data-role="comicMode"]').addEventListener('change', (e) => setComicPrefs({ mode: e.target.value }));
    panel.querySelector('[data-role="comicRtl"]').addEventListener('change', (e) => setComicPrefs({ rtl: e.target.checked }));
    panel.querySelector('[data-role="comicSaveData"]').addEventListener('change', (e) => setComicPrefs({ saveData: e.target.value }));
  }

  if (tab === 'account') {
    panel.innerHTML = `<div class="empty"><span class="spinner"></span></div>`;
    try {
      const r = await api.sessionCheck();
      const am = await api.authMode();
      panel.innerHTML = `
        <div class="set-sec">
          <h3>当前账号</h3>
          <div class="kv">
            <div class="k">用户名</div><div class="v">${escapeHtml(String(am.username ?? '-'))}</div>
            <div class="k">鉴权模式</div><div class="v">${escapeHtml(String(am.mode))}</div>
            <div class="k">会话状态</div><div class="v">${r && r.ok !== false ? '有效' : '无效'}</div>
            <div class="k">会话有效期</div><div class="v">${am.session_default_days ?? '-'} 天（长会话 ${am.session_long_days ?? '-'} 天）</div>
            <div class="k">需强制改密</div><div class="v">${am.must_change ? '是' : '否'}</div>
          </div>
        </div>
        <div class="set-sec">
          <h3>修改密码</h3>
          <div class="desc">对应服务端 <code>POST /api/account</code>。单账号体系，修改后其它端需重新登录。</div>
          <div class="form-row"><label>当前密码</label><input class="field" type="password" data-role="old"/></div>
          <div class="form-row"><label>新用户名（可留空）</label><input class="field" data-role="newu"/></div>
          <div class="form-row"><label>新密码</label><input class="field" type="password" data-role="newp"/></div>
          <div class="form-row"><label>确认新密码</label><input class="field" type="password" data-role="newp2"/></div>
          <button class="btn primary" data-role="saveacct">提交修改</button>
        </div>`;
      panel.querySelector('[data-role="saveacct"]').addEventListener('click', async () => {
        const oldp = panel.querySelector('[data-role="old"]').value;
        const newu = panel.querySelector('[data-role="newu"]').value.trim();
        const newp = panel.querySelector('[data-role="newp"]').value;
        const newp2 = panel.querySelector('[data-role="newp2"]').value;
        if (newp && newp !== newp2) return toast('两次输入的新密码不一致', 'err');
        if (!oldp) return toast('请输入当前密码', 'err');
        const payload = { old_password: oldp };
        if (newu) payload.username = newu;
        if (newp) payload.password = newp;
        try {
          await api.account(payload);
          toast('账号已更新', 'ok');
        } catch (e) {
          toast(`更新失败：${e.message}`, 'err');
        }
      });
    } catch (e) {
      panel.innerHTML = `<div class="alert err">读取账号信息失败：${escapeHtml(e.message)}</div>`;
    }
  }

  if (tab === 'data') {
    const st = vaultStore.stats();
    const favs = getFavorites();
    const favCount = Object.values(favs).reduce((a, b) => a + Object.keys(b || {}).length, 0);
    const pls = getPlaylists();
    panel.innerHTML = `
      <div class="set-sec">
        <h3>本地存储</h3>
        <div class="kv">
          <div class="k">存储后端</div><div class="v">${escapeHtml(st.backend)}</div>
          <div class="k">键数量</div><div class="v">${st.keys}</div>
          <div class="k">占用</div><div class="v">${fmtBytes(st.bytes)}</div>
          <div class="k">喜欢（本机）</div><div class="v">${favCount} 首</div>
          <div class="k">歌单（本机）</div><div class="v">${pls.length} 个</div>
        </div>
      </div>
      <div class="set-sec">
        <h3>跨端共享说明</h3>
        <div class="alert warn">
          服务端 v0.9.83 <b>尚未提供</b> 喜欢、歌单、视频续播位置接口（交接包 5.2 已列为下一版建议项），
          因此这几项目前<b>只保存在本机</b>，不会与 Web 端 / 安卓端互通。<br/>
          已共享的是：媒体库、文件索引、元数据、阅读进度、主题。
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn" data-role="export">导出本地数据（JSON）</button>
          <button class="btn danger" data-role="clear">清空本地数据</button>
        </div>
        <div class="form-hint">清空只影响本机偏好/收藏/续播，不会改动服务端任何数据。</div>
      </div>`;
    panel.querySelector('[data-role="export"]').addEventListener('click', () => {
      const dump = {};
      for (const k of ['vh_fav_audio_v1', 'vh_pl_audio_v1', 'vh_comic_prefs_v1']) dump[k] = vaultStore.get(k, null);
      dump.resume = (() => {
        const out = {};
        try {
          for (let i = 0; i < localStorage.length; i += 1) {
            const k = localStorage.key(i);
            if (k?.startsWith('vh_resume_')) out[k] = vaultStore.get(k, null);
          }
        } catch {
          /* 忽略 */
        }
        return out;
      })();
      const blob = new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `vaulthub-desktop-local-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      toast('已导出本地数据', 'ok');
    });
    panel.querySelector('[data-role="clear"]').addEventListener('click', async () => {
      const ok = await confirmDialog('清空本地数据', '将删除本机的收藏、歌单、续播位置与阅读偏好。服务端数据不受影响。', '清空');
      if (!ok) return;
      try {
        const keys = [];
        for (let i = 0; i < localStorage.length; i += 1) {
          const k = localStorage.key(i);
          if (k?.startsWith('vh_')) keys.push(k);
        }
        for (const k of keys) vaultStore.del(k);
        toast('本地数据已清空', 'ok');
        paint(mount, ctx);
      } catch (e) {
        toast(`清空失败：${e.message}`, 'err');
      }
    });
  }

  if (tab === 'about') {
    panel.innerHTML = `
      <div class="set-sec">
        <h3>VaultHub Desktop</h3>
        <div class="kv">
          <div class="k">客户端版本</div><div class="v">v${escapeHtml(String(info.appVersion))}</div>
          <div class="k">对接服务端契约</div><div class="v">v0.9.88（最新 UI · 对齐 03-quality.js / 02-media.js）</div>
          <div class="k">Electron</div><div class="v">${escapeHtml(String(info.electron))}</div>
          <div class="k">Chromium</div><div class="v">${escapeHtml(String(info.chrome))}</div>
          <div class="k">Node</div><div class="v">${escapeHtml(String(info.node))}</div>
          <div class="k">运行平台</div><div class="v">${escapeHtml(String(info.platform))}</div>
          <div class="k">用户数据目录</div><div class="v">${escapeHtml(String(info.userData))}</div>
          <div class="k">日志文件</div><div class="v">${escapeHtml(String(info.logPath))}</div>
        </div>
        <div style="display:flex;gap:8px;margin-top:12px">
          <button class="btn" data-role="openlog">${icon('folder', 14)} 打开日志目录</button>
          <button class="btn" data-role="stats">${icon('info', 14)} 本次会话请求统计</button>
        </div>
      </div>
      <div class="set-sec">
        <h3>致谢</h3>
        <div class="desc">界面主题令牌、接口契约与阅读/播放/画质规则取自服务端 <b>v0.9.88</b> 的 <code>index.html</code> / <code>web/js/03-quality.js</code> / <code>web/js/02-media.js</code>；交接包为 kit 1.0（当时对应 v0.9.83）。</div>
      </div>`;
    panel.querySelector('[data-role="openlog"]').addEventListener('click', () => window.vhHost.showItem(info.logPath));
    panel.querySelector('[data-role="stats"]').addEventListener('click', async () => {
      const rows = Object.entries(api.stats.byEndpoint).sort((a, b) => b[1] - a[1]);
      await modal({
        title: '请求统计',
        body: `<div class="kv">
          <div class="k">总请求数</div><div class="v">${api.stats.requests}</div>
          <div class="k">ETag 304 命中</div><div class="v">${api.stats.revalidated304}</div>
          <div class="k">失败数</div><div class="v">${api.stats.errors}</div>
        </div>
        <div style="margin-top:14px" class="kv">
          ${rows.map(([k, v]) => `<div class="k">${escapeHtml(k)}</div><div class="v">${v}</div>`).join('')}
        </div>`,
        actions: [{ label: '关闭', className: 'ghost' }],
      });
    });
  }
}
