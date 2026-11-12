# Database hot swap (SQLite ⇄ Postgres) from the admin panel

## Decisions (from the interview)

| Topic | Decision |
|---|---|
| Data | Copy everything into the target, verify, then cut over. The old DB stays untouched as a rollback point. |
| Client impact | Bulk copy runs while the relay is live; writes pause for a few seconds during the final delta + switch. Reads keep working. Writes during the pause get `OK false "error: database switch in progress, try again"` / HTTP 503 + `Retry-After`. |
| Postgres URL | Prefilled from `BEAMHOP_DATABASE_URL` / config when set, editable in the panel. The server tests the connection before anything else happens. |
| Persistence | `data/database.json` (mode 0600) overrides `config.database` at boot. Env vars still win; the panel warns and disables the swap if env pins the driver. |
| Non-empty target | Refused. The panel shows what's there; the admin must type a confirmation to drop it, then the swap continues. Never merges. |
| Instances | Single instance only. Swap is refused when another instance is detected on the current DB. Scaled deployments switch via config + restart (documented). |
| Old DB | Kept and frozen. The panel lists it as a rollback point with a "Delete old database" button (typed confirmation). Swapping back is a fresh full copy. |

Decided without asking (technical):
- Only the `owner` role can swap, and only after re-authenticating (password + TOTP/passkey, same as other sensitive actions). Every step is audit-logged in both DBs.
- Blossom blob bytes stay on their driver (fs/S3). Only metadata tables move.
- Every migration namespace gets copied: core, admin, blossom, metrics, nip29 and enabled plugins' tables. Tables whose owner isn't loaded block the swap with a clear message, so no data is silently dropped.

## Architecture

### 1. `SwappableDb` (packages/storage)
Today `createStores` builds one `Db`, and ~30 modules (core, admin-api, blossom, metrics, plugins) hold it or store objects built on it. Rather than re-wiring all of them, put an indirection layer in the one place they all get it from:

- `SwappableDb implements Db` wraps the current inner `Db`. `all/get/run/exec/tx/migrate` delegate to `current`.
- **Gate**: `pause()` stops new writes (and new `tx()`) from starting. Those calls wait up to N seconds, then reject with `DbSwitchingError`. `pause()` itself waits until in-flight transactions finish. Reads go through untouched until the moment of switching.
- `swap(next)` changes `current` atomically under the gate. The old inner Db stays open (read-only use) until it's released.
- **Dialect changes**: `dialect` is read at call time in a handful of places to pick SQL. Audit every `db.dialect` / `stores.db.dialect` read and make sure nothing caches a dialect-specific choice at construction. Known so far: `SqlEventStore` `fts` flag, the sqlite `PRAGMA optimize` interval, events-store prepared SQL. These get a `rebind()` hook (below).

### 2. Rebind hooks
Anything that caches DB-derived state registers `onDatabaseSwapped(cb)`. After the switch, while writes are still paused, the swap runs these hooks:
- `SqlEventStore`: recompute `fts` and dialect-specific SQL.
- `SqlUserStore`: `flush()` buffered activity **before** the final delta, then clear caches.
- Settings service: reload from `kv("settings","runtime")` (it should be identical, but reload anyway).
- Optimizer interval: start/stop depending on dialect.
- nip29 group state, blossom admission caches, login guard, admin sessions cache, metrics rollup cursors: re-read or invalidate.
- Plugins: an optional `onDatabaseSwapped` in the plugin API. A plugin without it keeps working through `SwappableDb`.

### 3. Copier (`packages/storage/src/transfer.ts`)
Reusable from the CLI too (`beamhop db copy --to postgres://…`), so it can be tested without the UI.

1. **Preflight**: connect to the target, check the version, check it's empty (any `_migrations` or known tables → "non-empty" result listing tables + row counts), check free disk space for SQLite targets, check the instance heartbeat (below).
2. **Schema**: run every namespace's migrations on the target (the same set `beamhop migrate` runs), so its schema is native to that dialect, not translated.
3. **Bulk copy (live)**: for each table, stream in keyed pages (by primary key) and batch-insert. Type conversion between dialects: booleans 0/1 ⇄ bool, BIGINT ⇄ number, BLOB ⇄ bytea, JSON text. FTS tables are not copied; they get rebuilt on the target (sqlite `events_fts` rebuild / postgres tsvector column populated by migration).
   - Record a **high-water mark** per table before copying it: max rowid / `created_at`+`id` for `events`, `event_tags`, `audit_log`, `metrics_*`.
