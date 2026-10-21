# Gap sweep vs. PLAN.md — 2026-10-21

Four read-only audits (core, admin panel, ops/deploy/CI, enterprise + team client) compared the code on `main` with every section of [PLAN.md](PLAN.md). Findings below are verified against the code; audit claims that turned out to be wrong are listed at the end.

**Overall:** every plan section has an implementation. Remaining gaps are (a) admin-panel UI for features that exist only in the backend, (b) CI that does not enforce what the plan promises, (c) a few real correctness/privacy bugs, and (d) things that need real infrastructure.

## A. Real bugs (fix first)

| # | Gap | Plan | Evidence |
|---|---|---|---|
| A1 | **Right to vanish (NIP-62) leaves the person's media on the server** | §10, §1.7 | Relay deletes events; nothing in `blossom`/`media` reacts to vanish. |
| A2 | **Two-person rule silently skips bulk delete and IdP disconnect** | §12.9 | `enterprise-compliance/src/config.ts` gates `moderation.bulk-delete` and `enterprise.disconnect-idp`, which don't exist as actions. |
| A3 | **UI edits never reach `beamhop.yaml`** (GitOps write-back unwired) | §3.4 | `setFileWriter` has no caller in the runtime. |
| A4 | Read-only actions show raw JSON in simple view; raw pubkeys shown without names | §6.6 | `pwa/.../ActionSheet.svelte` `JSON.stringify(output)`; queue/media/recycle bin show hex. |

## B. Built in the backend, missing in the admin app

| # | Gap | Plan |
|---|---|---|
| B1 | Enterprise admin screens: group mapping table, people/offboarding, company keys, compliance (holds, eDiscovery, SIEM), approvals inbox, network controls (`/people/company`, approvals etc. have no screen) | §12 |
| B2 | "Why?" only on errors — not on rejected posts, alerts, numbers, blocks (`experience.why` unused) | §6.10 |
| B3 | On-call schedule, alert mute/snooze, digest settings and tips | §6.8, §6.9, §6.12 |
| B4 | AI moderation pre-labels not shown on swipe cards | §5.3, §6.5 |
| B5 | Community analytics screen; live-ops detail (rejects by reason, p50/p95, DB size); log viewer with filters | §8 |
| B6 | Launch kit screen (announcement draft, NIP-11 polish); local success metrics (minutes/week) | §7 |
| B7 | Bulk actions in People and Activity (only Media has them) | §6.13 |
| B8 | Quarantine release/confirm, storage tiers + cleanup status in Media | §5.3, §6.1 |
| B9 | Second owner, API token list/revoke, notes on posts and files, per-item technical lens, override markers on goals | §6.4, §6.7, §6.11, §6.12 |

## C. Plan items not built

| # | Gap | Plan |
|---|---|---|
| C1 | Signature verification worker pool (runs inline today — likely bottleneck at 5k ev/s) | §3.5 |
| C2 | Blossom BUD-03 (server list) | §4.2 |
| C3 | Hot/cold blob tiering and per-tier storage quotas | §4.2 |
| C4 | In-app one-tap update with auto-backup + rollback, in-app doctor, resource advisor (CLI-only today) | §14 |
| C5 | `npm create beamhop --cf` one-command Cloudflare setup | §14 |
| C6 | Team client: admin-style swipe gestures; per-group outbound relay allow | §13, §12.10 |
| C7 | Enterprise compliance + network modules on Cloudflare | §12 |
| C8 | Plugin SDK reference in generated docs; OTel traces | §16, §8 |

## D. Quality gates the plan promises but CI doesn't enforce

| # | Gap | Plan |
|---|---|---|
| D1 | Load/bench regression gate (10k conns / 5k ev/s) not in CI and not demonstrated end to end | §3.5, §15 |
| D2 | Admin app vitest + Playwright E2E, svelte-check, team-client build not in CI | §15 |
| D3 | Real Cloudflare (workerd) test suite not in CI | §15 |
| D4 | Vanilla-profile checks: no enterprise strings in admin bundle, bundle budget, wizard snapshot | §12.0.6 |
| D5 | "Every top task in ≤3 taps" test; usability tests with people | §6.6 |
| D6 | SPDX header missing on 62 admin-app source files; no DCO check / CONTRIBUTING | §17 |

## E. Needs real infrastructure (cannot be closed locally)

Docker image, Postgres/MinIO/GCS paths, real Google/Entra tenants, KMS/Vault, SIEM endpoints, SMTP, a live Cloudflare deploy, cross-compiled binaries, ffmpeg transcoding, the release signing key, and an external security audit of key custody.

## Audit claims that were wrong

- "Binary embeds no version" — fixed earlier; `beamhop --version` prints `0.1.0-alpha.0`.
- "No per-relay switch for landing/portal/status" — exists (`relays[].public.{landing,portal,status}`).
- "NIP-17 DM alert channel not confirmed" — exists in `alerts/src/notifiers.ts`.
- Items the auditors marked IN PROGRESS (nsec sign-in, plugins screen, palette icons, quota bars, company sign-in setup, toast fix) are now merged.
