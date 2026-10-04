'use strict';
/**
 * 本地同源网关。
 *
 * 为什么需要它：
 *  - 渲染层是本地 HTML，直连 http(s)://<服务器> 会撞 CORS，且 <video>/<img> 无法携带 Cookie；
 *  - 服务端只有 Cookie 会话（无 API Token），必须由宿主进程统一持有 vh_session。
 *
 * 做法：在 127.0.0.1 起一个极小 HTTP 服务
 *  - /api/** 与 /healthz  → 反代到用户配置的 VaultHub 地址（透传 Range / ETag / 状态码）
 *  - 其它路径             → 提供渲染层静态资源
 * 渲染层因此始终处于同源环境，直接用相对路径 /api/... 即可。
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

/* ---------------- Cookie Jar ---------------- */

class CookieJar {
  constructor(initial, onChange) {
    this.cookies = new Map();
    this.onChange = onChange || (() => {});
    if (initial && typeof initial === 'object') {
      for (const [k, v] of Object.entries(initial)) {
        if (v && typeof v === 'object' && 'value' in v) this.cookies.set(k, v);
      }
    }
  }

  /** 解析 Set-Cookie 头（保留过期时间，剥离 Domain/Secure 等本地不适用属性） */
  absorb(setCookie) {
    if (!setCookie) return;
    const list = Array.isArray(setCookie) ? setCookie : [setCookie];
    let changed = false;
    for (const raw of list) {
      if (!raw) continue;
      const parts = raw.split(';');
      const kv = parts.shift();
      const eq = kv.indexOf('=');
      if (eq < 0) continue;
      const name = kv.slice(0, eq).trim();
      const value = kv.slice(eq + 1).trim();
      const entry = { value };
      for (const attr of parts) {
        const [ak, av] = attr.split('=');
        const key = (ak || '').trim().toLowerCase();
        if (key === 'max-age') entry.maxAge = parseInt(av, 10);
        else if (key === 'expires') entry.expires = (av || '').trim();
        else if (key === 'path') entry.path = (av || '').trim();
      }
      // 过期即删除
      const dead =
        (typeof entry.maxAge === 'number' && entry.maxAge <= 0) ||
        (entry.expires && new Date(entry.expires).getTime() < Date.now());
      if (dead) {
        if (this.cookies.delete(name)) changed = true;
      } else {
        const prev = this.cookies.get(name);
        if (!prev || prev.value !== value) changed = true;
        this.cookies.set(name, entry);
      }
    }
    if (changed) this.onChange(this.serialize());
  }

  header() {
    const now = Date.now();
    const out = [];
    for (const [name, e] of this.cookies) {
      if (e.expires && new Date(e.expires).getTime() < now) continue;
      out.push(`${name}=${e.value}`);
    }
    return out.join('; ');
  }

  has(name) {
    const e = this.cookies.get(name);
    if (!e) return false;
    if (e.expires && new Date(e.expires).getTime() < Date.now()) return false;
    return true;
  }

  serialize() {
    const o = {};
    for (const [k, v] of this.cookies) o[k] = v;
    return o;
  }

  clear() {
    this.cookies.clear();
    this.onChange({});
  }
}

