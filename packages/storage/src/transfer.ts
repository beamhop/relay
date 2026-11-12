import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import type { BeamhopConfig, DatabaseTarget, Db, Logger, Migration, NamespaceMigrations, TableProgress } from "@beamhop/sdk";
import { yieldToEventLoop } from "@beamhop/sdk";
import { createDb, type SqliteOptions } from "./db";
import { NAMESPACE as STORAGE_NAMESPACE, sqliteHasFts5, storageMigrations } from "./migrations";

/**
 * Copying a whole Beamhop database to another one (any dialect pair). Used by the runtime switcher and by
 * `beamhop db copy`.
 *
 * The target gets its schema from the migrations (prepareSchema), so it is native to its dialect; the copier only
 * moves rows, converting values between dialects on the way (see convertValue).
 */

export interface TransferOptions {
  logger: Logger;
  /** rows per read page / insert batch; default 1000 */
  batchRows?: number;
  signal?: AbortSignal;
  onProgress?(tables: TableProgress[]): void;
}

export interface DatabaseInspection {
  serverVersion: string;
  /** user tables (excluding sqlite internals and FTS shadow tables), with row counts */
  tables: { name: string; rows: number }[];
  /** bytes, when cheap to know (sqlite file size incl. WAL, pg_database_size) */
  sizeBytes?: number;
}

export interface VerifyReport {
  ok: boolean;
  tables: { table: string; sourceRows: number; targetRows: number; ok: boolean; detail?: string }[];
}

// ---------------------------------------------------------------------------------------------------------------
// Table classification: how finalCopy brings each table up to date while writes are paused.
//
// "append"  Rows are only ever inserted and deleted (never updated in place), keyed by a monotonic integer. bulkCopy
//           copies the rows up to a high-water mark (the key's max when the copy started); finalCopy copies the rows
//           past it, then diffs the key sets up to the mark in chunks: target rows missing from the source are
//           deleted, source rows missing from the target are copied. The second half matters: on postgres a
//           BIGSERIAL row can commit after a higher one (concurrent transactions), so it lands below the mark after
//           the bulk pass already went by; and sqlite reuses an INTEGER PRIMARY KEY (no AUTOINCREMENT) after the
//           highest row was deleted. `identity` columns are compared along with the key to catch that reuse.
// "child"   Rows belong to a row of an append table and are inserted / deleted with it (never on their own). They are
//           copied together with their parent rows; deleting a parent on the target removes them (FK cascade on
//           postgres, trigger on sqlite).
// "full"    Everything else, including any table a plugin owns: finalCopy deletes the target's rows and recopies all
//           of them. bulkCopy skips these (the copy would be thrown away).
//
// Checked against the code that writes each table:
// - events (storage): INSERT in save(), DELETE on replace / NIP-09 / expiry / vanish / retention; never UPDATEd.
//   seq is INTEGER PRIMARY KEY on sqlite (reusable, hence identity "id"), BIGSERIAL on postgres.
// - event_tags (storage): written by save() in the event's transaction, deleted only through events (trigger /
//   ON DELETE CASCADE). No primary key: child of events via event_seq.
// - audit_log (storage): INSERT by record(), DELETE by prune(); AUTOINCREMENT / BIGSERIAL id, never reused.
// - deleted_events: upserted with ON CONFLICT DO UPDATE (deleted_at moves) and keyed by (pubkey, ref): full.
// - users, invites, kv, ip_rules, admin_*, blossom_*, core_group_*, metrics_* (upserted counters): updated in
//   place: full.
// ---------------------------------------------------------------------------------------------------------------

interface AppendRule {
  /** monotonic integer column (the primary key) */
  key: string;
  /** compared with the key when diffing, to catch a key reused for another row */
  identity?: string[];
  /** tables whose rows belong to a row of this table */
  children?: { table: string; column: string }[];
}

const APPEND_TABLES: Record<string, AppendRule> = {
  events: { key: "seq", identity: ["id"], children: [{ table: "event_tags", column: "event_seq" }] },
  audit_log: { key: "id" },
};

/** Never copied: the target's own migrations fill it. */
const MIGRATIONS_TABLE = "_migrations";

/** Full-text tables (sqlite FTS5 virtual table and shadows): rebuilt on the target, never copied. */
const isFtsTable = (name: string) => /^events_fts($|_)/i.test(name);

/** Verified row by row (every row) regardless of size, up to this many rows; other tables up to SMALL_TABLE_ROWS. */
const ALWAYS_CHECKSUM = (name: string) => name === "kv" || name === "users" || name === "settings" || name.startsWith("admin_");
const ALWAYS_CHECKSUM_MAX_ROWS = 200_000;
const SMALL_TABLE_ROWS = 5_000;
const SAMPLE_ROWS = 200;

/** bound parameters per statement: postgres' wire protocol limit / sqlite's SQLITE_MAX_VARIABLE_NUMBER (>= 3.32) */
const MAX_PARAMS = { postgres: 65_535, sqlite: 32_766 } as const;

// ----- small helpers ---------------------------------------------------------------------------------------------

const q = (ident: string) => `"${ident.replace(/"/g, '""')}"`;
const num = (v: unknown) => Number(v ?? 0);

type ColType = "int" | "real" | "bool" | "bytes" | "json" | "text" | "other";

