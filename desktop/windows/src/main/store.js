'use strict';
/**
 * 配置与会话持久化。
 * - config.json : 服务器地址、端侧偏好（明文，无凭据）
 * - session.bin : vh_session Cookie（safeStorage 加密；不可用时退化为明文并标注）
 */
const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  serverBase: '',
  allowSelfSigned: false,
  theme: 'dark',
  volume: 1,
  muted: false,
  audioBitrate: 192,
  quality: 'auto',
  hardware: 'auto',
  rememberServer: true,
  bookFontSize: 18,
  comicFit: 'width',
  comicSinglePage: true,
  videoSubtitleScale: 1,
  lastLibrary: '',
  tocCollapsed: false,
};

function userDir() {
  return app.getPath('userData');
}
function configPath() {
  return path.join(userDir(), 'config.json');
}
function sessionPath() {
  return path.join(userDir(), 'session.bin');
}

let cache = null;

function loadConfig() {
  if (cache) return cache;
  let onDisk = {};
  try {
    onDisk = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch {
    onDisk = {};
  }
  cache = { ...DEFAULTS, ...onDisk };
  return cache;
}

function saveConfig(patch) {
  const cur = loadConfig();
  const next = { ...cur, ...(patch || {}) };
  cache = next;
  try {
    fs.mkdirSync(userDir(), { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify(next, null, 2), 'utf8');
  } catch (e) {
    console.error('[store] 写入 config.json 失败:', e.message);
  }
  return next;
}

/* ---------------- 会话 Cookie ---------------- */

function saveSession(cookies) {
  try {
    fs.mkdirSync(userDir(), { recursive: true });
    const json = JSON.stringify(cookies || {});
    if (safeStorage.isEncryptionAvailable()) {
      const enc = safeStorage.encryptString(json);
      fs.writeFileSync(sessionPath(), Buffer.concat([Buffer.from('VH1:'), enc]));
    } else {
      fs.writeFileSync(sessionPath(), Buffer.from('VH0:' + json, 'utf8'));
    }
  } catch (e) {
    console.error('[store] 保存会话失败:', e.message);
  }
}

function loadSession() {
  try {
    const buf = fs.readFileSync(sessionPath());
    const tag = buf.subarray(0, 4).toString('utf8');
    if (tag === 'VH1:') {
      if (!safeStorage.isEncryptionAvailable()) return {};
      return JSON.parse(safeStorage.decryptString(buf.subarray(4)));
    }
    if (tag === 'VH0:') return JSON.parse(buf.subarray(4).toString('utf8'));
    return {};
  } catch {
    return {};
  }
}

function clearSession() {
  try {
    fs.unlinkSync(sessionPath());
  } catch {
    /* 不存在即视为已清空 */
  }
}

module.exports = {
  DEFAULTS,
  loadConfig,
  saveConfig,
  loadSession,
  saveSession,
  clearSession,
  configPath,
  sessionPath,
  userDir,
};
