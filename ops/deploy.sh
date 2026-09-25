#!/usr/bin/env bash
# =============================================================================
# Radeef HRMS - zero-downtime deploy.
#
# Build ONCE (a release directory for PM2, or an image for Docker), then for each tenant:
#   1. pg_dump -Fc  -> /var/backups/radeef/<tenant>/pre-deploy-<ts>.dump (verified)
#   2. prisma migrate deploy (+ idempotent seed)
#   3. start the new release as a canary on PORT+CANARY_OFFSET and wait for /api/health
#   4. switch: PM2 = `current` symlink + `pm2 reload` (cluster mode starts the new process
#      before stopping the old one); Docker = retag radeef:live-<tenant> and recreate the
#      container while Nginx is pointed at the canary (when the upstream file is writable)
#   5. health check on the real port; automatic rollback to the previous release on failure
# Keeps the last KEEP_RELEASES (default 5) releases.
#
# One failing tenant does NOT stop the run (DEC-004): each tenant is deployed in its own subshell,
# the next tenant continues, a tenant x release matrix is printed at the end (and appended to
# $RADEEF_ROOT/deploy-matrix.log), and the exit code is non-zero when any tenant failed or was
# skipped. A failure in the MIGRATE stage usually means the release itself is broken, so after
# --max-migrate-failures such failures (default 1; 0 = never stop) the remaining tenants are
# SKIPPED instead of having the same migration attempted on their databases.
# Pools: canary DATABASE_URL gets connection_limit=2; migrations run with
# options=-c lock_timeout=10s -c statement_timeout=15min (private temp env files, never argv).
#
# Usage:
#   ops/deploy.sh [--mode pm2|docker] [--ref <git-ref>] [--image <image>] [--skip-seed] [--max-migrate-failures N] (--all | <tenant>...)
#   ops/deploy.sh [--mode pm2|docker] --release <release-id|image> --skip-migrate <tenant>...
#   ops/deploy.sh [--mode pm2|docker] --rollback <tenant>
#   ops/deploy.sh [--mode pm2|docker] [--ref <git-ref>] --build-only   (prints the release id / image)
#
# Rollback (application only; database migrations are NOT reverted):
#   ops/deploy.sh --rollback <tenant>          # previous entry in /opt/radeef/<tenant>/releases.log
# If a migration itself must be undone, restore the pre-deploy dump:
#   ops/restore.sh <tenant> /var/backups/radeef/<tenant>/pre-deploy-<ts>.dump
#
# PM2 mode runs as the unprivileged service user (never root). No secret lives in this
# script: everything comes from /etc/radeef/<tenant>.env.
# =============================================================================
set -euo pipefail
IFS=$'\n\t'
umask 027

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"

MODE="${RADEEF_MODE:-pm2}"
REF="${DEPLOY_REF:-origin/main}"
IMAGE=""
RELEASE=""
ROLLBACK=0
BUILD_ONLY=0
SKIP_MIGRATE=0
SKIP_SEED=0
ALL=0
TENANTS=()
SRC_DIR="${SRC_DIR:-$RADEEF_ROOT/src}"
RELEASES_DIR="${RELEASES_DIR:-$RADEEF_ROOT/releases}"
KEEP_RELEASES="${KEEP_RELEASES:-5}"
COMPOSE_FILE="${COMPOSE_FILE:-$RADEEF_ROOT/docker-compose.yml}"
UPSTREAM_DIR="${UPSTREAM_DIR:-/etc/nginx/radeef-upstreams}"
CANARY_OFFSET="${CANARY_OFFSET:-1000}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-120}"
TS="$(timestamp)"

MAX_MIGRATE_FAILURES="${MAX_MIGRATE_FAILURES:-1}"
TMP_FILES=()
STAGE_FILE=""