interface ColumnInfo {
  name: string;
  type: ColType;
  /** postgres data_type (information_schema), e.g. "jsonb" */
  pgType?: string;
  /** generated / virtual-table hidden column: cannot be inserted */
  generated: boolean;
  /** postgres GENERATED ALWAYS AS IDENTITY: insert needs OVERRIDING SYSTEM VALUE */
  identityAlways: boolean;
  /** postgres serial / identity column (its sequence is reset after the copy) */
  sequence: boolean;
}

interface TableInfo {
  name: string;
  columns: ColumnInfo[];
  /** primary key columns in key order (empty when none) */
  pk: string[];
}

function pgColType(dataType: string): ColType {
  const t = dataType.toLowerCase();
  if (t === "smallint" || t === "integer" || t === "bigint") return "int";
  if (t === "real" || t === "double precision" || t === "numeric") return "real";
  if (t === "boolean") return "bool";
  if (t === "bytea") return "bytes";
  if (t === "json" || t === "jsonb") return "json";
  if (t === "text" || t.startsWith("character")) return "text";
  return "other";
}

/** sqlite's type affinity rules (https://sqlite.org/datatype3.html#determination_of_column_affinity), plus BOOL */
function sqliteColType(declared: string): ColType {
  const t = declared.toUpperCase();
  if (t.includes("INT")) return "int";
  if (t.includes("CHAR") || t.includes("CLOB") || t.includes("TEXT")) return "text";
  if (t.includes("BLOB") || t === "") return "other";
  if (t.includes("BOOL")) return "bool";
  if (t.includes("JSON")) return "json";
  return "real";
}

const isBytes = (v: unknown): v is Uint8Array => v instanceof Uint8Array;

/**
 * A value read from the source, converted for a target column. sqlite hands back numbers, strings and Uint8Array;
 * postgres also booleans, Buffers, Dates and parsed JSON (int8 is parsed to a number by createDb). Booleans become
 * 0/1 (Beamhop stores them as INTEGER; postgres' boolean input accepts '0'/'1'). Strings, including JSON text and
 * a leading U+FEFF (the sqlite driver keeps it, see keepLeadingBom in db.ts), pass through unchanged.
 */
export function convertValue(v: unknown, type: ColType): unknown {
  if (v === null || v === undefined) return null;
  switch (type) {
    case "int":
    case "real": {
      if (typeof v === "boolean") return v ? 1 : 0;
      if (typeof v === "bigint") return Number.isSafeInteger(Number(v)) ? Number(v) : String(v);
      if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) {
        const n = Number(v);
        return type === "int" && !Number.isSafeInteger(n) ? v : n;
      }
      return v;
    }
    case "bool":
      if (typeof v === "string") return v === "0" || v.toLowerCase() === "false" || v.toLowerCase() === "f" ? 0 : 1;
      return v ? 1 : 0;
    case "bytes":
      if (isBytes(v)) return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
      if (typeof v === "string") return Buffer.from(v, "utf8");
      return v;
    case "text":
    case "json":
      if (typeof v === "bigint") return String(v);
      if (isBytes(v)) return Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("utf8");
      if (v instanceof Date) return v.toISOString();
      if (typeof v === "object") return JSON.stringify(v);
      return v;
    default:
      if (typeof v === "bigint") return Number.isSafeInteger(Number(v)) ? Number(v) : String(v);
      if (v instanceof Date) return v.toISOString();
      if (typeof v === "object" && !isBytes(v)) return JSON.stringify(v);
      return v;
  }
}

/**
 * VALUES placeholder for a target column. postgres.js serializes a parameter by the type the server infers for it,
 * and Db normalizes booleans to 0/1 before that: a 1 bound to a boolean column would be serialized as false, and a
 * string bound to a json column would be stored as a JSON string. Casting from int / text sidesteps both.
 */
function placeholderFor(c: ColumnInfo): string {
  if (c.pgType === "boolean") return "(CAST(? AS INTEGER) <> 0)";
  if (c.pgType === "json" || c.pgType === "jsonb") return `CAST(CAST(? AS TEXT) AS ${c.pgType})`;
  return "?";
}

/** A dialect-independent text form of a value (for checksums): both sides of a copy give the same string. */
function canonical(v: unknown, type: ColType): string {
  if (type === "json" && v !== null && v !== undefined) {
    // jsonb reorders keys and drops whitespace: compare the parsed values
    try {
      return `\u0000J${stableJson(typeof v === "string" ? JSON.parse(v) : v)}`;
    } catch {
      // not JSON: compared as text below
    }
  }
  const c = convertValue(v, type);
  if (c === null) return "\u0000N";
  if (isBytes(c)) return `\u0000B${Buffer.from(c.buffer, c.byteOffset, c.byteLength).toString("hex")}`;
  if (typeof c === "number") return `\u0000#${c}`;
  if (typeof c === "boolean") return `\u0000#${c ? 1 : 0}`;
  if (typeof c === "object") return JSON.stringify(c);
  return `\u0000S${String(c)}`;
}

function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

function abortError(signal: AbortSignal): Error {
  const r = signal.reason;
  return r instanceof Error ? r : new Error(typeof r === "string" ? r : "database copy cancelled");
}

// ----- introspection ---------------------------------------------------------------------------------------------

