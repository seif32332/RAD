#!/usr/bin/env bash
# AC-16: escape attempts inside the locked-down renderer container. Every probe must FAIL to compile.
export MSYS_NO_PATHCONV=1
HERE="$(cd "$(dirname "$0")" && pwd -W 2>/dev/null || pwd)"
IMG=ghcr.io/typst/typst@sha256:032e292249bcd378480cc7c142cfa324b63ef8aadeb88d7e7230320c4c9c422f
LOCK=(--rm --network none --read-only --user 65534:65534 --cap-drop ALL --security-opt no-new-privileges
      --memory 512m --pids-limit 64 -v "$HERE/work:/work:ro" -v "$HERE/fonts:/fonts:ro" -v "$HERE/out:/out")
for p in abs parent pkg; do
  msg=$(docker run "${LOCK[@]}" "$IMG" compile --root /work/_probe --font-path /fonts --ignore-system-fonts --ignore-embedded-fonts \
        "/work/_probe/$p.typ" "/out/probe-$p.pdf" 2>&1)
  code=$?
  echo "probe=$p exit=$code blocked=$([ $code -ne 0 ] && [ ! -f "$HERE/out/probe-$p.pdf" ] && echo yes || echo NO) :: $(echo "$msg" | grep -m1 -iE 'error' )"
done
# Identity + writable surface inside the container
docker run "${LOCK[@]}" --entrypoint sh "$IMG" -c 'id; touch /tmp/x 2>&1 | head -1; touch /work/x 2>&1 | head -1; wget -q -T 3 -O- https://packages.typst.org 2>&1 | head -1'
