#!/usr/bin/env bash
# Regenerates conformance/fixtures from the Go reference SDK. Needs Go 1.25+ (network on first run).
# Inputs live in conformance/cases; expected outputs in conformance/fixtures are committed so the TypeScript
# tests need no Go toolchain. Run this when the pinned upstream version changes.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p cases fixtures
node scripts/gen-cases-basic.ts
node scripts/gen-cases-state.ts
node scripts/gen-cases-client.ts
for c in base58 notes repeat state client; do
  (cd go-oracle && go run . "$c" < "../cases/$c.json" > "../fixtures/$c.json")
  echo "fixtures/$c.json"
done
