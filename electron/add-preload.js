'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getSearch: () => ipcRenderer.invoke('results:data'),
  onSearch: (cb) => { ipcRenderer.on('results:show-search', (_event, data) => cb(data)); },
  search: (text, prerelease) => ipcRenderer.invoke('results:search', { text, prerelease }),
  inspectResult: (id, index) => ipcRenderer.invoke('results:inspect', { id, index }),
  openSourcePage: (id, index) => ipcRenderer.invoke('results:open-source', { id, index }),
  addResult: (id, index, type, automatic) => ipcRenderer.invoke('results:add', { id, index, type, automatic }),
  close: () => ipcRenderer.invoke('results:close'),
});
