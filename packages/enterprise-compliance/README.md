# @beamhop/enterprise-compliance

Two opt-in modules. Each one loads only when its key is present under `modules:`
in the config (isolation rule §12.0).

| Module | Config key | What it does |
|---|---|---|
| `enterprise-compliance` | `modules.enterprise-compliance` | Two-person approvals, SIEM export, legal hold and eDiscovery, retention by group, data residency checks, blob encryption at rest, usage reports |
| `enterprise-network` | `modules.enterprise-network` | IP/CIDR allowlists, mTLS device certificates, zero-trust proxies (Google IAP, Cloudflare Access, Entra App Proxy), private-only mode |

## Approvals (two-person rule, §12.9)
- These actions are gated by default: `escrow.decrypt-dm`, `keyvault.destroy-key`,
  `keyvault.rotate-kek`, `compliance.release-hold`, `moderation.bulk-delete`,
  `enterprise.disconnect-idp`, `backups.restore`. Every action marked `sensitive: true`
  is gated too (`approvals.gateAllSensitive`). Ids that are not registered on the node are ignored.
- Running a gated action without `_approvalId` creates a request. The call returns
  `{ status: 'approval-required', requestId }` and other admins get a notification and an
  attention card (swipe right to approve, left to deny).
- Running the action again with `_approvalId` executes it once. Rules:
  - the approver is not the requester;
  - the approver holds the action's permission;
  - API tokens cannot approve;
  - the input must be byte-for-byte the same as in the request;
  - only the requester can execute the approved request;
  - requests expire after `requestTtlMinutes` and approvals after `executeWithinMinutes`.
- Other modules get the service with `kernel.use('enterprise.approvals')`. It offers
  `request`, `approve`, `deny`, `status`, `isApproved`, `consume`, `list` and
  `check({ actionId, input, principalId, reason?, approvalId? })`. `check` returns
  `{ status: 'approved' | 'pending' | 'denied' | 'expired', requestId?, approvers? }`.

## SIEM export
Sinks: `syslog` (RFC 5424 over TLS/TCP with octet counting, or UDP; Bun only, loaded
lazily), `splunk` (HEC), `sentinel` (Logs Ingestion API, Entra client credentials),
`chronicle` (v2 `unstructuredlogentries:batchCreate`, service-account JWT) and `webhook`
(HMAC-SHA256 signature in `x-beamhop-signature`).

Sources:
- the admin audit log (`admin.audit`, hash-chained by admin-api);
- the compliance event log (`compliance.siem-outbox`), which this module hash-chains. It holds
  sign-ins, config changes, deletions, approvals, holds, exports, and any records other modules
  push through `kernel.use('compliance.siem').record({ stream: 'signing' | 'escrow', … })`.

Every record carries `chain { log, seq, prevHash, hash }`, so tampering is visible. Each sink
keeps its own cursor in the DocStore, so a restart resumes where it stopped (at-least-once
delivery). Other behavior:
- exponential backoff, up to 15 minutes;
- a bounded outbox (`maxOutbox`): the oldest event-log records are dropped and counted, but
  audit entries are never dropped.

`compliance.test-sink` sends a test record.

## Legal hold & eDiscovery
- Holds can target people (pubkeys or directory subjects), IdP groups, relays, a date
  range and kinds.
- The module registers into `lifecycle.holds`. Retention, vanish, crypto-shred, recycle purge
  and blob expiry check it before they delete anything.
- A store-level guard copies held events into `compliance.hold-archive` before a NIP-09
  deletion, NIP-62 vanish, `deleteByIds` (used by moderation) or `deleteMatching` removes them.
  Held blobs are pinned: an owner can be removed, but the stored file stays.
- `compliance.export` builds a signed archive:
  - `events/<relay>.ndjson`;
  - `blobs.ndjson`;
  - `manifest.json`, which lists the sha256 and size of every file;
  - `signature.json`, a BIP-340 signature by the node key, which is wrapped by `keyWrapper`
    when one is configured.

  Archive files and referenced blobs are pinned. Use `verifyArchive()` to check an archive offline.

