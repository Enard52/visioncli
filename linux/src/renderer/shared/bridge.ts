// Typed access to the preload bridge (src/preload/index.ts) and helpers every overlay page uses.

export interface VcliBridge {
  on(channel: string, cb: (data: any) => void): () => void;
  send(channel: string, data?: unknown): void;
  invoke(channel: string, data?: unknown): Promise<any>;
}

declare global {
  interface Window { vcli: VcliBridge }
}

/** Falls back to a no-op bridge so a page can be opened on its own (e.g. in a browser while styling it). */
export const vcli: VcliBridge = (globalThis as any).vcli ?? { on: () => () => {}, send: () => {}, invoke: async () => undefined };

/** Reports `el`'s size (CSS px = DIPs) on `channel` whenever it changes; main sizes the window to fit. */
export function reportSize(el: HTMLElement, channel: string): void {
  let last = "";
  const report = () => {
    const r = el.getBoundingClientRect();
    const size = { width: Math.ceil(r.width), height: Math.ceil(r.height) };
    const key = `${size.width}x${size.height}`;
    if (key === last) return;
    last = key;
    vcli.send(channel, size);
  };
  new ResizeObserver(report).observe(el);
  report();
}

/** The page's query parameters (mode=… for pages loaded in several roles). */
export const params = new URLSearchParams(location.search);
