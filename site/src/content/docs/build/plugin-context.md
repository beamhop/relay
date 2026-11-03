---
title: Plugin context
description: Reference for the BeamhopPlugin object and the PluginContext passed to setup() — every member, with its type.
sidebar:
  order: 5
---

All types on this page come from `@beamhop/sdk` (`packages/sdk/src/plugin.ts` and the files it imports).

## `BeamhopPlugin`

```ts
interface BeamhopPlugin<S extends z.ZodType = z.ZodType> {
  name: string;
  version: string;
  description?: string;
  settings?: S;                 // zod schema, rendered as a form in the admin panel
  migrations?: Migration[];
  ui?: string;                  // path to a prebuilt ESM bundle for the admin panel
  setup(ctx: PluginContext<z.infer<S>>): void | Promise<void>;
  teardown?(): void | Promise<void>;
}
```

| Field | Notes |
| --- | --- |
| `name` | URL-safe: letters, digits, `.`, `_`, `-`, starting with a letter or digit. Used in routes, metrics owner names and the panel. |
| `version` | Any string. Shown in the panel; also busts the cache of the UI bundle URL. |
| `settings` | A zod (v4) schema. See [Settings](/relay/build/plugin-settings/). |
| `migrations` | See [Database migrations](/relay/build/plugin-migrations/). |
| `ui` | Absolute, or relative to the plugin package root. See [Admin UI extensions](/relay/build/plugin-admin-ui/). |
| `setup` | Runs when the plugin is enabled. Must finish within **30 s**, or the plugin is marked `error` and everything it registered is removed. |
| `teardown` | Runs on disable and at shutdown. Given **5 s**. |

If `setup()` throws, the plugin's status becomes `error`, the message is shown in the panel, and the server keeps
running.

## `PluginContext`

```ts
interface PluginContext<S> {
  name: string;
  logger: Logger;
  config: Readonly<BeamhopConfig>;
  db: Db;
  events: EventStore;
  users: UserStore;
  kv: KvStore;
  audit: AuditLog;
  bus: PluginBus;
  relay: RelayEngine;
  blossom?: BlossomService;
  metrics: MetricsService;
  runtimeSettings(): RuntimeSettings;
  settings: { get(): S; onChange(fn: (s: S) => void | Promise<void>): () => void };
  hooks: {
    onWrite(fn: WritePolicy, opts?: number | HookOptions): () => void;
    onQuery(fn: QueryHook, opts?: number | HookOptions): () => void;
    onVisibility(fn: VisibilityHook, opts?: number | HookOptions): () => void;
    onBlobUpload(fn: BlobUploadHook, opts?: number | HookOptions): () => void;
  };
  http: Hono;
  adminHttp: Hono;
  jobs: { every(name: string, intervalMs: number, fn: () => Promise<void> | void): () => void };
  on: EventBus["on"];
}
```

**Everything you register through `ctx` is removed automatically when the plugin is disabled**: hooks, routes, jobs,
bus listeners and settings listeners. Each registration also returns a function that removes it early.

### Registering behaviour

