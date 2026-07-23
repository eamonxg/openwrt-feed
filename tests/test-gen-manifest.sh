#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/dist/releases/opkg" "$tmp/dist/releases/apk" "$tmp/dist/snapshots/opkg" "$tmp/dist/snapshots/apk"
printf 'AAAA' > "$tmp/dist/releases/opkg/luci-theme-aurora_1.1.0-r1_all.ipk"
printf 'BB'   > "$tmp/dist/releases/opkg/luci-theme-aurora_1.0.0-r1_all.ipk"
printf 'CC'   > "$tmp/dist/releases/apk/luci-theme-aurora-1.1.0-r1.apk"
# real-world i18n apk names carry a luci-feed version with NO -rN tail (dot and tilde variants)
printf 'DD'   > "$tmp/dist/releases/apk/luci-i18n-aurora-config-de-26.192.49224.6b21ba7.apk"
printf 'EE'   > "$tmp/dist/releases/apk/luci-i18n-aurora-config-zh-cn-26.192.49224~6b21ba7.apk"
: > "$tmp/dist/releases/opkg/Packages"   # index files must NOT appear in manifest

scripts/gen-manifest.sh "$tmp/dist"
m="$tmp/dist/manifest.json"
[ -f "$m" ] || { echo "manifest missing"; exit 1; }
[ "$(jq -r '.channels.releases.opkg | length' "$m")" = "2" ] || { echo "opkg count"; exit 1; }
e=$(jq -c '.channels.releases.opkg[] | select(.file=="luci-theme-aurora_1.1.0-r1_all.ipk")' "$m")
[ "$(jq -r .pkg <<<"$e")" = "luci-theme-aurora" ] || { echo "pkg parse"; exit 1; }
[ "$(jq -r .version <<<"$e")" = "1.1.0-r1" ] || { echo "version parse"; exit 1; }
[ "$(jq -r .size <<<"$e")" = "4" ] || { echo "size"; exit 1; }
[ "$(jq -r .sha256 <<<"$e")" = "$(shasum -a 256 "$tmp/dist/releases/opkg/luci-theme-aurora_1.1.0-r1_all.ipk" | awk '{print $1}')" ] \
  || { echo "sha256"; exit 1; }
a=$(jq -c '.channels.releases.apk[] | select(.file=="luci-theme-aurora-1.1.0-r1.apk")' "$m")
[ "$(jq -r .pkg <<<"$a")" = "luci-theme-aurora" ] || { echo "apk pkg parse: $a"; exit 1; }
[ "$(jq -r .version <<<"$a")" = "1.1.0-r1" ] || { echo "apk version parse: $a"; exit 1; }
i=$(jq -c '.channels.releases.apk[] | select(.file=="luci-i18n-aurora-config-de-26.192.49224.6b21ba7.apk")' "$m")
[ "$(jq -r .pkg <<<"$i")" = "luci-i18n-aurora-config-de" ] || { echo "i18n apk pkg parse: $i"; exit 1; }
[ "$(jq -r .version <<<"$i")" = "26.192.49224.6b21ba7" ] || { echo "i18n apk version parse: $i"; exit 1; }
z=$(jq -c '.channels.releases.apk[] | select(.file=="luci-i18n-aurora-config-zh-cn-26.192.49224~6b21ba7.apk")' "$m")
[ "$(jq -r .pkg <<<"$z")" = "luci-i18n-aurora-config-zh-cn" ] || { echo "tilde apk pkg parse: $z"; exit 1; }
[ "$(jq -r .version <<<"$z")" = "26.192.49224~6b21ba7" ] || { echo "tilde apk version parse: $z"; exit 1; }
[ "$(jq -r '.channels.snapshots.opkg | length' "$m")" = "0" ] || { echo "empty channel"; exit 1; }
jq -e '.generated' "$m" >/dev/null || { echo "generated missing"; exit 1; }

# with no carry-forward info every channel is stamped with this run's time
[ "$(jq -r '.built.releases.opkg' "$m")" = "$(jq -r '.generated' "$m")" ] || { echo "built defaults to now"; exit 1; }

# carried-forward channels keep the stamp from the manifest their files came from,
# while channels rebuilt this run are stamped now
cat > "$tmp/live.json" <<'EOF'
{"generated":"2020-01-01T00:00:00Z",
 "built":{"releases":{"opkg":"2026-06-01T10:00:00Z","apk":"2026-06-01T10:00:00Z"},
          "snapshots":{"opkg":"2026-06-02T10:00:00Z","apk":"2026-06-02T10:00:00Z"}}}
EOF
printf 'releases/opkg\nreleases/apk\n' > "$tmp/carried.txt"
scripts/gen-manifest.sh "$tmp/dist" "$tmp/carried.txt" "$tmp/live.json"
[ "$(jq -r '.built.releases.opkg' "$m")" = "2026-06-01T10:00:00Z" ] || { echo "carried stamp not preserved"; exit 1; }
[ "$(jq -r '.built.snapshots.opkg' "$m")" = "$(jq -r '.generated' "$m")" ] || { echo "rebuilt channel not stamped now"; exit 1; }

# a manifest predating the built field falls back to its global generated time
cat > "$tmp/old-live.json" <<'EOF'
{"generated":"2026-05-05T05:05:05Z"}
EOF
scripts/gen-manifest.sh "$tmp/dist" "$tmp/carried.txt" "$tmp/old-live.json"
[ "$(jq -r '.built.releases.apk' "$m")" = "2026-05-05T05:05:05Z" ] || { echo "legacy fallback"; exit 1; }
