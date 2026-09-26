#!/usr/bin/env bash
# =============================================================================
# Radeef HRMS - install / update the internal document renderer (host / PM2 layout).
#
# Usage (as root):
#   sudo ops/render-setup.sh [--src <repo checkout>]            # first install or update
#   sudo ops/render-setup.sh --update [--src <repo checkout>]   # after a release that changed services/render
#   sudo ops/render-setup.sh --configure-tenants [--mode pm2|docker]
#        adds RENDER_SERVICE_URL / RENDER_SERVICE_TOKEN to every tenant env file that lacks them
#        (then reload the tenants: pm2 startOrReload ecosystem.config.js --update-env)
#
# What it does:
#   - prepares services/render (src, locks) in /opt/radeef/render/current.new and downloads the
#     pinned Typst binary and font bundle into it (scripts/fetch-assets.sh verifies every file
#     against typst.lock / fonts.lock), then swaps it in
#   - makes the files world-readable (no secrets there): the unit runs as a dynamic user
#   - creates /etc/radeef/services/render.env (chmod 600) with a random RENDER_SERVICE_TOKEN, once
#     (a sub-folder on purpose: every /etc/radeef/*.env is treated as a tenant by the ops scripts)
#   - installs ops/systemd/radeef-render.service with the host's Node, restarts it and checks
#     /health on 127.0.0.1:8091; the previous files and unit are restored if it does not become healthy
# Docker deployments use services/render/Dockerfile instead (see docs/RUNBOOK.md §5.2).
# =============================================================================
set -euo pipefail
IFS=$'\n\t'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"

SRC="$(cd "$SCRIPT_DIR/.." && pwd)"
MODE="${RADEEF_MODE:-pm2}"
ACTION="install"
RENDER_DIR="$RADEEF_ROOT/render"
SERVICE_ENV_DIR="$ENV_DIR/services"
RENDER_ENV="$SERVICE_ENV_DIR/render.env"
UNIT=/etc/systemd/system/radeef-render.service
PORT=8091

while (($#)); do
  case "$1" in
    --src) SRC="${2:?--src needs a path}"; shift 2 ;;
    --mode) MODE="${2:?--mode needs a value}"; shift 2 ;;
    --update) ACTION="update"; shift ;;
    --configure-tenants) ACTION="configure"; shift ;;
    -h|--help) sed -n '2,22p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

[[ $EUID -eq 0 ]] || die "run as root (sudo)"

# Every tenant env file: /etc/radeef/<tenant>.env, plus the ones listed in jobs-extra.list
# (same discovery as ops/face-setup.sh and run-jobs.sh).
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
  [[ -f "$RENDER_ENV" ]] || die "$RENDER_ENV not found: install the service first (Docker: see docs/RUNBOOK.md)"
  local token url f changed=0
  token="$(env_get "$RENDER_ENV" RENDER_SERVICE_TOKEN)"
  [[ -n "$token" ]] || die "RENDER_SERVICE_TOKEN missing in $RENDER_ENV"
  if [[ "$MODE" == "docker" ]]; then url="http://host.docker.internal:$PORT"; else url="http://127.0.0.1:$PORT"; fi
  while IFS= read -r f; do
    [[ -n "$f" ]] || continue
    if [[ -n "$(env_get "$f" RENDER_SERVICE_URL)" && -n "$(env_get "$f" RENDER_SERVICE_TOKEN)" ]]; then
      log "$f: already configured"
      continue
    fi
    sed -i -E '/^[[:space:]]*(export[[:space:]]+)?RENDER_SERVICE_(URL|TOKEN)=/d' "$f"
    # Unquoted on purpose: `docker run --env-file` would pass the quotes into the value.
    printf '\n# Document renderer (ops/render-setup.sh)\nRENDER_SERVICE_URL=%s\nRENDER_SERVICE_TOKEN=%s\n' "$url" "$token" >>"$f"
    log "$f: RENDER_SERVICE_URL / RENDER_SERVICE_TOKEN added"
    changed=1
  done < <(tenant_env_files)
  ((changed)) && log "reload the tenants so they read the new variables (pm2 startOrReload ecosystem.config.js --update-env, or recreate the containers)"
  return 0
}

if [[ "$ACTION" == "configure" ]]; then
  configure_tenants
  exit 0
fi

require_cmd node install systemctl curl openssl sha256sum tar xz
[[ -f "$SRC/services/render/src/main.mjs" ]] || die "services/render not found under $SRC (use --src <repo checkout>)"
NODE_BIN="$(command -v node)"
"$NODE_BIN" -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>20||(a===20&&b>=9)?0:1)' \
  || die "Node >= 20.9 required at $NODE_BIN (found $("$NODE_BIN" --version))"
