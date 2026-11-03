---
title: Database migrations
description: Create and evolve a plugin's own tables on SQLite and PostgreSQL with tracked, per-plugin migrations.
sidebar:
  order: 10
---

A plugin that needs its own tables declares `migrations`. beamhop applies them before `setup()` runs and remembers
which ones it has applied.

```ts
interface Migration {
  /** unique, sortable id within the namespace, e.g. "001_init" */
  id: string;
  /** SQL string (portable) or per-dialect SQL. Multiple statements allowed. */
  up: string | { sqlite: string; postgres: string };
}
```

## Example

From `plugins/hello`:

```ts
migrations: [
  {
    id: "001_init",
    up: "CREATE TABLE IF NOT EXISTS plugin_hello_rejections (id TEXT PRIMARY KEY, pubkey TEXT NOT NULL, at INTEGER NOT NULL, reason TEXT NOT NULL)",
  },
  {
    // postgres INTEGER is 32-bit (overflows in 2038); sqlite INTEGER is already 64-bit
    id: "002_bigint_at",
    up: { sqlite: "SELECT 1", postgres: "ALTER TABLE plugin_hello_rejections ALTER COLUMN at TYPE BIGINT" },
  },
],
```

The first migration is portable SQL. The second only matters on PostgreSQL, so it uses the per-dialect form with a
no-op for SQLite.

## When migrations run

- **On first enable.** Migrations run as `db.migrate("plugin:<name>", migrations)`, tracked per plugin in the
  `_migrations` table, so each id is applied once.
- **With `beamhop migrate`.** The CLI applies the migrations of *enabled* plugins only (enabled in the panel, or via
  `plugins.enabled` / `BEAMHOP_PLUGINS_ENABLED`) found in `plugins.dir` or `plugins.packages`. Auto-discovered npm
  plugins aren't loaded by the CLI.
- **Disabled plugins** get their migrations when they are first enabled. Installing a plugin never touches the
  database by itself.

If a migration fails, enabling fails: the plugin is marked `error` with the message, and the server keeps running.

## Rules of thumb

- **Never edit a migration that has shipped.** Add a new one with a later id.
- **Prefix table names with `plugin_<name>_`** so they can't collide with core tables (`core_*`, `admin_*`,
  `blossom_*`, `metrics_*`) or another plugin.
- **Write portable SQL** where you can. Placeholders are always `?`. Store JSON as `TEXT`, booleans as `INTEGER` 0/1,
  timestamps as unix seconds. Use `BIGINT` on PostgreSQL for anything that can exceed 2^31.
- **Bound tables that anonymous users can grow.** `hello` caps its rejection log at 1000 rows.

## Using your tables

Query them through `ctx.db`:

```ts
await ctx.db.run("INSERT INTO plugin_hello_rejections (id, pubkey, at, reason) VALUES (?, ?, ?, ?)", [id, pubkey, at, reason]);
const recent = await ctx.db.all<{ id: string; reason: string }>(
  "SELECT id, reason FROM plugin_hello_rejections ORDER BY at DESC LIMIT 20",
);
```

`ctx.db.dialect` is `"sqlite"` or `"postgres"` if you need to branch at runtime.

Disabling a plugin doesn't drop its tables, and there are no down-migrations. If a plugin should clean up after
itself, give it an admin route or document the `DROP TABLE` statements.
