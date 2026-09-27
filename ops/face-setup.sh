#!/usr/bin/env bash
# =============================================================================
# Radeef HRMS - install / update the internal face verification service (host / PM2 layout).
#
# Usage (as root):
#   sudo ops/face-setup.sh [--src <repo checkout>]            # first install or update
#   sudo ops/face-setup.sh --update [--src <repo checkout>]   # after a release that changed services/face
#   sudo ops/face-setup.sh --configure-tenants [--mode pm2|docker]
#        adds FACE_SERVICE_URL / FACE_SERVICE_TOKEN to every tenant env file that lacks them
#        (then reload the tenants: pm2 startOrReload ecosystem.config.js --update-env)
#
# What it does:
#   - prepares services/face (app, scripts, models, requirements) in /opt/radeef/face/current.new,
#     installs the pinned packages into /opt/radeef/face/.venv and downloads the detection /
#     recognition models (checksums in scripts/download_models.py), and only then swaps it in
#   - makes the files world-readable (no secrets there): the unit runs as a dynamic user
#   - creates /etc/radeef/services/face.env (chmod 600) with a random FACE_SERVICE_TOKEN, once
#     (a sub-folder on purpose: every /etc/radeef/*.env is treated as a tenant by the ops scripts)
#   - installs ops/systemd/radeef-face.service, restarts it and checks /health on 127.0.0.1:8090;
#     the previous files are restored when the new ones do not become healthy
# Docker deployments use services/face/Dockerfile instead (see docs/RUNBOOK.md).
# =============================================================================
set -euo pipefail
IFS=$'\n\t'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"

SRC="$(cd "$SCRIPT_DIR/.." && pwd)"
MODE="${RADEEF_MODE:-pm2}"
ACTION="install"
FACE_DIR="$RADEEF_ROOT/face"
SERVICE_ENV_DIR="$ENV_DIR/services"
FACE_ENV="$SERVICE_ENV_DIR/face.env"
UNIT=/etc/systemd/system/radeef-face.service

while (($#)); do
  case "$1" in
    --src) SRC="${2:?--src needs a path}"; shift 2 ;;
    --mode) MODE="${2:?--mode needs a value}"; shift 2 ;;
    --update) ACTION="update"; shift ;;
    --configure-tenants) ACTION="configure"; shift ;;
    -h|--help) sed -n '2,23p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

[[ $EUID -eq 0 ]] || die "run as root (sudo)"

