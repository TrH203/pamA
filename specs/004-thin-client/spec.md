# Feature Specification: Thin Client (CLI-only install, remote server)

**Feature Branch**: `004-thin-client`

**Created**: 2026-10-25

**Status**: Draft

**Input**: User description: "Thin client (option B): the user installs only the single `pama` binary and connects to pamA Cloud or a self-hosted server; no Node, embedded database or local server process on the machine. The constitution stays as is: raw transcripts NEVER leave the machine. Scope: (1) `pama login --server <url>` with a device/browser flow (open browser, confirm, CLI receives a device token stored in the OS keychain), replacing manual pairing codes; `pama logout`. (2) Digest drafting (read transcript, redact secrets, call an LLM to extract key ideas/decisions) runs on the machine inside the core library, calling a cloud LLM provider (Anthropic / OpenAI-compatible) or local Ollama directly; only redacted digest drafts are sent to the server. (3) In remote mode, review, link, inbox, reply, log, model, console and sync status talk directly to the remote server with the device token; the global `--server` flag works. (4) The current local mode (local server process) stays supported; the user picks the mode at login/init. (5) Cloud server: endpoint receiving digest drafts from devices, review in the web console, Ask Links served from the cloud; a cloud deployment guide. Out of scope: chat-platform bots, sending raw transcripts to the server."

## Overview

Today every pamA install runs a local server process with its own database on the owner's
machine; a remote server only receives copies of approved digests. This feature adds a **remote
mode**: the machine runs only the `pama` command (capture hooks + on-device digest drafting), and
everything else (review, Ask Links, inbox, audit log, console) lives on a remote server — pamA
Cloud or the team's self-hosted server. Local mode keeps working unchanged.

### Actors

