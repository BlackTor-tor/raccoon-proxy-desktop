const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('raccoonProxy', {
  getStatus: () => ipcRenderer.invoke('app:status'),
  startService: () => ipcRenderer.invoke('service:start'),
  stopService: () => ipcRenderer.invoke('service:stop'),
  saveSettings: (value) => ipcRenderer.invoke('settings:save', value),
  onLog: (cb) => {
    ipcRenderer.on('proxy:log', (_e, entry) => cb({ message: entry.line, level: entry.stream === 'err' ? 'error' : 'info' }));
  },
  onState: (cb) => {
    ipcRenderer.on('proxy:state', (_e, st) => cb(st));
  },
  onHealth: (cb) => {
    ipcRenderer.on('proxy:health', (_e, h) => cb(h));
  },
});
