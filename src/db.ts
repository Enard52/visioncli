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

const MAX_ROWS = 50;
const MAX_CELL = 200;

function parseEnv(dir: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const name of [".env", ".env.local"]) {
    const file = join(dir, name);
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      if (!m) continue;
      let v = m[2];
      if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
      else v = v.replace(/\s+#.*$/, "");
      vars[m[1]] = v;
    }
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

function format(rows: Record<string, unknown>[]) {
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

export async function query(sql: string, dir = process.cwd()): Promise<string> {
  const stmt = assertReadOnly(sql);
  const c = connection(dir);
  if (c.kind === "mysql") {
    const mysql = await import("mysql2/promise");
    const db = await mysql.createConnection({ host: c.host, port: c.port, user: c.user, password: c.password, database: c.database, connectTimeout: 8000 });
    try {
      await db.query("SET SESSION TRANSACTION READ ONLY");
      await db.query("START TRANSACTION READ ONLY");
      const [rows] = await db.query({ sql: stmt, timeout: 10000 });
      await db.query("ROLLBACK");
      return format(rows as Record<string, unknown>[]);
    } finally {
      await db.end();
    }
  }
  if (c.kind === "postgres") {
    const { default: pg } = await import("pg");
    const db = new pg.Client(c.url ? { connectionString: c.url } : { host: c.host, port: c.port, user: c.user, password: c.password, database: c.database });
    await db.connect();
    try {
      await db.query("BEGIN READ ONLY");
      await db.query("SET LOCAL statement_timeout = 10000");
      const res = await db.query(stmt);
      await db.query("ROLLBACK");
      return format(res.rows);
    } finally {
      await db.end();
    }
  }
  const { stdout } = await run("sqlite3", ["-readonly", "-json", c.file, stmt], { timeout: 10000 });
  return format(stdout.trim() ? JSON.parse(stdout) : []);
}

/** Tables with columns, and foreign keys, for the whole database or one table. */
export async function schema(table?: string, dir = process.cwd()): Promise<string> {
  const c = connection(dir);
  const t = table?.replace(/[^A-Za-z0-9_.$]/g, "");
  if (c.kind === "mysql") {
    const where = `table_schema = DATABASE()${t ? ` AND table_name = '${t}'` : ""}`;
    const cols = await query(
      `SELECT table_name, GROUP_CONCAT(CONCAT(column_name, ' ', column_type, IF(column_key='PRI',' PK',''), IF(is_nullable='YES',' null','')) ORDER BY ordinal_position SEPARATOR ', ') AS columns FROM information_schema.columns WHERE ${where} GROUP BY table_name ORDER BY table_name`,
      dir,
    );
    const fks = await query(
      `SELECT table_name, column_name, referenced_table_name, referenced_column_name FROM information_schema.key_column_usage WHERE ${where} AND referenced_table_name IS NOT NULL ORDER BY table_name`,
      dir,
    );
    return `TABLES\n${cols}\n\nFOREIGN KEYS\n${fks}`;
  }
  if (c.kind === "postgres") {
    const where = `c.table_schema = 'public'${t ? ` AND c.table_name = '${t}'` : ""}`;
    const cols = await query(
      `SELECT c.table_name, string_agg(c.column_name || ' ' || c.data_type || CASE WHEN c.is_nullable='YES' THEN ' null' ELSE '' END, ', ' ORDER BY c.ordinal_position) AS columns FROM information_schema.columns c WHERE ${where} GROUP BY c.table_name ORDER BY c.table_name`,
      dir,
    );
    const fks = await query(
      `SELECT tc.table_name, kcu.column_name, ccu.table_name AS referenced_table, ccu.column_name AS referenced_column FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name WHERE tc.constraint_type = 'FOREIGN KEY'${t ? ` AND tc.table_name = '${t}'` : ""} ORDER BY tc.table_name`,
      dir,
    );
    return `TABLES\n${cols}\n\nFOREIGN KEYS\n${fks}`;
  }
  const tables = t ? [t] : (await run("sqlite3", ["-readonly", c.file, ".tables"])).stdout.split(/\s+/).filter(Boolean);
  const parts: string[] = [];
  for (const name of tables) {
    parts.push(`${name}\n${await query(`PRAGMA table_info(${name})`, dir)}\nforeign keys:\n${await query(`PRAGMA foreign_key_list(${name})`, dir)}`);
  }
  return parts.join("\n\n") || "(no tables)";
}

export function describeConnection(dir = process.cwd()) {
  const c = connection(dir);
  return c.kind === "sqlite" ? `sqlite (${c.file})` : `${c.kind} database "${c.database}" on ${c.host}:${c.port}`;
}