/* ---------------- 静态资源 ---------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

function serveStatic(req, res, staticRoot, urlPath, log) {
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';

  // ⚠ 打包后渲染层位于 app.asar 内，而 Electron 的 asar 文件系统用**正斜杠**索引条目：
  //   用 path.join（Windows 下产生反斜杠）会报
  //   "ENOENT, src\renderer\index.html not found in ...\app.asar"。
  //   因此这里统一用正斜杠拼接；普通目录下 fs 同样接受正斜杠。
  const rootPosix = String(staticRoot).replace(/\\/g, '/');
  const unsafe = path.posix.normalize(rel);
  if (unsafe.includes('..')) {
    log?.(`static ${rel} -> 400 bad path`);
    res.writeHead(400, { 'content-type': 'text/plain' });
    return res.end('bad path');
  }
  const full = path.posix.join(rootPosix, unsafe);
  if (!full.startsWith(rootPosix)) {
    log?.(`static ${rel} -> 403 forbidden`);
    res.writeHead(403, { 'content-type': 'text/plain' });
    return res.end('forbidden');
  }
  fs.stat(full, (err, st) => {
    if (err || !st.isFile()) {
      log?.(`static ${rel} -> 404 (${full}) err=${err ? err.code || err.message : 'not a file'}`);
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('not found');
    }
    const type = MIME[path.posix.extname(full).toLowerCase()] || 'application/octet-stream';
    if (req.method === 'HEAD') {
      log?.(`static ${rel} -> 200 (HEAD) ${type} ${st.size}B`);
      res.writeHead(200, { 'content-type': type, 'content-length': st.size, 'cache-control': 'no-cache' });
      return res.end();
    }
    // 用 readFile 而不是 createReadStream：
    // 在 Electron 的 asar 里 fs.stat 能成功，但 fs.createReadStream 会直接抛
    // ENOENT（实测），导致打包后页面永远打不开。渲染层都是几十 KB 的小文件，
    // 一次性读入内存最简单也最可靠。
    fs.readFile(full, (rerr, buf) => {
      if (rerr) {
        log?.(`static ${rel} -> read error ${rerr.code || rerr.message}`);
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        return res.end('not found');
      }
      log?.(`static ${rel} -> 200 ${type} ${buf.length}B`);
      res.writeHead(200, {
        'content-type': type,
        'content-length': buf.length,
        'cache-control': 'no-cache',
      });
      res.end(buf);
    });
  });
}

/* ---------------- 反代 ---------------- */

function proxyTo(req, res, target, jar, cfg) {
  const isHttps = target.protocol === 'https:';
  const mod = isHttps ? https : http;
  const headers = { ...req.headers };
  delete headers.host;
  delete headers.origin;
  delete headers.referer;
  delete headers['accept-encoding']; // 统一向服务端要未压缩内容，避免二次解码错配
  headers['accept-encoding'] = 'identity';
  headers.connection = 'keep-alive';
  const cookie = jar.header();
  if (cookie) headers.cookie = cookie;
  else delete headers.cookie;

  const options = {
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || (isHttps ? 443 : 80),
    method: req.method,
    path: req.url,
    headers,
    rejectUnauthorized: !cfg.allowSelfSigned,
  };

  const preq = mod.request(options, (pres) => {
    jar.absorb(pres.headers['set-cookie']);
    const out = { ...pres.headers };
    delete out['set-cookie']; // 会话由宿主持有，不下发到渲染层
    delete out.connection;
    delete out['keep-alive'];
    delete out['transfer-encoding']; // 由 Node 自行决定分块
    res.writeHead(pres.statusCode || 502, out);
    if (req.method === 'HEAD') {
      pres.resume();
      return res.end();
    }
    pres.pipe(res);
  });

  preq.setTimeout(0);
  preq.on('error', (err) => {
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
    }
    res.end(
      JSON.stringify({
        ok: false,
        error: `无法连接 VaultHub：${err.message}`,
        hint: '请检查服务器地址、网络可达性，或在设置中允许自签名证书。',
      })
    );
  });

  req.on('aborted', () => preq.destroy());
  res.on('close', () => {
    if (!res.writableEnded) preq.destroy();
  });
  req.pipe(preq);
}

/**
 * @param {object} opts
 * @param {string} opts.staticRoot  渲染层目录
 * @param {() => object} opts.getConfig
 * @param {CookieJar} opts.jar
 * @returns {Promise<{port:number, server:import('http').Server, jar:CookieJar, close:()=>void}>}
 */
function startGateway({ staticRoot, getConfig, jar, log }) {
  const logLine = typeof log === 'function' ? log : () => {};
  const server = http.createServer((req, res) => {
    const cfg = getConfig();
    const isApi = req.url.startsWith('/api/') || req.url === '/healthz' || req.url.startsWith('/healthz?');
    if (!isApi) return serveStatic(req, res, staticRoot, req.url, logLine);

    if (!cfg.serverBase) {
      res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: false, error: '尚未配置 VaultHub 服务器地址' }));
    }
    let target;
    try {
      target = new URL(cfg.serverBase);
    } catch {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: false, error: '服务器地址格式无效' }));
    }
    proxyTo(req, res, target, jar, cfg);
  });

  server.requestTimeout = 0;
  server.headersTimeout = 120000;
  server.keepAliveTimeout = 65000;

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        port,
        server,
        jar,
        close: () =>
          new Promise((r) => {
            server.close(() => r());
            server.closeAllConnections?.();
          }),
      });
    });
  });
}

module.exports = { startGateway, CookieJar };
