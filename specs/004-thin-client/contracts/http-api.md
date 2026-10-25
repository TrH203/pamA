# HTTP API additions (004)

All bodies JSON; errors `{error: {code, message}}` as today.

## Auth

### POST /v1/auth/device/start — public

Request `{device_name: string(1..100)}` →
`200 {device_code, user_code: "ABCD-EFGH", verification_uri, verification_uri_complete, interval: 2, expires_in: 600}`.
404 `not_found` in local mode.

### POST /v1/auth/device/token — public

Request `{device_code}` →
- `200 {device_id, token, workspace_id, server_version}` once after approval;
- `428 {error.code: "authorization_pending"}` while pending;
- `403 access_denied` if denied; `410 expired_token` if expired or already consumed.

### GET /v1/auth/device/lookup?code=ABCD-EFGH — owner

`200 {user_code, device_name, created_at, status}`; 404 unknown/expired.

### POST /v1/auth/device/approve — owner (session or owner token)

Request `{user_code}` → `200 {device_id}`; creates the `devices` row in the caller's workspace.
`404` unknown, `410` expired, `409` already decided.

### POST /v1/auth/device/deny — owner

Request `{user_code}` → `204`.

### POST /v1/auth/device/console-link — device token

`200 {url}` — one-time sign-in URL (5 min) for the device's workspace owner.
`409 no_owner_email` when the workspace has no email (self-host with owner token only).

### POST /v1/auth/login — public (CHANGED)

Accepts optional `next` (relative path, `^/(?!/)`), redirected to after `/v1/auth/callback`.

## Authorization change

A valid device token is accepted on every `/v1/*` owner route and acts in the device's workspace.
Local-only routes (`/v1/transcripts/digest`, `/v1/sync/pending`, `/v1/sync/ack`) still return
`403 local_only` on servers. Revoked/unknown → `401 unauthorized`.

## Sync

### POST /v1/sync/drafts — device token

Request `{outbox_id, digest: SessionDigest, project_name?, bundle_name?, sync_enabled_at}` →
`200 {digest_id, version, status: "draft" | "approved"}`. Idempotent per `outbox_id`. 409
`sync_disabled` when a newer tombstone exists (as `/v1/sync/digests`). Layer 2 runs at ingest.

### GET /v1/sync/changes?since=<cursor> — device token

`200 {changes: [{agent, agent_session_id, project_key, digest_id, version, status, digest?,
changed_at}], cursor}` — review decisions in the device's workspace after `cursor` (max 200).
`digest` is included for `approved` versions. `cursor` is opaque.

## Health (CHANGED)

`capabilities` adds `"device_login"`, `"drafts"`, `"changes"`.

## Models (CHANGED, cloud mode)

`PUT /v1/models/settings/chat` from a session or device writes the workspace override;
`GET /v1/models/settings` shows `scope: "workspace" | "server"` for chat;
`POST /v1/models/settings/chat/revert` from a session/device removes the override.
