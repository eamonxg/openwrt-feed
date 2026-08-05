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

# ------------------------------------------------------------- language ------
# LuCI's configured language, or empty when unset or "auto".
LUCI_LANG=$(uci -q get luci.main.lang 2>/dev/null || true)
[ "$LUCI_LANG" = auto ] && LUCI_LANG=""

lang_pkg_for() { # <pkg> — the matching i18n package name, or empty
  [ -n "$LUCI_LANG" ] || return 0
  case "$1" in
    luci-app-*) ;;
    *) return 0 ;;
  esac
  echo "luci-i18n-${1#luci-app-}-$LUCI_LANG"
}

# expand_langs — append each selected app's language pack to $SEL, but only if
# the index actually carries it. A language the feed does not build is skipped
# in silence; it must never take the main package down with it.
#
# in_feed consults every configured index, not only this feed, so a language
# pack already available from the official repository is accepted. That is the
# desired outcome — the user gets their translation either way.
expand_langs() {
  add=""
  for p in $SEL; do
    lp=$(lang_pkg_for "$p")
    [ -n "$lp" ] || continue
    in_feed "$lp" || continue
    case " $SEL $add " in *" $lp "*) continue ;; esac
    add="$add $lp"
  done
  SEL="$SEL$add"
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

# -------------------------------------------------------------- executing ---
confirm() { # <prompt> — auto-yes under YES=, otherwise read one line from fd 3
  [ -z "${YES:-}" ] || return 0
  printf '%s [Y/n] ' "$1"
  read -r reply <&3 || reply=""
  case "$reply" in n*|N*) return 1 ;; *) return 0 ;; esac
}

# unpin — clear an apk world constraint that would make the upgrade a no-op.
#
# apk records a package installed from a local file (`apk add ./foo.apk`, LuCI's
# upload-a-package button, an image built by installing files) as a checksum
# constraint in /etc/apk/world:
#
#   luci-app-aurora-config><Q1fucTFL1zNFoR3+oZeUvsEcJ2bd4=
#
# That constraint names one exact file, and the installed copy satisfies it. So
# `apk upgrade <pkg>` has nothing to solve, changes nothing, and still exits 0 —
# even a blanket `apk upgrade` skips the package. The user is left reading
# "Upgraded:" over a version that did not move.
#
# `apk add <pkg>` "adds or updates given constraints to WORLD" (apk-add(8)), so
# naming the package rewrites the constraint to the bare name and restores
# normal version tracking — permanently, including for later upgrades run by
# hand. It is a solve, not a download: with the constraint already bare it
# changes nothing.
#
# Best effort on purpose. Its only job is to clear a constraint, so a failure
# here must not decide the package's verdict — the upgrade that follows does
# that, and reports honestly if the constraint turned out to be the blocker.
#
# Its output is deliberately NOT silenced. Committing world reconciles the
# installed set against it, which can uninstall a package that is installed,
# absent from world, and depended on by nothing. Measured on a live router: one
# `apk add` took the box from 236 packages to 235 and removed a language pack
# without naming it. A one-line "OK: ... in N packages" before each upgrade is a
# cheap price for never hiding that.
#
# opkg has no equivalent construct, hence the apk guard.
unpin() { # <pkg>
  [ "$PM" = apk ] || return 0
  apk add "$1" || true
}

# run_selection — install or upgrade every name in $SEL, one at a time.
# Each call is guarded by `if`, which suspends `set -e`: a package that fails
# must not abandon the ones behind it. Installing three packages and then dying
# without a word is worse than reporting the one that broke.
#
# The summary has no "already up to date" bucket on purpose: whether an upgrade
# was a no-op is the package manager's statement, printed just above, not a
# conclusion this script draws.
run_selection() {
  did_add="" did_up="" bad=""
  for p in $SEL; do
    if is_installed "$p"; then verb=$UP; else verb=$ADD; fi
    echo ""
    echo "==> $PM $verb $p"
    # Only on the upgrade path: the install path is already an `apk add`, which
    # writes an unconstrained world entry by itself.
    if [ "$verb" = "$UP" ]; then unpin "$p"; fi
    if "$PM" "$verb" "$p"; then
      if [ "$verb" = "$UP" ]; then did_up="$did_up $p"; else did_add="$did_add $p"; fi
    else
      bad="$bad $p"
    fi
  done
  echo ""
  echo "Summary:"
  [ -z "$did_add" ] || echo "  Installed:$did_add"
  [ -z "$did_up" ]  || echo "  Upgraded:$did_up"
  [ -z "$bad" ]     || echo "  Failed:$bad"
  if [ -n "$bad" ]; then RC=1; else RC=0; fi
}

