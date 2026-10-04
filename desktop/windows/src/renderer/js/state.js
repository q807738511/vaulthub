/* ============================================================================
   状态层

   分工（依据交接包 5.2 / 5.3）：
   - 服务端权威数据：媒体库、文件索引、元数据、阅读进度、主题 → 只读镜像，不落本地
   - 端侧偏好：音量/画质/字号/侧栏/上次位置 → vhHost 配置（userData/config.json）
   - 三端尚未共享的数据：喜欢 / 歌单 / 视频续播位置 → 本地持久化（标注为本地）
     ⚠ 服务端目前没有 favorites / playlists / playback/position 端点，
       这些数据在桌面端与安卓端之间**不互通**，UI 中已明确标注。
   ========================================================================= */

/* ---------------------------------------------------------------- 限额安全存储 */

const MEM = new Map();
const MAX_KEY_BYTES = 3 * 1024 * 1024; // 单键上限 3MB
const WRITE_TS = '__vh_wt';

function lsOk() {
  try {
    const k = '__vh_probe';
    localStorage.setItem(k, '1');
    localStorage.removeItem(k);
    return true;
  } catch {
    return false;
  }
}
const HAS_LS = lsOk();

function byteLen(s) {
  return new Blob([s]).size;
}

export const vaultStore = {
  get(key, fallback = null) {
    try {
      const raw = HAS_LS ? localStorage.getItem(key) : MEM.get(key);
      if (raw === null || raw === undefined) return fallback;
      return JSON.parse(raw);
    } catch {
      return fallback;
    }
  },

  set(key, value) {
    let raw;
    try {
      raw = JSON.stringify(value);
    } catch {
      return false;
    }
    // 单键过大：拒绝写入并保留内存副本，避免整块写 localStorage 触发 QuotaExceededError
    if (byteLen(raw) > MAX_KEY_BYTES) {
      MEM.set(key, raw);
      console.warn(`[store] ${key} 超过单键上限，仅保存在内存`);
      return false;
    }
    const stamped = raw.startsWith('{') ? (() => {
      try {
        const o = JSON.parse(raw);
        if (o && typeof o === 'object' && !Array.isArray(o)) {
          o[WRITE_TS] = Date.now();
          return JSON.stringify(o);
        }
      } catch {
        /* 非对象，按原样存 */
      }
      return raw;
    })() : raw;

    if (HAS_LS) {
      try {
        localStorage.setItem(key, stamped);
        MEM.delete(key);
        return true;
      } catch {
        // 配额爆了：淘汰最旧的可淘汰键后重试一次
        if (this.prune()) {
          try {
            localStorage.setItem(key, stamped);
            MEM.delete(key);
            return true;
          } catch {
            /* 仍然失败则退化为内存 */
          }
        }
        MEM.set(key, stamped);
        console.warn(`[store] ${key} 写入失败，已退化为内存存储`);
        return false;
      }
    }
    MEM.set(key, stamped);
    return true;
  },

  del(key) {
    MEM.delete(key);
    if (HAS_LS) {
      try {
        localStorage.removeItem(key);
      } catch {
        /* 忽略 */
      }
    }
  },

  /** 淘汰最旧的可淘汰键（保留 vh_resume / vh_fav / vh_pl 等用户数据） */
  prune() {
    if (!HAS_LS) return false;
    const evictable = [];
    try {
      for (let i = 0; i < localStorage.length; i += 1) {
        const k = localStorage.key(i);
        if (!k || !k.startsWith('vh_')) continue;
        if (k.startsWith('vh_resume_') || k.startsWith('vh_fav') || k.startsWith('vh_pl')) continue;
        let wt = 0;
        try {
          const o = JSON.parse(localStorage.getItem(k));
          if (o && typeof o === 'object') wt = o[WRITE_TS] || 0;
        } catch {
          /* 非对象 */
        }
        evictable.push({ k, wt, size: (localStorage.getItem(k) || '').length });
      }
    } catch {
      return false;
    }
    evictable.sort((a, b) => a.wt - b.wt);
    let freed = 0;
    for (const e of evictable) {
      try {
        localStorage.removeItem(e.k);
        freed += e.size;
      } catch {
        /* 忽略 */
      }
      if (freed > 4 * 1024 * 1024) break;
    }
    return freed > 0;
  },

  stats() {
    if (!HAS_LS) return { backend: 'memory', keys: MEM.size, bytes: 0 };
    let bytes = 0;
    let keys = 0;
    try {
      for (let i = 0; i < localStorage.length; i += 1) {
        const k = localStorage.key(i);
        bytes += (k.length + (localStorage.getItem(k) || '').length) * 2;
        keys += 1;
      }
    } catch {
      /* 忽略 */
    }
    return { backend: 'localStorage', keys, bytes };
  },
};

/* ---------------------------------------------------------------- 应用状态 */

export const state = {
  config: {},
  appInfo: {},
  libraries: [],
  currentLib: null,
  view: 'home',
  // 每个库的条目缓存（按库 id）
  libCache: new Map(),
  theme: { palette: 'emerald', mode: 'dark' },
  server: { online: false, health: '', version: '' },
  toasts: [],
};

/* ---------------------------------------------------------------- 端侧偏好 */

export async function loadConfig() {
  state.config = await window.vhHost.getConfig();
  return state.config;
}

export async function setConfig(patch) {
  state.config = await window.vhHost.setConfig(patch);
  return state.config;
}

/* ---------------------------------------------------------------- 主题 */

export function applyTheme(palette = 'emerald', mode = 'dark') {
  document.documentElement.dataset.palette = palette;
  document.documentElement.dataset.mode = mode;
  state.theme = { palette, mode };
}

