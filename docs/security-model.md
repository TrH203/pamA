# Security model

pamA lets other people ask about your AI coding sessions. It is built so that raw sessions never
leave your machine and nothing secret can come back out in an answer. This page describes the
controls; [threat-model.md](threat-model.md) maps them to attacks.

## Data flow

```
agent transcript (your disk) ──read in place──▶ Layer 1 (Rust, on device)
   ──redacted events──▶ local server: digest model ──▶ Layer 2 ──▶ draft digest
   ──you approve──▶ items (embedded, labelled) ──[only if you enable sync]──▶ your server
question ──▶ scope (RLS + filter) ──▶ retrieval ──▶ answer model ──▶ Layer 3 ──▶ cited answer / refusal
```

| Stays on your machine | May leave, only if you enable sync per source |
|---|---|
| Raw transcripts (never copied; read in place) | Approved digests (English summaries) |
| Layer-1-redacted events (only to the local server) | Tombstones that delete them again |
| Drafts, discarded and withdrawn digests | |

The transcript endpoint exists only on the local server: self-hosted and cloud servers answer 403.

## Three redaction layers (Constitution II)

1. **Layer 1, on the device, before any model.** 222 gitleaks rules (ASCII semantics, entropy,
   allowlists) plus pamA rules (connection-string passwords, env assignments, Vietnamese PII),
   and structural rules that drop whole tool results: `.env`/key files read, `env` dumps,
   `cat` of secret files, Codex code cells touching secrets or the environment. Placeholders are
   typed (`[SECRET:aws-access-token]`, `[PII:email]`, `[DROPPED:dotenv-file-read]`).
2. **Layer 2, at ingest.** The same rules run again over every string the digest model wrote, and
   a classifier labels items `business_sensitive`, `infra` or `customer`. Synced digests go
   through Layer 2 again on the receiving server.
3. **Layer 3, before an answer is shown.** Rules re-scan the answer, denied topics are checked, and
   a judge model looks for leaks, off-scope content and unsupported claims. Any failure — including
   the judge failing — refuses the answer and offers to forward the question to you.

The Rust and TypeScript rule engines share one rule directory and golden test outputs, so both
layers redact identically.

## Scope enforcement

Which digests a question may use is decided by data, not by the prompt:

- `resolveLink` turns the link's sources into session ids at query time, adds your workspace's
  default denied labels, and refuses expired or revoked links (410, no content).
- Retrieval runs as the database role `pama_app` with the scope in transaction-local settings, so a
  row-level security policy on `digest_items` filters rows; the query repeats the same filter.
- Answers may only cite items that were retrieved in scope; an answer without citations is refused.
- Project names outside the link never appear in responses.

## Prompt injection

Transcripts, digests and questions are passed to models as data blocks, after the policy. Even when
a model follows an injected instruction, it can only use in-scope items, and secrets were removed
before storage (Layer 1/2) and are checked again on the way out (Layer 3). The red-team suite
(`pnpm evals`, 55 cases) runs on every change to prompts, rules, pipeline or policy code and must
report zero leaks. Removing Layers 2 and 3 together makes it fail (8 leaks), which shows the gate
is real.

## Access to Ask Links

Open, PIN, email one-time code, or email/domain allowlist. PINs and codes are scrypt-hashed; five
failed attempts lock the visitor and the IP for 15 minutes. Access is bound to a signed, httpOnly
cookie scoped to the link — never to the IP address. Per-link and per-visitor hourly limits apply.
Every question is in the audit log (180-day retention), with outcome, citations and guard result.

## The hotkey

The desktop app reads the selected text through Accessibility/UI Automation where possible, else
copies it and restores your clipboard; only the question is kept. A draft is pasted into the field
you were in; pamA has no command that sends a message (Constitution III).

## Network

Every outbound connection made by pamA's processes goes through an egress guard and the network
log. Strict offline mode blocks all hosts except declared ones and loopback. It does not control
other programs (Ollama, vLLM, tunnels). No telemetry; no update checks.

## Accounts and secrets

- Device tokens, provider API keys: OS keychain (macOS Keychain, Windows Credential Manager).
- Local server: bound to 127.0.0.1 with a per-launch token.
- Servers: owner sign-in by email magic link (session cookie, SameSite=Lax) or the operator's owner
  token; devices pair with one-time codes and can be revoked; cloud workspaces are isolated per
  request.

## Known limits

- Rules catch known formats; a secret in an unknown format can pass Layer 1/2. Layer 3's judge and
  your review before approval are the remaining defences — review digests before sharing.
- Small local models are weaker judges: the default answer threshold is stricter for local models.
- Clipboard formats other than text, HTML, images and file lists cannot be restored.
- Windows UI Automation capture is compiled on Windows CI only.
