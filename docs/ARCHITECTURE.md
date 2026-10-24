# beamhop architecture

beamhop is a Nostr relay with a built-in Blossom media server, a PWA admin panel and a plugin system.
Bun is the primary runtime; everything must also run on Node ≥ 22 (via `bun build --target=node`).

## Packages (Bun workspaces, scope `@beamhop/*`)
| Package | Responsibility |
|---|---|
| `sdk` | **Contracts only** (+ tiny runtime: EventBus, HookRegistry, logger, zod config schemas). Everyone depends on it. |
| `storage` | `createStores(config) → Stores`: SQL `Db` abstraction (bun:sqlite / better-sqlite3 / postgres), EventStore (FTS for NIP-50), users, invites, ip rules, kv, audit, `createSettingsService`. |
| `core` | `createRelay(deps) → RelayEngine`: NIP-01 protocol, validation pipeline, subscriptions/fan-out, NIP-09/11/13/40/42/45/50/62/70/77/29/05/17-59, rate limits, moderation policies, retention jobs. |
| `blossom` | `createBlossom(deps) → BlossomService`: BUD-01/02/04/06/08/11/12, FS & S3 blob drivers, opt-in EXIF strip, thumbnails (sharp, optional), quotas, moderation status. |
| `metrics` | `createMetrics(deps) → MetricsService`: bus collectors, rollups in DB, live snapshot, GeoIP, OpenTelemetry export, process stats. |
| `admin-api` | `createAdminApi(deps) → AdminApi`: REST at `/admin/api` per `sdk/src/admin-contract.ts`, auth (NIP-98 / password / passkeys), RBAC, audit, SSE, web push, NIP-86. |
| `admin-ui` | React + shadcn/ui + TanStack Router/Query + MapLibre PWA. Built with Vite to `packages/admin-ui/dist`, served at `/admin`. |
| `server` | Composition root: config loading, runtime adapters (Bun.serve / node:http + ws), plugin manager, CLI, Docker, binary + node builds. |
| `plugins/*` | First-party/example plugins built with `@beamhop/sdk` `definePlugin`. |

## Request routing (server)
1. `GET /` with `Upgrade: websocket` → `relay.handleConnection`
2. `POST /` with `Content-Type: application/nostr+json+rpc` → `adminApi.nip86`
3. `relay.http` (NIP-11 on `GET /` with `Accept: application/nostr+json`, `/.well-known/nostr.json`)
4. `/admin/api/*` → admin-api; `/admin/*` → admin-ui static (SPA fallback to index.html)
5. `/plugins/<name>/*` → plugin public routes
6. blossom `app` (`/upload`, `/list/:pubkey`, `/mirror`, `/<sha256>[.ext]`)
7. `GET /` (browser) → simple landing page with relay info

## Event write pipeline (core)
parse → size limits → id/sig verify → created_at bounds → NIP-13 PoW → IP/pubkey ban & mute → access mode (public / whitelist / invite / auth-required, NIP-42) → NIP-70 protected → rate limit → **plugin write hooks** (`hooks.runWrite`) → built-in content policy (kind allow/block, word/regex filters) unless plugin said `accept` → special kinds (5 deletion, 62 vanish, 1984 report → bus, NIP-29 group kinds 9000-9020) → store (or ephemeral) → fan-out to matching subscriptions (respecting `hooks.isVisible` & NIP-42 gated kinds like 1059/4) → bus `event.accepted` / `event.rejected`.

## Conventions
- TypeScript, ESM, strict. Packages export `./src/index.ts` directly (no build step for libs).
- **Runtime-neutral code**: use Web APIs (`fetch`, `Request`, `crypto.subtle`, `TextEncoder`) and `node:*` modules. Bun-only APIs (`bun:sqlite`, `Bun.serve`) only behind `isBun` checks with dynamic `import()`.
- SQL: write portable SQL with `?` placeholders via `Db`; each package owns its tables via `db.migrate("<namespace>", migrations)`; table names prefixed by package (`blossom_*`, `metrics_*`, `admin_*`, `core_*`). JSON stored as TEXT, booleans as INTEGER, timestamps unix seconds.
- Cross-package communication: only through sdk interfaces, `EventBus` and `HookRegistry`. Never import another package's internals.
- Tests: `bun test` with files in `packages/<pkg>/test/*.test.ts`. Use SQLite `:memory:`.
- Typecheck: `npx tsc --noEmit -p tsconfig.json` (admin-ui has its own tsconfig).
