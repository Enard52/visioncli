import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { Updater, installKind, isNewer, parsePublicKey, pickAsset, verifyDetached } from "../../src/main/features/updater";
import { KOKORO_FILES, ModelInstaller, WHISPER_MODEL } from "../../src/main/features/installer";
import { Autostart, desktopEntry, systemdQuote, unitFile } from "../../src/main/features/autostart";
import { AgySetup, connectTools, openIntegrations } from "../../src/main/features/integrations";
import type { RunResult } from "../../src/main/features/run";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

/** A minisign key pair built with node:crypto: the base64 public key line and a signer for files. */
function minisignKeys() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x!, "base64url");
  const keyId = randomBytes(8);
  const pub = Buffer.concat([Buffer.from("Ed"), keyId, raw]).toString("base64");
  const signFile = (data: Buffer, prehash = true, comment = "timestamp:1760000000\tfile:VisionCLI.AppImage") => {
    const msg = prehash ? createHash("blake2b512").update(data).digest() : data;
    const sig = sign(null, msg, privateKey);
    const global = sign(null, Buffer.concat([sig, Buffer.from(comment)]), privateKey);
    return `untrusted comment: signature from minisign secret key\n${Buffer.concat([Buffer.from(prehash ? "ED" : "Ed"), keyId, sig]).toString("base64")}\ntrusted comment: ${comment}\n${global.toString("base64")}\n`;
  };
  return { pub, signFile, raw: (data: Buffer) => sign(null, data, privateKey).toString("base64") };
}

const release = (v: string) => ({
  tag_name: `v${v}`, html_url: `https://github.com/thethirdsourcers/visioncli/releases/tag/v${v}`,
  assets: [
    { name: `VisionCLI-${v}-macos.zip`, browser_download_url: "https://x/mac.zip" },
    { name: `VisionCLI-${v}-linux-x86_64.AppImage`, browser_download_url: "https://x/app" },
    { name: `VisionCLI-${v}-linux-x86_64.AppImage.minisig`, browser_download_url: "https://x/app.minisig" },
    { name: `VisionCLI-${v}-linux-amd64.deb`, browser_download_url: "https://x/deb" },
    { name: `VisionCLI-${v}-linux-arm64.AppImage`, browser_download_url: "https://x/arm" },
  ],
});

describe("Updater", () => {
  test("versions, assets, install kinds", () => {
    assert.ok(isNewer("0.10.0", "0.9.9"));
    assert.ok(!isNewer("0.8.0", "0.8"));
    assert.ok(isNewer("1.0.1", "1.0"));
    const r = pickAsset(release("0.9.0"), "appimage", "x64")!;
    assert.equal(r.name, "VisionCLI-0.9.0-linux-x86_64.AppImage");
    assert.equal(r.sigUrl, "https://x/app.minisig");
    assert.equal(pickAsset(release("0.9.0"), "deb", "x64")!.url, "https://x/deb");
    assert.equal(pickAsset(release("0.9.0"), "appimage", "arm64")!.url, "https://x/arm");
    assert.equal(pickAsset({ tag_name: "v1", assets: [] }, "appimage"), null);
    assert.equal(installKind({ APPIMAGE: "/a/V.AppImage" }, "/tmp/.mount_x/visioncli"), "appimage");
    assert.equal(installKind({}, "/opt/VisionCLI/visioncli"), "deb");
    assert.equal(installKind({}, "/home/me/visioncli/linux/node_modules/electron/dist/electron"), "dev");
  });

  test("minisign (prehashed and legacy) and raw ed25519 signatures", () => {
    const k = minisignKeys();
    const data = randomBytes(5000);
    assert.equal(verifyDetached(data, k.signFile(data), k.pub), null);
    assert.equal(verifyDetached(data, k.signFile(data, false), k.pub), null);
    assert.equal(verifyDetached(data, k.raw(data), k.pub), null);
    assert.equal(verifyDetached(data, k.signFile(data), `untrusted comment: minisign public key\n${k.pub}\n`), null);
    const tampered = Buffer.from(data); tampered[10] ^= 1;
    assert.equal(verifyDetached(tampered, k.signFile(data), k.pub), "The update's signature is invalid.");
    const other = minisignKeys();
    assert.equal(verifyDetached(data, other.signFile(data), k.pub), "The update was signed with a different key.");
    const forgedComment = k.signFile(data).replace("file:VisionCLI.AppImage", "file:evil");
    assert.equal(verifyDetached(data, forgedComment, k.pub), "The signature's trusted comment was tampered with.");
    assert.equal(verifyDetached(data, k.signFile(data), ""), "No valid update signing key is configured.");
    assert.ok(parsePublicKey(k.pub));
  });

  test("check → notify once; install replaces $APPIMAGE only with a valid signature", async () => {
    const dir = tmp("vcli-upd-");
    const appImage = join(dir, "VisionCLI.AppImage");
    writeFileSync(appImage, "old");
    const k = minisignKeys();
    const payload = Buffer.from("#!/bin/sh\necho new\n");
    let sig = k.signFile(payload);
    const fakeFetch = (async (url: string) => {
      if (url.includes("releases/latest")) return new Response(JSON.stringify(release("99.0.0")));
      if (url === "https://x/app") return new Response(payload, { headers: { "content-length": String(payload.length) } });
      if (url === "https://x/app.minisig") return new Response(sig);
      return new Response("", { status: 404 });
    }) as typeof fetch;
    let quit = 0;
    const u = new Updater({ currentVersion: "0.8.0", openUrl: () => {}, quit: () => quit++, fetch: fakeFetch, publicKey: k.pub,
      env: { APPIMAGE: appImage, PATH: "/usr/bin:/bin" }, arch: "x64" });
    const seen: string[] = [];
    u.onAvailable = (r) => seen.push(r.version);
    const statuses: (string | null)[] = [];
    u.onStatus = (s) => statuses.push(s);
    await u.check(false);
    await u.check(false);
    assert.deepEqual(seen, ["99.0.0"]); // notifiedUpdate: once
    await u.check(true);
    assert.deepEqual(seen, ["99.0.0", "99.0.0"]);
    // A bad signature: refused, the old AppImage stays.
    sig = minisignKeys().signFile(payload);
    let err = "";
    u.onError = (e) => (err = e);
    await u.install();
    assert.match(err, /different key/);
    assert.equal(readFileSync(appImage, "utf8"), "old");
    // A good one: replaced atomically (executable), relaunch + quit.
    sig = k.signFile(payload);
    await u.install();
    assert.equal(readFileSync(appImage, "utf8"), payload.toString());
    assert.equal(statSync(appImage).mode & 0o111, 0o111);
    assert.ok(statuses.some((s) => s?.includes("100%")));
    await new Promise((r) => setTimeout(r, 350));
    assert.equal(quit, 1);
  });

  test("deb installs open the release page", async () => {
    let opened = "";
    const u = new Updater({ currentVersion: "0.8.0", openUrl: (x) => (opened = x), quit: () => {}, env: {}, execPath: "/opt/VisionCLI/visioncli", arch: "x64",
      fetch: (async () => new Response(JSON.stringify(release("99.1.0")))) as unknown as typeof fetch });
    const r = await u.check(true);
    assert.equal(r?.kind, "deb");
    assert.match(u.installPrompt(r!), /sudo apt install \.\/VisionCLI-99\.1\.0-linux-amd64\.deb/);
    await u.install();
    assert.equal(opened, "https://github.com/thethirdsourcers/visioncli/releases/tag/v99.1.0");
  });
});

