#!/usr/bin/env bash
# Downloads the pinned font bundle into fonts/ and verifies every file against fonts.lock.
set -euo pipefail
cd "$(dirname "$0")"; mkdir -p fonts
grep -v '^#' fonts.lock | while read -r sha name url; do
  [ -f "fonts/$name" ] || curl -sSfL -o "fonts/$name" "$url"
  echo "$sha  fonts/$name" | sha256sum -c -
done
curl -sSfL -o fonts/OFL.txt https://github.com/google/fonts/raw/main/ofl/ibmplexsansarabic/OFL.txt
