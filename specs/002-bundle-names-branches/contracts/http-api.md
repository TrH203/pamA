# Contract: HTTP API delta

## `GET /v1/bundles` (owner console, existing; shape extended)
```json
{ "items": [{
  "id": "…", "name": "Refund shipping fee", "name_source": "suggested",
  "key": "feat/refund-shipping", "project": "shop", "project_id": "…",
  "branches": ["feat/refund-shipping", "fix/refund-typo"],
  "session_count": 4,
  "last_activity": "2026-10-23T09:12:00Z",
  "sessions": [{ "id": "…", "agent": "claude_code", "agent_session_id": "…",
                 "ended_at": "…", "branches": ["feat/refund-shipping"], "bundle_pinned": false }]
}] }
```
Existing fields are unchanged; new fields are additive. Bundles with no sessions stay hidden.

## `PATCH /v1/bundles/:id` (existing)
`{ "name": "…" }` sets `name_source = 'owner'`, bumps `name_updated_at`; with sync enabled the
latest approved digest is queued for re-delivery (research R8). `name` 1–200 chars.

## `POST /v1/bundles/merge`, `POST /v1/bundles/:id/split`
Supplied names set `name_source = 'owner'`; moved sessions get `bundle_pinned = true`.

## Sync (device → replica, existing digest delivery)
`bundle_name` is redacted before leaving; `bundle_name_source` added; replica applies the
name-overwrite rule in research R8.

## Scope (Constitution II)
`session_branches` and bundle names are exposed only on owner routes (`/v1/bundles`, review,
sync-local). Asker-facing/public routes and retrieval keep their current scoped queries and do not
select them, except where a bundle title is already returned for an in-scope source.
