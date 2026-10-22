#!/usr/bin/env bash
# Smoke test of a running self-hosted server (used by CI and after upgrades):
# health, auth required, pair a device, sync one approved digest, ask through an open link,
# then delete it with a tombstone.  Usage: deploy/smoke.sh [base-url]   (reads deploy/.env)
set -euo pipefail
BASE="${1:-http://127.0.0.1:7465}"
DIR="$(cd "$(dirname "$0")" && pwd)"
OWNER="$(grep '^PAMA_OWNER_TOKEN=' "$DIR/.env" | cut -d= -f2-)"
j() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const v=JSON.parse(s);console.log(eval('v'+process.argv[1]))})" "$1"; }
post() { curl -fsS -X POST -H 'content-type: application/json' "$@"; }

curl -fsS "$BASE/v1/health" | grep -q '"mode":"selfhost"' && echo "✓ health"
test "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/v1/review")" = 401 && echo "✓ owner API needs auth"

CODE=$(post -H "authorization: Bearer $OWNER" -d '{}' "$BASE/v1/devices/pairing-code" | j .code)
TOKEN=$(post -d "{\"code\":\"$CODE\",\"device_name\":\"smoke\"}" "$BASE/v1/devices/pair" | j .token)
echo "✓ paired a device"

NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
post -H "authorization: Bearer $TOKEN" "$BASE/v1/sync/digests" -d "{
  \"outbox_id\": \"smoke-$NOW\", \"approved_at\": \"$NOW\", \"sync_enabled_at\": \"$NOW\",
  \"digest\": {\"schema_version\": 1,
    \"source\": {\"agent\": \"codex\", \"agent_session_id\": \"smoke-$NOW\", \"project_key\": \"example.com/smoke\", \"bundle_key\": \"smoke\", \"ended_at\": \"$NOW\"},
    \"goal\": \"Check that the self-hosted server answers.\",
    \"decisions\": [{\"id\": 1, \"what\": \"The smoke test server answers questions about smoke checks.\", \"why\": \"Operators need a quick health signal.\"}],
    \"outcome\": \"Smoke check passed.\", \"open_items\": [], \"modules\": [\"smoke\"], \"redactions\": {\"secret\": 0, \"pii\": 0}}}" >/dev/null
echo "✓ synced an approved digest"

BUNDLE=$(curl -fsS -H "authorization: Bearer $OWNER" "$BASE/v1/bundles" | j ".items.find(b=>b.key==='smoke').id")
SLUG=$(post -H "authorization: Bearer $OWNER" -d "{\"sources\":[{\"type\":\"bundle\",\"id\":\"$BUNDLE\"}],\"access_mode\":\"open\",\"suggested_questions\":[\"Does the server answer?\"]}" "$BASE/v1/links" | j .slug)
STATUS=$(post -d '{"question":"Does the smoke test server answer questions about smoke checks?"}' "$BASE/a/$SLUG/api/ask" | j .status)
echo "✓ Ask Link answered: $STATUS"

post -H "authorization: Bearer $TOKEN" "$BASE/v1/sync/tombstones" -d "{\"outbox_id\":\"smoke-t-$NOW\",\"source_type\":\"bundle\",\"source_key\":\"example.com/smoke#smoke\"}" >/dev/null
test "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/a/$SLUG/api/meta")" = 410 && echo "✓ tombstone took the link down"
