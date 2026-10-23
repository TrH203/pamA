# Feature Specification: Bundle Names and Multi-Branch Sessions

**Feature Branch**: `002-bundle-names-branches`

**Created**: 2026-10-23

**Status**: Draft

**Input**: User description: "Bundle display names and multi-branch tracking per session. (1) Bundles get a human-readable display name (suggested from session digests, owner can rename) separate from the stable bundle key. (2) A single agent session can span multiple git branches: the system must record every branch a session touched, in order, with first/last seen time instead of only the last one; the session is still assigned to exactly one bundle (branch with the most activity, ignoring main/master when another branch exists). (3) Everywhere bundles are shown, display the bundle name as the title with its branches as chips below, with session count and last activity. Branch names must go through existing redaction/privacy rules before sync."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Recognize a bundle by a meaningful name (Priority: P1)

A pamA owner opens the list of bundles in a project and sees each one titled with a short, human-readable name such as "Google sign-in" instead of a raw branch key such as `feat/gsi-v2`. When a bundle is first created the system proposes a name drawn from what its sessions were about; the owner can accept it or rename it at any time. Renaming never changes which sessions belong to the bundle.

**Why this priority**: Asking "what is this bundle?" is the reason for this feature. A readable title is the smallest slice that already lets owners and askers understand their work at a glance.

**Independent Test**: Capture two sessions on one branch, open the bundle list, confirm a suggested name appears; rename it; confirm the new name shows everywhere and that capturing a further session on the same branch still lands in the same bundle.

**Acceptance Scenarios**:

1. **Given** a newly created bundle with at least one digested session, **When** the owner views the bundle list, **Then** the bundle shows a suggested human-readable name and not only the raw branch key.
2. **Given** a bundle with a suggested name, **When** the owner renames it, **Then** the new name is shown on every surface and persists after restart and sync.
3. **Given** an owner-renamed bundle, **When** new sessions are added to it, **Then** the system does not overwrite the owner's name with a new suggestion.
4. **Given** a bundle whose session digests are not yet available, **When** the owner views it, **Then** it shows a sensible fallback title (the branch key) until a name is suggested or set.

---

### User Story 2 - See which branches a bundle covers (Priority: P1)

Under each bundle title the owner sees small chips listing the branches its sessions worked on, together with the number of sessions and the time of the latest activity. The same summary is shown in the CLI, the web app and the desktop app.

**Why this priority**: The owner explicitly asked for branches to be visible so people understand what the bundle contains; it is equally important as the name.

**Independent Test**: Create a bundle whose sessions span two branches and verify both branches, the session count and last-activity time appear identically in CLI, web and desktop.

**Acceptance Scenarios**:

1. **Given** a bundle whose sessions touched branches `feat/login` and `feat/login-fix`, **When** the bundle is displayed, **Then** both branches appear as chips under the title.
2. **Given** a bundle with 4 sessions, **When** it is displayed, **Then** it shows "4 sessions" and the time of the most recent session activity.
3. **Given** two bundles are merged or a session is moved between bundles, **When** the bundle is displayed afterwards, **Then** its branch chips, session count and last activity reflect the new membership without manual refresh steps.
4. **Given** a bundle with more branches than fit in the available space, **When** it is displayed, **Then** the chips are truncated with a "+N more" indicator and the full list is available on demand.

---

### User Story 3 - A session that switches branches is recorded faithfully (Priority: P1)

An owner starts a coding-agent session on `feat/login`, then checks out `fix/typo` and keeps working in the same session. pamA records both branches, in the order they were visited, with when each was first and last seen. The session is still filed under exactly one bundle: the branch where most of the session's activity happened, ignoring `main`/`master` whenever any other branch is present.

**Why this priority**: Today only the last branch is kept, so work done on earlier branches is silently misfiled. This is the data correctness fix everything else displays.

