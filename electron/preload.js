'use strict';

// The ONLY thing the renderer can reach — a narrow, typed IPC surface. No Node,
// no ipcRenderer, no filesystem exposed to the page.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (cfg) => ipcRenderer.invoke('config:save', cfg),
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  check: (body) => ipcRenderer.invoke('check', body),
  update: (body) => ipcRenderer.invoke('update', body),
});
