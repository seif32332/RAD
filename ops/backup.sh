#!/usr/bin/env bash
# =============================================================================
# Radeef HRMS - daily backup of every tenant: database (pg_dump -Fc) + uploads (tar.gz).
#
# Usage:  ops/backup.sh [--all | <tenant>...]          (default: --all)
# Cron (root or the radeef user; must be able to read /etc/radeef/*.env):
#   15 2 * * * /opt/radeef/ops/backup.sh --all >>/var/log/radeef/backup.log 2>&1
#
# Layout: /var/backups/radeef/<tenant>/{daily,weekly,monthly}/<tenant>-<ts>.{dump,uploads.tar.gz,sha256}
# Retention: KEEP_DAILY=7, KEEP_WEEKLY=4 (Sunday copies), KEEP_MONTHLY=6 (1st of month copies).
# pre-deploy-*/pre-restore-* dumps (made by deploy.sh/restore.sh) are kept KEEP_ADHOC_DAYS=30 days.
#
# Offsite (strongly recommended - the local copies die with the disk):
#   RCLONE_REMOTE=b2crypt:radeef-backups   -> rclone copy of each tenant folder after the run
#   (use an rclone "crypt" remote so the provider never sees employee data in clear text)
# Optional: BACKUP_PING_URL=https://hc-ping.com/<uuid>  (pinged on success, /fail on failure)
# Settings may also be placed in /etc/radeef/backup.conf (KEY=value lines, root-owned).
# =============================================================================
set -euo pipefail
IFS=$'\n\t'
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"

BACKUP_CONF="${BACKUP_CONF:-$ENV_DIR/backup.conf}"
conf() { local v=""; [[ -r "$BACKUP_CONF" ]] && v="$(env_get "$BACKUP_CONF" "$1")"; printf '%s' "${v:-${2:-}}"; }

KEEP_DAILY="${KEEP_DAILY:-$(conf KEEP_DAILY 7)}"
KEEP_WEEKLY="${KEEP_WEEKLY:-$(conf KEEP_WEEKLY 4)}"
KEEP_MONTHLY="${KEEP_MONTHLY:-$(conf KEEP_MONTHLY 6)}"
KEEP_ADHOC_DAYS="${KEEP_ADHOC_DAYS:-$(conf KEEP_ADHOC_DAYS 30)}"
RCLONE_REMOTE="${RCLONE_REMOTE:-$(conf RCLONE_REMOTE)}"
BACKUP_PING_URL="${BACKUP_PING_URL:-$(conf BACKUP_PING_URL)}"

for n in "$KEEP_DAILY" "$KEEP_WEEKLY" "$KEEP_MONTHLY" "$KEEP_ADHOC_DAYS"; do
  [[ "$n" =~ ^[0-9]+$ ]] && ((n >= 1)) || die "retention values must be positive integers"
done

