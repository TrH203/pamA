# HTTP contract (owner API, additions)

- `GET /v1/models/settings` → `{ strict_offline, roles: { chat, small, embed } }` (Provider Configuration; never a key).
- `POST /v1/models/check` body `{ role, candidate? }` → Check Result. Without `candidate`, checks the active config.
- `PUT /v1/models/settings/:role` body `{ provider, model, baseUrl?, apiKey?, confirm?: ("data_leaves"|"reindex"|"unverified")[] }`
  - 200 → Provider Configuration (+ `check`, `reindexed?`)
  - 409 `confirmation_required` → `{ error, required: [...] }`
  - 422 `invalid_request` | `offline_blocked` | `incompatible` | `check_failed` (body carries `check`)
- `POST /v1/models/settings/:role/revert` → Provider Configuration, 409 `no_previous` if none.
Errors use `{ error: { code, message } }`.
