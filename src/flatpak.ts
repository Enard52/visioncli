import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

// Inside a Flatpak the app sees its runtime's /usr, not the host's: the CLIs and desktop tools it drives (claude,
// agy, gemini, tmux, xdotool, wmctrl, maim, pactl…) live on the host, so they run there through
// `flatpak-spawn --host` (the manifest's --talk-name=org.freedesktop.Flatpak). Only the app's own files (/app, the
// Electron binary itself) run inside. The one place that decides this, for the app and the MCP server alike.

export const FLATPAK_INFO = "/.flatpak-info";

let flatpak: boolean | undefined;
/** True inside a Flatpak sandbox (Flatpak always mounts /.flatpak-info there). */
export function inFlatpak(platform: string = process.platform, exists: (p: string) => boolean = existsSync): boolean {
  if (platform !== "linux") return false;
  if (exists === existsSync) return (flatpak ??= existsSync(FLATPAK_INFO));
  return exists(FLATPAK_INFO);
}

export interface HostOptions {
  /** The child's environment. Variables that differ from `base` are passed on (flatpak-spawn starts the host
   *  command with the session's environment, not ours). */
  env?: NodeJS.ProcessEnv;
  base?: NodeJS.ProcessEnv;
  /** Stop the host command when we exit (helpers that live as long as the app; not for programs that must outlive it). */
  watch?: boolean;
  /** Override detection (tests). */
  flatpak?: boolean;
  /** This process's binary (runs inside). */
  self?: string;
}

/** Programs and scripts the sandbox ships: they only exist inside, so they never go to the host. */
export const runsInside = (file: string, args: string[], self: string = process.execPath) =>
  file === "flatpak-spawn" || file === self || [file, ...args].some((a) => a.startsWith("/app/"));

/** `file args` as it must be started here: unchanged outside Flatpak, else through `flatpak-spawn --host`. */
export function hostCommand(file: string, args: string[], opts: HostOptions = {}): { file: string; args: string[] } {
  if (!(opts.flatpak ?? inFlatpak()) || runsInside(file, args, opts.self)) return { file, args };
  const base = opts.base ?? process.env;
  const env = opts.env ? Object.entries(opts.env).filter(([k, v]) => v !== undefined && base[k] !== v).map(([k, v]) => `--env=${k}=${v}`) : [];
  return { file: "flatpak-spawn", args: ["--host", ...(opts.watch ? ["--watch-bus"] : []), ...env, file, ...args] };
}

/** `command -v name` on the host (with `path` as its PATH), for tools the sandbox can't see. Null when missing. */
export function hostWhich(name: string, path?: string): string | null {
  const r = spawnSync("flatpak-spawn", ["--host", ...(path ? [`--env=PATH=${path}`] : []), "sh", "-c", 'command -v -- "$1"', "sh", name],
    { encoding: "utf8", timeout: 5000 });
  const hit = r.status === 0 ? (r.stdout ?? "").trim().split("\n")[0] : "";
  return hit.startsWith("/") ? hit : null;
}
