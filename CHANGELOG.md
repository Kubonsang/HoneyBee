# Changelog

## 0.1.0-beta.10 - 2026-09-09

- Compress newly seeded private Bee data with native NTFS compression in hb12.
  New files inherit compression; existing caches retain their state on attachment.
- Reuse external-Bee parent seeds without rewriting parents or VHDX containers.
- Measure 483.80 to 392.31 MB combined cache (18.91% reduction) in the paired GNF
  study, with timing regressions within 10%. The original 20% gate remains missed.
- Validate 572 GNF Unity tests, native compressed/uncompressed cache lifecycle,
  installed hb11-to-hb12 upgrade, service restart and physical Windows reboot.
- Record interrupted installer reconciliation and the limited preservation scope;
  remove all disposable installed child Workspaces after reboot validation.
- Add reproducible footprint, allocation and write-correlation experiments, with
  verified archival and scoped cleanup of generated experiment data.

## 0.1.0-beta.9 - 2026-09-09

- Prepare new Library parents with an immutable Bee seed and give each Workspace
  an independent external Bee cache, managed by the hb11 storage broker.
- Retain compiled Bee artifacts and Tundra state while regenerating allowlisted
  DAG/input files; reattachment preserves each Workspace's modified cache.
- Include private Bee and shared seed allocation in usage, quota and lifecycle
  cleanup. Existing parents and Workspaces keep their current layout.
- Measure 357.56 MB median child and 510.98 MB combined cache in the GNF startup
  campaign: 55.83% and 36.88% lower respectively. This does not meet the historical
  350 MB child median gate or guarantee a 300 MB total Workspace.
- Validate actual GNF broker integration with 364 passing tests, plus an installed
  hb10-to-hb11 upgrade, SCM restart and physical reboot. Repair two dirty user
  Workspaces while preserving all 21 changed files and Git HEAD/index contents.
- Reject stale storage compatibility metadata in Desktop bundles before packaging.
  Record the exact storage base revision and overlay SHA-256 in built tools.
- Update development/test dependencies to Vitest 4.1.11, addressing
  GHSA-82fw-gwwq-j7x9 reported by the release dependency audit.

## 0.1.0-beta.8 - 2026-09-08

- Create new Windows child VHDX with 1 MiB payload blocks, reusing existing
  2 MiB parents and preserving retained children at their original geometry.
- Measure 18.84% lower median persisted child allocation in the GNF Unity
  benchmark, with no qualifying first-open or reopen timing regression.
- Show measured logical/allocated Workspace storage and shared-parent usage,
  keeping unknown or partial measurements explicit.
- Include optional TestPlay shared-cache integration guidance; TestPlay's
  separate implementation is not installed or enabled by HoneyBee.
- Pin hb10 storage and verify old/new retained children across three reattach
  cycles and one physical reboot. Preserve all four original user child hashes
  and remove both disposable validation children.
- Update the bundled hb9-to-hb10 service-upgrade instructions. Existing child
  files do not shrink automatically; fresh install and older migrations remain
  outside this release's native qualification.

## 0.1.0-beta.7 - 2026-09-07

- Keep the changed-file list beside the unified diff, with file-type groups, search,
  line numbers, colors, new-file previews and per-file scroll restoration.
- Show dirty but available Workspaces as ready; preserve Unity settings and metadata
  changes and retain the existing removal protection.
- Explain retained mount identity failures separately from Git changes.
- Require a live broker lease before treating a readable Library mount as available,
  and reattach inactive children during Repair even when the stale path opens.
- Pin hb9 storage, which persists resolved volume identity before mounting and on
  successful reattachment. Legacy identity mismatches remain blocked without proof.
- Verified preserved fallback recovery and one physical reboot across three Workspaces.
  Unproven legacy mounts remain preserved; repeated reboot cycles are still unverified.

## 0.1.0-beta.6 - 2026-09-06

- Preserve built-in PowerShell sessions, input, and scroll position across tabs, Workspaces, and projects.
- Confirm terminal/app closure and require built-in terminals to close before Workspace removal.
- Distinguish unknown Git and stale refresh results; offer the correct repair or removal-retry action.
- Keep errors with their original task target, preserve diagnostic codes across Electron IPC, and separate diff loading from mutations.
- Limit evaluation to existing matching hb8 installations; fresh install and Beta 3 upgrade remain unverified.

