# shellcheck shell=bash
# Shared helpers for ops/*.sh. Source it; do not execute it.
# No secret is ever stored here: everything comes from /etc/radeef/<tenant>.env.

RADEEF_ROOT="${RADEEF_ROOT:-/opt/radeef}"
ENV_DIR="${ENV_DIR:-/etc/radeef}"
DATA_DIR="${DATA_DIR:-/var/lib/radeef}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/radeef}"
TENANT_RE='^[a-z][a-z0-9-]{1,29}$'

log()  { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
warn() { printf '[%s] WARNING: %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >&2; }
die()  { printf '[%s] ERROR: %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >&2; exit 1; }

require_cmd() {
  local c
  for c in "$@"; do
    command -v "$c" >/dev/null 2>&1 || die "required command not found: $c"
  done
}

# validate_tenant <name>: lower-case letter first, then [a-z0-9-], 2..30 chars.
validate_tenant() {
  local t="${1:-}"
  [[ "$t" =~ $TENANT_RE ]] || die "invalid tenant name '${t}' (must match ${TENANT_RE})"
}

tenant_env_file() { printf '%s/%s.env' "$ENV_DIR" "$1"; }

# require_env_file <tenant>: the env file must exist and must not be world-readable.
require_env_file() {
  local f
  f="$(tenant_env_file "$1")"
  [[ -f "$f" ]] || die "missing env file $f (create it with ops/new-tenant.sh or from .env.example)"
  if [[ -n "$(find "$f" -perm /o=rwx 2>/dev/null)" ]]; then
    die "$f is accessible by other users; run: chmod 600 $f"
  fi
}

# env_get <file> <KEY>: prints the value of KEY from a dotenv file without executing it.
# Supports KEY=value, KEY="value" and KEY='value' (last definition wins).
env_get() {
  local file="$1" key="$2" line value
  line="$(grep -E "^[[:space:]]*(export[[:space:]]+)?${key}=" "$file" 2>/dev/null | tail -n 1 || true)"
  [[ -n "$line" ]] || return 0
  value="${line#*=}"
  value="${value%$'\r'}"
  if [[ "$value" =~ ^\"(.*)\"[[:space:]]*$ ]]; then
    value="${BASH_REMATCH[1]}"
  elif [[ "$value" =~ ^\'(.*)\'[[:space:]]*$ ]]; then
    value="${BASH_REMATCH[1]}"
  fi
  printf '%s' "$value"
}

# tenant_var <tenant> <KEY> [default]
tenant_var() {
  local v
  v="$(env_get "$(tenant_env_file "$1")" "$2")"
  printf '%s' "${v:-${3:-}}"
}

# pg_url <DATABASE_URL>: libpq-compatible URI for pg_dump/pg_restore/psql run ON THE HOST.
# Strips Prisma-only query params (?schema=..&connection_limit=..) and maps the Docker
# host alias back to localhost.
pg_url() {
  local url="${1%%\?*}"
  url="${url/@host.docker.internal:/@127.0.0.1:}"
  url="${url/@host.docker.internal\//@127.0.0.1/}"
  printf '%s' "$url"
}

# url_set_param <url> <key> <value>: returns <url> with query parameter <key> set to <value>
# (replacing an existing one). <value> must already be URL-encoded.
url_set_param() {
  local url="$1" key="$2" value="$3" base query="" out="" part
  local -a parts=()
  base="${url%%\?*}"
  [[ "$url" == *\?* ]] && query="${url#*\?}"
  IFS='&' read -r -a parts <<<"$query"
  for part in "${parts[@]}"; do
    [[ -z "$part" || "${part%%=*}" == "$key" ]] && continue
    out+="${out:+&}$part"
  done
  printf '%s?%s%s=%s' "$base" "${out:+$out&}" "$key" "$value"
}

# Prisma pool sizes (DEC-004): app processes 5, deploy canary 2, CLI jobs 2.
APP_CONNECTION_LIMIT="${APP_CONNECTION_LIMIT:-5}"
CANARY_CONNECTION_LIMIT="${CANARY_CONNECTION_LIMIT:-2}"
# Migrations: fail fast behind a long-held lock and lift the 30s per-role statement_timeout.
# Passed via the Prisma URL "options" parameter (URL-encoded "-c lock_timeout=10s -c statement_timeout=15min").
MIGRATE_PG_OPTIONS="${MIGRATE_PG_OPTIONS:--c%20lock_timeout%3D10s%20-c%20statement_timeout%3D15min}"

# tenant_env_override <tenant> <DATABASE_URL>: writes a private temp copy of the tenant env file
# with DATABASE_URL replaced and prints its path (caller removes it). The URL never appears on a
# command line.
tenant_env_override() {
  local src tmp dir
  src="$(tenant_env_file "$1")"
  dir="${TMPDIR:-/tmp}"
  tmp="$(umask 077 && mktemp "$dir/radeef-$1-env.XXXXXX")"
  grep -Ev '^[[:space:]]*(export[[:space:]]+)?DATABASE_URL=' "$src" >"$tmp" || true
  printf 'DATABASE_URL="%s"\n' "$2" >>"$tmp"
  printf '%s' "$tmp"
}

tenant_pg_url() {
  local url
  url="$(tenant_var "$1" DATABASE_URL)"
  [[ -n "$url" ]] || die "DATABASE_URL is not set in $(tenant_env_file "$1")"
  pg_url "$url"
}

# pg_run <libpq-uri> <command> [args...]: runs a Postgres client tool with the password moved
# from the URI into PGPASSWORD, so it never appears in `ps` output. The URI (without
# password) is passed via --dbname.
pg_run() {
  local uri="$1"; shift
  local cmd="$1"; shift
  local re='^(postgres(ql)?://)([^:@/]+)(:([^@]*))?@(.*)$'
  local pass="" clean="$uri"
  if [[ "$uri" =~ $re ]]; then
    pass="${BASH_REMATCH[5]}"
    clean="${BASH_REMATCH[1]}${BASH_REMATCH[3]}@${BASH_REMATCH[6]}"
    # percent-decode (%XX) the password
    pass="$(printf '%b' "${pass//%/\\x}")"
  fi
  if [[ -n "$pass" ]]; then
    PGPASSWORD="$pass" "$cmd" --dbname="$clean" "$@"
  else
    "$cmd" --dbname="$clean" "$@"
  fi
}

tenant_port() {
  local p
  p="$(tenant_var "$1" PORT)"
  [[ "$p" =~ ^[0-9]{2,5}$ ]] || die "PORT is missing or invalid in $(tenant_env_file "$1")"
  printf '%s' "$p"
}

# Host-side uploads directory (the container path /app/uploads is mounted from here).
tenant_upload_dir() {
  local d
  d="$(tenant_var "$1" UPLOAD_DIR)"
  if [[ -z "$d" || "$d" == /app/* ]]; then
    d="${DATA_DIR}/$1/uploads"
  fi
  printf '%s' "$d"
}

# wait_healthy <url> [timeout_seconds]: polls until HTTP 200.
wait_healthy() {
  local url="$1" timeout="${2:-90}" waited=0
  while (( waited < timeout )); do
    if curl -fsS -m 5 -o /dev/null "$url" 2>/dev/null; then
      return 0
    fi
    sleep 2
    waited=$((waited + 2))
  done
  return 1
}

timestamp() { date -u '+%Y%m%dT%H%M%SZ'; }
