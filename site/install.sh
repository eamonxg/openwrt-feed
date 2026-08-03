#!/bin/sh
# eamonxg OpenWrt feed installer — https://__FEED_HOST__
# Usage: wget -qO- https://__FEED_HOST__/install.sh | sh                   (snapshots, default)
#        wget -qO- https://__FEED_HOST__/install.sh | CHANNEL=releases sh  (stable releases)
#        wget -qO- https://__FEED_HOST__/install.sh | PKGS="luci-theme-aurora" YES=1 sh
set -e
HOST="__FEED_HOST__"
FPR="__USIGN_FPR__"
CHANNEL="${CHANNEL:-snapshots}"
ROOT="${ROOT:-}"
TTY_DEV="${TTY_DEV-/dev/tty}"
[ "${1:-}" = "-s" ] && CHANNEL=snapshots
case "$CHANNEL" in
  releases|snapshots) ;;
  *) echo "invalid CHANNEL: $CHANNEL (releases|snapshots)" >&2; exit 1 ;;
esac

TMP=$(mktemp -d) || { echo "cannot create a temporary directory" >&2; exit 1; }
trap 'rm -rf "$TMP"' EXIT INT TERM

# Step 1: detect the package manager by its on-disk database — authoritative,
# unlike binary presence (both binaries can coexist) or OS version inference.
if [ -f "$ROOT/lib/apk/db/installed" ]; then
  PM=apk; ADD=add; UP=upgrade
elif [ -f "$ROOT/usr/lib/opkg/status" ]; then
  PM=opkg; ADD=install; UP=upgrade
else
  echo "Cannot detect the package manager:" >&2
  echo "neither apk db ($ROOT/lib/apk/db/installed) nor opkg status ($ROOT/usr/lib/opkg/status) exists." >&2
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
  mkdir -p "$ROOT/etc/apk/keys" "$ROOT/etc/apk/repositories.d"
  wget -qO "$ROOT/etc/apk/keys/eamonxg.pem" "https://$HOST/eamonxg.pem"
  drop_lines "$ROOT/etc/apk/repositories.d/customfeeds.list" "https://$HOST/"
  echo "https://$HOST/$CHANNEL/apk/packages.adb" >> "$ROOT/etc/apk/repositories.d/customfeeds.list"
else
  mkdir -p "$ROOT/etc/opkg/keys"
  wget -qO "$ROOT/etc/opkg/keys/$FPR" "https://$HOST/eamonxg.pub"
  drop_lines "$ROOT/etc/opkg/customfeeds.conf" "src/gz eamonxg "
  echo "src/gz eamonxg https://$HOST/$CHANNEL/opkg" >> "$ROOT/etc/opkg/customfeeds.conf"
fi

# Step 3: refresh the index
"$PM" update

ALL="__PACKAGES__"

print_only() {
  echo ""
  echo "Feed installed (channel: $CHANNEL). Available packages:"
  for p in $ALL; do
    echo "  $PM $ADD $p"
  done
  echo "Language packs: $PM $ADD luci-i18n-aurora-config-<lang>  (e.g. zh-cn, de, ja)"
}

# /dev/tty always exists on OpenWrt (devtmpfs), but opening it fails with ENXIO
# when the process has no controlling terminal — ssh one-shot commands, cron, CI.
# Probe by attempting the open, not by testing for the file.
have_tty() {
  [ -n "$TTY_DEV" ] || return 1
  (exec 3<"$TTY_DEV") 2>/dev/null
}

if have_tty; then
  print_only
else
  print_only
fi
