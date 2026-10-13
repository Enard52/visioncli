import { spawn } from "node:child_process";
import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import { chmodSync, createWriteStream, readFileSync, renameSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { log } from "../log";
import { settings } from "../settings";

// Finds newer releases on GitHub and installs them in place (port of overlay/Sources/Updater.swift).
// macOS checks the code signature; here the AppImage must carry a detached minisign (or raw ed25519) signature made
// with the release key below, so a corrupted or foreign download is refused.
//
// The release key:
//   1. Generate it once, offline:      minisign -G -p visioncli.pub -s visioncli.key
//      (or with Node: crypto.generateKeyPairSync("ed25519") and build the 42-byte "Ed"+keyid+key public key.)
//   2. Paste the second line of visioncli.pub (base64, starts with "RW") into UPDATE_PUBLIC_KEY.
//   3. For each release, sign every Linux asset:  minisign -S -s visioncli.key -m VisionCLI-0.9.0-linux-x86_64.AppImage
//      and upload the .minisig next to it (VisionCLI-0.9.0-linux-x86_64.AppImage.minisig).
// Until the key is set, updates are found and announced but never installed automatically.
//
// Windows: the release's NSIS installer (VisionCLI-<v>-windows-<arch>.exe, with its .minisig) is downloaded to %TEMP%,
// verified the same way, then run silently (/S, per-user: no admin) with --force-run so it starts the new version once
// it has replaced this one; VisionCLI quits right after starting it.

export const UPDATE_PUBLIC_KEY = ""; // TODO(release): the minisign public key, e.g. "RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3"

export const REPO = "thethirdsourcers/visioncli";

export interface Release {
  version: string;
  name: string;          // asset file name
  url: string;
  sigUrl: string | null;
  page: string;          // release page
  kind: AssetKind;
}

export type AssetKind = "appimage" | "deb" | "nsis";

/** How this copy was installed: an AppImage (replaceable), a .deb (apt/dpkg owns it), the Windows installer, or a dev
 *  checkout. */
export type InstallKind = "appimage" | "deb" | "nsis" | "dev";

export function installKind(env = process.env, execPath = process.execPath, platform: string = process.platform): InstallKind {
  if (platform === "win32") {
    // A dev run is electron.exe; the portable .exe unpacks to a temp folder and can't be replaced in place.
    if (/^electron\.exe$/i.test(basename(execPath.replace(/\\/g, "/"))) || env.PORTABLE_EXECUTABLE_FILE) return "dev";
    return "nsis";
  }
  if (env.APPIMAGE) return "appimage";
  if (/^\/(opt|usr)\//.test(execPath)) return "deb";
  return "dev";
}

export function isNewer(a: string, b: string): boolean {
  const pa = a.split(".").map((x) => parseInt(x, 10) || 0), pb = b.split(".").map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0, y = pb[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

const ARCHES: Record<string, string[]> = { x64: ["x86_64", "x64", "amd64"], arm64: ["arm64", "aarch64"], arm: ["armv7l", "armhf"] };

/** The asset for this machine in a GitHub release JSON: VisionCLI-<v>-linux-<arch>.AppImage (or .deb), or
 *  VisionCLI-<v>-windows-<arch>.exe. */
export function pickAsset(json: any, kind: AssetKind, arch: string = process.arch): Release | null {
  const tag = typeof json?.tag_name === "string" ? json.tag_name : null;
  const assets: { name: string; browser_download_url: string }[] = Array.isArray(json?.assets) ? json.assets : [];
  if (!tag) return null;
  const version = tag.startsWith("v") ? tag.slice(1) : tag;
  const ext = kind === "appimage" ? ".AppImage" : kind === "nsis" ? ".exe" : ".deb";
  const os = kind === "nsis" ? "windows" : "linux";
  const names = (ARCHES[arch] ?? [arch]).map((a) => `VisionCLI-${version}-${os}-${a}${ext}`.toLowerCase());
  const asset = assets.find((a) => names.includes(String(a.name).toLowerCase()));
  if (!asset) return null;
  const sig = assets.find((a) => a.name === asset.name + ".minisig") ?? assets.find((a) => a.name === asset.name + ".sig");
  return {
    version, name: asset.name, url: asset.browser_download_url, sigUrl: sig?.browser_download_url ?? null,
    page: typeof json.html_url === "string" ? json.html_url : `https://github.com/${REPO}/releases`, kind,
  };
}

// ── Signatures ──────────────────────────────────────────────────────────────────────────────────────────────────

function ed25519Key(raw: Buffer) {
  return createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: raw.toString("base64url") }, format: "jwk" });
}

/** A minisign public key (the base64 line, or the whole .pub file) → key id and raw key. */
export function parsePublicKey(text: string): { keyId: Buffer; key: Buffer } | null {
  const line = text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("untrusted comment:")).pop() ?? "";
  const b = Buffer.from(line, "base64");
  if (b.length === 42 && b.subarray(0, 2).toString() === "Ed") return { keyId: b.subarray(2, 10), key: b.subarray(10) };
  if (b.length === 32) return { keyId: Buffer.alloc(0), key: b }; // a bare ed25519 key
  return null;
}

