// electron-builder afterPack (Linux): the Electron binary becomes `visioncli.bin` and `visioncli` a small launcher
// (resources/bin/visioncli-launcher.sh) that keeps Chromium's sandbox on when the system allows it and adds
// --no-sandbox only when it can't work. AppRun (AppImage) and /usr/bin/visioncli (.deb) start the launcher.
const { chmodSync, copyFileSync, existsSync, renameSync } = require("node:fs");
const { join } = require("node:path");

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "linux") return;
  const exe = join(context.appOutDir, context.packager.executableName);
  const bin = `${exe}.bin`;
  if (!existsSync(bin)) renameSync(exe, bin);
  copyFileSync(join(context.packager.projectDir, "resources", "bin", "visioncli-launcher.sh"), exe);
  chmodSync(exe, 0o755);
};
