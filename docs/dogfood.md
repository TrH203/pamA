# Using and developing pamA at the same time

Two isolated installs on one machine:

| | **stable** (daily use) | **dev** (what you are changing) |
|---|---|---|
| Command | `pama`, app `/Applications/pamA.app` (hotkey, tray) | `pama-dev` |
| Built from | `make install` (release, self-contained) | the working tree (debug CLI, server from source) |
| Data | `~/.pama` | `~/.pama-dev` (`PAMA_HOME`) |
| Port | default (7465) | 7600 (`PAMA_PORT`) |

## Commands

```bash
make dev-link   # once: puts pama-dev on PATH
pama-dev …      # develop and try changes (rebuilds the CLI automatically; server runs from source)
make test       # cargo test + pnpm test + evals — run before upgrading
make install    # build everything and replace the stable app and CLI
```

## Loop

1. **Use** stable. Write anything wrong or missing in the log below, right when it happens.
2. **Develop** on a branch; try it with `pama-dev` on `~/.pama-dev` (never on your real data).
   - Server code or prompts: `pama-dev server stop`, the next `pama-dev` command restarts it.
   - Web: `pnpm --filter @pama/web build`.
3. **Gate:** `make test`.
4. **Merge** to `main`, then **upgrade stable:** `make install` (quit pamA first or let it do so).
5. Back to 1.

## Rules

- Do not `pama init` the same project with both `pama` and `pama-dev` (a session would be captured twice).
- Before a release that changes the schema, copy `~/.pama` to `~/.pama.bak`.
- The hotkey/tray only exist in the stable app; `pama-dev` covers CLI, server, web and Ask Links.

## Feedback log

| Date | What happened | Impact |
|---|---|---|
| 2026-10-24 | Asked "what is pamA?" on a link: refused, no approved item describes the product | Askers get nothing for basic questions |
