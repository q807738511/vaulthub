/* ============================================================================
   音乐：专辑 / 歌手 / 歌单 / ♥喜欢 / 曲目 + 常驻底部播放条 + 歌词
   - 音频流：GET /api/media/audio/stream?id=&path=&bitrate=（bitrate 必填）
   - 歌词  ：GET /api/media/audio/lyrics
   - 喜欢 / 歌单：⚠ 服务端无对应端点，保存在本机（UI 已标注）
   ========================================================================= */

import * as api from '../api.js';
import {
  coverUrl, fmtDuration, fmtBytes, escapeHtml, basename, cleanTitle, audioStreamUrl,
} from '../util.js';
import {
  state, getFavorites, isFavorite, toggleFavorite, getPlaylists, savePlaylist, deletePlaylist,
} from '../state.js';
import { icon, toast, modal, confirmDialog, lazyImg, seekBar } from '../ui.js';

/* ================================================================ 播放内核 */

const player = {
  audio: null,
  lib: null,
  track: null,
  queue: [],
  index: -1,
  imageIndex: null,
  shuffle: false,
  repeat: 'off', // off | one | all
  seek: null,
  visible: false,
};

function ensureAudio() {
  if (player.audio) return player.audio;
  const a = new Audio();
  a.preload = 'metadata';
  player.audio = a;
  // 供端到端自检读取播放状态（Audio() 不在 DOM 里，无法用选择器取到）
  window.__vhAudio = a;

  a.addEventListener('timeupdate', () => {
    const bar = document.querySelector('.abar');
    if (!bar || !a.duration || !Number.isFinite(a.duration)) return;
    player.seek?.setProgress(a.currentTime / a.duration);
    bar.querySelector('[data-role="cur"]').textContent = fmtDuration(a.currentTime);
    if (player.track) syncLyricHighlight(a.currentTime);
  });
  a.addEventListener('loadedmetadata', () => {
    const bar = document.querySelector('.abar');
    if (bar) bar.querySelector('[data-role="dur"]').textContent = fmtDuration(a.duration);
  });
  a.addEventListener('play', paintPlayState);
  a.addEventListener('pause', paintPlayState);
  a.addEventListener('ended', onEnded);
  a.addEventListener('error', () => {
    const e = a.error;
    const codes = { 1: '加载被中止', 2: '网络错误', 3: '解码失败', 4: '格式不受支持' };
    toast(`音频播放失败：${codes[e?.code] || '未知错误'}`, 'err');
  });
  a.volume = Number(state.config.volume ?? 1);
  a.muted = !!state.config.muted;
  return a;
}

/* ---------------------------------------------------------------- 底部播放条 */

