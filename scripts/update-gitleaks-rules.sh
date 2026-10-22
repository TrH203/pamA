#!/usr/bin/env bash
# Vendor gitleaks' default rules (MIT). Do not edit rules/gitleaks.toml by hand.
set -euo pipefail
TAG="${1:-v8.30.1}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
base="https://raw.githubusercontent.com/gitleaks/gitleaks/${TAG}"
{
  echo "# Vendored from gitleaks ${TAG} (MIT, see rules/LICENSE-gitleaks). Do not edit."
  echo "# Update with: scripts/update-gitleaks-rules.sh <tag>"
  curl -fsSL "${base}/config/gitleaks.toml"
} > "${ROOT}/rules/gitleaks.toml"
curl -fsSL "${base}/LICENSE" > "${ROOT}/rules/LICENSE-gitleaks"
echo "rules/gitleaks.toml updated to ${TAG}"