| Member | What it does | Page |
| --- | --- | --- |
| `hooks.onWrite` | Accept, reject, shadow or replace incoming events. | [Hooks](/relay/build/plugin-hooks/#write-hooks) |
| `hooks.onQuery` | Rewrite or reject `REQ` / `COUNT` / `NEG-OPEN` filters. | [Hooks](/relay/build/plugin-hooks/#query-hooks) |
| `hooks.onVisibility` | Hide individual events from readers. | [Hooks](/relay/build/plugin-hooks/#visibility-hooks) |
| `hooks.onBlobUpload` | Accept or reject Blossom uploads and mirrors. | [Hooks](/relay/build/plugin-hooks/#blob-upload-hooks) |
| `http` | Public [Hono](https://hono.dev) app at `/plugins/<name>/`. | [HTTP routes](/relay/build/plugin-routes/) |
| `adminHttp` | Hono app at `/admin/api/plugins/x/<name>/`, admins only. | [HTTP routes](/relay/build/plugin-routes/) |
| `jobs.every` | A periodic job. | [Jobs, events and metrics](/relay/build/plugin-jobs-metrics/) |
| `on` | Subscribe to bus events. | [Jobs, events and metrics](/relay/build/plugin-jobs-metrics/) |
| `metrics.counter` / `.gauge` | Custom metrics in `/metrics` and the dashboard. | [Jobs, events and metrics](/relay/build/plugin-jobs-metrics/#metrics) |
| `settings.get` / `.onChange` | This plugin's validated settings. | [Settings](/relay/build/plugin-settings/) |

### Services

These are the server's own services, not copies.

| Member | Type | Useful for |
| --- | --- | --- |
| `db` | `Db` | Async SQL with `?` placeholders on SQLite or PostgreSQL: `all`, `get`, `run`, `exec`, `tx`, `migrate`, plus `dialect`. |
| `events` | `EventStore` | `query(filters)`, `count(filters)`, `getById(id)`, `deleteByIds(ids)`, `stats()`, … |
| `users` | `UserStore` | `get(pubkey)` returns a `UserRecord` (status, role, allow/deny flags, `firstSeenAt`, `eventCount`, …); `upsert`, `list`. |
| `kv` | `KvStore` | Namespaced JSON key-value store: `get`, `set`, `setIfAbsent`, `delete`, `list`. |
| `audit` | `AuditLog` | `record({ actor, action, target, details, ip })` writes to the admin audit log. Use ``actor: `plugin:${ctx.name}` ``. |
| `relay` | `RelayEngine` | `publish(event, source)` through the full pipeline, `sign(template)` with the relay key, `pubkey`, `connections()`, `disconnect({ id \| pubkey \| ip })`, `nip11()`, `groups`. |
| `blossom` | `BlossomService \| undefined` | `list`, `get`, `setStatus`, `delete`, `usage`, `stats`, … Undefined when Blossom is disabled. |
| `metrics` | `MetricsService` | `snapshot()` of live stats, `series(...)`, plus `counter` / `gauge`. |
| `runtimeSettings()` | `RuntimeSettings` | The relay's current runtime settings (NIP-11 info, limits, access mode, …). |
| `config` | `Readonly<BeamhopConfig>` | The boot config with secrets removed (relay key, session secret, S3 credentials, VAPID private key, database password, OTel headers). |
| `logger` | `Logger` | `debug` / `info` / `warn` / `error(msg, data?)` and `child(scope)`. Scoped to `plugin:<name>`. |

### The plugin bus

`ctx.bus` is the event bus as a plugin sees it:

```ts
interface PluginBus {
  on: EventBus["on"];  // same as ctx.on; removed on disable
  emit(name: "alert", payload: { level: "info" | "warning" | "critical"; title: string; message: string; url?: string }): void;
}
```

Plugins may only emit `alert`, which shows up in the admin panel (and as a push notification for admins who
subscribed to alerts). Core events like `event.accepted` are emitted by core only; emitting any other name throws.

```ts
ctx.bus.emit("alert", { level: "warning", title: "Upstream feed down", message: "No data for 10 minutes" });
```

## Database conventions

The SDK's `Db` is the same abstraction every beamhop package uses:

- Always write `?` placeholders; the PostgreSQL adapter rewrites them.
- Store JSON as `TEXT`, booleans as `INTEGER` 0/1, timestamps as `INTEGER` unix seconds.
- Prefix your tables with `plugin_<name>_`.
- Never await non-database work inside `db.tx(...)`: on SQLite a transaction holds the single connection.

The SDK also exports `upsertRows(db, table, columns, keys, update, rows)` for chunked multi-row upserts and
`yieldToEventLoop()` for long batch jobs.
