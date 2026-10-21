# Beamhop — build status

**Version:** `0.1.0-alpha.0` · **Date:** 2026-10-21 · **Branch:** `main`

Built by a coordinated swarm in waves (contracts first, then parallel agents in isolated git worktrees, merged and verified after every wave). Plan: [PLAN.md](PLAN.md). Conventions: [CLAUDE.md](CLAUDE.md).

## Verified on `main`

| Check | Result |
|---|---|
| `bun run typecheck` | clean |
| `bunx biome check .` | clean |
| `bun test` (whole repo, real sockets) | 1,076 tests, 0 failing |
| Conformance, in-process, all NIPs/BUDs | 57 / 57 |
| Conformance vs. compiled binary over real sockets | 56 / 56 (mirror-from-private-address skipped by design) |
| Admin PWA | build, svelte-check, 55 unit, 19 Playwright E2E (phone + desktop) |
| Team client | build, svelte-check, unit tests, no-payments guard |
| Single binary (`darwin-arm64`, host) | builds, boots with 12 modules, serves relay, Blossom, `/admin`, `/app`, landing, OpenAPI |
| Cloudflare Worker | `wrangler deploy --dry-run` bundles (3.3 MiB / 652 KiB gz) |
| Docs reference | generated from schema + action registry, `--check` passes |

## What exists

- **Relay**: NIPs 01, 02, 09, 11, 13, 17/59, 29, 40, 42, 45, 50, 56, 62, 65, 70, 77; indexed fan-out; Durable Object hibernation.
- **Blossom**: BUD-01/02/04/05/06, dedupe, quotas, media variants, abuse hash scanning.
- **Storage**: SQLite (default), D1, Postgres via Drizzle; fs / S3 / R2 / GCS blobs.
- **Admin**: API generated from the action registry (REST, OpenAPI, CLI, palette, AI tools, NIP-86); Nostr / passkey / SSO login; RBAC; versioned config with diff + undo + time machine.
- **Admin app (PWA)**: wizard, health home with swipe cards, swipe moderation, people, media, goal sliders, technical lens, AI assistant panel.
- **Operations**: insights, smart alerts (push, NIP-17 DM, chat, email), digest, backups + Litestream HA, retention, legal holds, doctor, one-tap update/rollback, move/clone.
- **Extensibility**: sandboxed TS plugins, signed catalog, webhooks.
- **Public**: landing page, self-service portal, status page.
- **Enterprise (opt-in, invisible otherwise)**: OIDC (Google/Entra/generic), SCIM, directory sync, managed keys + NIP-46 bunker, KMS/Vault, DM escrow with two-person approval, SIEM, eDiscovery, residency, encryption at rest, network controls.
- **Team client**: Flotilla fork with SSO; all Lightning/zap/wallet/payment surfaces removed.
- **Deploy**: install script + systemd, Docker, Fly/Railway/Render/DO/Hetzner, GCP Terraform, Cloudflare, HA kit, air-gap bundle.

## Not verified here (needs real infrastructure)

- Docker image build, Postgres/MinIO/Keycloak integration (Docker not installed).
- Real Google / Entra tenants, real KMS / Vault, real SIEM endpoints, real SMTP.
- Real Cloudflare deploy (local Miniflare/workerd and dry-run only).
- Cross-compiled binaries other than darwin-arm64; ffmpeg transcoding.
- Load target (10k conns / 5k ev/s): storage ingest ~13k ev/s and fan-out ~65k ev/s measured in isolation; full end-to-end target not yet demonstrated on real hardware.
- Usability tests with real people; external security audit of key custody.

## Known follow-ups

- Release signing key (minisign) not yet created; `RELEASE_PUBLIC_KEY` is a placeholder.
- `@welshman/*` still bundles unused zap code paths (no UI reaches them).
- mTLS when Bun terminates TLS itself; CRL/OCSP for device certs.
- CI does not yet build the team client (its bundle guard runs only when built).
