# Beamhop — build status

**Version:** `0.1.0` · **Date:** 2026-10-22 · **Branch:** `main`

Built by a coordinated swarm in waves (contracts first, then parallel agents in isolated git worktrees, merged and verified after every wave). Plan: [PLAN.md](PLAN.md). Conventions: [CLAUDE.md](CLAUDE.md). Gap sweep and what closed it: [GAPS.md](GAPS.md).

## Verified on `main`

| Check | Result |
|---|---|
| `bun run typecheck` | clean |
| `bunx biome check .` | clean |
| `bun test` (whole repo, real sockets) | 1,376 tests, 0 failing |
| Docs reference (settings, actions, plugin SDK) | generated, `--check` passes |
| SPDX headers (`bun run ci:spdx`) | 870 files checked |
| Conformance, in-process, all NIPs/BUDs | 58 / 58 |
| Conformance vs. compiled binary over real sockets | 57 passed, 1 skipped (mirror from a private address is refused by design) |
| Admin app (PWA) | svelte-check clean, 175 unit, 155 Playwright (phone + desktop), first load 183 KB gzip (budget 200) |
| Vanilla profile | no enterprise wording in chunks a vanilla admin downloads; wizard outline snapshot; no enterprise routes/actions/config in a default node |
| Top-20 admin tasks | 20 / 20 within 3 taps (phone + desktop), see [docs/top-tasks.md](docs/top-tasks.md) |
| Real browser vs. compiled binary | claim → wizard → Home → 16 screens (incl. insights, launch kit, updates & health, backups, alerts, logs, on-call), no page errors |
| Team client | svelte-check clean, build, 52 tests incl. no-payments guard |
| Cloudflare Worker | workerd suite (`bun run test:workerd`) 2 + 6; `wrangler --dry-run` bundles within budget (default 714 KiB gzip of 740, enterprise 846 KiB of 885) |
| Single binary (`darwin-arm64`, host) | builds; boots with 14 modules; signature checking on 9 worker threads |
| Load (shared 10-core laptop) | 10k connections / 5k events/s for 30 s: 4,982–4,985 ev/s accepted, OK p95 106–349 ms, 100 % delivered, 0 errors; see [docs/performance.md](docs/performance.md) |
| Bench regression gate (`bun run bench:gate`) | 13 / 13 thresholds |

## What exists

- **Relay**: NIPs 01, 02, 09, 11, 13, 17/59, 29, 40, 42, 45, 50, 56, 62, 65, 70, 77; indexed fan-out; signature checking on a worker pool; pipelined saves; batched policy writes; background WAL checkpoints; Durable Object hibernation.
- **Blossom**: BUD-01/02/03/04/05/06, dedupe, quotas, media variants, abuse hash scanning, quarantine release/confirm, hot/cold tiering with per-tier caps; right to vanish removes the person's files.
- **Storage**: SQLite (default), D1, Postgres via Drizzle; fs / S3 / R2 / GCS blobs.
- **Admin**: API generated from the action registry (REST, OpenAPI, CLI, palette, AI tools, NIP-86); Nostr / passkey / SSO login; RBAC; versioned config with diff + undo + time machine, written back to `beamhop.yaml`; two-person rule on sensitive actions.
- **Admin app (PWA)**: wizard, health home with "Why?" on every number, card and alert; insights (live ops + community analytics); launch kit; swipe moderation with AI suggestions; bulk actions; notes; people (second owner, tokens); media (tiers, quarantine, cleanup); alerts (snooze, mute, on-call, digest); log viewer; updates & health (one-tap update with rollback, doctor, resource advisor); backups and restore; write-a-plugin; enterprise screens loaded only when enabled; technical lens app-wide and per item.
- **Operations**: insights, smart alerts (push, NIP-17 DM, chat, email), digest, backups + Litestream HA, retention, legal holds, doctor, in-app and CLI update/rollback, move/clone, opt-in OpenTelemetry traces.
- **Extensibility**: sandboxed TS plugins (SDK reference generated), signed catalog, webhooks, AI-written plugins installed turned off.
- **Public**: landing page, self-service portal, status page.
- **Enterprise (opt-in, invisible otherwise)**: OIDC (Google/Entra/generic), SCIM, directory sync, managed keys + NIP-46 bunker, KMS/Vault, DM escrow with two-person approval, SIEM, eDiscovery, residency, encryption at rest, network controls incl. per-group outbound relays — on Bun and on Cloudflare.
- **Team client**: Flotilla fork with SSO, swipe actions with undo, per-group outbound relay policy; all Lightning/zap/wallet/payment surfaces removed.
- **Deploy**: install script + systemd, Docker, Fly/Railway/Render/DO/Hetzner, GCP Terraform, Cloudflare (`npm create beamhop -- --cf`), HA kit, air-gap bundle.
- **CI**: check, admin-app (incl. Playwright + vanilla check), team-client, cloudflare (workerd + bundle budgets), bench (load regression gate), DCO; [CONTRIBUTING.md](CONTRIBUTING.md).

## Not verified here (needs real infrastructure)

- Docker image build, Postgres/MinIO/Keycloak integration (Docker not installed).
- Real Google / Entra tenants, real KMS / Vault, real SIEM endpoints, real SMTP.
- Real Cloudflare deploy (local workerd and dry-run only); `npm create beamhop` needs `@beamhop/runtime-cf` published.
- Cross-compiled binaries other than darwin-arm64; ffmpeg transcoding.
- 10k / 5k sustained beyond 30 s on dedicated hardware; bench thresholds on GitHub runners (first CI run).
- Usability tests with real people ([protocol](docs/usability-tests.md)); external security audit of key custody.

## Known follow-ups

- Release signing key (minisign) not yet created; `RELEASE_PUBLIC_KEY` is a placeholder, so in-app and CLI updates refuse unsigned releases unless `--allow-unsigned` is set.
- `@welshman/*` still bundles unused zap code paths (no UI reaches them).
- mTLS when Bun terminates TLS itself; CRL/OCSP for device certs; device certificates are not available on Cloudflare.
- Per-group outbound relay policy is enforced by the team client only (no server-side forwarding exists to enforce).
- Profile names for people outside the admin team (no kind-0 lookup endpoint yet); log viewer polls instead of streaming.
- Optional SQLite writer thread (`BEAMHOP_SQLITE_WRITER_THREAD=1`) measured slower than inline; off by default.
