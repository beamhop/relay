# Standby server and failover — runbook

Two servers. The **primary** serves everyone and copies every database change to a bucket
within about a second (Litestream). The **standby** does nothing but watch the primary. If the
primary stops answering three checks in a row (~30 s), the standby restores the database
from the bucket, starts Beamhop, and moves the public IP (or DNS record) to itself.

Expected loss on failover: at most a few seconds of posts (target ≤ 1 minute).
Expected downtime: under 5 minutes (usually about one).

Cloudflare deployments do not need any of this.

## What you need

- Two servers with Beamhop installed (`curl -fsSL https://get.beamhop.dev | sudo sh -s -- --systemd --no-start`)
  or Docker, in different zones/datacenters.
- A bucket (S3, R2, Spaces, Hetzner Object Storage, GCS) and a key for it.
- A **floating IP** (Hetzner), **Reserved IP** (DigitalOcean), static IP (GCP), or a DNS record
  with TTL 60 s. Floating IPs are faster and keep certificates simple.
- Media files are not in the database: either point both servers at the same S3/R2 bucket for
  media (`blobStorage`), or accept that media uploaded since the last backup are missing after
  a failover.

## Set up (systemd)

On **both** servers:

```bash
sudo useradd --system --home /var/lib/beamhop --shell /usr/sbin/nologin beamhop
sudo install -D -m 0644 systemd/beamhop-ha.conf /etc/systemd/system/beamhop.service.d/ha.conf
sudo install -m 0644 systemd/beamhop-litestream.service /etc/systemd/system/
sudo install -m 0644 systemd/litestream.yml /etc/beamhop/litestream.yml
sudo install -m 0600 /dev/null /etc/beamhop/litestream.env      # add the LITESTREAM_* keys
echo BEAMHOP_MODULES__LIFECYCLE__LITESTREAM__ENABLED=true | sudo tee -a /etc/beamhop/beamhop.env
# install litestream itself: https://litestream.io/install/ (.deb for your CPU)
```

**Primary:** `sudo systemctl enable --now beamhop beamhop-litestream`

**Standby:** keep Beamhop stopped and start the watcher:

```bash
sudo systemctl disable --now beamhop
sudo install -D -m 0755 failover.sh /usr/local/lib/beamhop/failover.sh
sudo install -D -m 0755 hooks/hetzner-floating-ip.sh /usr/local/lib/beamhop/hooks/hetzner-floating-ip.sh
sudo install -m 0600 systemd/failover.env.example /etc/beamhop/failover.env   # edit it
sudo install -m 0644 systemd/beamhop-failover.service /etc/systemd/system/
sudo systemctl enable --now beamhop-failover
```

Docker instead? Use `compose.yaml` (same file on both; `--profile primary up -d` on the primary)
and set `MODE=compose` in `failover.env`.

## Check it works (do this once, and after changes)

1. Admin app → Health: the replication check is green (no "Standby server is falling behind" card).
2. On the standby: `sudo DRY_RUN=1 FAIL_THRESHOLD=1 HEALTH_CMD=false /usr/local/lib/beamhop/failover.sh`
   prints the steps it would take without doing them.
3. Practise for real in a quiet hour: stop Beamhop on the primary, watch
   `journalctl -u beamhop-failover -f` on the standby, then open the relay.

## When a failover happened

1. You get an alert (the old primary is down; the standby logs "promotion finished").
2. Open the relay and the admin app: it should just work. Run `beamhop doctor` on the new primary.
3. **Do not start the old primary as it was.** If it comes back with replication on, it would
   write a different history into the same bucket. Turn it off, or on it run
   `sudo systemctl disable --now beamhop beamhop-litestream`.
4. Make the old primary the new standby: wipe its database
   (`sudo mv /var/lib/beamhop/db /var/lib/beamhop/db.old`), install the watcher there pointing at
   the new primary, and on the new primary delete `/var/lib/beamhop-failover/promoted` only if
   you want it to watch again later.

## Switch back on purpose (planned)

Stop Beamhop on the primary (`systemctl stop beamhop`), wait 5 seconds so the last changes reach
the bucket, then let the standby take over (or run `failover.sh` with `FAIL_THRESHOLD=1`).

## If something goes wrong

| You see | Do this |
|---|---|
| "restore FAILED" | The standby cannot read the bucket: check `/etc/beamhop/failover.env` keys, then `sudo systemctl restart beamhop-failover`. |
| Standby healthy, but users still reach nothing | The IP/DNS hook failed: run it by hand (`sudo -E /usr/local/lib/beamhop/hooks/<hook>.sh` with the env file loaded) or move the IP in your provider's console. |
| Certificate warnings after a DNS switch | Wait a minute — Beamhop requests a certificate on first start. `beamhop doctor` shows progress. |
| Both servers ran at once | Keep the one with the newest posts, turn the other off, rebuild it as standby. |

More detail: `packages/lifecycle/docs/high-availability.md`.
