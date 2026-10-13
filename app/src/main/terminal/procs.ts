import { readFileSync, readdirSync, readlinkSync } from "node:fs";

// Process discovery straight from /proc (the macOS app runs `ps` and `lsof`): one directory listing and a few small
// reads per process, no child processes.

export interface Proc {
  pid: number;
  ppid: number;
  pgrp: number;
  tpgid: number;        // foreground process group of its terminal (-1: none)
  tty: string | null;   // "pts/3", "tty2"; null when it has no controlling terminal
  comm: string;
  args: string[];
}

/** The controlling terminal's name from stat's tty_nr (major/minor packed like the kernel's new_encode_dev). */
export function ttyName(nr: number): string | null {
  if (!nr) return null;
  const major = (nr >> 8) & 0xfff;
  const minor = (nr & 0xff) | ((nr >> 12) & 0xfff00);
  if (major >= 136 && major <= 143) return `pts/${(major - 136) * 256 + minor}`; // Unix98 PTY slaves
  if (major === 4 && minor < 64) return `tty${minor}`;
  if (major === 4) return `ttyS${minor - 64}`;
  return null;
}

/** /proc/<pid>/stat, parsed; the command name is in parentheses and may itself contain spaces or ")". */
export function parseStat(stat: string): Omit<Proc, "args"> | null {
  const open = stat.indexOf("("), close = stat.lastIndexOf(")");
  if (open < 0 || close < open) return null;
  const rest = stat.slice(close + 2).split(" "); // state ppid pgrp session tty_nr tpgid …
  const pid = parseInt(stat.slice(0, open), 10);
  if (!Number.isFinite(pid) || rest.length < 6) return null;
  return { pid, comm: stat.slice(open + 1, close), ppid: +rest[1], pgrp: +rest[2], tty: ttyName(+rest[4]), tpgid: +rest[5] };
}

/** cmdline is NUL-separated; a process that set its title (node's process.title) may have one space-joined string. */
export function parseCmdline(raw: string): string[] {
  const parts = raw.split("\0").filter((s) => s.length > 0);
  if (parts.length === 1 && parts[0].includes(" ")) return parts[0].trim().split(/ +/);
  return parts;
}

export function readProc(pid: number): Proc | null {
  try {
    const st = parseStat(readFileSync(`/proc/${pid}/stat`, "utf8"));
    if (!st) return null;
    let args: string[] = [];
    try { args = parseCmdline(readFileSync(`/proc/${pid}/cmdline`, "utf8")); } catch {}
    return { ...st, args };
  } catch {
    return null; // gone, or not ours
  }
}

export function listProcs(): Proc[] {
  let names: string[] = [];
  try { names = readdirSync("/proc"); } catch { return []; }
  const out: Proc[] = [];
  for (const n of names) {
    if (!/^\d+$/.test(n)) continue;
    const p = readProc(+n);
    if (p) out.push(p);
  }
  return out;
}

/** The process's working directory (readlink /proc/<pid>/cwd), the `lsof -d cwd` of the macOS app. */
export function workingDirectory(pid: number): string | null {
  try { return readlinkSync(`/proc/${pid}/cwd`).replace(/ \(deleted\)$/, ""); } catch { return null; }
}

/** The process's environment: TMUX_PANE, KITTY_WINDOW_ID, WEZTERM_PANE… say which terminal pane it's in. */
export function environ(pid: number): Record<string, string> {
  const env: Record<string, string> = {};
  try {
    for (const kv of readFileSync(`/proc/${pid}/environ`, "utf8").split("\0")) {
      const i = kv.indexOf("=");
      if (i > 0) env[kv.slice(0, i)] = kv.slice(i + 1);
    }
  } catch {}
  return env;
}

/** pid, its parent, its grandparent… up to init (from a snapshot, so a parent that exited ends the chain). */
export function ancestors(pid: number, byPid: Map<number, Proc>): Proc[] {
  const out: Proc[] = [];
  let p = byPid.get(pid);
  const seen = new Set<number>();
  while (p && !seen.has(p.pid)) {
    seen.add(p.pid);
    out.push(p);
    if (p.ppid <= 1) break;
    p = byPid.get(p.ppid);
  }
  return out;
}

/** Every process below `pid` (children, their children…). */
export function descendants(pid: number, procs: Proc[]): Proc[] {
  const children = new Map<number, Proc[]>();
  for (const p of procs) children.set(p.ppid, [...(children.get(p.ppid) ?? []), p]);
  const out: Proc[] = [];
  const stack = [...(children.get(pid) ?? [])];
  while (stack.length) {
    const p = stack.pop()!;
    out.push(p);
    stack.push(...(children.get(p.pid) ?? []));
  }
  return out;
}

export const basename = (s: string) => s.slice(s.lastIndexOf("/") + 1);
