#!/usr/bin/env bash
# Resident memory of the running desktop app plus its sidecar (target ≤ 200 MB, plan.md).
# Usage: scripts/perf/desktop-memory.sh [pid-of-pama-desktop]
set -euo pipefail
pid="${1:-$(pgrep -x pama-desktop || pgrep -f 'pamA.app/Contents/MacOS' | head -1)}"
[ -z "$pid" ] && { echo "pama-desktop is not running" >&2; exit 1; }
kids=$(pgrep -P "$pid" | tr '\n' ' ')
total=0
for p in $pid $kids; do
  kb=$(ps -o rss= -p "$p" | tr -d ' ')
  printf "%-8s %6d MB  %s\n" "$p" $((kb / 1024)) "$(ps -o comm= -p "$p")"
  total=$((total + kb))
done
mb=$((total / 1024))
echo "total    ${mb} MB (target ≤ 200 MB)"
[ "$mb" -le 200 ]
