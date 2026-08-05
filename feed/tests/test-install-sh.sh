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

# --- non-root exits early with a clear message -------------------------------
setup_sandbox opkg
run_install "" FAKE_UID=1000
[ "$rc" != 0 ] || { echo "FAIL: non-root run should exit non-zero"; fail=1; }
assert_out "must be run as root"
refute_log "opkg update"

# --- a failed key download names the missing TLS package ---------------------
setup_sandbox opkg
run_install "" FAKE_WGET_FAIL=1
[ "$rc" != 0 ] || { echo "FAIL: failed download should exit non-zero"; fail=1; }
assert_out "libustream-ssl-mbedtls"

# --- the printed listing reflects probed state ------------------------------
setup_sandbox opkg
run_install "" \
  FAKE_INSTALLED="luci-theme-shadcn" \
  FAKE_INSTALLED_VER="luci-theme-shadcn=1.0.1" \
  FAKE_AVAIL="luci-theme-aurora=1.1.0 luci-theme-shadcn=1.0.3 luci-app-aurora-config=2.0.0"
[ "$rc" = 0 ] || { echo "FAIL: listing run exited $rc"; echo "$out"; fail=1; }
assert_out "not installed"
assert_out "installed 1.0.1"
assert_log "opkg list-installed luci-theme-shadcn"
assert_log "opkg list luci-theme-aurora"

# --- PKGS= picks the verb per package ---------------------------------------
setup_sandbox opkg
run_install "" YES=1 PKGS="luci-theme-aurora luci-theme-shadcn" \
  FAKE_INSTALLED="luci-theme-shadcn" \
  FAKE_INSTALLED_VER="luci-theme-shadcn=1.0.1" \
  FAKE_AVAIL="luci-theme-aurora=1.1.0 luci-theme-shadcn=1.0.3"
[ "$rc" = 0 ] || { echo "FAIL: PKGS run exited $rc"; echo "$out"; fail=1; }
assert_log "opkg install luci-theme-aurora"
assert_log "opkg upgrade luci-theme-shadcn"
refute_log "opkg install luci-theme-shadcn"

# --- same split on apk ------------------------------------------------------
setup_sandbox apk
run_install "" YES=1 PKGS="luci-theme-aurora luci-theme-shadcn" \
  FAKE_INSTALLED="luci-theme-shadcn" \
  FAKE_INSTALLED_VER="luci-theme-shadcn=1.0.1" \
  FAKE_AVAIL="luci-theme-aurora=1.1.0 luci-theme-shadcn=1.0.3"
assert_log "apk add luci-theme-aurora"
assert_log "apk upgrade luci-theme-shadcn"

# --- apk: an upgrade is preceded by an `add` that clears the world pin -------
# apk records a checksum constraint in /etc/apk/world ("pkg><Q1...") for any
# package installed from a local .apk file rather than by name from a
# repository. That constraint is satisfied by the installed file, so
# `apk upgrade <pkg>` finds nothing to do and still exits 0 — a silent no-op
# the script would otherwise report as a successful upgrade. `apk add <pkg>`
# updates the world constraint to the bare name, which restores normal version
# tracking; the upgrade then behaves.
setup_sandbox apk
run_install "" YES=1 PKGS="luci-theme-shadcn" \
  FAKE_INSTALLED="luci-theme-shadcn" \
  FAKE_INSTALLED_VER="luci-theme-shadcn=1.0.1" \
  FAKE_AVAIL="luci-theme-shadcn=1.0.3"
order=$(grep -E '^apk (add|upgrade) ' "$tmp/log" | tr '\n' '|')
[ "$order" = "apk add luci-theme-shadcn|apk upgrade luci-theme-shadcn|" ] \
  || { echo "FAIL: apk upgrade not preceded by an unpinning add: $order"; fail=1; }