usage() { sed -n '2,38p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

while (($#)); do
  case "$1" in
    --mode) MODE="${2:?--mode needs a value}"; shift 2 ;;
    --ref) REF="${2:?--ref needs a value}"; shift 2 ;;
    --image) IMAGE="${2:?--image needs a value}"; shift 2 ;;
    --release) RELEASE="${2:?--release needs a value}"; shift 2 ;;
    --rollback) ROLLBACK=1; SKIP_MIGRATE=1; shift ;;
    --skip-migrate) SKIP_MIGRATE=1; shift ;;
    --build-only) BUILD_ONLY=1; shift ;;
    --skip-seed) SKIP_SEED=1; shift ;;
    --all) ALL=1; shift ;;
    --max-migrate-failures) MAX_MIGRATE_FAILURES="${2:?--max-migrate-failures needs a value}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    -*) die "unknown option: $1 (see --help)" ;;
    *) TENANTS+=("$1"); shift ;;
  esac
done

[[ "$MODE" == "pm2" || "$MODE" == "docker" ]] || die "--mode must be pm2 or docker"
[[ "$KEEP_RELEASES" =~ ^[0-9]+$ ]] && ((KEEP_RELEASES >= 2)) || die "KEEP_RELEASES must be an integer >= 2"
[[ "$MAX_MIGRATE_FAILURES" =~ ^[0-9]+$ ]] || die "--max-migrate-failures must be an integer >= 0"

if ((ALL)); then
  shopt -s nullglob
  for f in "$ENV_DIR"/*.env; do
    name="$(basename "$f" .env)"
    [[ "$name" =~ $TENANT_RE ]] && TENANTS+=("$name")
  done
  shopt -u nullglob
fi
if ((BUILD_ONLY == 0)); then
  ((${#TENANTS[@]} > 0)) || die "no tenant given (pass tenant names or --all)"
fi
for t in "${TENANTS[@]}"; do
  validate_tenant "$t"
  require_env_file "$t"
done
if ((ROLLBACK)) && ((${#TENANTS[@]} != 1)); then die "--rollback takes exactly one tenant"; fi

require_cmd curl flock
((BUILD_ONLY)) || require_cmd pg_dump pg_restore
if [[ "$MODE" == "pm2" ]]; then
  require_cmd node npm pm2 git
  if [[ "$(id -u)" -eq 0 && "${ALLOW_ROOT:-0}" != "1" ]]; then
    die "PM2 mode must run as the service user (e.g. sudo -iu radeef $0 ...), not root"
  fi
else
  require_cmd docker
fi

mkdir -p "$RADEEF_ROOT" "$RELEASES_DIR"
exec 9>"$RADEEF_ROOT/.deploy.lock"
flock -n 9 || die "another deploy is already running"

CANARY_PID=""
CANARY_CONTAINER=""
cleanup() {
  if [[ -n "$CANARY_PID" ]]; then kill "$CANARY_PID" 2>/dev/null || true; fi
  if [[ -n "$CANARY_CONTAINER" ]]; then docker rm -f "$CANARY_CONTAINER" >/dev/null 2>&1 || true; fi
  local f
  for f in ${TMP_FILES[@]+"${TMP_FILES[@]}"}; do rm -f -- "$f"; done
}
trap cleanup EXIT

# ------------------------------------------------------------------ helpers
history_file() { printf '%s/%s/releases.log' "$RADEEF_ROOT" "$1"; }

# stage <name>: remembers how far the current tenant got (read by the matrix).
stage() {
  if [[ -n "$STAGE_FILE" ]]; then printf '%s' "$1" >"$STAGE_FILE"; fi
}

# private_env <tenant> <param> <value>: sets PRIVATE_ENV to a temp copy of the tenant env file
# whose DATABASE_URL has query parameter <param>=<value>. Removed by cleanup(). (Not used inside
# $(...): the TMP_FILES bookkeeping must happen in this shell.)
PRIVATE_ENV=""
private_env() {
  local url f
  url="$(tenant_var "$1" DATABASE_URL)"
  [[ -n "$url" ]] || die "[$1] DATABASE_URL is not set in $(tenant_env_file "$1")"
  f="$(tenant_env_override "$1" "$(url_set_param "$url" "$2" "$3")")"
  [[ -n "$f" && -f "$f" ]] || die "[$1] could not create a private env file"
  TMP_FILES+=("$f")
  PRIVATE_ENV="$f"
}

# current_release <tenant>: the release id (PM2) or image (Docker) the tenant runs now.
current_release() {
  local c
  if [[ "$MODE" == "pm2" ]]; then
    c="$(readlink "$RADEEF_ROOT/$1/current" 2>/dev/null || true)"
    printf '%s' "${c##*/}"
  else
    tail -n 1 "$(history_file "$1")" 2>/dev/null | awk '{print $2}' || true
  fi
}

