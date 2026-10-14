import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { startVoice } from "../voice.js";
import { errorResult } from "./common.js";

/** start_voice. */
export function register(server: McpServer) {
  server.registerTool(
    "start_voice",
    {
      title: "Start voice mode",
      description:
        "Launch the voice overlay for this project: the user holds Option (Option+Command with a screenshot), asks a question out loud, " +
        "and the answer appears in a bubble above their mouse pointer.",
      inputSchema: {},
    },
    async () => {
      try {
        return { content: [{ type: "text" as const, text: await startVoice(process.cwd()) }] };
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
