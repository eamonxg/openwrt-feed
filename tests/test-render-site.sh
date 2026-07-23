#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/dist"
mkmanifest() { cat > "$1" <<'EOF'
{"generated":"t","channels":{"releases":{"opkg":[{"pkg":"luci-theme-aurora"},{"pkg":"luci-i18n-aurora-config-de"}],"apk":[]},"snapshots":{"opkg":[{"pkg":"luci-theme-shadcn"}],"apk":[]}}}
EOF
}
mkmanifest "$tmp/dist/manifest.json"
scripts/render-site.sh site "$tmp/dist" "feed.example.test" "0b26f36ae0f4106d" "SHA256:Zm9vYmFyKw=="
[ -f "$tmp/dist/index.html" ] && [ -f "$tmp/dist/install.sh" ] && [ -f "$tmp/dist/_headers" ] \
  || { echo "site files missing"; exit 1; }
for a in neat-annotations.css geist-mono-variable.woff2 shantell-sans-500.woff2 \
         router-halftone.png paper-texture.jpg violet-node.png favicon.svg; do
  [ -f "$tmp/dist/assets/$a" ] || { echo "asset missing: $a"; exit 1; }
done
grep -q "feed.example.test" "$tmp/dist/install.sh" || { echo "host not substituted"; exit 1; }
grep -q "0b26f36ae0f4106d" "$tmp/dist/install.sh" || { echo "fpr not substituted"; exit 1; }
# the apk fingerprint contains / and + — it must survive sed unmangled
grep -qF "SHA256:Zm9vYmFyKw==" "$tmp/dist/index.html" || { echo "apk fpr not substituted"; exit 1; }
# package list derived from manifest: unique main packages, i18n excluded, sorted
grep -q "luci-theme-aurora luci-theme-shadcn" "$tmp/dist/install.sh" || { echo "package list not injected"; exit 1; }
! grep -q "luci-i18n-aurora-config-de" "$tmp/dist/install.sh" || { echo "i18n leaked into package list"; exit 1; }
! grep -rq "__FEED_HOST__\|__USIGN_FPR__\|__PACKAGES__" "$tmp/dist" || { echo "placeholder residue"; exit 1; }
sh -n "$tmp/dist/install.sh" || { echo "install.sh syntax"; exit 1; }
# residue guard must actually fire when a stray placeholder survives elsewhere in dist:
mkdir -p "$tmp/dist2"; mkmanifest "$tmp/dist2/manifest.json"
echo "__FEED_HOST__" > "$tmp/dist2/leftover.txt"
if scripts/render-site.sh site "$tmp/dist2" "h" "f" >/dev/null 2>&1; then
  echo "residue guard did not fire"; exit 1
fi
