/* ============================================================================
   视频播放器
   - 开播前 POST /api/media/playback/plan，按返回的 mode/url 播放
   - 直出走 /api/media/file（Range 206，拖动进度条不重下整段）
   - 播放计划失败或编码不兼容时回退 /api/media/compat
   - 续播位置保存在本地（服务端播放会话在内存且上限 64，不能当续播存储）
   ========================================================================= */

import * as api from '../api.js';
import {
  detectClientCapabilities, fmtDuration, fmtBytes, escapeHtml, srtToVtt, assToVtt,
  basename, cleanTitle, isVideo, playbackModeLabel,
} from '../util.js';
import { qualityVideoPreset, measuredNetworkBps } from '../quality.js';
import { getResume, setResume, clearResume, state } from '../state.js';
import { icon, toast, modal, seekBar } from '../ui.js';
import { findSubtitles, siblings } from '../paths.js';

/** 给 Promise 加超时（服务端 Web 端对播放计划用 20s 超时，避免永久卡住） */
function withTimeout(promise, ms, message) {
  let timer = 0;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

let host = null;
let video = null;
let seek = null;
let uiTimer = 0;
let current = null; // {lib, item}
let plan = null;
let subtitleBlobs = [];

function ensureHost() {
  if (host) return host;
  host = document.createElement('div');
  host.className = 'player hidden';
  host.innerHTML = `
    <div class="player-stage">
      <video playsinline preload="metadata"></video>
      <div class="player-msg hidden"></div>
      <div class="player-top">
        <button class="icon-btn" data-act="close" title="关闭 (Esc)">${icon('close', 18)}</button>
        <div class="pt-title">
          <div class="a" data-role="title"></div>
          <div class="b" data-role="sub"></div>
        </div>
        <span class="badge" data-role="mode"></span>
        <button class="icon-btn" data-act="subs" title="字幕">${icon('subtitle', 18)}</button>
        <button class="icon-btn" data-act="info" title="媒体信息">${icon('info', 18)}</button>
      </div>
      <div class="player-bottom">
        <div class="player-ctrl">
          <button class="icon-btn" data-act="prev" title="上一集">${icon('prev', 18)}</button>
          <button class="icon-btn" data-act="play" title="播放/暂停 (空格)">${icon('play', 22)}</button>
          <button class="icon-btn" data-act="next" title="下一集">${icon('next', 18)}</button>
          <span class="time" data-role="cur">0:00</span>
          <span data-role="seek"></span>
          <span class="time" data-role="dur">0:00</span>
          <button class="icon-btn" data-act="mute" title="静音 (M)">${icon('volume', 18)}</button>
          <input class="field" data-role="vol" type="range" min="0" max="1" step="0.01" style="width:90px;height:24px;padding:0;border:none;background:transparent" />
          <button class="icon-btn" data-act="rate" title="播放速度">${icon('speed', 18)}</button>
          <button class="icon-btn" data-act="fs" title="全屏 (F)">${icon('expand', 18)}</button>
        </div>
        <div class="hint-line">
          <span data-role="cap"></span>
          <span>·</span>
          <span>服务端播放会话为内存态，续播位置保存在本机</span>
        </div>
      </div>
    </div>`;
  document.body.appendChild(host);

  video = host.querySelector('video');
  seek = seekBar({
    onSeek: (r) => {
      if (!video.duration || !Number.isFinite(video.duration)) return;
      video.currentTime = r * video.duration;
      hideUiSoon();
    },
  });
  host.querySelector('[data-role="seek"]').appendChild(seek.el);

  host.querySelector('[data-act="close"]').addEventListener('click', close);
  host.querySelector('[data-act="play"]').addEventListener('click', togglePlay);
  host.querySelector('[data-act="fs"]').addEventListener('click', toggleFs);
  host.querySelector('[data-act="mute"]').addEventListener('click', toggleMute);
  host.querySelector('[data-act="rate"]').addEventListener('click', cycleRate);
  host.querySelector('[data-act="info"]').addEventListener('click', showInfo);
  host.querySelector('[data-act="subs"]').addEventListener('click', showSubtitleMenu);
  host.querySelector('[data-act="prev"]').addEventListener('click', () => stepEpisode(-1));
  host.querySelector('[data-act="next"]').addEventListener('click', () => stepEpisode(1));

  const vol = host.querySelector('[data-role="vol"]');
  vol.value = String(state.config.volume ?? 1);
  video.volume = Number(vol.value);
  video.muted = !!state.config.muted;
  vol.addEventListener('input', () => {
    video.volume = Number(vol.value);
    video.muted = false;
    import('../state.js').then((m) => m.setConfig({ volume: video.volume, muted: false }));
    paintVolume();
  });

  video.addEventListener('click', () => {
    togglePlay();
    hideUiSoon();
  });
  video.addEventListener('dblclick', toggleFs);
  video.addEventListener('timeupdate', onTime);
  video.addEventListener('progress', onProgress);
  video.addEventListener('play', paintPlay);
  video.addEventListener('pause', paintPlay);
  video.addEventListener('waiting', () => {
    if (video.readyState < 1) setMsg('缓冲中…', true);
  });
  video.addEventListener('playing', () => {
    clearLoadGuard();
    setMsg('', false);
  });
  video.addEventListener('loadedmetadata', () => {
    clearLoadGuard();
    setMsg('', false);
  });
  video.addEventListener('ended', onEnded);
  video.addEventListener('error', onError);
  host.addEventListener('mousemove', () => {
    host.classList.add('show-ui');
    hideUiSoon();
  });

  document.addEventListener('keydown', onKey);
  return host;
}

/* ---------------------------------------------------------------- 打开 */

export async function open(lib, item, { autoPlay = true } = {}) {
  ensureHost();
  current = { lib, item };
  plan = null;
  host.classList.remove('hidden');
  host.classList.add('show-ui');
  setMsg('正在向服务端申请播放计划…', true);

  const titleEl = host.querySelector('[data-role="title"]');
  const subEl = host.querySelector('[data-role="sub"]');
  titleEl.textContent = item.title || basename(item.path);
  subEl.textContent = `${lib.name} · ${basename(item.path)}`;

  // 播放计划：参数与 v0.9.88 的 requestPlaybackPlan 对齐
  // （quality 由画面清晰度档位决定：原画/高清 → auto，流畅 → 720p，极省 → 480p）
  const caps = detectClientCapabilities();
  const quality = qualityVideoPreset();
  const body = {
    library_id: String(lib.id),
    path: String(item.path),
    quality,
    hardware: state.config.hardware || 'auto',
    network_bps: measuredNetworkBps(),
    client: caps,
  };
  let usedPlan = null;
  let planError = '';
  try {
    // 服务端 Web 端对播放计划用 20s 超时，避免探测/转码异常时永久卡住
    usedPlan = await withTimeout(api.playbackPlan(body), 20000, '播放计划请求超时（20s）');
    plan = usedPlan;
  } catch (err) {
    planError = err.message;
  }
  window.vhHost?.log(
    `player.open lib=${lib?.id} quality=${quality} path=${String(item?.path).slice(0, 120)} ` +
      `-> ${usedPlan ? `plan.ok mode=${usedPlan.mode} url=${usedPlan.url ? 'yes' : 'no'}` : `plan.ERR=${planError}`}`
  );

  const modeBadge = host.querySelector('[data-role="mode"]');
  const capEl = host.querySelector('[data-role="cap"]');
  if (usedPlan) {
    const m = usedPlan.mode || 'direct';
    modeBadge.textContent = playbackModeLabel(usedPlan);
    modeBadge.className = `badge ${m === 'direct' ? 'ok' : 'warn'}`;
    const media = usedPlan.media || {};
    capEl.textContent = [
      media.container && `${media.container}`,
      media.video_codec && `${media.video_codec}${media.width ? ` ${media.width}x${media.height}` : ''}`,
      media.audio_codec,
      media.bit_rate && `${Math.round(Number(media.bit_rate) / 1000)} kbps`,
      usedPlan.reason,
    ]
      .filter(Boolean)
      .join(' · ');
  } else {
    modeBadge.textContent = '转码回退';
    modeBadge.className = 'badge warn';
    capEl.textContent = `播放计划失败（${planError}），改用 /api/media/compat 转码流`;
    toast(`播放计划失败：${escapeHtml(planError)}，已回退转码流`, 'warn');
  }

  const src = usedPlan && usedPlan.url ? usedPlan.url : api.urls.compatUrl(lib.id, item.path, state.config.hardware || 'auto');
  window.vhHost?.log(`player.src=${src.slice(0, 200)} (lib.id=${lib?.id})`);
  video.src = src;
  video.load();
  armLoadGuard(src, usedPlan);

  // 续播
  const resume = getResume(lib.id, item.path);
  if (resume && resume.position_ms > 5000) {
    const jump = () => {
      try {
        video.currentTime = resume.position_ms / 1000;
        toast(`已从 ${fmtDuration(resume.position_ms / 1000)} 继续播放（本机记录）`, 'info', 3600);
      } catch {
        /* 元数据未就绪 */
      }
      video.removeEventListener('loadedmetadata', jump);
    };
    video.addEventListener('loadedmetadata', jump);
  }

  await loadSubtitles(lib, item);
  if (autoPlay) video.play().catch(() => {});
  paintPlay();
  paintVolume();
  hideUiSoon();
  await updateNavButtons();
}

/* ---------------------------------------------------------------- 字幕 */

async function loadSubtitles(lib, item) {
  // 清理上一部
  for (const b of subtitleBlobs) URL.revokeObjectURL(b);
  subtitleBlobs = [];
  for (const t of [...video.querySelectorAll('track')]) t.remove();

  const found = findSubtitles(lib.id, item.path);
  let idx = 0;
  for (const s of found) {
    try {
      const res = await api.fetchBinary(api.urls.mediaUrl(lib.id, s.path));
      const buf = await res.arrayBuffer();
      const { decodeText } = await import('../util.js');
      const text = decodeText(buf);
      const lower = s.path.toLowerCase();
      let vtt;
      if (lower.endsWith('.vtt')) vtt = text;
      else if (lower.endsWith('.ass') || lower.endsWith('.ssa')) vtt = assToVtt(text);
      else vtt = srtToVtt(text);
      const blob = URL.createObjectURL(new Blob([vtt], { type: 'text/vtt' }));
      subtitleBlobs.push(blob);
      const track = document.createElement('track');
      track.kind = 'subtitles';
      track.label = s.name;
      track.srclang = /zh|chs|cht|chi|中文/i.test(s.name) ? 'zh' : 'en';
      track.src = blob;
      if (idx === 0) track.default = true;
      video.appendChild(track);
      idx += 1;
    } catch {
      /* 单条字幕失败不影响播放 */
    }
  }
  // 默认打开第一条
  if (idx > 0) {
    setTimeout(() => {
      try {
        video.textTracks[0].mode = 'showing';
      } catch {
        /* 忽略 */
      }
    }, 120);
  }
}

async function showSubtitleMenu() {
  const tracks = [...video.querySelectorAll('track')];
  const body = tracks.length
    ? `<div class="list">${tracks
        .map(
          (t, i) =>
            `<button class="row" data-i="${i}"><span class="r-idx">${i + 1}</span><span class="r-main"><span class="r-title">${escapeHtml(t.label)}</span></span><span class="r-right">${video.textTracks[i]?.mode === 'showing' ? '显示中' : ''}</span></button>`
        )
        .join('')}<button class="row" data-i="-1"><span class="r-idx">×</span><span class="r-main"><span class="r-title">关闭字幕</span></span></button></div>`
    : `<div class="alert info">未在同目录找到旁挂字幕（.srt/.ass/.vtt）。<br/>服务端的在线字幕接口在生产 Caddy 配置下不可达（见交接包 docs/06），因此桌面端只做本地旁挂字幕。</div>`;

  const d = modal({ title: '字幕', body, actions: [{ label: '关闭', className: 'ghost' }] });
  d.el.querySelectorAll('[data-i]').forEach((b) => {
    b.addEventListener('click', () => {
      const i = Number(b.dataset.i);
      video.textTracks[0] && [...video.textTracks].forEach((t, j) => (t.mode = j === i ? 'showing' : 'disabled'));
      if (i === -1) [...video.textTracks].forEach((t) => (t.mode = 'disabled'));
      d.close(null);
    });
  });
}

/* ---------------------------------------------------------------- 控制 */

function togglePlay() {
  if (video.paused) video.play().catch(() => {});
  else video.pause();
}

function toggleFs() {
  if (document.fullscreenElement) document.exitFullscreen();
  else host.requestFullscreen?.().catch(() => {});
}

function toggleMute() {
  video.muted = !video.muted;
  import('../state.js').then((m) => m.setConfig({ muted: video.muted }));
  paintVolume();
}

const RATES = [1, 1.25, 1.5, 2, 0.75, 0.5];
function cycleRate() {
  const i = RATES.indexOf(video.playbackRate);
  video.playbackRate = RATES[(i + 1) % RATES.length];
  toast(`播放速度 ${video.playbackRate}×`, 'info', 1600);
}

function paintPlay() {
  const b = host.querySelector('[data-act="play"]');
  b.innerHTML = video.paused ? icon('play', 22) : icon('pause', 22);
}

function paintVolume() {
  const b = host.querySelector('[data-act="mute"]');
  b.innerHTML = video.muted || video.volume === 0 ? icon('mute', 18) : icon('volume', 18);
}

function onTime() {
  if (!video.duration || !Number.isFinite(video.duration)) return;
  seek.setProgress(video.currentTime / video.duration);
  host.querySelector('[data-role="cur"]').textContent = fmtDuration(video.currentTime);
  host.querySelector('[data-role="dur"]').textContent = fmtDuration(video.duration);
  // 每 5 秒记一次续播位置
  if (current && Math.floor(video.currentTime) % 5 === 0) {
    setResume(current.lib.id, current.item.path, video.currentTime * 1000, video.duration * 1000);
  }
}

function onProgress() {
  try {
    if (video.buffered.length && video.duration) {
      seek.setBuffered(video.buffered.end(video.buffered.length - 1) / video.duration);
    }
  } catch {
    /* 忽略 */
  }
}

function onEnded() {
  if (current) {
    clearResume(current.lib.id, current.item.path);
    // 剧集自动下一集
    if (current.lib.type === 'series') {
      const nxt = neighbor(1);
      if (nxt) return open(current.lib, { ...current.item, path: nxt, title: cleanTitle(nxt) });
    }
  }
}

function onError() {
  const err = video.error;
  const codes = { 1: '加载被中止', 2: '网络错误', 3: '解码失败', 4: '源格式不受支持' };
  const msg = codes[err?.code] || '未知播放错误';
  setMsg(
    `<b>播放失败：${escapeHtml(msg)}</b><br/>
     容器/编码可能不被内置 Chromium 支持。<br/>
     <span class="muted">可尝试：切换播放模式为服务端转码。</span>`,
    true
  );
  if (plan && plan.mode === 'direct') {
    // 直出失败 → 自动尝试转码
    setMsg('直出失败，正在切换服务端转码…', true);
    video.src = api.urls.compatUrl(current.lib.id, current.item.path, state.config.hardware || 'auto');
    video.load();
    video.play().catch(() => {});
  }
}

function setMsg(html, show) {
  const el = host.querySelector('.player-msg');
  if (!show || !html) {
    el.classList.add('hidden');
    el.innerHTML = '';
    return;
  }
  el.innerHTML = html;
  el.classList.remove('hidden');
}

/* ---------------- 加载守卫 ----------------
   服务端转码可能长时间没有任何输出（实测 4K HEVC 的 full_transcode 返回 200 但 0 字节）。
   不能无限转圈，超时后要给出可操作的提示与重试入口。 */
let loadGuard = 0;

function clearLoadGuard() {
  clearTimeout(loadGuard);
  loadGuard = 0;
}

function armLoadGuard(src, planInfo) {
  clearLoadGuard();
  const isTranscode = /\/api\/media\/compat/.test(src);
  const waitMs = isTranscode ? 25000 : 12000;
  setMsg(
    isTranscode
      ? `正在等待服务端转码输出…<br/><span class="muted">${escapeHtml(planInfo?.reason || '')}</span>`
      : '正在加载媒体…',
    true
  );
  loadGuard = setTimeout(() => {
    if (!current || video.readyState >= 1) return;
    const reason = planInfo?.reason ? `<br/><span class="muted">服务端理由：${escapeHtml(planInfo.reason)}</span>` : '';
    setMsg(
      `<b>${waitMs / 1000} 秒内没有收到可播放数据</b><br/>
       ${isTranscode ? '服务端转码流没有输出' : '直出流没有响应'}${reason}<br/>
       <span class="muted">常见原因：该文件需要转码，但服务端转码不可用
       （硬件加速不可用、或 4K HEVC 等重负载转码失败）。</span><br/>
       <button class="btn sm" data-act="retry-direct">改用直出重试</button>
       <button class="btn sm" data-act="retry-compat">改用转码重试</button>`,
      true
    );
    host.querySelector('[data-act="retry-direct"]')?.addEventListener('click', () => {
      const lib = current.lib;
      const item = current.item;
      clearLoadGuard();
      video.src = api.urls.mediaUrl(lib.id, item.path);
      video.load();
      armLoadGuard(video.src, null);
      video.play().catch(() => {});
    });
    host.querySelector('[data-act="retry-compat"]')?.addEventListener('click', () => {
      const lib = current.lib;
      const item = current.item;
      clearLoadGuard();
      video.src = api.urls.compatUrl(lib.id, item.path, state.config.hardware || 'auto');
      video.load();
      armLoadGuard(video.src, planInfo);
      video.play().catch(() => {});
    });
  }, waitMs);
}

function hideUiSoon() {
  clearTimeout(uiTimer);
  host.classList.add('show-ui');
  uiTimer = setTimeout(() => {
    if (!video.paused) host.classList.remove('show-ui');
  }, 2600);
}

function onKey(e) {
  if (host.classList.contains('hidden')) return;
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea') return;
  switch (e.key) {
    case ' ':
      e.preventDefault();
      togglePlay();
      break;
    case 'ArrowRight':
      video.currentTime = Math.min(video.duration || 0, video.currentTime + 10);
      break;
    case 'ArrowLeft':
      video.currentTime = Math.max(0, video.currentTime - 10);
      break;
    case 'ArrowUp':
      video.volume = Math.min(1, video.volume + 0.05);
      paintVolume();
      break;
    case 'ArrowDown':
      video.volume = Math.max(0, video.volume - 0.05);
      paintVolume();
      break;
    case 'f':
    case 'F':
      toggleFs();
      break;
    case 'm':
    case 'M':
      toggleMute();
      break;
    case 'Escape':
      if (document.fullscreenElement) document.exitFullscreen();
      else close();
      break;
    default:
      break;
  }
  hideUiSoon();
}

/* ---------------------------------------------------------------- 上下集 */

function neighbor(delta) {
  if (!current || current.lib.type !== 'series') return null;
  const list = siblings(current.lib.id, current.item.path, isVideo);
  const i = list.indexOf(current.item.path);
  if (i < 0) return null;
  return list[i + delta] || null;
}

async function updateNavButtons() {
  const has = current && current.lib.type === 'series';
  host.querySelector('[data-act="prev"]').style.display = has ? '' : 'none';
  host.querySelector('[data-act="next"]').style.display = has ? '' : 'none';
}

function stepEpisode(delta) {
  const p = neighbor(delta);
  if (!p) return toast('没有更多集了', 'info', 1600);
  open(current.lib, { ...current.item, path: p, title: cleanTitle(p) });
}

/* ---------------------------------------------------------------- 信息 */

async function showInfo() {
  if (!plan && !current) return;
  const media = plan?.media || {};
  const rows = [
    ['媒体库', `${current.lib.name}（${current.lib.id}）`],
    ['相对路径', current.item.path],
    ['播放模式', plan ? `${plan.mode}（${plan.layer || '-'}）` : '转码回退'],
    ['服务端理由', plan?.reason || '-'],
    ['容器', media.container || '-'],
    ['视频编码', `${media.video_codec || '-'} ${media.width ? `${media.width}×${media.height}` : ''}`],
    ['音频编码', media.audio_codec || '-'],
    ['码率', media.bit_rate ? `${Math.round(Number(media.bit_rate) / 1000)} kbps` : '-'],
    ['时长', media.duration ? fmtDuration(Number(media.duration)) : '-'],
    ['硬件', plan?.hardware || '-'],
    ['视频动作', plan?.video_action || '-'],
    ['音频动作', plan?.audio_action || '-'],
    ['文件大小', fmtBytes(current.item.size)],
  ];
  await modal({
    title: '播放信息',
    body: `<div class="kv">${rows.map(([k, v]) => `<div class="k">${escapeHtml(k)}</div><div class="v">${escapeHtml(String(v))}</div>`).join('')}</div>`,
    actions: [{ label: '关闭', className: 'ghost' }],
  });
}

/* ---------------------------------------------------------------- 关闭 */

export function close() {
  if (!host) return;
  if (current && video.duration && Number.isFinite(video.duration)) {
    setResume(current.lib.id, current.item.path, video.currentTime * 1000, video.duration * 1000);
  }
  try {
    video.pause();
  } catch {
    /* 忽略 */
  }
  video.removeAttribute('src');
  video.load();
  for (const b of subtitleBlobs) URL.revokeObjectURL(b);
  subtitleBlobs = [];
  host.classList.add('hidden');
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  const wasSeries = current?.lib?.type === 'series';
  const lib = current?.lib;
  current = null;
  plan = null;
  // 返回列表时刷新续播角标
  window.dispatchEvent(new CustomEvent('vh:closed-player', { detail: { lib } }));
}

export function isOpen() {
  return host && !host.classList.contains('hidden');
}