- **Owner**: a person who codes with AI agents and installs `pama` on their machine.
- **Asker**: someone who uses the owner's Ask Link (unchanged by this feature).
- **Operator**: whoever runs the remote server (the pamA Cloud team or a company's admin).

## Clarifications

### Session 2026-10-25

- Q: In remote mode, which copy is the source of truth for digests reviewed on the web? → A: The
  machine keeps every draft; review decisions made on the server are pulled back to the machine.
- Q: On pamA Cloud, who provides the models that answer Ask Links? → A: Both — operator-provided
  defaults, with optional bring-your-own provider key per workspace.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Connect a new machine with one login (Priority: P1)

An owner installs only the `pama` command, runs a login command with the server address (or no
address for pamA Cloud), and a browser page opens showing a short code. They sign in on that page
(new owners create their workspace there), confirm the code matches, and approve the device. The
command finishes by itself, saying which workspace the machine is now connected to. Logging out
removes the machine's credential and revokes it on the server.

**Why this priority**: without a simple connection step nothing else in remote mode is usable, and
it replaces today's manual "create a pairing code in the console, paste it in the terminal" flow.

**Independent Test**: on a clean machine with only `pama` installed, run login against a test
server, approve in the browser, then run a status command and see the workspace name; run logout
and confirm the server lists the device as revoked.

**Acceptance Scenarios**:

1. **Given** a machine with only `pama` installed, **When** the owner runs login and approves in
   the browser, **Then** the command reports success within 5 seconds of approval and the
   credential is stored in the OS secret store, never in a plain file.
2. **Given** a machine where no browser can be opened (SSH, headless), **When** the owner runs
   login, **Then** the command prints a URL and code that can be approved from any other device.
3. **Given** the owner denies the request or the code expires (10 minutes), **When** the command
   is waiting, **Then** it stops with a clear message and a non-zero exit code and stores nothing.
4. **Given** a logged-in machine, **When** the owner runs logout, **Then** the local credential is
   deleted and the device appears as revoked in the console.
5. **Given** an existing pairing-code flow, **When** an owner still uses it, **Then** it keeps
   working (backward compatible).

---

### User Story 2 - Capture and draft digests without a local server (Priority: P1)

After login and `pama init` in a project, the owner keeps coding with Claude Code or Codex. When
a session ends, `pama` reads the transcript on the machine, removes secrets, asks the configured
model to draft the key ideas and decisions, and sends only the redacted draft to the remote
server, where it waits for review. No other pamA process keeps running on the machine.

**Why this priority**: this is the core value of the thin client — "install one command" — and
the place where the privacy promise must hold.

**Independent Test**: with remote mode active and no local server binary installed, end a coding
session; confirm a draft appears on the remote server, the machine's process list has no pamA
server, and the network log shows no request carrying transcript text.

**Acceptance Scenarios**:

1. **Given** remote mode and an initialized project with sync enabled, **When** an agent session
   ends, **Then** a redacted draft digest reaches the remote server and the agent is never slowed
   or broken by the hook.
2. **Given** a transcript containing a secret (API key, password, private key), **When** the draft
   is produced, **Then** the secret is absent from everything sent to both the model provider and
   the remote server.
3. **Given** the configured model is a local one (e.g. on the same machine or LAN), **When** a
   draft is produced, **Then** no third-party host is contacted except the remote pamA server.
4. **Given** the machine is offline or the server is down, **When** sessions end, **Then** drafts
   wait on the machine and are delivered exactly once when the connection returns.
5. **Given** the same transcript in local mode and in remote mode, **When** drafts are produced,
   **Then** both modes apply the same redaction rules and produce digests of the same structure.
6. **Given** a project where sync is not enabled, **When** a session ends in remote mode, **Then**
   nothing about that project is sent anywhere and the owner is told how to enable it.

---

### User Story 3 - Use every owner command against the remote server (Priority: P1)

In remote mode the owner uses the same commands as today — review drafts, manage Ask Links, read
the inbox and reply, view the audit log, check sync status, open the console — and they act on
the remote workspace. A global server option lets the owner point any single command at a
different server they are logged in to.

**Why this priority**: parity is what makes the thin client a real replacement for the local
install rather than a sync add-on.

**Independent Test**: in remote mode, approve a draft with the CLI, create an Ask Link, ask a
question through the link from another device, see it in the inbox and reply — all without a
local server — then check the same items in the web console.

**Acceptance Scenarios**:

1. **Given** remote mode, **When** the owner runs review, link, inbox, reply, log or sync status,
   **Then** the results come from the remote workspace and match what the web console shows.
2. **Given** remote mode, **When** the owner runs the console command, **Then** the remote
   console opens in the browser already signed in to the same workspace (or at its sign-in page).
3. **Given** the owner passes the global server option for a server they are logged in to,
   **When** any owner command runs, **Then** it acts on that server for that command only.
4. **Given** the owner passes the server option for a server they are not logged in to, **When**
   the command runs, **Then** it fails with a message suggesting the login command.
5. **Given** the remote credential was revoked, **When** any command runs, **Then** it fails with
   a "not authorized, log in again" message and a configuration exit code.

---

### User Story 4 - Review drafts in the web console (Priority: P2)

Drafts sent from the owner's machines appear in the remote web console, labelled with the
originating machine and project. The owner can approve, edit, or discard them there (or from the
CLI); approved digests become available to the owner's Ask Links immediately.

**Why this priority**: the web console is the natural review surface once nothing runs locally,
but CLI review (Story 3) already covers the minimum.

**Independent Test**: produce a draft from a machine in remote mode, approve it in the web
console, and ask an Ask Link question that is answered from it.

**Acceptance Scenarios**:

1. **Given** drafts from two machines, **When** the owner opens review in the console, **Then**
   each draft shows its source machine and project.
2. **Given** the owner edits and approves a draft in the console, **When** an asker asks a related
   question, **Then** the answer cites the approved digest.
3. **Given** the owner disables sync for a project from the machine, **When** the change reaches
   the server, **Then** that project's drafts and digests are deleted from the server and links
   stop answering from them.
4. **Given** auto-approve is on for a project, **When** a draft arrives, **Then** it is approved
   without manual review, exactly as in local mode.

---

### User Story 5 - Choose and switch between local and remote mode (Priority: P2)

During first setup the owner chooses local mode (everything on this machine, current behaviour)
or remote mode (log in to a server). They can later switch. The status and doctor commands always
say which mode is active and whether it is healthy.

**Why this priority**: local mode must stay first-class (privacy, offline), and owners need a
clear, reversible choice.

**Independent Test**: start in local mode, switch to remote mode, confirm new sessions go to the
remote server; switch back and confirm the local server is used again and nothing was lost.

**Acceptance Scenarios**:

1. **Given** a new install, **When** the owner runs init interactively, **Then** they are asked to
   choose local or remote mode, with a one-line explanation of what runs where.
2. **Given** local mode with existing approved digests, **When** the owner switches to remote mode,
   **Then** they are offered to upload existing approved digests per project (opt-in), and nothing
   is uploaded without that choice.
3. **Given** remote mode, **When** the owner runs doctor, **Then** it reports the mode, server
   reachability, login state, drafting model health, and pending deliveries.
4. **Given** a remote-mode install without the local server component, **When** the owner switches
   to local mode, **Then** they are told what must be installed.

---

### User Story 6 - Operate pamA Cloud / a remote server for many owners (Priority: P3)

An operator deploys the server in cloud mode following a single guide. Owners sign up themselves,
each getting a separate workspace; data of one workspace is never visible to another.

**Why this priority**: needed to offer a hosted service, but the thin client can be proven against
a self-hosted server first.

**Independent Test**: follow the cloud deployment guide on a clean host, sign up two owners,
connect one machine each, and confirm neither can see the other's drafts, digests, links or
inbox through the CLI, the console or the API.

**Acceptance Scenarios**:

1. **Given** a clean host, **When** an operator follows the cloud guide, **Then** the server is
   reachable over HTTPS with sign-up working within 30 minutes.
2. **Given** two workspaces, **When** a device of workspace A requests any resource of workspace B,
   **Then** the request is refused and nothing about B is revealed.

### Edge Cases

- The owner is logged in to several servers: one is the default, others are reached with the
  global server option; credentials are kept per server.
- The device clock is wrong: login and delivery still work (the server decides expiry).
- The drafting model is unreachable or misconfigured: the capture is kept and retried with
  backoff; doctor and status show the failure and how to fix it; nothing is sent to the server.
- A transcript is very large: drafting still completes within the model's limits (the transcript
  is reduced on the machine before any model call).
