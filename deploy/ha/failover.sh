#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Beamhop standby watcher (active-passive HA). Runs on the STANDBY server.
#
# Polls the primary's /healthz. After FAIL_THRESHOLD failed checks in a row it promotes this
# server: restores the database from the Litestream replica, starts Beamhop (+ Litestream, so
# this server now replicates), runs the traffic-switch hooks (floating IP / DNS), and stops.
# It never promotes twice: a marker file is written; delete it after rebuilding a new standby.
#
# Settings (environment, e.g. /etc/beamhop/failover.env):
#   PRIMARY_URL       https://relay.example.com/healthz — use the primary's own address, not the
#                     floating IP / DNS name that moves during failover
#   CHECK_INTERVAL    seconds between checks (10)
#   FAIL_THRESHOLD    failed checks in a row before failover (3)  → RTO ≈ 30 s + restore time
#   MODE              systemd | compose (systemd)
#   COMPOSE_FILE      compose file for MODE=compose (/opt/beamhop/deploy/ha/compose.yaml)
#   LITESTREAM_CONFIG /etc/litestream.yml          (MODE=systemd)
#   DB_PATH           /var/lib/beamhop/db/beamhop.sqlite (MODE=systemd)
#   RUN_AS_USER       owner of restored files (beamhop)
#   LOCAL_URL         health URL of this server once promoted (http://127.0.0.1:3334/healthz)
#   PROMOTE_HOOK      space-separated scripts run after promotion (see hooks/)
#   STATE_DIR         where the "promoted" marker lives (/var/lib/beamhop-failover)
# Overrides (tests, unusual setups): HEALTH_CMD, RESTORE_CMD, START_CMD, LOCAL_HEALTH_CMD,
#   MAX_CHECKS (stop after N checks without failover, exit 3), DRY_RUN=1 (log commands only).

set -u

CHECK_INTERVAL="${CHECK_INTERVAL:-10}"
FAIL_THRESHOLD="${FAIL_THRESHOLD:-3}"
MODE="${MODE:-systemd}"
COMPOSE_FILE="${COMPOSE_FILE:-/opt/beamhop/deploy/ha/compose.yaml}"
LITESTREAM_CONFIG="${LITESTREAM_CONFIG:-/etc/litestream.yml}"
DB_PATH="${DB_PATH:-/var/lib/beamhop/db/beamhop.sqlite}"
RUN_AS_USER="${RUN_AS_USER:-beamhop}"
LOCAL_URL="${LOCAL_URL:-http://127.0.0.1:3334/healthz}"
PROMOTE_HOOK="${PROMOTE_HOOK:-}"
STATE_DIR="${STATE_DIR:-/var/lib/beamhop-failover}"
MAX_CHECKS="${MAX_CHECKS:-0}"
DRY_RUN="${DRY_RUN:-0}"

log() { printf '%s beamhop-failover: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

run() { # run <description> <shell command>
  log "$1"
  if [ "$DRY_RUN" = 1 ]; then
    log "  (dry run) $2"
    return 0
  fi
  sh -c "$2"
}

if [ -z "${HEALTH_CMD:-}" ]; then
  [ -n "${PRIMARY_URL:-}" ] || { log "PRIMARY_URL is not set"; exit 64; }
  HEALTH_CMD="curl -fsS --max-time 5 -o /dev/null '$PRIMARY_URL'"
fi
if [ -z "${RESTORE_CMD:-}" ]; then
  case "$MODE" in
    systemd)
      RESTORE_CMD="litestream restore -config '$LITESTREAM_CONFIG' -if-replica-exists '$DB_PATH' && { ! id '$RUN_AS_USER' >/dev/null 2>&1 || chown -R '$RUN_AS_USER:$RUN_AS_USER' \"\$(dirname '$DB_PATH')\"; }"
      ;;
    compose)
      # `create` first so the data volume exists with the image's ownership (uid 65532).
      RESTORE_CMD="docker compose -f '$COMPOSE_FILE' --profile primary create beamhop && docker compose -f '$COMPOSE_FILE' run --rm --no-deps litestream restore -config /etc/litestream.yml -if-replica-exists /data/db/beamhop.sqlite"
      ;;
    *) log "MODE must be systemd or compose"; exit 64 ;;
  esac
fi
if [ -z "${START_CMD:-}" ]; then
  case "$MODE" in
    systemd) START_CMD="systemctl enable --now beamhop beamhop-litestream" ;;
    compose) START_CMD="docker compose -f '$COMPOSE_FILE' --profile primary up -d" ;;
  esac
fi
LOCAL_HEALTH_CMD="${LOCAL_HEALTH_CMD:-curl -fsSk --max-time 5 -o /dev/null '$LOCAL_URL'}"

promote() {
  log "primary failed $FAIL_THRESHOLD checks in a row; promoting this standby"
  # Litestream will not restore over an existing file; keep any stale local copy aside.
  if [ "$MODE" = systemd ] && [ -f "$DB_PATH" ]; then
    stamp="$(date -u +%Y%m%dT%H%M%SZ)"
    for f in "$DB_PATH" "$DB_PATH-wal" "$DB_PATH-shm"; do
      [ -f "$f" ] && run "keeping old local copy $f" "mv '$f' '$f.before-failover.$stamp'"
    done
  fi
  if ! run "restoring the database from the replica" "$RESTORE_CMD"; then
    log "restore FAILED; not starting. Fix the replica access and run this script again."
    return 1
  fi
  if ! run "starting Beamhop" "$START_CMD"; then
    log "start FAILED; check: journalctl -u beamhop / docker compose logs"
    return 1
  fi
  ok=0
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do
    if [ "$DRY_RUN" = 1 ] || sh -c "$LOCAL_HEALTH_CMD" >/dev/null 2>&1; then ok=1; break; fi
    sleep 5
  done
  if [ "$ok" = 1 ]; then log "this server is healthy"; else log "WARNING: this server is not answering its health check yet"; fi
  status=0
  for hook in $PROMOTE_HOOK; do
    run "switching traffic: $hook" "'$hook'" || { log "WARNING: hook failed: $hook"; status=2; }
  done
  mkdir -p "$STATE_DIR" && date -u +%Y-%m-%dT%H:%M:%SZ >"$STATE_DIR/promoted"
  log "promotion finished. Do NOT start the old primary with replication on; rebuild it as the new standby (see RUNBOOK.md)."
  return "$status"
}

if [ -f "$STATE_DIR/promoted" ]; then
  log "this server was already promoted ($(cat "$STATE_DIR/promoted")); nothing to do. Remove $STATE_DIR/promoted to watch again."
  exit 0
fi

log "watching ${PRIMARY_URL:-primary} every ${CHECK_INTERVAL}s (failover after $FAIL_THRESHOLD failures)"
fails=0
checks=0
while :; do
  if sh -c "$HEALTH_CMD" >/dev/null 2>&1; then
    [ "$fails" -gt 0 ] && log "primary is healthy again"
    fails=0
  else
    fails=$((fails + 1))
    log "primary check failed ($fails/$FAIL_THRESHOLD)"
  fi
  if [ "$fails" -ge "$FAIL_THRESHOLD" ]; then
    promote
    exit $?
  fi
  checks=$((checks + 1))
  if [ "$MAX_CHECKS" -gt 0 ] && [ "$checks" -ge "$MAX_CHECKS" ]; then exit 3; fi
  sleep "$CHECK_INTERVAL"
done