function ensureBar() {
  if (document.querySelector('.abar')) return document.querySelector('.abar');
  const bar = document.createElement('div');
  bar.className = 'abar hidden';
  bar.innerHTML = `
    <img class="ab-cover" alt="" />
    <div class="ab-info">
      <div class="t" data-role="t">未在播放</div>
      <div class="a" data-role="a"></div>
    </div>
    <div class="ab-mid">
      <div class="ab-ctrl">
        <button class="icon-btn" data-act="shuffle" title="随机">${icon('list', 16)}</button>
        <button class="icon-btn" data-act="prev" title="上一首">${icon('prev', 18)}</button>
        <button class="icon-btn" data-act="play" title="播放/暂停">${icon('play', 22)}</button>
        <button class="icon-btn" data-act="next" title="下一首">${icon('next', 18)}</button>
        <button class="icon-btn" data-act="repeat" title="循环">${icon('refresh', 16)}</button>
      </div>
      <div class="ab-seek">
        <span class="time" data-role="cur">0:00</span>
        <span data-role="seek" style="flex:1"></span>
        <span class="time" data-role="dur">0:00</span>
      </div>
    </div>
    <div class="ab-right">
      <button class="icon-btn" data-act="fav" title="喜欢（本机）">${icon('heart', 17)}</button>
      <button class="icon-btn" data-act="lyrics" title="歌词">${icon('list', 17)}</button>
      <button class="icon-btn" data-act="addpl" title="加入歌单（本机）">${icon('plus', 17)}</button>
      <button class="icon-btn" data-act="mute" title="静音">${icon('volume', 17)}</button>
      <input class="field vol" type="range" min="0" max="1" step="0.01" data-role="vol" />
    </div>`;
  document.body.appendChild(bar);

  player.seek = seekBar({
    onSeek: (r) => {
      const a = player.audio;
      if (a && a.duration && Number.isFinite(a.duration)) a.currentTime = r * a.duration;
    },
  });
  bar.querySelector('[data-role="seek"]').appendChild(player.seek.el);

  const vol = bar.querySelector('[data-role="vol"]');
  vol.value = String(state.config.volume ?? 1);
  vol.addEventListener('input', async () => {
    const a = ensureAudio();
    a.volume = Number(vol.value);
    a.muted = false;
    const { setConfig } = await import('../state.js');
    setConfig({ volume: a.volume, muted: false });
    paintVolume();
  });

  bar.querySelector('[data-act="play"]').addEventListener('click', toggle);
  bar.querySelector('[data-act="prev"]').addEventListener('click', () => step(-1));
  bar.querySelector('[data-act="next"]').addEventListener('click', () => step(1));
  bar.querySelector('[data-act="mute"]').addEventListener('click', async () => {
    const a = ensureAudio();
    a.muted = !a.muted;
    const { setConfig } = await import('../state.js');
    setConfig({ muted: a.muted });
    paintVolume();
  });
  bar.querySelector('[data-act="shuffle"]').addEventListener('click', () => {
    player.shuffle = !player.shuffle;
    bar.querySelector('[data-act="shuffle"]').classList.toggle('on', player.shuffle);
    toast(`随机播放 ${player.shuffle ? '开' : '关'}`, 'info', 1400);
  });
  bar.querySelector('[data-act="repeat"]').addEventListener('click', () => {
    const order = ['off', 'all', 'one'];
    player.repeat = order[(order.indexOf(player.repeat) + 1) % 3];
    bar.querySelector('[data-act="repeat"]').classList.toggle('on', player.repeat !== 'off');
    toast(`循环：${{ off: '关', all: '列表', one: '单曲' }[player.repeat]}`, 'info', 1400);
  });
  bar.querySelector('[data-act="fav"]').addEventListener('click', () => {
    if (!player.lib || !player.track) return;
    const now = toggleFavorite(player.lib.id, player.track.path);
    toast(now ? '已加入喜欢（仅本机）' : '已取消喜欢', 'info', 1800);
    paintFav();
  });
  bar.querySelector('[data-act="lyrics"]').addEventListener('click', toggleLyrics);
  bar.querySelector('[data-act="addpl"]').addEventListener('click', () => {
    if (!player.track) return;
    addToPlaylistDialog(player.lib, player.track);
  });
  return bar;
}

function paintPlayState() {
  const bar = document.querySelector('.abar');
  if (!bar) return;
  bar.querySelector('[data-act="play"]').innerHTML = player.audio?.paused ? icon('play', 22) : icon('pause', 22);
  bar.querySelector('[data-role="t"]').textContent = player.track?.title || '未在播放';
  bar.querySelector('[data-role="a"]').textContent = player.track
    ? `${player.track.artist || ''}${player.track.album ? ` · ${player.track.album}` : ''}`
    : '';
  paintFav();
  paintVolume();
}

function paintVolume() {
  const bar = document.querySelector('.abar');
  if (!bar || !player.audio) return;
  bar.querySelector('[data-act="mute"]').innerHTML =
    player.audio.muted || player.audio.volume === 0 ? icon('mute', 17) : icon('volume', 17);
}

function paintFav() {
  const bar = document.querySelector('.abar');
  if (!bar) return;
  const on = player.lib && player.track && isFavorite(player.lib.id, player.track.path);
  bar.querySelector('[data-act="fav"]').classList.toggle('on', !!on);
}

/* ---------------------------------------------------------------- 播放控制 */

export function playTrack(lib, track, queue, imageIndex) {
  ensureBar();
  ensureAudio();
  player.lib = lib;
  player.track = track;
  player.queue = queue && queue.length ? queue : [track];
  player.index = player.queue.findIndex((t) => t.path === track.path);
  if (player.index < 0) player.index = 0;
  player.imageIndex = imageIndex || player.imageIndex;

  const a = player.audio;
  a.src = audioStreamUrl(lib.id, track.path, state.config.audioBitrate || 192);
  a.play().catch((e) => toast(`播放失败：${e.message}`, 'err'));

  const bar = document.querySelector('.abar');
  bar.classList.remove('hidden');
  document.querySelector('.content')?.classList.add('with-abar');
  player.visible = true;
  const cover = imageIndex ? imageIndex.pick(track.path) : '';
  bar.querySelector('.ab-cover').src = cover ? coverUrl(lib.id, cover, 320) : '';
  paintPlayState();
  loadLyrics(lib, track);
  window.dispatchEvent(new CustomEvent('vh:audio-track', { detail: { lib, track } }));
}

