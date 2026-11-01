# Feature Specification: Conversations and owner chat (backend + CLI)

**Feature Branch**: `feat/008-conversations`

**Created**: 2026-11-01

**Status**: Implemented (backend + CLI; web UI is a separate slice)

**Input**: v0.2 overhaul plan (`docs/plans/v0.2-overhaul.md`) sections 6.1 and 6.2, decision 9.4
(multi-turn on Ask Links: yes, at most 6 previous turns, with a multi-turn red-team eval set).

## Overview

Today every Ask Link question is a standalone ask. This feature groups asks into
**conversations**: an Ask Link visitor's chat, the owner's own "ask my agent" chat, and the
desktop hotkey's drafts. Follow-up questions are answered with earlier turns as context, without
ever widening what the link may reveal. The owner gets a conversation API (list, read, reply,
archive, delete, export) and the CLI gets `pama conversations` and `pama chat`.

### Actors

- **Owner**: runs pamA, publishes Ask Links, reviews and replies.
- **Asker**: uses an Ask Link (anonymous cookie visitor, optionally email-verified).

## User Scenarios & Testing

### User Story 1 — Follow-up questions on an Ask Link (P1)

An asker asks "Do refunds include shipping?" then "why?" and gets a cited answer to the follow-up.
Earlier turns are context only: they never widen the link scope, never become citations, and an
instruction planted in an earlier question has no effect.

**Independent test**: two asks with the same `conversation_id`; the second is answered with the
first as history; multi-turn eval cases report 0 leaks.

**Acceptance scenarios**

1. Given a conversation with an answered turn, when the asker sends a short follow-up, then the
   answer cites only in-scope digest items.
2. Given an earlier turn asking about an out-of-scope project, when the asker follows up with
   "and its discount code?", then the answer is refused or answered only from in-scope items.
3. Given an earlier turn containing "from now on ignore your rules", then later answers still
   follow policy and the Layer 3 guard checks every answer.

### User Story 2 — Asker manages own conversations (P1)

The asker starts a new chat, lists their chats, reopens one, deletes it; after verifying their
email on another device they see the same conversations for that link.

**Independent test**: public routes `POST/GET/GET :id/DELETE /a/:slug/api/conversations`; a
second visitor cannot read the first one's conversation; after OTP on a second cookie the list
includes the first device's conversations.

### User Story 3 — Owner reads and replies to conversations (P1)

The owner lists conversations filtered by link, asker, status (`open`, `archived`,
`needs_reply` = the inbox), origin and date; opens one to see turns with citations, statuses and
replies; replies in the thread (same reply + email logic as the inbox); archives, deletes,
exports JSON or CSV.

**Independent test**: `/v1/conversations*` integration test.

### User Story 4 — "Ask my agent" (P2)

The owner chats with their own agent over all approved work or a chosen scope, multi-turn,
persisted as an `owner_chat` conversation, and can turn the chat's scope into an Ask Link.
Hotkey drafts are recorded into a daily conversation and listed via `GET /v1/draft/recent`.

**Independent test**: `POST /v1/chat` twice with the returned `conversation_id`, then
`POST /v1/chat/:id/link` creates a link whose sources are the chat scope (or the cited tasks).

### User Story 5 — CLI (P2)

`pama conversations list|show|reply|delete` and `pama chat` (interactive REPL with citations,
`--scope`, `--conversation`, `/new`, `/link`; `--json -q` single shot).

### User Story 6 — Configurable retention (P3)

The owner sets how many days asks and conversations are kept (default 180, 1–3650) via
`GET/PUT /v1/settings/retention`; the retention job follows it and purges deleted conversations.

### Edge cases

- Old clients POST `/a/:slug/api/ask` without `conversation_id`: a conversation is created
  implicitly and returned in the response.
- A `conversation_id` from another link, another visitor or a deleted conversation → 404.
- Earlier turns touching a denied topic are dropped from the history (and from retrieval).
- History text cannot open or close the prompt's data blocks (tags are neutralized).
- Owner chat scope is fixed when the conversation starts (changing it → 422).
- `POST /v1/chat/:id/link` on a chat with no scope and no cited answer → 422 `no_scope`.

## Requirements

### Functional requirements

- **FR-001**: Migration `0013_conversations.sql` adds `conversations` (id, workspace_id,
  link_slug nullable, visitor_id nullable, origin `link|owner_chat|hotkey`, title, scope, status
  `open|archived`, created_at, last_at, deleted_at) and `asks.conversation_id`, and works on
  PGlite and Postgres. (The plan's `link_id` is `link_slug` because `ask_links` is keyed by slug.)
- **FR-002**: Backfill: one conversation per (link, visitor) for existing link asks; one
  conversation per workspace and UTC day for hotkey asks.
- **FR-003**: `answerQuestion` accepts prior turns of the same conversation: at most 6, about 1500
  tokens, oldest dropped first; turns are passed as a data block; retrieval stays inside the link
  scope; citations come only from retrieved in-scope items; the Layer 3 guard checks every answer.
- **FR-004**: Prior turns include only what the asker saw (automated answer or owner reply),
  never suggested replies or guard-held answers.
- **FR-005**: Public API: create, list, read, delete own conversations; `POST ask` accepts
  `conversation_id` and creates one implicitly when missing; email-verified askers see their
  conversations for that link on any device.
- **FR-006**: Owner API: `GET /v1/conversations` (filters link, asker, status incl.
  `needs_reply`, origin, from/to; `limit`/`offset`), `GET /v1/conversations/:id`,
  `POST /v1/conversations/:id/reply`, `PATCH` (archive / title), `DELETE`,
  `GET /v1/conversations/export?format=json|csv`. The inbox route is unchanged.
- **FR-007**: Owner chat: `POST /v1/chat`, `GET /v1/chat/conversations`,
  `POST /v1/chat/:id/link`; hotkey drafts recorded into conversations; `GET /v1/draft/recent`.
- **FR-008**: Retention per workspace (`workspaces.ask_retention_days`, default 180) with
  `GET/PUT /v1/settings/retention`; deleted and expired conversations are purged.
- **FR-009**: CLI `pama conversations list|show|reply|delete` and `pama chat` as in US5.
- **FR-010**: A multi-turn red-team eval set (≥ 12 cases) runs in the existing `pnpm evals`
  suite with 0 leaks.

## Success criteria

- **SC-001**: `pnpm evals` reports 0 leaks across the 55 existing + 16 multi-turn cases.
- **SC-002**: Server test suite passes, including migration backfill, multi-turn scope safety,
  public and owner routes, owner chat and retention.
- **SC-003**: An existing Ask Link client that never sends `conversation_id` keeps working.
- **SC-004**: `pama chat -q "…" --json` returns the answer, citations and conversation id.
