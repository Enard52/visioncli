// GNOME on Wayland: Mutter doesn't let clients list windows or read the pointer, so VisionCLI ships a small GNOME
// Shell extension (resources/gnome-extension) that exports dev.visioncli.Shell on the session bus. Until it's
// enabled (a one-time install, then log out and back in), this backend works like the generic Wayland one:
// whole-screen and region capture through the Screenshot portal.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "../../log";
import type { Desktop, DesktopWindow, Jpeg, Point, Rect } from "../../contracts";
import { type Encoder, type Tools, cropFor, defaultEncoder, keepWindow, ownPids, pngSize, realTools, resourcesDir, union } from "./common";
import { busCall, nameHasOwner, portalScreenshot, sessionBus } from "./portal";
import { type DisplaySource, type PngSource, electronDisplays } from "./wayland";

export const GNOME_UUID = "visioncli@visioncli.dev";
export const GNOME_BUS = "dev.visioncli.Shell";
const PATH = "/dev/visioncli/Shell";
const VERSION = "1";

export const gnomeExtensionDir = () =>
  join(process.env.XDG_DATA_HOME || join(homedir(), ".local/share"), "gnome-shell/extensions", GNOME_UUID);

interface ShellWindow {
  id: string; wm_class: string; app_id: string; app: string; title: string; pid: number;
  x: number; y: number; width: number; height: number; focus: boolean;
}

export function parseShellWindows(json: string): (DesktopWindow & { focus: boolean })[] {
  return (JSON.parse(json) as ShellWindow[]).map((w) => ({
    id: String(w.id),
    app: w.app || w.wm_class,
    appId: w.wm_class || w.app_id.replace(/\.desktop$/, ""),
    title: w.title,
    pid: w.pid > 0 ? w.pid : undefined,
    bounds: { x: w.x, y: w.y, width: w.width, height: w.height },
    focus: !!w.focus,
  }));
}

export function parseShellDisplays(json: string): Rect[] {
  return (JSON.parse(json) as Rect[]).map(({ x, y, width, height }) => ({ x, y, width, height }));
}

/** "GNOME Shell 46.2" → 46. */
export function parseShellVersion(out: string): number | null {
  const m = /GNOME Shell\s+(\d+)/.exec(out);
  return m ? Number(m[1]) : null;
}

/** GNOME 42–44 load extensions as legacy scripts: the ESM source with its imports turned into imports.gi/imports.ui
 *  lookups, the base class dropped and an init() added. */