record_release() {
  mkdir -p "$RADEEF_ROOT/$1"
  printf '%s %s\n' "$TS" "$2" >>"$(history_file "$1")"
}

# previous_release <tenant> <current>: the newest history entry that differs from <current>.
previous_release() {
  local f
  f="$(history_file "$1")"
  [[ -f "$f" ]] || return 0
  awk -v cur="$2" '$2 != cur { prev = $2 } END { if (prev != "") print prev }' "$f"
}

backup_database() {
  local t="$1" dir dump
  dir="$BACKUP_DIR/$t"
  mkdir -p "$dir"
  dump="$dir/pre-deploy-$TS.dump"
  log "[$t] backup -> $dump"
  (umask 077 && pg_run "$(tenant_pg_url "$t")" pg_dump --format=custom --no-owner --file="$dump")
  pg_restore --list "$dump" >/dev/null || die "[$t] backup verification failed: $dump"
}

can_switch_upstream() {
  local t="$1"
  [[ -w "$UPSTREAM_DIR/$t.conf" ]] || return 1
  if [[ "$(id -u)" -eq 0 ]]; then return 0; fi
  sudo -n true 2>/dev/null
}

nginx_reload() {
  if [[ "$(id -u)" -eq 0 ]]; then nginx -t -q && systemctl reload nginx; else sudo -n nginx -t -q && sudo -n systemctl reload nginx; fi
}

set_upstream() {
  local t="$1" port="$2"
  printf 'server 127.0.0.1:%s max_fails=0;\n' "$port" >"$UPSTREAM_DIR/$t.conf"
  nginx_reload
}

# ------------------------------------------------------------------ PM2 mode
build_release() {
  [[ -d "$SRC_DIR/.git" ]] || die "SRC_DIR=$SRC_DIR is not a git checkout (git clone the repository there first)"
  log "build: fetching $REF in $SRC_DIR"
  git -C "$SRC_DIR" fetch --tags --prune origin
  git -C "$SRC_DIR" checkout --force --detach "$REF"
  git -C "$SRC_DIR" clean -fd
  local sha rel
  sha="$(git -C "$SRC_DIR" rev-parse --short=12 HEAD)"
  RELEASE="$TS-$sha"
  rel="$RELEASES_DIR/$RELEASE"
  log "build: npm ci + prisma generate + next build ($sha)"
  (
    cd "$SRC_DIR"
    npm ci --no-audit --no-fund
    npx prisma generate
    # Build-time placeholders only: the build never connects to the database.
    NODE_ENV=production \
      DATABASE_URL="postgresql://build:build@127.0.0.1:5432/build?schema=public" \
      SESSION_SECRET="build-time-placeholder-not-used-at-runtime-0000000000" \
      npm run build
  )
  [[ -f "$SRC_DIR/.next/standalone/server.js" ]] || die "build did not produce .next/standalone (next.config.ts must keep output: 'standalone')"

  log "build: assembling release $rel"
  mkdir -p "$rel/.next"
  cp -a "$SRC_DIR/.next/standalone" "$rel/.next/standalone"
  mkdir -p "$rel/.next/standalone/.next" "$rel/.next/standalone/node_modules"
  rm -rf "$rel/.next/standalone/.next/static" "$rel/.next/standalone/public"
  cp -a "$SRC_DIR/.next/static" "$rel/.next/standalone/.next/static"
  cp -a "$SRC_DIR/public" "$rel/.next/standalone/public"
  rm -rf "$rel/.next/standalone/public/uploads"
  # Make sure the generated Prisma client + query engine are present in the traced bundle.
  rm -rf "$rel/.next/standalone/node_modules/.prisma"
  cp -a "$SRC_DIR/node_modules/.prisma" "$rel/.next/standalone/node_modules/.prisma"
  cp -a "$SRC_DIR/prisma" "$rel/prisma"
  [[ -d "$SRC_DIR/scripts" ]] && cp -a "$SRC_DIR/scripts" "$rel/scripts"
  cp "$SRC_DIR/ecosystem.config.js" "$rel/ecosystem.config.js"
  printf '%s\n' "$(git -C "$SRC_DIR" rev-parse HEAD)" >"$rel/REVISION"
  # Never ship env files inside a release.
  find "$rel" -maxdepth 3 -name '.env*' -type f -delete
  BUILT_THIS_RUN=1
}

