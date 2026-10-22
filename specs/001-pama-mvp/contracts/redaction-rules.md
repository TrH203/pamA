# Redaction Rules Contract (`rules/`)

One rules directory is the single source of truth for Layer 1 (Rust, device) and the rule part of
Layer 3 (TypeScript, server). Format is a superset of gitleaks' TOML so upstream rules can be
vendored unchanged.

## Files

```text
rules/
├── gitleaks.toml        # vendored from gitleaks (MIT) — do not edit; update via script
├── pama.toml            # pamA rules (file paths, command outputs, PII for VN, connection strings)
├── LICENSE-gitleaks     # upstream license + attribution
└── tests/
    ├── positives/*.txt  # must be redacted
    └── negatives/*.txt  # must be left intact
```

## Rule schema (TOML)

```toml
[[rules]]
id = "aws-access-token"          # stable, kebab-case; used in placeholder
description = "AWS access key"
regex = '''(?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16}'''
secretGroup = 0                  # capture group to replace (default 0 = whole match)
entropy = 3.0                    # optional Shannon entropy floor for the secret group
keywords = ["akia", "asia"]      # optional case-insensitive prefilter
category = "secret"              # pamA extension: secret | pii (default secret)
  [[rules.allowlists]]
  regexes = ['''AKIAIOSFODNN7EXAMPLE''']

# pamA extension: structural rules applied to normalized transcript events
[[structural]]
id = "dotenv-file-read"
match = { tool = "read", path_glob = ["**/.env", "**/.env.*", "**/*.pem", "**/id_rsa*", "**/id_ed25519*"] }
action = "drop_content"          # drop_content | redact_all
[[structural]]
id = "env-dump"
match = { tool = "bash", command_regex = '''^\s*(env|printenv|set)\s*$''' }
action = "drop_content"
```

## Semantics

- Regexes are compiled with **ASCII semantics** (gitleaks parity, see research R3).
- Replacement token: `[SECRET:<id>]` for `category=secret`, `[PII:<id>]` for `category=pii`.
- Counts per rule are returned and stored in `SessionDigest.redactions.by_rule`.
- The TypeScript loader translates RE2-only syntax: a leading `(?i)` becomes the `i` flag,
  `\z` becomes `$` (no `m` flag); scoped modifiers such as `(?i:...)` rely on JavaScript RegExp
  modifiers support in Node 24 (**VERIFY** in CI). A rule that cannot be translated is reported
  and stays enforced by the Rust Layer 1 only.
- CI: every rule must compile in Rust; the JS compile report must list zero untranslated rules
  from `pama.toml`; all `positives` are redacted and all `negatives` untouched in both runtimes
  (Constitution V).
