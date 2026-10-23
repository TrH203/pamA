# Quickstart: validating bundle names and multi-branch sessions

Prerequisites: repo built (`cargo build`, `pnpm install`), see [../001-pama-mvp/quickstart.md](../001-pama-mvp/quickstart.md).

## 1. Parser + filing rule (Rust)
```bash
cargo test -p pama-core adapter_claude adapter_codex filing_branch contract_digest_schema
```
Expect: fixture session main → feat/login (most events) → fix/typo yields three `BranchVisit`s in
order and filing branch `feat/login`; main-only session files under `main`; tie → earliest.

## 2. Server derivation, naming, re-evaluation
```bash
pnpm --filter @pama/server test -- bundles digest-schema sync
```
Expect: first digest sets a suggested name (`name_source=suggested`); rename → `owner` and never
overwritten; re-capturing an unpinned session with a different final branch moves it; pinned
sessions stay; `listBundles` returns `branches`, `session_count`, `last_activity` after merge/split.

## 3. Privacy
```bash
pnpm --filter @pama/server test -- branch-redaction
pnpm evals   # regression gate: must still report 0 leaks (pipeline code changed)
```
Expect: no raw secret/PII-bearing branch name in the stored digest, `session_branches` rows or the sync `pending()` payload (incl. `bundle_name`); evals report 0 leaks.

## 4. End-to-end by hand (demo seed)
1. Start local server with the demo seed; open the console → Bundles.
2. Confirm each bundle shows name title, branch chips, session count and last activity.
3. Rename one bundle; run `pama sync status` and reload the desktop settings; names match.
4. Capture a recorded multi-branch session; confirm all branches appear and the session is under
   the expected bundle.
5. Load a pre-feature digest fixture; confirm it shows one branch and no error.