/**
 * Verifies `data` against a detached signature: minisign format (legacy "Ed" or prehashed "ED", with its trusted
 * comment's global signature), or a raw base64 ed25519 signature. Returns null when valid, else the reason.
 */
export function verifyDetached(data: Buffer, sigText: string, publicKey: string): string | null {
  const pk = parsePublicKey(publicKey);
  if (!pk) return "No valid update signing key is configured.";
  const key = ed25519Key(pk.key);
  const lines = sigText.split("\n").map((l) => l.replace(/\r$/, ""));
  if (lines[0]?.startsWith("untrusted comment:")) {
    const sig = Buffer.from(lines[1] ?? "", "base64");
    if (sig.length !== 74) return "The signature file is malformed.";
    const alg = sig.subarray(0, 2).toString(), keyId = sig.subarray(2, 10), s = sig.subarray(10);
    if (pk.keyId.length && !keyId.equals(pk.keyId)) return "The update was signed with a different key.";
    let message: Buffer;
    if (alg === "Ed") message = data;
    else if (alg === "ED") message = createHash("blake2b512").update(data).digest();
    else return "Unknown signature algorithm.";
    if (!verifySignature(null, message, key, s)) return "The update's signature is invalid.";
    const trusted = lines[2] ?? "";
    if (trusted.startsWith("trusted comment: ")) {
      const global = Buffer.from(lines[3] ?? "", "base64");
      const ok = global.length === 64 && verifySignature(null, Buffer.concat([s, Buffer.from(trusted.slice("trusted comment: ".length))]), key, global);
      if (!ok) return "The signature's trusted comment was tampered with.";
    }
    return null;
  }
  const raw = Buffer.from(sigText.trim(), "base64");
  if (raw.length !== 64) return "The signature file is malformed.";
  return verifySignature(null, data, key, raw) ? null : "The update's signature is invalid.";
}

// ── Updater ─────────────────────────────────────────────────────────────────────────────────────────────────────

export interface UpdaterOptions {
  currentVersion: string;
  /** Opens the release page (deb installs, or when the update can't be installed in place). */
  openUrl(url: string): void;
  /** Quit the app for the relaunch (after CrashReporter.markCleanExit). */
  quit(): void;
  fetch?: typeof fetch;
  publicKey?: string;
  env?: NodeJS.ProcessEnv;
  execPath?: string;
  arch?: string;
  platform?: string;
  /** Starts the downloaded Windows installer (tests); default: a detached process. */
  launch?(file: string, args: string[]): void;
  tmpDir?: string;
}

export class Updater {
  available: Release | null = null;
  status: string | null = null;  // "Downloading update… 40%" while installing
  onAvailable: (r: Release) => void = () => {};
  onError: (message: string) => void = () => {};
  onStatus: (status: string | null) => void = () => {};
  private timer: NodeJS.Timeout | null = null;

  constructor(private opts: UpdaterOptions) {}

  get kind(): InstallKind { return installKind(this.opts.env, this.opts.execPath, this.opts.platform); }
  private get fetch() { return this.opts.fetch ?? fetch; }