**Independent Test**: Feed a recorded session that moves `main` → `feat/login` (most activity) → `fix/typo` and confirm the session lists all three branches in order, is filed under the `feat/login` bundle, and that a session that only ever used `main` is filed under `main`.

**Acceptance Scenarios**:

1. **Given** a session with activity on `feat/login` (30 events) then `fix/typo` (5 events), **When** it is captured, **Then** both branches are recorded in visit order with first/last seen times and the session is filed under the `feat/login` bundle.
2. **Given** a session that moved between `main` and `feat/x`, **When** it is captured, **Then** it is filed under `feat/x` even if `main` had more events.
3. **Given** a session that only used `main`, **When** it is captured, **Then** it is filed under `main`.
4. **Given** two branches tie for the most activity, **When** the session is filed, **Then** the earliest-visited of the tied branches is chosen, deterministically.
5. **Given** a session with no branch information (no repository or detached HEAD), **When** it is captured, **Then** it behaves exactly as sessions without a branch do today.
6. **Given** the same session is captured again after more activity, **When** the branch list changes, **Then** the stored branch list is updated, and the bundle assignment is re-evaluated without creating duplicate sessions.

---

### User Story 4 - Branch names stay private and old data keeps working (Priority: P2)

Branch names can reveal client names or ticket numbers. When sync is enabled for a source, branch names pass through the same redaction rules as other digest content before leaving the machine; names that fail redaction are masked. Existing digests, devices and servers that know only the single-branch field continue to work unchanged.

**Why this priority**: Privacy is a constitutional principle and compatibility protects existing installations, but the feature is useful locally before this lands.

**Independent Test**: Sync a session whose branch is `acme-corp/secret-deal-AKIA…` and verify the stored/replicated digest contains the masked form only; load a digest created before this feature and verify it still displays and syncs.

**Acceptance Scenarios**:

1. **Given** a branch name containing a secret-like token or personal data, **When** the digest is prepared for sync, **Then** the redacted form is sent and the raw name never leaves the machine.
2. **Given** sync is off for a source, **When** sessions are captured, **Then** branch lists are stored locally only and nothing is sent.
3. **Given** a digest produced before this feature (single branch only), **When** it is displayed, **Then** it shows that one branch and no error occurs.
4. **Given** an older client sends a digest with only the single branch field, **When** the server receives it, **Then** it is accepted and treated as a one-branch list.

---

### Edge Cases

