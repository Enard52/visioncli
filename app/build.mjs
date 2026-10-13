// Builds the Linux app into build/: main process, preload, one bundle per renderer page, static assets.
// `--tests` also bundles tests/**/*.test.ts into <out>/tests (run with `node --test <out>/tests/`).
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const root = dirname(fileURLToPath(import.meta.url));
// VCLI_BUILD_DIR: a separate output folder (parallel builds); `--tests=<substr>,…` bundles only matching test files.
const out = process.env.VCLI_BUILD_DIR || join(root, "build");
const testArg = process.argv.find((a) => a.startsWith("--tests"));
const tests = !!testArg;
const testFilter = testArg?.includes("=") ? testArg.split("=")[1].split(",") : [];
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const common = { bundle: true, sourcemap: "inline", logLevel: "warning", absWorkingDir: root, target: "node20" };
const external = ["electron", "dbus-next", "mysql2", "mysql2/*", "pg", "pg-native"];

await esbuild.build({ ...common, entryPoints: { main: "src/main/index.ts" }, outdir: out, platform: "node", format: "cjs", external });
await esbuild.build({ ...common, entryPoints: { preload: "src/preload/index.ts" }, outdir: out, platform: "node", format: "cjs", external });

// The MCP server (../src) is bundled too, so the app runs without the repo: build/server/index.js.
await esbuild.build({
  ...common, entryPoints: { index: "../src/index.ts" }, outdir: join(out, "server"), platform: "node", format: "esm",
  outExtension: { ".js": ".mjs" }, external: ["mysql2", "mysql2/*", "pg", "pg-native"],
  banner: { js: 'import { createRequire as __vcliCreateRequire } from "node:module"; const require = __vcliCreateRequire(import.meta.url);' },
});

// Renderer pages: src/renderer/<page>/index.ts + index.html (+ style.css) → build/renderer/<page>/
const pages = readdirSync(join(root, "src/renderer"), { withFileTypes: true }).filter((d) => d.isDirectory() && d.name !== "shared");
for (const p of pages) {
  const dir = join(root, "src/renderer", p.name);
  const dest = join(out, "renderer", p.name);
  mkdirSync(dest, { recursive: true });
  if (existsSync(join(dir, "index.ts"))) {
    await esbuild.build({ ...common, target: "chrome128", entryPoints: [join(dir, "index.ts")], outfile: join(dest, "index.js"), platform: "browser", format: "iife" });
  }
  for (const f of readdirSync(dir)) if (!f.endsWith(".ts")) cpSync(join(dir, f), join(dest, f), { recursive: true });
}
cpSync(join(root, "src/renderer/shared"), join(out, "renderer/shared"), { recursive: true, filter: (f) => !f.endsWith(".ts") });

// Assets shared with the macOS app.
const res = join(root, "../overlay/Resources");
mkdirSync(join(out, "assets"), { recursive: true });
for (const f of ["mermaid.min.js", "kokoro_server.py", "mascot"]) cpSync(join(res, f), join(out, "assets", f), { recursive: true });
cpSync(join(root, "../docs/logo.png"), join(out, "assets/logo.png"));
if (existsSync(join(root, "resources"))) cpSync(join(root, "resources"), join(out, "resources"), { recursive: true });

if (tests) {
  const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith(".test.ts") ? [join(d, e.name)] : []);
  const entries = walk(join(root, "tests")).filter((f) => !testFilter.length || testFilter.some((t) => f.includes(t)));
  if (entries.length) {
    await esbuild.build({ ...common, entryPoints: entries, outdir: join(out, "tests"), outbase: "tests", platform: "node", format: "cjs", external });
  }
}