export function toLegacyExtension(esm: string): string {
  const name = /^export default class (\w+)/m.exec(esm)?.[1] ?? "VisionCLIExtension";
  const out = esm
    .replace(/^import (\w+) from 'gi:\/\/(\w+)';$/gm, "const $1 = imports.gi.$2;")
    .replace(/^import \* as (\w+) from 'resource:\/\/\/org\/gnome\/shell\/ui\/(\w+)\.js';$/gm, "const $1 = imports.ui.$2;")
    .replace(/^import \{Extension\} from .*$/m, "")
    .replace(/^export default class (\w+) extends Extension \{/m, "class $1 {");
  return `${out}\nfunction init() {\n    return new ${name}();\n}\n`;
}

/** Copies the extension into ~/.local/share/gnome-shell/extensions and enables it. On Wayland GNOME Shell only
 *  picks up new extensions at login, so the result says when a log out / log in is still needed. */
export async function installGnomeExtension(tools: Tools = realTools): Promise<{ ok: boolean; needsRelogin: boolean; message: string }> {
  const src = join(resourcesDir(), "gnome-extension", GNOME_UUID);
  const dest = gnomeExtensionDir();
  const version = parseShellVersion(await tools.text("gnome-shell", ["--version"]).catch(() => "")) ?? 99;
  await mkdir(dest, { recursive: true });
  // Read + write rather than copy: works from inside app.asar too.
  const esm = await readFile(join(src, "extension.js"), "utf8");
  await writeFile(join(dest, "extension.js"), version < 45 ? toLegacyExtension(esm) : esm);
  await writeFile(join(dest, "metadata.json"), await readFile(join(src, "metadata.json"), "utf8"));
  log(`desktop: installed GNOME extension for shell ${version} at ${dest}`);

  let enabled = false;
  try {
    await tools.text("gnome-extensions", ["enable", GNOME_UUID]);
    enabled = true;
  } catch {
    // The running shell hasn't seen it yet (Wayland): add it to the list it reads at login.
    try {
      const cur = await tools.text("gsettings", ["get", "org.gnome.shell", "enabled-extensions"]);
      const list = [...cur.matchAll(/'([^']+)'/g)].map((m) => m[1]);
      if (!list.includes(GNOME_UUID)) list.push(GNOME_UUID);
      await tools.text("gsettings", ["set", "org.gnome.shell", "enabled-extensions", `[${list.map((u) => `'${u}'`).join(", ")}]`]);
      enabled = true;
    } catch (e: any) {
      return { ok: false, needsRelogin: false, message: `Couldn't enable the VisionCLI GNOME extension: ${e?.message ?? e}` };
    }
  }
  const running = enabled && (await nameHasOwner(GNOME_BUS));
  return running
    ? { ok: true, needsRelogin: false, message: "The VisionCLI GNOME extension is on." }
    : { ok: true, needsRelogin: true, message: "The VisionCLI GNOME extension is installed. Log out and back in once so GNOME loads it." };
}

export class GnomeDesktop implements Desktop {
  readonly backend = "gnome" as const;
  constructor(
    private screen: DisplaySource = electronDisplays,
    private tools: Tools = realTools,
    private encode: Encoder = defaultEncoder(tools),
    private shot: PngSource = portalScreenshot,
  ) {}

  install() {
    return installGnomeExtension(this.tools);
  }

  private async call(member: string, signature = "", body: any[] = []): Promise<any[]> {
    return busCall(await sessionBus(), GNOME_BUS, PATH, GNOME_BUS, member, signature, body);
  }

  private async running(): Promise<boolean> {
    return nameHasOwner(GNOME_BUS);
  }

  async problem(): Promise<string | null> {
    if (await this.running()) {
      const v = await this.call("Version").then((b) => String(b[0]), () => "");
      return v === VERSION ? null : "VisionCLI's GNOME extension was updated. Log out and back in once to load the new version.";
    }
    const disabledAll = /true/.test(await this.tools.text("gsettings", ["get", "org.gnome.shell", "disable-user-extensions"]).catch(() => ""));
    if (disabledAll) return "GNOME extensions are turned off. Turn them on in the Extensions app so VisionCLI can see your windows and the mouse.";
    if (existsSync(join(gnomeExtensionDir(), "extension.js"))) {
      return "VisionCLI's GNOME extension is installed but not running yet. Log out and back in once (GNOME on Wayland only loads extensions at login).";
    }
    return "On GNOME (Wayland), VisionCLI needs its small GNOME Shell extension to see your windows and the mouse. Set it up from VisionCLI, then log out and back in once.";
  }

  async displays(): Promise<Rect[]> {
    try { return parseShellDisplays(String((await this.call("Displays"))[0])); } catch { return this.screen(); }
  }

  async pointer(): Promise<Point | null> {
    try {
      const [x, y] = await this.call("Pointer");
      return { x: Number(x), y: Number(y) };
    } catch {
      return null;
    }
  }

  private async all() {
    try { return parseShellWindows(String((await this.call("Windows"))[0])); } catch { return []; }
  }

  async windows(): Promise<DesktopWindow[]> {
    const own = ownPids();
    return (await this.all()).filter((w) => keepWindow(w, own)).map(({ focus: _, ...w }) => w);
  }

  async activeWindow(): Promise<DesktopWindow | null> {
    const own = ownPids();
    const all = await this.all();
    const w = all.find((w) => w.focus && !(w.pid !== undefined && own.has(w.pid))) ?? all.find((w) => keepWindow(w, own));
    if (!w) return null;
    const { focus: _, ...rest } = w;
    return rest;
  }

  captureWindow(w: DesktopWindow): Promise<Jpeg> {
    return this.captureRect(w.bounds);
  }

  async captureRect(r: Rect): Promise<Jpeg> {
    const [x, y, width, height] = [r.x, r.y, r.width, r.height].map(Math.round);
    try {
      // In-shell capture: no dialog, no file, exactly this area.
      const png = (await this.call("Screenshot", "iiii", [x, y, width, height]))[0] as Buffer;
      return await this.encode(Buffer.from(png));
    } catch (e: any) {
      if (await this.running()) log(`desktop: GNOME extension screenshot failed (${e?.message ?? e}); using the portal`);
    }
    const png = await this.shot();
    return this.encode(png, cropFor(r, union(await this.displays()), pngSize(png)));
  }

  async focus(w: DesktopWindow): Promise<void> {
    const [ok] = await this.call("Activate", "s", [w.id]);
    if (!ok) throw new Error(`Window ${w.title || w.app} is gone.`);
  }
}
