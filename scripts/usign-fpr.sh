#!/usr/bin/env bash
# Print the usign fingerprint (keynum) of a public key file.
# Key line 2 = base64(pkalg[2] || keynum[8] || pubkey[32]); fingerprint = keynum hex.
set -euo pipefail
[ -f "${1:-}" ] || { echo "usage: usign-fpr.sh <pubkey>" >&2; exit 2; }
fpr=$(sed -n 2p "$1" | base64 -d | dd bs=1 skip=2 count=8 2>/dev/null | od -An -tx1 | tr -d ' \n')
[ ${#fpr} -eq 16 ] || { echo "bad key file: $1" >&2; exit 1; }
printf '%s\n' "$fpr"
