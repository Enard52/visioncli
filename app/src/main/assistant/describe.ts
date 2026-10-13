import { existsSync } from "node:fs";
import { basename } from "node:path";

// Status lines and approval cards for tool calls (ClaudeSession.describe, PermissionRequest.title/detail).

type Input = Record<string, unknown>;
const str = (input: Input, k: string) => (typeof input[k] === "string" ? (input[k] as string) : "");
const base = (input: Input, k: string) => str(input, k).split("/").filter(Boolean).pop() ?? "";

/** The thinking-pill text while a tool runs. Covers Claude Code, Gemini CLI and agy tool names. */
export function describe(tool: string, input: Input = {}): string {
  switch (tool) {
    case "mcp__visioncli__look": return "Taking another look…";
    case "mcp__visioncli__list_windows": return "Checking open windows…";
    case "mcp__visioncli__device_screenshot": return "Looking at the simulator…";
    case "mcp__visioncli__db_schema": return "Reading the database schema…";
    case "mcp__visioncli__db_query": return "Querying the database…";
    case "mcp__visioncli__ui_elements": return "Reading the app's controls…";
    case "mcp__visioncli__click": case "mcp__visioncli__type_text": case "mcp__visioncli__press_keys": case "mcp__visioncli__scroll":
    case "mcp__visioncli__drag": case "mcp__visioncli__open_app": case "mcp__visioncli__open_url": return "Using your computer…";
    case "Read": return `Reading ${base(input, "file_path")}…`;
    case "Grep": return `Searching for “${[...str(input, "pattern")].slice(0, 40).join("")}”…`;
    case "Glob": return "Finding files…";
    case "Edit": case "MultiEdit": case "Write": return `Editing ${base(input, "file_path")}…`;
    case "Bash": return "Running a command…";
    case "ToolSearch": return "Getting ready…";
    // Gemini CLI tools (and visioncli MCP tools as Gemini names them)
    case "read_file": case "read_many_files": return `Reading ${base(input, "absolute_path") || base(input, "file_path")}…`;
    case "grep_search": case "search_file_content": return `Searching for “${[...str(input, "pattern")].slice(0, 40).join("")}”…`;
    case "glob": case "list_directory": return "Finding files…";
    case "replace": case "write_file": return `Editing ${base(input, "file_path")}…`;
    case "run_shell_command": return "Running a command…";
    case "google_web_search": case "web_fetch": return "Searching the web…";
    // agy
    case "view_file": return `Looking at ${str(input, "AbsolutePath") ? base(input, "AbsolutePath") : "a file"}…`;
    case "list_dir": case "find_by_name": return "Finding files…";
    case "run_command": return "Running a command…";
    case "write_to_file": case "replace_file_content": case "multi_replace_file_content":
      return `Editing ${str(input, "TargetFile") ? base(input, "TargetFile") : "a file"}…`;
    case "search_web": case "read_url_content": return "Searching the web…";
    case "look": return "Taking another look…";
    case "db_schema": return "Reading the database schema…";
    case "db_query": return "Querying the database…";
    default: return "Working…";
  }
}

/** A tool call waiting for the user's approval. */
export interface PermissionInfo { id: string; tool: string; input: Input }

/** "Claude wants to edit main.ts" */
export function permissionTitle(req: PermissionInfo, assistantName: string): string {
  const file = str(req.input, "file_path") || str(req.input, "notebook_path");
  const name = file ? basename(file) : "";
  switch (req.tool) {
    case "Edit": case "MultiEdit": return `${assistantName} wants to edit ${name}`;
    case "Write": return existsSync(file) ? `${assistantName} wants to overwrite ${name}` : `${assistantName} wants to create ${name}`;
    case "Bash": return `${assistantName} wants to run a command`;
    default: return `${assistantName} wants to use ${req.tool.split("mcp__visioncli__").join("")}`;
  }
}

/** A short preview, one line per entry: a diff for edits ("- " removed, "+ " added, "  " context), the command for
 *  Bash, the input as JSON otherwise. (macOS keeps the kinds as a tuple; the contract carries one string.) */
export function permissionPreview(req: PermissionInfo): string {
  type Kind = "-" | "+" | " ";
  const lines = (s: unknown, kind: Kind, max: number): string[] => {
    const all = (typeof s === "string" ? s : "").split("\n");
    const out = all.slice(0, max).map((l) => `${kind} ${[...l].length > 110 ? [...l].slice(0, 110).join("") + "…" : l}`);
    if (all.length > max) out.push(`  … ${all.length - max} more lines`);
    return out;
  };
  const i = req.input;
  switch (req.tool) {
    case "Edit": return [...lines(i.old_string, "-", 6), ...lines(i.new_string, "+", 8)].join("\n");
    case "MultiEdit": {
      const edits = Array.isArray(i.edits) ? (i.edits as Input[]) : [];
      return edits.slice(0, 3).flatMap((e) => [...lines(e.old_string, "-", 3), ...lines(e.new_string, "+", 4)]).join("\n");
    }
    case "Write": return lines(i.content, "+", 10).join("\n");
    case "Bash": return "  $ " + str(i, "command");
    default: return lines(JSON.stringify(i, null, 2), " ", 8).join("\n");
  }
}
