#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Point a DNS record at THIS server (any provider without floating IPs; here: Cloudflare DNS).
# Keep the record's TTL at 60 s or lower and the record "DNS only" (grey cloud) so WebSockets
# reach Beamhop directly.
#   CF_API_TOKEN   token with Zone.DNS:Edit
#   CF_ZONE_ID     zone id
#   CF_RECORD_ID   id of the A record (GET /zones/<zone>/dns_records?name=relay.example.com)
#   NEW_IP         optional; this server's public IPv4 (detected when empty)
set -eu
: "${CF_API_TOKEN:?set CF_API_TOKEN}" "${CF_ZONE_ID:?set CF_ZONE_ID}" "${CF_RECORD_ID:?set CF_RECORD_ID}"
NEW_IP="${NEW_IP:-$(curl -fsS https://api.ipify.org)}"
curl -fsS -X PATCH \
  -H "Authorization: Bearer $CF_API_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"content\": \"$NEW_IP\"}" \
  "https://api.cloudflare.com/client/v4/zones/$CF_ZONE_ID/dns_records/$CF_RECORD_ID" >/dev/null
echo "DNS record $CF_RECORD_ID now points at $NEW_IP"
