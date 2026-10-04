/* ============================================================================
   VaultHub 服务端访问层（v0.9.83 契约）
   全部请求走本地同源网关（相对路径 /api/...），会话 Cookie 由宿主进程持有。
   端点与方法以交接包 docs/01a-端点总表-自动生成.md 为准。
   ========================================================================= */

import { coverUrl, zipPageUrl, epubUrl, mediaUrl, audioStreamUrl } from './util.js';

/** 统计：用于验收留证（请求数 / 304 命中数） */
export const stats = { requests: 0, revalidated304: 0, errors: 0, byEndpoint: Object.create(null) };

const listeners = { unauthorized: [], error: [] };
export function on(evt, fn) {
  (listeners[evt] ||= []).push(fn);
  return () => {
    const a = listeners[evt] || [];
    const i = a.indexOf(fn);
    if (i >= 0) a.splice(i, 1);
  };
}
function emit(evt, payload) {
  for (const fn of listeners[evt] || []) {
    try {
      fn(payload);
    } catch (e) {
      console.error('[api] listener error', e);
    }
  }
}

/* ---------------------------------------------------------------- 底层请求 */

function qs(params) {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null || v === '') continue;
    u.set(k, String(v));
  }
  return u.toString();
}

export class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

async function request(path, { method = 'GET', body, headers = {}, raw = false, timeoutMs = 0 } = {}) {
  const name = path.split('?')[0];
  stats.requests += 1;
  stats.byEndpoint[name] = (stats.byEndpoint[name] || 0) + 1;

  const init = { method, headers: { ...headers }, credentials: 'same-origin' };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let timer = 0;
  let ctrl = null;
  if (timeoutMs > 0) {
    ctrl = new AbortController();
    init.signal = ctrl.signal;
    timer = setTimeout(() => ctrl.abort(), timeoutMs);
  }

  let res;
  try {
    res = await fetch(path, init);
  } catch (err) {
    stats.errors += 1;
    const msg = err.name === 'AbortError' ? '请求超时' : `网络错误：${err.message}`;
    emit('error', { path, message: msg });
    throw new ApiError(msg, 0, null);
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (res.status === 401) {
    emit('unauthorized', { path });
    const text = await res.text().catch(() => '');
    throw new ApiError('会话已失效，请重新登录', 401, text);
  }

  if (raw) return res;

  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }

  if (!res.ok) {
    stats.errors += 1;
    const msg = (data && (data.error || data.message)) || `HTTP ${res.status}`;
    throw new ApiError(msg, res.status, data);
  }
  return data;
}

/* ---------------------------------------------------------------- 文件列表缓存 */

const fileCache = new Map(); // key -> {etag, data}

/** 清空列表缓存（索引重建、手动刷新时调用） */
export function clearFileCache() {
  fileCache.clear();
}

/**
 * GET /api/media/files —— 带 ETag 条件请求。
 * 服务端对同参请求返回 ETag，命中则 304；此时复用本地缓存，避免重复传输大列表。
 */
export async function files({ id, offset = 0, limit = 200, q = '', sort = '', force = false }) {
  const query = qs({ id, offset, limit, q, sort });
  const key = query;
  const prev = force ? null : fileCache.get(key);

  const headers = {};
  if (prev && prev.etag) headers['If-None-Match'] = prev.etag;

  const res = await request(`/api/media/files?${query}`, { raw: true, headers });
  if (res.status === 304 && prev) {
    stats.revalidated304 += 1;
    return { ...prev.data, _fromCache: true };
  }
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    let d = null;
    try {
      d = JSON.parse(t);
    } catch {
      /* 非 JSON 错误体 */
    }
    throw new ApiError((d && d.error) || `HTTP ${res.status}`, res.status, d);
  }
  const data = await res.json();
  const etag = res.headers.get('etag');
  if (etag) fileCache.set(key, { etag, data });
  return { ...data, _fromCache: false };
}

/* ---------------------------------------------------------------- 认证 */

export const authMode = () => request('/api/auth/mode');
export const sessionCheck = () => request('/api/session/check');
export const login = (username, password) => request('/api/login', { method: 'POST', body: { username, password } });
export const logout = () => request('/api/logout', { raw: true }).then(() => true);
export const account = (payload) => request('/api/account', { method: 'POST', body: payload });

/* ---------------------------------------------------------------- 媒体库与列表 */

export const libraries = () => request('/api/media/libraries');
export const indexStatus = () => request('/api/media/index/status');
export const indexRebuild = (id) => request(`/api/media/index/rebuild${id ? `?id=${encodeURIComponent(id)}` : ''}`, { method: 'POST' });
export const indexCancel = (id) => request(`/api/media/index/cancel${id ? `?id=${encodeURIComponent(id)}` : ''}`, { method: 'POST' });

/* ---------------------------------------------------------------- 元数据 */

export const metadata = (id, path) => request(`/api/media/metadata?${qs({ id, path })}`);
export const artwork = (id, path) => request(`/api/media/metadata/artwork?${qs({ id, path })}`);
export const streams = (id, path) => request(`/api/media/streams?${qs({ id, path })}`);
export const probe = (id, path) => request(`/api/media/probe?${qs({ id, path })}`);

