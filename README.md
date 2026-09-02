# HoneyBee 0.7

HoneyBee is a Windows Unity Workspace provider. It creates independent Git worktrees and gives each
one a differencing-VHDX-backed Unity `Library`.

```text
shared Git repository
├─ source worktree
├─ Workspace combat  ── branch agent/combat  ── Library junction ── child VHDX
└─ Workspace ui      ── branch agent/ui      ── Library junction ── child VHDX
```

`Assets`, `Packages`, `ProjectSettings`, every other authored file, Git metadata, commits, and
uncommitted changes remain in ordinary Git worktrees. HoneyBee storage owns only `Library`.

HoneyBee does not schedule or supervise agents, define Run/DAG workflows, verify or publish patches,
approve work, merge, rebase, push, or create pull requests. After creating a Workspace, enter its
directory and run any tool yourself.

```powershell
honeybee workspace create combat --branch agent/combat
cd <workspace-path>
codex
```

## Status

The workspace-only product boundary and breaking cleanup are implemented in this tree. Automatic
repair after reboot is still a release blocker in the pinned `unity-workspace-storage` component:
retained attach rejects the stale mount path before its native identity-checked stale-mount cleanup
can run. Do not describe the complete reboot lifecycle as released until the upstream fix is pinned
and the real Windows reboot gate in [ADR-031](docs/decisions/ADR-031-git-worktree-library-only-cow.md)
passes.

## CLI

```text
honeybee project init <unity-project> --workspace-root <path>
honeybee project list

honeybee cache prepare [--project <id>]
honeybee cache status [--project <id>]

honeybee workspace create <name> --branch <new-branch> [--base <ref>] [--project <id>]
honeybee workspace attach <name> --branch <existing-branch> [--project <id>]
honeybee workspace list [--project <id>]
honeybee workspace status <name-or-id> [--project <id>]
honeybee workspace repair <name-or-id> [--project <id>]
honeybee workspace remove <name-or-id> [--project <id>]
```

`project init` finds `unity-workspace-storage.exe` beside the CLI, in the prepared Desktop tools,
or on `PATH`. `HONEYBEE_WORKSPACE_STORAGE` or `--storage-command` may supply an explicit absolute
path. Run `cache prepare` only after Unity has produced a source `Library` and Unity is closed.
`Library` must be ignored by Git.

Add `--json` to every project, cache, or Workspace command for machine-readable output. CLI response
envelopes use `schemaVersion: 1`; status DTOs deliberately omit storage executable paths, lease IDs,
and broker internals. Errors are JSON on stderr with `schemaVersion`, `ok: false`, `code`, and
`message`.

`workspace launch` and tool configuration no longer exist. `workspace remove` refuses a dirty Git
worktree, removes only a verified `Library` junction and the worktree, and preserves the branch.
Interrupted removals remain `cleanup-pending` and can be retried.

## Desktop Workspace Workbench

Desktop is a small view over the same Workspace Core. It contains:

- registered projects and their cache state;
- Workspaces, branch/HEAD state, and changed files;
- a bounded Git diff viewer;
- an interactive PowerShell terminal rooted in the selected Workspace;
- create/attach, repair, and safe remove actions.

It has no Agent Manager, Run/DAG, approval, verified-patch, publish, or merge surface. The sandboxed
renderer receives only strict versioned DTOs through the preload bridge; filesystem, Git, storage,
and PTY authority stay in the main process.

## Safety and persistence

- The registry is stored atomically as `workspace-registry-v2.json` under
  `%LOCALAPPDATA%\HoneyBee\workspace-core` by default.
- Registry mutation uses a cross-process lock bound to PID plus process-creation identity.
- Compatible Library-only v1 records are read and migrated on the first v2 write. The v1 file is
  not overwritten, providing a rollback reference.
- Full-project CoW records are rejected. Full-project CoW is not restored as a compatibility mode.
- Source branches are never deleted by Workspace cleanup.
- Missing or ordinary `Library` directories are never recursively treated as HoneyBee storage.

See [the v0.7 migration note](docs/migrations/v0.7-workspace-only.md) for breaking changes and
rollback guidance.

## Development

Requirements are Windows 11, Node.js 24, pnpm 11.18 through Corepack, Go 1.22+, Git, and the Windows
VHDX/storage prerequisites of the pinned storage component.

```powershell
corepack pnpm install --frozen-lockfile
corepack pnpm verify
```

Useful narrower commands:

```powershell
corepack pnpm build
corepack pnpm typecheck
corepack pnpm test:run
corepack pnpm --filter honeybee-desktop smoke
```

Desktop packaging first builds the pinned storage client and HoneyBee storage host:

```powershell
corepack pnpm --filter honeybee-desktop package:win
```

## Decisions and evidence

[ADR-031](docs/decisions/ADR-031-git-worktree-library-only-cow.md) defines the storage layout and
[ADR-032](docs/decisions/ADR-032-workspace-only-product-boundary.md) defines the product boundary.
The [decision index](docs/decisions/README.md) distinguishes active decisions from retained
historical control-plane decisions. Existing benchmark and validation evidence remains preserved
under `docs/benchmarks` and `docs/validation`; it is evidence, not a supported product surface.
