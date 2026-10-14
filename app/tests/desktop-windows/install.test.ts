import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Tools } from "../../src/main/desktop/windows/common";
import { GNOME_UUID, OLD_GNOME_UUIDS, installGnomeExtension } from "../../src/main/desktop/windows/gnome";

function fakeTools(shell: string, enableWorks: boolean) {
  const calls: string[] = [];
  const tools: Tools = {
    bytes: async () => Buffer.alloc(0),
    text: async (cmd, args) => {
      calls.push([cmd, ...args].join(" "));
      if (cmd === "gnome-shell") return `GNOME Shell ${shell}\n`;
      if (cmd === "gnome-extensions") { if (enableWorks) return ""; throw new Error("Extension doesn't exist"); }
      if (cmd === "gsettings" && args[0] === "get") return "['ding@rastersoft.com']\n";
      return "";
    },
  };
  return { tools, calls };
}

test("installGnomeExtension: GNOME 46 gets the ESM extension; on Wayland it asks for one re-login", async () => {
  process.env.XDG_DATA_HOME = mkdtempSync(join(tmpdir(), "vcli-gx-"));
  process.env.DBUS_SESSION_BUS_ADDRESS = "unix:path=/nonexistent/bus";
  const { tools } = fakeTools("46.1", true);
  const r = await installGnomeExtension(tools);
  assert.equal(r.ok, true);
  assert.equal(r.needsRelogin, true); // the fake session has no dev.visioncli.Shell running
  const dir = join(process.env.XDG_DATA_HOME, "gnome-shell/extensions", GNOME_UUID);
  assert.match(readFileSync(join(dir, "extension.js"), "utf8"), /^export default class/m);
  assert.equal(JSON.parse(readFileSync(join(dir, "metadata.json"), "utf8")).uuid, GNOME_UUID);
});

test("installGnomeExtension: GNOME 43 gets the legacy form; falls back to gsettings when the shell can't see it yet", async () => {
  process.env.XDG_DATA_HOME = mkdtempSync(join(tmpdir(), "vcli-gx-"));
  const { tools, calls } = fakeTools("43.9", false);
  const r = await installGnomeExtension(tools);
  assert.equal(r.ok, true);
  const js = readFileSync(join(process.env.XDG_DATA_HOME, "gnome-shell/extensions", GNOME_UUID, "extension.js"), "utf8");
  assert.match(js, /^const Gio = imports\.gi\.Gio;$/m);
  assert.match(js, /function init\(\)/);
  assert.ok(calls.includes(`gsettings set org.gnome.shell enabled-extensions ['ding@rastersoft.com', '${GNOME_UUID}']`));
});

test("installGnomeExtension: the extension under its old id is turned off and removed", async () => {
  process.env.XDG_DATA_HOME = mkdtempSync(join(tmpdir(), "vcli-gx-"));
  const old = join(process.env.XDG_DATA_HOME, "gnome-shell/extensions", OLD_GNOME_UUIDS[0]);
  mkdirSync(old, { recursive: true });
  writeFileSync(join(old, "metadata.json"), "{}");
  const { tools, calls } = fakeTools("46.1", true);
  await installGnomeExtension(tools);
  assert.equal(existsSync(old), false);
  assert.ok(calls.some((c) => c === `gnome-extensions disable ${OLD_GNOME_UUIDS[0]}`), calls.join("\n"));
});
