#!/usr/bin/env bash
# gen-manifest.sh <dist-dir> [carried-list] [live-manifest] — derive manifest.json from what
# actually exists (spec §5.2).
#
# Each channel/format also gets a build timestamp. A channel rebuilt in this run is stamped
# now; a channel carried forward from the live site keeps the stamp it already had, because
# its files were produced by that earlier build — stamping it now would claim a freshness it
# does not have. <carried-list> holds one "channel/format" per line (written by the deploy
# job's carry-forward step); <live-manifest> is the manifest those files came from.
set -euo pipefail
dist=$1 carried=${2:-} live=${3:-}
now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
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

built_at() { # $1=channel $2=fmt
  if [ -n "$carried" ] && [ -f "$carried" ] && grep -qxF "$1/$2" "$carried"; then
    # Carried forward: reuse the stamp from the manifest those files came from. Manifests
    # predating this field fall back to their global generated time.
    if [ -n "$live" ] && [ -f "$live" ]; then
      jq -r --arg c "$1" --arg f "$2" \
        '.built[$c][$f] // .generated // empty' "$live" 2>/dev/null | grep . && return 0
    fi
  fi
  printf '%s' "$now"
}

built_json() {
  jq -n \
    --arg ro "$(built_at releases opkg)" --arg ra "$(built_at releases apk)" \
    --arg so "$(built_at snapshots opkg)" --arg sa "$(built_at snapshots apk)" \
    '{releases:{opkg:$ro, apk:$ra}, snapshots:{opkg:$so, apk:$sa}}'
}

jq -n \
  --arg gen "$now" \
  --argjson built "$(built_json)" \
  --argjson ro "$(channel_json "$dist/releases/opkg")" \
  --argjson ra "$(channel_json "$dist/releases/apk")" \
  --argjson so "$(channel_json "$dist/snapshots/opkg")" \
  --argjson sa "$(channel_json "$dist/snapshots/apk")" \
  '{generated:$gen, built:$built,
    channels:{releases:{opkg:$ro, apk:$ra}, snapshots:{opkg:$so, apk:$sa}}}' \
  > "$dist/manifest.json"
