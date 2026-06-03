#!/usr/bin/env bash
#
# Obtain a Let's Encrypt certificate for the relay and serve wss:// directly
# from Bun (no Caddy/nginx in front). Run this ON the server that owns
# dev.beamhop.com's DNS A/AAAA record.
#
# Usage:
#   sudo DOMAIN=dev.beamhop.com EMAIL=you@example.com ./deploy/setup-tls.sh
#
# Requirements:
#   - certbot installed (apt: `sudo apt install certbot`; brew: `brew install certbot`)
#   - Port 80 reachable from the internet during issuance/renewal (standalone
#     challenge). The relay uses 7000, so this does not clash — but stop any
#     other web server bound to :80 for the brief issuance window.
#
# After this runs, start the relay with:
#   PORT=7000 \
#   RELAY_URL=wss://dev.beamhop.com \
#   TLS_CERT=/etc/letsencrypt/live/dev.beamhop.com/fullchain.pem \
#   TLS_KEY=/etc/letsencrypt/live/dev.beamhop.com/privkey.pem \
#   bun run index.ts
set -euo pipefail

DOMAIN="${DOMAIN:?set DOMAIN, e.g. dev.beamhop.com}"
EMAIL="${EMAIL:?set EMAIL for Let's Encrypt registration/expiry notices}"

if ! command -v certbot >/dev/null 2>&1; then
	echo "certbot not found. Install it (apt: 'sudo apt install certbot') and re-run." >&2
	exit 1
fi

# Issue (or renew if already present) via the standalone HTTP-01 challenge.
# certbot temporarily binds :80 itself for the challenge.
certbot certonly \
	--standalone \
	--non-interactive \
	--agree-tos \
	--email "$EMAIL" \
	--domain "$DOMAIN" \
	--keep-until-expiring

CERT_DIR="/etc/letsencrypt/live/${DOMAIN}"
echo
echo "Certificate ready in ${CERT_DIR}"
echo "Start the relay with:"
echo "  PORT=7000 RELAY_URL=wss://${DOMAIN} \\"
echo "    TLS_CERT=${CERT_DIR}/fullchain.pem \\"
echo "    TLS_KEY=${CERT_DIR}/privkey.pem \\"
echo "    bun run index.ts"
echo
echo "Renewal: certbot installs a renewal timer automatically. Bun does NOT"
echo "hot-reload certs, so add a deploy hook to restart the relay after renewal:"
echo "  echo 'systemctl restart nostr-relay' | sudo tee \\"
echo "    /etc/letsencrypt/renewal-hooks/deploy/restart-relay.sh"
echo "  sudo chmod +x /etc/letsencrypt/renewal-hooks/deploy/restart-relay.sh"
