# Data Model: pamA MVP v0.1

**Spec**: [spec.md](./spec.md) · **Research**: [research.md](./research.md)

Two stores:

- **Device store** (Rust, SQLite, per machine): capture state and outbox. Raw transcripts are
  never copied; only their path and hash are recorded.
- **Server store** (PostgreSQL 16 + pgvector, or PGlite in local mode): everything shareable.
  Every table below except `workspaces` carries `workspace_id`; every read of digest data goes
  through the scoped repository (and RLS where available).

IDs are ULIDs (text, sortable) unless noted. Timestamps are `timestamptz` (UTC).

## Device store (SQLite)

### captured_session
| Field | Type | Rules |
|---|---|---|
| id | text | ULID |
| agent | enum `claude_code \| codex` | |
| agent_session_id | text | unique per agent |
| transcript_path | text | absolute path on device; never sent |
| transcript_sha256 | text | detects re-processing |
| cwd, repo_remote, git_branch | text | project/bundle hints |
| status | enum | see state machine |
| error | text? | reason if `failed` |
| ended_at, processed_at | timestamp | |

State: `detected → redacting → digesting → ready_for_review → submitted` · any → `failed` (retry
with backoff, max 5) · `skipped` (project not enabled).

### outbox_item
| Field | Type | Rules |
|---|---|---|
| id | text | ULID; idempotency key |
| kind | enum `digest_upsert \| source_tombstone \| bundle_change` | |
| target | text | server id (local sidecar or remote) |
| payload | json | redacted content only |
| attempts, next_attempt_at | int, timestamp | exponential backoff |
| status | enum `pending \| sent \| dead` | delivered exactly once via idempotency key |

### settings (key/value)
hotkey, answer_source (`local \| server \| auto`), strict_offline (bool), declared_hosts (list),
providers (refs to keychain entries — secrets themselves live in OS keychain).

## Server store

### workspaces
| Field | Type | Rules |
|---|---|---|
| id | text | |
| owner_email | text? | null in pure local mode |
| default_deny_labels | text[] | subset of `business_sensitive, infra, customer` |
| auto_approve | bool | default false |
| embed_model, embed_dim | text, int | default `bge-m3`, 1024 |
| answer_threshold | real | default 0.7 cloud models / 0.8 local |

### devices
id, workspace_id, name, token_hash (argon2id), last_seen_at, revoked_at. A revoked device cannot
sync; its pending items are rejected with 401.

### projects
id, workspace_id, name, repo_key (normalized remote URL or path hash), auto_approve (bool?,
overrides workspace when not null), sync_enabled (bool, default false), sync_target (text?).

### bundles
id, workspace_id, project_id, name, key (e.g. git branch), sync_enabled (bool?, inherits project
when null), created_at. Owners can rename, split (move sessions), merge (re-point sessions).
`name` is the display name; `name_source` (`key` \| `suggested` \| `owner`) says where it came from
and `name_updated_at` when it last changed — see
[002 data model](../002-bundle-names-branches/data-model.md).

### sessions
id, workspace_id, project_id, bundle_id, agent, agent_session_id, started_at, ended_at,
redaction_counts (jsonb `{secret:int, pii:int}`), bundle_pinned (bool; true once the owner moved the
session). Unique (workspace_id, agent, agent_session_id). Every branch a session visited is kept in
`session_branches` (002).

### digests (versioned, immutable rows)
| Field | Type | Rules |
|---|---|---|
| id | text | |
| session_id | text | FK |
| version | int | starts at 1; edit ⇒ new row version+1 |
| digest_hash | text | sha256 of canonical JSON; unique per session ⇒ idempotent upserts |
| content | jsonb | validates against `contracts/session-digest.schema.json` |
| status | enum | see state machine |
| approved_at, approved_by | | |
| prompt_version, model | text | provenance |

State: `draft → approved → superseded` (when a newer version is approved) ·
`draft → discarded` · `approved → withdrawn` (late leak detected or owner action).
Only `approved` digests (latest version per session) are retrievable.

### digest_items (retrieval unit)
| Field | Type | Rules |
|---|---|---|
| id | text | stable within a digest version, e.g. `dg_…#d3` |
| digest_id, session_id, bundle_id, project_id | text | denormalized for scoped filtering |
| kind | enum `goal \| decision \| outcome \| open_item \| module` | |
| text | text | English, ≤ 1,000 chars |
| rationale, alternatives | text?, text[] | decisions only |
| labels | text[] | from Layer-2 classifier |
| embedding | vector(embed_dim) | HNSW index (cosine) |
| tsv | tsvector | full-text |
| active | bool | false when digest not latest-approved or source tombstoned |