function toggle() {
  const a = ensureAudio();
  if (!a.src) return;
  if (a.paused) a.play().catch(() => {});
  else a.pause();
}

function step(d) {
  if (!player.queue.length) return;
  if (player.shuffle) {
    let n = player.index;
    if (player.queue.length > 1) while (n === player.index) n = Math.floor(Math.random() * player.queue.length);
    player.index = n;
  } else {
    player.index += d;
    if (player.index < 0) player.index = player.repeat === 'all' ? player.queue.length - 1 : 0;
    if (player.index >= player.queue.length) player.index = player.repeat === 'all' ? 0 : player.queue.length - 1;
  }
  const t = player.queue[player.index];
  if (t) playTrack(player.lib, t, player.queue, player.imageIndex);
}

function onEnded() {
  if (player.repeat === 'one') {
    player.audio.currentTime = 0;
    player.audio.play().catch(() => {});
    return;
  }
  step(1);
}

export function stopAudio() {
  const a = player.audio;
  if (a) {
    a.pause();
    a.removeAttribute('src');
  }
  document.querySelector('.abar')?.classList.add('hidden');
  hideLyrics();
}

export function currentTrack() {
  return player.track ? { lib: player.lib, track: player.track } : null;
}

/* ================================================================ 歌词 */

let lyricsLines = [];
let lyricsPanel = null;

