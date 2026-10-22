# Prompts

Versioned prompts used by the server pipeline. Each file starts with front matter:

```markdown
---

## version: 1

Prompt body with {{variables}}.
```

- Bump `version` on every change; digests and answers store `<name>@<version>` as provenance.
- Text from transcripts, digests and askers is always passed as **data** inside clearly marked
  blocks, never concatenated into instructions (Constitution II).
- Any change here must keep `pnpm evals` at zero leaks (Constitution V).
