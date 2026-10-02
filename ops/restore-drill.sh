#!/usr/bin/env bash
# =============================================================================
# Radeef HRMS - automatic restore drill (master plan P0-04): a backup that was never restored is
# not a backup. For every tenant, the newest daily set made by ops/backup.sh is:
#   1. checked against its .sha256 file, the dump listed (pg_restore --list), the uploads archive listed
#   2. restored into a THROWAWAY database radeef_drill_<tenant> (never the tenant database)
#   3. checked: migrations present and finished, and the same last migration as the live database
#   4. dropped
# The result is written to the tenant's own JobRun table (job "restore-drill", SUCCEEDED/FAILED,
# details = JSON), so it shows next to the other background jobs.
#
# Usage (root, like ops/backup.sh):  ops/restore-drill.sh [--all | <tenant>...]
# Needs, in /etc/radeef/backup.conf (or the environment):
#   DRILL_PG_URL=postgresql://drill_admin:...@127.0.0.1:5432/postgres
#     a role allowed to CREATE and DROP databases (CREATEDB), used only for radeef_drill_* databases
#   DRILL_PING_URL=https://hc-ping.com/<uuid>   (optional: pinged on success, /fail on failure)
# Monthly timer: ops/systemd/radeef-restore-drill.timer (docs/RUNBOOK.md 3.4).
# =============================================================================
set -euo pipefail
IFS=$'\n\t'
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"

BACKUP_CONF="${BACKUP_CONF:-$ENV_DIR/backup.conf}"
conf() { local v=""; [[ -r "$BACKUP_CONF" ]] && v="$(env_get "$BACKUP_CONF" "$1")"; printf '%s' "${v:-${2:-}}"; }
DRILL_PG_URL="${DRILL_PG_URL:-$(conf DRILL_PG_URL)}"
DRILL_PING_URL="${DRILL_PING_URL:-$(conf DRILL_PING_URL)}"
[[ -n "$DRILL_PG_URL" ]] || die "DRILL_PG_URL is not set (in $BACKUP_CONF): a role with CREATEDB for the throwaway databases"

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
require_cmd pg_restore psql sha256sum tar

# db_url <libpq-uri> <dbname>: the same server and role, another database.
db_url() {
  local uri="${1%%\?*}" db="$2"
  printf '%s/%s' "${uri%/*}" "$db"
}

# record <tenant> <status> <started-iso> <details-json>: one JobRun row in the tenant database.
record() {
  pg_run "$(tenant_pg_url "$1")" psql -X -q -v ON_ERROR_STOP=1 \
    -v status="$2" -v started="$3" -v details="$4" <<'SQL'
INSERT INTO "JobRun" ("id", "job", "startedAt", "finishedAt", "status", "details")
VALUES (gen_random_uuid()::text, 'restore-drill', :'started'::timestamptz, now(), :'status', :'details');
SQL
}

# drill <tenant>: prints the details JSON on stdout; exit status = drill result.
drill() {
  local t="$1" dir latest base db admin_url drill_url sum_file uploads="none" migrations live_last drill_last in_live employees
  dir="$BACKUP_DIR/$t/daily"
  latest="$(find "$dir" -maxdepth 1 -type f -name '*.dump' -printf '%f\n' 2>/dev/null | sort -r | head -1)"
  [[ -n "$latest" ]] || { printf '{"error":"no daily backup in %s"}' "$dir"; return 1; }
  base="${latest%.dump}"
  sum_file="$dir/$base.sha256"
  [[ -f "$sum_file" ]] || { printf '{"backup":"%s","error":"missing .sha256"}' "$base"; return 1; }
  (cd "$dir" && sha256sum --quiet -c "$base.sha256") >&2 || { printf '{"backup":"%s","error":"checksum mismatch"}' "$base"; return 1; }
  pg_restore --list "$dir/$latest" >/dev/null || { printf '{"backup":"%s","error":"pg_restore --list failed"}' "$base"; return 1; }
  if [[ -f "$dir/$base.uploads.tar.gz" ]]; then
    tar -tzf "$dir/$base.uploads.tar.gz" >/dev/null || { printf '{"backup":"%s","error":"uploads archive unreadable"}' "$base"; return 1; }
    uploads="ok"
  fi

  db="radeef_drill_${t//-/_}"
  admin_url="$(pg_url "$DRILL_PG_URL")"
  drill_url="$(db_url "$admin_url" "$db")"
  pg_run "$admin_url" psql -X -q -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS \"$db\"" -c "CREATE DATABASE \"$db\"" >&2
  # From here on the throwaway database is always dropped, whatever happens.
  trap 'pg_run "$admin_url" psql -X -q -c "DROP DATABASE IF EXISTS \"'"$db"'\"" >&2 || true' RETURN
  if ! pg_run "$drill_url" pg_restore --no-owner --no-privileges --exit-on-error --single-transaction "$dir/$latest" >&2; then
    printf '{"backup":"%s","error":"restore failed"}' "$base"; return 1
  fi
  migrations="$(pg_run "$drill_url" psql -X -At -c 'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL')"
  # COLLATE "C": byte order, the order Prisma applies the letter-scheme migrations in (9_ < 9a < 9p).
  drill_last="$(pg_run "$drill_url" psql -X -At -c 'SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL ORDER BY migration_name COLLATE "C" DESC LIMIT 1')"
  live_last="$(pg_run "$(tenant_pg_url "$t")" psql -X -At -c 'SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL ORDER BY migration_name COLLATE "C" DESC LIMIT 1')"
  in_live="$(pg_run "$(tenant_pg_url "$t")" psql -X -At -v m="$drill_last" <<<'SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = :'"'"'m'"'"' AND finished_at IS NOT NULL;')"
  employees="$(pg_run "$drill_url" psql -X -At -c 'SELECT count(*) FROM "Employee"')"
  printf '{"backup":"%s","dumpBytes":%s,"migrations":%s,"lastMigration":"%s","liveLastMigration":"%s","employees":%s,"uploads":"%s"}' \
    "$base" "$(stat -c %s "$dir/$latest")" "${migrations:-0}" "$drill_last" "$live_last" "${employees:-0}" "$uploads"
  ((${migrations:-0} > 0)) || return 1
  # A deploy after the backup may add migrations, but the dump's last one must be applied in the live database.
  [[ -n "$drill_last" && "$in_live" == "1" ]] || return 1
}

FAILED=()
for t in "${TENANTS[@]}"; do
  require_env_file "$t"
  started="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  log "[$t] restore drill"
  set +e
  details="$(drill "$t")"
  rc=$?
  set -e
  status="SUCCEEDED"
  ((rc == 0)) || { status="FAILED"; FAILED+=("$t"); }
  log "[$t] $status $details"
  record "$t" "$status" "$started" "$details" || { warn "[$t] could not write JobRun"; FAILED+=("$t"); }
done

if ((${#FAILED[@]} > 0)); then
  [[ -z "$DRILL_PING_URL" ]] || curl -fsS -m 10 --retry 3 -o /dev/null "$DRILL_PING_URL/fail" || true
  die "restore drill failed for: ${FAILED[*]}"
fi
[[ -z "$DRILL_PING_URL" ]] || curl -fsS -m 10 --retry 3 -o /dev/null "$DRILL_PING_URL" || true
log "restore drill passed: ${TENANTS[*]}"
