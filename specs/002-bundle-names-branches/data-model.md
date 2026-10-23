# Data Model Delta: Bundle Names and Multi-Branch Sessions

Extends [`../001-pama-mvp/data-model.md`](../001-pama-mvp/data-model.md). Migration `0007`.

## bundles (changed)
| Field | Type | Rules |
|---|---|---|
| name | text | display name; unchanged column, now meaningful |
| name_source | text | `key` (default; name = key fallback) \| `suggested` \| `owner`; CHECK in set |
| name_updated_at | timestamptz | set whenever name changes (used for propagation) |

State: `key → suggested` on first approved digest; any → `owner` on rename/merge/split-name;
`owner` never leaves via automation. Backfill: rows where `name = key` → `key`, others → `owner`.

## sessions (changed)
| Field | Type | Rules |
|---|---|---|
| bundle_pinned | boolean | default false; true after split/merge/move; pinned sessions are not re-filed on re-capture |

## session_branches (new)
| Field | Type | Rules |
|---|---|---|
| session_id | text | FK → sessions, ON DELETE CASCADE |
| workspace_id | text | scope column like other tables |
| name | text | ≤ 256; redacted (written from the cleaned digest) |
| position | int | 0-based visit order (first-seen order) |
| first_seen_at, last_seen_at | timestamptz? | from transcript timestamps when present |
| event_count | int | ≥ 0 |

PK `(session_id, name)`. Rows replaced wholesale on each capture of the session (delete + insert in
one transaction). Max 20 per session. Backfill: one row from the latest digest's `source.git.branch`
per session where present.

## Derived: Bundle Summary (not stored)
`branches` = distinct `session_branches.name` over member sessions ordered by earliest
`first_seen_at` (then position); `session_count` = member sessions; `last_activity` =
`max(sessions.ended_at)`.

## Digest document (changed, additive)
`source.git.branches?: [{name, first_seen?, last_seen?, events?}]` ≤ 20; `source.git.branch` =
filing branch; `source.bundle_key` = filing branch (unchanged semantics). See
[contracts/digest-branches.md](./contracts/digest-branches.md).

## Device (Rust, in memory)
`BranchVisit { name, first_seen: Option<String>, last_seen: Option<String>, events: u32 }`,
`SessionMeta.branches: Vec<BranchVisit>`; `git_branch` kept = filing branch for existing callers.

## Relationships
`workspace 1─* project 1─* bundle 1─* session 1─* session_branches`; session 1─* digest(versions).
