#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
fail=0
for t in test-*.sh; do
  [ -e "$t" ] || continue
  echo "== $t"
  if bash "$t"; then echo "   PASS"; else echo "   FAIL"; fail=1; fi
done
exit "$fail"
