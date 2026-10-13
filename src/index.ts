#!/usr/bin/env node
import module from "node:module";

// Startup matters: the app spawns `visioncli quick …` per voice command, and the MCP server starts with every session.
// Cache compiled code between runs (Node 22+), and load the MCP SDK, zod and the tools only when serving MCP.
(module as { enableCompileCache?: () => unknown }).enableCompileCache?.();

// CLI: `visioncli voice [dir]`, `visioncli install`, `visioncli quick <command>`, `visioncli warm`, `visioncli browser <sub>`
const [cmd, ...rest] = process.argv.slice(2);
if (cmd) {
  try {
    if (cmd === "voice") console.log(await (await import("./voice.js")).startVoice(rest[0] ?? process.cwd()));
    else if (cmd === "install") console.log(await (await import("./voice.js")).install());
    else if (cmd === "quick") console.log(JSON.stringify(await (await import("./quick.js")).quick(rest.join(" "))));
    else if (cmd === "browse") {
      // visioncli browse <goal>: a multi-step task on the current tab (Jev agent via browserd); one JSON event per line
      const { browse } = await import("./agent/browserd.js");
      const last = await browse(rest.join(" "), (e) => process.stdout.write(JSON.stringify(e) + "\n"));
      process.exit(last?.type === "end" && last.status === "done" ? 0 : 1);
    }
    else if (cmd === "browserd") { await (await import("./agent/browserd.js")).serve(); process.exit(0); }
    else if (cmd === "warm")console.log(await (await import("./quick.js")).warm());
    else if (cmd === "route") {
      // visioncli route '<json RouteInput>': which model should answer, and (optionally) project or general (one Jev request)
      console.log(JSON.stringify(await (await import("./route.js")).route(JSON.parse(rest.join(" ")))));
    }
    else if (cmd === "computer") {
      const computer = await import("./control.js");
      // Debug path: raw JSON straight to the app, unchecked (the typed API is for the tools).
      const req = JSON.parse(rest.join(" ") || '{"action":"status"}') as import("./control.js").ControlRequest;
      console.log(JSON.stringify(await computer.send(req), null, 2));
    }
    else if (cmd === "browser") {
      // Debug helper: visioncli browser tabs|elements|read|click <t>|open <url>|scroll <dir>|nav <action>
      const browser = await import("./browser.js");
      const [sub, ...a] = rest;
      const out =
        sub === "tabs" ? await browser.tabs() :
        sub === "elements" ? await browser.elements() :
        sub === "read" ? await browser.read(2000) :
        sub === "click" ? await browser.click(a.join(" ")) :
        sub === "select" ? await browser.select(a[0], a.slice(1).join(" ")) :
        sub === "type" ? await browser.type(a[0], a.slice(1).join(" ")) :
        sub === "open" ? await browser.open(a[0]) :
        sub === "scroll" ? await browser.scroll(a[0] as "down") :
        sub === "nav" ? await browser.navigate(a[0] as "back") : `unknown: ${sub}`;
      console.log(typeof out === "string" ? out : JSON.stringify(out, null, 2));
    }
    else {
      console.error("Usage: visioncli [voice [dir] | install | quick <command> | browse <goal> | route <question> | warm | browser <sub>]");
      process.exit(2);
    }
    process.exit(0);
  } catch (err) {
    console.error(String((err as Error)?.message ?? err));
    process.exit(1);
  }
}

await (await import("./server.js")).start();