### ask_links
| Field | Type | Rules |
|---|---|---|
| slug | text PK | 8+ chars, base32, unguessable |
| workspace_id | text | |
| title | text | shown to askers |
| source_refs | jsonb | list of `{type: project\|bundle\|session, id}`; resolved to session ids at query time |
| detail | enum `headline \| summary \| technical` | default `summary` |
| deny_labels | text[] | ⊇ workspace defaults |
| deny_topics | text[] | free-text topics checked by guard |
| instruction | text? | ≤ 2,000 chars, treated as owner policy |
| access_mode | enum `open \| pin \| email_otp \| allowlist` | default `pin` |
| pin_hash | text? | required iff `pin` |
| allowlist | text[] | emails or `*@domain`; required iff `allowlist` |
| rate_limit_per_hour | int | default 30, 1–500 |
| expires_at | timestamp | default now+7d, max 90d |
| revoked_at | timestamp? | |
| footer_enabled | bool | "Create your own with pamA", default true |

State: `active → expired` (time) · `active → revoked` (owner) · `active → degraded` (some
sources tombstoned; serves remaining sources) · `degraded → revoked|expired`.
`expired`/`revoked` ⇒ public endpoints return 410 with no content.

### suggested_questions
id, link_slug, text (≤ 200 chars), rank, edited_by_owner (bool).

### visitors
id, link_slug, email (nullable), verified_at, ip_hash, failed_attempts, locked_until.
Lockout: 5 failed PIN/OTP ⇒ locked 15 min.

### asks (audit log + inbox)
| Field | Type | Rules |
|---|---|---|
| id | text | |
| workspace_id | text | |
| origin | enum `link \| hotkey` | |
| link_slug, visitor_id | text? | link only |
| question | text | ≤ 2,000 chars |
| language | text | detected BCP-47 |
| status | enum | see state machine |
| answer | text? | |
| citations | jsonb | `[{item_id, digest_id, digest_version}]` |
| confidence | real | |
| guard | jsonb | `{leak, off_scope, unsupported_claims, rule_hits[]}` |
| owner_reply, owner_replied_at | text?, timestamp? | |
| created_at | timestamp | retention 180 days (configurable) |

State: `received → answered` · `received → refused` · `refused → forwarded` (asker action) ·
`forwarded → owner_answered | dismissed`. `hotkey` asks: `received → drafted` (no visitor).

### sync_tombstones
id, workspace_id, source_type, source_id, received_at. Applying a tombstone deletes digests and
items of that source, sets `active=false`, and marks affected links `degraded`.

### network_log (local mode and server)
id, at, component (`server \| desktop \| cli`), host, purpose, allowed (bool).

### jobs (local mode queue only)
id, name, payload jsonb, status (`queued \| running \| done \| failed`), run_at, attempts.

## Relationships

```text
workspace 1─* device
workspace 1─* project 1─* bundle 1─* session 1─* digest(versions) 1─* digest_item
workspace 1─* ask_link *─* (project|bundle|session) via source_refs
ask_link 1─* suggested_question, 1─* visitor, 1─* ask
ask *─* digest_item via citations
```

## Scope enforcement

`resolveLink(slug, visitor)` → `{allowed_session_ids, deny_labels, deny_topics, detail,
instruction}`. All retrieval calls `scopedItems(allowed_session_ids, deny_labels)` which always
filters `session_id = ANY($1) AND active AND NOT labels && $2`. On Postgres the same filter is also
enforced by an RLS policy reading `current_setting('pama.allowed_session_ids')` under a
non-superuser role; on PGlite RLS is enabled only if the R4 spike passes.

## Validation rules (from FRs)

- Digest content must validate against the JSON Schema; unknown fields rejected (FR-004).
- An approved digest must have `redactions` counts present (FR-002, FR-004).
- Link creation rejects sources that are not approved or not owned by the workspace (FR-008).
- `answered` asks must have ≥ 1 citation and `guard` all false (FR-012, FR-013).
- Sync endpoints accept only `approved` digests and only for sources with `sync_enabled` (FR-024).
