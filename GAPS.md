# Gap sweep vs. PLAN.md — 2026-10-21

Four read-only audits (core, admin panel, ops/deploy/CI, enterprise + team client) compared the code on `main` with every section of [PLAN.md](PLAN.md). The same day, sections A–D were worked through with parallel agents and merged into `main`; each merge was followed by the full gate (typecheck, Biome, `bun test`, docs `--check`, conformance self-check).

**Status:** sections **A, B, C and D are closed**. Items that are only partly closed are marked **partly** with the reason. Section E still needs real infrastructure.

## A. Real bugs — closed

| # | Gap | Fix (merge) |
|---|---|---|
| A1 | NIP-62 left the person's media on the server | Relay emits `user.vanished`; Blossom removes the person's files (bytes erased only when no other owner remains; files under legal hold stop being served but are kept); media removes variants. The portal and `portal.right-to-vanish` now use the same shared path (`relay.vanish` service), so they also honor holds, the `until` cut-off and gift wraps (`50e8f79`, `db99ed5`). |
| A2 | Two-person rule gated action ids that did not exist | `moderation.bulk-delete` (policy) and `enterprise.disconnect-idp` (identity) are now real actions with preview + undo; a test loads every shipped module and checks each gated id resolves to a registered, non-read-only action (`d548fc8`). |
| A3 | UI edits never reached `beamhop.yaml` | runtime-bun writes changes back atomically, keeping comments, order and `${ENV}` references; env/flag overrides are never baked in; read-only files give a plain warning card; `--no-config-writeback` turns it off (`39c471e`). |
| A4 | Raw JSON and unnamed hex in simple view | `OutputView` renders action output in plain rows (raw JSON only behind the technical lens); a names store shows people by name or short npub everywhere (`737c41e`). |

## B. Admin app for existing backend features — closed

| # | Gap | Fix |
|---|---|---|
| B1 | Enterprise screens | Lazy module chunks for Company groups (mapping, directory sync, people/offboarding, disconnect), Company keys, Compliance (holds, eDiscovery, SIEM, residency, usage report with CSV/PDF download), Approvals (swipe inbox), Network access (incl. deny lists and per-group outbound relays). All enterprise text lives only in those chunks (`5818539`, `8e6907c`). |
| B2 | "Why?" only on errors | `experience.why` now also explains alerts, every number (metrics) and blocks; `WhyButton` on refused posts, alerts, health ring, tiles, cards, insights numbers, blocked people, storage (`121ecf1`, `5409129`, `1f239ec`). |
| B3 | On-call, mute/snooze, digest, tips | One-tap snooze (1 h, "Longer…"), mute/unmute, on-call schedule screen, digest frequency + tip toggle, tip cards (`5409129`, `0bbe47f`). |
| B4 | AI pre-labels on swipe cards | Shown as "Suggested: …" when the AI module is on; never applied automatically (`5409129`). |
| B5 | Analytics, live-ops detail, log viewer | `/insights` (live ops: accept/refuse by reason, p50/p95, DB size, storage, error rate; community: active people, kinds, clients, retention, storage by user, countries); log viewer with filters over a redacted in-memory log ring (`logs.query`) (`121ecf1`, `5409129`). |
| B6 | Launch kit, local stats | `/launch` (announcement draft, relay-profile checklist, QR, test relay) and a "Your week" card from local-only stats (`121ecf1`). |
| B7 | Bulk actions in People and Activity | Multi-select (long-press / checkbox / shift-click) with one preview and one undo (`1f239ec`, `5409129`, `8e6907c`). |
| B8 | Quarantine release, storage tiers, cleanup status | Release (instant with undo) / confirm delete (adds hash to local block list), tier bars, cleanup status (`383b66c`). |
| B9 | Second owner, tokens, notes, per-item lens, overrides | Recovery checklist + add second owner; token list/revoke/create; notes on posts, people and files; `ItemLens` on rows/cards; "Changed by you" markers on goals (`1f239ec`, `383b66c`, `121ecf1`). |
| AI | "Write a plugin from a description" | Plugins screen writes, tests and installs plugins **turned off**; test results, code behind the lens, "Allow this access" for declared permissions (owner, preview, undo) (`cf03c55`, `07f5d43`). |
| — | Backups screen was declared but missing | "Backups and restore" screen (list, check, restore for owners, standby status) (`07f5d43`). |

Known limits (not gaps): names for people outside the admin team come from npub, since no kind-0 profile endpoint exists; the log viewer polls every 3 s (no SSE topic); revoking a plugin's permission leaves it in an error state until it is turned off.

## C. Plan items not built — closed

