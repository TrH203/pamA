# Feature Specification: Model Settings in CLI and Web App

**Feature Branch**: `003-model-settings`

**Created**: 2026-10-24

**Status**: Draft

**Input**: User description: "Give the pamA web app a visual Settings area and let the CLI configure the same things easily: configure the embedding model and the chat model, choose local or cloud, switch provider, check compatibility, and check status. Both CLI and web app must be able to do this."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - See and change model settings visually (Priority: P1)

An owner opens Settings in the web app and sees two clearly labeled model roles: **Chat** (digesting, answering) and **Embedding** (search/retrieval). For each role they see the current provider, whether it is local or cloud, the model name and its health. They pick a provider from a list, choose or type a model, enter the endpoint and API key where needed, and save.

**Why this priority**: Today model choices exist only as raw CLI keys. A visual, guided form is the core ask and the smallest slice that delivers value.

**Independent Test**: Open Settings, change the chat provider and model, save, reload the page, and confirm the new values are shown and used for the next digest.

**Acceptance Scenarios**:

1. **Given** a fresh install, **When** the owner opens Settings, **Then** both roles show a sensible default and a status indicator.
2. **Given** the owner selects a provider, **When** the form renders, **Then** only fields relevant to that provider appear (endpoint for self-hosted, key for cloud).
3. **Given** the owner saves valid settings, **When** they reload, **Then** the settings persist and the API key is shown only as "set", never in clear text.
4. **Given** the owner enters an invalid value, **When** they save, **Then** a clear message names the field and nothing is changed.

---

### User Story 2 - Configure the same settings from the CLI (Priority: P1)

An owner runs a guided CLI command to view the current model setup, change a role's provider or model, and set keys, without having to know raw setting names. The CLI and web app always show the same values.

**Why this priority**: The owner explicitly wants parity; the CLI is the main path on headless and self-host machines.

**Independent Test**: Change the embedding model with the CLI, then open Settings in the web app and confirm it shows the change (and vice versa).

**Acceptance Scenarios**:

1. **Given** any state, **When** the owner runs the CLI show command, **Then** it prints chat and embedding provider, local/cloud, model, endpoint and status, with keys hidden.
2. **Given** the owner runs the CLI to set a provider and model for a role, **When** it completes, **Then** the web app shows the same values.
3. **Given** an interactive terminal, **When** the owner runs the guided setup, **Then** it asks role by role with defaults and confirms before saving.
4. **Given** a script, **When** the owner passes all values as arguments and a machine-readable output flag, **Then** it runs without prompts and returns structured output and a failing exit code on error.

---

### User Story 3 - Check status and compatibility before relying on a model (Priority: P2)

Before or after saving, the owner can run a check for a role. The check reports: reachable or not, model found or not, key accepted or not, whether the model supports what pamA needs for that role (for example structured output for chat, vector size for embedding), and latency. When something is wrong it says what to fix.

**Why this priority**: Misconfiguration is the main failure mode; checks turn silent failures into actionable messages. It builds on stories 1-2.

**Independent Test**: Point chat at an unreachable endpoint, run the check, and confirm it reports "unreachable" with a fix hint, from both CLI and web app.

**Acceptance Scenarios**:

1. **Given** a working configuration, **When** the owner runs the check, **Then** each role reports OK with latency.
2. **Given** a model that lacks a required capability, **When** checked, **Then** the result says which capability is missing and suggests alternatives.
3. **Given** an embedding model whose vector size differs from what is already stored, **When** checked or saved, **Then** the owner is warned that existing data must be re-indexed and must confirm before the change applies.
4. **Given** a cloud provider while strict-offline is on, **When** checked or saved, **Then** it is refused with an explanation.

---

### User Story 4 - Switch between local and cloud safely (Priority: P2)

The owner switches a role between a local provider and a cloud provider (and between cloud providers) in one step. The previous configuration is remembered so switching back is one action. Switching to cloud clearly tells the owner what data will leave the machine.

**Why this priority**: Local-first is a core product promise; switching must be easy and never surprising.

**Independent Test**: Switch chat from local to cloud, see the data-leaves-machine notice, confirm, then switch back and find the previous local settings restored.

