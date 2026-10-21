# Operations

Short answers to "how do I keep it running". Everything here can also be done in the admin app.

## Health check

```bash
beamhop status           # health score and what needs attention
beamhop doctor           # DNS, certificate, ports, proxy headers, WebSockets, disk, clock, storage
beamhop doctor --fix     # apply the one-step fixes it found
```

Load balancers and uptime monitors: `GET /healthz` (200 = healthy). In containers,
`beamhop --healthcheck` does the same without a shell.

## Backups

- **Turn them on:** admin app → Settings → Backups, or `beamhop backups setup`. Pick a bucket
  (S3, R2, GCS, Spaces, MinIO) or a folder. Daily by default, 14 kept.
- **Now:** `beamhop backup now` · **List:** `beamhop backup list` ·
  **Restore:** stop the server, then `beamhop backup restore <file>`.
- **Continuous (seconds, not hours):** run Litestream next to Beamhop. Generate its config with
  `beamhop backups litestream-config`; Docker users: `docker compose --profile backup up -d`
  with [deploy/compose.yaml](../deploy/compose.yaml).
- **Moving servers:** `beamhop move export` on the old one, `beamhop move import` on the new one.

Media files are backed up with the database when they are on disk. If they live in a bucket
(`blobStorage`), use that bucket's own versioning.

## Updates

| Install | Update |
|---|---|
| Binary / systemd | `sudo beamhop update`, then `sudo systemctl restart beamhop` (`beamhop update --check` only looks) |
| Docker | `docker pull ghcr.io/beamhop/beamhop && docker compose up -d` (or pin a version tag) |
| Cloudflare | redeploy (`wrangler deploy`) |
| Admin app | Settings → Updates → one tap; it backs up, updates, checks health and rolls back by itself |

Database changes run automatically after a backup. Something wrong after an update?
`sudo beamhop rollback` and restart.

## Standby server and failover

For a second server that takes over within minutes when the first one dies (about a second of
data at risk), follow [deploy/ha/RUNBOOK.md](../deploy/ha/RUNBOOK.md). Cloudflare deployments
already have this built in.

## Logs and data

- systemd: `journalctl -u beamhop` · data in `/var/lib/beamhop` · settings `/etc/beamhop/beamhop.env` + the admin app
- Docker: `docker logs beamhop` · data in the `/data` volume
- Logs are JSON; IP addresses are never written in the clear.

## Safe mode

If a plugin or a settings change stops Beamhop from starting: `beamhop serve --safe` (or
`BEAMHOP_SAFE=1`) starts with plugins off and the last settings that worked.
