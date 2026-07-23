#!/usr/bin/env bash
# render-site.sh <site-dir> <dist-dir> <host> <usign-fpr>
# Copy site files into dist, substitute placeholders, fail on any residue in dist.
# __PACKAGES__ is derived from dist/manifest.json (main packages, i18n excluded) —
# run gen-manifest.sh first.
set -euo pipefail
site=$1 dist=$2 host=$3 fpr=$4
[ -f "$dist/manifest.json" ] || { echo "ERROR: $dist/manifest.json missing — run gen-manifest.sh before render-site.sh" >&2; exit 1; }
pkgs=$(jq -r '[.channels[] | .[] | .[].pkg]
  | unique | map(select(startswith("luci-i18n-") | not)) | join(" ")' "$dist/manifest.json")
[ -n "$pkgs" ] || { echo "ERROR: no packages found in manifest.json" >&2; exit 1; }
cp "$site"/index.html "$site"/install.sh "$site"/_headers "$dist/"
mkdir -p "$dist/assets"
cp "$site"/assets/* "$dist/assets/"
for f in "$dist/index.html" "$dist/install.sh"; do
  sed -i.bak \
    -e "s/__FEED_HOST__/$host/g" \
    -e "s/__USIGN_FPR__/$fpr/g" \
    -e "s/__PACKAGES__/$pkgs/g" \
    "$f" && rm -f "$f.bak"
done
if grep -rl '__FEED_HOST__\|__USIGN_FPR__\|__PACKAGES__' "$dist"; then
  echo "ERROR: unsubstituted placeholders remain in dist" >&2
  exit 1
fi
