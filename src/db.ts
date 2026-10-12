import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

// Read-only database access for the project in the current directory. Connection details come from
// the project's own .env (Laravel DB_* vars or DATABASE_URL) and are never returned to the model.

type Conn =
  | { kind: "mysql"; host: string; port: number; user: string; password: string; database: string }
  | { kind: "postgres"; url?: string; host: string; port: number; user: string; password: string; database: string }
  | { kind: "sqlite"; file: string };

export const MAX_ROWS = 50;
export const MAX_CELL = 200;

/** KEY=value lines of a .env file: optional `export`, quoted values kept verbatim, unquoted ones lose a trailing # comment. */
export function parseEnvText(text: string, vars: Record<string, string> = {}): Record<string, string> {
  for (const line of text.split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line); // lazy: trailing spaces/CR aren't part of the value
    if (!m) continue;
    let v = m[2];
    if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, "");
    vars[m[1]] = v;
  }
  return vars;
}

function parseEnv(dir: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const name of [".env", ".env.local"]) { // .env.local wins
    const file = join(dir, name);
    if (existsSync(file)) parseEnvText(readFileSync(file, "utf8"), vars);
  }
  return vars;
}

export function connection(dir = process.cwd()): Conn {
  const env = { ...parseEnv(dir), ...pick(process.env, ["DATABASE_URL", "VISIONCLI_DATABASE_URL"]) };
  const url = env.VISIONCLI_DATABASE_URL || env.DATABASE_URL;
  if (url) {
    const u = new URL(url);
    const proto = u.protocol.replace(":", "");
    if (proto.startsWith("mysql") || proto === "mariadb") {
      return { kind: "mysql", host: u.hostname, port: Number(u.port || 3306), user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), database: u.pathname.slice(1) };
    }
    if (proto.startsWith("postgres")) {
      return { kind: "postgres", url, host: u.hostname, port: Number(u.port || 5432), user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), database: u.pathname.slice(1) };
    }
    if (proto === "file" || proto === "sqlite") return { kind: "sqlite", file: resolve(dir, u.pathname) };
  }
  const driver = (env.DB_CONNECTION || "").toLowerCase();
  if (driver === "mysql" || driver === "mariadb") {
    return { kind: "mysql", host: env.DB_HOST || "127.0.0.1", port: Number(env.DB_PORT || 3306), user: env.DB_USERNAME || "root", password: env.DB_PASSWORD || "", database: env.DB_DATABASE || "" };
  }
  if (driver === "pgsql" || driver === "postgres") {
    return { kind: "postgres", host: env.DB_HOST || "127.0.0.1", port: Number(env.DB_PORT || 5432), user: env.DB_USERNAME || "postgres", password: env.DB_PASSWORD || "", database: env.DB_DATABASE || "" };
  }
  if (driver === "sqlite") {
    return { kind: "sqlite", file: resolve(dir, env.DB_DATABASE || "database/database.sqlite") };
  }
  throw new Error("No database configured: expected DB_CONNECTION/DB_* or DATABASE_URL in the project's .env.");
}

function pick(obj: NodeJS.ProcessEnv, keys: string[]) {
  return Object.fromEntries(keys.filter((k) => obj[k]).map((k) => [k, obj[k] as string]));
}

/** Only single read statements get through; the connection is also opened read-only. */
export function assertReadOnly(sql: string) {
  const s = sql.trim().replace(/;\s*$/, "");
  if (s.includes(";")) throw new Error("Only one statement at a time.");
  if (!/^(select|show|describe|desc|explain|with|pragma\s+table_info|pragma\s+foreign_key_list)\b/i.test(s)) {
    throw new Error("Read-only: only SELECT, SHOW, DESCRIBE, EXPLAIN and WITH queries are allowed.");
  }
  if (/^with\b/i.test(s) && /\b(insert|update|delete|merge)\b/i.test(s)) throw new Error("Read-only: data-modifying CTEs are not allowed.");
  return s;
}

