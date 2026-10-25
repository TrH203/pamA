# Implementation Plan: Model Settings in CLI and Web App

**Branch**: `003-model-settings` | **Date**: 2026-10-24 | **Spec**: [spec.md](spec.md)

## Summary

Make the chat, small and embedding model roles configurable at runtime. The server becomes the single
source of truth (a `model_settings` table layered over env defaults), exposes owner-only endpoints to
read, check, apply and revert settings, and hot-swaps its model objects without a restart. The web
console gets a Settings tab; the CLI gets `pama model …`, both thin clients of the same endpoints.

## Technical Context

**Language/Version**: TypeScript (Node 24, Hono, zod, Vercel AI SDK) server + React/Vite web; Rust stable CLI (clap)
**Storage**: Postgres/PGlite — new table `model_settings`; keys encrypted with the server secret
**Testing**: vitest (server unit/integration, PGlite + fake models); cargo test (CLI parsing); typecheck
**Target Platform**: local sidecar, self-host, cloud (same code, Constitution IV)
**Project Type**: web-service + CLI + web console
**Performance Goals**: status/compat check result in ≤10 s (SC-006); save/apply is instant
**Constraints**: strict-offline must block cloud; no key ever returned or logged
**Scale/Scope**: 3 roles (chat, small, embed), 1 process-wide config per server

## Constitution Check

| Principle | Result |
|---|---|
| I Local-first & privacy | PASS. Switching to cloud needs explicit confirmation; strict-offline blocks it; checks go through the egress guard (logged). |
| II Redaction/scope | PASS. Untouched; settings routes are owner-only. |
| III Platform independence | PASS. No chat-platform dependency. |
| IV One codebase | PASS. One server implementation; CLI/web are clients. |
| V Test-first | PASS. Tests for secret masking, offline refusal and confirmation gates written before implementation. |
| VI Simplicity | PASS with one note. No new services. Keys: the server has no OS keychain, so keys are AES-GCM encrypted in the DB with the server secret (see Complexity Tracking). |

## Complexity Tracking

| Deviation | Why | Simpler alternative rejected because |
|---|---|---|
| API keys stored encrypted in the DB instead of the OS keychain (Technical Constraints) | Self-host/cloud servers have no keychain; web UI must be able to set keys | Env-only keys cannot be set from the web app, which is the feature's point. Keys are never returned, logged or exported. |

## Project Structure

```text
specs/003-model-settings/{spec,plan,research,data-model,quickstart,tasks}.md, contracts/
apps/server/
├── migrations/0008_model_settings.sql
├── src/llm/settings.ts        # service: view/check/apply/revert, encryption, hot swap
├── src/llm/check.ts           # status + compatibility checks
├── src/routes/models.ts       # /v1/models/*
└── tests/{unit,integration}/model-settings*.test.ts
apps/web/src/console/Settings.tsx   # new tab
crates/pama-cli/src/cmd/model.rs    # pama model show|set|check|switch|revert|setup
```
