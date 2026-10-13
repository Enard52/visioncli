// electron-builder beforePack: gives the bundled MCP server (build/server/index.mjs, from build.mjs) its database
// drivers. esbuild leaves mysql2 and pg external, so they're installed next to it at the versions the server's own
// lockfile pins, and ship as resources/server/node_modules. Pure JS, so one install serves every arch.
const { execFileSync } = require("node:child_process");
const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const DRIVERS = ["mysql2", "pg"];

exports.default = async function beforePack(context) {
  const linux = context.packager.projectDir;
  const server = join(linux, "build", "server");
  if (!existsSync(join(server, "index.mjs"))) throw new Error("build/server/index.mjs is missing: run `node build.mjs` first");
  if (DRIVERS.every((d) => existsSync(join(server, "node_modules", d, "package.json")))) return;

  const root = join(linux, "..");
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
  const spec = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).dependencies;
  const dependencies = Object.fromEntries(DRIVERS.map((d) => [d, lock.packages?.[`node_modules/${d}`]?.version ?? spec[d]]));
  writeFileSync(join(server, "package.json"), JSON.stringify({ private: true, dependencies }, null, 2) + "\n");
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  // Node refuses to start a .cmd without a shell (CVE-2024-27980); the arguments are fixed strings, so a shell is safe.
  execFileSync(npm, ["install", "--omit=dev", "--no-audit", "--no-fund", "--no-package-lock", "--loglevel=error"],
    { cwd: server, stdio: "inherit", shell: process.platform === "win32" });
};
