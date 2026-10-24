# Research: Model Settings

- **R1 Source of truth** — Decision: the server DB (`model_settings`) overrides env defaults; CLI and web are clients. Rationale: gives CLI/web parity (FR-005) and works in all modes. Rejected: CLI-side settings store (only reaches the server at spawn; web could not see it).
- **R2 Hot swap** — Decision: rebuild the model objects and `Object.assign` them into the shared `deps.models`; requests copy `deps` shallowly, so they see the change. In-flight calls keep their old objects. Rejected: restart the server (breaks the sidecar and in-flight jobs).
- **R3 Keys** — Decision: AES-256-GCM with a key derived from the server secret, stored in `model_settings.config.apiKeyEnc`; API returns only `keySet`. See Complexity Tracking.
- **R4 Status check** — Decision: chat/small: one short generation requesting a JSON object (reachable, model present, key accepted, JSON-output capability, latency). Embed: embed one string, compare vector length with the stored dimension. Errors map to codes: `unreachable`, `key_rejected`, `model_not_found`, `blocked_offline`.
- **R5 Embedding dimension** — The vector column is fixed at 1024 (`EMBED_DIM`). A model with another dimension is *incompatible* (clear message, no apply). A same-dimension but different model changes semantics: require `reindex` confirmation, then re-embed all digest items.
- **R6 Confirmations** — Server returns 409 `confirmation_required` with `required: ["data_leaves"|"reindex"]`; clients re-send with `confirm`. `unverified` lets an owner save when a check fails.
- **R7 Local vs cloud** — Reuse `isLocal()` (ollama, fake, private-network hosts = local).
- **R8 Languages** — The console is English-only today; Settings follows it. CLI is English.
