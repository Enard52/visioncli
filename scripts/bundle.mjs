// Builds dist/ as an ESM bundle: dist/index.js (the entry the app and the Claude Code plugin run) plus lazily loaded
// chunks, so `visioncli quick …` never parses the MCP SDK/zod and the server starts without resolving node_modules.
// Database drivers stay external (optional, loaded on first db_* call). Falls back to plain tsc without esbuild.
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
rmSync(dist, { recursive: true, force: true }); // also drops stale output of deleted sources

let esbuild;
try {
  esbuild = await import("esbuild");
} catch {
  console.warn("esbuild not installed: building unbundled with tsc");
  execFileSync(join(root, "node_modules", ".bin", "tsc"), ["-p", root, "--noEmit", "false"], { stdio: "inherit" });
  process.exit(0);
}

await esbuild.build({
  absWorkingDir: root,
  entryPoints: ["src/index.ts"],
  outdir: "dist",
  bundle: true,
  splitting: true, // dynamic import() → separate chunks, loaded only when needed
  format: "esm",
  platform: "node",
  target: "node18",
  chunkNames: "[name]-[hash]", // next to index.js: voice.ts finds the repo/app root from its own location
  external: ["mysql2", "mysql2/*", "pg", "pg-native"],
  // CommonJS dependencies inside an ESM bundle still call require() for Node built-ins.
  banner: { js: 'import { createRequire as __vcliCreateRequire } from "node:module"; const require = __vcliCreateRequire(import.meta.url);' },
  legalComments: "none",
  logLevel: "warning",
});
