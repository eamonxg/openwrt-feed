#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT

mkrepo() { # $1=path $2=default-branch $3...=tags
  local p=$1 b=$2; shift 2
  git init -q -b "$b" "$p"
  (cd "$p" && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
   for t in "$@"; do
     git -c user.email=t@t -c user.name=t commit -q --allow-empty -m "$t"
     git tag "$t"
   done)
}
mkrepo "$tmp/alpha" master v0.9.0 v0.10.0 v1.0.0   # sort -V must beat lexical: v0.9.0 < v0.10.0
mkrepo "$tmp/beta"  main   v0.1.0

cat > "$tmp/packages.json" <<EOF
[
  { "repo": "file://$tmp/alpha", "pkg": "alpha", "langs": ["zh-cn"] },
  { "repo": "file://$tmp/beta",  "pkg": "beta" }
]
EOF

rel=$(scripts/resolve-refs.sh "$tmp/packages.json" releases)
[ "$(jq -r 'map(select(.pkg=="alpha")) | map(.ref) | join(",")' <<<"$rel")" = "v0.10.0,v1.0.0" ] \
  || { echo "alpha releases wrong: $rel"; exit 1; }
[ "$(jq -r 'map(select(.pkg=="beta")) | length' <<<"$rel")" = "1" ] || { echo "beta count"; exit 1; }
[ "$(jq -r '.[0].langs | length' <<<"$rel")" = "1" ] || { echo "langs lost"; exit 1; }

snap=$(scripts/resolve-refs.sh "$tmp/packages.json" snapshots)
want=$(git -C "$tmp/beta" rev-parse main)
[ "$(jq -r 'map(select(.pkg=="beta")) | .[0].ref' <<<"$snap")" = "$want" ] \
  || { echo "snapshot sha wrong"; exit 1; }