## 0.1.0-beta.5 - 2026-09-05

- Preserve Git status columns and decode quoted paths for accurate file selection, including
  Unicode, spaces, and renames. Diff requests use literal paths and bound streamed output to 1 MiB.
- Discard superseded Workspace-list and diff responses after navigation.
- Show actionable bilingual setup diagnostics and validate the packaged storage version and hashes.
- Verify Desktop packaging, renderer interactions, and packaged PTY in Windows CI alongside the CLI.
- Include Desktop installation and storage setup documentation in the archive.

## 0.1.0-beta.4 - 2026-09-04

Windows Workspace lifecycle hardening for externally launched tools and reboot repair.

### Added

- Transactional retained removal with prepare, commit, abort, expiry, and durable retry receipts.
- Exclusive Library-volume locking before registry, junction, or Git worktree mutation.
- `workspace.in-use` guidance when Unity or another external process holds the Library volume.
- Linked-worktree, Codex, Claude Code, Unity batchmode, context-isolation, and active-handle dogfood
  gates.

### Fixed

- Retained attach now reaches identity-checked native stale-mount preparation after reboot.
- A lost remove response or failed reservation abort remains retryable with the same Workspace
  removal transaction.
- Storage cleanup no longer recursively removes a Workspace shell containing entries it does not
  own.
- Failed acquire removes only the empty pre-broker Workspace shell instead of leaving it behind.
- Cache preparation refuses to publish a parent unless capacity remains for its first child.

### Validation

- A real Unity project sustained four concurrent linked worktrees, distinct Library volumes,
  Codex and Claude Code commits, two concurrent Unity Editors, dirty and active-handle removal
  refusal, clean removal, retry, and branch preservation.
- The elevated create → work → shutdown/reboot → repair → Unity → remove gate passed on Windows 11
  with the retained child identity, authored Git data, and branch preserved and no disposable
  storage residuals after removal.

## 0.1.0-beta.3 - 2026-09-04

Desktop Workspace Workbench release (tag `v0.1.0-beta.3`, commit `9ec2444`).

- Unity Hub discovery, manual selection, Git clone onboarding, and project setup.
- Workspace list, changed files, bounded Git diff, and interactive PowerShell terminal.
- User-triggered CMD, PowerShell, VS Code, and exact-version Unity launch.
- Korean/English interface and compact Desktop layout.

## 0.1.0-beta.2 - Development milestone (included in Beta 3)

Windows CLI lifecycle hardening before real-project dogfood.

### Added

- Read-only honeybee doctor readiness diagnostics and stable human-readable output.
- workspace path for PowerShell directory navigation.
- Atomic bounded removal receipts for retrying a remove after its success response is lost.
- Packaged tool manifest, Node.js bootstrap check, installation guide, and stronger CLI smoke.
- A guarded four-Workspace Windows dogfood harness and evidence schema.

### Fixed

- Repair no longer replaces a Library junction that points to an unexpected target.
- Cleanup states are not hidden by derived repair state.
- Cache preparation rejects an active Unity lock and incomplete storage responses.
- Storage and filesystem failures use stable product error codes with next-action guidance.
- Clean Core/CLI builds prevent removed orchestration modules from leaking into the archive.

### Known beta limitation

Automatic repair after reboot remains blocked by the pinned upstream retained-attach ordering
defect. Remove Workspaces before a planned reboot.

## 0.1.0-beta.1 - 2026-09-03

First public beta of HoneyBee as a Windows Unity parallel Workspace provider.

### Included

- Git linked-worktree creation and attachment with one branch per Workspace.
- Library-only differencing VHDX cache and Workspace lifecycle.
- Stable JSON output for project, cache, and Workspace commands.
- Workspace Workbench with project and Workspace lists, Git status/diff, and terminal access.
- Atomic registry migration, dirty-worktree removal protection, resumable cleanup, and branch
  preservation.

### Known beta limitation

Automatic repair after reboot is not released. The pinned storage component validates a retained
mount path before its identity-aware stale-mount cleanup can run. Remove beta Workspaces before a
planned reboot and do not rely on this build for reboot recovery. See ADR-031 for the required
upstream fix and Windows release gate.