- Branch names that differ only in case or contain unusual characters, slashes, or very long text (over the existing length limit): they are stored as given up to the limit and compared exactly; over-long names are truncated consistently.
- A session that switches back to an earlier branch (`A` → `B` → `A`): the branch appears once in the list, with first-seen from the first visit and last-seen from the latest, and the visit order reflects first appearance.
- Very large number of branches in one session: the list is capped and the cap is visible to the user (not silent loss of the filing branch).
- A branch that has since been deleted in git: still shown, since it is history.
- Owner renames a bundle to a name that duplicates another bundle's name in the same project: allowed, because identity is the key, not the name.
- Two devices of the same owner capture the same session with different branch lists: lists are merged as a union, ordered by first-seen time.
- Suggested name generation unavailable (offline, no model): the fallback title is used and the system keeps working.
- Redaction masks a branch name: the chip shows the masked form and the bundle key used for filing is not altered by masking locally.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Each bundle MUST have a display name that is separate from its stable key; the key MUST NOT change when the name changes.
- **FR-002**: When a bundle is created, the system MUST propose a display name derived from its sessions' digests, and MUST fall back to the bundle key when no suggestion is available.
- **FR-003**: Owners MUST be able to rename a bundle at any time; an owner-set name MUST NOT be overwritten by later automatic suggestions.
- **FR-004**: Renames MUST propagate through sync for sources where sync is enabled, like other bundle changes.
- **FR-005**: The system MUST record, for every captured session, the ordered list of distinct git branches it touched, each with first-seen and last-seen times.
- **FR-006**: The single-branch field MUST continue to exist and MUST hold the branch the session is filed under, so consumers unaware of the list keep working.
- **FR-007**: Each session MUST belong to exactly one bundle, chosen as the branch with the most session events, excluding `main` and `master` whenever any other branch is present; ties MUST be broken deterministically by earliest first-seen.
- **FR-008**: Branch recording MUST work for every supported agent session format (Claude Code and Codex).
- **FR-009**: Sessions without branch information MUST be handled exactly as today.
- **FR-010**: Re-capturing the same session MUST update its branch list and bundle assignment without duplicating the session.
- **FR-011**: A bundle's displayed branches MUST be computed from its member sessions' branch lists, so they stay correct after rename, split, merge or session moves; no separate branch list is maintained by the user.
- **FR-012**: Bundle summaries on the CLI, web app and desktop app MUST show: the display name as title, branches as chips beneath, the session count, and the last-activity time.
- **FR-013**: When branch chips exceed the available space, the UI MUST show a "+N more" indicator and allow viewing the full list.
- **FR-014**: Branch names MUST pass through the existing redaction rules before they leave the user's machine, and MUST NOT be sent at all when sync is off for that source.
- **FR-015**: Digests and requests that carry only the single-branch field MUST remain valid and be treated as a one-element branch list; digests with the list MUST remain readable by validators that only know the single field.
- **FR-016**: Existing bundles and sessions MUST be migrated without data loss: existing bundles keep their key and show their current name or the key as fallback; existing sessions get a one-element branch list from their stored branch.
- **FR-017**: Safety-relevant behavior (redaction of branch names, bundle assignment rules) MUST have tests written before implementation, per the project constitution.

### Key Entities

- **Bundle**: A named group of sessions in a project. Has a stable key (usually a branch), a human-readable display name (suggested or owner-set), and an indication of whether the name was set by the owner.
- **Session Branch Record**: One entry in a session's ordered branch list: the branch name (redacted for sync), first-seen time, last-seen time and number of events on it. A session has one or more of these.
- **Session**: A recorded agent working session. Belongs to exactly one bundle; carries the filing branch and its branch records.
- **Bundle Summary**: Derived view of a bundle: display name, set of distinct branches across member sessions, session count, last-activity time.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In a review of 20 sample bundles, an owner can state what each bundle is about from its title and chips alone, without opening it, for at least 90% of them.
- **SC-002**: 100% of sessions that switch branches list every branch they visited, in order; none are reduced to only the final branch.
- **SC-003**: For a corpus of recorded multi-branch sessions, at least 95% are filed under the branch a reviewer judges to be the main one, and 100% are filed identically on re-capture.
- **SC-004**: A bundle's name, branches, session count and last activity are identical across CLI, web and desktop for the same data.
- **SC-005**: Zero raw branch names flagged by the redaction rules appear in synced data in the red-team evaluation suite.
- **SC-006**: 100% of pre-existing digests and bundles remain viewable and syncable after the change, with no manual migration step by the user.
- **SC-007**: Renaming a bundle is reflected on all surfaces within the normal refresh time of each surface, and takes the owner no more than two actions.

## Assumptions

- A bundle continues to correspond to one filing branch key at creation; multi-branch display comes from sessions that visited other branches, merges, or moves.
- Suggested names are produced from existing session digests and are only suggestions; any language model used follows the same local/offline rules as other digest generation.
- The cap on recorded branches per session and the display truncation threshold are fixed reasonable defaults, not user settings, in this version.
- Existing redaction rules cover branch-name-like strings adequately; if gaps are found they are added to the shared rule set rather than special-cased.
- Branch names are case-sensitive, matching git.
- Out of scope: splitting one session into several digests by branch; per-branch sync settings; automatic renaming of git branches.
- Depends on the existing capture pipeline, digest contract, bundle merge/split features and the three presentation surfaces from the MVP spec (`specs/001-pama-mvp`).