# ---------------------------------------------------------------- theme -----
# The static directory comes from the package's own file list, with two rules
# that the naive "first /www/luci-static/<dir> wins" reading gets wrong:
#
#   - "resources" is LuCI's *shared* asset directory, not a theme. Themes
#     routinely drop a file or two in there (menu overrides, extra JS), and it
#     sorts ahead of the theme's own directory in an apk listing. Picking it
#     points mediaurlbase at a directory holding no theme at all, which LuCI
#     never reports — it just goes on rendering whatever was active before.
#   - among what is left, prefer the luci-theme-<name> -> /luci-static/<name>
#     convention over whichever directory merely happens to come first.
#
# The convention is only the tie-break and the last-resort fallback, so a
# package that names its directory something else is still honoured.
theme_dir() { # <pkg>
  want=${1#luci-theme-}
  if [ "$PM" = apk ]; then
    files=$(apk info -L "$1" 2>/dev/null || true)
  else
    files=$(opkg files "$1" 2>/dev/null || true)
  fi
  d=$(printf '%s\n' "$files" \
      | sed -n 's|^/*www/luci-static/\([^/][^/]*\)/.*|\1|p' \
      | awk -v want="$want" '
          $0 == "resources" { next }
          $0 == want        { found = 1; exit }
          !first            { first = $0 }
          END               { print (found ? want : first) }')
  [ -n "$d" ] || d=$want
  echo "$d"
}

offer_theme() {
  themes=""
  for p in $did_add $did_up; do
    case "$p" in luci-theme-*) themes="$themes $p" ;; esac
  done
  [ -n "$themes" ] || return 0

  set -- $themes
  if [ $# -gt 1 ]; then
    echo ""
    echo "Installed themes:"
    i=1
    for t in $themes; do echo "  $i  $t"; i=$((i + 1)); done
    printf 'Set one as the active LuCI theme? Enter a number, or Enter to skip: '
    read -r reply <&3 || reply=""
    case "$reply" in
      ''|*[!0-9]*) return 0 ;;
    esac
    [ "$reply" -ge 1 ] && [ "$reply" -le $# ] || return 0
    eval "pick=\${$reply}"
  else
    pick=$1
    confirm "Set $pick as the active LuCI theme?" || return 0
  fi

  d=$(theme_dir "$pick")
  uci set "luci.main.mediaurlbase=/luci-static/$d"
  uci commit luci
  echo "Active theme set to $pick (/luci-static/$d)."
}

# ----------------------------------------------------------------- menu -----
is_sel() { case " $SEL " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }

toggle() { # <pkg>
  if is_sel "$1"; then
    new=""
    for q in $SEL; do [ "$q" = "$1" ] || new="$new $q"; done
    SEL=$new
  else
    SEL="$SEL $1"
  fi
}

# order_sel — re-order SEL to match the printed list. Pre-ticked packages seed
# SEL before any toggle appends, so without this the confirmation and the run
# order disagree with what the user just read.
order_sel() {
  ord=""
  for p in $ALL; do is_sel "$p" && ord="$ord $p"; done
  SEL=$ord
}

# menu — reprint-on-change checkbox list. No stty, no ANSI: this must work
# under BusyBox and any SSH client, and a Ctrl-C must never leave the user's
# terminal in a state the script has to undo.
#
# Any answer that leaves a usable selection ends the menu rather than redrawing
# it. Redrawing put the same prompt back underneath an answer the user had just
# given, which reads as if the answer had not registered; reviewing the choice
# belongs on the confirmation screen, which can send the user straight back
# here. Only "n" redraws, and only because an empty selection is the one answer
# there is nothing to confirm.
#
# SEL belongs to the caller, not to this function: coming back from the
# confirmation screen must reopen the menu on the selection already made.
menu() {
  while :; do
    echo ""
    i=1
    for p in $ALL; do
      if is_sel "$p"; then m=x; else m=" "; fi
      printf '  %2d  [%s] %-28s %-10s %s\n' \
        "$i" "$m" "$p" "$(state_field "$p" 3)" "$(status_text "$p")"
      lp=$(lang_pkg_for "$p")
      if [ -n "$lp" ] && is_sel "$p" && in_feed "$lp"; then
        printf '          + %s  (LuCI language)\n' "$lp"
      fi
      i=$((i + 1))
    done
    echo ""
    printf 'Toggle by number ("1 3"), "a" all, "n" none, "q" quit, Enter to confirm: '
    read -r reply <&3 || reply="q"
    case "$reply" in
      "")  if [ -n "$SEL" ]; then order_sel; return 0; fi
           echo "Nothing selected."; continue ;;
      q|Q) return 1 ;;
      a|A) SEL=$ALL; return 0 ;;
      n|N) SEL=""; echo "Nothing selected."; continue ;;
    esac
    bad=""
    for n in $reply; do
      case "$n" in
        ''|*[!0-9]*) bad="$bad $n"; continue ;;
      esac
      set -- $ALL
      if [ "$n" -ge 1 ] && [ "$n" -le $# ]; then
        eval "pick=\${$n}"
        toggle "$pick"
      else
        bad="$bad $n"
      fi
    done
    # Anything unparseable means the line did not land the way it was typed, so
    # redraw and let the user see where they actually are before moving on.
    if [ -n "$bad" ]; then echo "not a choice:$bad"; continue; fi
    if [ -n "$SEL" ]; then order_sel; return 0; fi
    echo "Nothing selected."
  done
}

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