- The same session is captured twice (hook + scan): the server stores one draft.
- The owner logs out with undelivered drafts: they are told how many are pending and asked
  whether to keep them for the next login or delete them.
- The workspace was deleted on the server: commands fail with a clear message; local data on the
  machine is untouched.
- Strict offline mode in remote mode: only the declared remote server and declared model endpoints
  may be contacted; anything else is blocked and logged.
- A command needs a feature the remote server is too old to support: the owner gets a clear
  "server version too old" message.

## Requirements *(mandatory)*

### Functional Requirements

**Connection**

- **FR-001**: Owners MUST be able to connect a machine to a remote server with one login command
  that uses a browser approval flow with a short, human-comparable code, and MUST be able to
  complete the approval from a different device than the one running the command.
- **FR-002**: Login MUST let new owners create their workspace during the browser step on servers
  that allow sign-up; self-hosted servers restricted to one owner MUST only accept that owner.
- **FR-003**: The device credential MUST be stored only in the OS secret store, be scoped to one
  workspace, be listed in the console, and be revocable from the console or by logging out.
- **FR-004**: Login requests MUST expire after 10 minutes and be single-use.
- **FR-005**: The existing pairing-code flow MUST keep working.

**On-device drafting**

- **FR-006**: In remote mode the machine MUST run no pamA background service; capture, redaction
  and drafting MUST run within short-lived `pama` command invocations triggered by the agent hooks
  or by the owner.
- **FR-007**: Raw transcripts MUST never be sent to the remote server. Before any model call, the
  on-device redaction layer MUST remove secrets using the same rule set as local mode.
- **FR-008**: Drafting MUST support at least one cloud provider (Anthropic), any OpenAI-compatible
  endpoint, and a local Ollama model, configured on the machine; provider keys MUST be stored in
  the OS secret store.
- **FR-009**: Local mode and remote mode MUST produce digests from the same transcript using the
  same redaction rules, the same drafting instructions and the same digest structure, so that a
  change in one mode applies to both.
- **FR-010**: Undelivered drafts MUST be kept on the machine and delivered exactly once, with
  retry and backoff, when the server becomes reachable.
- **FR-011**: The server MUST apply its ingest-time safety layer (PII rules + classification) to
  drafts arriving from devices, as it does in local mode.
- **FR-012**: Sync MUST remain opt-in per project or bundle and off by default; in remote mode,
  enabling a project during init MUST be an explicit choice by the owner.

**Remote commands**

- **FR-013**: In remote mode, review, link, inbox, reply, log, sync status, model and console
  commands MUST act on the remote workspace and show the same data as the web console.