describe("ModelInstaller", () => {
  test("same model URLs; downloads with progress; skips what's there", async () => {
    assert.equal(WHISPER_MODEL[1], "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin");
    assert.equal(KOKORO_FILES.length, 2);
    const dir = tmp("vcli-models-");
    const fetched: string[] = [];
    const fakeFetch = (async (url: string) => { fetched.push(url); return new Response(Buffer.alloc(1000, 1), { headers: { "content-length": "1000" } }); }) as typeof fetch;
    const m = new ModelInstaller({ fetch: fakeFetch, modelsDir: dir, confirm: async () => true, whisperBinary: { find: () => "/usr/bin/whisper-server", install: async () => "unused" } });
    const statuses: (string | null)[] = [];
    m.onStatus = (s) => statuses.push(s);
    const done = new Promise<[string, string | null]>((r) => (m.onFinished = (k, e) => r([k, e])));
    await m.installWhisper();
    assert.deepEqual(await done, ["Whisper", null]);
    assert.ok(m.whisperInstalled());
    assert.ok(statuses.includes("Downloading Whisper… 100% (0/0 MB)"));
    await m.installWhisper();
    assert.equal(fetched.length, 1);
  });

  test("HTTP errors and whisper binary hook", async () => {
    const dir = tmp("vcli-models-");
    let installed = false;
    const m = new ModelInstaller({ modelsDir: dir, fetch: (async () => new Response("", { status: 404 })) as unknown as typeof fetch,
      whisperBinary: { find: () => null, install: async (s) => { s("Building whisper.cpp…"); installed = true; return null; } } });
    const done = new Promise<string | null>((r) => (m.onFinished = (_k, e) => r(e)));
    await m.installWhisper();
    assert.equal(installed, true);
    assert.equal(await done, "Download failed (HTTP 404) for ggml-small.en.bin.");
    assert.equal(existsSync(join(dir, "ggml-small.en.bin")), false);
  });
});

