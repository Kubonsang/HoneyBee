# Changelog

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