function parseLrc(text) {
  const out = [];
  const lines = String(text).replace(/\r/g, '').split('\n');
  for (const line of lines) {
    const stamps = [...line.matchAll(/\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
    if (!stamps.length) continue;
    const content = line.replace(/\[[^\]]*\]/g, '').trim();
    if (!content) continue;
    for (const s of stamps) {
      const ms = s[3] ? parseInt(s[3].padEnd(3, '0'), 10) : 0;
      out.push({ time: parseInt(s[1], 10) * 60 + parseInt(s[2], 10) + ms / 1000, text: content });
    }
  }
  return out.sort((a, b) => a.time - b.time);
}

async function loadLyrics(lib, track) {
  if (!lyricsPanel || lyricsPanel.classList.contains('hidden')) {
    // 面板未打开时也先取，打开即用
  }
  lyricsLines = [];
  try {
    const r = await api.audioLyrics({ id: lib.id, path: track.path, artist: track.artist, title: track.title });
    if (r && r.found) {
      if (Array.isArray(r.synced_lyrics) && r.synced_lyrics.length) {
        lyricsLines = r.synced_lyrics
          .map((x) => ({ time: Number(x.time ?? x.t ?? 0), text: String(x.text ?? x.line ?? '') }))
          .filter((x) => x.text);
      } else if (typeof r.synced_lyrics === 'string' && r.synced_lyrics.includes('[')) {
        lyricsLines = parseLrc(r.synced_lyrics);
      } else if (typeof r.lyrics === 'string') {
        lyricsLines = parseLrc(r.lyrics);
        if (!lyricsLines.length) {
          lyricsLines = r.lyrics.split('\n').filter((l) => l.trim()).map((l) => ({ time: -1, text: l.trim() }));
        }
      }
      lyricsPanel && renderLyrics(r.lyrics_source || '服务端');
    } else if (lyricsPanel) {
      lyricsPanel.innerHTML = `<div class="muted" style="font-size:12.5px">未找到歌词（${escapeHtml(track.title)}）</div>`;
    }
  } catch (e) {
    if (lyricsPanel) lyricsPanel.innerHTML = `<div class="muted" style="font-size:12.5px">歌词获取失败：${escapeHtml(e.message)}</div>`;
  }
}

function renderLyrics(source) {
  if (!lyricsPanel) return;
  lyricsPanel.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
      <b style="font-size:13px">歌词</b>
      <span class="badge">${escapeHtml(String(source))}</span>
      <span class="grow"></span>
      <button class="icon-btn" data-role="xl">${icon('close', 15)}</button>
    </div>
    <div class="ly" data-role="ly"></div>`;
  lyricsPanel.querySelector('[data-role="xl"]').addEventListener('click', hideLyrics);
  const box = lyricsPanel.querySelector('[data-role="ly"]');
  box.innerHTML = lyricsLines
    .map((l, i) => `<div class="ly-line" data-i="${i}">${escapeHtml(l.text)}</div>`)
    .join('');
  syncLyricHighlight(player.audio?.currentTime || 0);
}

function syncLyricHighlight(t) {
  if (!lyricsPanel || !lyricsLines.length) return;
  let cur = -1;
  for (let i = 0; i < lyricsLines.length; i += 1) {
    if (lyricsLines[i].time >= 0 && lyricsLines[i].time <= t) cur = i;
  }
  const nodes = lyricsPanel.querySelectorAll('.ly-line');
  nodes.forEach((n, i) => n.classList.toggle('on', i === cur));
  if (cur >= 0 && nodes[cur]) {
    const box = lyricsPanel;
    const n = nodes[cur];
    const target = n.offsetTop - box.clientHeight / 2 + n.clientHeight / 2;
    box.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
  }
}

function ensureLyricsPanel() {
  if (lyricsPanel) return lyricsPanel;
  lyricsPanel = document.createElement('div');
  lyricsPanel.className = 'lyrics-panel hidden';
  document.body.appendChild(lyricsPanel);
  return lyricsPanel;
}

function toggleLyrics() {
  ensureLyricsPanel();
  if (lyricsPanel.classList.contains('hidden')) {
    lyricsPanel.classList.remove('hidden');
    if (player.lib && player.track) loadLyrics(player.lib, player.track);
  } else hideLyrics();
}
function hideLyrics() {
  lyricsPanel?.classList.add('hidden');
}

/* ================================================================ 歌单 */

function addToPlaylistDialog(lib, track) {
  const pls = getPlaylists();
  const body = `
    <div class="list" data-role="pls">
      ${pls
        .map(
          (p) => `<button class="row" data-id="${escapeHtml(p.id)}">
            <span class="r-idx">${icon('list', 15)}</span>
            <span class="r-main"><span class="r-title">${escapeHtml(p.name)}</span>
            <span class="r-sub">${p.tracks?.length || 0} 首</span></span></button>`
        )
        .join('') || '<div class="muted" style="padding:10px">还没有歌单</div>'}
    </div>
    <div class="form-row" style="margin-top:14px">
      <label>新建歌单</label>
      <input class="field" data-role="newname" placeholder="歌单名称"/>
    </div>
    <div class="alert info" style="margin-top:8px">歌单保存在本机：服务端 v0.9.83 没有 /api/media/playlists 端点，暂不支持跨端同步。</div>`;

  const d = modal({
    title: '加入歌单',
    body,
    actions: [
      { label: '关闭', className: 'ghost' },
      {
        label: '新建并加入',
        className: 'primary',
        keepOpen: true,
        onClick: (ov) => {
          const name = ov.querySelector('[data-role="newname"]').value.trim();
          if (!name) {
            toast('请输入歌单名称', 'err');
            return false;
          }
          const all = savePlaylist({ name, tracks: [track.path], libId: lib.id });
          toast(`已加入歌单「${escapeHtml(name)}」（仅本机）`, 'ok');
          d.close(null);
          return false;
        },
      },
    ],
  });

  d.el.querySelectorAll('[data-role="pls"] .row').forEach((b) => {
    b.addEventListener('click', () => {
      const id = b.dataset.id;
      const all = getPlaylists();
      const p = all.find((x) => x.id === id);
      if (!p) return;
      const tracks = [...(p.tracks || [])];
      if (!tracks.includes(track.path)) tracks.push(track.path);
      savePlaylist({ id, name: p.name, libId: lib.id, tracks });
      toast(`已加入歌单「${escapeHtml(p.name)}」（仅本机）`, 'ok');
      d.close(null);
      window.dispatchEvent(new CustomEvent('vh:playlists-changed'));
    });
  });
}

/* ================================================================ 音乐库视图 */

export async function renderAudioLibrary(mount, { lib, imageIndex, extra, onOpenDetail }) {
  if (!extra) {
    mount.innerHTML = `<div class="empty">${icon('warn', 42)}<div class="e-title">未加载到音频条目</div></div>`;
    return;
  }
  const trackCount = extra.tracks.length;
  let activeTab = 'albums';

  mount.innerHTML = `
    <div class="pad">
      <div class="audio-tabs">
        ${[
          ['albums', '专辑'],
          ['artists', '歌手'],
          ['playlists', '歌单'],
          ['favorites', '♥ 喜欢'],
          ['tracks', '曲目'],
        ]
          .map(([id, label]) => `<button class="tab" data-tab="${id}">${label}</button>`)
          .join('')}
        <span class="spacer grow"></span>
        <span class="badge">${trackCount} 首曲目 · ${extra.albums.length} 张专辑 · ${extra.artists.length} 位歌手</span>
      </div>
      <div data-role="body"></div>
    </div>`;

  const body = mount.querySelector('[data-role="body"]');

  const trackQueue = extra.tracks;
  const play = (t, queue) => playTrack(lib, t, queue || trackQueue, imageIndex);

  function paintAlbums() {
    body.innerHTML = '';
    const grid = document.createElement('div');
    grid.className = 'grid-posters';
    for (const al of extra.albums) {
      const card = document.createElement('button');
      card.className = 'card';
      const thumb = document.createElement('div');
      thumb.className = 'thumb';
      const cov = imageIndex ? imageIndex.pick(al.tracks[0].path) : '';
      thumb.appendChild(lazyImg(cov ? coverUrl(lib.id, cov, 320) : '', 'disc'));
      const tag = document.createElement('div');
      tag.className = 'tagline';
      tag.innerHTML = `<span>${al.tracks.length} 首</span><span>▶</span>`;
      thumb.appendChild(tag);
      card.appendChild(thumb);
      const t = document.createElement('div');
      t.className = 'title';
      t.textContent = al.album;
      const s = document.createElement('div');
      s.className = 'sub';
      s.textContent = al.artist;
      card.appendChild(t);
      card.appendChild(s);
      card.addEventListener('click', () => play(al.tracks[0], al.tracks));
      grid.appendChild(card);
    }
    body.appendChild(grid);
  }

  function paintTrackList(list, emptyMsg, { showAlbum = true } = {}) {
    body.innerHTML = '';
    if (!list.length) {
      body.innerHTML = `<div class="empty">${icon('music', 42)}<div class="e-title">${escapeHtml(emptyMsg)}</div></div>`;
      return;
    }
    const box = document.createElement('div');
    box.className = 'list';
    list.forEach((t, i) => {
      const b = document.createElement('button');
      b.className = 'row';
      const on = player.track && player.track.path === t.path;
      if (on) b.classList.add('active');
      b.innerHTML = `
        <span class="r-idx">${t.trackNo ?? i + 1}</span>
        <span class="r-main">
          <span class="r-title">${escapeHtml(t.title)}</span>
          <span class="r-sub">${escapeHtml(t.artist || '')}${showAlbum && t.album ? ` · ${escapeHtml(t.album)}` : ''}</span>
        </span>
        <span class="r-right">${fmtDuration(0)}</span>
        <span class="r-right">${fmtBytes(t.size)}</span>
        <span class="r-right" data-role="fav-${i}"></span>`;
      b.querySelector(`[data-role="fav-${i}"]`).innerHTML = isFavorite(lib.id, t.path)
        ? `<span style="color:var(--accent)">${icon('heart', 14)}</span>`
        : '';
      b.addEventListener('click', () => play(t, list));
      box.appendChild(b);
    });
    body.appendChild(box);
  }

  function paintArtists() {
    body.innerHTML = '';
    const grid = document.createElement('div');
    grid.className = 'grid-posters';
    for (const ar of extra.artists) {
      const card = document.createElement('button');
      card.className = 'card';
      const thumb = document.createElement('div');
      thumb.className = 'thumb';
      thumb.style.borderRadius = '50%';
      const cov = imageIndex ? imageIndex.pick(ar.tracks[0].path) : '';
      thumb.appendChild(lazyImg(cov ? coverUrl(lib.id, cov, 320) : '', 'user'));
      card.appendChild(thumb);
      const t = document.createElement('div');
      t.className = 'title';
      t.textContent = ar.name;
      t.style.textAlign = 'center';
      const s = document.createElement('div');
      s.className = 'sub';
      s.style.textAlign = 'center';
      s.textContent = `${ar.albumCount} 张专辑 · ${ar.tracks.length} 首`;
      card.appendChild(t);
      card.appendChild(s);
      card.addEventListener('click', () => paintTrackList(ar.tracks, '该歌手没有曲目'));
      grid.appendChild(card);
    }
    body.appendChild(grid);
  }

  function paintFavorites() {
    const favs = getFavorites()[lib.id] || {};
    const list = extra.tracks.filter((t) => favs[t.path]);
    paintTrackList(list, '本机还没有喜欢的歌曲。在曲目列表或播放条点 ♥ 加入。');
  }

  function paintPlaylists() {
    body.innerHTML = '';
    const pls = getPlaylists();
    const head = document.createElement('div');
    head.className = 'alert info';
    head.innerHTML = `歌单保存在本机 —— 服务端 v0.9.83 没有 <code>/api/media/playlists</code> 端点，暂不支持与 Web 端 / 安卓端同步。`;
    body.appendChild(head);

    const newRow = document.createElement('div');
    newRow.style.cssText = 'display:flex;gap:8px;margin-bottom:14px;max-width:520px';
    newRow.innerHTML = `<input class="field" placeholder="新歌单名称" data-role="npl"/>
      <button class="btn primary" data-role="cpl">${icon('plus', 14)} 新建</button>`;
    newRow.querySelector('[data-role="cpl"]').addEventListener('click', () => {
      const name = newRow.querySelector('[data-role="npl"]').value.trim();
      if (!name) return toast('请输入歌单名称', 'err');
      savePlaylist({ name, libId: lib.id, tracks: [] });
      toast(`已新建歌单「${escapeHtml(name)}」`, 'ok');
      paintPlaylists();
    });
    body.appendChild(newRow);

    if (!pls.length) {
      body.insertAdjacentHTML('beforeend', `<div class="empty">${icon('list', 42)}<div class="e-title">还没有歌单</div></div>`);
      return;
    }
    const box = document.createElement('div');
    box.className = 'list';
    for (const p of pls) {
      const tracks = (p.tracks || []).map((path) => extra.tracks.find((t) => t.path === path)).filter(Boolean);
      const row = document.createElement('div');
      row.className = 'row';
      row.innerHTML = `
        <span class="r-idx">${icon('list', 15)}</span>
        <span class="r-main">
          <span class="r-title">${escapeHtml(p.name)}</span>
          <span class="r-sub">${tracks.length} 首（本机）</span>
        </span>
        <button class="btn sm" data-role="p">播放</button>
        <button class="icon-btn" data-role="d" title="删除">${icon('trash', 15)}</button>`;
      row.querySelector('[data-role="p"]').addEventListener('click', (e) => {
        e.stopPropagation();
        if (!tracks.length) return toast('歌单是空的', 'warn');
        play(tracks[0], tracks);
      });
      row.querySelector('[data-role="d"]').addEventListener('click', async (e) => {
        e.stopPropagation();
        const ok = await confirmDialog('删除歌单', `确定删除「${escapeHtml(p.name)}」？`, '删除');
        if (!ok) return;
        deletePlaylist(p.id);
        paintPlaylists();
      });
      row.addEventListener('click', () => {
        if (!tracks.length) return toast('歌单是空的', 'warn');
        paintTrackList(tracks, '空歌单', { showAlbum: true });
      });
      box.appendChild(row);
    }
    body.appendChild(box);
  }

  function paint() {
    mount.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === activeTab));
    if (activeTab === 'albums') paintAlbums();
    else if (activeTab === 'artists') paintArtists();
    else if (activeTab === 'playlists') paintPlaylists();
    else if (activeTab === 'favorites') paintFavorites();
    else paintTrackList(extra.tracks, '该媒体库没有音频文件');
  }

  mount.querySelectorAll('[data-tab]').forEach((b) =>
    b.addEventListener('click', () => {
      activeTab = b.dataset.tab;
      paint();
    })
  );

  window.addEventListener('vh:track-changed', paint);
  window.addEventListener('vh:playlists-changed', () => {
    if (activeTab === 'playlists') paintPlaylists();
  });

  paint();

  // 当前正在播放的曲目高亮
  if (player.track) paintPlayState();
}

export function audioBarVisible() {
  return !!document.querySelector('.abar') && !document.querySelector('.abar').classList.contains('hidden');
}
