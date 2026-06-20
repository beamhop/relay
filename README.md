# Beamhop Relay v2

A Nostr relay written in TypeScript for Bun.

> Design decisions and the build plan live in [`docs/`](docs/): see
> [`docs/adr/`](docs/adr/README.md), [`docs/PLAN.md`](docs/PLAN.md), and
> [`docs/HUMAN-TODO.md`](docs/HUMAN-TODO.md).

By default the relay stores events in memory only. Run it with `--persistence` or `-p` to use SQLite persistence, or select the SQL-native Postgres backend for production.

```bash
bun install
bun run start
bun run start -- --port 7777 --persistence ./relay.sqlite
bun run start -- --storage postgres --postgres-url postgres://localhost/relay
```

## Storage backends

Choose the backend with `storage.backend` (`memory` | `sqlite` | `postgres`), the `--storage`
flag, or `RELAY_STORAGE_BACKEND`:

- `memory` (default): zero dependencies, in-process. The just-run-it standalone mode.
- `sqlite`: durable single-file persistence (`--persistence [path]`).
- `postgres`: SQL-native, the production backend (ADR-0002). Connection comes from
  `--postgres-url`, `RELAY_POSTGRES_URL` / `DATABASE_URL`, or `storage.postgres` in the config
  file. Postgres access uses Bun's native SQL client.

## Configuration

Config is read from YAML or JSON. A `relay.yaml`, `relay.config.yaml`, or `relay.json` file in
the working directory is auto-discovered; pass `--config <path>` to point elsewhere. Precedence
is **CLI flags > environment variables > config file > defaults**.

```yaml
port: 7777
storage:
  backend: postgres
  postgres:
    host: db.internal
    database: relay
disabledNips: ["50", "70"]
relay:
  name: Beamhop Relay
  description: Local development relay
```

## Running with Docker

```bash
# Standalone, in-memory, dependency-free:
docker compose up relay

# Production SQL-native path against a local Postgres:
docker compose --profile postgres up db relay-db   # relay on host port 7778
```

Both compose relays enable the admin panel at `/admin` (standalone `:7777`, postgres `:7778`).
The password defaults to `change-me`; override it with `RELAY_ADMIN_PASSWORD` (e.g. in a `.env`
file next to the compose file).

The Docker image is built as a standalone Bun executable in a multi-stage builder and runs from
a scratch runtime image. It does not include Bun, `node_modules`, or the TypeScript source.

## Dev shell

A Nix flake dev shell provides bun, node, postgresql, and docker-compose. With direnv:
`direnv allow`, then `bun install`. `bin/relay-pg <command>` runs a command (default `bun test`)
against an ephemeral local Postgres.

Enable the browser admin panel with `--web`/`-w` and a password. The password can be passed with `--password`, as the optional value to `--web`/`-w`, or through `RELAY_PASSWORD`; CLI flags override the environment variable.

```bash
bun run start -- --web --password "change-me"
RELAY_PASSWORD="change-me" bun run start -- --web
bun run start -- -w "change-me"
```

Plugins are enabled by default for every implemented NIP except the explicitly excluded NIPs: `13`, `15`, `26`, `64`, `72`, `BE`, and `EE`.

Disable plugins with CLI flags or a JSON config file:

```bash
bun run start -- --disable-nip 50 --disable-nip 70
bun run start -- --config relay.config.json
```

```json
{
  "port": 7777,
  "persistence": "./relay.sqlite",
  "admin": {
    "web": true
  },
  "disabledNips": ["50", "70"],
  "relay": {
    "name": "Beamhop Relay",
    "description": "Local development relay"
  }
}
```

## Relay Behavior

Implemented relay behavior includes:

- NIP-01 WebSocket protocol, event hashing/signature verification, filters, subscriptions, EOSE, replaceable/addressable/ephemeral event treatment.
- In-memory storage by default, SQLite when `--persistence`/`-p` is provided, and a SQL-native Postgres backend for production.
- NIP-09 deletion requests, including event/address tombstones.
- NIP-11 relay information document with relay-relevant `supported_nips`.
- NIP-40 expiration rejection and query suppression.
- NIP-42 AUTH challenges and signed auth event validation.
- NIP-45 COUNT responses with exact counts and HLL payloads for eligible filters.
- NIP-50 content/tag search filter support.
- NIP-59/NIP-17 gift-wrap read protection for `kind:1059`.
- NIP-62 request-to-vanish deletion cutoffs.
- NIP-67 EOSE completeness hints.
- NIP-70 protected event publishing rules.
- NIP-77 `NEG-*` support using valid protocol-v1 ID-list reconciliation frames.
- NIP-86 relay management JSON-RPC with NIP-98 authorization.
- Management kind allowlists apply to custom/unknown event kinds; event kinds declared by enabled NIP plugins remain publishable.

NIPs that define client behavior, event payload conventions, or event kinds without relay-side state changes are represented as plugins with declared event kinds and focused structural checks where the NIP requires relay enforcement.

## Useful Endpoints

- WebSocket relay: `/`
- NIP-11 metadata: `GET /` with `Accept: application/nostr+json`
- Plugin manifest: `GET /plugins`
- Health check: `GET /health`
- Browser admin panel: `GET /admin` when `--web`/`-w` is enabled
- NIP-86 management: `POST /` with `Content-Type: application/nostr+json+rpc` and NIP-98 `Authorization`

## Verification

```bash
bun run typecheck
bun test
bun run build:binary:mac      # host-native proof on macOS
bun run build:binary:linux    # linux/amd64 musl binary used by Docker/CI
```
