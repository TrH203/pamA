#!/usr/bin/env bash
# Build the local server as a single binary for the desktop app (research R6):
#   crates/pama-desktop/src-tauri/binaries/pama-server-<rust target triple>
# Usage: scripts/build-sidecar.sh [bun-target ...]   (default: this machine)
# Rules, prompts, migrations and the web build are bundled as app resources, not in the binary.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUN="${BUN:-npx -y bun@1}"
OUT="${ROOT}/crates/pama-desktop/src-tauri/binaries"
mkdir -p "${OUT}"

triple() {
  case "$1" in
    bun-darwin-arm64) echo aarch64-apple-darwin ;;
    bun-darwin-x64) echo x86_64-apple-darwin ;;
    bun-windows-x64) echo x86_64-pc-windows-msvc ;;
    bun-linux-x64) echo x86_64-unknown-linux-gnu ;;
    *) echo "unknown target $1" >&2; exit 1 ;;
  esac
}

host() {
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64) echo bun-darwin-arm64 ;;
    Darwin-x86_64) echo bun-darwin-x64 ;;
    Linux-x86_64) echo bun-linux-x64 ;;
    MINGW*|MSYS*|CYGWIN*) echo bun-windows-x64 ;;
    *) echo "unsupported host" >&2; exit 1 ;;
  esac
}

targets=("$@")
[ ${#targets[@]} -eq 0 ] && targets=("$(host)")

cd "${ROOT}/apps/server"
for t in "${targets[@]}"; do
  ext=""
  [[ "$t" == bun-windows-* ]] && ext=".exe"
  out="${OUT}/pama-server-$(triple "$t")${ext}"
  $BUN build src/sidecar.ts --compile --minify --target="$t" --outfile "$out"
  ls -lh "$out"
done
