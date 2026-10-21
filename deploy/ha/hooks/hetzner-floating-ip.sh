#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Move a Hetzner Cloud Floating IP to THIS server (run by failover.sh on the standby).
#   HCLOUD_TOKEN       API token (read & write) — Hetzner Console → Security → API tokens
#   FLOATING_IP_ID     id of the Floating IP (hcloud floating-ip list)
#   SERVER_ID          id of this standby server (hcloud server list)
# The standby must already have the Floating IP configured on its interface (Hetzner docs:
# "Floating IP persistent configuration"), so traffic flows as soon as it is assigned.
set -eu
: "${HCLOUD_TOKEN:?set HCLOUD_TOKEN}" "${FLOATING_IP_ID:?set FLOATING_IP_ID}" "${SERVER_ID:?set SERVER_ID}"
curl -fsS -X POST \
  -H "Authorization: Bearer $HCLOUD_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"server\": $SERVER_ID}" \
  "https://api.hetzner.cloud/v1/floating_ips/$FLOATING_IP_ID/actions/assign" >/dev/null
echo "Floating IP $FLOATING_IP_ID now points at server $SERVER_ID"