4. **Pause writes**: `SwappableDb.pause()`. Flush buffered user activity.
5. **Delta**:
   - Append-mostly tables (events, event_tags, audit, metrics): copy rows past the watermark, then reconcile deletions by diffing primary-key sets (ids only, cheap even for millions of rows).
   - All other tables (users, kv, settings, sessions, invites, ip_rules, admin_*, blossom_*, core_group_*, plugin tables) are small: truncate on the target and recopy in full during the pause.
   - If the pause would exceed its budget (default 15 s), abort, resume writes on the old DB, and report "too many changes, try again in a quieter period". No partial cutover.
6. **Verify**: row counts per table match, and checksums match on sampled rows (+ every row of `kv` and `users`).
7. **Switch**: `swap(target)`, run rebind hooks, write `data/database.json` (atomic tmp + rename), resume writes.
8. **Freeze old DB**: write a `kv` marker `server/frozenAt` into the old DB, so booting it by mistake shows "this database was superseded on … by …". Close it.

Failure at any step before 7 → resume on the old DB and drop nothing. Failure during 7 (rebind hook throws) → swap back to the old DB (no writes have reached the new one yet) and report the error.

### 4. Single-instance detection
Each instance writes a heartbeat row `kv("server","instances/<id>")` every 30 s. Preflight refuses if another fresh heartbeat (< 90 s) exists. SQLite is single-instance by nature, so this only matters on Postgres.

### 5. Boot
`loadConfig` reads `data/database.json` after the config file and before env. Precedence: env > database.json > config file > defaults. If env pins `BEAMHOP_DATABASE_DRIVER` / `BEAMHOP_DATABASE_URL` and it disagrees with database.json, log a warning; env wins. The Postgres URL in database.json is stored in a 0600 file next to the SQLite DB. It isn't encrypted (the key would sit in the same place), and the docs say so.

### 6. Admin API (`packages/admin-api/src/routes/system.ts`)
- `GET /admin/api/database`: current driver, location (URL with the password redacted), size, row counts, env-pinned flag, other instances, frozen rollback DBs.
- `POST /admin/api/database/test`: `{driver, url|path}` → connectivity + emptiness report.
- `POST /admin/api/database/switch`: `{driver, url|path, wipeTarget?: "confirm phrase"}`, owner + re-auth. Starts a background job (one at a time) and returns its id.
- `GET /admin/api/database/switch/:id`: phase, per-table progress, ETA, errors (SSE or polling, matching existing admin patterns).
- `POST /admin/api/database/switch/:id/cancel`: only before the pause phase.
- `DELETE /admin/api/database/rollback/:id`: delete a frozen old DB (SQLite file / drop the Postgres schema), typed confirmation.

### 7. Admin UI (`packages/admin-ui`, System → Database)
Current-backend card → "Switch to Postgres/SQLite" wizard: target (URL prefilled from env, or SQLite path defaulting to `data/beamhop.db`) → Test → non-empty warning + typed wipe confirmation → re-auth → live progress (phases, per-table bars, pause timer) → done/failed summary. Rollback points list with delete. Swap disabled with an explanation when env-pinned or multi-instance.

### 8. Relay behavior during the pause
- `EVENT` → `OK false "error: database switch in progress, try again shortly"`.
- `REQ`/`COUNT` keep working against the old DB (it's consistent; writes are paused).
- Blossom uploads/deletes → 503 + `Retry-After: 5`. Downloads keep working.
- Admin writes → 503 with the same message. `/health` reports `switching` (still 200, so orchestrators don't kill the process).

## Testing
- Unit: `SwappableDb` gate (in-flight tx drains, waiting writes time out, reads unaffected), type conversion round-trips, delta + deletion reconciliation.
- Integration (storage tests already run Postgres): sqlite→pg→sqlite round trip on a seeded DB, then compare every table. That includes BOM content, unicode, large tags, FTS search results before and after.
- e2e: switch under load (the existing load-resilience harness): no acknowledged EVENT is lost, clients see only retryable rejections, the pause stays under budget.
- Failure injection: kill the target connection mid-copy, mid-delta, and in a rebind hook → still on the old DB, no data loss.
- Boot precedence: env vs database.json vs config.

## Delivery order
1. `SwappableDb` + rebind hooks, wired in `createStores`, with no behavior change (ships alone).
2. Copier + `beamhop db copy` CLI + tests.
3. Pause semantics in relay/blossom/admin + heartbeat.
4. Boot-time `database.json` precedence.
5. Admin API + UI wizard.
6. Docs (OPERATIONS.md, site deploy/postgres page) + CHANGELOG entry.

## Open risks
- Modules that captured `dialect` or prepared dialect-specific SQL at construction: step 1 must find all of them (grep + a test that swaps the dialect and runs every store's methods).
- Very large SQLite → Postgres bulk copies take a long time. Fine, since they run live; only the delta has to fit the pause budget.
- Plugins that keep their own connections or caches outside `Db` won't follow the swap. Document `onDatabaseSwapped`.
