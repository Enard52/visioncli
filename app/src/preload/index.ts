// The renderer pages' only door to the main process: `window.vcli.on(channel, cb)`, `send(channel, data)` and
// `invoke(channel, data)` (a request with a reply). Pages run sandboxed with context isolation; they never see Node.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

contextBridge.exposeInMainWorld("vcli", {
  on(channel: string, cb: (data: unknown) => void): () => void {
    const listener = (_e: IpcRendererEvent, data: unknown) => cb(data);
    ipcRenderer.on(channel, listener);
    return () => { ipcRenderer.removeListener(channel, listener); };
  },
  send(channel: string, data?: unknown): void { ipcRenderer.send(channel, data); },
  invoke(channel: string, data?: unknown): Promise<unknown> { return ipcRenderer.invoke(channel, data); },
});
