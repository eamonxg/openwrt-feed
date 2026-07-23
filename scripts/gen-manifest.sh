#!/usr/bin/env bash
# gen-manifest.sh <dist-dir> — derive manifest.json from what actually exists (spec §5.2).
set -euo pipefail
dist=$1
sha() { if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | awk '{print $1}'; }
fsize() { if stat -c %s "$1" >/dev/null 2>&1; then stat -c %s "$1"; else stat -f %z "$1"; fi; }

channel_json() { # $1=dir
  local out='[]' f base pkg ver
  for f in "$1"/*.ipk "$1"/*.apk; do
    [ -f "$f" ] || continue
    base=$(basename "$f")
    case "$base" in
      *.ipk) pkg=${base%%_*}; ver=${base#*_}; ver=${ver%_all.ipk} ;;
      *.apk) # apk names: <pkg>-<version>.apk where version starts at the first "-<digit>"
             # boundary (covers 1.1.0-r1 and 26.192.49224.6b21ba7 / ~6b21ba7 styles)
             stem=${base%.apk}
             pkg=${stem%%-[0-9]*}
             ver=${stem#"$pkg"-} ;;
    esac
    out=$(jq -c --arg p "$pkg" --arg v "$ver" --arg f "$base" \
      --argjson s "$(fsize "$f")" --arg h "$(sha "$f")" \
      '. + [{pkg:$p, version:$v, file:$f, size:$s, sha256:$h}]' <<<"$out")
  done
  printf '%s' "$out"
}

jq -n \
  --arg gen "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --argjson ro "$(channel_json "$dist/releases/opkg")" \
  --argjson ra "$(channel_json "$dist/releases/apk")" \
  --argjson so "$(channel_json "$dist/snapshots/opkg")" \
  --argjson sa "$(channel_json "$dist/snapshots/apk")" \
  '{generated:$gen, channels:{releases:{opkg:$ro, apk:$ra}, snapshots:{opkg:$so, apk:$sa}}}' \
  > "$dist/manifest.json"
