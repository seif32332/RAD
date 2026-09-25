#!/usr/bin/env bash
# =============================================================================
# Radeef HRMS - restore one tenant from a backup made by ops/backup.sh or ops/deploy.sh.
#
# Usage:
#   ops/restore.sh [--mode pm2|docker] [--uploads <file.uploads.tar.gz>] [--yes] <tenant> <file.dump>
#
# What it does:
#   1. verifies the dump (pg_restore --list) and the uploads archive (tar -tzf)
#   2. takes a safety dump of the CURRENT database -> <backup dir>/<tenant>/pre-restore-<ts>.dump
#   3. stops the tenant app (pm2 stop / docker compose stop)
#   4. recreates the `public` schema and restores the dump in a single transaction
#   5. optionally replaces the uploads directory (the old one is kept as <dir>.pre-restore-<ts>)
#   6. starts the app again and waits for /api/health
#
# Test restores regularly into a scratch tenant/database (see docs/RUNBOOK.md): a backup that
# was never restored is not a backup.
# =============================================================================
set -euo pipefail
IFS=$'\n\t'
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"

MODE="${RADEEF_MODE:-pm2}"
PM2_USER="${PM2_USER:-radeef}"
COMPOSE_FILE="${COMPOSE_FILE:-$RADEEF_ROOT/docker-compose.yml}"
UPLOADS_ARCHIVE=""
ASSUME_YES=0
ARGS=()

while (($#)); do
  case "$1" in
    --mode) MODE="${2:?--mode needs a value}"; shift 2 ;;
    --uploads) UPLOADS_ARCHIVE="${2:?--uploads needs a file}"; shift 2 ;;
    --yes) ASSUME_YES=1; shift ;;
    -h|--help) sed -n '2,18p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) die "unknown option: $1" ;;
    *) ARGS+=("$1"); shift ;;
  esac
done
((${#ARGS[@]} == 2)) || die "usage: ops/restore.sh [--mode pm2|docker] [--uploads <tar.gz>] [--yes] <tenant> <file.dump>"
TENANT="${ARGS[0]}"
DUMP="${ARGS[1]}"
[[ "$MODE" == "pm2" || "$MODE" == "docker" ]] || die "--mode must be pm2 or docker"

validate_tenant "$TENANT"
require_env_file "$TENANT"
require_cmd pg_dump pg_restore psql curl tar
[[ -f "$DUMP" ]] || die "dump not found: $DUMP"
[[ -z "$UPLOADS_ARCHIVE" || -f "$UPLOADS_ARCHIVE" ]] || die "uploads archive not found: $UPLOADS_ARCHIVE"

PGURL="$(tenant_pg_url "$TENANT")"
PORT="$(tenant_port "$TENANT")"
UPDIR="$(tenant_upload_dir "$TENANT")"
TS="$(timestamp)"

log "[$TENANT] verifying $DUMP"
pg_restore --list "$DUMP" >/dev/null || die "not a valid pg_dump custom-format archive: $DUMP"
if [[ -n "$UPLOADS_ARCHIVE" ]]; then
  tar -tzf "$UPLOADS_ARCHIVE" >/dev/null || die "corrupt uploads archive: $UPLOADS_ARCHIVE"
fi

if ((ASSUME_YES == 0)); then
  [[ -t 0 ]] || die "refusing to restore non-interactively without --yes"
  printf 'This REPLACES the database of tenant "%s"%s.\n' "$TENANT" "${UPLOADS_ARCHIVE:+ and its uploads}"
  read -r -p "Type the tenant name to continue: " answer
  [[ "$answer" == "$TENANT" ]] || die "aborted"
fi

as_pm2() {
  if [[ "$(id -u)" -eq 0 && "$PM2_USER" != "root" ]]; then sudo -u "$PM2_USER" -H pm2 "$@"; else pm2 "$@"; fi
}

stop_app() {
  log "[$TENANT] stopping app"
  if [[ "$MODE" == "pm2" ]]; then as_pm2 stop "$TENANT" >/dev/null || warn "pm2 stop $TENANT failed (not running?)"
  else docker compose -f "$COMPOSE_FILE" stop "$TENANT"; fi
}

start_app() {
  log "[$TENANT] starting app"
  if [[ "$MODE" == "pm2" ]]; then as_pm2 start "$TENANT" >/dev/null
  else docker compose -f "$COMPOSE_FILE" start "$TENANT"; fi
}

SAFETY="$BACKUP_DIR/$TENANT/pre-restore-$TS.dump"
mkdir -p "$BACKUP_DIR/$TENANT"
log "[$TENANT] safety dump of the current database -> $SAFETY"
pg_run "$PGURL" pg_dump --format=custom --no-owner --file="$SAFETY"

stop_app
APP_STOPPED=1
on_exit() {
  local rc=$?
  if ((rc != 0)) && [[ "${APP_STOPPED:-0}" == "1" ]]; then
    warn "restore FAILED (exit $rc). The app is still stopped."
    warn "Previous database: ops/restore.sh --mode $MODE $TENANT $SAFETY"
  fi
}
trap on_exit EXIT

log "[$TENANT] recreating schema public"
pg_run "$PGURL" psql -v ON_ERROR_STOP=1 -q -c 'DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;'

log "[$TENANT] pg_restore (single transaction)"
pg_run "$PGURL" pg_restore --no-owner --no-acl --single-transaction --exit-on-error "$DUMP"

if [[ -n "$UPLOADS_ARCHIVE" ]]; then
  log "[$TENANT] restoring uploads into $UPDIR"
  staging="$(mktemp -d "$(dirname "$UPDIR")/.restore-XXXXXX")"
  tar -xzf "$UPLOADS_ARCHIVE" -C "$staging"
  # The archive holds one top-level directory (the uploads folder name at backup time).
  mapfile -t top < <(find "$staging" -mindepth 1 -maxdepth 1)
  ((${#top[@]} == 1)) && [[ -d "${top[0]}" ]] || die "unexpected uploads archive layout (expected one top-level directory)"
  if [[ -d "$UPDIR" ]]; then
    mv "$UPDIR" "$UPDIR.pre-restore-$TS"
    mv "${top[0]}" "$UPDIR"
    chown -R --reference="$UPDIR.pre-restore-$TS" "$UPDIR" 2>/dev/null || true
    chmod --reference="$UPDIR.pre-restore-$TS" "$UPDIR" 2>/dev/null || true
    log "[$TENANT] previous uploads kept in $UPDIR.pre-restore-$TS (delete after verification)"
  else
    mv "${top[0]}" "$UPDIR"
  fi
  rmdir "$staging" 2>/dev/null || true
fi

start_app
APP_STOPPED=0
if wait_healthy "http://127.0.0.1:$PORT/api/health" 120; then
  log "[$TENANT] restore complete and healthy"
else
  die "[$TENANT] restored, but /api/health is not OK; check the app logs"
fi
log "Note: if the dump is older than the deployed code, run the pending migrations (ops/deploy.sh --release <current> $TENANT) before users log in."
