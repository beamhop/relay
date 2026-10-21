#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Move a DigitalOcean Reserved IP to THIS Droplet (run by failover.sh on the standby).
#   DO_TOKEN      API token with write scope
#   RESERVED_IP   the Reserved IP, e.g. 203.0.113.10
#   DROPLET_ID    optional; read from the metadata service when empty
set -eu
: "${DO_TOKEN:?set DO_TOKEN}" "${RESERVED_IP:?set RESERVED_IP}"
DROPLET_ID="${DROPLET_ID:-$(curl -fsS http://169.254.169.254/metadata/v1/id)}"
curl -fsS -X POST \
  -H "Authorization: Bearer $DO_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"type\": \"assign\", \"droplet_id\": $DROPLET_ID}" \
  "https://api.digitalocean.com/v2/reserved_ips/$RESERVED_IP/actions" >/dev/null
echo "Reserved IP $RESERVED_IP now points at Droplet $DROPLET_ID"
