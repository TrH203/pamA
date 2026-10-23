#!/usr/bin/env bash
# Generate TypeScript types from #[typeshare] structs in pama-core (typeshare-cli 1.13).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
typeshare "${ROOT}/crates/pama-core" --lang=typescript --output-file="${ROOT}/packages/types/src/generated.ts"
