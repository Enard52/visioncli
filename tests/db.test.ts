import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import {
  MAX_CELL,
  MAX_ROWS,
  MAX_SCHEMA,
  assertReadOnly,
  connection,
  describeConnection,
  formatRows,
  formatSchema,
  parseEnvText,
  query,
  schema,
  sqliteForeignKeys,
} from "../src/db.js";

const dirs: string[] = [];
const project = (files: Record<string, string>) => {
  const dir = mkdtempSync(join(tmpdir(), "vcli-db-"));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
};
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

describe("parseEnvText", () => {
  test("quotes, export, comments, spacing", () => {
    const env = parseEnvText([
      "# comment",
      "export DB_HOST=db.local",
      "DB_PASSWORD=\"p#ss word\"",
      "DB_USERNAME='root' ",
      "DB_PORT=3307 # local port",
      "  SPACED  =  value  ",
      "EMPTY=",
      "not a var",
      "1BAD=x",
    ].join("\n"));
    assert.deepEqual(env, { DB_HOST: "db.local", DB_PASSWORD: "p#ss word", DB_USERNAME: "root", DB_PORT: "3307", SPACED: "value", EMPTY: "" });
  });

  test("a # inside an unquoted value without a space before it is kept", () => {
    assert.equal(parseEnvText("PASS=a#b").PASS, "a#b");
  });

  test("Windows line endings and trailing spaces after quotes", () => {
    assert.deepEqual(parseEnvText("A=1\r\nB=\"two\" \r\n"), { A: "1", B: "two" });
  });
});

describe("connection", () => {
  test("Laravel mysql with defaults", () => {
    const c = connection(project({ ".env": "DB_CONNECTION=mysql\nDB_DATABASE=shop\n" }));
    assert.deepEqual(c, { kind: "mysql", host: "127.0.0.1", port: 3306, user: "root", password: "", database: "shop" });
  });

  test(".env.local overrides .env", () => {
    const c = connection(project({ ".env": "DB_CONNECTION=mysql\nDB_DATABASE=a\n", ".env.local": "DB_DATABASE=b\n" }));
    assert.equal(c.kind === "mysql" && c.database, "b");
  });

  test("DATABASE_URL wins over DB_*, with decoded credentials", () => {
    const c = connection(project({ ".env": "DB_CONNECTION=mysql\nDATABASE_URL=postgresql://u%40x:p%2Fw@pg.local/app\n" }));
    assert.deepEqual(c, { kind: "postgres", url: "postgresql://u%40x:p%2Fw@pg.local/app", host: "pg.local", port: 5432, user: "u@x", password: "p/w", database: "app" });
  });

  test("mariadb URL is mysql", () => {
    assert.equal(connection(project({ ".env": "DATABASE_URL=mariadb://r@h:3310/d\n" })).kind, "mysql");
  });

  test("sqlite: Laravel default path, relative to the project", () => {
    const dir = project({ ".env": "DB_CONNECTION=sqlite\n" });
    assert.deepEqual(connection(dir), { kind: "sqlite", file: join(dir, "database/database.sqlite") });
  });

  test("nothing configured", () => {
    assert.throws(() => connection(project({})), /No database configured/);
  });
});

describe("assertReadOnly", () => {
  test("allows single read statements, trimming a trailing semicolon", () => {
    assert.equal(assertReadOnly("  SELECT 1;  "), "SELECT 1");
    for (const sql of ["show tables", "DESCRIBE users", "desc users", "explain select 1", "with x as (select 1) select * from x", "PRAGMA table_info(users)"]) {
      assert.equal(assertReadOnly(sql), sql);
    }
  });

  test("rejects writes, multiple statements and data-modifying CTEs", () => {
    assert.throws(() => assertReadOnly("delete from users"), /Read-only/);
    assert.throws(() => assertReadOnly("select 1; drop table users"), /one statement/);
    assert.throws(() => assertReadOnly("with d as (delete from users returning *) select * from d"), /data-modifying CTEs/);
    assert.throws(() => assertReadOnly("pragma writable_schema = 1"), /Read-only/);
    assert.throws(() => assertReadOnly("selectx from y"), /Read-only/); // word boundary
  });
});