TENANTS=()
if (($# == 0)) || [[ "${1:-}" == "--all" ]]; then
  shopt -s nullglob
  for f in "$ENV_DIR"/*.env; do
    name="$(basename "$f" .env)"
    [[ "$name" =~ $TENANT_RE ]] && TENANTS+=("$name")
  done
  shopt -u nullglob
else
  TENANTS=("$@")
fi
((${#TENANTS[@]} > 0)) || die "no tenants found in $ENV_DIR"
for t in "${TENANTS[@]}"; do validate_tenant "$t"; done

require_cmd pg_dump pg_restore tar sha256sum flock
[[ -z "$RCLONE_REMOTE" ]] || require_cmd rclone

mkdir -p "$BACKUP_DIR"
exec 9>"$BACKUP_DIR/.backup.lock"
flock -n 9 || die "another backup is already running"

TS="$(timestamp)"
DOW="$(date -u +%u)"   # 7 = Sunday
DOM="$(date -u +%d)"

# prune_tier <dir> <keep>: keep the newest <keep> backup sets (sorted by timestamped name).
prune_tier() {
  local dir="$1" keep="$2" i=0 f base
  [[ -d "$dir" ]] || return 0
  mapfile -t sets < <(find "$dir" -maxdepth 1 -type f -name '*.dump' -printf '%f\n' | sort -r)
  for f in "${sets[@]}"; do
    i=$((i + 1))
    if ((i > keep)); then
      base="${f%.dump}"
      rm -f -- "$dir/$base.dump" "$dir/$base.uploads.tar.gz" "$dir/$base.sha256"
    fi
  done
}

# copy_set <from_dir> <base> <to_dir>: hard link when possible (same filesystem), else copy.
copy_set() {
  local from="$1" base="$2" to="$3" f
  mkdir -p "$to"
  for f in "$from/$base".*; do
    ln -f "$f" "$to/" 2>/dev/null || cp -p "$f" "$to/"
  done
}

backup_tenant() {
  local t="$1" root daily base updir
  require_env_file "$t"
  root="$BACKUP_DIR/$t"
  daily="$root/daily"
  base="$t-$TS"
  mkdir -p "$daily"

  log "[$t] pg_dump"
  pg_run "$(tenant_pg_url "$t")" pg_dump --format=custom --no-owner --file="$daily/$base.dump.partial"
  pg_restore --list "$daily/$base.dump.partial" >/dev/null
  mv -f "$daily/$base.dump.partial" "$daily/$base.dump"

  updir="$(tenant_upload_dir "$t")"
  if [[ -d "$updir" ]]; then
    log "[$t] uploads $updir"
    tar -C "$(dirname "$updir")" -czf "$daily/$base.uploads.tar.gz.partial" "$(basename "$updir")"
    mv -f "$daily/$base.uploads.tar.gz.partial" "$daily/$base.uploads.tar.gz"
  else
    warn "[$t] uploads directory $updir not found; database only"
  fi
  (cd "$daily" && sha256sum "$base".dump "$base".uploads.tar.gz 2>/dev/null >"$base.sha256" || sha256sum "$base".dump >"$base.sha256")

  [[ "$DOW" == "7" ]] && copy_set "$daily" "$base" "$root/weekly"
  [[ "$DOM" == "01" ]] && copy_set "$daily" "$base" "$root/monthly"

  prune_tier "$daily" "$KEEP_DAILY"
  prune_tier "$root/weekly" "$KEEP_WEEKLY"
  prune_tier "$root/monthly" "$KEEP_MONTHLY"
  find "$root" -maxdepth 1 -type f \( -name 'pre-deploy-*.dump' -o -name 'pre-restore-*' \) -mtime +"$KEEP_ADHOC_DAYS" -delete

  if [[ -n "$RCLONE_REMOTE" ]]; then
    log "[$t] offsite copy -> $RCLONE_REMOTE/$t"
    rclone copy --transfers 2 --exclude '*.partial' "$root" "$RCLONE_REMOTE/$t"
  fi
  log "[$t] ok ($(du -sh "$daily/$base.dump" | cut -f1) db)"
}

FAILED=()
for t in "${TENANTS[@]}"; do
  set +e
  (set -e; backup_tenant "$t")
  rc=$?
  set -e
  if ((rc != 0)); then
    warn "[$t] backup FAILED (exit $rc)"
    rm -f "$BACKUP_DIR/$t/daily/"*.partial 2>/dev/null || true
    FAILED+=("$t")
  fi
done

if ((${#FAILED[@]} > 0)); then
  [[ -z "$BACKUP_PING_URL" ]] || curl -fsS -m 10 --retry 3 -o /dev/null "$BACKUP_PING_URL/fail" || true
  die "backup failed for: ${FAILED[*]}"
fi
[[ -z "$BACKUP_PING_URL" ]] || curl -fsS -m 10 --retry 3 -o /dev/null "$BACKUP_PING_URL" || true
log "backup complete: ${TENANTS[*]}"
