import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { describeConnection, query, schema } from "../db.js";
import { errorResult } from "./common.js";

/** Read-only database access: db_schema, db_query. */
export function register(server: McpServer) {
  server.registerTool(
    "db_schema",
    {
      title: "Database schema",
      description:
        "Tables, columns and foreign keys of the project's database (connection read from the project's .env: Laravel DB_* " +
        "or DATABASE_URL; MySQL, Postgres, SQLite). Pass a table to narrow it. Read-only.",
      inputSchema: { table: z.string().optional().describe("Only this table") },
      annotations: { readOnlyHint: true },
    },
    async ({ table }) => {
      try {
        return { content: [{ type: "text" as const, text: `${describeConnection()}\n\n${await schema(table)}` }] };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "db_query",
    {
      title: "Run a read-only SQL query",
      description:
        "Run one SELECT/SHOW/DESCRIBE/EXPLAIN/WITH query against the project's database inside a read-only transaction. " +
        "Results are capped at 50 rows; use LIMIT.",
      inputSchema: { sql: z.string().describe("A single read-only SQL statement") },
      annotations: { readOnlyHint: true },
    },
    async ({ sql }) => {
      try {
        return { content: [{ type: "text" as const, text: await query(sql) }] };
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
