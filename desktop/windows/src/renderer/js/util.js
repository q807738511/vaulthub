/* ============================================================================
   工具函数：格式化、路径解析、媒体条目抽取、封面解析、文本解码
   注意：服务端 /api/media/files 返回的是**原始文件清单**（含 .cover.jpg / .lrc /
   .nfo / BDMV 等旁挂文件），因此条目抽取与分组必须在客户端完成。
   ========================================================================= */

/* ---------------------------------------------------------------- 格式化 */

export function fmtBytes(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '-';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = Number(n);
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}

export function fmtDuration(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const p = (x) => String(x).padStart(2, '0');
  return h > 0 ? `${h}:${p(m)}:${p(ss)}` : `${m}:${p(ss)}`;
}

export function fmtMs(ms) {
  return fmtDuration((Number(ms) || 0) / 1000);
}

export function fmtTime(ts) {
  if (!ts) return '-';
  const d = new Date(Number(ts) * 1000);
  if (Number.isNaN(d.getTime())) return '-';
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function fmtRelative(ts) {
  if (!ts) return '';
  const diff = Date.now() - Number(ts) * 1000;
  if (diff < 0) return '刚刚';
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day} 天前`;
  return fmtTime(ts).slice(0, 10);
}

/* ---------------------------------------------------------------- 路径 */

export const dirname = (p) => {
  const i = String(p).lastIndexOf('/');
  return i < 0 ? '' : String(p).slice(0, i);
};
export const basename = (p) => {
  const i = String(p).lastIndexOf('/');
  return i < 0 ? String(p) : String(p).slice(i + 1);
};
export const stem = (p) => basename(p).replace(/\.[^.]+$/, '');
export const extname = (p) => {
  const b = basename(p);
  const i = b.lastIndexOf('.');
  return i < 0 ? '' : b.slice(i).toLowerCase();
};
export const segs = (p) => String(p).split('/').filter(Boolean);

export function stripExt(p) {
  return basename(p).replace(/\.[^.]+$/, '');
}

/** 把文件名清理成可读标题：去扩展名、去常见发布组/分辨率噪音 */
export function cleanTitle(p, keepYear = true) {
  let s = stripExt(p);
  s = s.replace(/[._]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  s = s.replace(/\b(1080p|2160p|720p|480p|4k|uhd|bluray|blu-ray|web-dl|webrip|hdtv|remux|hevc|h ?264|h ?265|x264|x265|aac|ac3|dts(-hd)?|truehd|atmos|flac|10bit|8bit|repack|proper|internal)\b/gi, '');
  s = s.replace(/\[[^\]]*\]/g, ' ');
  s = s.replace(/\bS\d{1,2}E\d{1,3}\b/gi, ' ');
  s = s.replace(/[-_.]+\s*$/, '').replace(/\s{2,}/g, ' ').trim();
  if (!keepYear) s = s.replace(/[（(]?\d{4}[）)]?/g, ' ');
  return s.replace(/\s{2,}/g, ' ').trim() || stripExt(p);
}

/* ---------------------------------------------------------------- 扩展名 */

export const VIDEO_EXT = ['.mp4', '.mkv', '.avi', '.m2ts', '.ts', '.m4v', '.mov', '.wmv', '.flv', '.webm', '.rmvb', '.rm', '.mpg', '.mpeg', '.vob', '.iso', '.mts'];
export const ARCHIVE_EXT = ['.zip', '.cbz', '.rar', '.cbr', '.7z', '.cb7', '.tar', '.gz'];
export const BOOK_EXT = ['.epub', '.txt', '.pdf', '.mobi', '.azw3', '.azw', '.fb2', '.djvu', '.md', '.html', '.htm'];
export const AUDIO_EXT = ['.mp3', '.flac', '.m4a', '.aac', '.wav', '.ogg', '.oga', '.opus', '.ape', '.wma', '.dsf', '.dff', '.aiff', '.aif', '.alac', '.mpc', '.wv'];
export const IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif', '.avif'];

const has = (list, p) => list.includes(extname(p));
export const isVideo = (p) => has(VIDEO_EXT, p);
export const isArchive = (p) => has(ARCHIVE_EXT, p);
export const isBook = (p) => has(BOOK_EXT, p);
export const isAudio = (p) => has(AUDIO_EXT, p);
export const isImage = (p) => has(IMAGE_EXT, p);

/** 蓝光原盘结构（BDMV/…）不是可直接播放的“集”，单独剔除 */
export function isDiscArtifact(p) {
  return /(^|\/)BDMV\//i.test(p) || /\.(bdmv|mpls|clpi|bdjo|jar)$/i.test(p) || /(^|\/)CERTIFICATE\//i.test(p);
}

/* ---------------------------------------------------------------- 图片索引 */

/**
 * 从原始文件清单里建立“目录 → 图片”索引，用于给媒体条目找封面。
 * 服务端的 cover 接口要求 path 指向**图片文件**，所以必须先在清单里定位图片。
 */
export class ImageIndex {
  constructor() {
    this.byDir = new Map(); // dir -> [path]
    this.byStem = new Map(); // `${dir}\n${stem}` -> path
  }

  add(p) {
    if (!isImage(p)) return;
    const d = dirname(p);
    let arr = this.byDir.get(d);
    if (!arr) this.byDir.set(d, (arr = []));
    arr.push(p);
    this.byStem.set(`${d}\n${stem(p)}`, p);
  }

  /** 为媒体条目挑一个最合适的封面图路径，找不到返回 '' */
  pick(mediaPath) {
    const d = dirname(mediaPath);
    const base = stem(mediaPath);

    // 1) 同名旁挂：<base>.cover.jpg / <base>.jpg
    const direct = this.byStem.get(`${d}\n${base}.cover`) || this.byStem.get(`${d}\n${base}`);
    if (direct) return direct;

    // 2) 目录内的通用封面名
    for (const n of ['cover', 'poster', 'folder', 'front', 'fanart', 'thumb', 'default', 'artwork']) {
      const hit = this.byStem.get(`${d}\n${n}`);
      if (hit) return hit;
    }

    // 3) 目录名同名图
    const dn = basename(d);
    if (dn) {
      const hit = this.byStem.get(`${d}\n${dn}`);
      if (hit) return hit;
    }

    // 4) 目录内任意图
    const arr = this.byDir.get(d);
    if (arr && arr.length) return arr[0];

    // 5) 向上一级（剧集集数常与剧集目录同级放图）
    const up = dirname(d);
    if (up) {
      const upArr = this.byDir.get(up);
      if (upArr && upArr.length) {
        for (const n of ['cover', 'poster', 'folder', 'fanart']) {
          const hit = this.byStem.get(`${up}\n${n}`);
          if (hit) return hit;
        }
        return upArr[0];
      }
    }
    return '';
  }
}

/* ---------------------------------------------------------------- 剧集解析 */

const SEASON_RE = /^(season\s*(\d+)|s(\d{1,2})|第\s*(\d{1,2})\s*季|specials?|sp)$/i;
const EPISODE_RES = [
  /[Ss](\d{1,2})[\s._-]*[Ee](\d{1,3})/,
  /[Ee]p?(\d{1,3})(?!\d)/,
  /第\s*(\d{1,4})\s*[集话話]/,
  /(?:^|[^\d])(\d{1,3})\s*[集话話]/,
];

function parseEpisode(filePath) {
  const b = stripExt(filePath);
  let season = null;
  let episode = null;

  // SxxExx
  let m = b.match(/[Ss](\d{1,2})[\s._-]*[Ee](\d{1,3})/);
  if (m) {
    season = parseInt(m[1], 10);
    episode = parseInt(m[2], 10);
    return { season, episode };
  }
  for (const re of EPISODE_RES) {
    const mm = b.match(re);
    if (mm) {
      episode = parseInt(mm[mm.length - 1], 10);
      break;
    }
  }
  // 路径中的季目录
  for (const s of segs(filePath).slice(0, -1)) {
    const sm = s.match(SEASON_RE);
    if (sm) {
      const n = sm[2] || sm[3] || sm[4];
      season = n ? parseInt(n, 10) : 0;
      break;
    }
  }
  return { season, episode };
}

/**
 * 剧集：按“剧名目录 → 季 → 集”分组。
 * 服务端给的是一堆文件路径，这里还原成用户期望的层级。
 */
export function groupSeries(entries) {
  const shows = new Map();
  for (const e of entries) {
    if (!isVideo(e.path) || isDiscArtifact(e.path)) continue;
    const parts = segs(e.path);
    if (parts.length < 2) continue;
    const showName = parts[0];
    const { season, episode } = parseEpisode(e.path);
    let show = shows.get(showName);
    if (!show) shows.set(showName, (show = { name: showName, seasons: new Map(), files: [] }));
    show.files.push(e);
    const sk = season === null ? 0 : season;
    let s = show.seasons.get(sk);
    if (!s) show.seasons.set(sk, (s = []));
    s.push({ ...e, episode: episode === null ? null : episode });
  }
  const out = [...shows.values()];
  for (const show of out) {
    show.episodeCount = show.files.length;
    show.size = show.files.reduce((a, b) => a + (b.size || 0), 0);
    show.seasonList = [...show.seasons.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([no, eps]) => {
        eps.sort((a, b) => {
          if (a.episode !== null && b.episode !== null) return a.episode - b.episode;
          return a.path.localeCompare(b.path, 'zh');
        });
        return { no, episodes: eps };
      });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
}

/* ---------------------------------------------------------------- 音频分组 */

/** 音频：曲目 → 专辑（父目录）→ 歌手（祖父目录，退回“未知歌手”） */
export function groupAudio(entries) {
  const tracks = [];
  for (const e of entries) {
    if (!isAudio(e.path)) continue;
    const parts = segs(e.path);
    const album = parts.length >= 2 ? parts[parts.length - 2] : '未分类';
    const artist = parts.length >= 3 ? parts[parts.length - 3] : '未知歌手';
    const noMatch = stripExt(e.path).match(/^\s*(\d{1,3})[\s._-]+/);
    tracks.push({
      ...e,
      title: cleanTitle(e.path, false) || stripExt(e.path),
      album,
      artist,
      trackNo: noMatch ? parseInt(noMatch[1], 10) : null,
    });
  }
  tracks.sort((a, b) => {
    if (a.album !== b.album) return a.album.localeCompare(b.album, 'zh');
    if (a.trackNo !== null && b.trackNo !== null) return a.trackNo - b.trackNo;
    return a.title.localeCompare(b.title, 'zh');
  });

  const albums = new Map();
  for (const t of tracks) {
    const k = `${t.artist}\n${t.album}`;
    let a = albums.get(k);
    if (!a) albums.set(k, (a = { artist: t.artist, album: t.album, tracks: [] }));
    a.tracks.push(t);
  }
  const artists = new Map();
  for (const t of tracks) {
    let a = artists.get(t.artist);
    if (!a) artists.set(t.artist, (a = { name: t.artist, tracks: [], albums: new Set() }));
    a.tracks.push(t);
    a.albums.add(t.album);
  }
  return {
    tracks,
    albums: [...albums.values()].sort((a, b) => a.album.localeCompare(b.album, 'zh')),
    artists: [...artists.values()]
      .map((a) => ({ ...a, albumCount: a.albums.size }))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh')),
  };
}

/* ---------------------------------------------------------------- 通用条目抽取 */

/**
 * 按库类型把原始文件清单抽取为可展示条目。
 * @returns {{items:Array, imageIndex:ImageIndex, extra?:object}}
 */
export function extractItems(libType, entries) {
  const imageIndex = new ImageIndex();
  for (const e of entries) imageIndex.add(e.path);

  if (libType === 'series') {
    const shows = groupSeries(entries);
    return {
      imageIndex,
      items: shows.map((s) => ({
        kind: 'show',
        path: s.files[0].path,
        dir: s.name,
        title: cleanTitle(s.name, false) || s.name,
        raw: s.name,
        sub: `${s.seasonList.length} 季 · ${s.episodeCount} 集`,
        size: s.size,
        show: s,
      })),
    };
  }

  let items = [];
  if (libType === 'movie') {
    items = entries
      .filter((e) => isVideo(e.path) && !isDiscArtifact(e.path))
      .map((e) => ({ kind: 'movie', path: e.path, title: cleanTitle(e.path), sub: fmtBytes(e.size), size: e.size, mtime: e.mtime }));
  } else if (libType === 'comic') {
    items = entries
      .filter((e) => isArchive(e.path) && !/\.part$/i.test(e.path))
      .map((e) => ({ kind: 'comic', path: e.path, title: cleanTitle(e.path), sub: fmtBytes(e.size), size: e.size, mtime: e.mtime }));
  } else if (libType === 'book') {
    items = entries
      .filter((e) => isBook(e.path))
      .map((e) => ({ kind: 'book', path: e.path, title: cleanTitle(e.path), sub: extname(e.path).slice(1).toUpperCase(), size: e.size, mtime: e.mtime }));
  } else if (libType === 'audio') {
    const g = groupAudio(entries);
    return { imageIndex, items: g.tracks.map((t) => ({ kind: 'track', ...t })), extra: g };
  } else {
    // 自定义模块 / 未知类型：列出全部非图片文件
    items = entries
      .filter((e) => !isImage(e.path))
      .map((e) => ({ kind: 'file', path: e.path, title: basename(e.path), sub: fmtBytes(e.size), size: e.size, mtime: e.mtime }));
  }
  return { imageIndex, items };
}

/* ---------------------------------------------------------------- 封面 URL */

import { qualityCoverWidth } from './quality.js';

/**
 * 封面/缩略图地址。
 * 不传 w 时按当前「画面清晰度」档位取宽度（原画/高清 320、流畅 200、极省 140），
 * 与 v0.9.88 的 qualityCoverWidth 行为一致；w<=0 表示取原图。
 */
export function coverUrl(libId, imgPath, w) {
  if (!imgPath) return '';
  const width = w === undefined || w === null ? qualityCoverWidth(320) : Number(w);
  const base = `/api/media/cover/?id=${encodeURIComponent(libId)}&path=${encodeURIComponent(imgPath)}`;
  return width > 0 ? `${base}&w=${width}` : base;
}

export function mediaUrl(libId, path) {
  return `/api/media/file?id=${encodeURIComponent(libId)}&path=${encodeURIComponent(path)}`;
}

export function audioStreamUrl(libId, path, bitrate = 192) {
  return `/api/media/audio/stream?id=${encodeURIComponent(libId)}&path=${encodeURIComponent(path)}&bitrate=${encodeURIComponent(bitrate)}`;
}

export function zipRegisterUrl(libId, path) {
  return `/api/media/archive/zip/register?id=${encodeURIComponent(libId)}&path=${encodeURIComponent(path)}`;
}

export function zipPageUrl(libId, path, entry, w = 0) {
  let u = `/api/media/archive/zip/page?id=${encodeURIComponent(libId)}&path=${encodeURIComponent(path)}&entry=${encodeURIComponent(entry)}`;
  if (w > 0) u += `&w=${w}`;
  return u;
}

export function epubUrl(libId, path) {
  return `/api/media/document/epub?id=${encodeURIComponent(libId)}&path=${encodeURIComponent(path)}`;
}

/* ---------------------------------------------------------------- 文本解码 */

/**
 * 中文老小说/字幕大量使用 GBK。服务端统一回 charset=utf-8，但字节未必是 UTF-8，
 * 所以这里做一次带 BOM 与回退的探测解码（Chromium 内置 gbk/big5 解码器）。
 */
export function decodeText(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (u8.length >= 3 && u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(u8.subarray(3));
  }
  if (u8.length >= 2 && u8[0] === 0xff && u8[1] === 0xfe) return new TextDecoder('utf-16le').decode(u8.subarray(2));
  if (u8.length >= 2 && u8[0] === 0xfe && u8[1] === 0xff) return new TextDecoder('utf-16be').decode(u8.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(u8);
  } catch {
    /* 不是合法 UTF-8，走中文编码回退 */
  }
  for (const enc of ['gbk', 'gb18030', 'big5']) {
    try {
      const t = new TextDecoder(enc).decode(u8);
      // 回退编码会产生大量替换符则视为不合适
      const bad = (t.match(/\uFFFD/g) || []).length;
      if (bad / Math.max(1, t.length) < 0.01) return t;
    } catch {
      /* 该编码不被支持，继续 */
    }
  }
  return new TextDecoder('utf-8').decode(u8);
}

/* ---------------------------------------------------------------- 电子书章节 */

/**
 * 从纯文本切分章节。
 * 正则与服务端 Web 端 v0.9.88 的 buildEbookChapters 完全一致，
 * 保证桌面端与 Web 端的目录划分相同（第X章/卷/回/节/部/集/篇、Chapter N、"1. 标题"）。
 * @returns {Array<{title:string, offset:number}>}
 */
export function buildEbookChapters(text) {
  const src = String(text || '');
  const chapters = [];
  const pattern =
    /(^|\n)\s*(第\s*[0-9一二三四五六七八九十百千万零两]+\s*[章卷回节部集篇]|Chapter\s+\d+|CHAPTER\s+\d+|[0-9]+\s*[\.、]\s*\S{2,30})/g;
  let m;
  while ((m = pattern.exec(src))) {
    chapters.push({
      title: (m[2] || m[1]).trim(),
      offset: m.index + (m[1] === '\n' ? 1 : 0),
    });
  }
  if (!chapters.length) chapters.push({ title: '全文', offset: 0 });
  return chapters;
}

const EBOOK_FONT_KEY = 'vaulthub_ebook_font_v1';
export const EBOOK_FONT_MIN = 12;
export const EBOOK_FONT_MAX = 32;
export const EBOOK_FONT_DEFAULT = 17;

/** 电子书字号：默认 17，范围 12–32（对齐 v0.9.88 的 changeEbookFontSize） */
export function clampEbookFontSize(n) {
  const v = Number(n) || EBOOK_FONT_DEFAULT;
  return Math.max(EBOOK_FONT_MIN, Math.min(EBOOK_FONT_MAX, v));
}

export function loadEbookFontPref() {
  try {
    const o = JSON.parse(localStorage.getItem(EBOOK_FONT_KEY) || '{}') || {};
    return {
      size: clampEbookFontSize(o.size ?? EBOOK_FONT_DEFAULT),
      italic: !!o.italic,
    };
  } catch {
    return { size: EBOOK_FONT_DEFAULT, italic: false };
  }
}

export function saveEbookFontPref(patch) {
  const next = { ...loadEbookFontPref(), ...(patch || {}) };
  next.size = clampEbookFontSize(next.size);
  try {
    localStorage.setItem(EBOOK_FONT_KEY, JSON.stringify(next));
  } catch {
    /* 忽略 */
  }
  applyEbookFontPref(next);
  return next;
}

/** 落到 CSS 变量：--ebook-font-size / --ebook-font-style（v0.9.88 新增斜体） */
export function applyEbookFontPref(pref) {
  const p = pref || loadEbookFontPref();
  const root = document.documentElement;
  root.style.setProperty('--ebook-font-size', `${clampEbookFontSize(p.size)}px`);
  root.style.setProperty('--ebook-font-style', p.italic ? 'italic' : 'normal');
  return p;
}

/* ---------------------------------------------------------------- 播放能力 */

/** 如实上报本机解码能力，供 playback/plan 决定是否转码（字段与 v0.9.88 对齐） */
export function detectClientCapabilities() {
  const v = document.createElement('video');
  const mse = typeof MediaSource !== 'undefined';
  const supported = (mime) => {
    try {
      return !!v.canPlayType(mime) || (mse && typeof MediaSource.isTypeSupported === 'function' && MediaSource.isTypeSupported(mime));
    } catch {
      return false;
    }
  };
  return {
    mse,
    mp4: supported('video/mp4'),
    h264: supported('video/mp4; codecs="avc1.42E01E,mp4a.40.2"'),
    hevc: supported('video/mp4; codecs="hvc1.1.6.L93.B0"'),
    vp9: supported('video/webm; codecs="vp09.00.10.08"'),
    aac: supported('audio/mp4; codecs="mp4a.40.2"'),
    opus: supported('audio/webm; codecs="opus"'),
    // 桌面端额外上报，便于服务端判断（Web 端未上报这三个）
    webm: supported('video/webm'),
    av1: supported('video/mp4; codecs="av01.0.05M.08"'),
    mp3: supported('audio/mpeg'),
    flac: supported('audio/ogg; codecs="flac"') || supported('audio/flac'),
    vorbis: supported('audio/webm; codecs="vorbis"'),
  };
}

/** 播放模式文案：与 v0.9.88 的 playbackModeLabel 一致 */
export function playbackModeLabel(plan) {
  const labels = {
    direct: 'Direct Play 原画直放',
    remux: 'Smart Stream · Remux',
    audio_transcode: 'Smart Stream · 仅音频转码',
    full_transcode: 'Smart Stream · 完整转码',
  };
  const base = labels[plan?.mode] || 'Smart Stream';
  return `${base}${plan?.hardware && plan.mode === 'full_transcode' ? ` · ${String(plan.hardware).toUpperCase()}` : ''}`;
}

/* ---------------------------------------------------------------- 字幕 */

/** SRT → WebVTT（浏览器只认 VTT） */
export function srtToVtt(text) {
  const body = text
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
  return `WEBVTT\n\n${body}`;
}

/** ASS/SSA 尽量提取纯文本（桌面端只做兜底展示，不做样式还原） */
export function assToVtt(text) {
  const out = ['WEBVTT', ''];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let inEvents = false;
  for (const line of lines) {
    if (/^\[Events\]/i.test(line)) {
      inEvents = true;
      continue;
    }
    if (/^\[/.test(line)) {
      inEvents = false;
      continue;
    }
    if (!inEvents || !/^Dialogue:/i.test(line)) continue;
    const parts = line.slice(9).split(',');
    if (parts.length < 10) continue;
    const start = assTime(parts[1]);
    const end = assTime(parts[2]);
    const txt = parts.slice(9).join(',').replace(/\{[^}]*\}/g, '').replace(/\\N/gi, '\n').trim();
    if (!start || !end || !txt) continue;
    out.push(`${start} --> ${end}`, txt, '');
  }
  return out.join('\n');
}

function assTime(t) {
  const m = String(t).trim().match(/^(\d+):(\d{2}):(\d{2})[.:](\d{1,2})$/);
  if (!m) return '';
  return `${m[1].padStart(2, '0')}:${m[2]}:${m[3]}.${m[4].padEnd(2, '0')}`;
}

/* ---------------------------------------------------------------- 杂项 */

export function debounce(fn, ms = 220) {
  let t = 0;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** 简易并发映射 */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}
