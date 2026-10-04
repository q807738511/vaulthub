// 聚焦诊断：只验证「剧集视频播放」这一条链路，把 plan 请求/响应与 player 状态写进 diag-play.log
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const OUT = path.join(__dirname, '..');
const LOG = path.join(OUT, 'diag-play.log');
const w = (m) => {
  try {
    fs.appendFileSync(LOG, `[${new Date().toISOString()}] ${m}\n`);
  } catch {
    /* 忽略 */
  }
};

const BASE = process.env.VH_BASE;
const USER = process.env.VH_USER || 'admin';
const PASS = process.env.VH_PASS || '';

const userData = path.join(OUT, '.diag-data');
fs.mkdirSync(userData, { recursive: true });
app.setPath('userData', userData);
for (const [k, sub] of [['cache', 'cache'], ['logs', 'logs'], ['temp', 'tmp']]) {
  const d = path.join(userData, sub);
  fs.mkdirSync(d, { recursive: true });
  app.setPath(k, d);
}
app.commandLine.appendSwitch('mute-audio');

setTimeout(() => {
  w('timeout-guard 90s');
  app.exit(7);
}, 90000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady()
  .then(async () => {
    const store = require('../src/main/store.js');
    const { startGateway, CookieJar } = require('../src/main/proxy.js');
    const { registerIpc } = require('../src/main/ipc.js');
    store.saveConfig({ serverBase: BASE, allowSelfSigned: true });
    const jar = new CookieJar({}, (c) => store.saveSession(c));
    const gw = await startGateway({
      staticRoot: path.join(OUT, 'src', 'renderer'),
      getConfig: () => store.loadConfig(),
      jar,
    });
    w(`gateway ${gw.port}`);

    const win = new BrowserWindow({
      width: 1280, height: 820, show: true,
      webPreferences: {
        preload: path.join(OUT, 'src', 'preload', 'preload.js'),
        contextIsolation: true, nodeIntegration: false, sandbox: true,
      },
    });
    const wc = win.webContents;
    wc.on('console-message', (...a) => {
      const d = a.length === 1 && a[0] && typeof a[0] === 'object' && 'message' in a[0]
        ? a[0] : { level: a[1], message: a[2], sourceId: a[4], lineNumber: a[3] };
      w(`[renderer:${d.level}] ${d.message} @${d.sourceId}:${d.lineNumber}`);
    });
    registerIpc({ getGateway: () => ({ port: gw.port, jar }), getWindow: () => win });

    await win.loadURL(`http://127.0.0.1:${gw.port}/`);
    await sleep(1200);

    // 登录
    const lr = await wc.executeJavaScript(
      `(async () => { const r = await fetch('/api/login', {method:'POST',headers:{'Content-Type':'application/json'},
        body: JSON.stringify({username: ${JSON.stringify(USER)}, password: ${JSON.stringify(PASS)}})});
        return r.status; })()`, true);
    w(`login status=${lr}`);

    await win.loadURL(`http://127.0.0.1:${gw.port}/`);
    // 等主界面
    for (let i = 0; i < 60; i += 1) {
      const ok = await wc.executeJavaScript(`document.getElementById('app')?.classList.contains('ready') || false`, true).catch(() => false);
      if (ok) break;
      await sleep(400);
    }
    w('app ready');

    // 找可播放文件（同 selftest 逻辑，取最小的候选并确认有输出）
    const files = await wc.executeJavaScript(
      `(async () => { const r = await fetch('/api/media/files?id=series-1cux2hw&offset=0&limit=500');
        const j = await r.json(); return (j.files||[]).filter(f=>/\\.(mp4|mkv|m4v)$/i.test(f.path) && !/BDMV\\//i.test(f.path)).map(f=>({path:f.path,size:f.size})); })()`, true);
    files.sort((a, b) => (a.size || 0) - (b.size || 0));
    w(`候选 ${files.length} 个，最小 ${files[0] ? (files[0].size / 1048576).toFixed(1) + 'MiB' : 'N/A'}`);
    const target = files[0];
    w(`目标: ${target.path}`);

    // 用应用自己的 api 直接调 plan，拿到真实请求/响应
    const planProbe = await wc.executeJavaScript(
      `(async () => {
         const libs = await (await fetch('/api/media/libraries')).json();
         const lib = libs.libraries.find(l => l.type === 'series');
         const body = { library_id: lib.id, path: ${JSON.stringify(target.path)}, quality: 'auto', hardware: 'auto',
           client: { mp4:true, webm:true, mse:true, h264:true, hevc:false, vp9:true, av1:false, aac:true, mp3:true, opus:true, vorbis:true, flac:true } };
         const r = await fetch('/api/media/playback/plan', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
         const t = await r.text();
         return { status: r.status, body: t.slice(0, 400), libId: lib.id };
       })()`, true);
    w(`planProbe = ${JSON.stringify(planProbe)}`);

    // 再走真实的播放器路径
    const opened = await wc.executeJavaScript(
      `(async () => {
         const libs = await (await fetch('/api/media/libraries')).json();
         const lib = libs.libraries.find(l => l.type === 'series');
         await window.__vhOpenItem(lib, { path: ${JSON.stringify(target.path)}, title: 'probe', size: ${target.size} }, null);
         return true;
       })()`, true).catch((e) => `openItem failed: ${e.message}`);
    w(`openItem = ${opened}`);

    for (let i = 0; i < 40; i += 1) {
      const st = await wc.executeJavaScript(
        `(() => { const v = document.querySelector('.player video');
          return { readyState: v?.readyState ?? -1, duration: v?.duration ?? null, w: v?.videoWidth ?? 0, h: v?.videoHeight ?? 0,
                   src: (v?.currentSrc || v?.src || '').slice(0, 220), err: v?.error?.code ?? null,
                   mode: document.querySelector('[data-role="mode"]')?.textContent || '',
                   cap: (document.querySelector('[data-role="cap"]')?.textContent || '').slice(0,160) }; })()`, true).catch(() => ({}));
      w(`t+${i * 2}s ${JSON.stringify(st)}`);
      if (st.readyState >= 1) break;
      await sleep(2000);
    }

    try {
      const img = await wc.capturePage();
      fs.writeFileSync(path.join(OUT, 'diag-play.png'), img.toPNG());
      w('screenshot ok');
    } catch (e) {
      w(`screenshot failed ${e.message}`);
    }
    w('=== done ===');
    app.exit(0);
  })
  .catch((e) => {
    w(`fatal: ${e.stack || e.message}`);
    app.exit(6);
  });
