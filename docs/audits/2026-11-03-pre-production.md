# Pre-production test report — 2026-11-03

A test and hardening pass over beamhop before the first production deployment. Fixes are listed in the
[changelog](../../CHANGELOG.md) under Unreleased; this report records what was tested, what held up, what is still
open, and the settings recommended for production.

## Scope

Six areas were tested in parallel, each on its own branch, against throwaway local instances only (no remote hosts),
then merged and re-tested together:

| Area | What was covered |
|---|---|
| NIP conformance | NIPs 1, 2, 4, 5, 9, 10, 11, 13, 17, 22, 28, 29, 40, 42, 44, 45, 50, 51, 56, 59, 62, 65, 70, 77, 86 against the current spec text; NIP-77 against a negentropy client written from the spec alone |
| Blossom | BUD-01/02/04/06/08/11/12 on the filesystem and S3 (MinIO) drivers: ranges, conditional GETs, concurrent and interrupted uploads, quotas, script safety, EXIF, thumbnails, mirror SSRF and hostile mirror origins |
| Admin | Every panel area and its API, role permissions, all sign-in methods (NIP-07, key, password, TOTP, passkeys, NIP-98), sessions, PWA, NIP-86 RPC |
| Security | Code review plus attack tests: authorization on all 75 admin routes per role and auth method, CSRF, sessions, XSS, SQL/FTS injection on both databases, proxy header spoofing, WebSocket abuse, Blossom traversal/SSRF/bombs, secrets in logs and responses, file permissions, dependency audit |
| Load and resilience | Throughput and latency at 1M events, fan-out, 10k connections, 30-min soaks, `kill -9` under write load, SIGTERM, Postgres outage, disk full |
| Deploy and ops | Every storage combination, Bun and Node builds, single binary, npm package contents, Dockerfile/compose review, probes, metrics, config validation, schema upgrades from earlier releases, backup/restore |

## Results after merging

| Suite | SQLite + fs | SQLite + S3 | Postgres + fs | Postgres + S3 |
|---|---|---|---|---|
| `bun test` (all packages and e2e, Postgres opt-in tests on) | 1993 pass, 0 fail | | | |
| `bun test ./e2e/relay` | 791 pass, 0 fail | 791 pass, 0 fail | 791 pass, 0 fail | 791 pass, 0 fail |
| Admin panel (Playwright, desktop + mobile) | 352 pass | | 352 pass | |

Not covered: the Docker image was reviewed but not built (no Docker on the test machine), and PostgreSQL 12
compatibility was checked by reading the SQL only (tests ran on PostgreSQL 17).

## Findings

The worst findings, all fixed:

- **Relay-wide stalls an outsider could trigger.** An SVG-sniffing regex backtracked exponentially on a ~300-byte
  upload (≈0.6 s of blocked event loop per request), and a pipelined burst of multi-filter COUNTs passed the read
  budget at arrival and then ran back to back for minutes.
- **A PostgreSQL restart crashed the relay** (an uncaught error from a transaction on a dead connection).
- **Privacy:** with EXIF stripping on, some malformed-but-decodable JPEG/PNG/WebP files were stored with GPS data.
- **NIP-62 replays** could delete a victim's gift wraps, including ones received after the request.
- **Blocked IPs** could still use every HTTP route (uploads, mirroring, invites, plugin routes).
- **The secrets database was world-readable** under the default umask.
- **SQLite queries that froze the relay at 1M events** (home feeds, COUNTs, common-word search, multi-tag filters).

Everything else found is in the changelog. What held up:

- Admin authorization: no gaps across 75 routes × every role × NIP-98 and cookie sessions; every CSRF variant refused;
  session fixation, cookie flags, NIP-98 checks, TOTP replay, passkey origin/rpId, login timing all sound.
- No SQL/FTS injection on SQLite or Postgres; no XSS path in the panel; no secrets in `/health`, NIP-11, metrics or
  error responses.
