#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Move a GCP static external IP from the failed primary VM to THIS standby VM.
# Needs the gcloud CLI and a VM service account allowed to change instances
# (roles/compute.instanceAdmin.v1 on both VMs).
#   STATIC_IP       the reserved address, e.g. 203.0.113.10
#   PRIMARY_VM      name of the failed primary
#   STANDBY_VM      name of this VM
#   ZONE            zone of both VMs (use PRIMARY_ZONE / STANDBY_ZONE if they differ)
#   ACCESS_CONFIG   access config name (default "external-nat"; check yours with
#                   gcloud compute instances describe <vm> --format='value(networkInterfaces[0].accessConfigs[0].name)')
set -eu
: "${STATIC_IP:?set STATIC_IP}" "${PRIMARY_VM:?set PRIMARY_VM}" "${STANDBY_VM:?set STANDBY_VM}"
PRIMARY_ZONE="${PRIMARY_ZONE:-${ZONE:?set ZONE}}"
STANDBY_ZONE="${STANDBY_ZONE:-$ZONE}"
AC="${ACCESS_CONFIG:-external-nat}"
# Free the address (the primary may be unreachable; this is an API call, not SSH).
gcloud compute instances delete-access-config "$PRIMARY_VM" --zone "$PRIMARY_ZONE" \
  --access-config-name "$AC" --quiet || true
# Swap this VM's ephemeral address for the static one.
gcloud compute instances delete-access-config "$STANDBY_VM" --zone "$STANDBY_ZONE" \
  --access-config-name "$AC" --quiet || true
gcloud compute instances add-access-config "$STANDBY_VM" --zone "$STANDBY_ZONE" \
  --access-config-name "$AC" --address "$STATIC_IP"
echo "Static IP $STATIC_IP now points at $STANDBY_VM"
