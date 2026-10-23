# Contract: Branch lists in digests and ingest

## `packages/types/schema/session-digest.schema.json` — `source.git`
```json
"git": {
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "branch":  { "type": "string", "maxLength": 256, "description": "Branch the session is filed under" },
    "branches": {
      "type": "array", "maxItems": 20,
      "description": "Every branch visited, in first-seen order",
      "items": {
        "type": "object", "additionalProperties": false, "required": ["name"],
        "properties": {
          "name":       { "type": "string", "minLength": 1, "maxLength": 256 },
          "first_seen": { "type": "string", "format": "date-time" },
          "last_seen":  { "type": "string", "format": "date-time" },
          "events":     { "type": "integer", "minimum": 0 }
        }
      }
    },
    "commits": { "...": "unchanged" }
  }
}
```
`schema_version` stays `1`.

## Rules
- `git.branch` and `source.bundle_key` = the filing branch (FR-006/007).
- Absent `branches` ⇒ treated as `[git.branch]` (or empty if no branch).
- `branches[].name` values are unique within a digest.
- Contract tests: Rust serde ↔ JSON Schema ↔ zod (new valid + invalid fixtures: duplicate names,
  > 20 items, empty name, unknown field in item).

## Transcript ingest (device → server `POST /v1/transcripts`, existing)
`git` object accepts `branches` as above; `bundle_key` precedence unchanged
(`bundle_key` → `git.branch` → `"default"`).

## Version skew
Sync client omits `git.branches` when the target server does not advertise branch-list support;
an older strict server would otherwise reject the digest with 422.
