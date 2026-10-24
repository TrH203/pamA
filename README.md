# pamA — Please Ask my AI

You build with AI coding agents (Claude Code, Codex). People keep asking you *what was decided
and why*. pamA reads your agent sessions **on your machine**, removes secrets, keeps short digests
of the key decisions, and answers those questions for you — with citations, in the asker's
language, and never with anything you did not approve.

- **Ask Link** — share a URL (PIN, email code or allowlist) scoped to some of your work. Askers get
  cited answers or can forward the question to you.
- **Hotkey** — select a question in any chat app (Zalo, Slack, Teams, email…), press
  **Cmd/Ctrl+Shift+Space**, paste the cited draft. pamA never sends anything itself.
- **Local first** — runs fully offline with Ollama/vLLM. Raw transcripts never leave your machine;
  approved digests sync to your own server only for the projects you choose.

Apache-2.0. Status: v0.1 (MVP).

## First Ask Link in 10 minutes

```bash
# 1. Install (from source for now)
git clone https://github.com/TrH203/pama && cd pama
pnpm install && pnpm --filter @pama/web build && cargo build --release -p pama-cli
export PATH="$PWD/target/release:$PATH"
export PAMA_SERVER_CMD="node --import tsx $PWD/apps/server/src/index.ts"   # until the desktop app is installed

# 2. Models: local (Ollama) or Anthropic
ollama pull bge-m3 && ollama pull qwen3:14b
#   or switch with the CLI / console Settings tab:
#     pama model show
#     echo "$KEY" | pama model switch chat cloud --model claude-sonnet-5-5 --key-stdin --yes
#     pama model check

# 3. Turn on capture in a project and work as usual
cd ~/code/my-project && pama init
claude    # …end the session as usual

# 4. Review what pamA kept (secrets are already replaced)
pama review
pama review --approve <id>

# 5. Share
pama link create --suggest "refund shipping fee" --access pin
#   → https://…/a/xxxxxxxx  PIN: 123456
```

### Or: only the `pama` command, with a pamA server (remote mode)

If your team runs a pamA server ([cloud](docs/deploy-cloud.md) or [self-host](docs/self-host.md)),
you need nothing but the `pama` binary — no Node, no local database:

```bash
pama login --server https://pama.example.com   # approve in the browser
cd ~/code/my-project && pama init --sync        # drafts of this project go to the server
pama model --device show                        # the model that drafts on your machine (Ollama by default)
```

Sessions are still read and redacted on your machine, and the digest is drafted there; only the
draft goes to the server, where you review it (`pama review` or the web console).

Want to look around first? `pnpm --filter @pama/server demo` starts a server with sample data and
prints a console URL and two Ask Links (offline models, nothing to install).

## How it works

```
┌──────────── your machine ────────────┐            ┌──── your server (optional) ────┐
│ Claude Code / Codex sessions         │            │                                │
│      │ hook / scan                   │  approved  │  same server, Postgres+pgvector│
│ pama-core (Rust): parse + Layer 1 ───┼─ digests ─▶│  Layer 2 again, Ask Links      │
│      │ redacted events               │  (opt-in)  │  always on                     │
│ local server (TypeScript, PGlite):   │            └────────────────────────────────┘
│  digest → Layer 2 → review → items   │
│  Ask Links · hotkey drafts · Layer 3 │◀── desktop app: tray, hotkey, popup
└──────────────────────────────────────┘
```

| Part | Tech |
|---|---|
| `crates/pama-core` | Rust: Claude/Codex adapters, Layer-1 redaction (gitleaks rules), device store, sync outbox |
| `crates/pama-cli` | `pama` command |
| `crates/pama-desktop` | Tauri 2 tray app, global hotkey, clipboard-safe capture/paste |
| `apps/server` | Hono + Drizzle; Postgres+pgvector or PGlite; AI SDK (Anthropic, OpenAI-compatible, Ollama) |
| `apps/web` | React: Ask Link page, owner console, desktop popup |
| `rules/`, `prompts/`, `evals/` | shared redaction rules, versioned prompts, red-team suite |

Docs: [security model](docs/security-model.md) · [threat model](docs/threat-model.md) ·
[self-host](docs/self-host.md) · [cloud server](docs/deploy-cloud.md) · [local links](docs/local-links.md) · [agents](docs/agents.md) ·
[spec & plan](specs/001-pama-mvp/).

## Develop

```bash
pnpm install && cargo build --workspace
cargo test --workspace && pnpm test        # PAMA_TEST_PG_URL=postgres://… also runs Postgres tests
pnpm evals                                 # red-team suite: must report 0 leaks
pnpm --filter @pama/web test:e2e           # browser tests (build the web app first)
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and the [constitution](.specify/memory/constitution.md).
