# High availability on VMs: Litestream active-passive

Beamhop on a single VM keeps everything in one SQLite file
(`<dataDir>/db/beamhop.sqlite`). [Litestream](https://litestream.io) streams every
change of that file to object storage within about a second, so a standby VM can
take over with almost no data loss. Target (PLAN §12.11): **RPO ≤ 1 minute,
RTO ≤ 5 minutes**. Cloudflare deployments inherit platform HA and do not need this.

## 1. Generate the Litestream config

```bash
beamhop backups litestream-config > /etc/litestream.yml      # CLI (generated from the action)
# or: Settings → Backups → "Standby server setup file" in the admin app
```

The file is built by `generateLitestreamConfig(config)` from
`modules.lifecycle.litestream.replica` (or `backups.target` when it is a bucket):

```yaml
modules:
  lifecycle:
    litestream:
      enabled: true                     # Beamhop watches replication lag
      metricsUrl: http://127.0.0.1:9090/metrics
      replica:
        driver: r2                      # s3 | r2 | gcs | fs
        bucket: relay-replica
        endpoint: https://<account-id>.r2.cloudflarestorage.com
```

Keys are written as `${LITESTREAM_ACCESS_KEY_ID}` / `${LITESTREAM_SECRET_ACCESS_KEY}`
references (Litestream expands environment variables); pass `inlineSecrets: true`
only if the file is protected. GCS without HMAC keys uses `type: gcs` and
`GOOGLE_APPLICATION_CREDENTIALS`.

## 2. Primary

Run Litestream next to Beamhop (systemd example):

```ini
[Service]
Environment=LITESTREAM_ACCESS_KEY_ID=… LITESTREAM_SECRET_ACCESS_KEY=…
ExecStart=/usr/bin/litestream replicate -config /etc/litestream.yml
```

With `litestream.enabled: true` Beamhop scrapes the metrics endpoint every 30 s.
The **lifecycle.litestream** health check reports: not running (critical),
behind ≥ `lagWarnSeconds` (warn, default 60 s) or ≥ `lagCriticalSeconds`
(critical, default 300 s), and a "Standby server is falling behind" card links to
the *Standby server and failover* playbook. Lag is derived from counters
(local WAL bytes advancing while replica bytes do not), because Litestream does
not export a "last replicated at" timestamp.

## 3. Standby

The standby has Beamhop installed with the same `beamhop.yaml` but is **not
running** Beamhop (SQLite has one writer). Keep it warm by restoring periodically
(e.g. hourly cron) to verify the replica:

```bash
litestream restore -config /etc/litestream.yml -o /tmp/verify.sqlite /var/lib/beamhop/db/beamhop.sqlite
```

## 4. Failover (health-checked switch)

1. A monitor (your load balancer, keepalived, Uptime Kuma, cloud health check)
   polls `https://<primary>/healthz` every 10 s; 3 failures → failover.
2. On the standby:
   ```bash
   litestream restore -config /etc/litestream.yml -if-replica-exists /var/lib/beamhop/db/beamhop.sqlite
   systemctl start beamhop litestream     # standby becomes the new primary and replicates
   ```
3. Move traffic: **floating IP** (Hetzner/DO/AWS EIP API call — seconds) or
   **DNS** (A/AAAA record with TTL ≤ 60 s). Floating IPs keep TLS certificates
   valid; with DNS, the standby obtains its own ACME certificate on first start
   (or copy `<dataDir>/tls`).
4. Never let the old primary start again with replication on — it would write a
   diverging history into the same replica path. Rebuild it as the new standby.

Media files are not in SQLite: use an S3/R2/GCS `blobStorage` shared by both VMs,
or enable `modules.lifecycle.backups.includeBlobBytes` so scheduled backups copy
them to the backup target.
