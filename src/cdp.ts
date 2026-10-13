import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// A minimal Chrome DevTools Protocol client for the user's own browser (no extension, no relaunch).
// Chrome 144+: tick "Allow remote debugging for this browser instance" once at chrome://inspect/#remote-debugging;
// the browser then writes DevToolsActivePort into its profile and asks "Allow remote debugging?" for each new
// connection. That's why one long-lived process (browserd) holds the socket instead of connecting per command.

// Profile folders that hold DevToolsActivePort, per browser (Linux: native, Flatpak and Snap installs; Windows: the
// "User Data" folders under %LOCALAPPDATA%). Microsoft Edge is Chromium with the same toggle at edge://inspect; it's
// offered on Windows and Linux (macOS drives browsers with AppleScript instead).
export function profileDirs(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, home = homedir()): Record<string, string[]> {
  const h = (...p: string[]) => join(home, ...p);
  if (platform === "darwin") {
    return {
      "Google Chrome": [h("Library/Application Support/Google/Chrome")],
      "Brave Browser": [h("Library/Application Support/BraveSoftware/Brave-Browser")],
      Chromium: [h("Library/Application Support/Chromium")],
    };
  }
  if (platform === "win32") {
    const local = env.LOCALAPPDATA || h("AppData", "Local");
    return {
      "Google Chrome": [join(local, "Google", "Chrome", "User Data")],
      "Brave Browser": [join(local, "BraveSoftware", "Brave-Browser", "User Data")],
      Chromium: [join(local, "Chromium", "User Data")],
      "Microsoft Edge": [join(local, "Microsoft", "Edge", "User Data")],
    };
  }
  return {
    "Google Chrome": [h(".config/google-chrome"), h(".var/app/com.google.Chrome/config/google-chrome")],
    "Brave Browser": [h(".config/BraveSoftware/Brave-Browser"), h(".var/app/com.brave.Browser/config/BraveSoftware/Brave-Browser"),
      h("snap/brave/current/.config/BraveSoftware/Brave-Browser")],
    Chromium: [h(".config/chromium"), h(".var/app/org.chromium.Chromium/config/chromium"), h("snap/chromium/common/chromium")],
    "Microsoft Edge": [h(".config/microsoft-edge"), h(".var/app/com.microsoft.Edge/config/microsoft-edge")],
  };
}

export const SETUP_HELP =
  'Open chrome://inspect/#remote-debugging in Chrome (edge://inspect/#remote-debugging in Edge), tick "Allow remote debugging for this browser instance", ' +
  'then click Allow when Chrome asks "Allow remote debugging?".';

/** The browser-level DevTools WebSocket URL a running browser advertises, if remote debugging is on. */
export function wsUrl(browser: string): string | undefined {
  for (const dir of profileDirs()[browser] ?? []) {
    try {
      const [port, path] = readFileSync(join(dir, "DevToolsActivePort"), "utf8").split("\n").map((s) => s.trim());
      if (port && path) return `ws://127.0.0.1:${port}${path}`;
    } catch {
      // not this install
    }
  }
  return undefined;
}

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };

export class CDP {
  private ws!: WebSocket;
  private next = 1;
  private pending = new Map<number, Pending>();
  private listeners = new Set<(method: string, params: any, sessionId?: string) => void>();
  closed = false;

  /** Connects; resolves once Chrome accepted (the user clicked Allow, or the browser was already trusted). */
  static async connect(url: string, timeoutMs = 60_000): Promise<CDP> {
    const c = new CDP();
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => { ws.close(); reject(new Error("Chrome didn't accept the connection (Allow remote debugging?).")); }, timeoutMs);
      ws.onopen = () => { clearTimeout(timer); resolve(); };
      ws.onerror = () => { clearTimeout(timer); reject(new Error(`Couldn't connect to the browser. ${SETUP_HELP}`)); };
      c.ws = ws;
    });
    c.ws.onmessage = (ev) => c.receive(String(ev.data));
    c.ws.onclose = () => {
      c.closed = true;
      for (const p of c.pending.values()) p.reject(new Error("Browser connection closed"));
      c.pending.clear();
    };
    // Chrome may not answer the first command until the user clicks Allow; this proves the session is usable.
    await c.send("Target.getTargets", {}, undefined, timeoutMs);
    return c;
  }

  private receive(raw: string) {
    const msg = JSON.parse(raw);
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message ?? "CDP error"));
      else p.resolve(msg.result);
    } else if (msg.method) {
      for (const l of this.listeners) l(msg.method, msg.params, msg.sessionId);
    }
  }

  send<T = any>(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = 15_000): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Browser connection closed"));
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)); }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  on(listener: (method: string, params: any, sessionId?: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close() {
    this.closed = true;
    try { this.ws.close(); } catch {}
  }
}
