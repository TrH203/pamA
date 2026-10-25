# Tasks: Model Settings in CLI and Web App

## Phase 1 — Server foundation
- [x] T001 Migration `apps/server/migrations/0008_model_settings.sql`
- [x] T002 Export `isLocal` from `src/llm/providers.ts`
- [x] T003 [P] Tests first: `tests/unit/model-settings.test.ts` (masking, offline refusal, confirmations, revert, embed dimension)
- [x] T004 `src/llm/check.ts` — status + compatibility checks (US3)
- [x] T005 `src/llm/settings.ts` — view/apply/revert/hot swap/key encryption (US1, US4)
- [x] T006 `src/routes/models.ts` and mount in `src/app.ts`; init in `src/index.ts` and `tests/helpers/ctx.ts`
- [x] T007 Re-embed on confirmed embedding change (FR-008)

## Phase 2 — Web (US1, US3, US4)
- [x] T008 `apps/web/src/console/Settings.tsx` + tab in `main.tsx`

## Phase 3 — CLI (US2)
- [x] T009 `crates/pama-cli/src/cmd/model.rs` + clap wiring in `main.rs`/`cmd/mod.rs`
- [x] T010 CLI parse tests

## Phase 4 — Polish
- [x] T011 Typecheck, lint, tests, README/docs mention
