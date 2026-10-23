# Release checklist: pamA v0.1 — quickstart scenarios

Run on 2026-10-23, macOS 26.2 (Apple Silicon), Node 24.22, Rust 1.99, offline (`fake`) models
unless noted. **Windows has not been run yet** and Scenario 3 needs a person at the keyboard, so
this release is not signed off.

| Scenario | How it was checked | macOS | Windows |
|---|---|---|---|
| 1 Capture & digest | `apps/server/tests/e2e/us1-capture.test.ts` — real `pama` binary + server: init, hook, draft without secrets (`AKIA`, DB password), decision with reason, same-branch sessions share a bundle, approve | ✅ | ⬜ not run |
| 2 Ask Link | `apps/web/tests/e2e/ask-link.spec.ts` (Playwright, Chromium) — PIN gate, cited answer, out-of-scope refusal + forward, owner reply shown, 5 wrong PINs → locked, revoke → 410 with no content | ✅ | ⬜ not run |
| 3 Hotkey | `docs/testing/hotkey-matrix.md` (manual) — clipboard logic covered by 6 automated tests; desktop app builds | ⬜ manual run pending | ⬜ not run |
| 4 Local & sync | `apps/server/tests/e2e/us4-sync.test.ts` — off by default, enable → delivered once, re-run no-op, link on the server answers, disable → copies deleted and link 410, device network log has the sync calls | ✅ | ⬜ not run |
| 5 Self-host | `docker compose up` + `deploy/smoke.sh` — healthy, auth required, pair, sync, answer, tombstone; server connects as non-superuser, RLS on | ✅ (build 17 min on this network) | n/a (Linux containers) |

## Done criteria

| Criterion | Result |
|---|---|
| Red-team suite ≥ 50 cases, 0 leaks | ✅ 55 cases, 0 leaks, 1 quality failure (offline models; rerun with real models before release) |
| SC-003 hotkey draft ≤ 3 s p90 | pamA overhead 7 ms p90 (`scripts/perf/bench.mts`); model latency to be measured with the chosen provider |
| SC-004 Ask Link in < 1 min | link creator with ranked suggestions; to be timed with dogfood users |
| SC-008 digest ≤ 2 min p95 | pamA overhead 40 ms p95 for 200 events; model latency to be measured |
| Sidecar ≤ 120 MB | ✅ 103 MB (darwin-arm64) |
| Desktop idle memory ≤ 200 MB | ⬜ `scripts/perf/desktop-memory.sh` once the app runs from an installed bundle |

## Before tagging v0.1

- [ ] Run Scenario 3 (hotkey matrix) on macOS and Windows
- [ ] Run Scenarios 1, 2, 4 on Windows (CI Windows runner covers the Rust build and tests)
- [ ] Rerun `pnpm evals` with the default real models (Anthropic and a local 14B model)
- [ ] Measure SC-003/SC-008 with real models; desktop idle memory