  /** Checks at launch (after a short delay) and every 6 hours. */
  startAutomaticChecks() {
    setTimeout(() => void this.check(false), 20_000).unref?.();
    this.timer = setInterval(() => void this.check(false), 6 * 3600_000);
    this.timer.unref?.();
  }

  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  async check(manual: boolean): Promise<Release | null> {
    if (!manual && !settings.get("autoUpdate")) return null;
    let found: Release | null = null;
    try {
      const res = await this.fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
        headers: { Accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(15_000),
      });
      const json = await res.json();
      const k = this.kind;
      const r = pickAsset(json, k === "deb" ? "deb" : k === "nsis" || (k === "dev" && (this.opts.platform ?? process.platform) === "win32") ? "nsis" : "appimage", this.opts.arch);
      if (r && isNewer(r.version, this.opts.currentVersion)) found = r;
    } catch (e) {
      log(`update check failed: ${(e as Error)?.message ?? e}`);
    }
    this.available = found;
    if (found) {
      log(`update available: ${found.version} (running ${this.opts.currentVersion})`);
      if (manual || settings.get("notifiedUpdate") !== found.version) {
        settings.set("notifiedUpdate", found.version);
        this.onAvailable(found);
      }
    }
    return found;
  }

  /** What the "Install update?" dialog says for this kind of install. */
  installPrompt(r: Release): string {
    if (this.kind === "appimage") return "VisionCLI will download the update, check its signature, replace itself and restart. Your settings are kept.";
    if (this.kind === "nsis") return "VisionCLI will download the installer, check its signature, install it and restart. Your settings are kept.";
    if (this.kind === "deb") return `VisionCLI ${r.version} is available as a .deb package. Its release page will open: download the .deb and install it (e.g. \`sudo apt install ./${r.name}\`), then restart VisionCLI.`;
    return `This copy of VisionCLI runs from a checkout, so it can't update itself. The release page for ${r.version} will open.`;
  }

  /** Downloads, verifies, replaces $APPIMAGE atomically and relaunches. deb and dev installs open the release page. */
  async install(): Promise<void> {
    const release = this.available;
    if (!release || this.status != null) return;
    if (this.kind === "nsis") return this.installWindows(release);
    if (this.kind !== "appimage") { this.opts.openUrl(release.page); return; }
    const target = (this.opts.env ?? process.env).APPIMAGE!;
    const tmp = join(dirname(target), `.VisionCLI-update-${randomBytes(6).toString("hex")}.AppImage`);
    const failure = await this.download(release, tmp).catch((e) => `Download failed: ${(e as Error)?.message ?? e}`);
    if (failure) {
      this.setStatus(null);
      log(`update: ${failure}`);
      rmSync(tmp, { force: true });
      this.onError(failure);
      return;
    }
    log(`update: installed ${release.version}; relaunching`);
    this.relaunch(target);
  }

  /** Windows: download and verify the installer, run it silently, quit (it closes any copy still running). */
  private async installWindows(release: Release) {
    const file = join(this.opts.tmpDir ?? tmpdir(), `VisionCLI-update-${randomBytes(6).toString("hex")}.exe`);
    const failure = await this.fetchVerified(release, file).catch((e) => `Download failed: ${(e as Error)?.message ?? e}`);
    if (failure) {
      this.setStatus(null);
      log(`update: ${failure}`);
      rmSync(file, { force: true });
      this.onError(failure);
      return;
    }
    log(`update: running the ${release.version} installer`);
    this.setStatus(`Installing ${release.version}…`);
    const args = ["--updated", "/S", "--force-run"];
    try {
      if (this.opts.launch) this.opts.launch(file, args);
      else spawn(file, args, { detached: true, stdio: "ignore", windowsHide: true }).unref();
    } catch (e) {
      this.setStatus(null);
      this.onError(`Couldn't start the installer: ${(e as Error).message}`);
      return;
    }
    setTimeout(() => this.opts.quit(), 300);
  }

  /** Returns an error message, or null once the verified AppImage replaced the running one. */
  private async download(release: Release, tmp: string): Promise<string | null> {
    const bad = await this.fetchVerified(release, tmp);
    if (bad) return bad;
    try {
      chmodSync(tmp, 0o755);
      renameSync(tmp, (this.opts.env ?? process.env).APPIMAGE!); // same folder: atomic, the running copy keeps its inode
    } catch (e) {
      return `Couldn't replace ${(this.opts.env ?? process.env).APPIMAGE}: ${(e as Error).message}`;
    }
    return null;
  }

  /** Downloads the asset to `tmp` and checks its signature: an error message, or null when it's genuine. */
  private async fetchVerified(release: Release, tmp: string): Promise<string | null> {
    const key = this.opts.publicKey ?? UPDATE_PUBLIC_KEY;
    if (!key) return "This build has no update signing key, so updates can't be verified. Download the new version from the release page.";
    if (!release.sigUrl) return "The update has no signature; not installing it.";
    this.setStatus(`Downloading update ${release.version}…`);
    log(`update: downloading ${release.url}`);
    const res = await this.fetch(release.url);
    if (res.status !== 200 || !res.body) return `Download failed (HTTP ${res.status}).`;
    const total = Number(res.headers.get("content-length")) || 0;
    const out = createWriteStream(tmp, { mode: 0o755 });
    let got = 0, lastPct = -1;
    try {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        got += value.length;
        if (!out.write(value)) await new Promise<void>((r) => out.once("drain", () => r()));
        const pct = total ? Math.floor((got / total) * 100) : -1;
        if (pct !== lastPct && pct >= 0) { lastPct = pct; this.setStatus(`Downloading update ${release.version}… ${pct}%`); }
      }
    } finally {
      await new Promise<void>((r) => out.end(r));
    }
    const sigRes = await this.fetch(release.sigUrl);
    if (sigRes.status !== 200) return `Couldn't download the update's signature (HTTP ${sigRes.status}).`;
    this.setStatus("Checking the update's signature…");
    return verifyDetached(readFileSync(tmp), await sigRes.text(), key);
  }

  private setStatus(s: string | null) { this.status = s; this.onStatus(s); }

  /** Starts the new copy: through systemd if VisionCLI runs as the user service, otherwise directly. */
  private relaunch(appImage: string) {
    const q = appImage.replace(/'/g, "'\\''");
    const script = (this.opts.env ?? process.env).INVOCATION_ID
      // No sleep first: the service's leftover processes are killed when it exits, a queued restart job is not.
      ? `systemctl --user --no-block restart visioncli.service 2>/dev/null || (sleep 1; setsid '${q}' >/dev/null 2>&1 &)`
      : `sleep 1; setsid '${q}' >/dev/null 2>&1 &`;
    try { spawn("/bin/sh", ["-c", script], { detached: true, stdio: "ignore" }).unref(); } catch {}
    setTimeout(() => this.opts.quit(), 300);
  }
}
