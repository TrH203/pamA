# Quickstart: validate model settings

1. `pnpm --filter @pama/server test -- model-settings` — unit + integration (fake models, PGlite).
2. `pama server start && pama model show` — defaults from env.
3. `pama model set chat --provider ollama --model qwen3:14b && pama model check chat`.
4. `pama console` → Settings tab: change embed model, observe re-index warning; switch chat to cloud, observe the data-leaves notice; revert.
5. Turn on strict offline (`pama config set strict_offline true`, restart) and confirm cloud apply is refused.
Expected: CLI and web always show the same values; no key appears anywhere.
