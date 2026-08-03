#!/usr/bin/env bash
# render-config.sh <host> <d1-id>
# Substitute __HUB_HOST__ / __HUB_D1_ID__ in hub/wrangler.template.jsonc,
# writing hub/wrangler.jsonc (gitignored — never committed). Fails closed if
# any __HUB placeholder remains after substitution (mirrors feed's
# render-site.sh placeholder guard).
set -euo pipefail
host=$1 d1_id=$2

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
hub_root=$(cd "$here/.." && pwd)

sed \
  -e "s/__HUB_HOST__/$host/g" \
  -e "s/__HUB_D1_ID__/$d1_id/g" \
  "$hub_root/wrangler.template.jsonc" > "$hub_root/wrangler.jsonc"

if grep -q '__HUB' "$hub_root/wrangler.jsonc"; then
  echo "ERROR: unsubstituted __HUB placeholder remains in wrangler.jsonc" >&2
  exit 1
fi
