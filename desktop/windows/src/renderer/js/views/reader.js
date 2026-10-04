/* ============================================================================
   阅读器：漫画（zip/cbz 内页）与电子书（EPUB / TXT / PDF）
   - 漫画：GET /api/media/archive/zip/register 取页清单 → /archive/zip/page 逐页取图
   - EPUB：GET /api/media/document/epub → chapters[{title,text}]（text 含 XML，需清洗）
   - TXT ：GET /api/media/file → 自动识别 UTF-8/GBK/BIG5 后分页
   - 进度：PUT /api/media/reading/progress（服务端持久化，Web 端与安卓端可见）
   ========================================================================= */

import * as api from '../api.js';
import {
  fmtBytes, escapeHtml, basename, cleanTitle, debounce, extname, decodeText,
  buildEbookChapters, loadEbookFontPref, saveEbookFontPref, applyEbookFontPref,
  EBOOK_FONT_MIN, EBOOK_FONT_MAX,
} from '../util.js';
import {
  state, getComicPrefs, setComicPrefs, comicTranscodeWidth, COMIC_PREFETCH_AHEAD,
} from '../state.js';
import { qualityPageWidth, weakNetworkActive, qualityLabelText, qualityProfile } from '../quality.js';
import { icon, toast, modal } from '../ui.js';

let host = null;
let session = null; // 当前阅读会话

function ensureHost() {
  if (host) return host;
  host = document.createElement('div');
  host.className = 'reader hidden';
  host.innerHTML = `
    <div class="reader-bar">
      <button class="icon-btn" data-act="close" title="关闭 (Esc)">${icon('close', 18)}</button>
      <span data-role="toc-btn"></span>
      <div class="rb-title" data-role="title"></div>
      <span data-role="tools"></span>
      <span class="badge" data-role="pos"></span>
    </div>
    <div class="reader-body" data-role="body"></div>
    <div class="reader-foot">
      <span data-role="foot-l"></span>
      <span class="grow"></span>
      <span data-role="sync"></span>
      <span data-role="foot-r"></span>
    </div>`;
  document.body.appendChild(host);

  host.querySelector('[data-act="close"]').addEventListener('click', close);
  document.addEventListener('keydown', onKey);
  return host;
}

/* ---------------------------------------------------------------- 打开 */

export async function open(lib, item) {
  ensureHost();
  host.classList.remove('hidden');
  host.querySelector('[data-role="title"]').textContent = item.title || basename(item.path);
  const body = host.querySelector('[data-role="body"]');
  body.className = 'reader-body';
  body.innerHTML = `<div class="empty"><span class="spinner"></span><div class="e-title">正在打开…</div></div>`;
  setTools([]);
  setPos('');

  const ext = extname(item.path);
  try {
    if (lib.type === 'comic' || ['.zip', '.cbz', '.rar', '.cbr', '.7z'].includes(ext)) {
      await openComic(lib, item);
    } else if (ext === '.epub') {
      await openEpub(lib, item);
    } else if (ext === '.pdf') {
      await openPdf(lib, item);
    } else {
      await openText(lib, item);
    }
  } catch (err) {
    body.innerHTML = `<div class="empty">${icon('warn', 42)}<div class="e-title">无法打开</div>
      <div class="e-hint">${escapeHtml(err.message)}</div>
      <div class="e-hint muted">文件：${escapeHtml(item.path)}</div></div>`;
  }
}

export function close() {
  if (!host) return;
  if (session?.flush) session.flush();
  if (session?.onClose) session.onClose();
  host.classList.add('hidden');
  const body = host.querySelector('[data-role="body"]');
  body.innerHTML = '';
  body.className = 'reader-body';
  session = null;
}

export function isOpen() {
  return host && !host.classList.contains('hidden');
}

/* ---------------------------------------------------------------- 头部工具 */

