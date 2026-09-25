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
#   - copies services/face (app, scripts, models, requirements) to /opt/radeef/face/current
#   - creates /opt/radeef/face/.venv (python3 -m venv) and installs requirements.txt
#   - downloads the detection / recognition models (checksums in scripts/download_models.py)
#   - creates /etc/radeef/services/face.env (chmod 600) with a random FACE_SERVICE_TOKEN, once
#     (a sub-folder on purpose: every /etc/radeef/*.env is treated as a tenant by the ops scripts)
#   - installs ops/systemd/radeef-face.service, restarts it and checks /health on 127.0.0.1:8090
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
SERVICE_USER="${SERVICE_USER:-radeef}"

while (($#)); do
  case "$1" in
    --src) SRC="${2:?--src needs a path}"; shift 2 ;;
    --mode) MODE="${2:?--mode needs a value}"; shift 2 ;;
    --update) ACTION="update"; shift ;;
    --configure-tenants) ACTION="configure"; shift ;;
    -h|--help) sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

[[ $EUID -eq 0 ]] || die "run as root (sudo)"

configure_tenants() {
  [[ -f "$FACE_ENV" ]] || die "$FACE_ENV not found: install the service first"
  local token url f changed=0
  token="$(env_get "$FACE_ENV" FACE_SERVICE_TOKEN)"
  [[ -n "$token" ]] || die "FACE_SERVICE_TOKEN missing in $FACE_ENV"
  if [[ "$MODE" == "docker" ]]; then url="http://host.docker.internal:8090"; else url="http://127.0.0.1:8090"; fi
  shopt -s nullglob
  for f in "$ENV_DIR"/*.env; do
    [[ "$(basename "$f" .env)" =~ $TENANT_RE ]] || continue
    if grep -q '^FACE_SERVICE_URL=' "$f"; then
      log "$(basename "$f"): already configured"
      continue
    fi
    printf '\n# Self clock-in face verification service (ops/face-setup.sh)\nFACE_SERVICE_URL="%s"\nFACE_SERVICE_TOKEN="%s"\n' "$url" "$token" >>"$f"
    log "$(basename "$f"): FACE_SERVICE_URL / FACE_SERVICE_TOKEN added"
    changed=1
  done
  shopt -u nullglob
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
python3 -m venv --help >/dev/null 2>&1 || die "python3-venv is missing (apt install python3-venv)"
id -u "$SERVICE_USER" >/dev/null 2>&1 || die "system user $SERVICE_USER not found (ops/new-tenant.sh creates it)"

liveness_models=("$SRC"/services/face/models/fasnet_*.onnx)
[[ -e "${liveness_models[0]}" ]] || warn "liveness models (services/face/models/fasnet_*.onnx) are missing: run tools/convert_fasnet.py once and commit them; until then every punch that needs the face check is rejected"

log "installing files into $FACE_DIR/current"
install -d -m 755 "$FACE_DIR"
rm -rf "$FACE_DIR/current.new"
install -d -m 755 "$FACE_DIR/current.new"
cp -a "$SRC/services/face/app" "$SRC/services/face/scripts" "$SRC/services/face/models" "$SRC/services/face/requirements.txt" "$FACE_DIR/current.new/"
if [[ -d "$FACE_DIR/current/models" ]]; then
  # keep already downloaded models (verified by checksum again below)
  cp -an "$FACE_DIR/current/models/." "$FACE_DIR/current.new/models/" 2>/dev/null || true
fi
rm -rf "$FACE_DIR/current.old"
[[ -d "$FACE_DIR/current" ]] && mv "$FACE_DIR/current" "$FACE_DIR/current.old"
mv "$FACE_DIR/current.new" "$FACE_DIR/current"

if [[ ! -x "$FACE_DIR/.venv/bin/python" ]]; then
  log "creating virtualenv $FACE_DIR/.venv"
  python3 -m venv "$FACE_DIR/.venv"
fi
"$FACE_DIR/.venv/bin/pip" install --quiet --upgrade pip
"$FACE_DIR/.venv/bin/pip" install --quiet -r "$FACE_DIR/current/requirements.txt"
(cd "$FACE_DIR/current" && "$FACE_DIR/.venv/bin/python" scripts/download_models.py)
chown -R root:root "$FACE_DIR"
chmod -R go-w "$FACE_DIR"

if [[ ! -f "$FACE_ENV" ]]; then
  log "creating $FACE_ENV with a random token"
  install -d -m 700 "$SERVICE_ENV_DIR"
  (umask 077 && printf '# radeef-face token (ops/face-setup.sh). Copy it to FACE_SERVICE_TOKEN of each tenant (--configure-tenants).\nFACE_SERVICE_TOKEN="%s"\n' "$(openssl rand -hex 32)" >"$FACE_ENV")
fi
chmod 600 "$FACE_ENV"

install -m 644 "$SCRIPT_DIR/systemd/radeef-face.service" "$UNIT"
systemctl daemon-reload
systemctl enable radeef-face.service >/dev/null
systemctl restart radeef-face.service

for _ in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:8090/health >/dev/null 2>&1; then
    log "radeef-face is healthy: $(curl -fsS http://127.0.0.1:8090/health)"
    rm -rf "$FACE_DIR/current.old"
    [[ "$ACTION" == "install" ]] && log "next: sudo ops/face-setup.sh --configure-tenants [--mode docker]"
    exit 0
  fi
  sleep 1
done
warn "radeef-face did not become healthy; last logs:"
journalctl -u radeef-face.service -n 40 --no-pager >&2 || true
if [[ -d "$FACE_DIR/current.old" ]]; then
  warn "rolling back to the previous files"
  rm -rf "$FACE_DIR/current" && mv "$FACE_DIR/current.old" "$FACE_DIR/current"
  systemctl restart radeef-face.service || true
fi
exit 1