RC=0

if [ -n "${PKGS+x}" ]; then
  SEL=""
  missing=""
  for p in $PKGS; do
    if in_feed "$p"; then SEL="$SEL $p"; else missing="$missing $p"; fi
  done
  if [ -n "$missing" ]; then
    echo "ERROR: not in this feed:$missing" >&2
    exit 1
  fi
  expand_langs
  run_selection
elif have_tty; then
  # Open fd 3 once. Redirecting each `read` from $TTY_DEV would rewind a
  # regular file to the start every time and spin forever.
  exec 3<"$TTY_DEV"
  SEL=""
  for p in $ALL; do
    is_installed "$p" && SEL="$SEL $p"      # already-installed start ticked:
  done                                      # a re-run upgrades what you have
                                            # and pulls in nothing new
  while :; do
    if menu; then
      # $picked is what the user actually ticked. SEL grows language packs just
      # below, and "back" has to restore the ticks rather than the expanded
      # list — otherwise the packs pile up and come back as hand-made choices.
      picked=$SEL
      expand_langs
      echo ""
      echo "Will run:"
      for p in $SEL; do
        if is_installed "$p"; then echo "  $PM $UP $p"; else echo "  $PM $ADD $p"; fi
      done
      if [ -n "${YES:-}" ]; then
        reply=y
      else
        printf 'Proceed? [Y/n], or "b" to change the selection: '
        read -r reply <&3 || reply=""
      fi
      case "$reply" in
        b|B)   SEL=$picked; continue ;;
        n*|N*) echo "Nothing done." ;;
        # offer_theme is deliberately absent from the PKGS= path: that path
        # exists for unattended runs, which must not rewrite the user's UCI
        # configuration.
        *)     run_selection; offer_theme ;;
      esac
    else
      echo "Nothing done."
    fi
    break
  done
else
  print_only
fi

exit "$RC"
