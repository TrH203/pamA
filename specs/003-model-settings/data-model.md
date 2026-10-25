# Data Model: Model Settings

**Table `model_settings`** (one row per role override; absent row = env default)
- `role` text PK — `chat` | `small` | `embed`
- `config` jsonb — `{provider, model, baseUrl?, apiKeyEnc?}`
- `previous` jsonb null — the config replaced by the last apply (for one-step revert)
- `last_check` jsonb null — Check Result `{at, ok, latencyMs, items[]}`
- `verified` boolean — last apply passed its check
- `updated_at` timestamptz

**Provider Configuration (API shape)**: `{provider, model, baseUrl?, keySet, local, verified, source: "env"|"saved", previous?: {provider, model, baseUrl?}}`

**Check Result**: `{role, ok, latencyMs, items: [{name, ok, detail, fix?}]}`; item names: `config`, `offline`, `reachable`, `model`, `key`, `json_output`, `dimension`.

**Transitions**: env default → saved (apply) → saved' (apply; previous = saved) → revert (swap config/previous).
