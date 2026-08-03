#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
REPO=$PWD
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
fail=0

# Render install.sh the way the site build does, so tests exercise the shipped
# file rather than the placeholder template.
render() {
  sed -e 's/__FEED_HOST__/feed.example.test/g' \
      -e 's/__USIGN_FPR__/0b26f36ae0f4106d/g' \
      -e 's/__PACKAGES__/luci-theme-aurora luci-theme-shadcn luci-app-aurora-config/g' \
      "$REPO/site/install.sh" > "$tmp/install.sh"
  chmod +x "$tmp/install.sh"
}

# setup_sandbox <pm>   pm = apk | opkg
setup_sandbox() {
  rm -rf "$tmp/root" "$tmp/log"
  mkdir -p "$tmp/root/etc" "$tmp/root/lib/apk/db" "$tmp/root/usr/lib/opkg"
  if [ "$1" = apk ]; then touch "$tmp/root/lib/apk/db/installed"
  else touch "$tmp/root/usr/lib/opkg/status"; fi
  : > "$tmp/log"
}

# run_install <stdin-for-tty|""> [env assignments...]
# Returns the script's exit code in $rc, its output in $out.
run_install() {
  local ttyin=$1; shift
  if [ -n "$ttyin" ]; then printf '%s' "$ttyin" > "$tmp/ttyin"
  else rm -f "$tmp/ttyin"; fi
  set +e
  out=$(env PATH="$REPO/tests/fixtures/fake-bin:$PATH" \
        ROOT="$tmp/root" \
        TTY_DEV="${ttyin:+$tmp/ttyin}" \
        FAKE_LOG="$tmp/log" \
        "$@" sh "$tmp/install.sh" 2>&1)
  rc=$?
  set -e
}

assert_log() { grep -qxF "$1" "$tmp/log" || { echo "FAIL: expected log line: $1"; cat "$tmp/log"; fail=1; }; }
refute_log() { grep -qxF "$1" "$tmp/log" && { echo "FAIL: unexpected log line: $1"; fail=1; }; return 0; }
assert_out() { grep -qF "$1" <<<"$out" || { echo "FAIL: expected output: $1"; echo "$out"; fail=1; }; }

# --- no controlling terminal: add the feed, print commands, exit 0 -----------
render
setup_sandbox opkg
run_install "" FAKE_AVAIL="luci-theme-aurora=1.1.0"
[ "$rc" = 0 ] || { echo "FAIL: no-tty run exited $rc"; echo "$out"; fail=1; }
assert_log "opkg update"
assert_out "opkg install luci-theme-aurora"
refute_log "opkg install luci-theme-aurora"
grep -q "src/gz eamonxg https://feed.example.test/snapshots/opkg" \
  "$tmp/root/etc/opkg/customfeeds.conf" || { echo "FAIL: feed line not written"; fail=1; }

exit "$fail"
