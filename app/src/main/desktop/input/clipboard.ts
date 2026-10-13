import { log } from "../../log";
import { spawn } from "node:child_process";
import { run, sleep, which } from "./exec";

// Long text is pasted (fast), then the user's clipboard is put back, as Computer.type does on macOS.
// Only text survives the round trip: an image on the clipboard is lost, same as on macOS (string type only).

export const LONG_TEXT = 300;

const wayland = () => !!process.env.WAYLAND_DISPLAY;

export function canPaste(): boolean {
  return wayland() ? !!(which("wl-copy") && which("wl-paste")) : !!which("xclip");
}

async function read(): Promise<string | null> {
  try {
    return wayland() ? await run("wl-paste", ["--no-newline", "--type", "text"], { timeout: 1500 })
      : await run("xclip", ["-o", "-selection", "clipboard"], { timeout: 1500 });
  } catch { return null; }
}

// xclip/wl-copy fork a background owner that serves the selection and keeps stdout open, so wait for the exit of
// the process we started (not for its pipes to close) and don't capture output.
function write(text: string): Promise<void> {
  const [cmd, args] = wayland() ? ["wl-copy", ["--type", "text/plain;charset=utf-8"]] : ["xclip", ["-selection", "clipboard", "-i"]];
  return new Promise((resolve, reject) => {
    const child = spawn(cmd as string, args as string[], { stdio: ["pipe", "ignore", "ignore"] });
    const t = setTimeout(() => { child.kill(); reject(new Error(`${cmd} timed out`)); }, 3000);
    child.once("error", (e) => { clearTimeout(t); reject(e); });
    child.once("exit", (code) => { clearTimeout(t); code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`)); });
    child.stdin!.end(text);
  });
}

/** Copies `text`, runs `paste` (the backend's ctrl+v), then restores the previous text after 0.6 s. */
export async function pasteText(text: string, paste: () => Promise<void>) {
  const saved = await read();
  await write(text);
  await sleep(50);
  await paste();
  setTimeout(() => {
    (saved !== null ? write(saved) : wayland() ? run("wl-copy", ["--clear"]).then(() => {}) : write("")).catch((e) => log(`clipboard restore: ${e.message}`));
  }, 600);
}