function setTools(defs) {
  const box = host.querySelector('[data-role="tools"]');
  box.innerHTML = '';
  for (const d of defs) {
    if (d.type === 'sep') {
      const s = document.createElement('span');
      s.style.cssText = 'width:1px;height:20px;background:var(--border2);margin:0 4px';
      box.appendChild(s);
      continue;
    }
    if (d.type === 'select') {
      const sel = document.createElement('select');
      sel.className = 'field';
      sel.style.width = d.width || '86px';
      sel.style.height = '28px';
      for (const o of d.options) {
        const op = document.createElement('option');
        op.value = o.value;
        op.textContent = o.label;
        if (o.value === d.value) op.selected = true;
        sel.appendChild(op);
      }
      sel.addEventListener('change', () => d.onChange(sel.value));
      box.appendChild(sel);
      continue;
    }
    const b = document.createElement('button');
    b.className = `icon-btn ${d.on ? 'on' : ''}`;
    b.title = d.title || '';
    b.innerHTML = icon(d.icon, 17);
    if (d.onClick) b.addEventListener('click', d.onClick);
    box.appendChild(b);
  }
}

function setPos(t) {
  host.querySelector('[data-role="pos"]').textContent = t;
}

function setFoot(l, r) {
  if (l !== undefined) host.querySelector('[data-role="foot-l"]').innerHTML = l;
  if (r !== undefined) host.querySelector('[data-role="foot-r"]').innerHTML = r;
}

function setSync(html) {
  host.querySelector('[data-role="sync"]').innerHTML = html;
}

/* ---------------------------------------------------------------- 进度（服务端） */

function makeProgressWriter(libId, path, getState) {
  let lastSent = 0;
  let lastErr = 0;
  const write = async (force = false) => {
    const s = getState();
    if (!s || !s.total) return;
    const now = Date.now();
    if (!force && now - lastSent < 4000) return;
    lastSent = now;
    try {
      // 字段与 v0.9.88 的 saveReadingProgress 一致：progress 归一到 0–100，
      // page/total 为 0 时不覆盖服务端已有值。
      const progress =
        typeof s.progress === 'number'
          ? Math.max(0, Math.min(100, s.progress))
          : Math.max(0, Math.min(100, (s.page / s.total) * 100));
      const payload = { progress: Number(progress.toFixed(3)) };
      if (Number(s.page) > 0) payload.page = Number(s.page);
      if (Number(s.total) > 0) payload.total = Number(s.total);
      await api.readingProgressPut(libId, path, payload);
      setSync(`<span class="badge ok">${icon('check', 12)} 进度已同步到服务端</span>`);
    } catch (err) {
      if (Date.now() - lastErr > 15000) {
        lastErr = Date.now();
        setSync(`<span class="badge err">进度同步失败：${escapeHtml(err.message)}</span>`);
      }
    }
  };
  const debounced = debounce(() => write(false), 1200);
  return { write, debounced };
}

