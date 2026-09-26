#!/usr/bin/env sh
# Downloads the pinned Typst binary and font bundle into <dest>/bin and <dest>/fonts, verifying
# every file against typst.lock / fonts.lock. Used by ops/render-setup.sh, the Dockerfile and CI.
# Usage: scripts/fetch-assets.sh <dest> [arch]      (arch: x86_64 | aarch64, default: uname -m)
set -eu
HERE="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${1:?usage: fetch-assets.sh <dest> [arch]}"
ARCH="${2:-$(uname -m)}"
case "$ARCH" in amd64) ARCH=x86_64 ;; arm64) ARCH=aarch64 ;; esac

sha256_of() { sha256sum "$1" | cut -d' ' -f1; }
mkdir -p "$DEST/bin" "$DEST/fonts"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

line="$(grep -v '^#' "$HERE/typst.lock" | awk -v a="$ARCH" '$1 == a')"
[ -n "$line" ] || { echo "fetch-assets: no pinned Typst build for arch $ARCH" >&2; exit 1; }
tar_sha="$(echo "$line" | awk '{print $2}')"
bin_sha="$(echo "$line" | awk '{print $3}')"
url="$(echo "$line" | awk '{print $4}')"

if [ -f "$DEST/bin/typst" ] && [ "$(sha256_of "$DEST/bin/typst")" = "$bin_sha" ]; then
  echo "typst: already present ($bin_sha)"
else
  curl -fsSL --proto '=https' --tlsv1.2 -o "$TMP/typst.tar.xz" "$url"
  [ "$(sha256_of "$TMP/typst.tar.xz")" = "$tar_sha" ] || { echo "fetch-assets: typst tarball checksum mismatch" >&2; exit 1; }
  tar -xJf "$TMP/typst.tar.xz" -C "$TMP"
  [ "$(sha256_of "$TMP/typst-$ARCH-unknown-linux-musl/typst")" = "$bin_sha" ] || { echo "fetch-assets: typst binary checksum mismatch" >&2; exit 1; }
  install -m 755 "$TMP/typst-$ARCH-unknown-linux-musl/typst" "$DEST/bin/typst"
  echo "typst: installed ($bin_sha)"
fi

grep -v '^#' "$HERE/fonts.lock" | while read -r sha name url; do
  [ -n "$sha" ] || continue
  if [ -f "$DEST/fonts/$name" ] && [ "$(sha256_of "$DEST/fonts/$name")" = "$sha" ]; then continue; fi
  curl -fsSL --proto '=https' --tlsv1.2 -o "$TMP/$name" "$url"
  [ "$(sha256_of "$TMP/$name")" = "$sha" ] || { echo "fetch-assets: checksum mismatch for $name" >&2; exit 1; }
  install -m 644 "$TMP/$name" "$DEST/fonts/$name"
  echo "font: installed $name"
done
echo "$bin_sha" > "$DEST/bin/typst.sha256"
