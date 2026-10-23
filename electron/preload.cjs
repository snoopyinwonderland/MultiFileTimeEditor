const { contextBridge, webUtils } = require('electron');

contextBridge.exposeInMainWorld('desktopFiles', {
  getPathForFile(file) {
    return webUtils.getPathForFile(file);
  },
});