/** Rows as a tab-separated table, capped at MAX_ROWS rows and MAX_CELL characters per cell. */
export function formatRows(rows: Record<string, unknown>[]) {
  if (!rows.length) return "(no rows)";
  const shown = rows.slice(0, MAX_ROWS);
  const cols = Object.keys(shown[0]);
  const cell = (v: unknown) => {
    const s = v === null || v === undefined ? "NULL" : v instanceof Date ? v.toISOString() : typeof v === "object" ? JSON.stringify(v) : String(v);
    return s.length > MAX_CELL ? s.slice(0, MAX_CELL) + "…" : s.replace(/\s+/g, " ");
  };
  const lines = [cols.join("\t"), ...shown.map((r) => cols.map((c) => cell(r[c])).join("\t"))];
  if (rows.length > MAX_ROWS) lines.push(`… ${rows.length - MAX_ROWS} more rows (add LIMIT/WHERE to narrow)`);
  return lines.join("\n");
}

// One pool per process (per connection settings), opened on first use: no reconnect + handshake per query.
type Runner = { key: string; rows: (sql: string) => Promise<Record<string, unknown>[]>; end: () => Promise<void> };
let runner: Runner | null = null;
const CONNECT_TIMEOUT = 8000;
const QUERY_TIMEOUT = 10000;

async function open(c: Exclude<Conn, { kind: "sqlite" }>): Promise<Runner> {
  const key = JSON.stringify(c);
  if (runner?.key === key) return runner;
  const old = runner;
  runner = null;
  old?.end().catch(() => {});
  if (c.kind === "mysql") {
    const mysql = await import("mysql2/promise");
    const pool = mysql.createPool({
      host: c.host, port: c.port, user: c.user, password: c.password, database: c.database,
      connectTimeout: CONNECT_TIMEOUT, connectionLimit: 2, maxIdle: 1, idleTimeout: 60_000,
    });
    runner = {
      key,
      end: () => pool.end(),
      rows: async (sql) => {
        const db = await pool.getConnection();
        try {
          await db.query("SET SESSION TRANSACTION READ ONLY");
          await db.query("START TRANSACTION READ ONLY");
          const [rows] = await db.query({ sql, timeout: QUERY_TIMEOUT });
          return rows as Record<string, unknown>[];
        } finally {
          await db.query("ROLLBACK").catch(() => {});
          db.release();
        }
      },
    };
  } else {
    const { default: pg } = await import("pg");
    const pool = new pg.Pool({
      ...(c.url ? { connectionString: c.url } : { host: c.host, port: c.port, user: c.user, password: c.password, database: c.database }),
      connectionTimeoutMillis: CONNECT_TIMEOUT, max: 2, idleTimeoutMillis: 60_000,
    });
    pool.on("error", () => {}); // an idle client dropped by the server: the pool replaces it
    runner = {
      key,
      end: () => pool.end(),
      rows: async (sql) => {
        const db = await pool.connect();
        try {
          await db.query("BEGIN READ ONLY");
          await db.query(`SET LOCAL statement_timeout = ${QUERY_TIMEOUT}`);
          return (await db.query(sql)).rows;
        } finally {
          await db.query("ROLLBACK").catch(() => {});
          db.release();
        }
      },
    };
  }
  return runner!;
}

async function rows(sql: string, c: Conn): Promise<Record<string, unknown>[]> {
  if (c.kind === "sqlite") {
    const { stdout } = await run("sqlite3", ["-readonly", "-json", c.file, sql], { timeout: QUERY_TIMEOUT });
    return stdout.trim() ? JSON.parse(stdout) : [];
  }
  const r = await open(c);
  try {
    return await r.rows(sql);
  } catch (err: any) {
    // Can't connect (server down, .env changed): drop the pool so the next call starts fresh.
    if (!err?.sqlMessage && !err?.severity) {
      if (runner === r) runner = null;
      r.end().catch(() => {});
    }
    throw err;
  }
}

export async function query(sql: string, dir = process.cwd()): Promise<string> {
  const stmt = assertReadOnly(sql);
  return formatRows(await rows(stmt, connection(dir)));
}

export const MAX_SCHEMA = 8000;

