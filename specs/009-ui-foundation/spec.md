# Feature Specification: UI Foundation (design tokens, component kit, console shell, i18n)

**Feature Branch**: `feat/009-ui-foundation` | **Created**: 2026-11-01 | **Status**: Implemented
**Input**: docs/plans/v0.2-overhaul.md, section 7 (Spec 009a) and the final decisions in section 9.

## Summary

pamA's web surfaces (owner console, public Ask page, desktop popup and settings window) were built
ad hoc with raw Tailwind classes, `window.confirm`, bare "Loading…" text and a tab-based console.
v0.2 needs one calm, accessible visual language and a console shell that the new feature slices
(Home, Conversations, Chat, Library, Activity) can plug into. This slice delivers that foundation
without building those features' content.

## User Stories

### US1 - One consistent, calm look (P1)

As an owner I see the same warm-neutral surfaces, single sage accent, type scale and controls in
the console, the Ask page and the desktop windows, in light or dark mode.

**Acceptance**
1. Given any page, colours come only from `@theme` CSS variables; no gradients exist anywhere.
2. Given the OS is in dark mode, pages render dark; given a manual choice (System/Light/Dark), it
   overrides the OS via `<html data-theme>` and persists per browser.
3. Given `prefers-reduced-motion: reduce`, transitions and animations are effectively disabled.

### US2 - Navigable console with deep links (P1)

As an owner I navigate the console from a collapsible left sidebar (Home, Review, Conversations,
Links, Chat, Library, Activity, Settings) with URLs I can bookmark and share, and the back button works.

**Acceptance**
1. `/review`, `/links`, `/conversations`, `/library/tasks`, `/activity/audit`, `/activity/doctor`
   and `/settings/connections` open the existing screens; reloading any of them works (the server
   serves `console.html` for every console route).
2. Old `?tab=` links (e.g. `/?tab=bundles`, `/console?tab=links&q=…`) redirect to the new route and
   keep their other parameters.
3. Home, Conversations (beyond the inbox), Chat, Library and Activity sections not built yet show
   an EmptyState placeholder "Coming in v0.2".
4. Sidebar items have count badge slots (Review shows the number waiting); Cmd/Ctrl+K opens a
   command palette to jump to any page.

### US3 - Clear loading, empty, error and confirm states (P1)

As an owner I never see a bare "Loading…" or an unexplained red line; I see skeletons, empty states,
an error banner with Retry, toasts for results, and an in-app dialog instead of `window.confirm`.

### US4 - English and Vietnamese (P2)

As an owner or asker I can use the interface in English or Vietnamese; the console has a language
switch in the sidebar footer, the desktop settings has one too, and `<html lang>` follows the choice.

### US5 - Restyled Ask page and desktop windows (P2)

As an asker on a phone the Ask page is a mobile-first chat layout; as an owner the hotkey popup and
desktop Settings window use the kit. Behaviour (requests, IPC, flows) is unchanged.

## Functional Requirements

- **FR-001** Design tokens in Tailwind v4 `@theme` (packages/ui/src/theme.css): stone/sand
  surfaces, one sage accent with light/dark variants, success/warning/danger with soft tints,
  radii 8px controls / 12px cards, 1px hairline borders, soft shadow for popovers/dialogs only,
  type scale 12/13/14/16/20/24, Inter + JetBrains Mono from @fontsource (no CDN).
- **FR-002** No gradients in any stylesheet or class.
- **FR-003** Dark mode via `prefers-color-scheme` plus manual `data-theme` override; motion
  120-200ms; `prefers-reduced-motion` respected.
- **FR-004** packages/ui kit (owned code, Radix primitives, lucide icons): Button (primary,
  secondary, ghost, danger; sizes; loading), Input, Textarea, Select, Switch, Checkbox, Field
  (label/hint/error wired with aria), Tabs, Dialog, ConfirmDialog + `useConfirm`, Toast provider +
  `useToast`, Tooltip, Table (horizontal scroll wrapper), Badge / StatusPill (icon + text) /
  CountBadge, Card, PageHeader, EmptyState, Skeleton, Spinner, ErrorBanner with Retry, Notice,
  CommandPalette (cmdk). BundleSummary and AutomatedBadge keep working.
- **FR-005** Visible focus rings and AA contrast for text on every surface token.
- **FR-006** Console uses TanStack Router (URL routes, legacy `?tab=` redirect) and TanStack
  Query on top of the shared api client (`apps/web/src/lib/api.ts`, typed `ApiError`).
- **FR-007** Route map: Review `/review`; Links + create `/links`; Inbox `/conversations`; Audit
  `/activity/audit`; Bundles `/library/tasks` labelled "Tasks" with the one-line explanation "A task
  groups agent sessions about the same piece of work, by default one git branch"; Placement +
  Models `/settings/connections`; Doctor `/activity/doctor`; placeholders for Home, Chat, Library,
  Activity. Login and DeviceApprove restyled.
- **FR-008** packages/i18n with EN + VI message catalogues (VI must cover every EN key), a
  provider, browser-language detection, persisted choice and `<html lang>` sync; the Ask strings
  moved there from `apps/web/src/ask/i18n.ts`.
- **FR-009** The server serves `console.html` for all console routes and `.woff` fonts.
- **FR-010** Existing unit, integration and Playwright tests keep passing; Playwright selectors
  updated where the markup changed.

## Success Criteria

- **SC-001** `grep -ri gradient apps/web/src packages/ui/src` finds no styling use.
- **SC-002** No `window.confirm`, bare "Loading…" or hard-coded `text-red-*` / `stone-*` classes
  remain in apps/web/src.
- **SC-003** Every v0.1 `?tab=` value maps to a v0.2 route (unit-tested).
- **SC-004** Component tests cover Button loading, Field aria wiring, StatusPill text+icon,
  ErrorBanner retry, `useConfirm`, VI key coverage and `<html lang>` switching.
- **SC-005** `tsc`, `vitest`, `vite build` and `biome check` pass for apps/web, packages/ui,
  packages/i18n; apps/server tests pass.

## Out of Scope

Real content for Home, Conversations, Chat, Library and Activity (owned by other v0.2 slices),
any API or DB change, Rust/Tauri changes.
