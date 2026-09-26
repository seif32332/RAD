#!/usr/bin/env bash
# =============================================================================
# Radeef HRMS - run one scripts/jobs.mjs job for every tenant (DEC-009). For a systemd timer
# or cron (see docs/RUNBOOK.md "Background jobs"); never exposed over HTTP.
#
# Usage:
#   ops/run-jobs.sh [--mode pm2|docker] [--jitter SECONDS] <job> [tenant...]
#     <job>: expiry-digest | deactivate-terminated | outbox-dispatch
#     no tenant given = every tenant (below)
#
# Tenants:
#   - every $ENV_DIR/<tenant>.env (ops/new-tenant.sh), and
#   - every env file listed in $ENV_DIR/jobs-extra.list, one absolute path per line (tenants
#     created by radeef-manage keep their env in <TENANTS_ROOT>/<name>/.env).
#   A tenant whose env file contains RADEEF_JOBS="off" is skipped: set it for suspended tenants.
#
# How a job runs:
#   pm2    : node --env-file=<env> scripts/jobs.mjs <job>, from $JOBS_APP_DIR (default
#            $RADEEF_ROOT/src: its node_modules holds the generated Prisma client, exactly like the
#            deploy seed); for a jobs-extra.list tenant, from the directory of its .env.
#   docker : docker run --rm --env-file <env> radeef:live-<tenant> node scripts/jobs.mjs <job>
# jobs.mjs caps its pool at connection_limit=2, refuses to run twice at once per database and
# records a JobRun row. One failing tenant does not stop the others; exit 1 if any failed.
# =============================================================================
set -euo pipefail
IFS=$'\n\t'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"

MODE="${RADEEF_MODE:-pm2}"
JITTER=0
JOB=""
TENANTS=()
JOBS_APP_DIR="${JOBS_APP_DIR:-$RADEEF_ROOT/src}"
JOB_TIMEOUT="${JOB_TIMEOUT:-30m}"
JOB_RE='^(expiry-digest|deactivate-terminated|outbox-dispatch|purge-attendance-biometrics|documents-retention|documents-integrity)$'

while (($#)); do
  case "$1" in
    --mode) MODE="${2:?--mode needs a value}"; shift 2 ;;
    --jitter) JITTER="${2:?--jitter needs a value}"; shift 2 ;;
    -h|--help) sed -n '2,26p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) die "unknown option: $1" ;;
    *) if [[ -z "$JOB" ]]; then JOB="$1"; else TENANTS+=("$1"); fi; shift ;;
  esac
done
[[ "$JOB" =~ $JOB_RE ]] || die "usage: ops/run-jobs.sh [--mode pm2|docker] [--jitter SECONDS] <expiry-digest|deactivate-terminated|outbox-dispatch> [tenant...]"
[[ "$MODE" == "pm2" || "$MODE" == "docker" ]] || die "--mode must be pm2 or docker"
[[ "$JITTER" =~ ^[0-9]+$ ]] || die "--jitter must be a number of seconds"
require_cmd node timeout
[[ "$MODE" == "docker" ]] && require_cmd docker

# name<TAB>env-file<TAB>workdir
declare -a TARGETS=()
add_target() { TARGETS+=("$1"$'\t'"$2"$'\t'"$3"); }

shopt -s nullglob
for f in "$ENV_DIR"/*.env; do
  name="$(basename "$f" .env)"
  [[ "$name" =~ $TENANT_RE ]] || continue
  add_target "$name" "$f" "$JOBS_APP_DIR"
done
shopt -u nullglob
if [[ -f "$ENV_DIR/jobs-extra.list" ]]; then
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%%#*}"
    line="${line//[[:space:]]/}"
    [[ -n "$line" ]] || continue
    [[ "$line" == /* && -f "$line" ]] || { warn "jobs-extra.list: not a file: $line"; continue; }
    add_target "$(basename "$(dirname "$line")")" "$line" "$(dirname "$line")"
  done <"$ENV_DIR/jobs-extra.list"
fi

if ((JITTER > 0)); then
  delay=$((RANDOM % JITTER))
  log "jitter: sleeping ${delay}s"
  sleep "$delay"
fi

ok=0
failed=0
skipped=0
for entry in "${TARGETS[@]}"; do
  IFS=$'\t' read -r name envf workdir <<<"$entry"
  if ((${#TENANTS[@]} > 0)); then
    wanted=0
    for t in "${TENANTS[@]}"; do [[ "$t" == "$name" ]] && wanted=1; done
    ((wanted)) || continue
  fi
  if [[ "$(env_get "$envf" RADEEF_JOBS)" == "off" ]]; then
    log "[$name] skipped (RADEEF_JOBS=off)"
    skipped=$((skipped + 1))
    continue
  fi
  log "[$name] $JOB"
  set +e
  if [[ "$MODE" == "docker" ]]; then
    # The uploads volume is mounted like in docker-compose.yml (purge-attendance-biometrics deletes files there).
    timeout "$JOB_TIMEOUT" docker run --rm --env-file "$envf" -e NODE_ENV=production \
      -v "$DATA_DIR/$name/uploads:/app/uploads" \
      --add-host host.docker.internal:host-gateway "radeef:live-$name" node scripts/jobs.mjs "$JOB"
  else
    (cd "$workdir" && timeout "$JOB_TIMEOUT" env -i PATH="$PATH" HOME="${HOME:-/tmp}" NODE_ENV=production \
      node --env-file="$envf" scripts/jobs.mjs "$JOB")
  fi
  rc=$?
  set -e
  if ((rc == 0)); then ok=$((ok + 1)); else failed=$((failed + 1)); warn "[$name] $JOB failed (exit $rc)"; fi
done

log "$JOB: ok=$ok failed=$failed skipped=$skipped"
((failed == 0)) || exit 1