# Runs a node script with ONLY the tenant env file (+PATH/HOME) as environment.
tenant_node() {
  local t="$1"; shift
  env -i PATH="$PATH" HOME="${HOME:-/tmp}" NODE_ENV=production \
    node --env-file="$(tenant_env_file "$t")" "$@"
}

migrate_pm2() {
  local t="$1" rel="$2"
  log "[$t] prisma migrate deploy (lock_timeout=10s)"
  private_env "$t" options "$MIGRATE_PG_OPTIONS"
  (cd "$rel" && env -i PATH="$PATH" HOME="${HOME:-/tmp}" NODE_ENV=production \
    node --env-file="$PRIVATE_ENV" "$SRC_DIR/node_modules/prisma/build/index.js" migrate deploy --schema "$rel/prisma/schema.prisma")
  if ((SKIP_SEED == 0)) && [[ "${BUILT_THIS_RUN:-0}" == "1" ]]; then
    log "[$t] seed (idempotent)"
    (cd "$SRC_DIR" && tenant_node "$t" "$SRC_DIR/prisma/seed.mjs")
  fi
}

canary_pm2() {
  local t="$1" rel="$2" cport="$3"
  log "[$t] canary on 127.0.0.1:$cport (connection_limit=$CANARY_CONNECTION_LIMIT)"
  mkdir -p "$RADEEF_ROOT/$t"
  private_env "$t" connection_limit "$CANARY_CONNECTION_LIMIT"
  # Environment variables given here take precedence over the --env-file values.
  env -i PATH="$PATH" HOME="${HOME:-/tmp}" NODE_ENV=production PORT="$cport" HOSTNAME=127.0.0.1 \
    node --env-file="$PRIVATE_ENV" "$rel/.next/standalone/server.js" \
    >"$RADEEF_ROOT/$t/canary.log" 2>&1 &
  CANARY_PID=$!
  if ! wait_healthy "http://127.0.0.1:$cport/api/health" "$HEALTH_TIMEOUT"; then
    tail -n 50 "$RADEEF_ROOT/$t/canary.log" >&2 || true
    die "[$t] canary failed its health check; nothing was switched (log: $RADEEF_ROOT/$t/canary.log)"
  fi
  kill "$CANARY_PID" 2>/dev/null || true
  wait "$CANARY_PID" 2>/dev/null || true
  CANARY_PID=""
}

switch_pm2() {
  local t="$1" rel="$2" tdir="$RADEEF_ROOT/$1"
  mkdir -p "$tdir"
  ln -sfn "$rel" "$tdir/current.new"
  mv -Tf "$tdir/current.new" "$tdir/current"
  cp "$rel/ecosystem.config.js" "$RADEEF_ROOT/ecosystem.config.js"
  pm2 startOrReload "$RADEEF_ROOT/ecosystem.config.js" --only "$t" --update-env
  pm2 save >/dev/null
}