describe("Autostart", () => {
  test("systemd unit with restart limits; XDG fallback", async () => {
    const unit = unitFile(["/home/me/Apps/Vision CLI.AppImage"], "/home/me/.local/state/visioncli");
    assert.match(unit, /^ExecStart="\/home\/me\/Apps\/Vision CLI\.AppImage"$/m);
    assert.match(unit, /^Restart=on-failure$/m);
    assert.match(unit, /^StartLimitBurst=4$/m);
    assert.match(unit, /^StartLimitIntervalSec=180$/m);
    assert.match(unit, /^WantedBy=graphical-session.target$/m);
    assert.equal(systemdQuote("/usr/bin/visioncli"), "/usr/bin/visioncli");
    assert.match(desktopEntry(["/opt/VisionCLI/visioncli"]), /^Exec=\/opt\/VisionCLI\/visioncli$/m);

    const config = tmp("vcli-auto-");
    const calls: string[] = [];
    let graphical = true;
    const runner = async (_c: string, args: string[]): Promise<RunResult> => {
      calls.push(args.join(" "));
      if (args[1] === "is-active") return { code: graphical ? 0 : 3, out: graphical ? "active\n" : "inactive\n", err: "" };
      if (args[1] === "is-enabled") return { code: 0, out: "enabled\n", err: "" };
      return { code: 0, out: "", err: "" };
    };
    const a = new Autostart({ exec: ["/x/VisionCLI.AppImage"], config, logs: config, runner });
    assert.equal(await a.set(true), "systemd");
    assert.ok(existsSync(join(config, "systemd/user/visioncli.service")));
    assert.ok(calls.includes("--user enable visioncli.service"));
    assert.equal(await a.isEnabled(), true);
    assert.equal(await a.set(false), "off");
    assert.ok(!existsSync(join(config, "systemd/user/visioncli.service")));
    graphical = false;
    assert.equal(await a.set(true), "xdg");
    assert.ok(existsSync(join(config, "autostart/visioncli.desktop")));
    assert.equal(await a.isEnabled(), true);
    await a.set(false);
    assert.equal(await a.isEnabled(), false);
  });
});

describe("Integrations", () => {
  test("agy: MCP config + allow rules (kept, deduped, sorted keys); session rules", () => {
    const home = tmp("vcli-agy-");
    AgySetup.home = home;
    AgySetup.addAllowRule("command(make test)");
    AgySetup.install("/usr/bin/node", "/opt/v/server/index.mjs");
    AgySetup.install("/usr/bin/node", "/opt/v/server/index.mjs");
    const cfg = JSON.parse(readFileSync(join(home, ".gemini/config/mcp_config.json"), "utf8"));
    assert.deepEqual(cfg.mcpServers.visioncli, { command: "/usr/bin/node", args: ["/opt/v/server/index.mjs"] });
    const allow: string[] = JSON.parse(readFileSync(join(home, ".gemini/antigravity-cli/settings.json"), "utf8")).permissions.allow;
    assert.equal(allow[0], "command(make test)");
    assert.equal(allow.filter((r) => r === "mcp(visioncli/look)").length, 1);
    assert.ok(allow.includes("command(git diff)"));
    AgySetup.sessionRules.add("command(make test)");
    AgySetup.clearSessionRules();
    assert.ok(!JSON.parse(readFileSync(join(home, ".gemini/antigravity-cli/settings.json"), "utf8")).permissions.allow.includes("command(make test)"));
    assert.equal(AgySetup.rulePrefix("git push origin main"), "git push");
    assert.equal(AgySetup.rulePrefix("ls -la"), "ls");
  });

  test("claude mcp add --scope user -- <node> <server>; gemini --trust", async () => {
    const dir = tmp("vcli-int-");
    const fake = (name: string) => {
      const p = join(dir, name);
      writeFileSync(p, `#!/bin/sh\necho "$@" >> ${dir}/${name}.log\n`, { mode: 0o755 });
      return p;
    };
    const t = { node: "/usr/bin/node", server: "/opt/v/server/index.mjs", claude: fake("claude"), gemini: fake("gemini"), agy: null, path: "/usr/bin:/bin" };
    assert.equal(await connectTools("claude", t), null);
    assert.equal(readFileSync(join(dir, "claude.log"), "utf8"), "mcp remove visioncli -s user\nmcp add visioncli --scope user -- /usr/bin/node /opt/v/server/index.mjs\n");
    assert.equal(await connectTools("gemini", t), null);
    assert.match(readFileSync(join(dir, "gemini.log"), "utf8"), /mcp add -s user --trust visioncli \/usr\/bin\/node \/opt\/v\/server\/index\.mjs/);
    assert.equal(await connectTools("antigravity", t), "Antigravity isn't installed.");
    assert.equal(await connectTools("claude", { ...t, node: null }), "Needs Node.js 18 or later (nodejs.org).");
  });

  test("integrations.json is created 0600 and opened, never read", async () => {
    const file = join(tmp("vcli-int-"), "integrations.json");
    let opened = "";
    await openIntegrations((p) => { opened = p; }, file);
    assert.equal(opened, file);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    writeFileSync(file, '{"typesafe":{"apiKey":"SECRET"}}');
    await openIntegrations(() => {}, file);
    assert.equal(readFileSync(file, "utf8"), '{"typesafe":{"apiKey":"SECRET"}}'); // left alone
  });
});
