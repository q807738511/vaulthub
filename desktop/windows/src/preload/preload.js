'use strict';
/**
 * 渲染层与宿主之间的唯一通道。
 * 会话 Cookie 不出宿主；渲染层只拿到配置与少量能力。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vhHost', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (patch) => ipcRenderer.invoke('config:set', patch),

  clearSession: () => ipcRenderer.invoke('session:clear'),
  sessionStatus: () => ipcRenderer.invoke('session:status'),

  testServer: (base, allowSelfSigned) => ipcRenderer.invoke('net:test', { base, allowSelfSigned }),

  appInfo: () => ipcRenderer.invoke('app:info'),
  log: (line) => ipcRenderer.invoke('log:write', line),

  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  showItem: (p) => ipcRenderer.invoke('shell:showItem', p),
  pickDirectory: () => ipcRenderer.invoke('dialog:pickDirectory'),
});
