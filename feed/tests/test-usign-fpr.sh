#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
got=$(scripts/usign-fpr.sh tests/fixtures/keyring-test.pub)
[ "$got" = "0b26f36ae0f4106d" ] || { echo "expected 0b26f36ae0f4106d, got: $got"; exit 1; }