# --- apk: a fresh install stays a single add --------------------------------
# The install path already writes an unconstrained world entry, so adding an
# upgrade behind it would be a pointless second transaction.
setup_sandbox apk
run_install "" YES=1 PKGS="luci-theme-aurora" FAKE_AVAIL="luci-theme-aurora=1.1.0"
[ "$(grep -c '^apk add luci-theme-aurora$' "$tmp/log")" = 1 ] \
  || { echo "FAIL: fresh install should issue exactly one apk add"; cat "$tmp/log"; fail=1; }
refute_log "apk upgrade luci-theme-aurora"

# --- opkg has no world, so it gains no unpinning step -----------------------
setup_sandbox opkg
run_install "" YES=1 PKGS="luci-theme-shadcn" \
  FAKE_INSTALLED="luci-theme-shadcn" \
  FAKE_INSTALLED_VER="luci-theme-shadcn=1.0.1" \
  FAKE_AVAIL="luci-theme-shadcn=1.0.3"
assert_log "opkg upgrade luci-theme-shadcn"
refute_log "opkg install luci-theme-shadcn"

# --- apk: the unpinning add is best effort, the upgrade decides the verdict --
# If the add fails the upgrade is still attempted, and a genuinely broken
# package is still reported as Failed rather than silently swallowed.
setup_sandbox apk
run_install "" YES=1 PKGS="luci-theme-shadcn" \
  FAKE_INSTALLED="luci-theme-shadcn" \
  FAKE_INSTALLED_VER="luci-theme-shadcn=1.0.1" \
  FAKE_AVAIL="luci-theme-shadcn=1.0.3" \
  FAKE_FAIL="luci-theme-shadcn"
[ "$rc" != 0 ] || { echo "FAIL: a failed apk upgrade should exit non-zero"; echo "$out"; fail=1; }
assert_log "apk upgrade luci-theme-shadcn"
assert_out "Failed:"

# --- an unknown name in PKGS is an error, and nothing is installed -----------
setup_sandbox opkg
run_install "" YES=1 PKGS="luci-theme-nope" FAKE_AVAIL="luci-theme-aurora=1.1.0"
[ "$rc" != 0 ] || { echo "FAIL: unknown PKGS name should exit non-zero"; fail=1; }
assert_out "not in this feed"
refute_log "opkg install luci-theme-nope"

# --- one failing package does not abandon the rest --------------------------
setup_sandbox opkg
run_install "" YES=1 PKGS="luci-theme-aurora luci-app-aurora-config" \
  FAKE_AVAIL="luci-theme-aurora=1.1.0 luci-app-aurora-config=2.0.0" \
  FAKE_FAIL="luci-theme-aurora"
[ "$rc" != 0 ] || { echo "FAIL: a failed package should make the run exit non-zero"; fail=1; }
assert_log "opkg install luci-theme-aurora"
assert_log "opkg install luci-app-aurora-config"
assert_out "Failed:"

# --- toggling by number goes straight to the confirmation --------------------
# Fixture: shadcn is installed, so it starts ticked. "1" ticks aurora as well
# and ends the menu — the toggle prompt must not come back under an answer the
# user has already given. "y" answers Proceed, the last line skips the theme
# offer (two themes were touched, so that prompt takes a number).
setup_sandbox opkg
run_install $'1\ny\n\n' \
  FAKE_INSTALLED="luci-theme-shadcn" \
  FAKE_INSTALLED_VER="luci-theme-shadcn=1.0.1" \
  FAKE_AVAIL="luci-theme-aurora=1.1.0 luci-theme-shadcn=1.0.3 luci-app-aurora-config=2.0.0"
[ "$rc" = 0 ] || { echo "FAIL: menu run exited $rc"; echo "$out"; fail=1; }
assert_out "[x] luci-theme-shadcn"
assert_log "opkg install luci-theme-aurora"
assert_log "opkg upgrade luci-theme-shadcn"
refute_log "opkg install luci-app-aurora-config"

# --- "q" quits without touching anything ------------------------------------
setup_sandbox opkg
run_install $'q\n' FAKE_AVAIL="luci-theme-aurora=1.1.0"
[ "$rc" = 0 ] || { echo "FAIL: quit should exit 0"; fail=1; }
refute_log "opkg install luci-theme-aurora"

