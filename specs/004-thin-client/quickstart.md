# Quickstart: Thin Client validation

## Prerequisites

- A server in cloud mode: `docker compose -f deploy/docker-compose.yml up` with
  `PAMA_MODE=cloud`, `SMTP_URL` (or Mailpit), `PAMA_SECRET` (see `docs/deploy-cloud.md`).
- Only the `pama` binary on the test machine (no `pama-server` next to it, no Node).
- A drafting model: `pama config set provider.chat.provider ollama` (or Anthropic with
  `echo $KEY | pama config set provider.anthropic.key -`).

## Scenarios

1. **Login (US1)**: `pama login --server https://pama.example --no-browser` → open the printed
   URL elsewhere, sign in by email, approve the code. Expect "logged in" ≤ 5 s later;
   `pama mode` shows `remote`. `pama logout` → console Devices lists it as revoked.
2. **Draft without a server (US2)**: `pama init --mode remote --sync` in a repo, run a Claude Code
   session containing a fake secret, end it. Expect within a minute: a draft in the console
   Review tab labelled with this device; `ps` shows no `pama-server`; `pama doctor --json`
   network log shows only the model host and the pamA server; the secret is not in the draft.
3. **Offline (US2.4)**: disconnect, end two sessions, reconnect, run any `pama` command or wait
   for the next hook; both drafts arrive once.
4. **Commands (US3)**: `pama review`, `pama review --approve <id>`, `pama link create ...`,
   ask through the link from a phone, `pama inbox`, `pama reply ...` — all succeed with no local
   server. `pama --server https://other review` without login → exit 2.
5. **Pull-back (FR-025)**: edit and approve a draft in the web console; run `pama review`; the
   device copy (`pama sync status --json`) shows `approved` with the edited text.
6. **Isolation (US6)**: two owners, two devices; each device's token gets 404/empty for the
   other's ids (automated in `apps/server/tests/integration/thin-client.test.ts`).

## Automated

- `cargo test -p pama-core draft::` and `cargo test -p pama-cli`
- `pnpm --filter @pama/server test -- device-flow thin-client`
