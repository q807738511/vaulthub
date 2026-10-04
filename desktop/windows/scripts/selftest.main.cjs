'use strict';
/**
 * VaultHub Desktop 端到端自检（在真实 Electron 进程中运行）
 *
 * 用法（推荐用环境变量传参，避免 Electron/Chromium 的命令行参数解析歧义）：
 *   $env:VH_BASE="http://host:8088"; $env:VH_USER="admin"; $env:VH_PASS="***"; $env:VH_OUT="...\selftest-out"
 *   electron scripts/selftest.main.cjs --no-sandbox --disable-gpu
 *
 * 也兼容位置参数：electron scripts/selftest.main.cjs <base> <user> <pass> [outDir]
 *
 * 它做三件事：
 *  1. 用真实网关（proxy.js）跑一遍接口契约（登录 / 列表 / ETag→304 / 封面 / Range / 播放计划 / 阅读进度）
 *  2. 真正加载渲染层，驱动 UI（登录 → 逐库浏览 → 打开视频/漫画/电子书/音乐）并断言 DOM
 *  3. 输出 JSON 报告与截图到 outDir
 *
 * 使用独立的 userData 目录，不会污染正式安装的用户配置。
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');

// 位置参数里过滤掉 --switch，剩下的按 base/user/pass/out 依次取
const positionals = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const ARG_BASE = process.env.VH_BASE || positionals[0];
const ARG_USER = process.env.VH_USER || positionals[1];
const ARG_PASS = process.env.VH_PASS || positionals[2];
const ARG_OUT = process.env.VH_OUT || positionals[3];
const BASE = (ARG_BASE || '').replace(/\/+$/, '');
const USER = ARG_USER || 'admin';
const PASS = ARG_PASS || '';
const OUT = ARG_OUT || path.join(process.cwd(), 'selftest-out');

const RENDERER_ROOT = path.join(__dirname, '..', 'src', 'renderer');
const report = { startedAt: new Date().toISOString(), base: BASE, steps: [], shots: [], ok: true };
const t0 = Date.now();

// 立即落盘的引导日志：GUI 子系统进程看不到 stdout，任何早期崩溃都靠它定位
const BOOT_LOG = path.join(__dirname, '..', 'selftest-boot.log');
try {
  fs.writeFileSync(BOOT_LOG, `[${new Date().toISOString()}] module-load argv=${JSON.stringify(process.argv.slice(2))}\n`);
} catch {
  /* 忽略 */
}
const boot = (m) => {
  try {
    fs.appendFileSync(BOOT_LOG, `[${new Date().toISOString()}] ${m}\n`);
  } catch {
    /* 忽略 */
  }
  console.log(m);
};
process.on('uncaughtException', (e) => boot(`uncaughtException: ${e.stack || e.message}`));
process.on('unhandledRejection', (e) => boot(`unhandledRejection: ${e && (e.stack || e.message)}`));
boot(`electron-api=${!!(app && app.whenReady)} electron=${process.versions.electron} BASE=${BASE} OUT=${OUT}`);

// 注意：不要再叠加 use-angle=swiftshader / disable-gpu-compositing 之类的开关，
// 实测会让 GPU 进程硬崩并弹出 "electron has stopped working / CrashSender.exe" 对话框。
// 渲染相关开关一律由外部命令行传入。
app.commandLine.appendSwitch('mute-audio');
app.commandLine.appendSwitch('noerrdialogs');
app.commandLine.appendSwitch('disable-crash-reporter');
app.commandLine.appendSwitch('disable-breakpad');

function persist() {
  try {
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
  } catch {
    /* 报告写入失败不应影响自检本身 */
  }
}

function step(name, ok, detail) {
  report.steps.push({ name, ok: !!ok, detail: detail === undefined ? '' : detail, ms: Date.now() - t0 });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) report.ok = false;
  persist(); // 增量落盘：即使后续进程崩溃也能拿到已完成的结果
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 从路径取文件名（去扩展名），用于给播放器一个标题 */
const popTitle = (p) => String(p).split('/').pop().replace(/\.[^.]+$/, '');

/**
 * 安全解析 JSON。
 * 服务端 media-go 掉线时 Caddy 会返回 502 且响应体为空，
 * 直接 JSON.parse 会抛 "Unexpected end of JSON input" 并中断整个自检 —— 这里给出可读原因。
 */
function safeJson(buf, label) {
  const t = buf.toString();
  if (!t) throw new Error(`${label} 返回空响应体（服务端 media-go 未就绪或 Caddy 502）`);
  try {
    return JSON.parse(t);
  } catch {
    throw new Error(`${label} 返回非 JSON 内容：${t.slice(0, 140)}`);
  }
}

/** 在渲染层里执行并等待 Promise */
async function js(wc, code) {
  return wc.executeJavaScript(`(async () => { ${code} })()`, true);
}

async function waitFor(wc, expr, timeoutMs = 20000, label = expr) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const v = await js(wc, `return (${expr});`);
      if (v) return v;
    } catch {
      /* 页面尚未就绪 */
    }
    await sleep(250);
  }
  throw new Error(`等待超时: ${label}`);
}

