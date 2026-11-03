# Implementation Plan: UI Foundation

**Branch**: `feat/009-ui-foundation` | **Date**: 2026-11-01 | **Spec**: [spec.md](./spec.md)

## Summary

Build the shared visual layer once (tokens + kit in `packages/ui`, strings in `packages/i18n`),
then move every existing screen onto it and put the console behind a router-driven shell.

## Technical Context

- React 19, Vite multi-page (`ask.html`, `console.html`, `desktop.html`), Tailwind v4.
- New runtime deps: Radix primitives (checkbox, dialog, slot, switch, tabs, toast, tooltip), cmdk,
  clsx + tailwind-merge (`cn`), lucide-react, @tanstack/react-router, @tanstack/react-query,
  @fontsource-variable/inter, @fontsource/jetbrains-mono.
- New dev deps (apps/web): @testing-library/react, user-event, dom, jsdom.
- No DB migration, no API change. One server change: static deep-link routes + `.woff` type.

## Structure

```
packages/ui/src/theme.css        tokens (@theme), dark mode, reduced motion, base styles
packages/ui/src/theme.ts         initTheme / useTheme (system | light | dark)
packages/ui/src/components/*.tsx kit
packages/i18n/src/{en,vi,index}.ts  catalogues + I18nProvider/useI18n
apps/web/src/lib/providers.tsx   I18n + Tooltip + Toast + Confirm providers
apps/web/src/lib/query.ts        QueryClient (no retry on 4xx ApiError)
apps/web/src/console/router.tsx  TanStack route tree
apps/web/src/console/legacy.ts   ?tab= -> route mapping
apps/web/src/console/Shell.tsx   sidebar, count badges, palette, language/theme footer
apps/web/src/console/Placeholder.tsx  "Coming in v0.2"
```

## Decisions

- **Native `<select>` styled**, not Radix Select: better mobile pickers and less code.
- **Theme choice in localStorage** (per-browser convenience, failures ignored); the default follows
  the OS.
- **Legacy redirect before the router mounts**, implemented as a pure function so it is unit tested.
- **Server serves console.html per top-level section** (explicit list, not a catch-all) so `/a/*`,
  `/v1/*` and static assets keep their handlers.
- **i18n as a workspace package** so console, desktop and Ask share one catalogue; the type of
  `en` forces `vi` to provide every key.

## Constitution Check

No data leaves the device in new ways; no new network calls; fonts are bundled (works offline).
Safety-critical paths unchanged. Passes.
