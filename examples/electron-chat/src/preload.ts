import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("crosslink", {
  getState: () => ipcRenderer.invoke("crosslink:state"),
  getPairingSession: (mode?: string) => ipcRenderer.invoke("crosslink:pair", mode),
  setNetworkMode: (mode: string) => ipcRenderer.invoke("crosslink:set-network-mode", mode),
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
  onPairingEvent: (listener: (event: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, pairingEvent: unknown) => listener(pairingEvent);
    ipcRenderer.on("crosslink:pairing-event", handler);
    return () => ipcRenderer.removeListener("crosslink:pairing-event", handler);
  },
});
