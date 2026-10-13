import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applicationDirs, chooseEditor, editorCommand, findEntry, parseDesktopFile, parseExec, readEntries, resolveFile, terminalEditorCommand,
} from "../../src/main/desktop/apps";

test("parses the [Desktop Entry] group only, with value escapes", () => {
  const kv = parseDesktopFile(`# comment
[Desktop Entry]
Name=Text Editor
Name[de]=Texteditor
Exec=gedit %U
Comment=Edit\\stext\\nfiles
NoDisplay=false

[Desktop Action new-window]
Name=New Window
Exec=gedit --new-window
`);
  assert.equal(kv.Name, "Text Editor");
  assert.equal(kv["Name[de]"], "Texteditor");
  assert.equal(kv.Exec, "gedit %U");
  assert.equal(kv.Comment, "Edit text\nfiles");
});

test("Exec: quoting, escapes and field codes", () => {
  assert.deepEqual(parseExec("gedit %U"), ["gedit"]);
  assert.deepEqual(parseExec(`"/opt/My App/bin/app" --flag %f`), ["/opt/My App/bin/app", "--flag"]);
  assert.deepEqual(parseExec(`sh -c "echo \\"hi\\" \\$HOME"`), ["sh", "-c", `echo "hi" $HOME`]);
  assert.deepEqual(parseExec("app --pct=100%% --x=%u"), ["app", "--pct=100%", "--x="]);
  assert.deepEqual(parseExec(`/usr/bin/flatpak run --branch=stable --command=foo org.foo.Bar @@u %U @@`),
    ["/usr/bin/flatpak", "run", "--branch=stable", "--command=foo", "org.foo.Bar", "@@u", "@@"]);
  assert.deepEqual(parseExec(`app ""`), ["app", ""]);
});

test("XDG dirs, Flatpak and Snap exports, user first", () => {
  const dirs = applicationDirs({ XDG_DATA_DIRS: "/a:/b" }, "/home/u");
  assert.equal(dirs[0], "/home/u/.local/share/applications");
  assert.ok(dirs.includes("/a/applications") && dirs.includes("/b/applications"));
  assert.ok(dirs.includes("/var/lib/flatpak/exports/share/applications"));
  assert.ok(dirs.includes("/home/u/.local/share/flatpak/exports/share/applications"));
  assert.ok(dirs.includes("/var/lib/snapd/desktop/applications"));
});

test("reads entries: ids, overrides, hidden, subfolders", () => {
  const root = mkdtempSync(join(tmpdir(), "apps-"));
  const user = join(root, "user"), sys = join(root, "sys");
  mkdirSync(join(sys, "kde"), { recursive: true });
  mkdirSync(user, { recursive: true });
  const entry = (name: string, extra = "") => `[Desktop Entry]\nType=Application\nName=${name}\nExec=${name.toLowerCase()} %F\n${extra}`;
  writeFileSync(join(sys, "org.gnome.gedit.desktop"), entry("Gedit", "StartupWMClass=Gedit\n"));
  writeFileSync(join(sys, "xclock.desktop"), entry("XClock"));
  writeFileSync(join(user, "xclock.desktop"), entry("My Clock"));          // user overrides system
  writeFileSync(join(sys, "gone.desktop"), entry("Gone", "Hidden=true\n"));
  writeFileSync(join(sys, "helper.desktop"), entry("Helper", "NoDisplay=true\n"));
  writeFileSync(join(sys, "link.desktop"), "[Desktop Entry]\nType=Link\nName=L\nURL=x\n");
  writeFileSync(join(sys, "kde", "konsole.desktop"), entry("Konsole"));
  const es = readEntries([user, sys]);
  const ids = es.map((e) => e.id).sort();
  assert.deepEqual(ids, ["helper.desktop", "kde-konsole.desktop", "org.gnome.gedit.desktop", "xclock.desktop"]);
  assert.equal(es.find((e) => e.id === "xclock.desktop")!.name, "My Clock");
  assert.equal(es.find((e) => e.id === "helper.desktop")!.hidden, true);

  assert.equal(findEntry(es, "gedit")!.id, "org.gnome.gedit.desktop");
  assert.equal(findEntry(es, "Konsole")!.id, "kde-konsole.desktop");
  assert.equal(findEntry(es, "my clock")!.id, "xclock.desktop");
  assert.equal(findEntry(es, "clock")!.id, "xclock.desktop");
  assert.equal(findEntry(es, "helper")!.id, "helper.desktop");
  assert.equal(findEntry(es, "nothing-like-this"), undefined);
});

test("editor commands", () => {
  assert.deepEqual(editorCommand({ kind: "jetbrains", cmd: "/opt/idea/bin/idea" }, "/p/a.ts", 12), ["/opt/idea/bin/idea", "--line", "12", "/p/a.ts"]);
  assert.deepEqual(editorCommand({ kind: "vscode", cmd: "code" }, "/p/a.ts", 3), ["code", "--goto", "/p/a.ts:3"]);
  assert.deepEqual(editorCommand({ kind: "zed", cmd: "zed" }, "/p/a.ts", 3), ["zed", "/p/a.ts:3"]);
  assert.deepEqual(editorCommand({ kind: "sublime", cmd: "subl" }, "/p/a.ts", 3), ["subl", "/p/a.ts:3"]);
  assert.deepEqual(terminalEditorCommand("nvim", "/p/a.ts", 7), ["nvim", "+7", "/p/a.ts"]);
  assert.deepEqual(terminalEditorCommand("hx", "/p/a.ts", 7), ["hx", "/p/a.ts:7"]);
  assert.equal(terminalEditorCommand("gedit", "/p/a.ts", 7), null);
});

test("editor choice: in-project, then project markers, then running, then installed", () => {
  const code = { kind: "vscode" as const, cmd: "code", cwd: "/other" };
  const idea = { kind: "jetbrains" as const, cmd: "idea", cwd: "/home/u" };
  const none = () => null;
  assert.equal(chooseEditor([code, { ...idea, cwd: "/proj/sub" }], "/proj", [], none)!.kind, "jetbrains");
  assert.equal(chooseEditor([code, idea], "/proj", ["jetbrains"], none)!.kind, "jetbrains");
  assert.equal(chooseEditor([code, idea], "/proj", [], none)!.kind, "vscode");
  assert.equal(chooseEditor([], "/proj", ["zed"], (k) => (k === "zed" ? { kind: "zed", cmd: "zed" } : null))!.kind, "zed");
  assert.equal(chooseEditor([], "/proj", [], none), null);
});

test("resolves bare file names inside the project, skipping node_modules", async () => {
  const p = mkdtempSync(join(tmpdir(), "proj-"));
  mkdirSync(join(p, "node_modules/x"), { recursive: true });
  mkdirSync(join(p, "src/deep"), { recursive: true });
  writeFileSync(join(p, "node_modules/x/util.ts"), "");
  writeFileSync(join(p, "src/deep/util.ts"), "");
  assert.equal(await resolveFile("util.ts", p), join(p, "src/deep/util.ts"));
  assert.equal(await resolveFile("deep/util.ts", p), join(p, "src/deep/util.ts"));
  assert.equal(await resolveFile("src/deep/util.ts", p), join(p, "src/deep/util.ts"));
  assert.equal(await resolveFile("missing.ts", p), null);
});