# DynamicUser runs outside any home directory: Node must be a system path (not ~/.nvm).
case "$NODE_BIN" in /usr/*|/opt/*) ;; *) die "node at $NODE_BIN is not under /usr or /opt (install a system Node for the service)";; esac

# 1) Prepare the new files next to the running ones (nothing running changes yet).
log "preparing $RENDER_DIR/current.new"
install -d -m 755 "$RENDER_DIR"
rm -rf "$RENDER_DIR/current.new"
install -d -m 755 "$RENDER_DIR/current.new"
cp -a "$SRC/services/render/src" "$SRC/services/render/scripts" "$SRC/services/render/package.json" \
  "$SRC/services/render/typst.lock" "$SRC/services/render/fonts.lock" "$RENDER_DIR/current.new/"
if [[ -d "$RENDER_DIR/current/bin" || -d "$RENDER_DIR/current/fonts" ]]; then
  # reuse already downloaded assets (fetch-assets.sh re-verifies them and replaces any mismatch)
  cp -a "$RENDER_DIR/current/bin" "$RENDER_DIR/current/fonts" "$RENDER_DIR/current.new/" 2>/dev/null || true
  # fonts no longer listed in the lock must not stay (the service refuses to start with them)
  for f in "$RENDER_DIR/current.new/fonts"/*; do
    [[ -e "$f" ]] || continue
    grep -q "  $(basename "$f")  " "$RENDER_DIR/current.new/fonts.lock" || rm -f "$f"
  done
fi
sh "$RENDER_DIR/current.new/scripts/fetch-assets.sh" "$RENDER_DIR/current.new"

# Runs as a dynamic user: readable by others, writable by root only.
chown -R root:root "$RENDER_DIR"
chmod -R u=rwX,go=rX "$RENDER_DIR"

# Smoke test before swapping: the new binary must report the pinned version.
"$RENDER_DIR/current.new/bin/typst" --version | grep -q "^typst $(grep -o 'v[0-9.]*' "$RENDER_DIR/current.new/typst.lock" | head -1 | tr -d v)" \
  || die "the downloaded typst does not report the pinned version"

# 2) Swap.
rm -rf "$RENDER_DIR/current.old"
[[ -d "$RENDER_DIR/current" ]] && mv "$RENDER_DIR/current" "$RENDER_DIR/current.old"
mv "$RENDER_DIR/current.new" "$RENDER_DIR/current"

if [[ ! -f "$RENDER_ENV" ]]; then
  log "creating $RENDER_ENV with a random token"
  install -d -m 700 "$SERVICE_ENV_DIR"
  (umask 077 && printf '# radeef-render token (ops/render-setup.sh). Copy it to RENDER_SERVICE_TOKEN of each tenant (--configure-tenants).\nRENDER_SERVICE_TOKEN=%s\n' "$(openssl rand -hex 32)" >"$RENDER_ENV")
fi
chmod 600 "$RENDER_ENV"

# The unit refers to the default locations; follow RADEEF_ROOT / ENV_DIR overrides and the host's Node.
rm -f "$UNIT.old"
[[ -f "$UNIT" ]] && cp -a "$UNIT" "$UNIT.old"
sed -e "s#/opt/radeef#${RADEEF_ROOT}#g" -e "s#/etc/radeef#${ENV_DIR}#g" -e "s#^ExecStart=NODE_BIN #ExecStart=${NODE_BIN} #" \
  "$SCRIPT_DIR/systemd/radeef-render.service" >"$UNIT.tmp"
install -m 644 "$UNIT.tmp" "$UNIT"
rm -f "$UNIT.tmp"
systemctl daemon-reload
systemctl enable radeef-render.service >/dev/null
systemctl restart radeef-render.service

for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
    log "radeef-render is healthy: $(curl -fsS "http://127.0.0.1:$PORT/health")"
    rm -rf "$RENDER_DIR/current.old" "$UNIT.old"
    [[ "$ACTION" == "install" ]] && log "next: sudo ops/render-setup.sh --configure-tenants [--mode docker]"
    exit 0
  fi
  sleep 1
done
warn "radeef-render did not become healthy; last logs:"
journalctl -u radeef-render.service -n 40 --no-pager >&2 || true
if [[ -d "$RENDER_DIR/current.old" || -f "$UNIT.old" ]]; then
  warn "rolling back to the previous files / unit"
  if [[ -d "$RENDER_DIR/current.old" ]]; then rm -rf "$RENDER_DIR/current" && mv "$RENDER_DIR/current.old" "$RENDER_DIR/current"; fi
  if [[ -f "$UNIT.old" ]]; then mv -f "$UNIT.old" "$UNIT" && systemctl daemon-reload; fi
  systemctl restart radeef-render.service || true
fi
exit 1