async function listTables(db: Db): Promise<string[]> {
  if (db.dialect === "sqlite") {
    const rows = await db.all<{ name: string; sql: string | null }>(
      "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'",
    );
    const virtual = rows.filter((r) => /^\s*CREATE\s+VIRTUAL\s+TABLE/i.test(r.sql ?? "")).map((r) => r.name);
    return rows
      .map((r) => r.name)
      .filter((n) => !virtual.includes(n) && !virtual.some((v) => n.startsWith(`${v}_`)) && !isFtsTable(n))
      .sort();
  }
  const rows = await db.all<{ name: string }>(
    "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'",
  );
  return rows.map((r) => r.name).filter((n) => !isFtsTable(n)).sort();
}

async function tableInfo(db: Db, table: string): Promise<TableInfo> {
  if (db.dialect === "sqlite") {
    const cols = await db.all<{ name: string; type: string; pk: number; hidden: number }>(
      "SELECT name, type, pk, hidden FROM pragma_table_xinfo(?) ORDER BY cid",
      [table],
    );
    return {
      name: table,
      columns: cols.map((c) => ({
        name: c.name,
        type: sqliteColType(c.type ?? ""),
        // 1: hidden column of a virtual table, 2/3: generated (virtual / stored)
        generated: num(c.hidden) !== 0,
        identityAlways: false,
        sequence: false,
      })),
      pk: cols.filter((c) => num(c.pk) > 0).sort((a, b) => num(a.pk) - num(b.pk)).map((c) => c.name),
    };
  }
  const cols = await db.all<{
    name: string;
    data_type: string;
    is_generated: string;
    is_identity: string;
    identity_generation: string | null;
    column_default: string | null;
  }>(
    `SELECT column_name AS name, data_type, is_generated, is_identity, identity_generation, column_default
       FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ? ORDER BY ordinal_position`,
    [table],
  );
  const pk = await db.all<{ name: string }>(
    `SELECT a.attname AS name
       FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE i.indisprimary AND i.indrelid = to_regclass(quote_ident(current_schema()) || '.' || quote_ident(?))
      ORDER BY array_position(i.indkey::int2[], a.attnum)`,
    [table],
  );
  return {
    name: table,
    columns: cols.map((c) => ({
      name: c.name,
      type: pgColType(c.data_type),
      pgType: c.data_type.toLowerCase(),
      generated: c.is_generated === "ALWAYS",
      identityAlways: c.is_identity === "YES" && c.identity_generation === "ALWAYS",
      sequence: c.is_identity === "YES" || (c.column_default ?? "").startsWith("nextval("),
    })),
    pk: pk.map((r) => r.name),
  };
}

/** child → parent table pairs (foreign keys) */
async function foreignKeys(db: Db, tables: string[]): Promise<{ child: string; parent: string }[]> {
  if (db.dialect === "sqlite") {
    const out: { child: string; parent: string }[] = [];
    for (const t of tables) {
      for (const fk of await db.all<{ table: string }>("SELECT \"table\" FROM pragma_foreign_key_list(?)", [t])) out.push({ child: t, parent: fk.table });
    }
    return out;
  }
  return db.all<{ child: string; parent: string }>(
    `SELECT c.relname AS child, p.relname AS parent
       FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_class p ON p.oid = k.confrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE k.contype = 'f' AND n.nspname = current_schema()`,
  );
}

