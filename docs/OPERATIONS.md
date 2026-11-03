# Operating beamhop

Health checks, logs, backups, upgrades and a production checklist. Configuration itself is described in the
[README](../README.md#configuration).

## Production checklist

- [ ] **`BEAMHOP_PUBLIC_URL`** is the `https://` address users reach. NIP-42 AUTH, NIP-98 / passkey admin logins and
      Blossom descriptor URLs are checked against or built from it.
- [ ] **Owner**: `BEAMHOP_OWNERS=npub1…` (or `beamhop admin add npub1… --role owner`). Without an owner nobody can
      sign in to `/admin/`.
- [ ] **Reverse proxy** in front (TLS, WebSockets), and beamhop bound to loopback or a private network only
      (`BEAMHOP_HOST=127.0.0.1`, or a `127.0.0.1:3334:3334` port mapping in Docker).
- [ ] **`BEAMHOP_TRUST_PROXY=true`** behind that proxy, and **`BEAMHOP_TRUSTED_PROXIES`** narrowed to the proxy's
      address (`127.0.0.1/32,::1/128` for one on the same host). Without it every client shares the proxy's IP and
      one set of per-IP limits. Never enable it when clients can reach the port directly.
- [ ] **`BEAMHOP_METRICS_TOKEN`**: a long random value (`openssl rand -hex 32`) if anything but a local loopback
      client scrapes `/metrics`. With `trustProxy` on and no token, `/metrics` is not served at all.
- [ ] **Database**: SQLite on a local disk (not NFS), or PostgreSQL 12+ via `BEAMHOP_DB_DRIVER=postgres` and
      `BEAMHOP_DATABASE_URL`. Use a dedicated role that owns its database/schema.
- [ ] **Blobs**: a persistent `BEAMHOP_BLOSSOM_FS_PATH`, or S3 (`BEAMHOP_BLOSSOM_DRIVER=s3`, `BEAMHOP_S3_*`). The
      startup log says `blob storage is not usable` if credentials, bucket or permissions are wrong.
- [ ] **Backups** scheduled and a restore tried once (see below).
- [ ] **Stop grace period** above `BEAMHOP_SHUTDOWN_TIMEOUT_MS` (10 s): `--stop-timeout 30` in Docker,
      `TimeoutStopSec=30` in systemd.
- [ ] **Probes**: load balancer → `GET /health`, container/process supervisor → `GET /health/live`.
- [ ] **Logs**: `BEAMHOP_LOG_FORMAT=json` if they go to a log shipper.
- [ ] **Secrets** (`BEAMHOP_DATABASE_URL`, `BEAMHOP_S3_SECRET_ACCESS_KEY`, `BEAMHOP_METRICS_TOKEN`,
      `BEAMHOP_RELAY_SECRET_KEY`) come from the environment or a `0600` config file, not from the image or the repo.

## Reverse proxy

beamhop serves the relay (WebSocket and NIP-11 on `/`), Blossom (`/upload`, `/<sha256>`, …) and the admin panel
(`/admin/`) on one port. The proxy must pass WebSocket upgrades, keep long-lived connections open, and accept
uploads up to the Blossom size limit (100 MiB by default, a runtime setting).

nginx:

```nginx
server {
    listen 443 ssl http2;
    server_name relay.example.com;
    # ssl_certificate …

    client_max_body_size 100m;          # ≥ Blossom's maxUploadBytes
    proxy_request_buffering off;        # stream uploads; beamhop enforces its own limits

    location / {
        proxy_pass http://127.0.0.1:3334;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;   # map $http_upgrade $connection_upgrade { default upgrade; '' close; }
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 1h;
        proxy_send_timeout 1h;
    }
}
```

Caddy (`reverse_proxy` handles WebSockets and `X-Forwarded-For` itself):

```
relay.example.com {
    request_body { max_size 100MB }
    reverse_proxy 127.0.0.1:3334
}
```

With either: `BEAMHOP_TRUST_PROXY=true BEAMHOP_TRUSTED_PROXIES=127.0.0.1/32,::1/128 BEAMHOP_HOST=127.0.0.1`.

## Health checks

| Endpoint | 200 | 503 |
| --- | --- | --- |
| `GET /health/live` | the process answers (also while starting and shutting down) | never |
| `GET /health` | ready and the database answered within the check timeout | starting, draining, stopping, or the database is down / slow. The body says `{"ok":false,"error":"unavailable"}`; the cause is logged (`health check failed`), never returned |

Use `/health` for load balancers and orchestrator readiness, `/health/live` for restarts: restarting does not fix a
database outage, and must not cut a graceful shutdown short. Both are served even while the server refuses other
requests during shutdown. Blob storage (S3) is not part of `/health`, so an S3 hiccup does not take the relay out of
rotation; its state at startup is logged.

## Metrics

- `GET /metrics` (Prometheus text): with `BEAMHOP_METRICS_TOKEN` set, requires `Authorization: Bearer <token>`.
  Without it, only loopback clients connecting directly (no forwarding headers) get it, and nobody does when
  `trustProxy` is on. `BEAMHOP_PROMETHEUS=false` turns it off.
- OTLP/HTTP push: `BEAMHOP_OTEL_ENABLED=true BEAMHOP_OTEL_ENDPOINT=http://collector:4318/v1/metrics`
  (`BEAMHOP_OTEL_HEADERS=k=v,…` for auth). See `deploy/otel-collector.yaml` and `deploy/prometheus.yml`.

## Logs

Logs go to stdout (debug/info) and stderr (warn/error). `BEAMHOP_LOG_FORMAT=text` (default) prints
`<time> LEVEL [scope] message {fields}`; `json` prints one object per line:

```json
{"time":"2026-11-03T12:00:00.000Z","level":"warn","scope":"beamhop:server","msg":"health check failed","error":"…"}
```

Database URLs, S3 keys and the metrics token are not logged. Admin API errors are logged with their stack; clients
only get `{"error":"internal error"}`.

## Files and permissions

A new SQLite database is created `0600` in a `0700` directory: it holds the relay's secret key, admin password
hashes, 2FA secrets and sessions. `beamhop init` writes `beamhop.config.json` as `0600`. Existing files keep their
mode, so check older installs: `chmod 600 data/beamhop.db* && chmod 700 data`. Keep backups just as private.

The Docker image runs as `bun` (uid 1000) and only `/data` is writable.

## Backups

Back up the database first, then the blobs: a blob uploaded in between is only an unreferenced file, while the
other order can leave rows whose bytes are missing.

### SQLite

Never copy `beamhop.db` with `cp` while the server runs (WAL mode: recent writes live in `beamhop.db-wal`). Take an
online backup with the `sqlite3` CLI; both forms are safe under write load and give a consistent snapshot:

```sh
umask 077
sqlite3 data/beamhop.db "VACUUM INTO 'backups/beamhop-$(date +%F-%H%M).db'"   # compact copy, needs SQLite ≥ 3.27
# or
sqlite3 data/beamhop.db ".backup 'backups/beamhop-$(date +%F-%H%M).db'"
sqlite3 backups/beamhop-….db "PRAGMA integrity_check"                          # → ok
```

Restore: stop beamhop, replace `data/beamhop.db` with the backup, delete any `data/beamhop.db-wal` / `-shm` left next
to it, start.

### PostgreSQL

```sh
pg_dump -Fc -f beamhop-$(date +%F-%H%M).pgc "$BEAMHOP_DATABASE_URL"            # consistent snapshot, online
pg_restore --exit-on-error --clean --if-exists -d "$BEAMHOP_DATABASE_URL" beamhop-….pgc   # with beamhop stopped
```

Add `-n <schema>` to both when beamhop lives in its own schema (`?search_path=` in the URL).

### Blobs

- Filesystem: `rsync -a data/blobs/ backup-host:beamhop-blobs/` (content-addressed: files never change once
  written, so incremental copies are cheap). Files starting with `.` and ending in `.tmp` are writes in progress.
- S3: enable bucket versioning or replication on the provider side.

### Events only

`beamhop export > events.jsonl` / `beamhop import < events.jsonl` move events (not users, settings, admin state or
blobs) between relays or backends, e.g. from SQLite to PostgreSQL.

## Upgrades

Migrations run automatically at start (or explicitly with `beamhop migrate`), each in a transaction, and are
recorded in `_migrations`; a second start applies nothing. There are no down-migrations: **back up before
upgrading**, and roll back by restoring that backup together with the previous version.

Tested upgrade paths: databases created by 61de29f, 75dc6b7 and 275754b (SQLite and PostgreSQL) upgraded to the
current release with all events, replaceable/addressable state, deletions, full-text search, bans, blocked IPs,
NIP-11 settings and blobs intact.
