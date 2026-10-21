# Quickstart

Three steps: install, open the link, answer the wizard.

## 1. Install

Pick one.

**On your computer or a server (Linux, macOS)**

```bash
curl -fsSL https://get.beamhop.dev | sh
beamhop
```

**On a server, as a service that starts on boot, with HTTPS for your domain**
(point the domain's DNS at the server first):

```bash
curl -fsSL https://get.beamhop.dev | sudo sh -s -- --systemd --domain relay.example.com
journalctl -u beamhop -n 30        # shows the setup link
```

**With Docker**

```bash
docker run -d --name beamhop -p 3334:3334 -v beamhop:/data ghcr.io/beamhop/beamhop
docker logs beamhop                # shows the setup link
```

Behind your own reverse proxy (Caddy, nginx, Traefik), add
`-e BEAMHOP_NODE__TRUST_PROXY=true` and forward WebSockets.

**On Cloudflare** (no server at all): use the *Deploy to Cloudflare* button in the
[README](../README.md), or follow [deploy/cloudflare](../deploy/cloudflare/README.md).

**On a cloud platform**: Fly.io, Railway, Render, DigitalOcean, Hetzner and Google Cloud
templates are in [deploy/](../deploy). Each one is already set up for that platform's HTTPS.

## 2. Open the link

Beamhop prints something like:

```
  Admin:       http://203.0.113.7:3334/admin/
  Claim code:  7Q4K-PX2M   (one-time — enter it in the admin app to become owner)
```

Open the link on your phone or computer and sign in with Nostr (browser extension, signer app,
or a passkey). The claim code makes you the owner. Lost the output? Run `beamhop claim-code`.

## 3. Answer the wizard

1. **What kind of relay?** Public social, Private team, Community (web of trust) or Media host.
   This sets about fifty sensible defaults; you can change any of them later.
2. **Your domain.** Type it in. Beamhop checks DNS and gets an HTTPS certificate by itself
   when it can, or tells you exactly what your proxy needs.
3. **Done.** You get your relay address (`wss://…`), media address, a QR code and a page
   to share.

That's it. The home screen tells you if anything needs you; the checklist there walks you
through backups and alerts in the first week.

## If something is off

```bash
beamhop doctor          # checks DNS, certificate, ports, proxy, disk; offers fixes
```

More: [operations](operations.md) (backups, updates, failover).
