# Research: Bundle Names and Multi-Branch Sessions

## R1. Where to count branches per session
- **Decision**: In the Rust parsers, per event. Claude Code lines carry `gitBranch` on every
  user/assistant record; Codex carries it in `session_meta.git` and in later `turn_context` /
  git-info records where present. Maintain `SessionMeta.branches: Vec<BranchVisit>`
  (`name`, `first_seen`, `last_seen`, `events`), appended in first-seen order, deduplicated by name.
- **Rationale**: Events sent to the server contain no branch field; only the parser sees the
  transcript. Today `claude.rs` overwrites `git_branch` on every line (last wins) — the root bug.
- **Alternatives**: add `branch` to each `Event` and let the server count (bigger payload, pushes
  transcript-shaped data across the boundary for no gain); `git reflog` on the device (not
  reproducible from a recorded transcript, breaks fixtures).

## R2. Where the filing-branch rule lives
- **Decision**: Rust `project::pick_filing_branch(&[BranchVisit]) -> Option<&str>`: highest
  `events` among branches excluding `main`/`master` (if any other exists), ties → earliest
  `first_seen`; otherwise the best of `main`/`master`. Device sends the result as `bundle_key` and
  `git.branch` (unchanged fields); server keeps using `bundle_key`.
- **Rationale**: Only the device has the counts, and the server already trusts `bundle_key`;
  one implementation, no drift (Constitution IV justification: data availability).
- **Alternatives**: recompute on server from `git.branches[].events` (duplicate rule in two
  languages); let the owner always choose (defeats automation).

## R3. Digest schema compatibility
- **Decision**: Additive optional `source.git.branches[]` = `{name, first_seen?, last_seen?,
  events?}`, max 20 items. `schema_version` stays `1`; `git.branch` and `bundle_key` keep
  their meaning. Readers treat a missing list as `[git.branch]`.
- **Rationale**: Existing schema is strict (`additionalProperties:false`), so an **older strict
  server will reject** the new field. Mitigation: devices omit `git.branches` when pushing to a
  remote whose version/capabilities (server meta/version info) do not list `branch_lists`; local
  sidecar always ships with the same build. Release notes: upgrade self-host servers before devices.
- **Alternatives**: bump `schema_version` to 2 (older servers reject *every* digest, worse);
  put branches in a side-channel request field (loses them from the stored digest, breaks sync
  replication).

## R4. Storing branch lists and deriving bundle chips
- **Decision**: New table `session_branches(session_id, name, position, first_seen_at,
  last_seen_at, event_count)`, PK `(session_id, name)`, replaced wholesale on each (re)capture.
  `listBundles` derives `branches` with one grouped query over member sessions
  (`DISTINCT` by name, ordered by earliest first-seen), plus `session_count` and
  `last_activity = max(sessions.ended_at)`.
- **Rationale**: Derived data cannot go stale after split/merge/move (FR-011). One extra query,
  no N+1.
- **Alternatives**: JSON column on `sessions` (cannot aggregate in SQL cheaply); materialized list
  on `bundles` (must be maintained on every move — the staleness bug we want to avoid).

## R5. Re-evaluating a session's bundle on re-capture
- **Decision**: Add `sessions.bundle_pinned boolean default false`, set true by split/merge/move
  (`moveSessions`). On re-capture of an unpinned session whose new `bundle_key` differs,
  `assignBundle` for the new key and `moveSessions`-style update of `sessions` + `digest_items`
  (without setting pinned). Pinned sessions keep their bundle (today's behavior for owner moves).
  Empty bundles are already hidden by `listBundles`.
- **Rationale**: Fixes silent misfiling when the final branch changes, without undoing owner edits.
- **Alternatives**: never re-evaluate (spec FR-010 violated); always re-evaluate (undoes owner
  splits/merges).

## R6. Branch names and privacy
- **Decision**: Rely on existing Layer 2: `cleanAndLabel` → `sanitizeDeep` walks every string of the
  digest, including `source.bundle_key` and `source.git.branches[].name`, so stored digests and
  `session_branches` rows (written from the cleaned digest) hold redacted names. Additionally redact
  `bundles.name` with `rules.redact` in `pending()` before it leaves for a replica. `bundles.key`
  stays as captured locally (existing behavior); it is not shown in chips.
- **Rationale**: No new redaction path, so no new rules to drift; add a branch-redaction test
  (Constitution V).
- **Alternatives**: redact on the device in `request_body` (would change the stable bundle key and
  fragment bundles when rules evolve).
- **Note**: branch chips come from cleaned names, so a masked chip may differ from the raw key;
  accepted (spec edge case: masked name shown).

## R7. Suggested bundle names
- **Decision**: No extra model call. When a bundle's `name_source = 'key'` and its first approved
  digest arrives, set `name` to that digest's `goal` shortened to ≤ 60 chars at a word boundary
  (strip trailing punctuation) and `name_source = 'suggested'`. Owner rename/merge/split-name sets
  `'owner'`; suggestions never overwrite `'owner'`. Offline/no-digest fallback stays the key.
- **Rationale**: Goals are already English summaries produced under the existing prompt; an extra
  model call adds cost, latency, prompt/eval surface (Constitution VI).
- **Alternatives**: dedicated "title" field in the digest prompt (prompt change → full eval run);
  LLM naming job (new moving part).

## R8. Name propagation to replicas
- **Decision**: Digest deliveries already carry `bundle_name`. Change the replica rule from
  `UPDATE … WHERE name = key` to "update when replica `name_source <> 'owner'` or the incoming
  source is `owner`", and send `name_source` alongside. On owner rename with sync enabled, reset the
  delivery of the bundle's latest approved digest so the new name travels in the normal flow.
  **Risk to verify first in tasks**: that re-delivery of an already-known digest is idempotent on
  the replica (receipt keyed by outbox id); if not, fall back to a small
  `bundle_name` upsert endpoint.
- **Alternatives**: use the unimplemented `BundleChange` outbox kind (new device-side code path).

## R9. Presentation
- **Decision**: One `BundleSummary` component in `packages/ui` (title, branch chips with "+N more"
  after 3, "N sessions", relative last-activity) used by console `Bundles.tsx` and the desktop
  settings list; CLI prints the same fields as text. API returns `branches`, `session_count`,
  `last_activity` so no surface computes them itself.
- **Alternatives**: per-surface formatting (SC-004 drift).

## R10. Caps and edge handling
- **Decision**: cap 20 branches per session; when exceeded keep the filing branch plus the first 19
  by first-seen and set `branches_truncated=true` in the stored digest-adjacent metadata (response
  field `branches_truncated` on session rows). A→B→A counts events for A in one entry. Names compared
  exactly (case-sensitive); over-long names truncated to 256 as today.
