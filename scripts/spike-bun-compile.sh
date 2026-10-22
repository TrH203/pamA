#!/usr/bin/env bash
# Spike R6: compile a minimal Hono + PGlite + pgvector program with `bun build --compile`
# and run it twice (initdb, then reopen). Usage: scripts/spike-bun-compile.sh [bun-target]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="${1:-bun-darwin-arm64}"
OUT="$(mktemp -d)"
BUN="${BUN:-npx -y bun@1}"
cd "${ROOT}/apps/server"
$BUN build spikes/bun/entry.ts --compile --target="${TARGET}" --outfile "${OUT}/pglite-spike"
ls -lh "${OUT}/pglite-spike"
"${OUT}/pglite-spike" "${OUT}/data"
"${OUT}/pglite-spike" "${OUT}/data"
rm -rf "${OUT}"
