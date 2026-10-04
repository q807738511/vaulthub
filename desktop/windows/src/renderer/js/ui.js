/* ============================================================================
   UI 基础件：图标、提示、弹窗、懒加载图片、进度条
   ========================================================================= */

import { escapeHtml } from './util.js';

/* ---------------------------------------------------------------- 图标 */

const P = {
  home: 'M3 10.5 12 3l9 7.5V21a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z',
  film: 'M3 4h18v16H3zM7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4',
  tv: 'M3 5h18v12H3zM8 21h8M12 17v4',
  book: 'M4 4h7a3 3 0 0 1 3 3v13a2.5 2.5 0 0 0-2.5-2.5H4zM20 4h-5a3 3 0 0 0-3 3v13a2.5 2.5 0 0 1 2.5-2.5H20z',
  comic: 'M4 4h13l3 3v13H4zM17 4v3h3',
  music: 'M9 18V5l11-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0m11-2a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
  search: 'M11 19a8 8 0 1 1 0-16 8 8 0 0 1 0 16m10 2-4.35-4.35',
  back: 'M15 18l-6-6 6-6',
  fwd: 'M9 18l6-6-6-6',
  close: 'M6 6l12 12M18 6L6 18',
  settings: 'M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-2.87 1.2v.17a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 7.9 19.9l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4 15.4H3.83a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.1 7.9l-.06-.06A2 2 0 1 1 6.87 5.01l.06.06a1.7 1.7 0 0 0 2.87-1.2V3.7a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 2.87 1.2l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0 1.2 2.87h.17a2 2 0 1 1 0 4h-.09z',
  sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4',
  moon: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z',
  play: 'M6 4l14 8-14 8z',
  pause: 'M8 5h4v14H8zM12 5h4v14h-4z',
  next: 'M6 4l10 8-10 8zM18 4v16',
  prev: 'M18 4L8 12l10 8zM6 4v16',
  volume: 'M11 5 6 9H3v6h3l5 4zM16 9a4 4 0 0 1 0 6M19 6a8 8 0 0 1 0 12',
  mute: 'M11 5 6 9H3v6h3l5 4zM22 9l-6 6M16 9l6 6',
  expand: 'M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3',
  refresh: 'M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6',
  heart: 'M12 21s-8-4.6-8-10a4.5 4.5 0 0 1 8-2.8A4.5 4.5 0 0 1 20 11c0 5.4-8 10-8 10z',
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  plus: 'M12 5v14M5 12h14',
  check: 'M20 6 9 17l-5-5',
  info: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 16v-4M12 8h.01',
  warn: 'M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01',
  user: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  clock: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2',
  disc: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4',
  sidebar: 'M3 4h18v16H3zM9 4v16',
  zoomIn: 'M11 19a8 8 0 1 1 0-16 8 8 0 0 1 0 16m10 2-4.35-4.35M11 8v6M8 11h6',
  zoomOut: 'M11 19a8 8 0 1 1 0-16 8 8 0 0 1 0 16m10 2-4.35-4.35M8 11h6',
  fit: 'M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3',
  single: 'M5 3h14v18H5z',
  pages: 'M3 3h8v18H3zM13 3h8v18h-8z',
  subtitle: 'M3 5h18v14H3zM7 15h4M13 15h4M7 11h10',
  speed: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 12l4-4',
  external: 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14 21 3',
  trash: 'M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6',
  grid: 'M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z',
  italic: 'M19 4h-9M14 20H5M15 4 9 20',
  download: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3',
  palette: 'M12 22a10 10 0 1 1 0-20c5.5 0 10 3.6 10 8 0 2.5-2 4-4.5 4H15a2 2 0 0 0-2 2c0 .6.2 1 .5 1.4.3.4.5.8.5 1.3 0 1.3-1 1.8-2 1.8z',
  search2: 'M11 19a8 8 0 1 1 0-16 8 8 0 0 1 0 16m10 2-4.35-4.35',
  zap: 'M13 2 3 14h8l-1 8 10-12h-8z',
};

export function icon(name, size = 16, cls = '') {
  const d = P[name] || P.info;
  return `<svg class="ico ${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"
    aria-hidden="true"><path d="${d}"/></svg>`;
}

export const LIB_ICON = { movie: 'film', series: 'tv', comic: 'comic', book: 'book', audio: 'music' };
export const libIcon = (type) => icon(LIB_ICON[type] || 'folder', 18);

/* ---------------------------------------------------------------- Toast */

let toastHost = null;

export function toast(message, kind = 'info', ms = 4200) {
  if (!toastHost) {
    toastHost = document.createElement('div');
    toastHost.className = 'toasts';
    document.body.appendChild(toastHost);
  }
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `${String(message)}`;
  toastHost.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity 200ms';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 220);
  }, ms);
  return el;
}

/* ---------------------------------------------------------------- 弹窗 */

