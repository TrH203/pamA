# Tasks: Conversations and owner chat (backend + CLI)

**Input**: [spec.md](./spec.md), [plan.md](./plan.md)

## Phase 1: Data model

- [x] T001 Migration `apps/server/migrations/0013_conversations.sql` (conversations, asks.conversation_id, origin `owner_chat`, `workspaces.ask_retention_days`, backfill) and drizzle schema `apps/server/src/db/schema/conversations.ts` (+ `core.ts`, `links.ts`, `index.ts`)
- [x] T002 Backfill test `apps/server/tests/integration/conversations-migration.test.ts`

## Phase 2: Multi-turn answers (US1)

- [x] T003 Unit tests `apps/server/tests/unit/multi-turn.test.ts` (caps, budget, deny topics, tag neutralization, scope, citations, guard)
- [x] T004 `historyBlock`, `history` input and follow-up retrieval in `apps/server/src/pipeline/answer.ts`; prompt v2 in `prompts/answer.md`
- [x] T005 `priorTurns`, conversation helpers in `apps/server/src/services/conversations.ts`

## Phase 3: Public Ask API (US1, US2)

- [x] T006 `conversation_id` on `POST /a/:slug/api/ask` with implicit creation, `apps/server/src/routes/public.ts`, `apps/server/src/services/asks.ts`
- [x] T007 Public conversations routes (create, list, read, delete) with cross-device resume by verified email (`askerIds`)

## Phase 4: Owner API and chat (US3, US4, US6)

- [x] T008 `apps/server/src/routes/conversations.ts`: list with filters, detail, reply, archive, delete, export JSON/CSV; mount in `apps/server/src/app.ts`
- [x] T009 `/v1/chat`, `/v1/chat/conversations`, `/v1/chat/:id/link`
- [x] T010 Hotkey drafts recorded per day and `GET /v1/draft/recent` in `apps/server/src/routes/draft.ts`
- [x] T011 Per-workspace retention in `apps/server/src/jobs/retention.ts` and `/v1/settings/retention`
- [x] T012 Integration tests `apps/server/tests/integration/conversations.test.ts`

## Phase 5: Evals (FR-010)

- [x] T013 `evals/cases/multi-turn.yaml` (16 cases), `turns` support in `evals/lib/{cases,harness,judge}.ts`, README
- [x] T014 `pnpm evals`: 71 cases, 0 leaks (the one quality failure `answer-refund-why` also fails on the base branch)

## Phase 6: CLI (US5)

- [x] T015 `Api::delete` in `crates/pama-core/src/client.rs`
- [x] T016 `pama conversations list|show|reply|delete` and `pama chat` in `crates/pama-cli/src/cmd/conversations.rs`, `main.rs`, `cmd/mod.rs`; unit tests

## Review fixes

- [x] T019 Resume only with an email proven by a one-time code on this link (`askerIds` ignores visitors with a code pending; asking for a code for another email clears `verified_at`)
- [x] T020 CSV export neutralises formulas (`csvCell`, also after leading spaces and full-width forms); export pages by `offset` with `next_offset` (JSON) / `X-Pama-Next-Offset` (CSV) past 2000 conversations
- [x] T021 "New chat" reuses an empty conversation (advisory lock), shares the question budget, and a link takes at most `rate_limit_per_hour` new empty conversations an hour
- [x] T022 Retrieval is driven by the current question; only a short follow-up borrows the previous non-denied question (`retrievalQuery`)
- [x] T023 Hotkey day conversation lookup/insert under an advisory lock; after resume, `/api/asks`, feedback and forward work for turns asked on the other device

## Not in this slice

- [ ] T017 CLI flags for `--from/--to`, archive and export (server routes exist)
- [x] T018 Web UI (console Conversations and Chat pages, Ask page conversation list, desktop popup history), see Phase 7

## Phase 7: Web UI (spec 008 UI slice)

- [x] T024 Console `/conversations` (`apps/web/src/console/pages/conversations/ConversationsPage.tsx`): list from `GET /v1/conversations` with status (All, Needs reply = old Inbox, Open, Archived), link, source and date filters in the URL, paging, JSON/CSV export (all pages via `next_offset` / `X-Pama-Next-Offset`); `Inbox.tsx` removed
- [x] T025 Console `/conversations/:id` (`ConversationDetail.tsx`): thread with status chips, citations linking to the Library search (`/library/search?q=<item text>`), owner replies; inline reply composer with "Suggest a reply" and Dismiss; archive/unarchive; delete with ConfirmDialog; server serves `/conversations/*` deep links
- [x] T026 Console `/chat` (`apps/web/src/console/pages/chat/ChatPage.tsx`): chat list sidebar, multi-turn pane on `POST /v1/chat`, scope picker (searchable multi-select `ScopeCombobox`, fixed once a chat starts), citation chips, "Create Ask Link from this chat" (`POST /v1/chat/:id/link`) dialog with URL and PIN
- [x] T027 Ask page (`apps/web/src/ask/AskPage.tsx`, `ConversationList.tsx`): resumes the latest conversation (also after email OTP on another device), follow-ups send `conversation_id`, "New conversation", list/switch/delete own conversations; falls back to `/asks` on servers without conversations; Playwright selectors unchanged
- [x] T028 Desktop popup (`apps/web/src/desktop/Popup.tsx`, `RecentDrafts.tsx`): recent drafts from `GET /v1/draft/recent` can be reopened; scope picked with the searchable combobox (tasks and projects)
- [x] T029 EN/VI strings in `packages/i18n/src/conversations.ts` (mounted as `convo`)
- [x] T030 Component tests: `conversations.test.tsx`, `chat.test.tsx`, `ask/AskPage.test.tsx`, `desktop/Popup.test.tsx`
- [x] T024 Console Settings → Retention (`apps/web/src/console/pages/settings/Retention.tsx`):
  `GET/PUT /v1/settings/retention` with validation (1–3650 days)