describe("formatRows", () => {
  test("no rows", () => assert.equal(formatRows([]), "(no rows)"));

  test("tab-separated with NULL, dates, JSON and whitespace collapsed", () => {
    const out = formatRows([{ id: 1, name: "a\n b", at: new Date("2026-01-02T03:04:05Z"), meta: { k: 1 }, gone: null }]);
    assert.equal(out, "id\tname\tat\tmeta\tgone\n1\ta b\t2026-01-02T03:04:05.000Z\t{\"k\":1}\tNULL");
  });

  test("long cells are cut at MAX_CELL", () => {
    const out = formatRows([{ v: "x".repeat(MAX_CELL + 5) }]);
    assert.equal(out.split("\n")[1], "x".repeat(MAX_CELL) + "…");
  });

  test("capped at MAX_ROWS rows with a hint", () => {
    const out = formatRows(Array.from({ length: MAX_ROWS + 7 }, (_, i) => ({ i })));
    const lines = out.split("\n");
    assert.equal(lines.length, 1 + MAX_ROWS + 1);
    assert.equal(lines.at(-1), "… 7 more rows (add LIMIT/WHERE to narrow)");
  });
});

describe("formatSchema", () => {
  test("tables and foreign keys, upper-cased column labels too", () => {
    const out = formatSchema([{ t: "orders", cols: "id int PK, user_id int" }, { T: "users", COLS: "id int PK" }], [{ t: "orders", fk: "user_id -> users.id" }]);
    assert.equal(out, "TABLES\norders: id int PK, user_id int\nusers: id int PK\n\nFOREIGN KEYS\norders.user_id -> users.id");
  });

  test("no foreign keys / no tables", () => {
    assert.match(formatSchema([{ t: "a", cols: "id" }], []), /FOREIGN KEYS\n\(none\)$/);
    assert.equal(formatSchema([], []), "(no tables)");
    assert.equal(formatSchema([], [], "users"), "(no table users)");
  });

  test(`capped near ${MAX_SCHEMA} characters, saying how much was left out`, () => {
    const tables = Array.from({ length: 400 }, (_, i) => ({ t: `table_${i}`, cols: "id bigint PK, created_at timestamp null" }));
    const out = formatSchema(tables, []);
    assert.ok(out.length <= MAX_SCHEMA + 200, String(out.length));
    const m = /… truncated \((\d+) more lines, 400 tables\)\. Pass `table` to see one table in full\.$/.exec(out);
    assert.ok(m, out.slice(-200));
    const shown = out.split("\n").filter((l) => l.startsWith("table_")).length;
    assert.equal(shown + Number(m[1]), 400 + 3); // "more lines": the rest of the tables + blank line, FOREIGN KEYS, (none)
  });
});

describe("sqliteForeignKeys", () => {
  test("splits newline-joined keys per table, skips tables without", () => {
    assert.deepEqual(sqliteForeignKeys([{ t: "a", fk: "x -> b.id\ny -> c.id" }, { t: "b", fk: null }]), [
      { t: "a", fk: "x -> b.id" },
      { t: "a", fk: "y -> c.id" },
    ]);
  });
});

let hasSqlite = true;
try { execFileSync("sqlite3", ["-version"]); } catch { hasSqlite = false; }

describe("sqlite end to end", { skip: !hasSqlite && "sqlite3 not installed" }, () => {
  const dir = project({ ".env": "DB_CONNECTION=sqlite\nDB_DATABASE=app.sqlite\n" });
  execFileSync("sqlite3", [join(dir, "app.sqlite"),
    "CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL, name TEXT);" +
    "CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), total REAL);" +
    "INSERT INTO users VALUES (1, 'a@x.dev', NULL), (2, 'b@x.dev', 'B');" +
    "INSERT INTO orders VALUES (10, 1, 9.5);"]);

  test("describeConnection", () => assert.equal(describeConnection(dir), `sqlite (${join(dir, "app.sqlite")})`));

  test("schema: columns with PK/null markers and foreign keys", async () => {
    assert.equal(await schema(undefined, dir), [
      "TABLES",
      "orders: id INTEGER PK, user_id INTEGER, total REAL null",
      "users: id INTEGER PK, email TEXT, name TEXT null",
      "",
      "FOREIGN KEYS",
      "orders.user_id -> users.id",
    ].join("\n"));
  });

  test("schema of one table; the table name is sanitized", async () => {
    assert.match(await schema("users", dir), /^TABLES\nusers: /);
    assert.equal(await schema("users'; drop table users; --", dir), "(no table usersdroptableusers)");
  });

  test("query", async () => {
    assert.equal(await query("select id, email, name from users order by id", dir), "id\temail\tname\n1\ta@x.dev\tNULL\n2\tb@x.dev\tB");
    assert.equal(await query("select * from users where id = 99", dir), "(no rows)");
  });

  test("writes never reach the database", async () => {
    await assert.rejects(query("insert into users values (3, 'c', 'c')", dir), /Read-only/);
  });
});