/** 服务端 settings 里的 theme（dark/light/custom）映射到本地调色板 */
export function themeFromServer(themeValue, localPalette) {
  const v = String(themeValue || '').toLowerCase();
  const mode = v === 'light' ? 'light' : v === 'dark' ? 'dark' : null;
  if (mode) return { palette: localPalette || 'emerald', mode };
  return null;
}

/* ---------------------------------------------------------------- 视频续播（本地） */

const resumeKey = (libId, path) => `vh_resume_${libId}_${path}`;

export function getResume(libId, path) {
  const v = vaultStore.get(resumeKey(libId, path), null);
  return v && typeof v.position_ms === 'number' ? v : null;
}

export function setResume(libId, path, positionMs, durationMs) {
  if (!Number.isFinite(positionMs) || positionMs < 5) return;
  vaultStore.set(resumeKey(libId, path), {
    position_ms: Math.floor(positionMs),
    duration_ms: Number.isFinite(durationMs) ? Math.floor(durationMs) : null,
    updated_at: Math.floor(Date.now() / 1000),
  });
}

export function clearResume(libId, path) {
  vaultStore.del(resumeKey(libId, path));
}

export function listResume() {
  const out = [];
  if (!HAS_LS) return out;
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith('vh_resume_')) continue;
      const v = vaultStore.get(k, null);
      if (!v) continue;
      // vh_resume_<libId>_<path>
      const rest = k.slice('vh_resume_'.length);
      const us = rest.indexOf('_');
      if (us < 0) continue;
      out.push({ libId: rest.slice(0, us), path: rest.slice(us + 1), ...v });
    }
  } catch {
    /* 忽略 */
  }
  return out.sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
}

/* ---------------------------------------------------------------- 喜欢 / 歌单（本地） */

const FAV_KEY = 'vh_fav_audio_v1';
const PL_KEY = 'vh_pl_audio_v1';

export function getFavorites() {
  const v = vaultStore.get(FAV_KEY, {});
  return v && typeof v === 'object' ? v : {};
}
export function isFavorite(libId, path) {
  return !!getFavorites()[libId]?.[path];
}
export function toggleFavorite(libId, path) {
  const all = getFavorites();
  const lib = { ...(all[libId] || {}) };
  if (lib[path]) delete lib[path];
  else lib[path] = { added_at: Math.floor(Date.now() / 1000) };
  all[libId] = lib;
  vaultStore.set(FAV_KEY, all);
  return !!lib[path];
}

export function getPlaylists() {
  const v = vaultStore.get(PL_KEY, []);
  return Array.isArray(v) ? v : [];
}
export function savePlaylist(pl) {
  const all = getPlaylists();
  const i = all.findIndex((p) => p.id === pl.id);
  if (i >= 0) all[i] = { ...all[i], ...pl };
  else all.push({ id: pl.id || `pl_${Date.now()}`, created_at: Math.floor(Date.now() / 1000), tracks: [], ...pl });
  vaultStore.set(PL_KEY, all);
  return all;
}
export function deletePlaylist(id) {
  const all = getPlaylists().filter((p) => p.id !== id);
  vaultStore.set(PL_KEY, all);
  return all;
}

/* ---------------------------------------------------------------- 漫画/阅读偏好 */

/* 键名与默认值对齐服务端 Web 端 v0.9.88 的 COMIC_PREFS_KEY / comicPrefs()：
   { saveData:"auto", mode:"single", rtl:true, fit:"width", width:1600 }
   注意 rtl 默认 **true**（日式漫画从右到左翻页），与服务端一致。 */
export const COMIC_PREFS_KEY = 'vaulthub_comic_prefs';
export const COMIC_PREFETCH_AHEAD = 3;
export const COMIC_DEFAULT_WIDTH = 1600;

export function getComicPrefs() {
  const def = { saveData: 'auto', mode: 'single', rtl: true, fit: 'width', width: COMIC_DEFAULT_WIDTH };
  const v = vaultStore.get(COMIC_PREFS_KEY, null);
  return v && typeof v === 'object' ? { ...def, ...v } : def;
}

export function setComicPrefs(patch) {
  const next = { ...getComicPrefs(), ...(patch || {}) };
  vaultStore.set(COMIC_PREFS_KEY, next);
  return next;
}

/** 省流是否生效：on/off/auto；auto 走弱网判定（与 v0.9.88 comicSaveDataActive 一致） */
export function comicSaveDataActive(weakFn) {
  const mode = String(getComicPrefs().saveData || 'auto');
  if (mode === 'on') return true;
  if (mode === 'off') return false;
  if (typeof weakFn === 'function' && weakFn()) return true;
  const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (!c) return false;
  if (c.saveData) return true;
  return /^(slow-)?2g$|^3g$/.test(String(c.effectiveType || ''));
}

/**
 * 漫画页取图宽度。
 * 显式画质档位优先（原画 0 / 高清 1600 / 流畅 1200 / 极省 900）；
 * 「自动」档返回 null 时交回省流判定：弱网 → prefs.width(1600)，否则 0（原图直出）。
 * @param {number|null} explicitPageW qualityPageWidth() 的结果
 * @param {() => boolean} weakFn 弱网判定函数
 */
export function comicTranscodeWidth(explicitPageW, weakFn) {
  if (explicitPageW !== null && explicitPageW !== undefined) return Number(explicitPageW) || 0;
  return comicSaveDataActive(weakFn) ? Number(getComicPrefs().width) || COMIC_DEFAULT_WIDTH : 0;
}