**Acceptance Scenarios**:

1. **Given** chat on a local provider, **When** the owner switches to cloud, **Then** a notice states what is sent and requires confirmation.
2. **Given** a switch was made, **When** the owner switches back, **Then** the earlier provider, model and endpoint are restored (keys stay in secure storage).
3. **Given** a switch fails its check, **When** the owner declines to keep it, **Then** the previous working configuration remains active.

---

### Edge Cases

- A model change while digests or answers are in flight: in-flight work finishes with the old setting; new work uses the new one.
- Provider unreachable at save time: owner may save anyway (marked "unverified") or cancel.
- Settings changed in CLI and web at nearly the same time: the later save wins and the other surface shows the update on next load.
- Missing or empty API key for a cloud provider: save is blocked with a clear message.
- Server settings in a shared (self-host/cloud) workspace: only owners/admins may change them; others see them read-only.
- Secrets must never appear in output, logs, exports or the web page after entry.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The web app MUST provide a Settings area showing, for the Chat and Embedding roles, provider, local/cloud, model, endpoint, key state and live status.
- **FR-002**: Owners MUST be able to change provider, model and endpoint for each role independently, from both the web app and the CLI.
- **FR-003**: The CLI MUST offer a command to show the full model setup and a guided interactive setup, plus non-interactive arguments with machine-readable output for scripts.
- **FR-004**: The system MUST support at least one local provider and at least one cloud provider per role, and MUST let owners add any compatible self-hosted endpoint.
- **FR-005**: Settings made in the CLI and the web app MUST be the same settings; a change in one MUST be visible in the other.
- **FR-006**: The system MUST provide a status check per role (reachable, model present, key accepted, latency) available from both surfaces.
- **FR-007**: The system MUST provide a compatibility check per role verifying the model supports the capabilities pamA needs for that role, and report missing capabilities with a suggested fix.
- **FR-008**: The system MUST detect an embedding change that invalidates stored vectors, warn the owner, and require explicit confirmation before applying and re-indexing.
- **FR-009**: Switching a role between local and cloud MUST show what data would leave the machine and require confirmation, and MUST be refused when strict-offline is on.
- **FR-010**: The system MUST remember the previous configuration per role so the owner can revert in one action.
- **FR-011**: API keys MUST be stored only in secure storage, shown only as "set"/"not set", and never logged or returned in clear text.
- **FR-012**: Invalid input MUST be rejected with a message naming the field, leaving existing settings unchanged.
- **FR-013**: In shared workspaces only owners/admins MUST be able to change model settings; others MUST see them read-only.
- **FR-014**: The web Settings area and CLI output MUST be available in the same languages the product already supports.

### Key Entities

- **Model Role**: a purpose a model serves (Chat, Embedding); has exactly one active configuration and one remembered previous configuration.
- **Provider Configuration**: provider kind, local or cloud, model name, endpoint, key reference, verified state, last check result.
- **Check Result**: outcome of a status or compatibility check: pass/fail per item, latency, suggested fix, time run.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A new owner can configure both roles and reach a passing check in under 3 minutes from either the web app or the CLI.
- **SC-002**: 100% of model settings changeable in one surface are visible and identical in the other.
- **SC-003**: A switch between local and cloud (or back) takes no more than 3 steps and is reversible in 1.
- **SC-004**: In testing, 95% of misconfigurations (unreachable, wrong key, missing model, missing capability) produce a message that names the cause and a fix.
- **SC-005**: No API key appears in any screen, CLI output, log or export in security review.
- **SC-006**: Status and compatibility checks return a result within 10 seconds for a reachable provider.

## Assumptions

- Builds on the existing provider settings (chat, small, embedding roles; anthropic, openai-compatible, ollama); this feature adds visibility, guidance, checks and switching, not new model-based capabilities.
- The existing secure key storage and strict-offline behavior are reused.
- The web app Settings is part of the owner console; Ask Link visitors never see it.
- Desktop app Settings may reuse the same behavior later; it is out of scope here.
- A "small" helper model role exists today; it is shown under Chat as an advanced option.
- Re-indexing after an embedding change reuses the existing indexing pipeline.
