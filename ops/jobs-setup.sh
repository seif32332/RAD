#!/usr/bin/env bash
# =============================================================================
# Radeef HRMS - install and enable the timers for EVERY background job (src/jobs/registry.ts).
#
# Usage (root):
#   ops/jobs-setup.sh            install ops/systemd/radeef-jobs@* into /etc/systemd/system and
#                                enable every radeef-jobs@<job>.timer
#   ops/jobs-setup.sh --check    only report which timers are missing or disabled (exit 1 if any)
#   ops/jobs-setup.sh --cron     print the equivalent /etc/cron.d/radeef-jobs lines instead
#
# The list of jobs is the list of timer files in ops/systemd. A unit test
# (src/lib/__tests__/ops-job-timers.test.ts, ARCH-018) keeps it equal to JOB_NAMES in
# src/jobs/registry.ts and to the job pattern in ops/run-jobs.sh.
# =============================================================================
set -euo pipefail
IFS=$'\n\t'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"

UNIT_SRC="$SCRIPT_DIR/systemd"
UNIT_DST="${UNIT_DST:-/etc/systemd/system}"
MODE="install"
case "${1:-}" in
  "") ;;
  --check) MODE="check" ;;
  --cron) MODE="cron" ;;
  -h|--help) sed -n '2,14p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
  *) die "unknown option: $1" ;;
esac

JOBS=()
shopt -s nullglob
for f in "$UNIT_SRC"/radeef-jobs@*.timer; do
  j="$(basename "$f" .timer)"
  JOBS+=("${j#radeef-jobs@}")
done
shopt -u nullglob
((${#JOBS[@]} > 0)) || die "no radeef-jobs@*.timer files in $UNIT_SRC"

if [[ "$MODE" == "cron" ]]; then
  # cron in Debian/Ubuntu ignores CRON_TZ: the times below assume the server runs on Riyadh time.
  for j in "${JOBS[@]}"; do
    cal="$(sed -n 's/^OnCalendar=//p' "$UNIT_SRC/radeef-jobs@$j.timer")"
    delay="$(sed -n 's/^RandomizedDelaySec=\([0-9]*\)min$/\1/p' "$UNIT_SRC/radeef-jobs@$j.timer")"
    if [[ "$cal" =~ \*:0/([0-9]+):00 ]]; then
      # Every N minutes (domain-events).
      printf '*/%d * * * * radeef /opt/radeef/src/ops/run-jobs.sh --jitter %d %s >>/var/log/radeef/jobs.log 2>&1\n' \
        "${BASH_REMATCH[1]}" "$((${delay:-0} * 60))" "$j"
      continue
    fi
    time="$(grep -o '[0-9][0-9]:[0-9][0-9]:[0-9][0-9]' <<<"$cal")"
    hh="${time%%:*}"; mm="${time#*:}"; mm="${mm%%:*}"
    dow='*'; [[ "$cal" == Fri* ]] && dow='5'
    printf '%d %d * * %s radeef /opt/radeef/src/ops/run-jobs.sh --jitter %d %s >>/var/log/radeef/jobs.log 2>&1\n' \
      "$((10#$mm))" "$((10#$hh))" "$dow" "$((${delay:-0} * 60))" "$j"
  done
  exit 0
fi

require_cmd systemctl
missing=0
for j in "${JOBS[@]}"; do
  unit="radeef-jobs@$j.timer"
  if [[ "$MODE" == "check" ]]; then
    if systemctl is-enabled --quiet "$unit" 2>/dev/null && systemctl is-active --quiet "$unit" 2>/dev/null; then
      log "$unit: enabled"
    else
      warn "$unit: NOT enabled"
      missing=$((missing + 1))
    fi
  fi
done
if [[ "$MODE" == "check" ]]; then
  ((missing == 0)) || die "$missing job timer(s) not enabled; run ops/jobs-setup.sh as root"
  exit 0
fi

[[ "$(id -u)" == "0" ]] || die "run as root"
install -m 0644 "$UNIT_SRC/radeef-jobs@.service" "$UNIT_DST/radeef-jobs@.service"
for j in "${JOBS[@]}"; do
  install -m 0644 "$UNIT_SRC/radeef-jobs@$j.timer" "$UNIT_DST/radeef-jobs@$j.timer"
done
systemctl daemon-reload
for j in "${JOBS[@]}"; do
  systemctl enable --now "radeef-jobs@$j.timer"
  log "enabled radeef-jobs@$j.timer"
done
systemctl list-timers 'radeef-jobs@*' --no-pager || true
