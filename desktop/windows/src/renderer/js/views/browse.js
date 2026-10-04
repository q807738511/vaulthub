/* ============================================================================
   媒体库浏览：服务端分页 → 客户端条目抽取 → 海报墙 + 无限滚动 + 搜索
   服务端 /api/media/files 返回的是原始文件清单（含旁挂文件），
   所以这里边翻页边抽取条目，并按需继续加载，避免一次枚举 18 万条文件。
   ========================================================================= */

import * as api from '../api.js';
import { extractItems, ImageIndex, coverUrl, fmtBytes, debounce, escapeHtml, isAudio } from '../util.js';
import { icon, libIcon, lazyImg, toast } from '../ui.js';
import { registerPaths } from '../paths.js';

// 实测：服务端对 limit 有上限，>500 会静默回落到 100（见 selftest 记录），所以取 500
const PAGE = 500;
const MAX_PAGES = 60; // 单次浏览最多翻这么多页，避免大库拖死

export class LibraryBrowser {
  constructor({ lib, mount, onOpen, type }) {
    this.lib = lib;
    this.mount = mount;
    this.onOpen = onOpen;
    this.type = type || lib.type;
    this.offset = 0;
    this.pages = 0;
    this.done = false;
    this.loading = false;
    this.query = '';
    this.sort = '';
    this.imageIndex = null;
    this.items = [];
    this.extra = null;
    this.renderTarget = null;
    this.sentinel = null;
    this.statusEl = null;
  }

  async init() {
    this.mount.innerHTML = `
      <div class="toolbar">
        <span class="badge accent">${escapeHtml(this.lib.name)}</span>
        <span class="badge">${escapeHtml(this.type)}</span>
        <span class="muted" data-role="count" style="font-size:12px"></span>
        <span class="spacer"></span>
        <select class="field" data-role="sort" style="width:130px;height:30px">
          <option value="">默认排序</option>
          <option value="name">按名称</option>
          <option value="size">按大小</option>
          <option value="mtime">按时间</option>
        </select>
        <button class="btn sm" data-role="refresh">${icon('refresh', 14)} 刷新</button>
      </div>
      <div class="grid-posters" data-role="grid"></div>
      <div class="sentinel" data-role="sentinel"></div>
    `;
    this.renderTarget = this.mount.querySelector('[data-role="grid"]');
    this.sentinel = this.mount.querySelector('[data-role="sentinel"]');
    this.statusEl = this.mount.querySelector('[data-role="count"]');

    this.mount.querySelector('[data-role="sort"]').addEventListener('change', (e) => {
      this.sort = e.target.value;
      this.reload();
    });
    this.mount.querySelector('[data-role="refresh"]').addEventListener('click', () => {
      api.clearFileCache();
      this.reload();
    });

    // 无限滚动
    this.scrollObs = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) this.loadMore();
      },
      { root: this.mount.closest('.content') || null, rootMargin: '500px 0px' }
    );
    this.scrollObs.observe(this.sentinel);

    await this.reload();
  }

  destroy() {
    this.scrollObs?.disconnect();
  }

  async reload() {
    this.offset = 0;
    this.pages = 0;
    this.done = false;
    this.items = [];
    this.extra = null;
    this.imageIndex = null;
    this.renderTarget.innerHTML = '';
    await this.loadMore();
  }

  setQuery(q) {
    this.query = q;
    this.reload();
  }

  async loadMore() {
    if (this.loading || this.done) return;
    this.loading = true;
    if (this.sentinel) this.sentinel.innerHTML = `<span class="spinner"></span>`;

    try {
      while (this.pages < MAX_PAGES) {
        const res = await api.files({
          id: this.lib.id,
          offset: this.offset,
          limit: PAGE,
          q: this.query,
          sort: this.sort,
        });
        const entries = res.files || [];
        this.offset += entries.length;
        this.pages += 1;

        // 累积图片索引（封面解析依赖它）并登记路径（旁挂字幕查找依赖它）
        if (!this.imageIndex) this.imageIndex = new ImageIndex();
        for (const e of entries) this.imageIndex.add(e.path);
        registerPaths(this.lib.id, entries.map((e) => e.path));

        const { items, extra } = extractItems(this.type, entries);
        if (extra) this.extra = mergeAudioExtra(this.extra, extra);
        this.items.push(...items);
        this.appendItems(items);

        const enough = this.items.length >= 240;
        this.done = !res.has_more || entries.length === 0;
        if (this.done || enough) break;
      }
    } catch (err) {
      toast(`加载「${escapeHtml(this.lib.name)}」失败：${escapeHtml(err.message)}`, 'err');
      this.done = true;
    } finally {
      this.loading = false;
      this.updateStatus();
      if (this.sentinel) {
        this.sentinel.innerHTML = this.done
          ? this.items.length
            ? `<span class="muted" style="font-size:12px">已到底部 · 共 ${this.items.length} 项</span>`
            : ''
          : '';
      }
      // 若首屏未填满，继续拉
      if (!this.done && this.items.length < 12) this.loadMore();
    }
  }

  updateStatus() {
    if (!this.statusEl) return;
    const n = this.items.length;
    this.statusEl.textContent = this.done ? `${n} 项 · 已全部加载` : `${n} 项 · 继续滚动加载`;
  }

  coverFor(item) {
    const img = this.imageIndex ? this.imageIndex.pick(item.path) : '';
    return coverUrl(this.lib.id, img, 320);
  }

  appendItems(items) {
    const frag = document.createDocumentFragment();
    for (const it of items) {
      const card = document.createElement('button');
      card.className = 'card';
      const thumb = document.createElement('div');
      thumb.className = 'thumb';
      thumb.appendChild(lazyImg(this.coverFor(it), 'film'));
      const tag = document.createElement('div');
      tag.className = 'tagline';
      tag.innerHTML = `<span>${escapeHtml(it.sub || '')}</span><span>${it.kind === 'show' ? '剧集' : ''}</span>`;
      thumb.appendChild(tag);

      const title = document.createElement('div');
      title.className = 'title';
      title.textContent = it.title || it.path;

      card.appendChild(thumb);
      card.appendChild(title);
      card.addEventListener('click', () => this.onOpen(it, this));

      frag.appendChild(card);
    }
    this.renderTarget.appendChild(frag);
  }
}