| # | Gap | Fix |
|---|---|---|
| C1 | Signature verification worker pool | `SignatureVerifier` port + Bun worker pool (batching, back-pressure, crash-safe, embedded in the binary), `node.verifyWorkers` / `--verify-workers`, `bench/verify.ts` (`2fb10b9`). |
| C2 | BUD-03 | Kind 10063 server lists used for `?as=` redirects; conformance check `bud03.server-list` (`383b66c`). **Partly:** not advertised in a server-info document because Blossom has no standard one. |
| C3 | Hot/cold tiering + per-tier quotas | `TieredBlobStore`, resumable tiering job (never moves held/quarantined files), per-tier caps with 80/95 % cards, `media.storage-tiers` / `media.run-tiering`; the resource advisor suggests turning it on (`383b66c`, `07f5d43`). **Partly:** a person's quota counts all tiers together (no per-user-per-tier quota, kept simple on purpose). |
| C4 | In-app update, doctor, advisor | `system.update` (backup → download → verify → swap → restart → health self-test → automatic rollback), `system.rollback`, `system.doctor`, `system.advisor`; "Updates & health" screen (`b93e8af`). On Cloudflare the screen explains that updates go through a redeploy. Unsigned releases are now refused (the release key is still a placeholder — section E). |
| C5 | `npm create beamhop --cf` | New `create-beamhop` package: wrangler login, D1/R2, `wrangler.toml`, migrations, secrets, deploy, claim code; idempotent, `--dry-run` (`6e51f1e`). Needs `@beamhop/runtime-cf` published to npm before it works for outside users. |
| C6 | Team client swipes; per-group outbound relays | Swipe rows with undo; outbound policy served at `/.well-known/beamhop/network` and followed by the client (`2d20d69`, `df53e65`). **Partly:** enforcement is client-side, because no Beamhop module forwards group events to other relays; NIP-29 has no group mute, so the swipe offers "Remove person". |
| C7 | Enterprise modules on Cloudflare | Compliance + network controls load on Workers (SIEM via D1 + cron, deny lists before the Durable Object, `CF-Connecting-IP` hashed); claim code created at first boot; workerd test suite `bun run test:workerd` (`df53e65`). Company-device certificates (mTLS) are unavailable on Cloudflare by design and say so. |
| C8 | Plugin SDK docs; OTel | `docs/reference/plugin-sdk.md` generated from the SDK; opt-in `@beamhop/otel` (OTLP/HTTP JSON over fetch, no PII, off by default) (`fc2404f`). |

## D. Quality gates — closed

| # | Gap | Fix |
|---|---|---|
| D1 | Load/bench regression gate | `scripts/bench/load.ts` (real server, 10k connections) and `scripts/bench/gate.ts` with `thresholds.json`, CI `bench` job (`efb2216`). Performance work (`328eded`): 10k connections / 5k events/s **met in 30-second runs** (4,982–4,985 ev/s accepted, OK p95 106–349 ms, 100 % delivered, 0 errors) on a shared 10-core laptop. **Partly:** 60-second runs reached 4.3–4.9k ev/s on this busy machine; a run on dedicated hardware is still needed. CI floors are derived, not measured on a GitHub runner yet. |
| D2 | Admin app + team client in CI | `admin-app` job (svelte-check, vitest, build, budget, Playwright) and `team-client` job (check, build, no-payments guard) (`f7dbb9e`). |
| D3 | workerd suite in CI | `cloudflare` job: `test:workerd` + `wrangler --dry-run` bundle budgets for default and `--enterprise` builds (`f7dbb9e`). |
| D4 | Vanilla-profile checks | `scripts/ci/vanilla-check.ts` (no enterprise wording in chunks a vanilla admin downloads; bundle budgets), wizard outline snapshot, `runtime-bun/test/vanilla.test.ts`. Leaks it found were fixed; the only allowed hits are the Organization-persona entry point (`f7dbb9e`, `1c576e9`). |
| D5 | ≤3 taps for top-20 tasks; usability tests | `packages/pwa/e2e/top-tasks.ts` counts real taps for 20 tasks on phone and desktop — **20 of 20 within budget** ([docs/top-tasks.md](docs/top-tasks.md)) (`efb2216`, `0bbe47f`). **Partly:** usability tests with real people need people; the protocol is in [docs/usability-tests.md](docs/usability-tests.md). |
| D6 | SPDX headers, DCO, CONTRIBUTING | Headers on all admin-app files, repo-wide `ci:spdx` check, `scripts/ci/dco-check.ts` + CI job, [CONTRIBUTING.md](CONTRIBUTING.md) (`737c41e`, `f7dbb9e`). |

Bugs found and fixed along the way: partial module sections in `beamhop.yaml` reached modules without defaults and stopped all posting (now parsed on every config path); connections over the pending-message limit got no `OK` (now `OK false rate-limited:`); Cloudflare store wrappers stacked across kernels (blobs encrypted twice).

## E. Needs real infrastructure (cannot be closed locally)

Docker image, Postgres/MinIO/GCS paths, real Google/Entra tenants, KMS/Vault, SIEM endpoints, SMTP, a live Cloudflare deploy (and publishing `@beamhop/runtime-cf` for `npm create beamhop`), cross-compiled binaries, ffmpeg transcoding, the release signing key, an external security audit of key custody, a load run on dedicated hardware, first CI run on GitHub runners (bench thresholds), and usability tests with real people.

## Audit claims that were wrong

- "Binary embeds no version" — fixed earlier; `beamhop --version` prints `0.1.0-alpha.0`.
- "No per-relay switch for landing/portal/status" — exists (`relays[].public.{landing,portal,status}`).
- "NIP-17 DM alert channel not confirmed" — exists in `alerts/src/notifiers.ts`.
- Items the auditors marked IN PROGRESS (nsec sign-in, plugins screen, palette icons, quota bars, company sign-in setup, toast fix) were merged before this sweep.
