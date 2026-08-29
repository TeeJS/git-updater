'use strict';

// The ONLY thing the renderer can reach — a narrow, typed IPC surface. No Node,
// no ipcRenderer, no filesystem exposed to the page.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  getState: () => ipcRenderer.invoke('state:get'),
  getInstalled: () => ipcRenderer.invoke('installed:get'),
  saveConfig: (cfg) => ipcRenderer.invoke('config:save', cfg),
  openConfig: () => ipcRenderer.invoke('config:open'),
  openLog: () => ipcRenderer.invoke('log:open'),
  openFolder: (appKey) => ipcRenderer.invoke('folder:open', appKey),
  validateRepo: (owner, repo) => ipcRenderer.invoke('repo:validate', { owner, repo }),
  closeApp: (appKey, force) => ipcRenderer.invoke('app:close', { appKey, force }),
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  openRelease: (owner, repo) => ipcRenderer.invoke('release:open', { owner, repo }),
  previewAsset: (appKey) => ipcRenderer.invoke('asset:preview', appKey),
  check: (body) => ipcRenderer.invoke('check', body),
  update: (body) => ipcRenderer.invoke('update', body),
  onProgress: (cb) => ipcRenderer.on('update:progress', (_e, data) => cb(data)),
  openScan: () => ipcRenderer.invoke('scan:open'),
  scanRun: () => ipcRenderer.invoke('scan:run'),
  scanAdd: (repos) => ipcRenderer.invoke('scan:add', repos),
  onConfigChanged: (cb) => ipcRenderer.on('config-changed', () => cb()),
});