/* ---------------------------------------------------------------- 播放 */

export const playbackPlan = (payload) => request('/api/media/playback/plan', { method: 'POST', body: payload });

export const compatUrl = (id, path, hw = 'auto') =>
  `/api/media/compat?${qs({ id, path, hw })}`;

export const weakProbeUrl = (kb = 256) => `/api/media/weak/probe?kb=${kb}`;

/* ---------------------------------------------------------------- 音频 */

export const audioLyrics = ({ id, path, artist, title, save, force }) =>
  request(`/api/media/audio/lyrics?${qs({ id, path, artist, title, save, force })}`);
export const audioArtist = (name) => request(`/api/media/audio/artist?${qs({ name })}`);
export const audioMetadata = ({ artist, title, source, country }) =>
  request(`/api/media/audio/metadata?${qs({ artist, title, source, country })}`);
export const audioCacheStats = () => request('/api/media/audio/cache/stats');

/* ---------------------------------------------------------------- 漫画压缩包 */

export const zipRegister = (id, path) => request(`/api/media/archive/zip/register?${qs({ id, path })}`);

/* ---------------------------------------------------------------- 电子书 */

export const epubDocument = (id, path) => request(`/api/media/document/epub?${qs({ id, path })}`);
export const pdfInfo = (id, path) => request(`/api/media/pdf/info?${qs({ base: '', path })}`);

/* ---------------------------------------------------------------- 阅读进度（跨端共享） */

export const readingProgress = (id, path) =>
  request(`/api/media/reading/progress?${qs({ id, path })}`);

/** 写回服务端后，Web 端与安卓端同一账号可见 */
export const readingProgressPut = (id, path, payload) =>
  request(`/api/media/reading/progress?${qs({ id, path })}`, { method: 'PUT', body: payload });

export const readingProgressDelete = (id, path) =>
  request(`/api/media/reading/progress?${qs({ id, path })}`, { method: 'DELETE' });

/* ---------------------------------------------------------------- 字幕 */

export const subtitleExtractUrl = (id, path, track) => `/api/media/subtitles/extract?${qs({ id, path, track })}`;
export const subtitleProxyUrl = (id, path) => `/api/media/subtitles/proxy?${qs({ id, path })}`;
export const subtitleSearch = (id, path) => request(`/api/media/subtitles/search?${qs({ id, path })}`);

/* ---------------------------------------------------------------- 系统与设置 */

/** 运行/刮削设置。字段与 v0.9.88 的 loadMediaRuntimeSettings 对齐。 */
export const settings = () => request('/api/media/settings', { headers: { 'cache-control': 'no-cache' } });

/**
 * 写回运行/刮削设置 —— 服务端 Web 端用的是 **PUT**（不是 POST）。
 * payload 字段与 saveMediaRuntimeSettings 完全一致；密钥留空表示保留服务端已有值。
 */
export const settingsPut = (payload) => request('/api/media/settings', { method: 'PUT', body: payload });

/** 刮削器状态（/api/media/scrapers） */
export const scrapers = () => request('/api/media/scrapers');

/** 代理/直连网络测速（固定白名单：TMDB / TVDB / 通知 / GitHub API） */
export const networkSpeed = () => request('/api/media/network/speed', { method: 'POST', body: {} });

/** 清某库的刮削缓存，便于按新参数重刮 */
export const scrapeCacheClear = (libId) =>
  request(`/api/media/scrape-cache?id=${encodeURIComponent(libId)}`, { method: 'DELETE' });

export const systemMetrics = () => request('/api/system/metrics');
export const systemRuntime = () => request('/api/system/runtime');
export const castAvatarUrl = (person) => `/api/media/cast/avatar?person=${encodeURIComponent(person)}`;

/* ---------------------------------------------------------------- 原始文件读取（TXT/字幕等） */

/**
 * 取整个文件内容。带回退：Range 失败则整体拉取。
 * @returns {Promise<{text:string, bytes:number, status:number}>}
 */
export async function fetchTextFile(id, path, { maxBytes = 16 * 1024 * 1024 } = {}) {
  const res = await request(mediaUrl(id, path), { raw: true });
  if (!res.ok) throw new ApiError(`读取文件失败（HTTP ${res.status}）`, res.status, null);
  const buf = await res.arrayBuffer();
  if (buf.byteLength > maxBytes) {
    // 超大文本只取前段，避免一次吃满内存
    const head = buf.slice(0, maxBytes);
    const { decodeText } = await import('./util.js');
    return { text: decodeText(head), bytes: buf.byteLength, status: res.status, truncated: true };
  }
  const { decodeText } = await import('./util.js');
  return { text: decodeText(buf), bytes: buf.byteLength, status: res.status, truncated: false };
}

export async function fetchBinary(url) {
  const res = await request(url, { raw: true });
  if (!res.ok) throw new ApiError(`HTTP ${res.status}`, res.status, null);
  return res;
}

/* ---------------------------------------------------------------- 便捷导出 */

export const urls = { coverUrl, zipPageUrl, epubUrl, mediaUrl, audioStreamUrl, compatUrl, weakProbeUrl, subtitleExtractUrl, subtitleProxyUrl, castAvatarUrl };
