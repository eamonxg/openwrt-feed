#!/usr/bin/env bash
# resolve-refs.sh <packages.json> <releases|snapshots>
# stdout: JSON array [{url, pkg, ref, langs}] — releases: up to 2 newest v* tags
# per package, OLDEST FIRST (build order); snapshots: default-branch HEAD sha.
set -euo pipefail
pkgs_file=$1 channel=$2
out='[]'
n=$(jq length "$pkgs_file")
for ((i=0; i<n; i++)); do
  entry=$(jq -c ".[$i]" "$pkgs_file")
  repo=$(jq -r .repo <<<"$entry")
  pkg=$(jq -r .pkg <<<"$entry")
  langs=$(jq -c '.langs // []' <<<"$entry")
  case "$repo" in *://*) url=$repo ;; *) url="https://github.com/$repo.git" ;; esac
  refs=()
  if [ "$channel" = releases ]; then
    # newest 2 tags, oldest first (sort -V ascending, keep the last two)
    while IFS= read -r t; do refs+=("$t"); done < <(
      git ls-remote --tags --refs "$url" 'v*' \
        | awk -F/ '{print $NF}' | sort -V | tail -n 2)
  else
    refs+=("$(git ls-remote "$url" HEAD | awk '{print $1}')")
  fi
  for ref in "${refs[@]}"; do
    out=$(jq -c --arg u "$url" --arg p "$pkg" --arg r "$ref" --argjson l "$langs" \
      '. + [{url:$u, pkg:$p, ref:$r, langs:$l}]' <<<"$out")
  done
done
printf '%s\n' "$out"