## Retention by group
`retention.groups: [{ group, days }]` and `defaultDays`. If someone is in more than one
group, the longest period applies. The provider is exposed as `compliance.retention` and is
registered into `lifecycle.retentionProviders` if lifecycle offers it. Legal holds always
override retention.

## Data residency
Set `residency.relays.<id>.region` and `residency.databaseRegion`. The database adapter has
no region field, so `databaseRegion` is whatever the operator declares for D1 or Postgres.
These are compared with `blobStorage.region` (fs/memory blobs count as living with the
database) and `backups.target.region`. Region matching:
- `eu` matches `eu-*`, `europe-*`, and the R2 `weur`/`eeur` locations;
- `us` and `ap` are handled the same way.

Checks run at boot and on every config change. A mismatch makes the health check critical,
adds an attention card and writes an error to the log.

## Encryption at rest
- **Blobs:** set `encryption.blobs: true`, which needs `ports.keyWrapper` (local master key,
  KMS or Vault). Each blob gets its own AES-256-GCM data key, wrapped by the KEK, and is
  encrypted in 64 KiB chunks so range reads still work. Blobs stay addressed by the sha256 of
  the plaintext. Blobs stored before you turned this on stay readable. For your own wiring,
  use `EncryptedBlobStore` directly.
- **Database:** `bun:sqlite` has no SQLCipher. Use one of these instead:
  - an encrypted volume (LUKS/dm-crypt, or cloud disks with customer-managed keys) for the
    SQLite file and the Litestream replicas;
  - managed Postgres with storage encryption and CMEK, or TDE (e.g. EDB, Percona pg_tde);
  - D1, which Cloudflare encrypts at rest.

  Also keep backups in buckets with SSE-KMS.

## Usage reports
`compliance.usage-report` builds a CSV and a PDF per IdP group for one month: people, posts,
stored bytes and uploaded bytes. Node ingress comes from insights. Both files are stored in the
blob store (pinned) and indexed in `compliance.reports`. A scheduled job creates last month's
report automatically.

## Network controls (`enterprise-network`)
The module registers a core `RequestGate`. Runtimes call gates before every HTTP request and
WebSocket upgrade. They pass the raw client IP to gates only, only when at least one gate
exists, and never log or store it.
- **Allowlists:** `allowlist.admin` applies to `/api/` and `/admin`;
  `allowlist.relays.<id>` applies to everything else. IPv4 and IPv6 are supported, and IPv4
  addresses mapped into IPv6 (`::ffff:a.b.c.d`) match IPv4 ranges. A request without a known
  IP is denied when a list applies.
- **mTLS:** the proxy passes the certificate in one of these forms:
  - URL-encoded PEM (nginx `$ssl_client_escaped_cert`, ALB);
  - base64 DER;
  - Envoy XFCC.

  The module checks the certificate against `mtls.caPem`. The header is trusted only if
  `node.trustProxy` is on or the request carries `mtls.proxySecret`. If Bun terminates TLS
  itself, configure the CA in Bun's TLS settings instead (not wired yet).
- **Zero trust:** checks the `x-goog-iap-jwt-assertion` header (IAP) or
  `cf-access-jwt-assertion` (Cloudflare Access) against the provider's JWKS, or against an
  inline `jwks` for air-gapped installs. Entra App Proxy's user header is trusted only together
  with the proxy secret. `zeroTrust.admins` maps an email to an admin id. After that, the
  `zero-trust` auth provider signs the admin in on each request, or
  `POST /api/zero-trust/session` issues a normal admin session.
- **Private-only:**
  - the landing and status pages return 404;
  - NIP-11 is reduced to the name and limitations;
  - the portal stays available unless `keepPortal: false`.
