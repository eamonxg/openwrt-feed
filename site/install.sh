#!/bin/sh
# eamonxg OpenWrt feed installer — https://__FEED_HOST__
# Usage: wget -qO- https://__FEED_HOST__/install.sh | sh                   (snapshots, default)
#        wget -qO- https://__FEED_HOST__/install.sh | CHANNEL=releases sh  (stable releases)
set -e
HOST="__FEED_HOST__"
FPR="__USIGN_FPR__"
CHANNEL="${CHANNEL:-snapshots}"
[ "${1:-}" = "-s" ] && CHANNEL=snapshots
case "$CHANNEL" in
  releases|snapshots) ;;
  *) echo "invalid CHANNEL: $CHANNEL (releases|snapshots)" >&2; exit 1 ;;
esac

# Step 1: detect the package manager by its on-disk database — authoritative,
# unlike binary presence (both binaries can coexist) or OS version inference.
if [ -f /lib/apk/db/installed ]; then
  PM=apk
elif [ -f /usr/lib/opkg/status ]; then
  PM=opkg
else
  echo "Cannot detect the package manager:" >&2
  echo "neither apk db (/lib/apk/db/installed) nor opkg status (/usr/lib/opkg/status) exists." >&2
  exit 1
fi
command -v "$PM" >/dev/null 2>&1 || { echo "$PM database found but $PM binary is missing" >&2; exit 1; }
echo "Package manager: $PM  |  channel: $CHANNEL"

# drop_lines <file> <fixed-string> — remove our previous feed lines (idempotent re-runs,
# clean channel switches; other feeds' lines are untouched)
drop_lines() {
  [ -f "$1" ] || return 0
  grep -vF "$2" "$1" > "$1.tmp" || true
  mv "$1.tmp" "$1"
}

# Step 2: import the signing key and add the feed
if [ "$PM" = apk ]; then
  mkdir -p /etc/apk/keys /etc/apk/repositories.d
  wget -qO /etc/apk/keys/eamonxg.pem "https://$HOST/eamonxg.pem"
  drop_lines /etc/apk/repositories.d/customfeeds.list "https://$HOST/"
  echo "https://$HOST/$CHANNEL/apk/packages.adb" >> /etc/apk/repositories.d/customfeeds.list
else
  mkdir -p /etc/opkg/keys
  wget -qO "/etc/opkg/keys/$FPR" "https://$HOST/eamonxg.pub"
  drop_lines /etc/opkg/customfeeds.conf "src/gz eamonxg "
  echo "src/gz eamonxg https://$HOST/$CHANNEL/opkg" >> /etc/opkg/customfeeds.conf
fi

# Step 3: refresh the index
"$PM" update

[ "$PM" = apk ] && INSTALL_CMD="apk add" || INSTALL_CMD="opkg install"
echo ""
echo "Feed installed (channel: $CHANNEL). Available packages:"
for p in __PACKAGES__; do
  echo "  $INSTALL_CMD $p"
done
echo "Language packs: $INSTALL_CMD luci-i18n-aurora-config-<lang>  (e.g. zh-cn, de, ja)"
