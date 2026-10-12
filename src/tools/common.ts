import type { Capture, WindowInfo } from "../capture.js";

// Result shapes shared by the tool modules.

export function describe(w: WindowInfo) {
  return `${w.app}${w.title ? ` — "${w.title}"` : ""} (window ${w.id})`;
}

export function imageResult(img: Capture, caption: string) {
  const size = img.width ? ` [${img.width}x${img.height}]` : "";
  return {
    content: [
      { type: "text" as const, text: caption + size },
      { type: "image" as const, data: img.data, mimeType: img.mimeType },
    ],
  };
}

export function errorResult(err: unknown) {
  return { isError: true, content: [{ type: "text" as const, text: String((err as Error)?.message ?? err) }] };
}

export const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