export function modal({ title = '', body = '', actions = [], width }) {
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  overlay.innerHTML = `
    <div class="modal" ${width ? `style="width:min(${width},94vw)"` : ''} role="dialog" aria-modal="true">
      <div class="modal-head">
        <h3>${escapeHtml(title)}</h3>
        <button class="icon-btn" data-act="__close" title="关闭">${icon('close', 16)}</button>
      </div>
      <div class="modal-body"></div>
      <div class="modal-foot"></div>
    </div>`;
  overlay.querySelector('.modal-body').innerHTML = body;

  const foot = overlay.querySelector('.modal-foot');
  const close = (v) => {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
    resolveClose(v);
  };
  let resolveClose = () => {};
  const done = new Promise((r) => {
    resolveClose = r;
  });
  const onKey = (e) => {
    if (e.key === 'Escape') close(null);
  };

  actions.forEach((a) => {
    const b = document.createElement('button');
    b.className = `btn ${a.className || ''}`;
    b.textContent = a.label;
    b.addEventListener('click', async () => {
      if (a.onClick) {
        const r = await a.onClick(overlay);
        if (r === false) return; // 阻止关闭
      }
      if (a.keepOpen) return;
      close(a.value ?? null);
    });
    foot.appendChild(b);
  });

  overlay.querySelector('[data-act="__close"]').addEventListener('click', () => close(null));
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) close(null);
  });
  document.addEventListener('keydown', onKey);
  document.body.appendChild(overlay);
  done.close = close;
  done.el = overlay;
  return done;
}

export function confirmDialog(title, message, confirmLabel = '确定') {
  return modal({
    title,
    body: `<div style="font-size:13px;line-height:1.8;color:var(--text2)">${message}</div>`,
    actions: [
      { label: '取消', value: false, className: 'ghost' },
      { label: confirmLabel, value: true, className: 'primary' },
    ],
  });
}

/* ---------------------------------------------------------------- 懒加载图片 */

const io = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const img = e.target;
      io.unobserve(img);
      const src = img.dataset.src;
      if (src) img.src = src;
    }
  },
  { rootMargin: '360px 0px' }
);

/**
 * 生成一个懒加载图片元素。
 * @param {string} src  图片地址（为空则直接显示占位）
 * @param {string} ph   占位字符（图标名或文字）
 */
export function lazyImg(src, ph = '') {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'position:absolute;inset:0';
  if (!src) {
    wrap.innerHTML = `<div class="ph">${ph ? icon(ph, 30) : ''}</div>`;
    return wrap;
  }
  const img = document.createElement('img');
  img.alt = '';
  img.loading = 'lazy';
  img.decoding = 'async';
  img.dataset.src = src;
  img.addEventListener('load', () => img.classList.add('loaded'));
  img.addEventListener('error', () => {
    img.remove();
    wrap.insertAdjacentHTML('beforeend', `<div class="ph">${ph ? icon(ph, 30) : ''}</div>`);
  });
  wrap.appendChild(img);
  io.observe(img);
  return wrap;
}

/** 详情页大图（立即加载，不走 observer） */
export function bigImg(src, ph = '') {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'position:absolute;inset:0';
  if (!src) {
    wrap.innerHTML = `<div class="ph">${ph ? icon(ph, 40) : ''}</div>`;
    return wrap;
  }
  const img = document.createElement('img');
  img.alt = '';
  img.decoding = 'async';
  img.src = src;
  img.addEventListener('error', () => {
    img.remove();
    wrap.insertAdjacentHTML('beforeend', `<div class="ph">${ph ? icon(ph, 40) : ''}</div>`);
  });
  wrap.appendChild(img);
  return wrap;
}

/* ---------------------------------------------------------------- 可拖动进度条 */

/**
 * @param {{onSeek:(ratio:number)=>void, onScrub?:(ratio:number|null)=>void}} opts
 */
export function seekBar({ onSeek, onScrub } = {}) {
  const el = document.createElement('div');
  el.className = 'seek';
  el.innerHTML = `<div class="track"><div class="buf"></div><div class="fill"></div><div class="knob"></div></div>`;
  const buf = el.querySelector('.buf');
  const fill = el.querySelector('.fill');
  const knob = el.querySelector('.knob');

  const ratioAt = (e) => {
    const r = el.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  };
  let dragging = false;
  const apply = (r) => {
    const pct = `${(r * 100).toFixed(3)}%`;
    fill.style.width = pct;
    knob.style.left = pct;
  };
  el.addEventListener('mousedown', (e) => {
    dragging = true;
    el.setPointerCapture?.(e.pointerId ?? 1);
    const r = ratioAt(e);
    apply(r);
    onScrub?.(r);
    e.preventDefault();
  });
  el.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const r = ratioAt(e);
    apply(r);
    onScrub?.(r);
  });
  const end = (e) => {
    if (!dragging) return;
    dragging = false;
    const r = ratioAt(e);
    onScrub?.(null);
    onSeek?.(r);
  };
  el.addEventListener('mouseup', end);
  el.addEventListener('mouseleave', (e) => {
    if (dragging) end(e);
  });

  return {
    el,
    setProgress(r) {
      if (!dragging) apply(Math.min(1, Math.max(0, r || 0)));
    },
    setBuffered(r) {
      buf.style.width = `${(Math.min(1, Math.max(0, r || 0)) * 100).toFixed(3)}%`;
    },
  };
}

/* ---------------------------------------------------------------- 小工具 */

export function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

export function installImageFallback() {
  // 图片失败时的兜底在 lazyImg/bigImg 内已处理；此处无需全局监听
}