deploy_tenant_pm2() {
  local t="$1" rel="$RELEASES_DIR/$RELEASE" port cport prev
  [[ -f "$rel/.next/standalone/server.js" ]] || die "release not found: $rel"
  port="$(tenant_port "$t")"
  cport=$((port + CANARY_OFFSET))
  prev="$(readlink "$RADEEF_ROOT/$t/current" 2>/dev/null || true)"
  prev="${prev##*/}"

  if ((SKIP_MIGRATE == 0)); then
    stage backup
    backup_database "$t"
    stage migrate
    migrate_pm2 "$t" "$rel"
  fi
  stage canary
  canary_pm2 "$t" "$rel" "$cport"

  stage switch
  log "[$t] switching to $RELEASE"
  switch_pm2 "$t" "$rel"
  stage health
  if ! wait_healthy "http://127.0.0.1:$port/api/health" "$HEALTH_TIMEOUT"; then
    if [[ -n "$prev" && -d "$RELEASES_DIR/$prev" ]]; then
      warn "[$t] health check failed after switch; rolling back to $prev"
      stage "health (rolled back to $prev)"
      switch_pm2 "$t" "$RELEASES_DIR/$prev"
    fi
    die "[$t] deploy of $RELEASE failed (see: pm2 logs $t)"
  fi
  record_release "$t" "$RELEASE"
  stage done
  log "[$t] live on $RELEASE (previous: ${prev:-none})"
}

prune_releases() {
  local keep=() r in_use t target
  for t in "$ENV_DIR"/*.env; do
    t="$(basename "$t" .env)"
    target="$(readlink "$RADEEF_ROOT/$t/current" 2>/dev/null || true)"
    [[ -n "$target" ]] && keep+=("${target##*/}")
  done
  # Release ids start with a UTC timestamp, so a reverse name sort is newest first.
  mapfile -t all < <(find "$RELEASES_DIR" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort -r)
  local i=0
  for r in "${all[@]}"; do
    i=$((i + 1))
    ((i <= KEEP_RELEASES)) && continue
    in_use=0
    for t in "${keep[@]}"; do [[ "$t" == "$r" ]] && in_use=1; done
    if ((in_use)); then continue; fi
    log "prune: removing old release $r"
    rm -rf -- "${RELEASES_DIR:?}/$r"
  done
}

# ------------------------------------------------------------------ Docker mode
prepare_image() {
  if [[ -n "$IMAGE" ]]; then
    docker image inspect "$IMAGE" >/dev/null 2>&1 || docker pull "$IMAGE"
  else
    [[ -d "$SRC_DIR/.git" ]] || die "SRC_DIR=$SRC_DIR is not a git checkout (or pass --image)"
    git -C "$SRC_DIR" fetch --tags --prune origin
    git -C "$SRC_DIR" checkout --force --detach "$REF"
    git -C "$SRC_DIR" clean -fd
    IMAGE="radeef:$(git -C "$SRC_DIR" rev-parse --short=12 HEAD)"
    log "build: docker build -t $IMAGE"
    docker build --pull -t "$IMAGE" "$SRC_DIR"
  fi
  RELEASE="$IMAGE"
}

# docker_env_args <tenant> [env-file]: the env file defaults to /etc/radeef/<tenant>.env.
docker_env_args() {
  printf '%s\n' --env-file "${2:-$(tenant_env_file "$1")}" \
    -e NODE_ENV=production -e HOSTNAME=0.0.0.0 -e PORT=3000 -e UPLOAD_DIR=/app/uploads \
    --add-host host.docker.internal:host-gateway
}