# Every tenant env file: /etc/radeef/<tenant>.env, plus the ones listed in jobs-extra.list
# (tenants created by the management panel keep their env file elsewhere, as in run-jobs.sh).
tenant_env_files() {
  local f line
  shopt -s nullglob
  for f in "$ENV_DIR"/*.env; do
    [[ "$(basename "$f" .env)" =~ $TENANT_RE ]] && printf '%s\n' "$f"
  done
  shopt -u nullglob
  if [[ -f "$ENV_DIR/jobs-extra.list" ]]; then
    while IFS= read -r line || [[ -n "$line" ]]; do
      line="${line%%#*}"
      line="${line//[[:space:]]/}"
      [[ -n "$line" && "$line" == /* && -f "$line" ]] && printf '%s\n' "$line"
    done <"$ENV_DIR/jobs-extra.list"
  fi
  return 0
}

configure_tenants() {
  [[ -f "$FACE_ENV" ]] || die "$FACE_ENV not found: install the service first (Docker: see docs/RUNBOOK.md)"
  local token url f changed=0
  token="$(env_get "$FACE_ENV" FACE_SERVICE_TOKEN)"
  [[ -n "$token" ]] || die "FACE_SERVICE_TOKEN missing in $FACE_ENV"
  if [[ "$MODE" == "docker" ]]; then url="http://host.docker.internal:8090"; else url="http://127.0.0.1:8090"; fi
  while IFS= read -r f; do
    [[ -n "$f" ]] || continue
    if [[ -n "$(env_get "$f" FACE_SERVICE_URL)" && -n "$(env_get "$f" FACE_SERVICE_TOKEN)" ]]; then
      log "$f: already configured"
      continue
    fi
    # Empty or partial FACE_SERVICE_* lines (e.g. copied from .env.example) are replaced.
    sed -i -E '/^[[:space:]]*(export[[:space:]]+)?FACE_SERVICE_(URL|TOKEN)=/d' "$f"
    # Unquoted on purpose: `docker run --env-file` would pass the quotes into the value.
    printf '\n# Self clock-in face verification service (ops/face-setup.sh)\nFACE_SERVICE_URL=%s\nFACE_SERVICE_TOKEN=%s\n' "$url" "$token" >>"$f"
    log "$f: FACE_SERVICE_URL / FACE_SERVICE_TOKEN added"
    changed=1
  done < <(tenant_env_files)
  ((changed)) && log "reload the tenants so they read the new variables (pm2 startOrReload ecosystem.config.js --update-env, or recreate the containers)"
  return 0
}

if [[ "$ACTION" == "configure" ]]; then
  configure_tenants
  exit 0
fi

require_cmd python3 install systemctl curl openssl
[[ -d "$SRC/services/face/app" ]] || die "services/face not found under $SRC (use --src <repo checkout>)"
python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' || die "python 3.10+ required"
# `python3 -m venv --help` succeeds even without ensurepip: create a throwaway venv instead.
probe="$(mktemp -d)"
if ! python3 -m venv "$probe/v" >/dev/null 2>&1 || [[ ! -x "$probe/v/bin/pip" ]]; then
  rm -rf "$probe"
  die "python3-venv is missing (apt install python3-venv)"
fi
rm -rf "$probe"

liveness_models=("$SRC"/services/face/models/fasnet_*.onnx)
[[ -e "${liveness_models[0]}" ]] || warn "liveness models (services/face/models/fasnet_*.onnx) are missing: run tools/convert_fasnet.py once and commit them; until then every punch that needs the face check is rejected"

# 1) Prepare the new files next to the running ones (nothing running changes yet).
log "preparing $FACE_DIR/current.new"
install -d -m 755 "$FACE_DIR"
rm -rf "$FACE_DIR/current.new"
install -d -m 755 "$FACE_DIR/current.new"
cp -a "$SRC/services/face/app" "$SRC/services/face/scripts" "$SRC/services/face/models" \
  "$SRC/services/face/requirements.txt" "$SRC/services/face/constraints.txt" "$FACE_DIR/current.new/"
if [[ -d "$FACE_DIR/current/models" ]]; then
  # keep already downloaded models (verified by checksum again below)
  cp -an "$FACE_DIR/current/models/." "$FACE_DIR/current.new/models/" 2>/dev/null || true
fi

if [[ ! -x "$FACE_DIR/.venv/bin/pip" ]]; then
  log "creating virtualenv $FACE_DIR/.venv"
  rm -rf "$FACE_DIR/.venv"
  python3 -m venv "$FACE_DIR/.venv" || { rm -rf "$FACE_DIR/.venv"; die "could not create the virtualenv"; }
fi
"$FACE_DIR/.venv/bin/pip" install --quiet --upgrade pip
# constraints.txt pins every transitive package to the tested versions.
"$FACE_DIR/.venv/bin/pip" install --quiet -r "$FACE_DIR/current.new/requirements.txt" -c "$FACE_DIR/current.new/constraints.txt"
(cd "$FACE_DIR/current.new" && "$FACE_DIR/.venv/bin/python" scripts/download_models.py)

# The unit runs as a dynamic user (not the tenants' user): everything here must be readable by
# others, and writable by root only. Release checkouts may arrive with umask 027 modes.
chown -R root:root "$FACE_DIR"
chmod -R u=rwX,go=rX "$FACE_DIR"

# 2) Swap.
rm -rf "$FACE_DIR/current.old"
[[ -d "$FACE_DIR/current" ]] && mv "$FACE_DIR/current" "$FACE_DIR/current.old"
mv "$FACE_DIR/current.new" "$FACE_DIR/current"

if [[ ! -f "$FACE_ENV" ]]; then
  log "creating $FACE_ENV with a random token"
  install -d -m 700 "$SERVICE_ENV_DIR"
  # Unquoted: systemd, dotenv, Docker --env-file and env_get all read it the same way.
  (umask 077 && printf '# radeef-face token (ops/face-setup.sh). Copy it to FACE_SERVICE_TOKEN of each tenant (--configure-tenants).\nFACE_SERVICE_TOKEN=%s\n' "$(openssl rand -hex 32)" >"$FACE_ENV")
fi
chmod 600 "$FACE_ENV"

# The unit refers to the default locations; follow RADEEF_ROOT / ENV_DIR overrides.
# The previous unit is kept until the new one is healthy (a hardening option the host's systemd
# does not support must not leave the service down).
rm -f "$UNIT.old"
[[ -f "$UNIT" ]] && cp -a "$UNIT" "$UNIT.old"
sed -e "s#/opt/radeef#${RADEEF_ROOT}#g" -e "s#/etc/radeef#${ENV_DIR}#g" "$SCRIPT_DIR/systemd/radeef-face.service" >"$UNIT.tmp"
install -m 644 "$UNIT.tmp" "$UNIT"
rm -f "$UNIT.tmp"
systemctl daemon-reload
systemctl enable radeef-face.service >/dev/null
systemctl restart radeef-face.service

for _ in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:8090/health >/dev/null 2>&1; then
    log "radeef-face is healthy: $(curl -fsS http://127.0.0.1:8090/health)"
    rm -rf "$FACE_DIR/current.old" "$UNIT.old"
    [[ "$ACTION" == "install" ]] && log "next: sudo ops/face-setup.sh --configure-tenants [--mode docker]"
    exit 0
  fi
  sleep 1
done
warn "radeef-face did not become healthy; last logs:"
journalctl -u radeef-face.service -n 40 --no-pager >&2 || true
if [[ -d "$FACE_DIR/current.old" || -f "$UNIT.old" ]]; then
  # Files and unit only: the shared venv keeps the new packages (pinned; rarely changed).
  warn "rolling back to the previous files / unit"
  if [[ -d "$FACE_DIR/current.old" ]]; then rm -rf "$FACE_DIR/current" && mv "$FACE_DIR/current.old" "$FACE_DIR/current"; fi
  if [[ -f "$UNIT.old" ]]; then mv -f "$UNIT.old" "$UNIT" && systemctl daemon-reload; fi
  systemctl restart radeef-face.service || true
fi
exit 1
