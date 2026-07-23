#!/usr/bin/env bash
# repro-diff.sh <dirA> <dirB> — compare package files (*.ipk/*.apk) across two build runs.
# Indexes are excluded: apk's ECDSA signature is randomized by design (spec §7).
set -euo pipefail
a=$1 b=$2
fail=0
while read -r fa; do
  rel=${fa#"$a"/}
  fb="$b/$rel"
  if [ ! -f "$fb" ]; then echo "MISSING in B: $rel"; fail=1; continue; fi
  if cmp -s "$fa" "$fb"; then echo "identical: $rel"
  else echo "DIFFERS: $rel"; fail=1; fi
done < <(find "$a" \( -name '*.ipk' -o -name '*.apk' \) | sort)
exit "$fail"
