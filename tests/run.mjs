// `npm test`: bundles tests/**/*.test.ts with esbuild (same settings as scripts/bundle.mjs) and runs them with Node's
// built-in runner. Tests run with HOME in a temp dir, so nothing reads or writes the real config dir.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "node_modules", ".cache", "vcli-tests");
rmSync(out, { recursive: true, force: true });

const filter = process.argv.slice(2); // optional substrings: `npm test -- route control`
const walk = (dir, suffix) => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(join(dir, e.name), suffix) : e.name.endsWith(suffix) ? [join(dir, e.name)] : []);
const entries = walk(join(root, "tests"), ".test.ts").filter((f) => !filter.length || filter.some((s) => f.includes(s)));
if (!entries.length) {
  console.error("No test files found.");
  process.exit(1);
}

await esbuild.build({
  absWorkingDir: root,
  entryPoints: entries.map((f) => relative(root, f)),
  outdir: out,
  outbase: "tests",
  outExtension: { ".js": ".mjs" }, // ESM regardless of package.json lookups under node_modules
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node18",
  external: ["mysql2", "mysql2/*", "pg", "pg-native"],
  banner: { js: 'import { createRequire as __vcliCreateRequire } from "node:module"; const require = __vcliCreateRequire(import.meta.url);' },
  sourcemap: "inline",
  logLevel: "warning",
});

const home = mkdtempSync(join(tmpdir(), "vcli-test-home-"));
mkdirSync(join(home, "Library", "Application Support", "visioncli"), { recursive: true });
mkdirSync(join(home, ".config", "visioncli"), { recursive: true }); // CONFIG_DIR on Linux
const env = { ...process.env, HOME: home, VISIONCLI_REPO: root };
for (const k of ["TYPESAFE_API_KEY", "DATABASE_URL", "VISIONCLI_DATABASE_URL", "VISIONCLI_QUICK_DRY", "VISIONCLI_FRONT_APP"]) delete env[k];

const r = spawnSync(process.execPath, ["--enable-source-maps", "--test", "--test-reporter=spec", ...walk(out, ".test.mjs")], { stdio: "inherit", env, cwd: root });
rmSync(home, { recursive: true, force: true });
process.exit(r.status ?? 1);
