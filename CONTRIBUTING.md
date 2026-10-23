# Contributing to pamA

Thanks for helping. pamA reads private work sessions, so safety rules are strict.

## Workflow

- We use Spec Kit: specify → (clarify) → plan → tasks → implement. Feature docs live in `specs/`.
- Every change lands through a reviewed pull request. Commits follow
  [Conventional Commits](https://www.conventionalcommits.org/).
- Read `.specify/memory/constitution.md` before your first PR.

## Development

```bash
pnpm install
cargo build --workspace
pnpm --filter @pama/server dev        # local server on 127.0.0.1:7465 (PGlite)
cargo test --workspace && pnpm test   # all tests
pnpm evals                            # red-team suite, must report 0 leaks
```

## Safety-critical code (test first)

Changes to `rules/`, `prompts/`, `apps/server/src/pipeline/`, `apps/server/src/policy/` or
`crates/pama-core/src/redact/` need a failing test first, and `pnpm evals` must stay at zero leaks.

## Licensing

pamA is Apache-2.0. Do not add GPL/AGPL/LGPL code or dependencies; CI blocks them.
