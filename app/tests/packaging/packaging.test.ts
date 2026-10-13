// Packaging: electron-builder config, the .desktop entry, the .deb scripts and the shell helpers the app ships.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { accessSync, constants, copyFileSync, existsSync, mkdtempSync, readFileSync, readlinkSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const yaml = require("js-yaml") as { load(s: string): any }; // electron-builder's own YAML parser

// The app/ folder: tests run from it (npm test), or from a separate build dir with cwd = app/.
function linuxDir() {
  for (let d = process.cwd(); d !== dirname(d); d = dirname(d)) {
    if (existsSync(join(d, "electron-builder.yml"))) return d;
    if (existsSync(join(d, "app", "electron-builder.yml"))) return join(d, "app");
  }
  throw new Error("app/electron-builder.yml not found from " + process.cwd());
}
const LINUX = linuxDir();
const RES = join(LINUX, "resources");
const cfg = yaml.load(readFileSync(join(LINUX, "electron-builder.yml"), "utf8"));
const executable = (f: string) => { try { accessSync(f, constants.X_OK); return true; } catch { return false; } };

function desktopEntry(text: string) {
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  assert.equal(lines[0], "[Desktop Entry]");
  return Object.fromEntries(lines.slice(1).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
}

function pngSize(file: string) {
  const b = readFileSync(file);
  assert.equal(b.toString("latin1", 1, 4), "PNG", file);
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

test("identity, targets and arches", () => {
  assert.equal(cfg.appId, "dev.visioncli.overlay");
  assert.equal(cfg.productName, "VisionCLI");
  assert.equal(cfg.linux.category, "Development");
  assert.equal(cfg.linux.executableName, "visioncli");
  assert.deepEqual(cfg.linux.target, ["AppImage", "deb"]);
  assert.match(cfg.linux.maintainer, /<.+@.+>/); // fpm needs an email for the .deb
  for (const t of [cfg.appImage, cfg.deb]) assert.equal(t.artifactName, "${productName}-${version}-linux-${arch}.${ext}");
  assert.notEqual(cfg.directories.buildResources, "build", "build/ is the app itself");
});

test("files: the app build, without tests; the MCP server outside the asar", () => {
  assert.ok(cfg.files.includes("build/**"));
  assert.ok(cfg.files.includes("package.json"));
  assert.ok(cfg.files.some((f: string) => f.startsWith("!build/tests")));
  assert.ok(cfg.files.some((f: string) => f.startsWith("!build/server")));
  const extra = Object.fromEntries(cfg.extraResources.map((e: { from: string; to: string }) => [e.to, e.from]));
  assert.equal(extra.server, "build/server");
  assert.equal(extra.bin, "resources/bin");
  assert.equal(extra["bin/install-deps.sh"], "scripts/install-deps.sh");
  for (const from of Object.values(extra) as string[]) if (!from.startsWith("build/")) assert.ok(existsSync(join(LINUX, from)), from);
  for (const hook of [cfg.beforePack, cfg.afterPack]) assert.ok(existsSync(join(LINUX, hook)), hook);
});

test("icons: hicolor sizes generated from docs/logo.png", () => {
  assert.equal(cfg.linux.icon, "resources/icons");
  for (const s of [16, 24, 32, 48, 64, 128, 256]) assert.deepEqual(pngSize(join(RES, "icons", `${s}x${s}.png`)), [s, s]);
});

test("window matching: WM_CLASS (productName) and Wayland app_id (desktopName) match the .desktop entries", () => {
  assert.equal(cfg.extraMetadata.productName, cfg.linux.desktop.StartupWMClass);
  assert.equal(cfg.extraMetadata.desktopName, `${cfg.linux.executableName}.desktop`);
  // The AppImage entry must not hard-code --no-sandbox: the launcher decides.
  assert.ok(!cfg.appImage.executableArgs.includes("--no-sandbox"));
  assert.ok(!(cfg.linux.executableArgs ?? []).includes("--no-sandbox"));
});

test(".deb dependencies cover the desktop tools", () => {
  const all = [...cfg.deb.depends, ...cfg.deb.recommends];
  for (const want of ["xdotool", "wmctrl", "x11-utils", "maim | imagemagick", "xclip", "grim", "slurp", "wl-clipboard",
    "tmux", "pipewire-bin | pulseaudio-utils", "at-spi2-core", "libnotify4"]) assert.ok(all.includes(want), want);
  assert.ok(cfg.deb.depends.includes("libnotify4") && cfg.deb.depends.includes("tmux"));
});

test(".deb scripts: only the macros electron-builder defines, the input-group hint, sandbox setup", () => {
  for (const f of [cfg.deb.afterInstall, cfg.deb.afterRemove]) {
    const text = readFileSync(join(LINUX, f), "utf8");
    // electron-builder expands ${name} and fails the build on unknown names.
    for (const [, name] of text.matchAll(/\$\{([a-zA-Z]+)\}/g)) assert.ok(["executable", "sanitizedProductName"].includes(name), name);
    assert.ok(executable(join(LINUX, f)), f);
  }
  const postinst = readFileSync(join(LINUX, cfg.deb.afterInstall), "utf8");
  assert.match(postinst, /usermod -aG input/);
  assert.match(postinst, /chmod 4755 "\$APP\/chrome-sandbox"/);
  assert.match(postinst, /userns,/);
});

test("the AppImage .desktop template", () => {
  const d = desktopEntry(readFileSync(join(RES, "visioncli.desktop"), "utf8"));
  assert.equal(d.Type, "Application");
  assert.equal(d.Name, "VisionCLI");
  assert.equal(d.Exec, "@EXEC@ %U");
  assert.equal(d.Icon, cfg.linux.executableName);
  assert.equal(d.StartupWMClass, cfg.linux.desktop.StartupWMClass);
  assert.ok(d.Categories.split(";").includes("Development"));
  assert.equal(d.Terminal, "false");
});

test("systemd unit: crash restart only, like the launchd agent", () => {
  const unit = readFileSync(join(RES, "systemd", "visioncli.service"), "utf8");
  assert.match(unit, /^ExecStart=@EXEC@$/m);
  assert.match(unit, /^Restart=on-failure$/m);
  assert.match(unit, /^WantedBy=graphical-session.target$/m);
});

test("shell scripts parse", () => {
  for (const f of ["resources/bin/visioncli-launcher.sh", "resources/bin/visioncli-mcp", "resources/bin/setup-user.sh",
    "scripts/install-deps.sh", "resources/deb/postinst", "resources/deb/postrm"]) {
    const r = spawnSync("sh", ["-n", join(LINUX, f)], { encoding: "utf8" });
    assert.equal(r.status, 0, `${f}: ${r.stderr}`);
    assert.ok(executable(join(LINUX, f)) || f.endsWith("install-deps.sh"), `${f} is executable`);
  }
});

// A stand-in for the Electron binary that prints how it was started.
function fakeApp(dir: string, name: string) {
  const f = join(dir, name);
  writeFileSync(f, '#!/bin/sh\necho "RUN_AS_NODE=$ELECTRON_RUN_AS_NODE"\nfor a in "$@"; do echo "ARG=$a"; done\n', { mode: 0o755 });
  return f;
}

test("launcher: keeps the sandbox when it works, --no-sandbox only when it can't, strips the desktop marker", { skip: process.platform === "win32" && "Linux packaging: a POSIX sh script" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "vcli-launcher-"));
  copyFileSync(join(RES, "bin", "visioncli-launcher.sh"), join(dir, "visioncli"));
  execFileSync("chmod", ["755", join(dir, "visioncli")]);
  fakeApp(dir, "visioncli.bin");
  const launch = (env: Record<string, string>, ...args: string[]) =>
    execFileSync(join(dir, "visioncli"), args, { env: { ...process.env, ...env }, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .split("\n").filter((l) => l.startsWith("ARG=")).map((l) => l.slice(4));
  assert.deepEqual(launch({ VISIONCLI_SANDBOX_CHECK: "yes" }, "--vcli-desktop", "a b", "c"), ["a b", "c"]);
  assert.deepEqual(launch({ VISIONCLI_SANDBOX_CHECK: "no" }, "--vcli-desktop", "x"), ["--no-sandbox", "x"]);
  assert.deepEqual(launch({ VISIONCLI_SANDBOX_CHECK: "yes", VISIONCLI_NO_SANDBOX: "1" }), ["--no-sandbox"]);
  // Node mode: arguments untouched, no Chromium switches.
  assert.deepEqual(launch({ VISIONCLI_SANDBOX_CHECK: "no", ELECTRON_RUN_AS_NODE: "1" }, "-e", "1"), ["-e", "1"]);
});

test("visioncli-mcp: runs the app as Node with a bootstrap that finds resources/server/index.mjs", () => {
  const dir = mkdtempSync(join(tmpdir(), "vcli-mcp-"));
  const app = fakeApp(dir, "VisionCLI.AppImage");
  const out = execFileSync("sh", [join(RES, "bin", "visioncli-mcp"), "install"], { env: { ...process.env, VISIONCLI_APP: app }, encoding: "utf8" });
  assert.match(out, /^RUN_AS_NODE=1$/m);
  const args = out.split("\nARG=").slice(1).map((a) => a.trim());
  assert.equal(args[0], "-e");
  assert.match(args[1], /"resources", "server", "index\.mjs"/);
  assert.match(args[1], /delete process\.env\.ELECTRON_RUN_AS_NODE/);
  assert.deepEqual(args.slice(2), ["--", "install"]);
  // No app: a clear error.
  const none = spawnSync("sh", [join(RES, "bin", "visioncli-mcp")], { env: { PATH: process.env.PATH, HOME: dir }, encoding: "utf8" });
  if (!existsSync("/opt/VisionCLI/visioncli")) assert.match(none.stderr, /isn't installed/);
});

test("setup-user.sh: stable AppImage link, menu entry, icons and the MCP wrapper (no root)", { skip: process.platform === "win32" && "Linux packaging: a POSIX sh script" }, () => {
  const home = mkdtempSync(join(tmpdir(), "vcli-home-"));
  const appimage = join(home, "Downloads", "VisionCLI-1.2.3-linux-x86_64.AppImage");
  execFileSync("mkdir", ["-p", dirname(appimage)]);
  writeFileSync(appimage, "", { mode: 0o755 });
  // A PATH without claude/systemctl: no registration, no unit.
  const out = execFileSync("sh", [join(RES, "bin", "setup-user.sh")], {
    env: { HOME: home, PATH: "/usr/bin:/bin", APPIMAGE: appimage, XDG_DATA_HOME: join(home, ".local/share"), XDG_CONFIG_HOME: join(home, ".config") },
    encoding: "utf8",
  });
  const link = join(home, ".local/bin/VisionCLI.AppImage");
  assert.equal(readlinkSync(link), appimage);
  assert.match(out, new RegExp(`^appimage=${link}$`, "m"));
  const mcp = join(home, ".local/bin/visioncli-mcp");
  assert.equal(readFileSync(mcp, "utf8"), readFileSync(join(RES, "bin", "visioncli-mcp"), "utf8"));
  assert.ok(statSync(mcp).mode & 0o100);
  const d = desktopEntry(readFileSync(join(home, ".local/share/applications/visioncli.desktop"), "utf8"));
  assert.equal(d.Exec, `${link} %U`);
  assert.deepEqual(pngSize(join(home, ".local/share/icons/hicolor/256x256/apps/visioncli.png")), [256, 256]);
  // Idempotent.
  execFileSync("sh", [join(RES, "bin", "setup-user.sh")], { env: { HOME: home, PATH: "/usr/bin:/bin", APPIMAGE: appimage } });
  assert.equal(readlinkSync(link), appimage);
});

test("install-deps.sh: picks packages for the distro and session (dry run)", { skip: process.platform !== "linux" }, () => {
  const out = execFileSync("sh", [join(LINUX, "scripts", "install-deps.sh"), "-y", "--dry-run", "--session", "wlroots"], { encoding: "utf8" });
  assert.match(out, /session:\s+wlroots/);
  assert.match(out, /grim slurp/);
  assert.match(out, /wl-clipboard/);
  assert.match(out, /tmux/);
  const x11 = execFileSync("sh", [join(LINUX, "scripts", "install-deps.sh"), "-y", "--dry-run", "--session", "x11"], { encoding: "utf8" });
  assert.doesNotMatch(x11, /grim/);
  assert.match(x11, /no input-group setup needed/);
});
