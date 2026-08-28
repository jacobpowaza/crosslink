import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("crosslink", {
  getState: () => ipcRenderer.invoke("crosslink:state"),
  getPairingCode: () => ipcRenderer.invoke("crosslink:pair"),
  sendMessage: (text: string) => ipcRenderer.invoke("crosslink:send", text),
  revokeDevice: (deviceId: string) => ipcRenderer.invoke("crosslink:revoke", deviceId),
  setBackgroundEnabled: (enabled: boolean) => ipcRenderer.invoke("crosslink:set-background", enabled),
  onState: (listener: (state: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: unknown) => listener(state);
    ipcRenderer.on("crosslink:state", handler);
    return () => ipcRenderer.removeListener("crosslink:state", handler);
  },
  onMessage: (listener: (message: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, message: unknown) => listener(message);
    ipcRenderer.on("crosslink:message", handler);
    return () => ipcRenderer.removeListener("crosslink:message", handler);
  },
});