function mergeAudioExtra(prev, next) {
  if (!prev) return next;
  const map = new Map();
  for (const a of [...prev.albums, ...next.albums]) map.set(`${a.artist}\n${a.album}`, a);
  const amap = new Map();
  for (const a of [...prev.artists, ...next.artists]) amap.set(a.name, a);
  const tmap = new Map();
  for (const t of [...prev.tracks, ...next.tracks]) tmap.set(t.path, t);
  return { albums: [...map.values()], artists: [...amap.values()], tracks: [...tmap.values()] };
}

/* ---------------------------------------------------------------- 搜索视图 */

export function renderSearchView(mount, { onOpenLibrary, onOpenItem }) {
  mount.innerHTML = `
    <div class="pad">
      <div class="sec-head"><h2>搜索</h2><span class="sub" data-role="hint">输入关键字，跨全部媒体库检索</span></div>
      <div data-role="out"></div>
    </div>`;
  const out = mount.querySelector('[data-role="out"]');
  const hint = mount.querySelector('[data-role="hint"]');

  const run = debounce(async (q) => {
    if (!q.trim()) {
      hint.textContent = '输入关键字，跨全部媒体库检索';
      out.innerHTML = `<div class="empty">${icon('search', 42)}<div class="e-title">等待输入</div></div>`;
      return;
    }
    hint.innerHTML = `<span class="spinner"></span> 正在检索「${escapeHtml(q)}」…`;
    out.innerHTML = '';
    const results = [];
    for (const lib of (mount.__libs || [])) {
      try {
        const res = await api.files({ id: lib.id, offset: 0, limit: 200, q });
        const entries = res.files || [];
        const { items } = extractItems(lib.type, entries);
        const imgIndex = new ImageIndex();
        for (const e of entries) imgIndex.add(e.path);
        registerPaths(lib.id, entries.map((e) => e.path));
        results.push({ lib, items: items.slice(0, 60), imgIndex, total: res.total });
      } catch {
        /* 单库失败不影响其它库 */
      }
    }
    const totalHits = results.reduce((a, b) => a + b.items.length, 0);
    hint.textContent = `共 ${totalHits} 条匹配`;
    if (!totalHits) {
      out.innerHTML = `<div class="empty">${icon('search', 42)}<div class="e-title">没有匹配结果</div><div class="e-hint">试试更短的关键字，或检查索引状态是否 ready。</div></div>`;
      return;
    }
    for (const r of results) {
      if (!r.items.length) continue;
      const sec = document.createElement('div');
      sec.className = 'sec';
      sec.innerHTML = `<div class="sec-head"><h2>${libIcon(r.lib.type)} ${escapeHtml(r.lib.name)}</h2><span class="sub">${r.items.length} 项 / 共 ${r.total ?? '?'} 个文件</span></div>`;
      const grid = document.createElement('div');
      grid.className = 'grid-posters compact';
      for (const it of r.items) {
        const card = document.createElement('button');
        card.className = 'card';
        const thumb = document.createElement('div');
        thumb.className = 'thumb';
        thumb.appendChild(lazyImg(coverUrl(r.lib.id, r.imgIndex.pick(it.path), 320), 'film'));
        const title = document.createElement('div');
        title.className = 'title';
        title.textContent = it.title;
        card.appendChild(thumb);
        card.appendChild(title);
        card.addEventListener('click', () => onOpenItem(r.lib, it));
        grid.appendChild(card);
      }
      sec.appendChild(grid);
      out.appendChild(sec);
    }
  }, 380);

  return { setQuery: run, setLibraries: (libs) => (mount.__libs = libs) };
}
