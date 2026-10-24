# Data Model: Thin Client

## Server (migration `0009_thin_client.sql`)

### device_auth_requests (NEW)

| Field | Type | Notes |
|---|---|---|
| device_code_hash | text PK | sha256 of the secret device code |
| user_code | text unique | `XXXXXXXX` normalized (no dash), shown as `XXXX-XXXX` |
| device_name | text | from the CLI (≤ 100) |
| status | text | `pending` → `approved` / `denied`; `consumed` after token handed out |
| workspace_id | text null | set on approval |
| device_id | text null | set on approval (devices row created then) |
| token_once | text null | plain device token, kept only until the first successful poll, then cleared |
| expires_at | timestamptz | created + 10 min |
| created_at | timestamptz | |

State: `pending --approve--> approved --poll--> consumed`; `pending --deny--> denied`;
any state past `expires_at` behaves as expired except `consumed`.

### login_tokens (ALTER)

- `next text null` — relative path to redirect to after sign-in (must start with `/`, not `//`).

### digests (ALTER)

- `origin_device_id text null` — device that drafted it (remote mode).
- `review_seq bigint` — set from the sequence `digests_review_seq` by a trigger on insert and on
  every status change; `/v1/sync/changes` returns rows after the device's last seen number.

### workspace_model_settings (NEW)

| Field | Type | Notes |
|---|---|---|
| workspace_id | text | PK part |
| role | text | PK part, only `chat` in this release |
| config | jsonb | `{provider, model, baseUrl?, apiKeyEnc?}` (key encrypted like `model_settings`) |
| updated_at | timestamptz | |

## Device store (SQLite)

### settings keys (NEW)

| Key | Value |
|---|---|
| `mode` | `local` (default) or `remote` |
| `remote.servers` | JSON `[{url, workspace_id, device_id, email?}]` |
| `sync.default_target` | default server URL (existing key) |
| `remote.sync_projects` | JSON list of project keys with sync on (remote mode) |
| `remote.changes_cursor:<url>` | last applied change cursor |
| `remote.changes_at:<url>` | last pull time (ms) for throttling |

### remote_digest (NEW)

| Field | Type | Notes |
|---|---|---|
| target | text | server URL — PK part |
| agent | text | PK part |
| agent_session_id | text | PK part |
| project_key | text | for tombstones and listing |
| digest | text | JSON `SessionDigest` as drafted (or as edited on the server) |
| status | text | `draft`, `approved`, `discarded`, `deleted` |
| server_digest_id | text null | from the server's ingest response |
| version | integer null | |
| updated_at | integer | ms |

### outbox_item (payload flag)

- drafts use kind `digest_upsert` with `"draft": true` in the payload (existing device stores
  keep their kind CHECK constraint); delivered to `POST /v1/sync/drafts`, flag stripped.

Validation: the payload's `digest` must pass `SessionDigest::validate` before enqueue.
