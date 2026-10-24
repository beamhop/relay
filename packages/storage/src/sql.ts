import type { Db, Dialect } from "@beamhop/sdk";

/** Lists larger than this are passed as a single JSON parameter instead of `?` placeholders. */
const MAX_INLINE_PARAMS = 200;

/**
 * Builds a parameterized `col IN (...)` condition. Large lists use a single JSON parameter
 * (sqlite `json_each`, postgres `json_array_elements_text`) to stay clear of variable limits.
 */
export function inList(
  dialect: Dialect,
  column: string,
  values: readonly (string | number)[],
  type: "text" | "int" = "text",
): { sql: string; params: unknown[] } {
  if (values.length === 0) return { sql: "1 = 0", params: [] };
  if (values.length <= MAX_INLINE_PARAMS) {
    return { sql: `${column} IN (${values.map(() => "?").join(", ")})`, params: [...values] };
  }
  const json = JSON.stringify(values);
  if (dialect === "sqlite") return { sql: `${column} IN (SELECT value FROM json_each(?))`, params: [json] };
  // `?::text::json`, not `?::json`: postgres.js JSON.stringifies json-typed params, which would turn the
  // already-serialized array into a JSON string scalar
  const elem = type === "int" ? "(json_array_elements_text(?::text::json))::bigint" : "json_array_elements_text(?::text::json)";
  return { sql: `${column} IN (SELECT ${elem})`, params: [json] };
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Escapes LIKE wildcards; use together with `ESCAPE '\'`. */
export const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** SQL for the larger of two values (`MAX(a,b)` in sqlite, `GREATEST(a,b)` in postgres). */
export const greatest = (dialect: Dialect, a: string, b: string) =>
  dialect === "sqlite" ? `MAX(${a}, ${b})` : `GREATEST(${a}, ${b})`;

export function parseJson<T>(text: unknown, fallback: T): T {
  if (typeof text !== "string" || text === "") return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export const toBool = (v: unknown) => v === 1 || v === true || v === "1" || v === "t";
export const toNum = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
export const toNumOrNull = (v: unknown) => (v === null || v === undefined ? null : Number(v));

/** True for unique-constraint violations on both sqlite and postgres. */
export function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | undefined;
  if (!e) return false;
  return e.code === "23505" || e.code === "SQLITE_CONSTRAINT_UNIQUE" || /UNIQUE constraint failed/i.test(e.message ?? "");
}

/** Multi-row INSERT helper; chunks rows to respect parameter limits. */
export async function insertRows(
  db: Db,
  head: string,
  columns: number,
  rows: unknown[][],
  tail = "",
  rowsPerChunk = 100,
): Promise<void> {
  const tuple = `(${Array.from({ length: columns }, () => "?").join(", ")})`;
  for (const part of chunk(rows, rowsPerChunk)) {
    await db.run(`${head} VALUES ${part.map(() => tuple).join(", ")}${tail ? ` ${tail}` : ""}`, part.flat());
  }
}
