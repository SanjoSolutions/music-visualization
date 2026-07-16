const { contextBridge, ipcRenderer } = require("electron");

if (["win32", "darwin", "linux"].includes(process.platform)) {
  contextBridge.exposeInMainWorld("systemAudio", Object.freeze({
    platform: process.platform,
    start: () => ipcRenderer.invoke("system-audio:start"),
    stop: () => ipcRenderer.invoke("system-audio:stop"),
    onFrame: (listener) => {
      const handler = (_event, frame) => listener(frame);
      ipcRenderer.on("system-audio:frame", handler);
      return () => ipcRenderer.removeListener("system-audio:frame", handler);
    },
    onEnded: (listener) => {
      const handler = (_event, message) => listener(message);
      ipcRenderer.on("system-audio:ended", handler);
      return () => ipcRenderer.removeListener("system-audio:ended", handler);
    },
  }));
}