- **FR-014**: A global server option MUST direct a single command to any server the machine is
  logged in to; the default server MUST be the one chosen at login.
- **FR-015**: Commands MUST keep the existing exit codes (user error, configuration/auth, network,
  safety) and machine-readable output option.
- **FR-016**: The console command MUST open the remote console without asking the owner to sign
  in again when a valid session can be established from the device credential.

**Server**

- **FR-017**: The server MUST accept redacted drafts from devices, attribute them to the device and
  project, and present them for review in the console and through the API.
- **FR-018**: Review actions (approve, edit, discard, auto-approve) MUST behave identically
  whether done in the console or the CLI.
- **FR-019**: Disabling sync or deleting a source on the machine MUST delete the corresponding
  drafts and digests on the server and stop links from using them.
- **FR-020**: In cloud mode, every request MUST be confined to the caller's workspace in the data
  layer.
- **FR-021**: A cloud deployment guide MUST cover HTTPS, sign-up email, models for answering,
  backups and upgrades.

**Mode selection**

- **FR-022**: Owners MUST choose local or remote mode at first setup and be able to switch later;
  switching MUST never upload existing data without a per-project opt-in.
- **FR-023**: Doctor and status MUST report the active mode, login state per server, server
  reachability and version compatibility, drafting model health and pending deliveries.
- **FR-024**: Strict offline mode MUST apply in remote mode, allowing only declared endpoints.

**Source of truth and answering models**

- **FR-025**: In remote mode the machine MUST remain the source of truth for digests (Constitution
  I): it keeps every draft it produced and its review state; review decisions made on the server
  (approve, edit, discard) MUST be pulled back to the machine the next time any `pama` command
  runs against that server. When the machine and the server disagree, the latest review decision
  wins; a deletion (sync off, source deleted) on the machine always wins over the server.
- **FR-026**: On pamA Cloud the operator MUST provide default answering models for all workspaces,
  and each owner MAY instead set their own provider and key for their workspace; owner keys MUST
  be stored encrypted on the server, never shown back in clear text, and only used for that
  workspace.

### Key Entities

- **Server connection**: a remote server the machine is logged in to — address, workspace, device
  identity, whether it is the default; its credential lives in the OS secret store.
- **Login request**: a pending browser approval — short code, expiry, status (pending, approved,
  denied, expired), the device name requesting it.
- **Device**: a machine connected to a workspace — name, last seen, revoked or not (exists today,
  extended with login-flow origin).
- **Draft digest (remote)**: a redacted digest drafted on a machine, delivered to the server —
  source machine, project/bundle, session reference, items, review state.
- **Mode**: the per-machine choice of local or remote, plus the default server for remote.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An owner goes from "nothing installed" to a first draft visible on the remote server
  in under 10 minutes, installing only one program.
- **SC-002**: In remote mode, no pamA process remains running on the machine more than 60 seconds
  after the last agent session ended (excluding retries in progress).
- **SC-003**: Across the red-team evaluation suite, 0 raw transcript fragments and 0 seeded
  secrets reach the remote server or the model provider.
- **SC-004**: Agent session end is never delayed by more than the existing hook budget (1.5 s) by
  pamA in remote mode.
- **SC-005**: 100% of owner commands available in local mode work in remote mode with identical
  output structure.
- **SC-006**: Drafts produced while offline are delivered within 1 minute of connectivity
  returning, with 0 duplicates.
- **SC-007**: 0 cross-workspace data exposures in the isolation test suite.
- **SC-008**: The installed footprint for remote mode is a single file under 30 MB.

## Assumptions

- No hosted pamA Cloud instance exists yet: `pama login` without a server uses the address
  configured by the build or environment, otherwise asks for one.
- The browser approval flow follows the common device-authorization pattern (as used by popular
  developer CLIs); the remote console's existing email magic-link sign-in is reused for the
  browser step.
- Desktop app (hotkey) support for remote mode is out of scope for this feature; the desktop app
  continues to use local mode. A follow-up feature will connect it to remote servers.
- Billing, team accounts, SSO and quotas for pamA Cloud are out of scope.
- The answer pipeline (retrieval, prompting, guard, escalation) stays on the server, unchanged.
- Self-host servers can run in cloud mode (multi-owner) or self-host mode (single owner); the thin
  client works with both.
- Out of scope: chat-platform bots, uploading raw transcripts, migrating existing remote replicas
  between servers.
