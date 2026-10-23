# Threat model

Scope: pamA MVP v0.1 (desktop + CLI + local server; self-host/cloud server; Ask Link page).
Assets: secrets and personal data in agent sessions; the owner's decisions and business details;
the owner's reputation (answers in their name).

| # | Threat | Actor | Controls | Tests |
|---|---|---|---|---|
| T1 | Secret in a transcript reaches a digest or an answer | any asker | Layer 1 rules + structural drops on device; Layer 2 re-scan at ingest; Layer 3 re-scan + judge | `redaction_rules`, `redact_events`, digest-pipeline, guard, evals `secret-*` |
| T2 | Asker learns about another project or a denied topic | asker | link scope resolved at query time; RLS + SQL filter; cite-only-retrieved; denied labels/topics; names outside scope never returned | scoped-repo, resolve-link, public-api, evals `cross-*` |
| T3 | Prompt injection in the question | asker | policy-first prompt, question as data; scope and secrets enforced outside the model | evals `inject-*` |
| T4 | Instructions planted in a transcript or digest | someone who wrote into the session (pasted ticket, repo file) | digest prompt treats transcript as data; secrets removed before storage; Layer 3 | evals `inject-digest-*` |
| T5 | Brute-forcing a PIN or code | asker | scrypt hashes; 5 failures → 15-minute lock per cookie and per IP; rate limits | access tests, Playwright lockout |
| T6 | Link forwarded to the wrong people | owner mistake | access modes, expiry (max 90 days), rate limit, instant revoke (410 without content), audit log | resolve-link, static, public-api |
| T7 | Access shared across browsers on one network | other people on the same NAT | access bound to signed cookie, never IP | access "never inherited" test |
| T8 | Raw transcripts leave the machine | software bug, misconfiguration | transcript endpoint local-only (403 elsewhere); sync sends approved digests only; opt-in per source | transcripts-local-only, sync tests |
| T9 | Synced copies outlive the owner's decision | owner turns sync off / withdraws | tombstones with portable keys; stale deliveries rejected (409); links over deleted sources stop | sync tests, US4 e2e, smoke |
| T10 | Stolen or lost laptop keeps pushing | thief | device revoke → 401; tokens in OS keychain | sync tests |
| T11 | Hotkey sends a message in the owner's name | bug | no send command exists; paste only; capability lists exact commands | clipboard tests, capability file |
| T12 | Clipboard contents leak | other apps / logs | snapshot + restore; only the question kept; no clipboard logging | clipboard tests |
| T13 | Unwanted network egress (telemetry, model calls to the cloud in "offline" mode) | — | egress guard + network log on server and device; strict offline; no telemetry/updater | egress, egress-strict, net_guard, no_telemetry |
| T14 | Cross-workspace access on a cloud server | another customer | per-request workspace from session/device/link; every query filtered by workspace | auth "cloud workspaces" test |
| T15 | Server compromise | attacker | server stores only approved digests (no transcripts); DB user is not a superuser; RLS on items | compose smoke |
| T16 | Wrong answers in the owner's name | model error | cite-or-refuse; confidence threshold; judge for unsupported claims; answers labelled automated; feedback buttons | answer/guard tests, evals `halluc-*` |

Out of scope for v0.1: compromised owner machine (it holds the raw transcripts by design),
malicious model providers (use local models or self-host vLLM), denial of service on public links
beyond rate limits.