deploy_tenant_docker() {
  local t="$1" port cport updir prev bridged=0
  port="$(tenant_port "$t")"
  cport=$((port + CANARY_OFFSET))
  updir="$(tenant_upload_dir "$t")"
  prev="$(tail -n 1 "$(history_file "$t")" 2>/dev/null | awk '{print $2}' || true)"
  mapfile -t envargs < <(docker_env_args "$t")

  if ((SKIP_MIGRATE == 0)); then
    stage backup
    backup_database "$t"
    stage migrate
    log "[$t] prisma migrate deploy (lock_timeout=10s)"
    local -a migargs=()
    private_env "$t" options "$MIGRATE_PG_OPTIONS"
    mapfile -t migargs < <(docker_env_args "$t" "$PRIVATE_ENV")
    docker run --rm "${migargs[@]}" "$IMAGE" npx prisma migrate deploy
    # The seed runs with the normal tenant URL (per-role statement_timeout applies).
    ((SKIP_SEED)) || docker run --rm "${envargs[@]}" "$IMAGE" node prisma/seed.mjs
  fi

  stage canary
  log "[$t] canary container on 127.0.0.1:$cport (connection_limit=$CANARY_CONNECTION_LIMIT)"
  CANARY_CONTAINER="radeef-canary-$t"
  docker rm -f "$CANARY_CONTAINER" >/dev/null 2>&1 || true
  private_env "$t" connection_limit "$CANARY_CONNECTION_LIMIT"
  local -a canaryargs=()
  mapfile -t canaryargs < <(docker_env_args "$t" "$PRIVATE_ENV")
  docker run -d --name "$CANARY_CONTAINER" "${canaryargs[@]}" \
    -p "127.0.0.1:$cport:3000" -v "$updir:/app/uploads:ro" "$IMAGE" >/dev/null
  if ! wait_healthy "http://127.0.0.1:$cport/api/health" "$HEALTH_TIMEOUT"; then
    docker logs --tail 50 "$CANARY_CONTAINER" >&2 || true
    die "[$t] canary failed its health check; nothing was switched"
  fi

  if can_switch_upstream "$t"; then
    log "[$t] nginx -> canary while the container is recreated"
    set_upstream "$t" "$cport"
    bridged=1
  else
    warn "[$t] $UPSTREAM_DIR/$t.conf not writable: the container restart shows the maintenance page for a few seconds"
  fi

  stage switch
  docker tag "$IMAGE" "radeef:live-$t"
  docker compose -f "$COMPOSE_FILE" up -d --no-deps "$t"
  stage health
  local ok=1
  wait_healthy "http://127.0.0.1:$port/api/health" "$HEALTH_TIMEOUT" || ok=0
  if ((ok == 0)) && [[ -n "$prev" ]]; then
    warn "[$t] health check failed after switch; rolling back to $prev"
    stage "health (rolled back to $prev)"
    docker tag "$prev" "radeef:live-$t" && docker compose -f "$COMPOSE_FILE" up -d --no-deps "$t" || true
    wait_healthy "http://127.0.0.1:$port/api/health" "$HEALTH_TIMEOUT" || warn "[$t] rollback is not healthy either"
  fi
  if ((bridged)); then set_upstream "$t" "$port"; fi
  docker rm -f "$CANARY_CONTAINER" >/dev/null 2>&1 || true
  CANARY_CONTAINER=""
  ((ok)) || die "[$t] deploy of $IMAGE failed (see: docker logs $t)"
  record_release "$t" "$IMAGE"
  stage done
  log "[$t] live on $IMAGE (previous: ${prev:-none})"
}

# ------------------------------------------------------------------ main
if ((ROLLBACK)); then
  t="${TENANTS[0]}"
  if [[ "$MODE" == "pm2" ]]; then
    cur="$(readlink "$RADEEF_ROOT/$t/current" 2>/dev/null || true)"
    cur="${cur##*/}"
  else
    cur="$(tail -n 1 "$(history_file "$t")" 2>/dev/null | awk '{print $2}' || true)"
  fi
  RELEASE="$(previous_release "$t" "$cur")"
  [[ -n "$RELEASE" ]] || die "[$t] no previous release in $(history_file "$t")"
  log "[$t] rollback: $cur -> $RELEASE (database is NOT reverted)"
  [[ "$MODE" == "docker" ]] && IMAGE="$RELEASE"
elif [[ -n "$RELEASE" ]]; then
  [[ "$MODE" == "docker" ]] && IMAGE="$RELEASE"
elif [[ "$MODE" == "pm2" ]]; then
  build_release
else
  prepare_image
fi

