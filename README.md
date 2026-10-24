# beamhop

**beamhop** is an all-in-one, self-hostable [Nostr](https://github.com/nostr-protocol/nips) relay with a
[Blossom](https://github.com/hzrd149/blossom) media server, an installable PWA admin panel and a plugin system.
A single process serves everything on one port. It runs on **Bun** or **Node ≥ 22** and can also be built as a **single binary**.

```
ws://host/            → Nostr relay (NIP-01 + many NIPs)
http://host/          → landing page, NIP-11 (Accept: application/nostr+json), NIP-86 management RPC
http://host/<sha256>  → Blossom (BUD-01/02/04/06/08/11/12)
http://host/admin/    → admin panel (PWA)
http://host/plugins/… → plugin public routes
http://host/metrics   → Prometheus metrics
http://host/health    → liveness probe (JSON; 503 if the database is unreachable)
```

## Features

- **Relay**:
  - NIPs 1, 4, 5, 9, 11, 13, 17, 29, 40, 42, 45, 50, 56, 59, 62, 70, 77 and 86 (advertised in NIP-11; 5, 29 and 86 only while NIP-05, groups and the admin API are enabled).
  - Client-side NIPs such as 2, 10, 22, 28, 44, 51 and 65 work through generic NIP-01 storage; per NIP-11 they are not advertised.
  - Full-text search, NIP-42 auth, proof-of-work, NIP-29 groups, negentropy sync and expiration.
  - Rate limits, IP rules and allow/ban lists.
- **Blossom**:
  - Filesystem or S3-compatible storage.
  - Upload/mirror/media endpoints and range requests.
  - Optional EXIF stripping (off by default, since it changes the blob hash; it also drops images appended after a JPEG's main image, such as MPF/MPO secondary images and gain maps), plus thumbnails when `sharp` is installed.
  - Per-user quotas: empty uses the relay default (where 0 means unlimited); a per-user quota of 0 means no uploads, and "unlimited" in the panel stores 2^53−1 bytes. Per-user quotas of 0 set before this change (which meant unlimited) are migrated to that value.
  - Blobs are never servable as script: JavaScript is served as `text/plain`, WebAssembly as opaque bytes, and script/worker/XSLT loads (`Sec-Fetch-Dest`) are refused.
- **Admin panel** (`/admin/`):
  - An installable PWA with live dashboard, connections, users and roles, content moderation, reports, media, settings, plugins, audit log, push notifications and a metrics map.
  - Sign in with NIP-07, a private key (nsec/hex, kept in the browser), a password, TOTP or passkeys.
  - Privacy: images and video from other hosts (avatars, banners, media in notes) and the world map's tiles are only loaded after you opt in, per browser (Account → Privacy). Media in reported content never loads on its own.
  - Scripting the admin API: NIP-98 callers need nothing extra; any other client (cookie sessions, password logins) must send `X-Requested-With: beamhop` (or the relay's `Origin`) and a JSON body on every POST/PUT/PATCH/DELETE, logins included.
- **Storage**: SQLite (`bun:sqlite` or `better-sqlite3`) or PostgreSQL 12 or newer (generated columns).
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
BEAMHOP_METRICS_TOKEN=… docker compose --profile observability up -d # + OTel collector, Prometheus, Grafana
```

Or use plain Docker:

```sh
docker build -t beamhop .
docker run -p 3334:3334 -v beamhop-data:/data -e BEAMHOP_OWNERS=npub1… beamhop
```

- The image runs as a non-root user.
- Data lives in `/data`: `BEAMHOP_SQLITE_PATH=/data/beamhop.db` and `BEAMHOP_BLOSSOM_FS_PATH=/data/blobs`.
- The health check calls `GET /health`, which checks the database and returns 503 if it is unreachable.

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
beamhop admin remove <npub|hex>         revoke the role; also ends their sessions and push devices and removes password, TOTP and passkeys
beamhop admin password <npub|hex>       set a password login (reads stdin or prompts); ends all of that admin's sessions
                    [--reset-2fa]      …and removes TOTP and passkeys (recovery for a lost or hijacked authenticator)
beamhop user ban <npub|hex> [--reason text]
beamhop user unban <npub|hex>
beamhop export [--filter '<json>'] > events.jsonl   (NIP-50 "search" filters are refused: results aren't in time order)
beamhop import [--skip-verify] < events.jsonl
beamhop migrate                         apply core, admin, blossom and enabled-plugin migrations (plugins.dir / plugins.packages only)
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

Relative paths, whether from the config file, `BEAMHOP_*` variables or CLI flags, are resolved against the config file's directory, or the working directory when no config file is used.
See [`beamhop.config.example.json`](beamhop.config.example.json) for an example.

Most relay behaviour is not set here. Limits, NIP-11 info, policies, auth, Blossom size/quota/MIME settings and similar are **runtime settings**: you edit them live in the admin panel (Settings) and they are stored in the database. Blossom upload abuse limits (`blossom.limits.*`) are boot-time config; see below.

| Env var | JSON path | Default |
| --- | --- | --- |
| `BEAMHOP_PORT` / `PORT` | `server.port` | `3334` |
| `BEAMHOP_HOST` | `server.host` | `0.0.0.0` |
| `BEAMHOP_PUBLIC_URL` | `server.publicUrl` | `http://localhost:<port>`. Set it to the address users reach: NIP-42 relay tags, NIP-98 / passkey logins and Blossom descriptor URLs are checked against or built from it |
| `BEAMHOP_TRUST_PROXY` | `server.trustProxy` | `false`. Enable only behind exactly one reverse proxy — and do enable it there: otherwise every client shares the proxy's address, so per-IP limits (connections, rate limits, Blossom's 4 concurrent uploads per IP) apply to all users at once. The client IP is then read from `server.proxyIpHeader`; non-IP values are ignored |
| `BEAMHOP_PROXY_IP_HEADER` | `server.proxyIpHeader` | `x-forwarded-for`: the *rightmost* entry, i.e. the hop your proxy appended (nginx `$proxy_add_x_forwarded_for`, Caddy, Traefik, HAProxy `option forwardfor`) — values the client sends itself are ignored. If your proxy instead *sets* a single-address header and passes the client's own `X-Forwarded-For` through (e.g. nginx with only `proxy_set_header X-Real-IP $remote_addr`), set this to that header (`x-real-ip`, `cf-connecting-ip`, …) or the client IP is spoofable. If a request carries no `X-Forwarded-For` at all, `X-Real-IP` is used instead |
| `BEAMHOP_TRUSTED_PROXIES` | `server.trustedProxies` | Comma-separated addresses / CIDR ranges of your reverse proxy. Only requests whose socket peer is in this list get their client IP from `server.proxyIpHeader`; anyone else (e.g. a client reaching the port directly) is identified by their own address, whatever headers they send. Default: loopback and private networks (`127.0.0.0/8`, `::1`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `100.64.0.0/10`, `fc00::/7`). Behind a CDN that connects to beamhop directly (e.g. Cloudflare without a local proxy), list the CDN's published ranges |
| `BEAMHOP_METRICS_TOKEN` | `server.metricsToken` | unset: `/metrics` is then only served to loopback clients (`127.0.0.0/8`, `::1`) that reach beamhop directly (no forwarding headers), and not at all when `server.trustProxy` is on (a proxy on the same host would make every client look local). Anything else, including Prometheus in the compose network (the `observability` profile needs this variable set), must send `Authorization: Bearer <token>`. A known placeholder such as `change-me` or the example file's `REPLACE-WITH-…` value disables `/metrics` (with an error in the log) |
| `BEAMHOP_MEMORY_LIMIT` | — | unset. Memory limit in bytes for the dashboard's memory gauge (otherwise the cgroup limit, then total RAM) |
| `BEAMHOP_PROMETHEUS` | `server.prometheus` | `true`. Set `false` to disable `/metrics` |
| `BEAMHOP_DB_DRIVER` | `database.driver` | `sqlite` (or `postgres`) |
| `BEAMHOP_SQLITE_PATH` | `database.sqlitePath` | `./data/beamhop.db` |
| `BEAMHOP_DATABASE_URL` | `database.postgresUrl` | none |
| `BEAMHOP_RELAY_SECRET_KEY` | `relaySecretKey` | generated and stored in the DB. Accepts nsec or hex |
| `BEAMHOP_BLOSSOM_ENABLED` | `blossom.enabled` | `true` |
| `BEAMHOP_BLOSSOM_DRIVER` | `blossom.driver` | `fs` (or `s3`) |
| `BEAMHOP_BLOSSOM_FS_PATH` | `blossom.fsPath` | `./data/blobs` |
| `BEAMHOP_BLOSSOM_MAX_UPLOADS_PER_IP`, `BEAMHOP_BLOSSOM_UPLOADS_PER_MINUTE_PER_IP`, `BEAMHOP_BLOSSOM_MAX_BUFFERED_UPLOAD_BYTES`, … | `blossom.limits.*` | Blossom upload/mirror abuse limits (4 concurrent bodies and 60 uploads/min per IP, 256 MiB buffered, …); see [packages/blossom/README.md](packages/blossom/README.md) for the full list |
| `BEAMHOP_S3_ENDPOINT`, `_REGION`, `_BUCKET`, `_ACCESS_KEY_ID`, `_SECRET_ACCESS_KEY`, `_PUBLIC_URL` | `blossom.s3.*` | none |
| `BEAMHOP_OTEL_ENABLED` | `metrics.otel.enabled` | `false` |
| `BEAMHOP_OTEL_ENDPOINT` | `metrics.otel.endpoint` | `http://localhost:4318/v1/metrics` |
| `BEAMHOP_OTEL_HEADERS` (`k=v,k2=v2`) | `metrics.otel.headers` | none |
| `BEAMHOP_OTEL_INTERVAL_MS` | `metrics.otel.intervalMs` | `15000` |
| `BEAMHOP_GEOIP_DB` | `metrics.geoipDbPath` | none. Path to a GeoLite2/DB-IP city `.mmdb` file |
| `BEAMHOP_METRICS_RETENTION_DAYS` | `metrics.retentionDays` | `30` |
| `BEAMHOP_ADMIN_ENABLED` | `admin.enabled` | `true` |
| `BEAMHOP_OWNERS` (comma separated npub/hex) | `admin.owners` | none |
| `BEAMHOP_ADMIN_UI_DIR` | `admin.uiDir` | auto-detected: embedded, next to the bundle, or (only when running from source) `packages/admin-ui/dist`. The working directory is never searched |
| `BEAMHOP_VAPID_PUBLIC_KEY`, `_PRIVATE_KEY`, `_SUBJECT` | `admin.vapid.*` | generated |
| `BEAMHOP_PLUGINS_DIR` | `plugins.dir` | `./plugins` |
| `BEAMHOP_PLUGINS` (comma separated) | `plugins.packages` | none. Extra npm packages to load |
| `BEAMHOP_PLUGINS_AUTO_DISCOVER` | `plugins.autoDiscoverNpm` | `false`. Also load every `beamhop-plugin-*` / `@scope/beamhop-plugin-*` package in `node_modules` |
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
- packages listed in `plugins.packages`
- with `plugins.autoDiscoverNpm` / `BEAMHOP_PLUGINS_AUTO_DISCOVER=true`, also every npm package named `beamhop-plugin-*` or `@scope/beamhop-plugin-*` in `node_modules`. This is off by default because any dependency with such a name would run inside the relay; prefer listing packages in `plugins.packages`

They are disabled by default: `setup()` only runs once enabled, but every discovered module is imported at boot, so only install plugins you trust. Enable them in **Admin → Plugins**, or with `plugins.enabled` / `BEAMHOP_PLUGINS_ENABLED`.
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
