# beamhop

**beamhop** is an all-in-one, self-hostable [Nostr](https://github.com/nostr-protocol/nips) relay with a
[Blossom](https://github.com/hzrd149/blossom) media server, an installable PWA admin panel and a plugin system.
A single process serves everything on one port. It runs on **Bun** or **Node ≥ 22** and can also be built as a **single binary**.

```
ws://host/            → Nostr relay (NIP-01 + many NIPs)
http://host/          → landing page, NIP-11 (Accept: application/nostr+json), NIP-86 management RPC
http://host/<sha256>  → Blossom (BUD-01/02/04/06/08)
http://host/admin/    → admin panel (PWA)
http://host/plugins/… → plugin public routes
http://host/metrics   → Prometheus metrics
```

## Features

- **Relay**:
  - NIPs 1, 2, 4, 5, 9, 10, 11, 13, 17, 22, 28, 29, 40, 42, 44, 45, 50, 51, 56, 59, 62, 65, 70, 77 and 86.
  - Full-text search, NIP-42 auth, proof-of-work, NIP-29 groups, negentropy sync and expiration.
  - Rate limits, IP rules and allow/ban lists.
- **Blossom**:
  - Filesystem or S3-compatible storage.
  - Upload/mirror/media endpoints and range requests.
  - EXIF stripping, plus thumbnails when `sharp` is installed.
- **Admin panel** (`/admin/`):
  - An installable PWA with live dashboard, connections, users and roles, content moderation, reports, media, settings, plugins, audit log, push notifications and a metrics map.
  - Sign in with NIP-07, a password, TOTP or passkeys.
- **Storage**: SQLite (`bun:sqlite` or `better-sqlite3`) or PostgreSQL.
- **Observability**: built-in metrics with rollups, a Prometheus endpoint, OTLP export and GeoIP.
- **Plugins**:
  - Write, query, visibility and blob hooks; public and admin HTTP routes; jobs; metrics; zod-validated settings; DB migrations; admin UI extensions.
  - Plugins can be enabled and disabled at runtime from the panel, without a restart.

## Quickstart

### Bun (from source)

```sh
bun install
bun run build:ui                # builds the admin panel (packages/admin-ui/dist)
BEAMHOP_OWNERS=npub1… bun run start
# dev mode with auto-reload:
bun run dev
```

Open <http://localhost:3334/admin/> and sign in with the owner key (NIP-07 extension).

### npx / Node

The `packages/server` node build is published to npm as **`beamhop`**. Its `bin` is `cli.js`, a single bundled ESM
file that ships with the admin UI. The native drivers `better-sqlite3`, `postgres` and the optional `sharp` are its only runtime dependencies.

```sh
npx beamhop init                 # writes ./beamhop.config.json
npx beamhop admin add npub1… --role owner
npx beamhop start
```

To build and publish it yourself:

```sh
bun run build:ui && bun run build:node    # → packages/server/dist/node/{cli.js,admin-ui/,package.json}
node packages/server/dist/node/cli.js start
cd packages/server/dist/node && npm publish
```

### Docker

```sh
docker compose up -d                         # SQLite + filesystem blobs in the beamhop-data volume
BEAMHOP_OWNERS=npub1… docker compose up -d
docker compose --profile postgres up -d      # + PostgreSQL   (set BEAMHOP_DB_DRIVER=postgres)
docker compose --profile s3 up -d            # + MinIO        (set BEAMHOP_BLOSSOM_DRIVER=s3)
docker compose --profile observability up -d # + OTel collector, Prometheus, Grafana
```

Or use plain Docker:

```sh
docker build -t beamhop .
docker run -p 3334:3334 -v beamhop-data:/data -e BEAMHOP_OWNERS=npub1… beamhop
```

- The image runs as a non-root user.
- Data lives in `/data`: `BEAMHOP_SQLITE_PATH=/data/beamhop.db` and `BEAMHOP_BLOSSOM_FS_PATH=/data/blobs`.
- The health check queries NIP-11.

To run CLI commands inside the container, use `docker compose exec beamhop bun packages/server/src/cli.ts admin add npub1…`.

### Single binary

```sh
bun run build:ui && bun run build:binary     # → packages/server/dist/beamhop (admin UI embedded)
./packages/server/dist/beamhop start
# cross-compile:
BEAMHOP_BINARY_TARGET=bun-linux-x64 bun run build:binary
```

The binary uses `bun:sqlite`. Thumbnails are disabled because `sharp` is not bundled, but EXIF stripping still works.

## CLI

```
beamhop [start]                         start the server (default)
beamhop init [--force]                  write beamhop.config.json with sensible defaults
beamhop admin add <npub|hex> [--role owner|admin|moderator|viewer]
beamhop admin remove <npub|hex>
beamhop admin password <npub|hex>       set a password login (reads stdin or prompts)
beamhop user ban <npub|hex> [--reason text]
beamhop user unban <npub|hex>
beamhop export [--filter '<json>'] > events.jsonl
beamhop import [--skip-verify] < events.jsonl
beamhop migrate
beamhop --version | --help
```

Global flags: `-c/--config`, `-p/--port`, `--host`, `--public-url`, `--db`, `--sqlite-path`, `--database-url`,
`--plugins-dir`, `--owner` (repeatable), `--log-level`, `--trust-proxy`, `--runtime bun|node`.

## Configuration

Configuration is merged in this order, where later sources win:

1. built-in defaults
2. `beamhop.config.json`, located via `--config`, then `BEAMHOP_CONFIG`, then `./beamhop.config.json`
3. `BEAMHOP_*` environment variables
4. CLI flags

Relative paths in the config file are resolved against the file's directory.
See [`beamhop.config.example.json`](beamhop.config.example.json) for an example.

Most relay behaviour is not set here. Limits, NIP-11 info, policies, auth, Blossom limits and similar are **runtime settings**: you edit them live in the admin panel (Settings) and they are stored in the database.

| Env var | JSON path | Default |
| --- | --- | --- |
| `BEAMHOP_PORT` / `PORT` | `server.port` | `3334` |
| `BEAMHOP_HOST` | `server.host` | `0.0.0.0` |
| `BEAMHOP_PUBLIC_URL` | `server.publicUrl` | `http://localhost:<port>` |
| `BEAMHOP_TRUST_PROXY` | `server.trustProxy` | `false`. When enabled, the client IP is read from `X-Forwarded-For`/`X-Real-IP` |
| `BEAMHOP_METRICS_TOKEN` | `server.metricsToken` | unset. When set, `/metrics` requires `Authorization: Bearer <token>` |
| `BEAMHOP_PROMETHEUS` | `server.prometheus` | `true`. Set `false` to disable `/metrics` |
| `BEAMHOP_DB_DRIVER` | `database.driver` | `sqlite` (or `postgres`) |
| `BEAMHOP_SQLITE_PATH` | `database.sqlitePath` | `./data/beamhop.db` |
| `BEAMHOP_DATABASE_URL` | `database.postgresUrl` | none |
| `BEAMHOP_RELAY_SECRET_KEY` | `relaySecretKey` | generated and stored in the DB. Accepts nsec or hex |
| `BEAMHOP_BLOSSOM_ENABLED` | `blossom.enabled` | `true` |
| `BEAMHOP_BLOSSOM_DRIVER` | `blossom.driver` | `fs` (or `s3`) |
| `BEAMHOP_BLOSSOM_FS_PATH` | `blossom.fsPath` | `./data/blobs` |
| `BEAMHOP_S3_ENDPOINT`, `_REGION`, `_BUCKET`, `_ACCESS_KEY_ID`, `_SECRET_ACCESS_KEY`, `_PUBLIC_URL` | `blossom.s3.*` | none |
| `BEAMHOP_OTEL_ENABLED` | `metrics.otel.enabled` | `false` |
| `BEAMHOP_OTEL_ENDPOINT` | `metrics.otel.endpoint` | `http://localhost:4318/v1/metrics` |
| `BEAMHOP_OTEL_HEADERS` (`k=v,k2=v2`) | `metrics.otel.headers` | none |
| `BEAMHOP_OTEL_INTERVAL_MS` | `metrics.otel.intervalMs` | `15000` |
| `BEAMHOP_GEOIP_DB` | `metrics.geoipDbPath` | none. Path to a GeoLite2/DB-IP city `.mmdb` file |
| `BEAMHOP_METRICS_RETENTION_DAYS` | `metrics.retentionDays` | `30` |
| `BEAMHOP_ADMIN_ENABLED` | `admin.enabled` | `true` |
| `BEAMHOP_OWNERS` (comma separated npub/hex) | `admin.owners` | none |
| `BEAMHOP_SESSION_SECRET` | `admin.sessionSecret` | generated and stored in the DB |
| `BEAMHOP_ADMIN_UI_DIR` | `admin.uiDir` | auto-detected (embedded, next to the bundle, or `packages/admin-ui/dist`) |
| `BEAMHOP_VAPID_PUBLIC_KEY`, `_PRIVATE_KEY`, `_SUBJECT` | `admin.vapid.*` | generated |
| `BEAMHOP_PLUGINS_DIR` | `plugins.dir` | `./plugins` |
| `BEAMHOP_PLUGINS` (comma separated) | `plugins.packages` | none. Extra npm packages to load |
| `BEAMHOP_PLUGINS_ENABLED` (comma separated) | `plugins.enabled` | none. Plugins enabled by default; the panel can override |
| `BEAMHOP_LOG_LEVEL` | `logLevel` | `info` |

## Admin bootstrap

Owners always have full access. You can make someone an owner in either of these ways:

- set `BEAMHOP_OWNERS=npub1…` (or `admin.owners` in the config), or
- run `beamhop admin add npub1… --role owner`, which is stored in the database.

Owners can then sign in at `/admin/` with a NIP-07 browser extension and invite other admins, moderators or viewers.
For servers without a browser signer, run `beamhop admin password npub1…` to enable password login.

## Plugins

Plugins come from three places:

- local folders in `plugins.dir`
- npm packages named `beamhop-plugin-*` or `@scope/beamhop-plugin-*`
- packages listed in `plugins.packages`

They are disabled by default. Enable them in **Admin → Plugins**, or with `plugins.enabled` / `BEAMHOP_PLUGINS_ENABLED`.
Two first-party plugins are included:

- [`plugins/hello`](plugins/hello): an example of every plugin capability, including an admin UI page.
- [`plugins/spam-filter`](plugins/spam-filter): heuristic spam scoring based on duplicate floods, link density, mention floods and new-account limits.

See **[plugins/README.md](plugins/README.md)** for the authoring guide.

## Development

```sh
bun install
bun run dev                 # server with --watch
bun run --filter @beamhop/admin-ui dev   # admin UI with Vite HMR
bun test                    # all tests
bun run test:server         # server/composition tests (incl. e2e over websocket)
bun run typecheck
```

The codebase is a Bun workspace monorepo. Contracts live in `packages/sdk`.

| Package | Purpose |
| --- | --- |
| `packages/server` | composition root, CLI, runtime adapters, plugin manager |
| `packages/core` | relay engine |
| `packages/blossom` | Blossom server |
| `packages/storage` | SQLite/Postgres stores and the settings service |
| `packages/metrics` | metrics |
| `packages/admin-api` | admin REST API and NIP-86 |
| `packages/admin-ui` | admin PWA |

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for details.

## License

[MIT](LICENSE) © 2026 beamhop contributors
