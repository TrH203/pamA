# Contract: CLI delta

## `pama review` (digest list, existing)
Bundle column shows the display name instead of the raw key; append branch hint when the session
spans more than one branch: `Refund shipping fee [feat/refund-shipping +1]`.

## `pama sync status` (existing)
Per project, list bundles as:
```
  Refund shipping fee   id=01J…   branches: feat/refund-shipping, fix/refund-typo   4 sessions   last 2026-10-23 09:12   sync: off
```
Long branch lists truncate to 3 names + `+N more`; `--json` output is unabridged and uses the
`branches`, `session_count`, `last_activity` fields from `/v1/bundles`.

Exit codes and flags are unchanged.
