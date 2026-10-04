'use strict';
/**
 * VaultHub Desktop — Electron 主进程
 *
 * 职责：
 *  1. 起本地同源网关（见 proxy.js），渲染层永远只用相对路径 /api/...
 *  2. 持有 vh_session（Cookie 由宿主管，渲染层看不到）
 *  3. 持久化端侧偏好与会话
 *  4. 注册 IPC（实现见 ipc.js，与端到端自检共用同一套 handler）
 */
const { app, BrowserWindow, shell } = require('electron');
const path = require('path');

const store = require('./store');
const { startGateway, CookieJar } = require('./proxy');
const { registerIpc, writeLog } = require('./ipc');

const RENDERER_ROOT = path.join(__dirname, '..', 'renderer');
const IS_DEV = process.argv.includes('--dev');

let mainWindow = null;
let gateway = null;
let jar = null;

/* ---------------- 网关 ---------------- */

async function ensureGateway() {
  if (gateway) return gateway;
  jar = new CookieJar(store.loadSession(), (cookies) => store.saveSession(cookies));
  gateway = await startGateway({
    staticRoot: RENDERER_ROOT,
    getConfig: () => store.loadConfig(),
    jar,
    log: (line) => writeLog(line),
  });
  writeLog(`gateway listening on http://127.0.0.1:${gateway.port}`);
  return gateway;
}

/* ---------------- 窗口 ---------------- */

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 960,
    minHeight: 620,
    show: false,
    backgroundColor: '#0B1413',
    title: 'VaultHub Desktop',
    autoHideMenuBar: true,
    webPreferences: {
      // 打包后 preload 位于 app.asar 内，asar 用正斜杠索引条目
      preload: path.join(__dirname, '..', 'preload', 'preload.js').replace(/\\/g, '/'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());

  // 外链一律交给系统浏览器，不在应用内开新窗口
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  try {
    const gw = await ensureGateway();
    await mainWindow.loadURL(`http://127.0.0.1:${gw.port}/`);
  } catch (err) {
    writeLog(`gateway 启动失败: ${err.message}`);
    await mainWindow.loadURL(
      'data:text/html;charset=utf-8,' +
        encodeURIComponent(
          `<body style="font-family:Segoe UI,sans-serif;background:#0B1413;color:#E6F2F0;padding:40px">
             <h2>网关启动失败</h2><pre>${String(err.message)}</pre></body>`
        )
    );
  }

  if (IS_DEV) mainWindow.webContents.openDevTools({ mode: 'detach' });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  return mainWindow;
}

/* ---------------- 生命周期 ---------------- */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    registerIpc({ getGateway: () => gateway, getWindow: () => mainWindow });
    writeLog(`app start v${app.getVersion()} electron=${process.versions.electron}`);
    await createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', async () => {
    writeLog('app quit');
    if (gateway) {
      try {
        await gateway.close();
      } catch {
        /* 退出路径，忽略 */
      }
    }
  });
}

process.on('uncaughtException', (err) => {
  writeLog(`uncaughtException: ${err.stack || err.message}`);
});
process.on('unhandledRejection', (err) => {
  writeLog(`unhandledRejection: ${err && (err.stack || err.message)}`);
});