async function shot(wc, name) {
  const p = path.join(OUT, `${name}.png`);
  let buf = null;
  // 首选 capturePage
  try {
    const img = await wc.capturePage();
    if (!img.isEmpty()) buf = img.toPNG();
  } catch {
    /* 退到 CDP */
  }
  // 回退：CDP Page.captureScreenshot（软件渲染下更稳）
  if (!buf) {
    try {
      const dbg = wc.debugger;
      if (!dbg.isAttached()) dbg.attach('1.3');
      const r = await dbg.sendCommand('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      buf = Buffer.from(r.data, 'base64');
      dbg.detach();
    } catch (e) {
      console.log(`      截图失败 ${name}: ${e.message}`);
      report.shots.push({ name, failed: e.message });
      return null;
    }
  }
  try {
    fs.writeFileSync(p, buf);
    // 采样确认不是纯色/空白
    const set = new Set();
    for (let i = 0; i < buf.length; i += 997) set.add(buf[i]);
    report.shots.push({ name, file: p, bytes: buf.length, sampleDistinct: set.size });
    console.log(`      截图 ${name}.png (${buf.length} B)`);
    return p;
  } catch (e) {
    console.log(`      截图写入失败 ${name}: ${e.message}`);
    return null;
  }
}

/* ---------------------------------------------------------------- 直接 HTTP 辅助（绕过网关，用于对照） */

function rawRequest(urlStr, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const mod = u.protocol === 'https:' ? require('https') : http;
    const req = mod.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        method,
        path: u.pathname + u.search,
        headers: { 'accept-encoding': 'identity', ...headers },
        rejectUnauthorized: false,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) })
        );
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/* ---------------------------------------------------------------- 主流程 */

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  // 独立 userData，避免污染正式配置；缓存也落在输出目录内
  const userData = path.join(OUT, 'userdata');
  fs.mkdirSync(userData, { recursive: true });
  app.setPath('userData', userData);
  for (const [k, sub] of [['cache', 'cache'], ['logs', 'logs'], ['temp', 'tmp']]) {
    const d = path.join(userData, sub);
    fs.mkdirSync(d, { recursive: true });
    app.setPath(k, d);
  }
  app.commandLine.appendSwitch('disk-cache-dir', path.join(userData, 'cache'));

  const store = require('../src/main/store.js');
  const { startGateway, CookieJar } = require('../src/main/proxy.js');
  const { registerIpc } = require('../src/main/ipc.js');

  await app.whenReady();

  // 预置服务器地址，让客户端直接进入「登录」而不是首次连接向导
  store.saveConfig({ serverBase: BASE, allowSelfSigned: true, themePinned: false });

  const jar = new CookieJar({}, (c) => store.saveSession(c));
  const gw = await startGateway({ staticRoot: RENDERER_ROOT, getConfig: () => store.loadConfig(), jar });
  const origin = `http://127.0.0.1:${gw.port}`;
  report.gatewayPort = gw.port;
  console.log(`网关: ${origin}  →  ${BASE}`);

  /* ============ 阶段 1：接口契约（走网关，与渲染层同一条链路） ============ */

  // 1.1 健康检查
  {
    const r = await rawRequest(`${origin}/healthz`);
    step('healthz 经网关可达', r.status === 200 && r.body.toString().includes('ok'), `${r.status} ${r.body.toString().trim()}`);
  }

  // 1.2 登录（会话 Cookie 由网关持有）
  let loginBody = null;
  {
    const body = JSON.stringify({ username: USER, password: PASS });
    const r = await rawRequest(`${origin}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    loginBody = r.body.toString();
    step('POST /api/login 200', r.status === 200, loginBody.slice(0, 120));
    step('网关持有 vh_session', jar.has('vh_session'), jar.has('vh_session') ? 'Cookie 已捕获并持久化' : '未捕获');
  }

  // 1.3 库列表 + 逐库列表 + ETag 条件请求
  let libraries = [];
  {
    const r = await rawRequest(`${origin}/api/media/libraries`);
    libraries = safeJson(r.body, "GET /api/media/libraries").libraries || [];
    step('GET /api/media/libraries', r.status === 200 && libraries.length > 0, `${libraries.length} 个库: ${libraries.map((l) => `${l.id}[${l.type}]`).join(', ')}`);
  }

  for (const lib of libraries) {
    const url = `${origin}/api/media/files?id=${encodeURIComponent(lib.id)}&offset=0&limit=50`;
    const r1 = await rawRequest(url);
    const etag = r1.headers.etag;
    let total = null;
    let version = null;
    try {
      const j = JSON.parse(r1.body.toString());
      total = j.total;
      version = j.version;
    } catch {
      /* 忽略 */
    }
    step(
      `列表 ${lib.type} (${lib.id})`,
      r1.status === 200 && !!etag,
      `total=${total} version=${version} etag=${etag ? '有' : '无'} bytes=${r1.body.length}`
    );

    if (etag) {
      const r2 = await rawRequest(url, { headers: { 'if-none-match': etag } });
      step(`列表 ${lib.type} If-None-Match → 304`, r2.status === 304, `status=${r2.status} bytes=${r2.body.length}`);
    }
  }

  // 1.4 封面
  {
    const lib = libraries.find((l) => l.type === 'audio') || libraries[0];
    const lr = await rawRequest(`${origin}/api/media/files?id=${encodeURIComponent(lib.id)}&offset=0&limit=400`);
    const files = safeJson(lr.body, "GET /api/media/files").files || [];
    const img = files.find((f) => /\.(jpe?g|png|webp)$/i.test(f.path));
    if (img) {
      const cr = await rawRequest(
        `${origin}/api/media/cover/?id=${encodeURIComponent(lib.id)}&path=${encodeURIComponent(img.path)}&w=320`
      );
      step(
        '封面缩略图 w=320',
        cr.status === 200 && cr.headers['content-type']?.startsWith('image/'),
        `${cr.status} ${cr.headers['content-type']} ${cr.body.length}B cache=${cr.headers['cache-control']}`
      );
    } else {
      step('封面缩略图 w=320', false, '未在库中找到图片文件');
    }
  }

  // 1.5 播放计划 + Range
  {
    const lib = libraries.find((l) => l.type === 'movie');
    if (lib) {
      const lr = await rawRequest(`${origin}/api/media/files?id=${encodeURIComponent(lib.id)}&offset=0&limit=1000`);
      const files = safeJson(lr.body, "GET /api/media/files").files || [];
      const vid = files.find((f) => /\.(mp4|mkv|m2ts|ts|avi)$/i.test(f.path) && !/BDMV\//i.test(f.path));
      if (vid) {
        const planBody = JSON.stringify({
          library_id: lib.id,
          path: vid.path,
          quality: 'auto',
          hardware: 'auto',
          client: { mp4: true, mse: true, h264: true, hevc: true, vp9: true, av1: true, aac: true, opus: true, mp3: true, flac: true },
        });
        const pr = await rawRequest(`${origin}/api/media/playback/plan`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: planBody,
        });
        let pj = null;
        try {
          pj = JSON.parse(pr.body.toString());
        } catch {
          /* 忽略 */
        }
        step(
          'POST /api/media/playback/plan',
          pr.status === 200 && !!pj?.url,
          `mode=${pj?.mode} layer=${pj?.layer} container=${pj?.media?.container} v=${pj?.media?.video_codec} ${pj?.media?.width}x${pj?.media?.height} reason=${pj?.reason}`
        );
        report.planSample = { path: vid.path, plan: pj };

        const fr = await rawRequest(`${origin}/api/media/file?id=${encodeURIComponent(lib.id)}&path=${encodeURIComponent(vid.path)}`, {
          headers: { range: 'bytes=0-2047' },
        });
        step(
          'GET /api/media/file Range 206',
          fr.status === 206 && fr.body.length === 2048,
          `${fr.status} content-range=${fr.headers['content-range']} bytes=${fr.body.length}`
        );
      } else {
        step('视频播放计划', false, '电影库未找到视频文件');
      }
    }
  }

  // 1.6 音频流（bitrate 必填）
  {
    const lib = libraries.find((l) => l.type === 'audio');
    if (lib) {
      const lr = await rawRequest(`${origin}/api/media/files?id=${encodeURIComponent(lib.id)}&offset=0&limit=400`);
      const files = safeJson(lr.body, "GET /api/media/files").files || [];
      const au = files.find((f) => /\.(mp3|flac|m4a|ogg|wav|ape|opus)$/i.test(f.path));
      if (au) {
        const ok = await rawRequest(
          `${origin}/api/media/audio/stream?id=${encodeURIComponent(lib.id)}&path=${encodeURIComponent(au.path)}&bitrate=192`,
          { headers: { range: 'bytes=0-1023' } }
        );
        const bad = await rawRequest(
          `${origin}/api/media/audio/stream?id=${encodeURIComponent(lib.id)}&path=${encodeURIComponent(au.path)}`
        );
        step('音频流 Range 206（带 bitrate）', ok.status === 206, `${ok.status} bytes=${ok.body.length} type=${ok.headers['content-type']}`);
        step('音频流缺 bitrate → 400', bad.status === 400, `${bad.status} ${bad.body.toString().slice(0, 60)}`);
      } else {
        step('音频流', false, '音乐库未找到音频文件');
      }
    }
  }

  // 1.7 漫画压缩包 register + page
  {
    const lib = libraries.find((l) => l.type === 'comic');
    if (lib) {
      const lr = await rawRequest(`${origin}/api/media/files?id=${encodeURIComponent(lib.id)}&offset=0&limit=2000`);
      const files = safeJson(lr.body, "GET /api/media/files").files || [];
      const arc = files.find((f) => /\.(zip|cbz|rar|cbr|7z)$/i.test(f.path));
      if (arc) {
        const rr = await rawRequest(
          `${origin}/api/media/archive/zip/register?id=${encodeURIComponent(lib.id)}&path=${encodeURIComponent(arc.path)}`
        );
        let rj = null;
        try {
          rj = JSON.parse(rr.body.toString());
        } catch {
          /* 忽略 */
        }
        const entries = rj?.entries || [];
        step('漫画 register 页清单', rr.status === 200 && entries.length > 0, `${rr.status} total=${rj?.total} entries=${entries.length}`);
        if (entries.length) {
          const e0 = entries[0].name || entries[0].raw;
          const pg = await rawRequest(
            `${origin}/api/media/archive/zip/page?id=${encodeURIComponent(lib.id)}&path=${encodeURIComponent(arc.path)}&entry=${encodeURIComponent(e0)}&w=800`
          );
          step(
            '漫画页 w=800 缩略',
            pg.status === 200 && pg.headers['content-type']?.startsWith('image/'),
            `${pg.status} ${pg.headers['content-type']} ${pg.body.length}B`
          );
          report.comicSample = { lib: lib.id, path: arc.path, entry: e0, firstPage: entries[0] };
        }
      } else {
        step('漫画 register', false, '漫画库未找到压缩包');
      }
    }
  }

  // 1.8 阅读进度写回 / 读回（跨端共享能力）
  {
    const lib = libraries.find((l) => l.type === 'book');
    if (lib) {
      const lr = await rawRequest(`${origin}/api/media/files?id=${encodeURIComponent(lib.id)}&offset=0&limit=200`);
      const files = safeJson(lr.body, "GET /api/media/files").files || [];
      const bk = files.find((f) => /\.(txt|epub|pdf)$/i.test(f.path));
      if (bk) {
        const q = `id=${encodeURIComponent(lib.id)}&path=${encodeURIComponent(bk.path)}`;
        const marker = { progress: 37.5, page: 42, total: 120 };
        const put = await rawRequest(`${origin}/api/media/reading/progress?${q}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(marker),
        });
        step('PUT 阅读进度', put.status === 200, `${put.status} ${put.body.toString().slice(0, 120)}`);
        const get = await rawRequest(`${origin}/api/media/reading/progress?${q}`);
        const gj = safeJson(get.body, "GET /api/media/reading/progress");
        // 服务端始终返回 {id, items:{path:{...}}}，带 path 也不收窄
        const entry = gj && gj.items ? gj.items[bk.path] : gj;
        const ok = entry && entry.progress === marker.progress && entry.page === marker.page && entry.total === marker.total;
        step(
          'GET 阅读进度读回一致',
          ok,
          `progress=${entry?.progress} page=${entry?.page} total=${entry?.total}（响应为 {id,items} 映射）`
        );
        // DELETE 也应生效
        const del = await rawRequest(`${origin}/api/media/reading/progress?${q}`, { method: 'DELETE' });
        const after = safeJson((await rawRequest(`${origin}/api/media/reading/progress?${q}`)).body, "GET reading/progress");
        const gone = !(after.items && after.items[bk.path]);
        step('DELETE 阅读进度生效', del.status === 200 && gone, `DELETE=${del.status} 条目已移除=${gone}`);
        report.readingSample = { lib: lib.id, path: bk.path, wrote: marker, readBack: entry };
      } else {
        step('阅读进度', false, '电子书库未找到文档');
      }
    }
  }

  // 1.9 元数据 / 设置 / 索引状态
  {
    const r = await rawRequest(`${origin}/api/media/settings`);
    step('GET /api/media/settings', r.status === 200, `bytes=${r.body.length}`);
    const s = await rawRequest(`${origin}/api/media/index/status`);
    let sj = null;
    try {
      sj = safeJson(s.body, "GET /api/media/index/status");
    } catch {
      /* 忽略 */
    }
    step('GET /api/media/index/status', s.status === 200, `running=${sj?.running} libs=${sj?.libraries?.length}`);
  }

  // 1.10 找一个真正能被 Chromium 播放的视频（用于后面的真实解码验证）
  //      本媒体库的现状：电影都是 HEVC（需全转码，实测服务端 0 字节输出），
  //      剧集里有 H.264 的 MKV（audio_transcode，实测可出流）。
  let playable = null;
  {
    const lib = libraries.find((l) => l.type === 'series');
    const CLIENT_CAPS = {
      mp4: true, webm: true, mse: true, h264: true, hevc: false, vp9: true,
      av1: false, aac: true, mp3: true, opus: true, vorbis: true, flac: true,
    };
    const cands = [];
    if (lib) {
      for (let page = 0; page < 4 && cands.length < 40; page += 1) {
        const r = await rawRequest(
          `${origin}/api/media/files?id=${encodeURIComponent(lib.id)}&offset=${page * 500}&limit=500`
        );
        const files = safeJson(r.body, "API").files || [];
        for (const f of files) {
          if (/\.(mp4|mkv|m4v|mov)$/i.test(f.path) && !/BDMV\//i.test(f.path)) cands.push(f);
        }
        if (!files.length) break;
      }
    }
    // 优先挑最小的（转码更快）
    cands.sort((a, b) => (a.size || 0) - (b.size || 0));
    for (const c of cands.slice(0, 10)) {
      const pr = await rawRequest(`${origin}/api/media/playback/plan`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          library_id: lib.id, path: c.path, quality: 'auto', hardware: 'auto', client: CLIENT_CAPS,
        }),
      });
      let pj = null;
      try {
        pj = JSON.parse(pr.body.toString());
      } catch {
        continue;
      }
      if (!pj?.url) continue;
      const target = pj.url.startsWith('http') ? pj.url : `${origin}${pj.url}`;
      const t0 = Date.now();
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 25000);
        const sr = await fetch(target, { signal: ctrl.signal, headers: { 'accept-encoding': 'identity' } });
        let bytes = 0;
        const reader = sr.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.length;
          if (bytes >= 32768) break;
        }
        try {
          await reader.cancel();
        } catch {
          /* 忽略 */
        }
        clearTimeout(timer);
        if (bytes > 0) {
          playable = { libId: lib.id, path: c.path, size: c.size, mode: pj.mode, bytes, ms: Date.now() - t0 };
          break;
        }
      } catch {
        /* 该候选无输出，换下一个 */
      }
    }
    if (playable) {
      step(
        '找到可播放视频（转码流确有输出）',
        true,
        `${playable.mode} · ${(playable.size / 1048576).toFixed(0)}MiB · 首包 ${playable.bytes}B/${playable.ms}ms · ${playable.path.slice(-56)}`
      );
    } else {
      step('找到可播放视频', false, `扫描 ${cands.length} 个候选，服务端均无可播放输出`);
    }
    report.playableSample = playable;
  }

  /* ============ 阶段 2：真实 UI 驱动 ============ */

  // 前面的接口阶段已经用网关登录过，这里先清空会话，
  // 让窗口从「未登录」开始，才能真正验证登录 gate 与 401 → 重登路径。
  jar.clear();
  store.clearSession();

  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    show: true, // 需要真实合成帧才能截图与解码视频
    backgroundColor: '#0B1413',
    webPreferences: {
      preload: path.join(__dirname, '..', 'src', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const wc = win.webContents;
  // 渲染层的所有控制台输出与加载失败都写进 boot log（GUI 进程看不到 stdout）
  wc.on('console-message', (...args) => {
    let level;
    let message;
    let source;
    let line;
    if (args.length === 1 && args[0] && typeof args[0] === 'object' && 'message' in args[0]) {
      ({ level, message, sourceId: source, lineNumber: line } = args[0]);
    } else {
      const [, l, m, ln, sid] = args;
      level = l;
      message = m;
      line = ln;
      source = sid;
    }
    boot(`[renderer:${level}] ${message}  @${source || '?'}:${line || '?'}`);
  });
  wc.on('preload-error', (_e, preloadPath, err) => boot(`[preload-error] ${preloadPath}: ${err && err.message}`));
  wc.on('did-fail-load', (_e, code, desc, url) => boot(`[did-fail-load] ${code} ${desc} ${url}`));
  wc.on('render-process-gone', (_e, details) => boot(`[render-process-gone] ${JSON.stringify(details)}`));

  // 注册宿主 IPC —— 与正式 main.js 共用同一实现，否则渲染层 config:get 会报无 handler
  registerIpc({ getGateway: () => ({ port: gw.port, jar }), getWindow: () => win });

  await win.loadURL(`${origin}/`);
  await sleep(600);
  await shot(wc, '01-login-gate');

  // 启动流程包含一次 /healthz + /api/auth/mode 探测，需要等待 gate 真正渲染出来
  let gateTitle = '';
  try {
    gateTitle = await waitFor(
      wc,
      `document.querySelector('.gate h1')?.textContent || ''`,
      25000,
      '登录 gate 出现'
    );
  } catch {
    gateTitle = '';
  }
  const gateErr = await js(
    wc,
    `return (document.querySelector('.gate pre')?.textContent || document.querySelector('.gate-card')?.innerText || '').slice(0, 900);`
  );
  step('渲染层加载并显示登录页', /登录|连接/.test(gateTitle), `gate 标题=「${gateTitle}」`);
  if (!/登录|连接/.test(gateTitle)) {
    boot(`渲染层启动失败，页面文本:\n${gateErr}`);
    step('渲染层启动错误详情', false, gateErr.replace(/\s+/g, ' ').slice(0, 300));
  }

  // 通过网关登录（等价于用户点击“登录”）
  const loginRes = await js(
    wc,
    `const r = await fetch('/api/login', {method:'POST',headers:{'Content-Type':'application/json'},
       body: JSON.stringify({username: ${JSON.stringify(USER)}, password: ${JSON.stringify(PASS)}})});
     return { status: r.status, body: (await r.text()).slice(0,200) };`
  );
  step('渲染层通过网关登录', loginRes.status === 200, JSON.stringify(loginRes));

  // 重新加载：boot() 应发现有效会话并直接进入主界面
  await win.loadURL(`${origin}/`);
  await waitFor(wc, `document.getElementById('app')?.classList.contains('ready')`, 25000, '#app.ready');

  const navCount = await js(wc, `return document.querySelectorAll('#nav .nav-item[data-lib]').length;`);
  step('侧栏渲染出媒体库入口', navCount === libraries.length, `${navCount} / ${libraries.length}`);
  await shot(wc, '02-home');

  const homeCards = await js(wc, `return document.querySelectorAll('.lib-grid .lib-card').length;`);
  step('首页库卡片渲染', homeCards > 0, `${homeCards} 张`);
  const footVer = await js(wc, `return document.getElementById('footVer')?.textContent || '';`);
  step('侧栏版本号显示', /v\d/.test(footVer), footVer);

  // 逐库浏览
  const summary = {};
  for (const lib of libraries) {
    try {
      await js(wc, `document.querySelector('#nav .nav-item[data-lib="${lib.id}"]').click(); return true;`);
      await sleep(900);
      // 等待条目或空态
      await waitFor(
        wc,
        `document.querySelectorAll('.grid-posters .card, .audio-tabs, .empty').length > 0`,
        25000,
        `库 ${lib.id} 渲染`
      );
      const info = await js(
        wc,
        `return {
           cards: document.querySelectorAll('.grid-posters .card').length,
           tabbed: !!document.querySelector('.audio-tabs'),
           tabs: document.querySelectorAll('.audio-tabs .tab').length,
           empty: document.querySelectorAll('.empty').length,
           imgs: document.querySelectorAll('.thumb img').length,
           loaded: document.querySelectorAll('.thumb img.loaded').length,
           title: document.getElementById('topTitle')?.textContent || ''
         };`
      );
      summary[lib.type] = info;
      step(
        `浏览「${lib.name}」(${lib.type})`,
        info.cards > 0 || info.tabbed,
        `卡片=${info.cards} 图片=${info.loaded}/${info.imgs}${info.tabbed ? ` 音乐tab=${info.tabs}` : ''}`
      );
      await shot(wc, `03-lib-${lib.type}`);
    } catch (e) {
      step(`浏览「${lib.name}」(${lib.type})`, false, e.message);
    }
  }
  report.librarySummary = summary;

  // 剧集 → 真实视频解码（**先跑这一步**：电影都是 4K HEVC 全转码，
  // 实测服务端会一直不产出数据并占住转码槽，先跑电影会把剧集也拖死）
  async function runSeriesPlaybackTest() {
    if (!playable) return;
    try {
      // 注意：openItem 需要的是**媒体库对象**（取 lib.id 拼播放计划），不是 libId 字符串
      const libObj = libraries.find((l) => l.id === playable.libId);
      const item = { path: playable.path, title: popTitle(playable.path), size: playable.size };
      await js(wc, `await window.__vhOpenItem(${JSON.stringify(libObj)}, ${JSON.stringify(item)}, null); return true;`);
      await waitFor(
        wc,
        `!!document.querySelector('.player') && !document.querySelector('.player').classList.contains('hidden')`,
        15000,
        '播放器打开'
      );
      await waitFor(
        wc,
        `!!(document.querySelector('.player video')?.currentSrc || document.querySelector('.player video')?.src)`,
        30000,
        '播放 URL 落地'
      );
      let meta = false;
      try {
        await waitFor(wc, `(document.querySelector('.player video')?.readyState || 0) >= 1`, 90000, '剧集视频元数据');
        meta = true;
      } catch {
        meta = false;
      }
      const v1 = await js(
        wc,
        `const v = document.querySelector('.player video');
         return { src: v.currentSrc || v.src, duration: v.duration, w: v.videoWidth, h: v.videoHeight,
                  readyState: v.readyState, mode: document.querySelector('[data-role="mode"]')?.textContent || '',
                  cap: document.querySelector('[data-role="cap"]')?.textContent || '',
                  msg: (document.querySelector('.player-msg')?.textContent || '').slice(0, 160) };`
      );
      step(
        '剧集视频（H.264 MKV → 音频转码）真实解码',
        meta && v1.duration > 0 && v1.w > 0,
        meta
          ? `时长=${Math.round(v1.duration)}s ${v1.w}x${v1.h} readyState=${v1.readyState} 模式=${v1.mode}`
          : `未拿到元数据 readyState=${v1.readyState} 模式=${v1.mode} 提示=${v1.msg}`
      );
      step('剧集播放器展示服务端决策', !!v1.mode, `${v1.mode} · ${v1.cap.slice(0, 110)}`);
      report.seriesSample = { ...playable, ...v1, meta };

      let advanced = false;
      try {
        await waitFor(wc, `(document.querySelector('.player video')?.currentTime || 0) > 1.0`, 40000, '视频播放推进');
        advanced = true;
      } catch {
        advanced = false;
      }
      const v2 = await js(
        wc,
        `const v = document.querySelector('.player video');
         return { t: v.currentTime, paused: v.paused, buffered: v.buffered.length ? v.buffered.end(v.buffered.length - 1) : 0 };`
      );
      step(
        '视频播放进度真实推进',
        advanced,
        `currentTime=${(v2.t || 0).toFixed(2)}s 已缓冲=${(v2.buffered || 0).toFixed(1)}s paused=${v2.paused}`
      );
      const seeked = await js(
        wc,
        `const v = document.querySelector('.player video');
         v.currentTime = Math.min((v.duration || 0) * 0.25, 60);
         await new Promise(r => setTimeout(r, 2500));
         return { t: v.currentTime, readyState: v.readyState, err: v.error ? v.error.code : null };`
      );
      step(
        '拖动进度（转码流 seek）',
        seeked.t > 0,
        `seek 后 currentTime=${seeked.t.toFixed(2)}s readyState=${seeked.readyState} err=${seeked.err}`
      );
      await shot(wc, '04-player-series');
      await js(wc, `document.querySelector('.player [data-act="close"]')?.click(); return true;`);
      await sleep(1200);
    } catch (e) {
      step('剧集视频播放', false, e.message);
    }
  }

  await runSeriesPlaybackTest();

  // 电影 → 播放器（这一步验证「点卡片能开播放器 + 拿到服务端播放决策」；
  // 本库电影都是 HEVC，需要全转码，而实测服务端全转码 0 字节输出，
  // 所以是否能真的解出画面属于**服务端能力**，这里如实记录，不当作客户端失败。）
  {
    const lib = libraries.find((l) => l.type === 'movie');
    if (lib) {
      try {
        await js(wc, `document.querySelector('#nav .nav-item[data-lib="${lib.id}"]').click(); return true;`);
        await waitFor(wc, `document.querySelectorAll('.grid-posters .card').length > 0`, 25000, '电影卡片');
        const nCards = await js(wc, `return document.querySelectorAll('.grid-posters .card').length;`);
        await js(wc, `document.querySelector('.grid-posters .card').click(); return true;`);
        await waitFor(
          wc,
          `!!document.querySelector('.player') && !document.querySelector('.player').classList.contains('hidden')`,
          15000,
          '播放器打开'
        );
        // 必须等到播放地址指向**本电影库**，否则可能读到上一次播放留下的旧 src
        await waitFor(
          wc,
          `((document.querySelector('.player video')?.currentSrc || '') + (document.querySelector('.player video')?.src || '')).includes('${lib.id}')`,
          30000,
          '电影播放 URL 落地'
        );
        const p = await js(
          wc,
          `const v = document.querySelector('.player video');
           return { src: v?.currentSrc || v?.src || '', readyState: v?.readyState, duration: v?.duration,
                    err: v?.error?.code ?? null,
                    mode: document.querySelector('[data-role="mode"]')?.textContent || '',
                    cap: document.querySelector('[data-role="cap"]')?.textContent || '',
                    msg: document.querySelector('.player-msg')?.textContent || '' };`
        );
        step('点电影卡片可打开播放器', true, `电影库卡片=${nCards}`);
        step('播放器取得播放 URL 并开始加载', !!p.src && p.src.includes('/api/media/'), `src=${decodeURIComponent(p.src).slice(0, 110)}`);
        step('播放器展示服务端播放决策与理由', !!p.mode, `模式=${p.mode} · ${p.cap.slice(0, 120)}`);
        report.movieSample = { cards: nCards, ...p };

        // 最多等 30s，看服务端转码是否真的会出画面；不出也如实记录
        let moviePlayed = false;
        try {
          await waitFor(wc, `(document.querySelector('.player video')?.readyState || 0) >= 1`, 30000, '电影元数据');
          moviePlayed = true;
        } catch {
          moviePlayed = false;
        }
        const p2 = await js(
          wc,
          `const v = document.querySelector('.player video');
           return { duration: v?.duration, w: v?.videoWidth, h: v?.videoHeight, readyState: v?.readyState,
                    msg: (document.querySelector('.player-msg')?.textContent || '').slice(0, 200) };`
        );
        step(
          '电影（4K HEVC / 全转码）真实解码',
          moviePlayed && p2.duration > 0,
          moviePlayed
            ? `时长=${Math.round(p2.duration)}s ${p2.w}x${p2.h}`
            : `服务端全转码未输出可播放数据（readyState=${p2.readyState}）—— 服务端限制，非客户端缺陷`
        );
        report.movieSample = { ...report.movieSample, played: moviePlayed, ...p2 };
        await sleep(400);
        await shot(wc, '04-player-movie');
        await js(wc, `document.querySelector('.player [data-act="close"]')?.click(); return true;`);
        await sleep(700);
      } catch (e) {
        step('电影播放', false, e.message);
      }
    }
  }

  // 剧集播放测试已在电影测试之前执行（见 runSeriesPlaybackTest）

  // 漫画 → 阅读器
  {
    const lib = libraries.find((l) => l.type === 'comic');
    if (lib) {
      try {
        if (await js(wc, `return !document.querySelector('.player')?.classList.contains('hidden');`)) {
          await js(wc, `document.querySelector('.player [data-act="close"]').click(); return true;`);
          await sleep(800);
        }
        await js(wc, `document.querySelector('#nav .nav-item[data-lib="${lib.id}"]').click(); return true;`);
        await waitFor(wc, `document.querySelectorAll('.grid-posters .card').length > 0`, 25000, '漫画卡片');
        await js(wc, `document.querySelector('.grid-posters .card').click(); return true;`);
        await waitFor(wc, `!document.querySelector('.reader')?.classList.contains('hidden')`, 15000, '阅读器打开');
        await waitFor(wc, `(document.querySelector('.reader-body img.comic-page')?.naturalWidth || 0) > 0`, 40000, '漫画页解码');
        const c = await js(
          wc,
          `const img = document.querySelector('.reader-body img.comic-page');
           return { w: img?.naturalWidth, h: img?.naturalHeight, pos: document.querySelector('[data-role="pos"]')?.textContent || '' };`
        );
        step('漫画页真实解码', c.w > 0, `${c.w}x${c.h} 位置=${c.pos}`);
        await sleep(1200);
        const sync = await js(wc, `return document.querySelector('[data-role="sync"]')?.textContent || '';`);
        step('漫画阅读进度已同步服务端', /同步/.test(sync), sync);
        await shot(wc, '05-comic-reader');
        await js(wc, `document.querySelector('.reader [data-act="close"]').click(); return true;`);
        await sleep(600);
      } catch (e) {
        step('漫画阅读', false, e.message);
      }
    }
  }

  // 电子书（TXT）→ 阅读器 + 中文编码
  {
    const lib = libraries.find((l) => l.type === 'book');
    if (lib) {
      try {
        await js(wc, `document.querySelector('#nav .nav-item[data-lib="${lib.id}"]').click(); return true;`);
        await waitFor(wc, `document.querySelectorAll('.grid-posters .card').length > 0`, 30000, '电子书卡片');
        await js(wc, `document.querySelector('.grid-posters .card').click(); return true;`);
        await waitFor(wc, `!document.querySelector('.reader')?.classList.contains('hidden')`, 20000, '电子书阅读器');
        await waitFor(wc, `(document.querySelector('.book-text, .book-chapter')?.textContent || '').length > 50`, 40000, '正文渲染');
        const b = await js(
          wc,
          `const t = document.querySelector('.book-text, .book-chapter')?.textContent || '';
           const cjk = (t.match(/[\\u4e00-\\u9fff]/g) || []).length;
           const bad = (t.match(/\\uFFFD/g) || []).length;
           return { len: t.length, cjk, bad, head: t.slice(0, 80) };`
        );
        step('电子书正文渲染且中文可读', b.len > 50 && b.cjk > 10, `${b.len} 字符, 汉字 ${b.cjk}, 替换符 ${b.bad}`);
        step('文本编码探测正确（无乱码替换符）', b.bad === 0, `替换符 ${b.bad} 个；开头「${b.head.replace(/\s+/g, ' ')}」`);
        await sleep(1000);
        await shot(wc, '06-book-reader');
        await js(wc, `document.querySelector('.reader [data-act="close"]').click(); return true;`);
        await sleep(600);
      } catch (e) {
        step('电子书阅读', false, e.message);
      }
    }
  }

  // 音乐 → 播放
  {
    const lib = libraries.find((l) => l.type === 'audio');
    if (lib) {
      try {
        await js(wc, `document.querySelector('#nav .nav-item[data-lib="${lib.id}"]').click(); return true;`);
        await waitFor(wc, `document.querySelectorAll('.audio-tabs .tab').length > 0`, 25000, '音乐视图');
        const tabs = await js(wc, `return [...document.querySelectorAll('.audio-tabs .tab')].map(t=>t.textContent.trim());`);
        step('音乐视图五个 tab', tabs.length === 5, tabs.join(' / '));
        await js(wc, `document.querySelector('.grid-posters .card')?.click(); return true;`);
        await waitFor(wc, `!!document.querySelector('.abar') && !document.querySelector('.abar').classList.contains('hidden')`, 20000, '音乐播放条');
        const a = await js(
          wc,
          `const bar = document.querySelector('.abar');
           return { barVisible: !!bar && !bar.classList.contains('hidden'),
                    title: document.querySelector('.abar [data-role="t"]')?.textContent || '',
                    artist: document.querySelector('.abar [data-role="a"]')?.textContent || '',
                    hasAudio: !!window.__vhAudio,
                    src: window.__vhAudio?.src || '',
                    paused: window.__vhAudio?.paused };`
        );
        step('音乐播放条出现', !!a.barVisible, `${a.title} — ${a.artist}`);
        step('音频流地址已设置', !!a.src && a.src.includes('/api/media/audio/stream'), `src=${decodeURIComponent(a.src).slice(0, 110)}`);
        // 等真正开始播放（currentTime 前进）
        let progressed = false;
        try {
          await waitFor(wc, `(window.__vhAudio?.currentTime || 0) > 0.3`, 25000, '音频播放推进');
          progressed = true;
        } catch {
          progressed = false;
        }
        const ap = await js(
          wc,
          `const au = window.__vhAudio;
           return { cur: au?.currentTime, dur: au?.duration, paused: au?.paused, readyState: au?.readyState, err: au?.error?.code ?? null };`
        );
        step(
          '音频真实解码并推进播放',
          progressed && ap.dur > 0,
          `currentTime=${(ap.cur || 0).toFixed(2)}s 时长=${(ap.dur || 0).toFixed(1)}s paused=${ap.paused} readyState=${ap.readyState}`
        );
        await shot(wc, '07-audio');
      } catch (e) {
        step('音乐播放', false, e.message);
      }
    }
  }

  // 主题切换
  {
    try {
      await js(wc, `document.getElementById('btnTheme').click(); return true;`);
      await sleep(700);
      const mode = await js(wc, `return document.documentElement.dataset.mode;`);
      step('明暗主题切换', mode === 'light', `data-mode=${mode}`);
      await shot(wc, '08-light-theme');
      await js(wc, `document.getElementById('btnTheme').click(); return true;`);
      await sleep(400);
    } catch (e) {
      step('主题切换', false, e.message);
    }
  }

  // 搜索
  {
    try {
      await js(
        wc,
        `const s = document.getElementById('topSearch'); s.value = 'a'; s.dispatchEvent(new Event('input')); return true;`
      );
      await sleep(3500);
      const r = await js(wc, `return { hint: document.querySelector('[data-role="hint"]')?.textContent || '', cards: document.querySelectorAll('.grid-posters .card').length };`);
      step('搜索返回结果', r.cards > 0, `命中卡片=${r.cards} · ${r.hint}`);
      await shot(wc, '09-search');
    } catch (e) {
      step('搜索', false, e.message);
    }
  }

  // 设置页
  {
    try {
      await js(wc, `document.getElementById('btnSettings').click(); return true;`);
      await waitFor(wc, `document.querySelectorAll('.set-nav .tab').length > 0`, 12000, '设置页');
      const tabs = await js(wc, `return document.querySelectorAll('.set-nav .tab').length;`);
      step('设置页渲染', tabs >= 6, `${tabs} 个分组`);
      await shot(wc, '10-settings');
    } catch (e) {
      step('设置页', false, e.message);
    }
  }

  // ============ 新增：与服务端 v0.9.88 对齐的功能验收 ============

  // 画面清晰度档位：档位 → data-quality / --vh-quality-color / 灰度
  {
    try {
      const q0 = await js(
        wc,
        `return { q: document.documentElement.dataset.quality,
                  color: document.documentElement.style.getPropertyValue('--vh-quality-color'),
                  gray: document.documentElement.classList.contains('quality-gray') };`
      );
      step('画质档位已落到 <html>（data-quality）', !!q0.q, `data-quality=${q0.q} --vh-quality-color=${q0.color} gray=${q0.gray}`);

      // 点顶栏按钮循环，直到 data-quality 发生变化
      let changed = null;
      for (let i = 0; i < 6; i += 1) {
        await js(wc, `document.getElementById('btnQuality').click(); return true;`);
        await sleep(500);
        changed = await js(
          wc,
          `return { q: document.documentElement.dataset.quality,
                    color: document.documentElement.style.getPropertyValue('--vh-quality-color'),
                    gray: document.documentElement.classList.contains('quality-gray'),
                    title: document.getElementById('btnQuality')?.title || '',
                    stored: localStorage.getItem('vaulthub_quality_level_v1') };`
        );
        if (changed.q && changed.q !== q0.q) break;
      }
      step('顶栏可循环切换画质档位', !!changed?.q && changed.q !== q0.q, `data-quality=${changed?.q} 色彩=${changed?.color} 灰度=${changed?.gray} 存储=${changed?.stored}`);
      step('档位文案与色彩变量同步', !!changed?.title && changed.title.includes('画面清晰度'), changed?.title);

      // 切到「极省」应变为灰度（saturate(0)）
      await js(wc, `document.getElementById('btnQuality').click(); return true;`).catch(() => {});
      report.qualitySample = { initial: q0, after: changed };
    } catch (e) {
      step('画质档位', false, e.message);
    }
  }

  // 漫画：v0.9.88 偏好键/默认值 + 工具栏控件 + 页脚档位
  {
    const lib = libraries.find((l) => l.type === 'comic');
    if (lib) {
      try {
        await js(wc, `document.querySelector('#nav .nav-item[data-lib="${lib.id}"]').click(); return true;`);
        await waitFor(wc, `document.querySelectorAll('.grid-posters .card').length > 0`, 25000, '漫画卡片');
        await js(wc, `document.querySelector('.grid-posters .card').click(); return true;`);
        await waitFor(wc, `!document.querySelector('.reader')?.classList.contains('hidden')`, 15000, '阅读器打开');
        await waitFor(wc, `(document.querySelector('.reader-body img.comic-page')?.naturalWidth || 0) > 0`, 40000, '漫画页解码');
        const c = await js(
          wc,
          `const bar = document.querySelector('.reader-bar');
           return { titles: [...bar.querySelectorAll('.icon-btn')].map(b => b.title),
                    prefsRaw: localStorage.getItem('vaulthub_comic_prefs'),
                    pos: document.querySelector('[data-role="pos"]')?.textContent || '',
                    foot: document.querySelector('[data-role="foot-r"]')?.textContent || '' };`
        );
        // v0.9.88 的 comicPrefs() 默认 rtl:true（日式从右到左）；这里验证默认值确实生效。
        step(
          '漫画默认右到左翻页（v0.9.88 rtl:true）',
          (c.titles || []).some((t) => t.includes('右到左')),
          (c.titles || []).join(' | ').slice(0, 170)
        );
        step('漫画工具栏含模式/方向/跳转控件', (c.titles || []).length >= 6, `${(c.titles || []).length} 个控件 · 位置=${c.pos}`);
        step('漫画页脚显示取图宽度策略', /原图直出|服务端转码/.test(c.foot), c.foot.slice(0, 120));

        // 切一次阅读模式：应写回与服务端同名的偏好键
        await js(
          wc,
          `[...document.querySelectorAll('.reader-bar .icon-btn')].find(b => b.title.includes('阅读模式'))?.click(); return true;`
        );
        await sleep(700);
        const afterPrefs = await js(wc, `return localStorage.getItem('vaulthub_comic_prefs') || '';`);
        step('切换模式写回 vaulthub_comic_prefs', /"mode"/.test(afterPrefs), afterPrefs.slice(0, 150));
        report.comicSample = { titles: c.titles, pos: c.pos, foot: c.foot, prefsAfterChange: afterPrefs };
        await shot(wc, '11-comic-v0988');
        await js(wc, `document.querySelector('.reader [data-act="close"]').click(); return true;`);
        await sleep(600);
      } catch (e) {
        step('漫画 v0.9.88 规则', false, e.message);
      }
    }
  }

  // 电子书：章节切分 + 目录 + 字号范围 12–32
  {
    const lib = libraries.find((l) => l.type === 'book');
    if (lib) {
      try {
        await js(wc, `document.querySelector('#nav .nav-item[data-lib="${lib.id}"]').click(); return true;`);
        await waitFor(wc, `document.querySelectorAll('.grid-posters .card').length > 0`, 30000, '电子书卡片');
        await js(wc, `document.querySelector('.grid-posters .card').click(); return true;`);
        await waitFor(wc, `!document.querySelector('.reader')?.classList.contains('hidden')`, 20000, '电子书阅读器');
        await waitFor(wc, `(document.querySelector('.book-text, .book-chapter')?.textContent || '').length > 50`, 40000, '正文渲染');
        const b = await js(
          wc,
          `const heads = document.querySelectorAll('.ebook-chapter-title');
           const toc = document.querySelectorAll('.toc .toc-item');
           const sizes = [...document.querySelectorAll('.reader-bar select option')].map(o => o.value);
           const t = document.querySelector('.book-text, .book-chapter')?.textContent || '';
           return { heads: heads.length, toc: toc.length, sizes,
                    first: heads[0]?.textContent || '', len: t.length };`
        );
        step('TXT 按章切分并生成目录', b.heads >= 1 && b.toc >= 1, `章节=${b.heads} 目录项=${b.toc} 首章「${b.first}」`);

        // 直接用带章节标记的样本验证正则（所打开的 TXT 恰好没有章节标记，
        // 会走「全文」兜底路径，无法证明切分规则本身正确）
        const chap = await js(
          wc,
          `const m = await import('/js/util.js');
           const t = '书名\\n第一章 起\\n正文a\\nChapter 2\\n正文b\\n3. 小标题\\n正文c\\n第二卷 承\\n正文d';
           const ch = m.buildEbookChapters(t);
           return { n: ch.length, titles: ch.map(c => c.title), offsets: ch.map(c => c.offset) };`
        );
        step(
          '章节正则覆盖 第X章/Chapter N/N. 标题 三类',
          // 注意：捕获在 [章卷回节部集篇] 处结束（与 v0.9.88 同一正则），
          // 所以标题就是「第一章」「第二卷」，不含其后的正文文字。
          chap.n === 4 &&
            chap.titles.includes('第一章') &&
            chap.titles.includes('Chapter 2') &&
            chap.titles.includes('3. 小标题') &&
            chap.titles.includes('第二卷'),
          `${chap.n} 章：${chap.titles.join(' / ')}`
        );
        step('章节偏移可用于目录跳转', chap.offsets.every((o) => Number.isFinite(o) && o >= 0), `offsets=${chap.offsets.join(',')}`);
        step(
          '电子书字号范围 12–32',
          b.sizes.length >= 15 && b.sizes.includes('12') && b.sizes.includes('32'),
          `共 ${b.sizes.length} 档：${b.sizes[0]}…${b.sizes[b.sizes.length - 1]}`
        );
        await shot(wc, '12-ebook-chapters');
        await js(wc, `document.querySelector('.reader [data-act="close"]').click(); return true;`);
        await sleep(600);
      } catch (e) {
        step('电子书 v0.9.88 规则', false, e.message);
      }
    }
  }

  // 刮削设置页：字段来自服务端 /api/media/settings
  {
    try {
      await js(wc, `document.getElementById('btnSettings').click(); return true;`);
      await waitFor(wc, `document.querySelectorAll('.set-nav .tab').length > 0`, 12000, '设置页');
      await js(
        wc,
        `[...document.querySelectorAll('.set-nav .tab')].find(b => b.textContent.includes('刮削'))?.click(); return true;`
      );
      await waitFor(wc, `!!document.querySelector('[data-role="mediaScraperMode"]')`, 20000, '刮削面板');
      const s = await js(
        wc,
        `const g = r => document.querySelector('[data-role="' + r + '"]');
         return {
           mode: g('mediaScraperMode')?.value || '',
           region: g('scrapeRegion')?.value || '',
           minMatch: g('scrapeMinMatch')?.value || '',
           tmdbBase: g('tmdbApiBase')?.value || '',
           tmdbKeyPlaceholder: g('tmdbApiKey')?.placeholder || '',
           proxyPlaceholder: g('scraperProxy')?.placeholder || '',
           cacheDir: g('cache_dir')?.value || '',
           fields: document.querySelectorAll('.set-panel [data-role]').length
         };`
      );
      step('刮削面板字段来自服务端', !!s.mode && !!s.region, `scraper_mode=${s.mode} region=${s.region} 阈值=${s.minMatch}%`);
      step('刮削缓存参数已回显', !!s.cacheDir, `cache_dir=${s.cacheDir}（面板共 ${s.fields} 个字段）`);
      step('密钥只显示已设置/未设置', /已设置|未设置/.test(s.tmdbKeyPlaceholder), `TMDB=${s.tmdbKeyPlaceholder} · 代理=${s.proxyPlaceholder}`);
      report.scrapeSample = s;
      await shot(wc, '13-settings-scrape');

      await js(
        wc,
        `[...document.querySelectorAll('.set-nav .tab')].find(b => b.textContent.includes('画面清晰度'))?.click(); return true;`
      );
      await waitFor(wc, `document.querySelectorAll('[data-q]').length >= 5`, 12000, '画质设置页');
      await shot(wc, '14-settings-quality');
      step('设置页含独立「画面清晰度」页', true, '5 个档位可选');
    } catch (e) {
      step('刮削设置页', false, e.message);
    }
  }

  // 请求统计（用于证明 ETag 命中与请求规模）
  {
    const st = await js(
      wc,
      `return { requests: window.__vhStats ? window.__vhStats.requests : null };`
    ).catch(() => ({ requests: null }));
    report.rendererStats = st;
  }

  report.endedAt = new Date().toISOString();
  report.durationMs = Date.now() - t0;
  const failed = report.steps.filter((s) => !s.ok);
  report.summary = { total: report.steps.length, passed: report.steps.length - failed.length, failed: failed.length };

  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2), 'utf8');

  console.log(`\n================ 自检汇总 ================`);
  console.log(`共 ${report.summary.total} 项，通过 ${report.summary.passed}，失败 ${report.summary.failed}`);
  for (const f of failed) console.log(`  FAIL  ${f.name} — ${f.detail}`);
  console.log(`报告: ${path.join(OUT, 'report.json')}`);
  console.log(`截图: ${report.shots.length} 张 → ${OUT}`);
  console.log(`总耗时: ${(report.durationMs / 1000).toFixed(1)}s`);

  try {
    await gw.close();
  } catch {
    /* 退出路径 */
  }
  app.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error('自检异常:', e.stack || e.message);
  try {
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(
      path.join(OUT, 'report.json'),
      JSON.stringify({ ...report, fatal: String(e.stack || e.message) }, null, 2)
    );
  } catch {
    /* 忽略 */
  }
  app.exit(2);
});
