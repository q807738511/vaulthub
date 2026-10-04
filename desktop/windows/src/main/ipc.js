'use strict';
/**
 * 宿主 IPC 层。
 *
 * 单独成模块的原因：主进程入口（main.js）与端到端自检（scripts/selftest.main.cjs）
 * 都需要注册同一套 handler。之前 handler 内联在 main.js 里，导致自检进程里
 * 渲染层调用 config:get 报 "No handler registered for 'config:get'"。
 */
const { app, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');

const store = require('./store');

function logFile() {
  return path.join(store.userDir(), 'app.log');
}

/**
 * 应用版本号（对外显示用）。
 * 优先用 package.json 的 shortVersion（四段，例如 0.1.0.0），
 * 因为 electron-builder 强制 version 必须是三段 semver，而产品版本按四段发布。
 * 也不直接用 app.getVersion()：以“单个脚本文件”为入口运行时（自检/诊断场景）
 * 它找不到 package.json，会退化成 Electron 自己的版本号。
 */
function appVersion() {
  try {
    // 打包后 package.json 位于 app.asar 内，asar 用正斜杠索引条目
    const pkgPath = path.join(__dirname, '..', '..', 'package.json').replace(/\\/g, '/');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    if (pkg && pkg.shortVersion) return pkg.shortVersion;
    if (pkg && pkg.version) return pkg.version;
  } catch {
    /* 退回 Electron 的判定 */
  }
  return app.getVersion();
}

function writeLog(line) {
  try {
    fs.mkdirSync(store.userDir(), { recursive: true });
    fs.appendFileSync(logFile(), `[${new Date().toISOString()}] ${line}\n`, 'utf8');
  } catch {
    /* 日志失败不影响主流程 */
  }
}

/** 直连用户填写的地址做一次 GET /healthz（不经过网关） */
function httpGetJson(base, allowSelfSigned, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    let target;
    try {
      target = new URL(base);
    } catch {
      return finish({ ok: false, error: '地址格式无效，示例：http://192.168.1.10:8088' });
    }
    if (!/^https?:$/.test(target.protocol)) return finish({ ok: false, error: '仅支持 http:// 或 https://' });
    const isHttps = target.protocol === 'https:';
    const mod = isHttps ? https : http;
    const req = mod.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (isHttps ? 443 : 80),
        method: 'GET',
        path: target.pathname.replace(/\/$/, '') + '/healthz',
        headers: { accept: 'text/plain', 'accept-encoding': 'identity' },
        rejectUnauthorized: !allowSelfSigned,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => finish({ ok: true, status: res.statusCode, body: body.trim().slice(0, 200) }));
      }
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`连接超时（${timeoutMs / 1000}s）`)));
    req.on('error', (err) => {
      const hint =
        err.code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || /self.signed|unable to verify/i.test(err.message)
          ? '证书无法验证：若使用自签名证书，请勾选「允许自签名证书」。'
          : err.code === 'ECONNREFUSED'
            ? '目标端口拒绝连接，请确认 VaultHub 已启动且端口正确。'
            : err.code === 'ENOTFOUND' || err.code === 'EHOSTUNREACH'
              ? '主机不可达，请检查地址与服务端网络。'
              : '';
      finish({ ok: false, error: err.message, hint });
    });
    req.end();
  });
}

/** 再取 /api/auth/mode，确认对方确实是 VaultHub */
function fetchAuthMode(base, allowSelfSigned) {
  return new Promise((resolve) => {
    let target;
    try {
      target = new URL(base);
    } catch {
      return resolve({ ok: false, error: '地址无效' });
    }
    const isHttps = target.protocol === 'https:';
    const mod = isHttps ? https : http;
    const req = mod.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (isHttps ? 443 : 80),
        method: 'GET',
        path: target.pathname.replace(/\/$/, '') + '/api/auth/mode',
        headers: { accept: 'application/json', 'accept-encoding': 'identity' },
        rejectUnauthorized: !allowSelfSigned,
      },
      (res) => {
        let b = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (b += c));
        res.on('end', () => {
          try {
            resolve({ ok: true, status: res.statusCode, mode: JSON.parse(b) });
          } catch {
            resolve({ ok: false, error: '服务端返回了非 JSON 内容，可能不是 VaultHub', raw: b.slice(0, 160) });
          }
        });
      }
    );
    req.setTimeout(8000, () => req.destroy(new Error('连接超时')));
    req.on('error', (err) => resolve({ ok: false, error: err.message }));
    req.end();
  });
}

/**
 * 注册全部 IPC。
 * @param {object} ctx
 * @param {() => (null|{port:number, jar:any})} ctx.getGateway
 * @param {() => any} ctx.getWindow  返回主窗口（可为 null）
 */
function registerIpc(ctx) {
  const gw = () => (ctx.getGateway ? ctx.getGateway() : null);

  ipcMain.handle('config:get', () => store.loadConfig());
  ipcMain.handle('config:set', (_e, patch) => store.saveConfig(patch || {}));

  ipcMain.handle('session:clear', () => {
    const g = gw();
    if (g && g.jar) g.jar.clear();
    store.clearSession();
    writeLog('session cleared');
    return { ok: true };
  });

  ipcMain.handle('session:status', () => {
    const g = gw();
    return {
      hasCookie: !!(g && g.jar && g.jar.has('vh_session')),
      serverBase: store.loadConfig().serverBase,
    };
  });

  ipcMain.handle('net:test', async (_e, { base, allowSelfSigned }) => {
    const clean = String(base || '').trim().replace(/\/+$/, '');
    if (!clean) return { ok: false, error: '请填写服务器地址' };
    const health = await httpGetJson(clean, !!allowSelfSigned);
    if (!health.ok) return { ...health, base: clean };
    const mode = await fetchAuthMode(clean, !!allowSelfSigned);
    writeLog(`net:test ${clean} healthz=${health.status} mode=${mode.ok ? 'ok' : mode.error}`);
    return { ...mode, base: clean, healthz: health.body };
  });

  ipcMain.handle('app:info', () => {
    const g = gw();
    return {
      appVersion: appVersion(),
      productName: 'VaultHub Desktop',
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      v8: process.versions.v8,
      platform: `${process.platform} ${process.arch}`,
      userData: store.userDir(),
      configPath: store.configPath(),
      logPath: logFile(),
      gatewayPort: g ? g.port : null,
      dev: process.argv.includes('--dev'),
    };
  });

  ipcMain.handle('log:write', (_e, line) => {
    writeLog(String(line));
    return { ok: true };
  });

  ipcMain.handle('shell:openExternal', async (_e, url) => {
    if (/^https?:/i.test(String(url))) {
      await shell.openExternal(String(url));
      return { ok: true };
    }
    return { ok: false, error: '仅允许 http/https 外链' };
  });

  ipcMain.handle('shell:showItem', (_e, p) => {
    shell.showItemInFolder(String(p));
    return { ok: true };
  });

  ipcMain.handle('dialog:pickDirectory', async () => {
    const win = ctx.getWindow ? ctx.getWindow() : null;
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
    return { ok: !r.canceled, path: r.filePaths?.[0] || '' };
  });
}

module.exports = { registerIpc, writeLog, logFile, httpGetJson, fetchAuthMode };
