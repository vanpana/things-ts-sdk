#!/usr/bin/env bash
# Generates conformance/fixtures (the Go reference SDK's answers) and conformance/cases. Needs Go 1.25+ (network on
# first run). Nothing generated is committed: `npm run test:conformance` runs this, then the tests. The output is
# deterministic for a given pinned Go version (conformance/go-oracle/go.mod).
set -euo pipefail
cd "$(dirname "$0")"
command -v go >/dev/null || { echo "Go 1.25+ is required (https://go.dev/dl/)" >&2; exit 1; }
mkdir -p cases fixtures
node scripts/gen-cases-basic.ts
node scripts/gen-cases-state.ts
node scripts/gen-cases-client.ts
for c in base58 notes repeat state client; do
  # write to a temporary file first, so a failed run never truncates a committed fixture
  (cd go-oracle && go run . "$c" < "../cases/$c.json" > "../fixtures/$c.json.tmp") && mv "fixtures/$c.json.tmp" "fixtures/$c.json"
  echo "fixtures/$c.json"
done
