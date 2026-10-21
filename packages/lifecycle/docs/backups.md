# Backups, restore and retention

## Backups

`config.backups` (`enabled`, `schedule: hourly|daily|weekly`, `keep`, `target`)
drives a scheduled job (checked every `modules.lifecycle.backups.checkMinutes`).
Each run writes one gzip'd tar archive, stored content-addressed (key = sha256
of the archive, type `application/vnd.beamhop.backup+gzip`) in the backup target:
`backups.target` (S3 / R2 / GCS / folder via `@beamhop/blobs`), or
`<dataDir>/backups` on Bun when no bucket is set. On Cloudflare a bucket target is
required (the "Backups have nowhere to go" card asks for one).

| Store | Database part of the archive |
|---|---|
| SQLite on Bun | `db/beamhop.sqlite` — online snapshot via `VACUUM INTO` (consistent, WAL-safe) |
| D1 (Workers) | `db/<table>.ndjson` — logical dump of every table via SQL (`sqlite_master`), runs inside the Worker |
| Postgres | `db/<table>.ndjson` logical dump (used by restore) **plus** `db/pg_dump.sql` when `pg_dump` is on PATH (for manual `psql` restores; password passed via `PGPASSWORD`, not argv) |
| memory / no SQL | `ports/events/<relay>.ndjson` — events only (restore merges them back) |

Every archive also has `blobs/manifest.ndjson` (sha256 + owner + size + type per
ownership), `config/config.json` (current config revision) and `manifest.json`
(row counts, event counts per relay, applied migrations, sha256 of every file).
Derived tables (`tags`, FTS5) are never dumped; triggers rebuild them on restore.
Set `modules.lifecycle.backups.format: ndjson` to force the portable format
(e.g. to move from SQLite to Postgres). Archives contain secrets from the config
(bucket keys, SMTP URLs): protect the backup bucket accordingly.

`lifecycle.backups/last` (DocStore) = `{ at, ok, size, location, error?, lastOkAt }`
is what insights health reads. The newest `keep` archives are kept.

## Restore (`backups.restore`, sensitive)

1. Archive sha256 is checked against the catalog, then every file against
   `manifest.json`; any mismatch aborts.
2. Refused if the archive has migrations this version does not know.
3. Writes pause (`lifecycle.restore-guard` policy hook rejects events/uploads).
4. Every table present in both is replaced (one transaction on bun:sqlite;
   chunked batches on D1/Postgres — not atomic there).
5. Row counts and per-relay event counts are verified against the manifest.
6. The backup catalog is preserved; missing blob bytes are copied back from the
   backup target when present (`includeBlobBytes`).
7. The running config is not changed: the backup's settings are in the restored
   settings history and can be restored from the time machine.

## Retention

Applied by the `lifecycle.retention` job (hourly by default), in chunks of
`chunkSize` with a scan budget of `maxEventsPerRun` per relay; the sweep resumes
from a stored cursor (`lifecycle.retention/<relayId>`), and lag shows in the
`lifecycle.retention` health check. Precedence for one event:

1. a `relay.retention` rule naming its kind (several → the longest wins),
2. the author's tier `retentionDays`,
3. a relay-wide rule (no `kinds`),
4. goals-derived `defaultRetentionDays` (absent → keep forever).

Steps 2-4 only apply to regular kinds: profiles, follow lists, other
replaceable/addressable events and deletion requests (kinds 5, 62) stay unless a
rule names their kind. Blob ownerships get `expiresAt = uploadedAt + tier
retentionDays` on upload (blob GC in blossom removes them).

Storage caps (`modules.lifecycle.storageCaps.<relayId|*>`) remove the oldest
low-value kinds (reactions, reposts) down to `targetPercent` — automatically only
with `autoPrune: true`; otherwise a card suggests `lifecycle.prune-storage`.

## Legal holds

`kernel.use<LegalHolds>('lifecycle.holds')` → `isHeld(relayId, { pubkey?, eventId?,
createdAt?, kind?, sha256? })`, `register(provider)`. Retention, storage pruning and
blob expiry consult it before deleting (held blob ownerships get their expiry
pushed back). Other deletion paths (recycle-bin purge, NIP-62 vanish,
crypto-shred) must call it too. A throwing provider counts as "held".
