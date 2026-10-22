# HTTP API Contract: pamA server v1

Same API in local (sidecar), self-host and cloud modes. Base path `/v1`. JSON bodies, UTF-8.
Errors: `{ "error": { "code": string, "message": string } }` with the status codes listed.
Schemas referenced: [session-digest.schema.json](./session-digest.schema.json), entities in
[data-model.md](../data-model.md).

## Auth

| Caller | Mechanism |
|---|---|
| Device (desktop/CLI) | `Authorization: Bearer <device_token>` (issued by `POST /v1/devices/pair`) |
| Owner (console) | Session cookie after email magic link; in local mode a per-launch token on `127.0.0.1` |
| Asker (public link) | Signed httpOnly cookie scoped to `/a/<slug>` after access check |

## Device endpoints

| Method & path | Purpose | Request → Response | Errors |
|---|---|---|---|
| `POST /v1/devices/pair` | Exchange a one-time pairing code (shown in console) for a device token | `{code, device_name}` → `{device_id, token}` | 400, 410 code expired |
| `POST /v1/transcripts/digest` | **Local sidecar only.** Produce a draft digest from a Layer-1-redacted transcript (normalized events) | `{agent, agent_session_id, project_key, bundle_key, events[], redactions}` → `{digest_id, version, status:"draft"}` | 403 when called on a non-local server (raw-ish data must not reach remote servers), 422 |
| `POST /v1/sync/digests` | Upsert an **approved** digest to a remote server | `{outbox_id, digest: SessionDigest, approved_at}` → `{digest_id, version}` (idempotent on `outbox_id` / `digest_hash`) | 409 sync disabled for source, 422 schema |
| `POST /v1/sync/tombstones` | Delete a source's remote copies | `{outbox_id, source_type, source_id}` → `{deleted_items, degraded_links}` | 404 |
| `POST /v1/draft` | Hotkey draft answer | `{question, scope_hint?: source_ref[], shorter?: bool}` → `{status, answer?, citations[], confidence, suggested_scope: source_ref[]}` | 422 |

`status` ∈ `answered | refused`; `refused` includes `reason` ∈ `out_of_scope | low_confidence | denied_topic | guard_failed`.

## Owner endpoints

| Method & path | Purpose |
|---|---|
| `GET /v1/review` | Draft digests awaiting review (paged) |
| `POST /v1/digests/{id}/approve` | Approve (optionally with edited content → new version) `{content?}` |
| `POST /v1/digests/{id}/discard` | Discard a draft |
| `POST /v1/digests/{id}/withdraw` | Withdraw an approved digest (deactivates items) |
| `GET/PATCH /v1/projects/{id}` | `auto_approve`, `sync_enabled`, `sync_target` |
| `GET/PATCH /v1/bundles/{id}` | rename, `sync_enabled` |
| `POST /v1/bundles/{id}/split` | `{session_ids[], new_name}` → new bundle |
| `POST /v1/bundles/merge` | `{bundle_ids[], name}` |
| `POST /v1/suggest` | `{query}` → `{sources:[{ref, title, score, sessions, date_range, flagged_labels[]}]}` ranked; flagged sources `preselected:false` |
| `POST /v1/links` | Create link (fields per data-model `ask_links`; `pin` in clear only in request) → `{slug, url, suggested_questions[]}` |
| `GET /v1/links` · `GET/PATCH /v1/links/{slug}` | List, read, update settings / suggested questions |
| `POST /v1/links/{slug}/revoke` | Immediate revoke → 204 |
| `GET /v1/inbox` | Forwarded asks |
| `POST /v1/asks/{id}/reply` | `{text}` → shown on link page, emailed if visitor verified |
| `POST /v1/asks/{id}/dismiss` | Dismiss forwarded ask |
| `GET /v1/audit?link=&status=&from=&to=` | Ask log (paged), export `?format=csv` |
| `GET /v1/network-log` | Outbound connections (local mode and server) |

## Public (asker) endpoints — mounted at `/a/{slug}`

| Method & path | Purpose | Response | Errors |
|---|---|---|---|
| `GET /a/{slug}` | Ask Link web page (SPA) | HTML | 410 expired/revoked (no content), 404 |
| `GET /a/{slug}/api/meta` | Owner display name, title, coverage summary, access mode, suggested questions (only after access granted) | JSON | 401 needs access, 410 |
| `POST /a/{slug}/api/access` | `{pin}` or `{email}` (sends OTP) or `{email, otp}` | 204 + cookie | 401, 423 locked (15 min), 429 |
| `POST /a/{slug}/api/ask` | `{question}` → `{ask_id, status, answer?, citations:[{item_id, label}], language}` | JSON | 401, 410, 429 rate limit |
| `POST /a/{slug}/api/asks/{ask_id}/forward` | Forward refused question to owner | 202 | 409 already forwarded |
| `GET /a/{slug}/api/asks` | Visitor's own asks incl. owner replies | JSON | 401 |

Rules enforced by every public endpoint:

- Expired/revoked ⇒ 410 with an empty body apart from the error code (FR-016).
- Answers never reveal names of projects/bundles outside the link (FR-011, acceptance US2-4).
- Every call writes/updates an `asks` or `visitors` audit row (FR-017).
- Responses carry `X-Pama-Automated: true` and UI labels answers as automated (FR-014).

## Health

`GET /v1/health` → `{status:"ok", mode:"local|selfhost|cloud", db:"pg|pglite", version}`.