/** Tables with columns, and foreign keys, for the whole database or one table (capped; pass a table for the rest). */
export async function schema(table?: string, dir = process.cwd()): Promise<string> {
  const c = connection(dir);
  const t = table?.replace(/[^A-Za-z0-9_.$]/g, "");
  let tables: Record<string, unknown>[];
  let fks: Record<string, unknown>[];
  if (c.kind === "mysql") {
    const where = `table_schema = DATABASE()${t ? ` AND table_name = '${t}'` : ""}`;
    [tables, fks] = await Promise.all([
      rows(`SELECT table_name AS t, GROUP_CONCAT(CONCAT(column_name, ' ', column_type, IF(column_key='PRI',' PK',''), IF(is_nullable='YES',' null','')) ORDER BY ordinal_position SEPARATOR ', ') AS cols FROM information_schema.columns WHERE ${where} GROUP BY table_name ORDER BY table_name`, c),
      rows(`SELECT table_name AS t, CONCAT(column_name, ' -> ', referenced_table_name, '.', referenced_column_name) AS fk FROM information_schema.key_column_usage WHERE ${where} AND referenced_table_name IS NOT NULL ORDER BY table_name`, c),
    ]);
  } else if (c.kind === "postgres") {
    const where = `c.table_schema = 'public'${t ? ` AND c.table_name = '${t}'` : ""}`;
    [tables, fks] = await Promise.all([
      rows(`SELECT c.table_name AS t, string_agg(c.column_name || ' ' || c.data_type || CASE WHEN c.is_nullable='YES' THEN ' null' ELSE '' END, ', ' ORDER BY c.ordinal_position) AS cols FROM information_schema.columns c WHERE ${where} GROUP BY c.table_name ORDER BY c.table_name`, c),
      rows(`SELECT tc.table_name AS t, kcu.column_name || ' -> ' || ccu.table_name || '.' || ccu.column_name AS fk FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name WHERE tc.constraint_type = 'FOREIGN KEY'${t ? ` AND tc.table_name = '${t}'` : ""} ORDER BY tc.table_name`, c),
    ]);
  } else {
    // One sqlite3 run for every table (pragma table-valued functions), instead of two per table.
    const all = await rows(
      `SELECT m.name AS t,
        (SELECT group_concat(p.name || ' ' || p.type || CASE WHEN p.pk THEN ' PK' ELSE '' END || CASE WHEN p."notnull" OR p.pk THEN '' ELSE ' null' END, ', ') FROM pragma_table_info(m.name) p) AS cols,
        (SELECT group_concat(f."from" || ' -> ' || f."table" || '.' || f."to", char(10)) FROM pragma_foreign_key_list(m.name) f) AS fk
      FROM sqlite_master m WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%'${t ? ` AND m.name = '${t}'` : ""} ORDER BY m.name`,
      c,
    );
    tables = all;
    fks = sqliteForeignKeys(all);
  }
  return formatSchema(tables, fks, t);
}

/** sqlite's per-table newline-joined foreign keys ("from -> table.to") as one row each. */
export function sqliteForeignKeys(all: Record<string, unknown>[]): Record<string, unknown>[] {
  return all.flatMap((r) => (r.fk ? String(r.fk).split("\n").map((fk) => ({ t: r.t, fk })) : []));
}

/**
 * The schema text: tables with their columns, then foreign keys, capped at MAX_SCHEMA characters (the rest is summarized).
 * `t`/`cols`/`fk` are read in either case, as some drivers return column labels upper-cased.
 */
export function formatSchema(tables: Record<string, unknown>[], fks: Record<string, unknown>[], t?: string): string {
  if (!tables.length) return t ? `(no table ${t})` : "(no tables)";
  const val = (r: Record<string, unknown>, k: string) => String(r[k] ?? r[k.toUpperCase()] ?? "");
  const lines = ["TABLES", ...tables.map((r) => `${val(r, "t")}: ${val(r, "cols")}`), "", "FOREIGN KEYS",
    ...(fks.length ? fks.map((r) => `${val(r, "t")}.${val(r, "fk")}`) : ["(none)"])];
  let out = "";
  for (const [i, line] of lines.entries()) {
    if (out.length + line.length > MAX_SCHEMA) {
      return `${out}… truncated (${lines.length - i} more lines, ${tables.length} tables). Pass \`table\` to see one table in full.`;
    }
    out += line + "\n";
  }
  return out.trimEnd();
}

export function describeConnection(dir = process.cwd()) {
  const c = connection(dir);
  return c.kind === "sqlite" ? `sqlite (${c.file})` : `${c.kind} database "${c.database}" on ${c.host}:${c.port}`;
}
