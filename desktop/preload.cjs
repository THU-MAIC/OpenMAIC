'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('openmaicDesktop', {
  isDesktop: true,
  platform: process.platform,
  version: process.env.OPENMAIC_DESKTOP_VERSION || 'dev',
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
});
