'use strict';

// The ONLY thing the renderer can reach — a narrow, typed IPC surface. No Node,
// no ipcRenderer, no filesystem exposed to the page.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  getState: () => ipcRenderer.invoke('state:get'),
  saveConfig: (cfg) => ipcRenderer.invoke('config:save', cfg),
  openConfig: () => ipcRenderer.invoke('config:open'),
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  openRelease: (owner, repo) => ipcRenderer.invoke('release:open', { owner, repo }),
  previewAsset: (appKey) => ipcRenderer.invoke('asset:preview', appKey),
  check: (body) => ipcRenderer.invoke('check', body),
  update: (body) => ipcRenderer.invoke('update', body),
  onProgress: (cb) => ipcRenderer.on('update:progress', (_e, data) => cb(data)),
});