if ((BUILD_ONLY)); then
  log "built: $RELEASE"
  log "deploy it with: $0 --mode $MODE --release $RELEASE <tenant>..."
  exit 0
fi

# Each tenant runs in its own subshell: `die` ends that tenant only, its own EXIT trap stops a
# leftover canary and removes its private env files, and the loop continues with the next one.
STATUS_DIR="$(mktemp -d "${TMPDIR:-/tmp}/radeef-deploy.XXXXXX")"
trap 'cleanup; rm -rf -- "$STATUS_DIR"' EXIT
declare -A T_BEFORE=() T_AFTER=() T_RESULT=() T_STAGE=()
FAILED=0
SKIPPED=0
MIGRATE_FAILED=0

for t in "${TENANTS[@]}"; do
  T_BEFORE[$t]="$(current_release "$t")"
  if ((MAX_MIGRATE_FAILURES > 0 && MIGRATE_FAILED >= MAX_MIGRATE_FAILURES)); then
    T_RESULT[$t]="SKIPPED"
    T_STAGE[$t]="not started: $MIGRATE_FAILED migration failure(s) in this run (--max-migrate-failures)"
    T_AFTER[$t]="${T_BEFORE[$t]}"
    SKIPPED=$((SKIPPED + 1))
    warn "[$t] skipped: ${T_STAGE[$t]}"
    continue
  fi
  printf 'start' >"$STATUS_DIR/$t.stage"
  set +e
  (
    set -euo pipefail
    STAGE_FILE="$STATUS_DIR/$t.stage"
    TMP_FILES=()
    CANARY_PID=""
    CANARY_CONTAINER=""
    trap cleanup EXIT
    if [[ "$MODE" == "pm2" ]]; then deploy_tenant_pm2 "$t"; else deploy_tenant_docker "$t"; fi
  )
  rc=$?
  set -e
  T_STAGE[$t]="$(cat "$STATUS_DIR/$t.stage" 2>/dev/null || true)"
  T_AFTER[$t]="$(current_release "$t")"
  if ((rc == 0)); then
    T_RESULT[$t]="OK"
  else
    T_RESULT[$t]="FAILED"
    FAILED=$((FAILED + 1))
    [[ "${T_STAGE[$t]}" == "migrate" ]] && MIGRATE_FAILED=$((MIGRATE_FAILED + 1))
    warn "[$t] FAILED at stage '${T_STAGE[$t]}' (exit $rc); continuing with the next tenant"
  fi
done

[[ "$MODE" == "pm2" ]] && prune_releases

# Tenant x release matrix (also appended to $RADEEF_ROOT/deploy-matrix.log).
print_matrix() {
  local t
  printf '\n== deploy %s  mode=%s  target=%s ==\n' "$TS" "$MODE" "$RELEASE"
  printf '%-22s %-36s %-36s %-8s %s\n' TENANT BEFORE AFTER RESULT STAGE
  for t in "${TENANTS[@]}"; do
    printf '%-22s %-36s %-36s %-8s %s\n' "$t" "${T_BEFORE[$t]:--}" "${T_AFTER[$t]:--}" "${T_RESULT[$t]:-?}" "${T_STAGE[$t]:-}"
  done
  printf 'ok=%d failed=%d skipped=%d\n' "$((${#TENANTS[@]} - FAILED - SKIPPED))" "$FAILED" "$SKIPPED"
}
print_matrix
print_matrix >>"$RADEEF_ROOT/deploy-matrix.log" 2>/dev/null || warn "could not append to $RADEEF_ROOT/deploy-matrix.log"

log "rollback: $0 --mode $MODE --rollback <tenant>   (DB restore: ops/restore.sh <tenant> $BACKUP_DIR/<tenant>/pre-deploy-$TS.dump)"
if ((FAILED > 0 || SKIPPED > 0)); then
  die "deploy finished with $FAILED failed and $SKIPPED skipped tenant(s) (see the matrix above)"
fi
log "done: ${TENANTS[*]} -> $RELEASE"
