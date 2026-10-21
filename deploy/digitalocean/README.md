# Beamhop on DigitalOcean

| Option | Use when | File |
|---|---|---|
| **Droplet + cloud-init** (recommended) | You want the simple setup: one server, data on its disk, automatic certificates | `cloud-init.yaml` |
| **1-Click Marketplace image** | Same as above, picked from the Marketplace | `marketplace/` |
| **App Platform** | You prefer a managed platform; needs managed Postgres + Spaces | `app.yaml` |

## Droplet

Create a Droplet (Ubuntu 24.04, 1 GB RAM is enough to start), paste `cloud-init.yaml` into
**Advanced options → Add initialized data**, set `DOMAIN` at the top. After ~1 minute:
`ssh root@<ip> journalctl -u beamhop -n 30` shows the setup link and claim code.

For a standby server and failover with a Reserved IP see `deploy/ha/`.

## 1-Click Marketplace image (maintainer notes)

The image is built with Packer from a stock Ubuntu 24.04 snapshot:

1. `marketplace/install.sh` runs on the build Droplet: installs Beamhop with `--systemd --no-start`,
   enables the firewall, and adds the first-login message (`marketplace/99-beamhop-motd`).
2. Run DigitalOcean's `img_check.sh` (from `digitalocean/marketplace-partners`) and fix anything it
   reports, then clean up (`cleanup.sh` from the same repo) and snapshot.
3. On first boot the service starts on `:3334`; the message of the day tells the owner to run
   `beamhop-setup-domain relay.example.com`, which re-runs the installer with `--domain`.
4. Submit the snapshot in the Vendor Portal; listing text: "Nostr relay + media server with a
   phone-friendly admin app. Open the link from the welcome message to finish in 60 seconds."

## App Platform

`doctl apps create --spec deploy/digitalocean/app.yaml`, then set the two Spaces keys in the
dashboard. Data lives in the managed database, media in Spaces.