- Mirror SSRF, including DNS rebinding and redirects to private addresses, is blocked.
- `kill -9` during writes (about 15 runs over both databases): no acknowledged event lost, SQLite integrity checks pass.
- SIGTERM drains and exits in under 300 ms; the relay survives a full disk and recovers without a restart.
- 30-minute soaks on each database: no heap, file-descriptor or subscription leaks; 360k events, none refused.
- Schema upgrades from earlier releases preserve data on SQLite and PostgreSQL.

## Measured capacity

Indicative only: client and server shared one machine with other test runs.

| | SQLite | PostgreSQL |
|---|---|---|
| EVENT writes, `verifyWorkers` 0 | 3,100/s | 2,300/s |
| EVENT writes, `verifyWorkers` 4 | 7,000/s | 5,300/s |
| Live delivery, 5,000 subscribers | 282,000 events/s | |
| Concurrent connections | 10,000 at ≈10 KB each | |

## Recommended production settings

In addition to the checklist in [OPERATIONS.md](../OPERATIONS.md#production-checklist):

- `BEAMHOP_VERIFY_WORKERS=4` (about 2.3× write throughput).
- Plan for 10,000–20,000 connections per instance; raise the open-file limit and the listen backlog (`somaxconn`).
- Keep the default rate limits.
- PostgreSQL: each instance opens up to 20 connections, so the default `max_connections` of 100 fits about four
  instances; put pgbouncer in front beyond that.
- `BEAMHOP_TRUSTED_PROXIES` narrowed to the actual proxy address; the default trusts all private ranges.
- Alert on free disk space separately: `/health` stays 200 while the disk is full.

## Open issues

Known and not fixed in this pass:

- COUNT with a common-word search still takes ≈870 ms on SQLite at 1M events, and multi-filter COUNTs have no row cap
  (consider capping and answering `approximate`).
- `COUNT failed` errors are not yet throttled like REQ/write failures, so a database outage logs one line per COUNT.
- SQLite memory grew ≈1.4 MB/min during the soak while the JS heap stayed flat; worth a longer run in staging.
- Blossom: authenticated GET/HEAD/DELETE verify a signature for any `Authorization` header with no rate limit
  (≈0.3 ms each); BUD-11 delete tokens without a `server` tag can be replayed against another server; quota and block
  locks are per process, so they don't hold across several instances sharing one database.
- Blossom: large S3-proxied blobs are sent without `Content-Length` under Bun (HEAD reports it; a public bucket URL
  avoids it). `/media` (BUD-05) is not implemented.
- Any pubkey the relay knows can broadcast vanish requests, also on a whitelist relay.
- `bun audit`: 4 advisories (2 moderate, 2 low) in build-time dependencies under `vite-plugin-pwa`; none ship at
  runtime.
- Deliberately stricter than the specs: unknown filter keys get `invalid:`; an unauthenticated COUNT including kind 4
  is refused rather than filtered; NIP-29's minimum of 3 `previous` refs isn't enforced; NIP-86's optional role
  methods aren't implemented.

## Re-running

```bash
bun run build:ui && bun run build:plugins   # the plugin and panel tests need the built bundles
bun run typecheck && bun test
BEAMHOP_E2E_DB=postgres BEAMHOP_E2E_PG_URL=postgres://… BEAMHOP_E2E_BLOBS=s3 \
  BEAMHOP_E2E_S3_ENDPOINT=http://127.0.0.1:9000 BEAMHOP_E2E_S3_ACCESS_KEY_ID=… BEAMHOP_E2E_S3_SECRET_ACCESS_KEY=… \
  bun test ./e2e/relay
bun run test:e2e:admin                      # add BEAMHOP_E2E_DB=postgres … for the Postgres run
bun e2e/load/bench.ts --db sqlite,postgres  # see e2e/load/README.md for soak and resilience runs
```