# --- invalid input reprompts instead of exiting -----------------------------
setup_sandbox opkg
run_install $'zzz\n9\nn\nq\n' FAKE_AVAIL="luci-theme-aurora=1.1.0"
[ "$rc" = 0 ] || { echo "FAIL: reprompt run exited $rc"; echo "$out"; fail=1; }
assert_out "not a choice"

# --- "a" ticks everything and confirms straight away ------------------------
# "a" leaves a usable selection, so like a toggle it must not put the same
# prompt back up; "y" answers Proceed and the last line skips the theme offer.
setup_sandbox opkg
run_install $'a\ny\n\n' \
  FAKE_AVAIL="luci-theme-aurora=1.1.0 luci-theme-shadcn=1.0.3 luci-app-aurora-config=2.0.0"
assert_log "opkg install luci-theme-aurora"
assert_log "opkg install luci-theme-shadcn"
assert_log "opkg install luci-app-aurora-config"
[ "$(grep -c 'Toggle by number' <<<"$out")" = 1 ] \
  || { echo "FAIL: \"a\" reprinted the toggle prompt"; echo "$out"; fail=1; }

# --- "n" is the one answer that has to redraw -------------------------------
# An empty selection has nothing to confirm, so the menu stays put and says so.
setup_sandbox opkg
run_install $'n\nq\n' \
  FAKE_INSTALLED="luci-theme-shadcn" \
  FAKE_AVAIL="luci-theme-aurora=1.1.0 luci-theme-shadcn=1.0.3 luci-app-aurora-config=2.0.0"
[ "$rc" = 0 ] || { echo "FAIL: \"n\" then quit exited $rc"; echo "$out"; fail=1; }
assert_out "Nothing selected."
refute_log "opkg upgrade luci-theme-shadcn"

# --- the language pack follows the app package ------------------------------
setup_sandbox opkg
run_install "" YES=1 PKGS="luci-app-aurora-config" FAKE_LANG="zh-cn" \
  FAKE_AVAIL="luci-app-aurora-config=2.0.0 luci-i18n-aurora-config-zh-cn=2.0.0"
assert_log "opkg install luci-app-aurora-config"
assert_log "opkg install luci-i18n-aurora-config-zh-cn"

# --- a language the feed does not carry is skipped, main package unaffected --
setup_sandbox opkg
run_install "" YES=1 PKGS="luci-app-aurora-config" FAKE_LANG="eo" \
  FAKE_AVAIL="luci-app-aurora-config=2.0.0"
[ "$rc" = 0 ] || { echo "FAIL: missing language pack must not fail the run"; echo "$out"; fail=1; }
assert_log "opkg install luci-app-aurora-config"
refute_log "opkg install luci-i18n-aurora-config-eo"

# --- lang=auto means no language pack ---------------------------------------
setup_sandbox opkg
run_install "" YES=1 PKGS="luci-app-aurora-config" FAKE_LANG="auto" \
  FAKE_AVAIL="luci-app-aurora-config=2.0.0 luci-i18n-aurora-config-auto=2.0.0"
refute_log "opkg install luci-i18n-aurora-config-auto"

# --- accepting the offer points LuCI at the theme's static directory --------
# The fixture file list opens with /www/luci-static/resources/, exactly as a
# real theme package does. That directory is LuCI's shared asset store, not a
# theme: pointing mediaurlbase at it leaves LuCI rendering the previous theme
# with no error anywhere, so the theme's own directory must win.
setup_sandbox opkg
run_install $'1\ny\ny\n' \
  FAKE_AVAIL="luci-theme-aurora=1.1.0 luci-theme-shadcn=1.0.3 luci-app-aurora-config=2.0.0"
assert_log "opkg install luci-theme-aurora"
assert_log "opkg files luci-theme-aurora"
assert_log "uci set luci.main.mediaurlbase=/luci-static/aurora"
refute_log "uci set luci.main.mediaurlbase=/luci-static/resources"
assert_log "uci commit luci"

