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

[ "$(id -u)" = 0 ] || { echo "This installer must be run as root." >&2; exit 1; }

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

# fetch <url> <dest> — OpenWrt's default wget is uclient-fetch, which cannot do
# TLS without libustream-ssl. Say that, rather than surfacing a bare exit code.
fetch() {
  if wget -qO "$2" "$1"; then return 0; fi
  echo "" >&2
  echo "ERROR: could not fetch $1" >&2
  echo "If this router has no HTTPS support yet, install it and re-run:" >&2
  echo "  $PM $ADD libustream-ssl-mbedtls ca-bundle" >&2
  exit 1
}

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
  fetch "https://$HOST/eamonxg.pem" "$ROOT/etc/apk/keys/eamonxg.pem"
  drop_lines "$ROOT/etc/apk/repositories.d/customfeeds.list" "https://$HOST/"
  echo "https://$HOST/$CHANNEL/apk/packages.adb" >> "$ROOT/etc/apk/repositories.d/customfeeds.list"
else
  mkdir -p "$ROOT/etc/opkg/keys"
  fetch "https://$HOST/eamonxg.pub" "$ROOT/etc/opkg/keys/$FPR"
  drop_lines "$ROOT/etc/opkg/customfeeds.conf" "src/gz eamonxg "
  echo "src/gz eamonxg https://$HOST/$CHANNEL/opkg" >> "$ROOT/etc/opkg/customfeeds.conf"
fi

# Step 3: refresh the index
"$PM" update

ALL="__PACKAGES__"

# ---------------------------------------------------------------- probing ---
# Two kinds of fact, deliberately different in reliability:
#   installed-or-not — the decision input, straight from the package manager
#                      database, authoritative
#   version strings  — display only, best effort. opkg and apk version schemes
#                      are not comparable, so the script never orders them; it
#                      only ever shows them.

apk_ver() { # <pkg>; reads one `apk list` line on stdin, writes the version
  awk -v p="$1" '{ n = $1; sub("^" p "-", "", n); print n; exit }'
}

is_installed() { # <pkg>
  if [ "$PM" = apk ]; then
    [ -n "$(apk info -e "$1" 2>/dev/null)" ]
  else
    [ -n "$(opkg list-installed "$1" 2>/dev/null)" ]
  fi
}

installed_ver() { # <pkg>
  if [ "$PM" = apk ]; then
    apk list -I "$1" 2>/dev/null | apk_ver "$1"
  else
    opkg list-installed "$1" 2>/dev/null | awk -v p="$1" '$1 == p { print $3; exit }'
  fi
}

avail_ver() { # <pkg>
  if [ "$PM" = apk ]; then
    apk list "$1" 2>/dev/null | apk_ver "$1"
  else
    opkg list "$1" 2>/dev/null | awk -v p="$1" '$1 == p { print $3; exit }'
  fi
}

in_feed() { # <pkg> — is the name known to any configured index?
  if [ "$PM" = apk ]; then
    [ -n "$(apk list "$1" 2>/dev/null)" ]
  else
    [ -n "$(opkg list "$1" 2>/dev/null)" ]
  fi
}

# Field 2 of the state file carries two distinct facts and must not conflate
# them: "-" means not installed, "?" means installed but the version string
# could not be parsed. Storing empty for both would show an unparseable version
# as "not installed" while the executor still dispatched "upgrade" — the display
# and the decision would disagree, and the confirmation prompt is the user's
# last chance to catch a wrong verb.
probe_all() {
  : > "$TMP/state"
  for p in $ALL; do
    if is_installed "$p"; then iv=$(installed_ver "$p"); iv=${iv:-?}; else iv="-"; fi
    printf '%s\t%s\t%s\n' "$p" "$iv" "$(avail_ver "$p")" >> "$TMP/state"
  done
}

state_field() { # <pkg> <field-number>
  awk -F'\t' -v p="$1" -v n="$2" '$1 == p { print $n; exit }' "$TMP/state"
}

status_text() { # <pkg>
  iv=$(state_field "$1" 2)
  if [ "$iv" = "-" ]; then
    echo "not installed"
  else
    echo "installed $iv -> upgrade"
  fi
}

probe_all

print_only() {
  echo ""
  echo "Feed installed (channel: $CHANNEL). Available packages:"
  for p in $ALL; do
    av=$(state_field "$p" 3)
    printf '  %-28s %-10s %s\n' "$p" "${av:--}" "$(status_text "$p")"
  done
  echo ""
  echo "Install with:"
  for p in $ALL; do
    if is_installed "$p"; then echo "  $PM $UP $p"; else echo "  $PM $ADD $p"; fi
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
