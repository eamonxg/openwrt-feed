#!/usr/bin/env bash
# verify-live.sh <host> — acceptance checks against the deployed feed (spec §12).
set -euo pipefail
cd "$(dirname "$0")/.."
host=$1
base="https://$host"
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
fail=0
chk() { if "$@"; then echo "ok: $*"; else echo "FAIL: $*"; fail=1; fi }

curl -fsS "$base/manifest.json" -o "$tmp/manifest.json"
curl -fsS "$base/install.sh" -o "$tmp/install.sh"
curl -fsS "$base/eamonxg.pub" -o "$tmp/eamonxg.pub"
curl -fsSI "$base/releases/opkg/Packages.gz" -o "$tmp/headers"

chk grep -qi '^content-type: application/octet-stream' "$tmp/headers"
chk bash -c "! grep -qi '^content-encoding:' '$tmp/headers'"
chk bash -c "! grep -q '__FEED_HOST__\|__USIGN_FPR__\|__PACKAGES__' '$tmp/install.sh'"
chk cmp -s "$tmp/eamonxg.pub" keys/eamonxg.pub
chk sh -n "$tmp/install.sh"

# every manifest file must exist remotely with matching size (download-measured:
# HEAD content-length is unreliable behind CDN chunked transfer)
while read -r line; do
  ch=$(cut -d' ' -f1 <<<"$line"); fmt=$(cut -d' ' -f2 <<<"$line")
  f=$(cut -d' ' -f3 <<<"$line"); size=$(cut -d' ' -f4 <<<"$line")
  got=$(curl -fsS -o /dev/null -w '%{size_download}' "$base/$ch/$fmt/$f" || echo FETCH-FAILED)
  if [ "$got" = "$size" ]; then echo "ok: $ch/$fmt/$f ($size bytes)"
  else echo "FAIL: $ch/$fmt/$f size $got != $size"; fail=1; fi
done < <(jq -r '.channels | to_entries[] | .key as $c | .value | to_entries[] | .key as $f
                | .value[] | "\($c) \($f) \(.file) \(.size)"' "$tmp/manifest.json")

# index signature verifies against the committed pubkey (needs usign locally; skip if absent)
USIGN_BIN=${USIGN_BIN:-$(command -v usign || echo "$HOME/.secrets/openwrt-feed/usign-bin")}
if [ -x "$USIGN_BIN" ]; then
  curl -fsS "$base/releases/opkg/Packages" -o "$tmp/Packages"
  curl -fsS "$base/releases/opkg/Packages.sig" -o "$tmp/Packages.sig"
  chk "$USIGN_BIN" -V -m "$tmp/Packages" -x "$tmp/Packages.sig" -p keys/eamonxg.pub
else
  echo "skip: usign not available locally (CI already verified in-action)"
fi
exit "$fail"
