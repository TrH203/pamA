# CLI contract (additions)

- `pama model show` — table of roles (provider, local/cloud, model, endpoint, key set/not set, verified). `--json` for scripts.
- `pama model set <chat|small|embed> --provider P --model M [--base-url U] [--key-stdin] [--yes] [--force]` — non-interactive. `--yes` confirms data_leaves/reindex; `--force` saves unverified. Key read from stdin only (never argv).
- `pama model switch <role> <local|cloud> [--model M] [--yes]` — convenience over set (local→ollama, cloud→anthropic/openai-compatible requires `--provider`).
- `pama model check [role]` — status + compatibility; exit 0 ok, 2 on failure.
- `pama model revert <role>`.
- `pama model setup` — guided prompts per role (TTY only).
Exit codes follow contracts/cli.md of 001 (1 user, 2 config, 3 network).