# --- same on apk, where "resources" sorts first in the file listing ----------
setup_sandbox apk
run_install $'1\ny\ny\n' \
  FAKE_AVAIL="luci-theme-aurora=1.1.0 luci-theme-shadcn=1.0.3 luci-app-aurora-config=2.0.0"
assert_log "uci set luci.main.mediaurlbase=/luci-static/aurora"
refute_log "uci set luci.main.mediaurlbase=/luci-static/resources"

# --- declining leaves the configuration alone -------------------------------
setup_sandbox opkg
run_install $'1\ny\nn\n' \
  FAKE_AVAIL="luci-theme-aurora=1.1.0 luci-theme-shadcn=1.0.3 luci-app-aurora-config=2.0.0"
assert_log "opkg install luci-theme-aurora"
refute_log "uci commit luci"

# --- no theme installed, no offer -------------------------------------------
setup_sandbox opkg
run_install $'3\ny\n' \
  FAKE_AVAIL="luci-theme-aurora=1.1.0 luci-theme-shadcn=1.0.3 luci-app-aurora-config=2.0.0"
assert_log "opkg install luci-app-aurora-config"
refute_log "uci commit luci"

# --- "b" reopens the menu on the selection already made ---------------------
# "1" ticks aurora and lands on the confirmation, "b" goes back — aurora must
# still be ticked there — "3" adds the app, "y" runs, "n" declines the theme.
setup_sandbox opkg
run_install $'1\nb\n3\ny\nn\n' \
  FAKE_AVAIL="luci-theme-aurora=1.1.0 luci-theme-shadcn=1.0.3 luci-app-aurora-config=2.0.0"
[ "$rc" = 0 ] || { echo "FAIL: back-and-forth run exited $rc"; echo "$out"; fail=1; }
[ "$(grep -c 'luci-theme-aurora' <<<"$out")" -ge 2 ] \
  || { echo "FAIL: menu was not reprinted after \"b\""; echo "$out"; fail=1; }
assert_out "[x] luci-theme-aurora"
assert_log "opkg install luci-theme-aurora"
assert_log "opkg install luci-app-aurora-config"

# --- going back does not accumulate language packs --------------------------
# expand_langs runs before the confirmation, so "b" must restore the ticks
# rather than the expanded list; otherwise the pack reappears as a hand-made
# choice and, on a second pass, more than once.
setup_sandbox opkg
run_install $'3\nb\n\ny\n' FAKE_LANG="zh-cn" \
  FAKE_AVAIL="luci-app-aurora-config=2.0.0 luci-i18n-aurora-config-zh-cn=2.0.0 luci-theme-aurora=1.1.0 luci-theme-shadcn=1.0.3"
[ "$(grep -c '^opkg install luci-i18n-aurora-config-zh-cn$' "$tmp/log")" = 1 ] \
  || { echo "FAIL: language pack installed more than once"; cat "$tmp/log"; fail=1; }

# --- the run order matches the printed list order ---------------------------
# Pre-ticked packages seed the selection before any toggle appends to it, so
# without an explicit re-order shadcn (#2) would be acted on before aurora (#1)
# and the confirmation would contradict the list the user just read.
setup_sandbox opkg
run_install $'1\ny\nn\n' \
  FAKE_INSTALLED="luci-theme-shadcn" \
  FAKE_INSTALLED_VER="luci-theme-shadcn=1.0.1" \
  FAKE_AVAIL="luci-theme-aurora=1.1.0 luci-theme-shadcn=1.0.3 luci-app-aurora-config=2.0.0"
order=$(grep -E '^opkg (install|upgrade) ' "$tmp/log" | tr '\n' '|')
[ "$order" = "opkg install luci-theme-aurora|opkg upgrade luci-theme-shadcn|" ] \
  || { echo "FAIL: run order does not match list order: $order"; fail=1; }

exit "$fail"
