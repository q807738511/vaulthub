/* ============================================================================
   剧集详情：季 / 集网格 + 服务端元数据（本地 NFO / TMDB 刮削结果）
   展示格式对齐 Web 端：季标题「剧名 第N季 共M集」，集数按网格展示，点集即播。
   ========================================================================= */

import * as api from '../api.js';
import { coverUrl, fmtBytes, fmtDuration, escapeHtml, cleanTitle, basename } from '../util.js';
import { icon, libIcon, bigImg, toast, modal } from '../ui.js';
import { getResume, listResume } from '../state.js';

export async function renderSeriesDetail(mount, { lib, item, imageIndex, onPlay }) {
  const show = item.show;
  const cover = imageIndex ? imageIndex.pick(item.path) : '';

  mount.innerHTML = `
    <div class="pad">
      <div class="detail-head">
        <div class="detail-poster"></div>
        <div class="detail-info">
          <h1>${escapeHtml(item.title)}</h1>
          <div class="detail-meta" data-role="meta">
            <span class="badge accent">${libIcon('series')} 剧集</span>
            <span class="badge">${show.seasonList.length} 季</span>
            <span class="badge">${show.episodeCount} 集</span>
            <span class="badge">${fmtBytes(show.size)}</span>
          </div>
          <div class="detail-actions">
            <button class="btn primary" data-act="play-first">${icon('play', 15)} 播放第一集</button>
            <button class="btn" data-act="play-last">${icon('clock', 15)} 继续观看</button>
            <button class="btn" data-act="info">${icon('info', 15)} 媒体信息</button>
          </div>
          <div class="detail-desc" data-role="desc"><span class="muted">正在读取元数据…</span></div>
        </div>
      </div>
      <div data-role="seasons"></div>
    </div>`;

  mount.querySelector('.detail-poster').appendChild(bigImg(cover ? coverUrl(lib.id, cover, 1280) : '', 'tv'));

  const flat = [];
  for (const s of show.seasonList) for (const e of s.episodes) flat.push(e);

  mount.querySelector('[data-act="play-first"]').addEventListener('click', () => {
    if (flat.length) onPlay(lib, { path: flat[0].path, title: cleanTitle(flat[0].path), size: flat[0].size });
  });

  mount.querySelector('[data-act="play-last"]').addEventListener('click', async () => {
    // 优先本机续播记录
    const resumes = listResume().filter((r) => r.libId === lib.id && r.path.startsWith(`${show.name}/`));
    if (resumes.length) {
      const r = resumes[0];
      return onPlay(lib, { path: r.path, title: cleanTitle(r.path), size: 0 });
    }
    // 其次服务端阅读进度（部分内容也会写这里）
    try {
      const pr = await api.readingProgress(lib.id);
      const items = pr.items || {};
      const hit = Object.entries(items)
        .filter(([p]) => p.startsWith(`${show.name}/`))
        .sort((a, b) => (b[1].updated_at || 0) - (a[1].updated_at || 0))[0];
      if (hit) return onPlay(lib, { path: hit[0], title: cleanTitle(hit[0]), size: 0 });
    } catch {
      /* 无进度则忽略 */
    }
    if (flat.length) onPlay(lib, { path: flat[0].path, title: cleanTitle(flat[0].path), size: flat[0].size });
    else toast('没有可播放的集', 'warn');
  });

  mount.querySelector('[data-act="info"]').addEventListener('click', () => {
    const rows = [
      ['剧名（目录）', show.name],
      ['季数', String(show.seasonList.length)],
      ['集数', String(show.episodeCount)],
      ['合计大小', fmtBytes(show.size)],
      ['媒体库', `${lib.name}（${lib.id}）`],
      ['首集路径', flat[0] ? flat[0].path : '-'],
    ];
    modal({
      title: '剧集信息',
      body: `<div class="kv">${rows.map(([k, v]) => `<div class="k">${escapeHtml(k)}</div><div class="v">${escapeHtml(v)}</div>`).join('')}</div>`,
      actions: [{ label: '关闭', className: 'ghost' }],
    });
  });

  // 季 / 集
  const seasonsBox = mount.querySelector('[data-role="seasons"]');
  const multiSeason = show.seasonList.length > 1;
  for (const s of show.seasonList) {
    const sec = document.createElement('div');
    sec.className = 'season';
    const label = s.no > 0
      ? `${item.title} 第${s.no}季 共${s.episodes.length}集`
      : `${item.title} 共${s.episodes.length}集`;
    sec.innerHTML = `<div class="season-head">${icon('tv', 16)}<span>${escapeHtml(label)}</span>
      <span class="muted" style="font-size:12px;font-weight:400">${fmtBytes(s.episodes.reduce((a, b) => a + (b.size || 0), 0))}</span></div>`;
    const grid = document.createElement('div');
    grid.className = 'ep-grid';
    for (const ep of s.episodes) {
      const b = document.createElement('button');
      b.className = 'ep';
      const no = ep.episode !== null && ep.episode !== undefined ? ep.episode : '';
      const resume = getResume(lib.id, ep.path);
      b.innerHTML = `
        <span class="ep-no">${no === '' ? '·' : `E${String(no).padStart(2, '0')}`}</span>
        <span class="ep-txt">
          <span class="ep-name">${escapeHtml(cleanTitle(ep.path))}</span>
          <span class="ep-size">${fmtBytes(ep.size)}${resume ? ` · 已看到 ${fmtDuration(resume.position_ms / 1000)}` : ''}</span>
        </span>
        ${icon('play', 14)}`;
      b.addEventListener('click', () => onPlay(lib, { path: ep.path, title: cleanTitle(ep.path), size: ep.size }));
      grid.appendChild(b);
    }
    sec.appendChild(grid);
    seasonsBox.appendChild(sec);
  }

  // 服务端元数据（异步补全）
  const descEl = mount.querySelector('[data-role="desc"]');
  try {
    const md = await api.metadata(lib.id, item.path);
    const bits = [];
    if (md.title) bits.push(md.title);
    if (md.year) bits.push(`(${md.year})`);
    if (md.overview) bits.push(`\n\n${md.overview}`);
    else if (md.plot) bits.push(`\n\n${md.plot}`);
    if (md.genres && md.genres.length) bits.push(`\n\n类型：${md.genres.join(' / ')}`);
    if (md.cast && md.cast.length) bits.push(`\n\n演职：${md.cast.slice(0, 12).join('、')}`);
    descEl.textContent = bits.length ? bits.join('') : '（该剧集暂无本地元数据；服务端刮削未返回简介）';
    const metaBox = mount.querySelector('[data-role="meta"]');
    if (md.provider) {
      const sp = document.createElement('span');
      sp.className = 'badge';
      sp.textContent = `来源：${md.provider}`;
      metaBox.appendChild(sp);
    }
    const h1 = mount.querySelector('h1');
    if (md.title && md.title !== item.title) h1.textContent = md.title;
  } catch (err) {
    descEl.innerHTML = `<span class="muted">元数据读取失败：${escapeHtml(err.message)}</span>`;
  }
}
