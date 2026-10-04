// 快速诊断：只加载渲染层并把启动期的报错写进 diag.log，几秒即可返回
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const OUT = path.join(__dirname, '..');
const LOG = path.join(OUT, 'diag.log');
const w = (m) => {
  try {
    fs.appendFileSync(LOG, `[${new Date().toISOString()}] ${m}\n`);
  } catch {
    /* 忽略 */
  }
};

w(`=== diag start argv=${JSON.stringify(process.argv.slice(2))} BASE=${process.env.VH_BASE || ''} ===`);

const userData = path.join(OUT, '.diag-data');
fs.mkdirSync(userData, { recursive: true });
app.setPath('userData', userData);
for (const [k, sub] of [['cache', 'cache'], ['logs', 'logs'], ['temp', 'tmp']]) {
  const d = path.join(userData, sub);
  fs.mkdirSync(d, { recursive: true });
  app.setPath(k, d);
}

setTimeout(() => {
  w('timeout-guard 25s');
  app.exit(7);
}, 25000);

app.whenReady().then(async () => {
  const store = require('../src/main/store.js');
  const { startGateway, CookieJar } = require('../src/main/proxy.js');
  store.saveConfig({ serverBase: process.env.VH_BASE, allowSelfSigned: true });

  const jar = new CookieJar({}, (c) => store.saveSession(c));
  const gw = await startGateway({
    staticRoot: path.join(OUT, 'src', 'renderer'),
    getConfig: () => store.loadConfig(),
    jar,
  });
  w(`gateway on ${gw.port}`);

  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    show: true,
    webPreferences: {
      preload: path.join(OUT, 'src', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const wc = win.webContents;
  wc.on('console-message', (...a) => {
    if (a.length === 1 && a[0] && typeof a[0] === 'object' && 'message' in a[0]) {
      w(`[renderer:${a[0].level}] ${a[0].message} @${a[0].sourceId}:${a[0].lineNumber}`);
    } else {
      w(`[renderer:${a[1]}] ${a[2]} @${a[4]}:${a[3]}`);
    }
  });
  wc.on('preload-error', (_e, p, err) => w(`[preload-error] ${p}: ${err && err.message}`));
  wc.on('did-fail-load', (_e, c, d, u) => w(`[did-fail-load] ${c} ${d} ${u}`));
  wc.on('render-process-gone', (_e, d) => w(`[render-process-gone] ${JSON.stringify(d)}`));

  const { registerIpc } = require('../src/main/ipc.js');
  registerIpc({ getGateway: () => ({ port: gw.port, jar }), getWindow: () => win });

  await win.loadURL(`http://127.0.0.1:${gw.port}/`);
  await new Promise((r) => setTimeout(r, 3500));

  const info = await wc
    .executeJavaScript(
      `(() => ({
        hasVhHost: typeof window.vhHost,
        hasVhHostKeys: window.vhHost ? Object.keys(window.vhHost).join(',') : '(none)',
        appReady: document.getElementById('app')?.classList.contains('ready') || false,
        gateTitle: document.querySelector('.gate h1')?.textContent || '',
        gateErr: (document.querySelector('.gate pre')?.textContent || '').slice(0, 1200),
        bodyLen: document.body.innerText.length,
        bodyHead: document.body.innerText.slice(0, 400)
      }))()`,
      true
    )
    .catch((e) => ({ evalError: e.message }));

  w('PAGE_INFO ' + JSON.stringify(info, null, 2));
  try {
    const img = await wc.capturePage();
    fs.writeFileSync(path.join(OUT, 'diag.png'), img.toPNG());
    w(`screenshot ok empty=${img.isEmpty()}`);
  } catch (e) {
    w(`screenshot failed: ${e.message}`);
  }
  w('=== diag done ===');
  app.exit(0);
}).catch((e) => {
  w(`whenReady failed: ${e.stack || e.message}`);
  app.exit(6);
});
