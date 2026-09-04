# Changelog

## 0.1.0-beta.4 - Unreleased

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

## 0.1.0-beta.2 - Unreleased

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
