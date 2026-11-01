# Tasks: UI Foundation

**Input**: [spec.md](./spec.md), [plan.md](./plan.md)

## Phase 1: Foundation

- [x] T001 Tokens in `packages/ui/src/theme.css` (@theme: surfaces, sage accent, semantic tints, radii, hairlines, popover shadow, type scale, fonts), dark mode via media query + `data-theme`, reduced motion
- [x] T002 `packages/ui/src/theme.ts`: initTheme/useTheme with persisted choice
- [x] T003 [P] Kit components in `packages/ui/src/components/` (Button, Input, Textarea, Select, Switch, Checkbox, Field, Tabs, Dialog, ConfirmDialog/useConfirm, Toast, Tooltip, Table, Badge/StatusPill/CountBadge, Card, PageHeader, EmptyState, Skeleton, Spinner, ErrorBanner, Notice, CommandPalette)
- [x] T004 Restyle BundleSummary and AutomatedBadge with tokens (API unchanged)
- [x] T005 [P] `packages/i18n` with EN + VI catalogues, provider, detection, `<html lang>` sync
- [x] T006 Server: console deep-link routes + `.woff` type in `apps/server/src/routes/static.ts`, integration test

## Phase 2: Console shell (US2)

- [x] T007 `apps/web/src/lib/providers.tsx` and `lib/query.ts`; typed errors in `lib/api.ts`
- [x] T008 `console/legacy.ts` + `legacy.test.ts` (every v0.1 tab mapped, params kept)
- [x] T009 `console/router.tsx` route tree and `console/Shell.tsx` (collapsible sidebar, mobile menu, count badges, Cmd+K palette, language/theme footer)
- [x] T010 `console/Placeholder.tsx` for Home, Chat, Library, Activity, Conversations landing

## Phase 3: Restyle existing screens (US3)

- [x] T011 Review, Links, LinkCreate, Inbox, Audit, Bundles (as Tasks with explanation), Settings/Placement/Models, Doctor
- [x] T012 Login and DeviceApprove
- [x] T013 Replace `confirm()` with `useConfirm`, bare loading/red text with Skeleton/ErrorBanner, add empty states

## Phase 4: Ask page and desktop (US4, US5)

- [x] T014 Ask page (AskPage, AccessGate, Thread) mobile-first chat layout; strings moved to packages/i18n
- [x] T015 Desktop Popup restyled
- [x] T016 Desktop Settings window restyled, plus Appearance (theme, language)
- [x] T017 Playwright Ask spec selector updated (error now `role="alert"`)

## Phase 5: Tests and polish

- [x] T018 Component tests `apps/web/src/lib/kit.test.tsx` (jsdom): Button, Field, StatusPill, ErrorBanner, useConfirm, i18n coverage and lang switch
- [x] T019 tsc, vitest, vite build, biome for apps/web, packages/ui, packages/i18n; apps/server tsc + vitest
- [ ] T020 Run the Playwright e2e suite against a live dev server (not run in this slice; needs the server + browsers)
- [ ] T021 Translate the remaining English-only hint strings inside individual screens (titles, nav and Ask are translated; some per-screen helper text is still EN)