async function loadServerProgress(libId, path) {
  try {
    const r = await api.readingProgress(libId, path);
    if (!r) return null;
    // 实测：服务端始终返回 {id, items:{ "<path>": {progress,page,total,updated_at} }}，
    // 即使带了 path 也不会收窄成单条，所以必须自己按 path 取值。
    if (r.items && typeof r.items === 'object') return r.items[path] || null;
    if (typeof r.page === 'number' || typeof r.progress === 'number') return r;
    return null;
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------------- 漫画 */

async function openComic(lib, item) {
  const body = host.querySelector('[data-role="body"]');
  body.innerHTML = `<div class="empty"><span class="spinner"></span><div class="e-title">正在读取压缩包页清单…</div></div>`;

  const reg = await api.zipRegister(lib.id, item.path);
  const entries = (reg.entries || []).filter((e) => /\.(jpe?g|png|webp|gif|bmp|avif)$/i.test(e.name || e.raw || ''));
  if (!entries.length) {
    body.innerHTML = `<div class="empty">${icon('warn', 42)}<div class="e-title">压缩包内没有图片页</div>
      <div class="e-hint">共 ${reg.total || 0} 个条目，未发现可显示的图片。</div></div>`;
    return;
  }

  const prefs = getComicPrefs();
  let idx = 0;
  // 阅读模式：scroll = 连续滚动，double = 双页，single = 单页（v0.9.88 默认 single）
  let mode = ['single', 'double', 'scroll'].includes(prefs.mode) ? prefs.mode : 'single';
  let zoom = 1;
  // v0.9.88 的 comicPrefs 默认 rtl:true（日式漫画从右到左）
  let rtl = prefs.rtl !== false;

  const server = await loadServerProgress(lib.id, item.path);
  if (server && typeof server.page === 'number' && server.page >= 1 && server.page <= entries.length) {
    idx = server.page - 1;
    toast(`已恢复到服务端记录的进度：第 ${server.page} / ${entries.length} 页`, 'info', 3200);
  }

  const writer = makeProgressWriter(lib.id, item.path, () => ({ page: idx + 1, total: entries.length }));

  const pageUrl = (i, w) => api.urls.zipPageUrl(lib.id, item.path, entries[i].name || entries[i].raw, w);

  /**
   * 取图宽度：显式画质档位优先（原画 0 / 高清 1600 / 流畅 1200 / 极省 900）；
   * 「自动」档交回省流判定（弱网 → prefs.width，否则 0 = 原图直出）。
   * 0 表示原图直出，不传 w。与 v0.9.88 的 comicTranscodeWidth 一致。
   */
  const serverWidth = () => comicTranscodeWidth(qualityPageWidth(), weakNetworkActive);

  /* 预取后 3 页（v0.9.88 的 COMIC_PREFETCH_AHEAD = 3），翻页时不至于空白 */
  const prefetched = new Set();
  function prefetchAhead() {
    const w = serverWidth();
    for (let k = 1; k <= COMIC_PREFETCH_AHEAD; k += 1) {
      const i = idx + k;
      if (i >= entries.length) break;
      const u = pageUrl(i, w);
      if (prefetched.has(u)) continue;
      prefetched.add(u);
      const im = new Image();
      im.decoding = 'async';
      im.src = u;
    }
  }

  function paint() {
    const w = serverWidth();
    const pageImg = (i) => {
      const img = document.createElement('img');
      img.className = 'comic-page';
      img.decoding = 'async';
      img.loading = 'eager';
      img.style.width = `${Math.round(zoom * 100)}%`;
      img.src = pageUrl(i, w);
      img.dataset.i = String(i);
      return img;
    };

    if (mode === 'scroll') {
      body.className = 'reader-body scroll';
      body.innerHTML = '';
      entries.forEach((_, i) => {
        const img = pageImg(i);
        img.loading = i < 3 ? 'eager' : 'lazy';
        body.appendChild(img);
      });
      const target = body.querySelector(`img[data-i="${idx}"]`);
      if (target) target.scrollIntoView({ block: 'start' });
    } else if (mode === 'double') {
      body.className = 'reader-body paged';
      body.innerHTML = '';
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:2px;align-items:center;justify-content:center;max-width:100%;max-height:100%';
      // 右到左时先放后一页
      const pair = rtl ? [idx + 1, idx] : [idx, idx + 1];
      for (const i of pair) {
        if (i < 0 || i >= entries.length) continue;
        const img = pageImg(i);
        img.style.width = `${Math.round((zoom * 100) / 2)}%`;
        row.appendChild(img);
      }
      body.appendChild(row);
    } else {
      body.className = 'reader-body paged';
      body.innerHTML = '';
      body.appendChild(pageImg(idx));
    }

    setPos(`${idx + 1} / ${entries.length}`);
    setFoot(
      `<b>${escapeHtml(item.title)}</b> · 第 ${idx + 1} 页 · ${qualityLabelText()}`,
      `${escapeHtml(basename(item.path))} · ${fmtBytes(item.size)} · 共 ${entries.length} 页 · ${serverWidth() ? `服务端转码 ${serverWidth()}px` : '原图直出'}`
    );
    setSync('读取服务端阅读进度中…');
    writer.debounced();
    if (mode !== 'scroll') prefetchAhead();
  }

  function goto(i, { silent } = {}) {
    idx = Math.min(entries.length - 1, Math.max(0, i));
    if (mode === 'scroll') {
      const target = body.querySelector(`img[data-i="${idx}"]`);
      if (target) target.scrollIntoView({ block: 'start', behavior: silent ? 'auto' : 'smooth' });
      setPos(`${idx + 1} / ${entries.length}`);
    } else {
      paint();
    }
  }

  /* 翻页方向：rtl 时「下一页」是往左（索引减小） */
  const step = (delta) => goto(idx + (rtl ? -delta : delta));
  const cycleMode = () => {
    const order = ['single', 'double', 'scroll'];
    mode = order[(order.indexOf(mode) + 1) % order.length];
    setComicPrefs({ mode });
    paint();
    toast(`阅读模式：${{ single: '单页', double: '双页', scroll: '连续滚动' }[mode]}`, 'info', 1600);
  };
  const cycleFit = () => {
    zoom = zoom >= 2 ? 1 : Math.round((zoom + 0.25) * 100) / 100;
    paint();
  };

  setTools([
    { icon: 'back', title: rtl ? '上一页（→ 方向）' : '上一页 (←)', onClick: () => step(-1) },
    { icon: 'fwd', title: rtl ? '下一页（← 方向）' : '下一页 (→)', onClick: () => step(1) },
    { type: 'sep' },
    { icon: 'zoomOut', title: '缩小', onClick: () => { zoom = Math.max(0.5, zoom - 0.25); paint(); } },
    { icon: 'zoomIn', title: '放大', onClick: () => { zoom = Math.min(3, zoom + 0.25); paint(); } },
    { icon: 'fit', title: '适应窗口 / 放大', onClick: cycleFit },
    { type: 'sep' },
    { icon: 'pages', title: '阅读模式：单页 / 双页 / 连续滚动', on: mode !== 'single', onClick: cycleMode },
    {
      icon: 'refresh',
      title: `翻页方向：${rtl ? '右到左（日式）' : '左到右'}`,
      on: rtl,
      onClick: () => {
        rtl = !rtl;
        setComicPrefs({ rtl });
        paint();
        toast(`翻页方向：${rtl ? '右到左' : '左到右'}`, 'info', 1600);
      },
    },
    { icon: 'list', title: '页码跳转', onClick: jumpDialog },
  ]);

  function jumpDialog() {
    const d = modal({
      title: '跳转到页',
      body: `<div class="form-row"><label>页码（1 - ${entries.length}）</label>
        <input class="field" type="number" min="1" max="${entries.length}" value="${idx + 1}" data-role="p"/></div>`,
      actions: [
        { label: '取消', className: 'ghost' },
        {
          label: '跳转',
          className: 'primary',
          keepOpen: true,
          onClick: (ov) => {
            const v = parseInt(ov.querySelector('[data-role="p"]').value, 10);
            if (!v || v < 1 || v > entries.length) {
              toast('页码超出范围', 'err');
              return false;
            }
            goto(v - 1);
            d.close(null);
            return false;
          },
        },
      ],
    });
  }

  // 连续滚动模式下的滚动进度
  body.addEventListener('scroll', () => {
    if (mode !== 'scroll') return;
    const imgs = [...body.querySelectorAll('img')];
    const mid = body.scrollTop + body.clientHeight / 2;
    let best = idx;
    for (let i = 0; i < imgs.length; i += 1) {
      if (imgs[i].offsetTop <= mid) best = i;
    }
    if (best !== idx) {
      idx = best;
      setPos(`${idx + 1} / ${entries.length}`);
      writer.debounced();
    }
  });

  session = {
    kind: 'comic',
    next: () => step(1),
    prev: () => step(-1),
    flush: () => writer.write(true),
  };
  paint();
}

/* ---------------------------------------------------------------- EPUB */

function stripMarkup(s) {
  return String(s)
    .replace(/<\?xml[^>]*\?>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function openEpub(lib, item) {
  const body = host.querySelector('[data-role="body"]');
  body.innerHTML = `<div class="empty"><span class="spinner"></span><div class="e-title">正在解析 EPUB…</div></div>`;

  const doc = await api.epubDocument(lib.id, item.path);
  const chapters = (doc.chapters || []).map((c) => ({ title: c.title || '', text: stripMarkup(c.text || '') }));
  if (!chapters.length) {
    body.innerHTML = `<div class="empty">${icon('warn', 42)}<div class="e-title">EPUB 内没有可读章节</div></div>`;
    return;
  }

  let idx = 0;
  let tocOpen = false;
  const server = await loadServerProgress(lib.id, item.path);
  if (server && typeof server.page === 'number' && server.page >= 1 && server.page <= chapters.length) {
    idx = server.page - 1;
    toast(`已恢复到服务端记录的章节：第 ${server.page} / ${chapters.length} 章`, 'info', 3200);
  }

  const writer = makeProgressWriter(lib.id, item.path, () => ({ page: idx + 1, total: chapters.length }));

  const toc = document.createElement('div');
  toc.className = 'toc hidden';
  chapters.forEach((c, i) => {
    const b = document.createElement('button');
    b.className = 'toc-item';
    b.textContent = `${i + 1}. ${c.title || `第 ${i + 1} 章`}`;
    b.addEventListener('click', () => {
      idx = i;
      tocOpen = false;
      paint();
    });
    toc.appendChild(b);
  });

  function paint() {
    body.className = 'reader-body';
    body.innerHTML = '';
    body.appendChild(toc);
    toc.classList.toggle('hidden', !tocOpen);
    [...toc.children].forEach((c, i) => c.classList.toggle('active', i === idx));

    const wrap = document.createElement('div');
    wrap.className = 'book-chapter';
    wrap.innerHTML = `<h2>${escapeHtml(chapters[idx].title || `第 ${idx + 1} 章`)}</h2>
      <div class="body"></div>`;
    // 用 textContent 注入，避免 EPUB 内容里的标签被执行
    wrap.querySelector('.body').textContent = chapters[idx].text;
    body.appendChild(wrap);
    body.scrollTop = 0;

    setPos(`第 ${idx + 1} / ${chapters.length} 章`);
    setFoot(
      `<b>${escapeHtml(doc.title || item.title)}</b>${doc.truncated ? ' <span class="badge warn">内容已截断</span>' : ''}`,
      `${fmtBytes(doc.bytes || item.size)} · 共 ${chapters.length} 章`
    );
    setSync('正在同步进度到服务端…');
    writer.write(true);
  }

  setTools([
    { icon: 'back', title: '上一章', onClick: () => { if (idx > 0) { idx -= 1; paint(); } } },
    { icon: 'fwd', title: '下一章', onClick: () => { if (idx < chapters.length - 1) { idx += 1; paint(); } } },
    { type: 'sep' },
    { icon: 'list', title: '目录', on: tocOpen, onClick: () => { tocOpen = !tocOpen; paint(); } },
    ...ebookFontTools(),
  ]);

  session = {
    kind: 'epub',
    next: () => { if (idx < chapters.length - 1) { idx += 1; paint(); } },
    prev: () => { if (idx > 0) { idx -= 1; paint(); } },
    flush: () => writer.write(true),
  };
  paint();
}

/* ---------------------------------------------------------------- TXT / 其它文本 */

/* 电子书字号与斜体：与 v0.9.88 一致（12–32px，--ebook-font-size / --ebook-font-style） */
function ebookFontTools() {
  const pref = loadEbookFontPref();
  const sizes = [];
  for (let n = EBOOK_FONT_MIN; n <= EBOOK_FONT_MAX; n += 1) sizes.push(n);
  return [
    { type: 'sep' },
    {
      type: 'select',
      width: '84px',
      value: String(pref.size),
      options: sizes.map((n) => ({ value: String(n), label: `${n}px` })),
      onChange: (v) => {
        saveEbookFontPref({ size: Number(v) });
        toast(`正文字号 ${v}px（范围 ${EBOOK_FONT_MIN}–${EBOOK_FONT_MAX}）`, 'info', 1400);
      },
    },
    {
      icon: 'italic',
      title: '正体 / 斜体',
      on: pref.italic,
      onClick: () => {
        const cur = loadEbookFontPref();
        saveEbookFontPref({ italic: !cur.italic });
        toast(`字体样式：${!cur.italic ? '斜体' : '正体'}`, 'info', 1400);
      },
    },
  ];
}

async function openText(lib, item) {
  const body = host.querySelector('[data-role="body"]');
  body.innerHTML = `<div class="empty"><span class="spinner"></span><div class="e-title">正在读取文本…</div></div>`;

  const res = await api.fetchTextFile(lib.id, item.path);
  const text = res.text;

  /* 与服务端 v0.9.88 同一套正则切章（第X章/卷/回/节/部/集/篇、Chapter N、"1. 标题"），
     无匹配时退化为单章「全文」。这样桌面端也能像 Web 端一样按章跳转与统计进度。 */
  const rawChapters = buildEbookChapters(text);
  const chapters = rawChapters.map((c, i) => ({
    title: c.title || `第 ${i + 1} 章`,
    text: text.slice(c.offset, i + 1 < rawChapters.length ? rawChapters[i + 1].offset : text.length),
  }));

  applyEbookFontPref();

  const server = await loadServerProgress(lib.id, item.path);
  const startProgress = server && typeof server.progress === 'number' ? Math.max(0, Math.min(99.9, server.progress)) : 0;

  let idx = 0;
  let tocOpen = false;
  /* ⚠ 正在恢复上次位置时**绝不能**写进度：此刻 scrollTop 还是 0，
     一写就把服务端已保存的进度覆盖成 0（v0.9.88 trackReaderProgress 的同款保护）。 */
  let restoring = true;

  const writer = makeProgressWriter(lib.id, item.path, () => {
    const max = body.scrollHeight - body.clientHeight;
    const ratio = max > 2 ? body.scrollTop / max : 0;
    return { page: idx + 1, total: chapters.length, progress: restoring ? undefined : Math.min(100, ratio * 100) };
  });

  const toc = document.createElement('div');
  toc.className = 'toc hidden';
  chapters.forEach((c, i) => {
    const b = document.createElement('button');
    b.className = 'toc-item';
    b.textContent = `${i + 1}. ${c.title}`;
    b.addEventListener('click', () => {
      tocOpen = false;
      jumpToChapter(i);
    });
    toc.appendChild(b);
  });

  function jumpToChapter(i) {
    const heads = body.querySelectorAll('.ebook-chapter-title');
    const target = heads[Math.min(i, heads.length - 1)];
    if (target) {
      const max = body.scrollHeight - body.clientHeight;
      body.scrollTop = Math.max(0, Math.min(max, (Number(target.offsetTop) || 0) - 8));
    }
    idx = i;
    updatePos();
    writer.debounced();
  }

  body.className = 'reader-body';
  body.innerHTML = '';
  body.appendChild(toc);
  toc.classList.toggle('hidden', !tocOpen);

  const wrap = document.createElement('div');
  wrap.className = 'book-text';
  for (const c of chapters) {
    const h = document.createElement('h2');
    h.className = 'ebook-chapter-title';
    h.textContent = c.title;
    const d = document.createElement('div');
    d.className = 'body';
    d.textContent = c.text;
    wrap.appendChild(h);
    wrap.appendChild(d);
  }
  body.appendChild(wrap);

  function currentChapterIndex() {
    const heads = [...body.querySelectorAll('.ebook-chapter-title')];
    let best = 0;
    for (let i = 0; i < heads.length; i += 1) {
      if ((Number(heads[i].offsetTop) || 0) <= body.scrollTop + 12) best = i;
    }
    return best;
  }

  function updatePos() {
    const max = body.scrollHeight - body.clientHeight;
    const ratio = max > 2 ? body.scrollTop / max : 0;
    const pct = Math.min(100, ratio * 100);
    setPos(`${(pct).toFixed(1)}% · 第 ${idx + 1} / ${chapters.length} 章`);
    setFoot(
      `<b>${escapeHtml(item.title)}</b>${res.truncated ? ' <span class="badge warn">仅载入前段</span>' : ''}`,
      `${fmtBytes(res.bytes)} · ${text.length.toLocaleString()} 字符 · ${chapters.length} 章`
    );
    [...toc.children].forEach((c, i) => c.classList.toggle('active', i === idx));
  }

  body.addEventListener('scroll', () => {
    const ci = currentChapterIndex();
    if (ci !== idx) idx = ci;
    updatePos();
    if (!restoring) writer.debounced();
  });

  setTools([
    {
      icon: 'list',
      title: `目录（${chapters.length} 章）`,
      on: tocOpen,
      onClick: () => {
        tocOpen = !tocOpen;
        toc.classList.toggle('hidden', !tocOpen);
      },
    },
    { icon: 'back', title: '上一章', onClick: () => jumpToChapter(Math.max(0, idx - 1)) },
    { icon: 'fwd', title: '下一章', onClick: () => jumpToChapter(Math.min(chapters.length - 1, idx + 1)) },
    { type: 'sep' },
    { icon: 'zoomOut', title: '上一页 (PgUp)', onClick: () => body.scrollBy({ top: -body.clientHeight * 0.92, behavior: 'smooth' }) },
    { icon: 'zoomIn', title: '下一页 (PgDn)', onClick: () => body.scrollBy({ top: body.clientHeight * 0.92, behavior: 'smooth' }) },
    ...ebookFontTools(),
  ]);

  // 恢复服务端进度（恢复完成前不写回，避免把进度覆盖成 0）
  if (startProgress > 0.5) {
    requestAnimationFrame(() => {
      const max = body.scrollHeight - body.clientHeight;
      body.scrollTop = (startProgress / 100) * Math.max(0, max);
      idx = currentChapterIndex();
      updatePos();
      restoring = false;
      toast(`已恢复到服务端记录的进度 ${startProgress.toFixed(1)}%`, 'info', 3200);
      setSync('正在同步进度到服务端…');
      writer.write(true);
    });
  } else {
    updatePos();
    restoring = false;
    setSync('正在同步进度到服务端…');
    writer.write(true);
  }

  session = {
    kind: 'text',
    next: () => jumpToChapter(Math.min(chapters.length - 1, idx + 1)),
    prev: () => jumpToChapter(Math.max(0, idx - 1)),
    flush: () => writer.write(true),
  };
}

/* ---------------------------------------------------------------- PDF */

async function openPdf(lib, item) {
  const body = host.querySelector('body');
  body.innerHTML = `<div class="empty">${icon('warn', 42)}<div class="e-title">PDF 阅读</div>
    <div class="e-hint">服务端提供 /api/media/pdf/info、/api/media/pdf/page、/api/media/pdf/cover 三个端点。<br/>
    当前版本先提供单页浏览，若服务端未启用 PDF 渲染会返回错误。</div></div>`;
}

/* ---------------------------------------------------------------- 键盘 */

function onKey(e) {
  if (!host || host.classList.contains('hidden')) return;
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
  if (!session) return;
  if (e.key === 'Escape') return close();
  if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') {
    e.preventDefault();
    session.next();
  } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
    e.preventDefault();
    session.prev();
  }
}
