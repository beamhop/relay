# ADR-0002 — Postgres backend is SQL-native, not a memory mirror

- **Status:** Accepted
- **Date:** 2026-06-20
- **Context source:** Grill session 2026-06-20

## Context

The existing `SqliteEventStore` (`src/storage/sqlite.ts`) is **memory-first**: it hydrates
every event into a `MemoryEventStore` at boot, serves all queries from RAM, and on every
write executes `DELETE FROM events; …re-insert every row` (`syncSnapshot`). SQLite is a
durable snapshot of the in-memory state, not a queryable backend.

That design has two fatal properties for production:

1. **It does not scale.** Every write is O(n) over the whole dataset, and the working set must
   fit in RAM.
2. **It cannot run multi-instance.** Two pods sharing one database would each `DELETE FROM
   events` and re-write their own RAM snapshot, clobbering each other. Memory-mirror is
   structurally incompatible with HA (ADR-0003).

The decision was whether the Postgres backend should copy this memory-mirror pattern (simple,
consistent), do SQL-native execution (queries/writes hit the DB directly), or a hybrid
(Postgres truth + in-RAM hot cache).

## Decision

The Postgres backend (`PostgresEventStore`) is **SQL-native**: Postgres is the single source
of truth. Reads run as indexed SQL queries; writes are incremental upserts. No full-dataset
RAM mirror, no snapshot dumps.

- NIP-01 filter queries map to indexed SQL (by `id`, `pubkey`, `kind`, `created_at`, tags).
- NIP-50 search uses Postgres full-text (`tsvector` / `pg_trgm`) rather than the SQLite FTS5
  path.
- Deletions / tombstones / vanish requests become real rows and SQL operations, not snapshot
  rewrites.

**Driver:** the `postgres` (porsager) npm package. Chosen over `Bun.sql` because it has
confirmed `LISTEN`/`NOTIFY` support, which ADR-0003 needs for the HA fan-out option. This is a
**production-only** dependency; the standalone path (`memory` / `bun:sqlite`) never imports it,
preserving the zero-dependency default (ADR-0001).

The existing `memory` and `sqlite` stores are left as-is.

## Consequences

- ✅ Durable, scales past RAM, and is a valid shared backend for multiple instances.
- ✅ Real indexes and SQL search instead of full-scan-in-RAM.
- ✅ Unblocks HA: pods can share one Postgres without clobbering each other.
- ⚠️ The single largest piece of new code in this effort; correctness of the SQL mapping for
  every supported NIP filter must be covered by tests, reusing the existing storage test suite.
- ⚠️ One added production dependency (the Postgres driver).
- ➡️ First production cutover uses this backend directly (no SQLite-on-PVC interim step).
