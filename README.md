# Beamhop

**A Nostr relay and Blossom media server in one program.**
Run it anywhere in about a minute, then manage it from your phone.
Open source (AGPL-3.0), private by default, no telemetry.

<!-- Screenshots: admin home (phone), setup wizard, moderation swipe. Add images under docs/img/. -->
<p align="center"><em>Screenshots coming soon.</em></p>

## Quickstart

```bash
curl -fsSL https://get.beamhop.dev | sh
beamhop
```

Open the link it prints, sign in with Nostr, pick what kind of relay you want. Done.
The whole walkthrough (Docker and Cloudflare too) is one page: **[docs/quickstart.md](docs/quickstart.md)**.

## Deploy with one click

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/beamhop/beamhop/tree/main/deploy/cloudflare)
[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new/template/beamhop)
[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/beamhop/beamhop)
[![Deploy to DigitalOcean](https://www.deploytodo.com/do-btn-blue.svg)](https://cloud.digitalocean.com/apps/new?repo=https://github.com/beamhop/beamhop/tree/main)

| Where | How |
|---|---|
| Any Linux or macOS machine | `curl -fsSL https://get.beamhop.dev \| sh` (add `--systemd --domain relay.example.com` for a server) |
| Docker | `docker run -p 3334:3334 -v beamhop:/data ghcr.io/beamhop/beamhop` · [compose](deploy/compose.yaml) |
| Fly.io | [`deploy/fly/fly.toml`](deploy/fly/fly.toml) |
| Railway · Render | [`deploy/railway`](deploy/railway/README.md) · [`deploy/render/render.yaml`](deploy/render/render.yaml) |
| DigitalOcean · Hetzner | [cloud-init](deploy/digitalocean/README.md) · [cloud-init](deploy/hetzner/cloud-init.yaml) |
| Google Cloud | [Terraform module](deploy/gcp/README.md) |
| Cloudflare (Workers) | [`deploy/cloudflare`](deploy/cloudflare/README.md) |
| Standby server + failover | [`deploy/ha`](deploy/ha/RUNBOOK.md) |
| No internet access | [docs/airgap.md](docs/airgap.md) |

## Learn more

- [Quickstart](docs/quickstart.md) — install, wizard, done
- [Operations](docs/operations.md) — backups, updates, health checks, failover
- [Reference](docs/reference/README.md) — every setting and admin action, generated from the code
- [PLAN.md](PLAN.md) — product and technical plan

Everything else is in the app: every setting has an ⓘ with a plain explanation.

## License

[AGPL-3.0-or-later](LICENSE). Contributions are accepted under the DCO (`git commit -s`).
