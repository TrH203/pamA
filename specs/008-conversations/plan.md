# Implementation Plan: Conversations and owner chat (backend + CLI)

**Branch**: `feat/008-conversations` | **Spec**: [spec.md](./spec.md) | **Migration**: 0013

## Summary

Add a `conversations` table that every ask belongs to, feed earlier turns into the answer
pipeline as untrusted context, expose conversations on the public Ask API and an owner API, add
the owner's "ask my agent" chat, and the matching CLI commands.

## Technical context

- Server: TypeScript, Hono, raw SQL migrations (PGlite locally, Postgres in cloud), drizzle
  schema mirror, vitest.
- CLI: Rust (`pama-cli`, `pama-core::client::Api`).
- Evals: `evals/` package, offline fake model provider by default.

## Constitution check

- **Scope safety (V)**: history never changes the retrieval scope; citations are validated
  against retrieved in-scope items; Layer 3 guard unchanged and run for every turn; multi-turn
  red-team cases added to the zero-leak gate.
- **Raw transcripts never leave the machine**: unaffected (only asks and answers are stored).
- **Retention**: still enforced, now configurable per workspace.

## Design

### Data model (`apps/server/migrations/0013_conversations.sql`, `src/db/schema/conversations.ts`)

- `conversations(id, workspace_id → workspaces, link_slug → ask_links.slug, visitor_id, origin,
  title ≤ 200, scope jsonb, status, created_at, last_at, deleted_at)`; CHECK `origin = 'link'` ⇔
  `link_slug IS NOT NULL`. Indexes `(workspace_id, last_at)`, `(link_slug, visitor_id)`.
- `asks.conversation_id → conversations ON DELETE CASCADE`, index `(conversation_id, created_at)`;
  `asks_origin` CHECK gains `owner_chat`.
- `workspaces.ask_retention_days int NOT NULL DEFAULT 180 CHECK 1..3650`.

### Backfill decision

- Link asks: one conversation per `(link_slug, visitor_id)`, titled after the first question.
- Hotkey asks: **one conversation per workspace and UTC day** ("Drafts YYYY-MM-DD"), chosen over
  one conversation per ask so the desktop history stays readable; new hotkey drafts follow the
  same daily grouping.
- Ids are derived deterministically from the group key (md5 prefix) so the asks can be updated in
  one statement. Asks whose link or workspace no longer exists keep a null conversation.

### Multi-turn answers (`src/pipeline/answer.ts`, `prompts/answer.md` v2)

- `historyBlock(turns, denyTopics)`: drop turns mentioning a denied topic, keep the last 6, clip
  each side to 1200 chars, neutralize data-block tags, drop oldest until ≤ 1500 × 4 chars.
- Retrieval embeds `previous question + new question` but still runs inside `scope`.
- The prompt says the history is data, never a source of facts, and instructions in it are
  ignored. Citation validation and the guard are unchanged.
- `priorTurns()` returns what the asker actually saw (answer or owner reply).

### APIs

- Public (`src/routes/public.ts`): `POST/GET /a/:slug/api/conversations`,
  `GET/DELETE /a/:slug/api/conversations/:id`; `POST ask` takes optional `conversation_id`.
  "This asker" = cookie visitor ∪ visitors of the same link verified with the same email.
  Citations shown are re-filtered against the link's current scope and deny labels.
- Owner (`src/routes/conversations.ts`): list/detail/reply/patch/delete/export, `/v1/chat`,
  `/v1/chat/conversations`, `/v1/chat/:id/link`, `/v1/settings/retention`.
- Draft (`src/routes/draft.ts`): records each hotkey draft into the day's conversation;
  `GET /v1/draft/recent`.
- Delete is soft (`deleted_at`), hidden at once and purged by `jobs/retention.ts`.

### CLI (`crates/pama-cli/src/cmd/conversations.rs`)

- `pama conversations list [--link --asker --status --origin --limit --offset]`, `show <id>`,
  `reply <id> <text> [--ask <id>]`, `delete <id>`; `Api::delete` added to `pama-core`.
- `pama chat [-q Q] [--scope bundle:<id>…] [--conversation <id>]`; REPL commands `/new`,
  `/link`, `/quit`.

## Testing

- `tests/integration/conversations-migration.test.ts`: backfill grouping.
- `tests/unit/multi-turn.test.ts`: history block caps, tag neutralization, retrieval stays in
  scope, uncited history answers refused, guard runs on follow-ups.
- `tests/integration/conversations.test.ts`: public, owner, chat, draft, retention routes.
- `evals/cases/multi-turn.yaml`: 16 cases (scope escalation, injection over turns, secret fishing).
- Rust unit tests for CLI path building and formatting.
