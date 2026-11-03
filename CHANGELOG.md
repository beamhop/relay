# Changelog

All notable changes to beamhop are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Every change that affects users, operators, plugin authors or the API gets an entry under **Unreleased** in the same
commit, in one of: Added, Changed, Deprecated, Removed, Fixed, Security. Entries say what changed for the reader, not
how it was implemented. On release the Unreleased section becomes the version's section, with its date.

## [Unreleased]

Pre-production hardening. The full test report, open issues and recommended production settings are in
[docs/audits/2026-11-03-pre-production.md](docs/audits/2026-11-03-pre-production.md).

### Security

- Uploads: SVG detection no longer backtracks exponentially. A ~300-byte upload from any key allowed to upload could
  block the event loop for about 0.6 s per request.
- Reads: the query-time budget is checked again when a REQ/COUNT/NEG-OPEN actually starts running, not only when it
  arrives. A pipelined burst of multi-filter COUNTs could stall the relay for minutes and then lock other clients out
  of reads.
- NIP-62: a replayed request to vanish no longer deletes gift wraps received after the request; wrap deletion is
  bounded by the request's `created_at` and skipped when it was already applied.
- The SQLite database (relay key, VAPID key, TOTP secrets, password hashes) is now created in a `0700` directory and
  its files are made `0600` when opened, existing ones included. `beamhop init` writes its config `0600`.
- IP block rules now apply to every public HTTP route (Blossom upload/mirror/delete, invites, plugin routes) with 403,
  not only to WebSockets. The admin panel/API, NIP-86 and health probes stay reachable so a rule can be lifted.
- CSP on the invite page (only its own hashed script) and a sandboxing CSP on plugin public responses that don't set
  their own, since both share the admin panel's origin.
- An admin delete of a blocked or pending blob keeps it blocked/held, so its uploader can't re-upload it approved.
- Admin panel: the NIP-46 signer's auth URL is opened only if it is http(s), without an opener.
- Blossom: EXIF stripping fails closed. Files the stripper couldn't parse (junk between JPEG segments, stray markers,
  truncated PNG/WebP chunks) were stored with their GPS data, and EXIF between progressive JPEG scans was missed. If
  metadata survives a second pass the upload is refused with 415.

### Added

- Install: every push to `main` publishes the Node build to the `dist` branch, so `npx github:beamhop/relay#dist start`
  runs beamhop with only Node 22+. beamhop is not published to npm.
- Docs: a product page and documentation site at <https://beamhop.github.io/relay/> (source in `site/`), covering
  install and deploy, a configuration reference generated from the config schema, an admin app guide with
  screenshots, and plugins and API.
- Admin: list your own panel sessions and sign out any or all others (`GET /auth/sessions`,
  `DELETE /auth/sessions/:id`, `POST /auth/sessions/end-others`), with a Sessions card on the account page.
- `BEAMHOP_LOG_FORMAT=json` for one JSON object per log line.
- Blob storage is checked at startup; a wrong S3 secret, missing bucket, unreachable endpoint or unwritable blob dir is
  logged as `blob storage is not usable` instead of surfacing only as failed uploads.
- [docs/OPERATIONS.md](docs/OPERATIONS.md): production checklist, reverse proxy, probes, metrics, logs, file
  permissions, backups and restores, upgrades.
- Load, soak and resilience tools in `e2e/load/` (`bench.ts`, `soak.ts`, `resilience.ts`).
- The e2e relay suite runs on any storage combination: `BEAMHOP_E2E_DB=sqlite|postgres` (with `BEAMHOP_E2E_PG_URL`)
  and `BEAMHOP_E2E_BLOBS=fs|s3` (with `BEAMHOP_E2E_S3_*`); see `e2e/harness/backend.ts`.
- New e2e suites: NIP-01, NIP-09/42/56/62/70, NIP-29/86 and NIP-45/50/77 conformance (NIP-77 against an independent
  negentropy client); Blossom on both blob drivers; adversarial admin authorization, CSRF, sessions, SQL injection,
  headers and IP rules; passkey and NIP-07 sign-in; the PWA update flow; a per-role sweep of every panel page.

### Changed

- Admin: the event filter's quick-add chips no longer offer zaps (kind 9735).
- Clients whose send buffer stays congested for 30 s are disconnected.
- Repeated write/REQ failures (database down, disk full) are logged once per distinct error per 10 s, with a count of
  suppressed repeats, instead of once per request.
- NIP-50 search on SQLite ranks the newest 5,000 matches instead of all of them; narrower searches return the same
  results as before.
- Out-of-range runtime settings (negative or fractional sizes and quotas, zero retention interval, kinds outside
  0–65535, non-ws(s) NIP-05 relays) are refused with 400 naming the field, and flagged in the panel before saving.
- Pubkey settings (retention exemptions, NIP-11 `pubkey`) accept npubs and are stored as hex.
- IP rules are stored in one canonical spelling (lowercase, compressed IPv6); removal matches any spelling.
- Docker Compose: stop grace above the 10 s shutdown budget, an init process, dropped capabilities;
  `.dockerignore` also excludes `.npmrc`, key files, nsec backups and database dumps.
- The published `cli.js.map` no longer contains the build machine's paths.

### Fixed

- Admin: Live → Connections showed nonsense connection durations (such as "-20739833d"); the connection start time is
  in milliseconds and is now read as such.
- The landing page footer, CLI help and NIP-11 `software` field now point to the real repository,
  `github.com/beamhop/relay`.
- Plugins README: the `registerPage` example no longer passes an `icon` option the SDK doesn't accept.
- Storage: a PostgreSQL restart, failover or network cut during a transaction crashed the relay. Now `/health` turns
  503, writes are refused, and they resume when the database is back; no acknowledged event is lost.
- Storage: SQLite reads that stalled the relay on large databases (≈1M events) are bounded, e.g. a 300-author feed
  232 → 0.9 ms, `COUNT kinds:[1]` 908 → 9 ms, multi-hashtag filters 36 → 0.5 ms.
- NIP-01: event ids hashed over the exact NIP-01 serialization (control characters unescaped) are accepted.
- NIP-62: a deletion request naming a request to vanish no longer gets the vanish refused.
- NIP-70: a protected request to vanish not sent by its authenticated author takes effect but isn't stored or relayed.
- NIP-77: a later NEG-OPEN or NEG-CLOSE for the same id supersedes a NEG-OPEN still being prepared (it could win, or
  leave a session open).
- NIP-86: the NIP-98 `u` tag is checked against the actual request URL including its query string.
- Blossom: `If-Range` is honoured (a stale validator gets the whole blob) and `If-None-Match: *` matches.
- Blossom: a blob removed from the S3 bucket outside beamhop can be restored by re-uploading it.
- Blossom: `GET /list` answers 400 to a malformed `cursor`, `limit`, `since` or `until` (clients paginated in
  circles).
- Blossom: `HEAD /upload` refuses `X-Content-Length: 0`, like the upload itself.
- Blossom: `/media` and `/report` answer a CORS-enabled 404, so browser clients see "not supported" instead of a
  network error.
- Admin API: U+0000 in paths, queries, JSON bodies and NIP-86 params is refused with 400; on PostgreSQL it caused
  500s, including on unauthenticated passkey login routes.
- Admin panel: plugin widgets and actions are hidden from roles without `plugins.use` (they failed with 403).
- Retention exemptions entered as npubs exempted nobody.
