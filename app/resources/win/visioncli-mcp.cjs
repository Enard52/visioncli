// Started by visioncli-mcp.cmd as `VisionCLI.exe <this file> [args]` with ELECTRON_RUN_AS_NODE=1: runs the bundled
// MCP server (resources/server/index.mjs) as if Node had been given it directly.
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");

const server = join(__dirname, "..", "server", "index.mjs");
// Programs the server starts (the app for `visioncli voice`, VS Code, other Electron apps) must start as apps. The
// server re-adds it where it means to start itself in Node mode (browserd).
delete process.env.ELECTRON_RUN_AS_NODE;
process.argv.splice(1, 1, server); // the server reads its CLI from argv[2..] and its own path from argv[1]
import(pathToFileURL(server).href).catch((e) => {
  console.error(e);
  process.exit(1);
});