async function countRows(db: Db, table: string): Promise<number> {
  return num((await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${q(table)}`))?.n);
}

// ----- public functions ------------------------------------------------------------------------------------------

/** Opens (creating when needed) the database a target describes. The caller closes it. */
export async function openDatabase(target: DatabaseTarget, sqlite?: SqliteOptions): Promise<Db> {
  if (target.driver === "sqlite" && !target.sqlitePath) throw new Error("a sqlite target needs a file path");
  if (target.driver === "postgres" && !target.postgresUrl) throw new Error("a postgres target needs a connection URL");
  const database = { driver: target.driver, sqlitePath: target.sqlitePath ?? "", postgresUrl: target.postgresUrl } as BeamhopConfig["database"];
  return createDb({ database }, sqlite);
}

/**
 * Server version, user tables with row counts (`_migrations` included; sqlite internals and FTS tables left out)
 * and size. Pass the target to include a sqlite file's WAL in the size.
 */
export async function inspectDatabase(db: Db, target?: DatabaseTarget): Promise<DatabaseInspection> {
  const tables: { name: string; rows: number }[] = [];
  for (const name of await listTables(db)) tables.push({ name, rows: await countRows(db, name) });
  if (db.dialect === "sqlite") {
    const v = await db.get<{ v: string }>("SELECT sqlite_version() AS v");
    let sizeBytes: number | undefined;
    const path = target?.driver === "sqlite" ? target.sqlitePath : undefined;
    if (path && path !== ":memory:" && existsSync(path)) {
      sizeBytes = 0;
      for (const f of [path, `${path}-wal`]) if (existsSync(f)) sizeBytes += statSync(f).size;
    } else {
      const pc = await db.get<{ page_count: number }>("PRAGMA page_count");
      const ps = await db.get<{ page_size: number }>("PRAGMA page_size");
      sizeBytes = num(pc?.page_count) * num(ps?.page_size);
    }
    return { serverVersion: `SQLite ${v?.v ?? "?"}`, tables, sizeBytes };
  }
  const v = await db.get<{ server_version: string }>("SHOW server_version");
  const size = await db.get<{ n: number }>("SELECT pg_database_size(current_database())::bigint AS n");
  return { serverVersion: `PostgreSQL ${(v?.server_version ?? "?").split(" ")[0]}`, tables, sizeBytes: size ? num(size.n) : undefined };
}

/** Drops every table (and FTS / views / sequences / triggers) in the database. */
export async function wipeDatabase(db: Db): Promise<void> {
  if (db.dialect === "sqlite") {
    await db.exec("PRAGMA foreign_keys = OFF");
    try {
      const objs = await db.all<{ type: string; name: string; sql: string | null }>(
        "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\'",
      );
      for (const o of objs.filter((o) => o.type === "view")) await db.exec(`DROP VIEW IF EXISTS ${q(o.name)}`);
      for (const o of objs.filter((o) => o.type === "trigger")) await db.exec(`DROP TRIGGER IF EXISTS ${q(o.name)}`);
      // a virtual table drops its shadow tables with it
      for (const o of objs.filter((o) => o.type === "table" && /^\s*CREATE\s+VIRTUAL\s+TABLE/i.test(o.sql ?? ""))) {
        await db.exec(`DROP TABLE IF EXISTS ${q(o.name)}`);
      }
      const left = await db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'");
      for (const t of left) await db.exec(`DROP TABLE IF EXISTS ${q(t.name)}`);
      if (await db.get("SELECT 1 AS x FROM sqlite_master WHERE name = 'sqlite_sequence'")) await db.run("DELETE FROM sqlite_sequence");
    } finally {
      await db.exec("PRAGMA foreign_keys = ON");
    }
    await db.exec("VACUUM");
    return;
  }
  const views = await db.all<{ name: string }>("SELECT table_name AS name FROM information_schema.views WHERE table_schema = current_schema()");
  for (const v of views) await db.exec(`DROP VIEW IF EXISTS ${q(v.name)} CASCADE`);
  const mviews = await db.all<{ name: string }>("SELECT matviewname AS name FROM pg_matviews WHERE schemaname = current_schema()");
  for (const v of mviews) await db.exec(`DROP MATERIALIZED VIEW IF EXISTS ${q(v.name)} CASCADE`);
  const tables = await db.all<{ name: string }>(
    "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'",
  );
  if (tables.length) await db.exec(`DROP TABLE IF EXISTS ${tables.map((t) => q(t.name)).join(", ")} CASCADE`);
  const seqs = await db.all<{ name: string }>("SELECT sequence_name AS name FROM information_schema.sequences WHERE sequence_schema = current_schema()");
  for (const s of seqs) await db.exec(`DROP SEQUENCE IF EXISTS ${q(s.name)} CASCADE`);
}

/**
 * Applies every namespace's migrations to `target`, so its schema is native to its dialect. The storage namespace
 * uses the list for the target's dialect (the source may have recorded the FTS-less sqlite variant, or a sqlite
 * target may lack FTS5), and runs first.
 */
export async function prepareSchema(target: Db, namespaces: NamespaceMigrations[]): Promise<void> {
  const ordered = [...namespaces].sort((a, b) => Number(b.namespace === STORAGE_NAMESPACE) - Number(a.namespace === STORAGE_NAMESPACE));
  for (const ns of ordered) {
    let migrations: Migration[] = ns.migrations;
    if (ns.namespace === STORAGE_NAMESPACE) migrations = storageMigrations(target.dialect === "sqlite" ? await sqliteHasFts5(target) : true);
    await target.migrate(ns.namespace, migrations);
  }
}

/**
 * Wraps a Db to record every migrate() call (latest list per namespace), for building a target's schema from what a
 * server actually registers when `SwitchableDb.registeredMigrations()` is unavailable.
 */
export function recordMigrations(inner: Db): { db: Db; recorded(): NamespaceMigrations[] } {
  const seen = new Map<string, Migration[]>();
  const db: Db & { readonly inTxContext?: boolean } = {
    get dialect() {
      return inner.dialect;
    },
    get inTxContext() {
      return (inner as { inTxContext?: boolean }).inTxContext;
    },
    all: (sql, params) => inner.all(sql, params),
    get: (sql, params) => inner.get(sql, params),
    run: (sql, params) => inner.run(sql, params),
    exec: (sql) => inner.exec(sql),
    tx: (fn) => inner.tx(fn),
    migrate: (namespace, migrations) => {
      seen.set(namespace, [...migrations]);
      return inner.migrate(namespace, migrations);
    },
    close: () => inner.close(),
  };
  return { db, recorded: () => [...seen].map(([namespace, migrations]) => ({ namespace, migrations })) };
}

// ----- the copier ------------------------------------------------------------------------------------------------

type Row = Record<string, unknown>;
type Mode = "append" | "child" | "full";

interface ColumnPair {
  src: string;
  tgt: string;
  type: ColType;
  /** the VALUES placeholder for it on the target */
  placeholder: string;
}

interface TablePlan {
  name: string;
  /** the target's name for it (case may differ) */
  target: string;
  mode: Mode;
  columns: ColumnPair[];
  /** unique paging key (source column names); empty: sqlite rowid / postgres ctid paging */
  key: string[];
  append?: AppendRule & { srcKey: string; identity: string[] };
  /** for "child": its parent and the column referencing the parent's key */
  childOf?: { parent: string; column: string };
  children: TablePlan[];
  overriding: boolean;
  /** high-water mark (append tables), set by bulkCopy */
  mark?: number;
  progress: TableProgress;
}

const ROWID = "__bh_rowid";

/**
 * Copies every table from `source` to `target` (schema already prepared, target otherwise empty).
 * bulkCopy() runs while the source is live; finalCopy() runs with writes paused and brings the target fully up to
 * date (rows added/changed/deleted since); verify() compares the two.
 */
export class DatabaseCopier {
  private plans: TablePlan[] | null = null;
  private bulkDone = false;
  private readonly batch: number;

  constructor(
    readonly source: Db,
    readonly target: Db,
    readonly opts: TransferOptions,
  ) {
    this.batch = Math.max(1, Math.floor(opts.batchRows ?? 1000));
  }

  progress(): TableProgress[] {
    return (this.plans ?? []).map((p) => ({ ...p.progress }));
  }

  /** Copies the append tables up to their high-water marks (the rest is copied by finalCopy). Source may be live. */
  async bulkCopy(): Promise<void> {
    const plans = await this.discover();
    for (const p of plans) {
      p.progress.total = await countRows(this.source, p.name);
      for (const c of p.children) c.progress.total = await countRows(this.source, c.name);
    }
    this.emit();
    for (const p of plans) {
      if (p.mode !== "append" || !p.append) continue;
      this.checkAbort();
      const k = p.append.srcKey;
      const row = await this.source.get<{ m: number | null }>(`SELECT MAX(${q(k)}) AS m FROM ${q(p.name)}`);
      p.mark = row?.m == null ? Number.MIN_SAFE_INTEGER : num(row.m);
      for await (const page of this.pages(this.source, p, `${q(k)} <= ?`, [p.mark])) {
        await this.insertWithChildren(p, page);
      }
      this.opts.logger.debug("bulk copy: table done", { table: p.name, mark: p.mark, rows: p.progress.copied });
    }
    this.bulkDone = true;
    this.emit();
  }

  /**
   * Brings the target up to date with the source; run with source writes paused. Without a prior bulkCopy it
   * copies everything.
   */
  async finalCopy(): Promise<void> {
    const plans = await this.discover();
    if (!this.bulkDone) {
      for (const p of plans) {
        p.progress.total = await countRows(this.source, p.name);
        for (const c of p.children) c.progress.total = await countRows(this.source, c.name);
      }
    }
    // full tables: empty them on the target (children before parents), then copy (parents first)
    const full = plans.filter((p) => p.mode === "full");
    for (const p of [...full].reverse()) {
      this.checkAbort();
      await this.target.run(`DELETE FROM ${q(p.target)}`);
    }
    for (const p of plans) {
      this.checkAbort();
      if (p.mode === "full") {
        p.progress.copied = 0;
        p.progress.total = await countRows(this.source, p.name);
        for await (const page of this.pages(this.source, p)) await this.insertWithChildren(p, page);
      } else if (p.mode === "append" && p.append) {
        p.progress.total = await countRows(this.source, p.name);
        for (const c of p.children) c.progress.total = await countRows(this.source, c.name);
        if (p.mark !== undefined) await this.reconcile(p, p.mark);
        const k = p.append.srcKey;
        const pages = p.mark === undefined ? this.pages(this.source, p) : this.pages(this.source, p, `${q(k)} > ?`, [p.mark]);
        for await (const page of pages) await this.insertWithChildren(p, page);
      }
      p.progress.done = true;
      for (const c of p.children) c.progress.done = true;
      this.emit();
    }
    await this.resetSequences(plans);
    // Full-text search needs no extra pass: on sqlite the events_fts triggers (installed by the target's own
    // migrations) indexed every inserted / deleted event; on postgres `events.search` is a generated column.
    this.emit();
  }

  /** Compares row counts of every table, and row contents (all rows of small tables, a sample of big ones). */
  async verify(): Promise<VerifyReport> {
    const plans = await this.discover();
    const out: VerifyReport["tables"] = [];
    const all = plans.flatMap((p) => [p, ...p.children]);
    for (const p of all) {
      this.checkAbort();
      const sourceRows = await countRows(this.source, p.name);
      const targetRows = await countRows(this.target, p.target);
      let ok = sourceRows === targetRows;
      let detail = ok ? undefined : "row counts differ";
      if (ok && sourceRows > 0) {
        const full = sourceRows <= SMALL_TABLE_ROWS || (ALWAYS_CHECKSUM(p.name) && sourceRows <= ALWAYS_CHECKSUM_MAX_ROWS);
        if (full) {
          const [a, b] = [await this.checksum(this.source, p, "src"), await this.checksum(this.target, p, "tgt")];
          ok = a === b;
          detail = ok ? `checksum of all ${sourceRows} rows matches` : "row contents differ";
        } else {
          const r = await this.sampleCompare(p);
          ok = r.ok;
          detail = r.detail;
        }
      }
      out.push({ table: p.name, sourceRows, targetRows, ok, detail });
    }
    return { ok: out.every((t) => t.ok), tables: out };
  }

  // ----- internals ---------------------------------------------------------------------------------------------

  private emit() {
    this.opts.onProgress?.(this.progress());
  }

  private checkAbort() {
    const s = this.opts.signal;
    if (s?.aborted) throw abortError(s);
  }

  private async discover(): Promise<TablePlan[]> {
    if (this.plans) return this.plans;
    const log = this.opts.logger;
    const srcTables = (await listTables(this.source)).filter((t) => t !== MIGRATIONS_TABLE);
    const tgtByLower = new Map((await listTables(this.target)).map((t) => [t.toLowerCase(), t]));
    const missing = srcTables.filter((t) => !tgtByLower.has(t.toLowerCase()));
    if (missing.length) {
      throw new Error(
        `the target database has no table for: ${missing.join(", ")} (is the plugin or feature that owns it enabled?); nothing was copied`,
      );
    }
    const byName = new Map<string, TablePlan>();
    for (const name of srcTables) {
      const tgtName = tgtByLower.get(name.toLowerCase())!;
      const [si, ti] = [await tableInfo(this.source, name), await tableInfo(this.target, tgtName)];
      const tgtCols = new Map(ti.columns.filter((c) => !c.generated).map((c) => [c.name.toLowerCase(), c]));
      const columns: ColumnPair[] = [];
      for (const c of si.columns) {
        if (c.generated) continue;
        const t = tgtCols.get(c.name.toLowerCase());
        if (t) columns.push({ src: c.name, tgt: t.name, type: t.type, placeholder: placeholderFor(t) });
        else log.warn("column missing on the target, not copied", { table: name, column: c.name });
      }
      const has = (col: string) => columns.find((c) => c.src.toLowerCase() === col.toLowerCase())?.src;
      let mode: Mode = "full";
      let append: TablePlan["append"];
      const rule = APPEND_TABLES[name.toLowerCase()];
      if (rule) {
        const srcKey = has(rule.key);
        const identity = (rule.identity ?? []).map(has);
        if (srcKey && si.pk.length === 1 && si.pk[0] === srcKey && identity.every(Boolean)) {
          mode = "append";
          append = { ...rule, srcKey, identity: identity as string[] };
        } else log.warn("append table without its expected key, copied in full instead", { table: name });
      }
      byName.set(name.toLowerCase(), {
        name,
        target: tgtName,
        mode,
        columns,
        key: si.pk.filter((k) => has(k)).length === si.pk.length ? si.pk : [],
        append,
        children: [],
        overriding: ti.columns.some((c) => c.identityAlways),
        progress: { table: name, total: 0, copied: 0, done: false },
      });
    }
    // attach children to their append parents
    for (const p of byName.values()) {
      for (const c of p.mode === "append" ? (p.append?.children ?? []) : []) {
        const child = byName.get(c.table.toLowerCase());
        const col = child?.columns.find((x) => x.src.toLowerCase() === c.column.toLowerCase());
        if (!child || !col) continue;
        child.mode = "child";
        child.childOf = { parent: p.name, column: col.src };
        p.children.push(child);
      }
    }
    // parents before children (foreign keys on either side)
    const fks = [...(await foreignKeys(this.source, srcTables)), ...(await foreignKeys(this.target, [...tgtByLower.values()]))];
    const deps = new Map<string, Set<string>>();
    for (const { child, parent } of fks) {
      const [c, pa] = [child.toLowerCase(), parent.toLowerCase()];
      if (c === pa || !byName.has(c) || !byName.has(pa)) continue;
      if (!deps.has(c)) deps.set(c, new Set());
      deps.get(c)!.add(pa);
    }
    const ordered: TablePlan[] = [];
    const state = new Map<string, number>();
    const visit = (n: string) => {
      if (state.get(n) === 2) return;
      if (state.get(n) === 1) return; // cycle: keep going, the order between the two is arbitrary
      state.set(n, 1);
      for (const d of deps.get(n) ?? []) visit(d);
      state.set(n, 2);
      ordered.push(byName.get(n)!);
    };
    for (const n of [...byName.keys()].sort()) visit(n);
    // children are copied by their parent; they stay listed (progress, verify) through it
    this.plans = ordered.filter((p) => p.mode !== "child");
    for (const p of ordered) {
      if (p.mode !== "full") continue;
      if (deps.get(p.name.toLowerCase()) && [...deps.get(p.name.toLowerCase())!].some((d) => byName.get(d)?.mode !== "full")) {
        log.warn("full table references an append table; it is copied after it", { table: p.name });
      }
    }
    return this.plans;
  }

  /** Source rows in pages, in key order (keyset paging), rowid order (sqlite) or ctid order with offsets (postgres). */
  private async *pages(db: Db, p: TablePlan, where?: string, params: unknown[] = []): AsyncGenerator<Row[]> {
    const cols = p.columns.map((c) => q(c.src));
    const extra = where ? ` AND (${where})` : "";
    if (p.key.length) {
      const keyCols = p.key.map(q);
      const keyExpr = keyCols.length === 1 ? keyCols[0] : `(${keyCols.join(", ")})`;
      const keyParam = keyCols.length === 1 ? "?" : `(${keyCols.map(() => "?").join(", ")})`;
      let last: unknown[] | null = null;
      for (;;) {
        this.checkAbort();
        const cond = last ? `${keyExpr} > ${keyParam}` : "1 = 1";
        const rows: Row[] = await db.all<Row>(
          `SELECT ${cols.join(", ")} FROM ${q(p.name)} WHERE ${cond}${extra} ORDER BY ${keyCols.join(", ")} LIMIT ${this.batch}`,
          [...(last ?? []), ...params],
        );
        if (!rows.length) return;
        last = p.key.map((k) => rows[rows.length - 1][k]);
        yield rows;
        await yieldToEventLoop();
        if (rows.length < this.batch) return;
      }
    }
    if (db.dialect === "sqlite") {
      let last = Number.MIN_SAFE_INTEGER;
      for (;;) {
        this.checkAbort();
        const rows: Row[] = await db.all<Row>(
          `SELECT rowid AS ${ROWID}, ${cols.join(", ")} FROM ${q(p.name)} WHERE rowid > ?${extra} ORDER BY rowid LIMIT ${this.batch}`,
          [last, ...params],
        );
        if (!rows.length) return;
        last = num(rows[rows.length - 1][ROWID]);
        yield rows;
        await yieldToEventLoop();
        if (rows.length < this.batch) return;
      }
    }
    // postgres table without a primary key: physical order is stable while writes are paused (finalCopy)
    for (let offset = 0; ; offset += this.batch) {
      this.checkAbort();
      const rows: Row[] = await db.all<Row>(
        `SELECT ${cols.join(", ")} FROM ${q(p.name)} WHERE 1 = 1${extra} ORDER BY ctid LIMIT ${this.batch} OFFSET ${offset}`,
        params,
      );
      if (!rows.length) return;
      yield rows;
      await yieldToEventLoop();
      if (rows.length < this.batch) return;
    }
  }

  /** Multi-row INSERTs into the target, within the parameter limit. */
  private async insert(db: Db, p: TablePlan, rows: Row[]): Promise<void> {
    if (!rows.length) return;
    const cols = p.columns;
    const per = Math.max(1, Math.min(this.batch, Math.floor(MAX_PARAMS[db.dialect] / Math.max(1, cols.length))));
    const tuple = `(${cols.map((c) => c.placeholder).join(", ")})`;
    const head = `INSERT INTO ${q(p.target)} (${cols.map((c) => q(c.tgt)).join(", ")})${p.overriding && db.dialect === "postgres" ? " OVERRIDING SYSTEM VALUE" : ""} VALUES `;
    for (let i = 0; i < rows.length; i += per) {
      const part = rows.slice(i, i + per);
      const params: unknown[] = [];
      for (const r of part) for (const c of cols) params.push(convertValue(r[c.src], c.type));
      await db.run(head + part.map(() => tuple).join(", "), params);
    }
    p.progress.copied += rows.length;
  }

  /** Inserts a page of rows and, for an append table, its children's rows (in one target transaction). */
  private async insertWithChildren(p: TablePlan, rows: Row[]): Promise<void> {
    if (!rows.length) return;
    const childRows: [TablePlan, Row[]][] = [];
    if (p.children.length && p.append) {
      const keys = rows.map((r) => r[p.append!.srcKey]);
      for (const c of p.children) childRows.push([c, await this.childRowsOf(c, keys)]);
    }
    await this.target.tx(async (tx) => {
      await this.insert(tx, p, rows);
      for (const [c, cr] of childRows) await this.insert(tx, c, cr);
    });
    this.emit();
  }

  private async childRowsOf(c: TablePlan, parentKeys: unknown[]): Promise<Row[]> {
    const col = c.childOf!.column;
    const out: Row[] = [];
    for (let i = 0; i < parentKeys.length; i += 500) {
      const part = parentKeys.slice(i, i + 500);
      out.push(
        ...(await this.source.all<Row>(
          `SELECT ${c.columns.map((x) => q(x.src)).join(", ")} FROM ${q(c.name)} WHERE ${q(col)} IN (${part.map(() => "?").join(", ")})`,
          part,
        )),
      );
    }
    return out;
  }

  /**
   * Append table, keys up to `mark`: deletes target rows the source no longer has (or has under another identity)
   * and copies source rows the target is missing. Chunked by key range, ids only.
   */
  private async reconcile(p: TablePlan, mark: number): Promise<void> {
    const a = p.append!;
    const k = a.srcKey;
    const tk = p.columns.find((c) => c.src === k)!.tgt;
    const tIdent = a.identity.map((i) => p.columns.find((c) => c.src === i)!.tgt);
    const chunk = this.batch * 10;
    const sig = (r: Row, key: string, ident: string[]) => [String(num(r[key])), ...ident.map((i) => String(r[i]))].join("\u0000");
    let after = Number.MIN_SAFE_INTEGER;
    for (;;) {
      this.checkAbort();
      const src = await this.source.all<Row>(
        `SELECT ${[k, ...a.identity].map(q).join(", ")} FROM ${q(p.name)} WHERE ${q(k)} > ? AND ${q(k)} <= ? ORDER BY ${q(k)} LIMIT ${chunk}`,
        [after, mark],
      );
      const hi = src.length < chunk ? mark : num(src[src.length - 1][k]);
      const tgt = await this.target.all<Row>(
        `SELECT ${[tk, ...tIdent].map(q).join(", ")} FROM ${q(p.target)} WHERE ${q(tk)} > ? AND ${q(tk)} <= ?`,
        [after, hi],
      );
      const srcSigs = new Set(src.map((r) => sig(r, k, a.identity)));
      const tgtSigs = new Set(tgt.map((r) => sig(r, tk, tIdent)));
      const gone = tgt.filter((r) => !srcSigs.has(sig(r, tk, tIdent))).map((r) => num(r[tk]));
      const missing = src.filter((r) => !tgtSigs.has(sig(r, k, a.identity))).map((r) => num(r[k]));
      for (let i = 0; i < gone.length; i += 500) {
        const part = gone.slice(i, i + 500);
        // children go with them (ON DELETE CASCADE / trigger)
        await this.target.run(`DELETE FROM ${q(p.target)} WHERE ${q(tk)} IN (${part.map(() => "?").join(", ")})`, part);
      }
      if (gone.length) this.opts.logger.debug("final copy: removed rows deleted from the source", { table: p.name, rows: gone.length });
      for (let i = 0; i < missing.length; i += this.batch) {
        const part = missing.slice(i, i + this.batch);
        const rows = await this.source.all<Row>(
          `SELECT ${p.columns.map((c) => q(c.src)).join(", ")} FROM ${q(p.name)} WHERE ${q(k)} IN (${part.map(() => "?").join(", ")})`,
          part,
        );
        await this.insertWithChildren(p, rows);
      }
      await yieldToEventLoop();
      after = hi;
      if (src.length < chunk) return;
    }
  }

  /** postgres target: moves serial / identity sequences past the copied keys. */
  private async resetSequences(plans: TablePlan[]): Promise<void> {
    if (this.target.dialect !== "postgres") return; // sqlite's AUTOINCREMENT counter follows explicit inserts
    for (const p of plans.flatMap((x) => [x, ...x.children])) {
      const info = await tableInfo(this.target, p.target);
      for (const c of info.columns.filter((x) => x.sequence)) {
        await this.target.get(
          `SELECT setval(pg_get_serial_sequence(?, ?), COALESCE((SELECT MAX(${q(c.name)}) FROM ${q(p.target)}), 1), (SELECT MAX(${q(c.name)}) FROM ${q(p.target)}) IS NOT NULL) AS v`,
          [q(p.target), c.name],
        );
      }
    }
  }

  private rowCanon(p: TablePlan, r: Row, side: "src" | "tgt"): string {
    return p.columns.map((c) => canonical(r[side === "src" ? c.src : c.tgt], c.type)).join("\u0001");
  }

  /** sha256 over every row's canonical form, sorted (dialect-independent order). */
  private async checksum(db: Db, p: TablePlan, side: "src" | "tgt"): Promise<string> {
    const cols = p.columns.map((c) => q(side === "src" ? c.src : c.tgt)).join(", ");
    const rows = await db.all<Row>(`SELECT ${cols} FROM ${q(side === "src" ? p.name : p.target)}`);
    const lines = rows.map((r) => this.rowCanon(p, r, side)).sort();
    const h = createHash("sha256");
    for (const l of lines) h.update(l).update("\u0002");
    return h.digest("hex");
  }

  /** Compares the rows of a random sample of keys (primary key, or the parent key of a child table). */
  private async sampleCompare(p: TablePlan): Promise<{ ok: boolean; detail: string }> {
    const keySrc = p.childOf ? [p.childOf.column] : p.key;
    if (!keySrc.length) return { ok: true, detail: "row counts match (no key to sample by)" };
    const keyTgt = keySrc.map((k) => p.columns.find((c) => c.src === k)!.tgt);
    const keyTypes = keySrc.map((k) => p.columns.find((c) => c.src === k)!.type);
    const sample = await this.source.all<Row>(
      `SELECT * FROM (SELECT DISTINCT ${keySrc.map(q).join(", ")} FROM ${q(p.name)}) s ORDER BY RANDOM() LIMIT ${SAMPLE_ROWS}`,
    );
    const fetch = async (db: Db, side: "src" | "tgt") => {
      const keys = side === "src" ? keySrc : keyTgt;
      const out: string[] = [];
      for (let i = 0; i < sample.length; i += 50) {
        const part = sample.slice(i, i + 50);
        const cond = part.map(() => `(${keys.map((k) => `${q(k)} = ?`).join(" AND ")})`).join(" OR ");
        const params = part.flatMap((r) => keySrc.map((k, j) => convertValue(r[k], keyTypes[j])));
        const cols = p.columns.map((c) => q(side === "src" ? c.src : c.tgt)).join(", ");
        const rows = await db.all<Row>(`SELECT ${cols} FROM ${q(side === "src" ? p.name : p.target)} WHERE ${cond}`, params);
        out.push(...rows.map((r) => this.rowCanon(p, r, side)));
      }
      return out.sort();
    };
    const [a, b] = [await fetch(this.source, "src"), await fetch(this.target, "tgt")];
    const ok = a.length === b.length && a.every((x, i) => x === b[i]);
    return { ok, detail: ok ? `sample of ${sample.length} keys matches` : `sampled rows differ (${a.length} source vs ${b.length} target rows)` };
  }
}
