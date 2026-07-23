#!/usr/bin/env bash
# preview.sh [port] — render the site the way a deploy would and serve it locally.
#
# site/index.html and site/install.sh carry __FEED_HOST__ / __USIGN_FPR__ / __APK_FPR__
# placeholders that only get substituted at deploy time, so opening those files directly shows
# the raw markers. This renders them with the real fingerprints (derived from keys/) and a
# stand-in host, against a manifest fetched from the live feed when reachable.
set -euo pipefail
cd "$(dirname "$0")/.."
port=${1:-8787}
host=${PREVIEW_HOST:-openwrt.example}
dist=$(mktemp -d)
trap 'rm -rf "$dist"' EXIT

mkdir -p "$dist"/{releases,snapshots}/{opkg,apk}
if [ -n "${PREVIEW_MANIFEST_URL:-}" ] && curl -fsS --max-time 10 "$PREVIEW_MANIFEST_URL" -o "$dist/manifest.json"; then
  echo "manifest: $PREVIEW_MANIFEST_URL"
else
  # Enough shape for the page to render its tables without any live feed.
  cat > "$dist/manifest.json" <<'EOF'
{"generated":"2026-01-01T00:00:00Z",
 "built":{"releases":{"opkg":"2026-01-01T00:00:00Z","apk":"2026-01-01T00:00:00Z"},
          "snapshots":{"opkg":"2026-01-01T00:00:00Z","apk":"2026-01-01T00:00:00Z"}},
 "channels":{
  "releases":{"opkg":[{"pkg":"luci-theme-aurora","version":"1.1.0-r20260711","file":"luci-theme-aurora_1.1.0-r20260711_all.ipk","size":206234,"sha256":"0"}],"apk":[]},
  "snapshots":{"opkg":[{"pkg":"luci-theme-aurora","version":"1.1.2-r20260723","file":"luci-theme-aurora_1.1.2-r20260723_all.ipk","size":206234,"sha256":"0"},
                       {"pkg":"luci-i18n-aurora-config-de","version":"26.193.44843~1de9ea1","file":"luci-i18n-aurora-config-de_26.193.44843~1de9ea1_all.ipk","size":7960,"sha256":"0"}],"apk":[]}}}
EOF
  echo "manifest: built-in sample (set PREVIEW_MANIFEST_URL to use a live one)"
fi

fpr=$(scripts/usign-fpr.sh keys/eamonxg.pub)
apk_fpr="SHA256:$(openssl pkey -pubin -in keys/eamonxg.pem -outform DER \
  | openssl dgst -sha256 -binary | openssl base64)"
scripts/render-site.sh site "$dist" "$host" "$fpr" "$apk_fpr"

echo "serving http://127.0.0.1:$port/  (host=$host, ctrl-c to stop)"
cd "$dist" && exec python3 -m http.server "$port" --bind 127.0.0.1
