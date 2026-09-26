#!/usr/bin/env bash
# Renders every fixture to PDF (+ PNG previews) inside a locked-down Typst container.
# Usage: ./render.sh [ppi]
set -uo pipefail
export MSYS_NO_PATHCONV=1
HERE="$(cd "$(dirname "$0")" && pwd -W 2>/dev/null || pwd)"
IMG=ghcr.io/typst/typst@sha256:032e292249bcd378480cc7c142cfa324b63ef8aadeb88d7e7230320c4c9c422f
TS=1790413200   # 2026-09-26T09:00:00Z, the fixtures' issuance instant
PPI="${1:-110}"
LOCK=(--rm --network none --read-only --user 65534:65534 --cap-drop ALL --security-opt no-new-privileges
      --memory 512m --pids-limit 64 -v "$HERE/work:/work:ro" -v "$HERE/fonts:/fonts:ro" -v "$HERE/out:/out")
rm -rf "$HERE/out"; mkdir -p "$HERE/out"
for dir in "$HERE"/work/F*; do
  f="$(basename "$dir")"
  docker run "${LOCK[@]}" "$IMG" compile --root "/work/$f" --font-path /fonts --ignore-system-fonts --ignore-embedded-fonts \
    --creation-timestamp $TS "/work/$f/main.typ" "/out/$f.pdf" 2> "$HERE/out/$f.stderr.txt"
  echo "$f pdf exit=$? stderr_bytes=$(wc -c < "$HERE/out/$f.stderr.txt")"
  # Reference text layer (xpdf 4.x pdftotext on the host); per page too, for pagination checks.
  pdftotext -enc UTF-8 "$HERE/out/$f.pdf" "$HERE/out/$f.txt"
  for p in 1 2 3; do pdftotext -enc UTF-8 -f $p -l $p "$HERE/out/$f.pdf" "$HERE/out/$f.p$p.txt" 2>/dev/null || rm -f "$HERE/out/$f.p$p.txt"; done
  docker run "${LOCK[@]}" "$IMG" compile --root "/work/$f" --font-path /fonts --ignore-system-fonts --ignore-embedded-fonts \
    --format png --ppi "$PPI" "/work/$f/main.typ" "/out/$f-{p}.png" 2>/dev/null
done
