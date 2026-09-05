# HoneyBee Windows Unity Workspaces

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

The published prerelease is [Beta 4](https://github.com/Kubonsang/HoneyBee/releases/tag/v0.1.0-beta.4),
released on 2026-09-04. This working tree prepares `0.1.0-beta.5` with quality fixes; its locally assembled
archives are not the published Beta 4 assets. The
[quality follow-up checklist](docs/validation/beta4-release-readiness.md) tracks candidate
verification separately from earlier physical-reboot evidence.
The candidate pins `unity-workspace-storage` revision `68e05e0`, which lets retained attach reach
the native identity-checked stale-mount cleanup and adds an exclusive Library-volume removal
handshake. It also refuses to publish a cache that leaves no capacity for its first child.
The physical Windows reboot gate in
[ADR-031](docs/decisions/ADR-031-git-worktree-library-only-cow.md) passed on this candidate. Reboot
recovery is explicit: wait for `workspace status` to report `repair-required`, run
`workspace repair`, and do not open the Workspace until it reports `ready` again.

The GitHub prerelease provides unsigned Windows x64 Desktop and CLI archives plus SHA-256 checksums.
The CLI archive requires Node.js 24 and a one-time elevated storage service setup; extract it and
follow the [Windows CLI Beta guide](docs/operations/windows-cli-beta.md). Windows may warn before
opening the unsigned Desktop executable.

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
honeybee workspace path <name-or-id> [--project <id>]
honeybee workspace repair <name-or-id> [--project <id>]
honeybee workspace remove <name-or-id> [--project <id>]

honeybee doctor
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
worktree and first reserves and exclusively locks the exact Library volume. If Unity, an IDE, an AI
CLI, or another process still holds it, removal fails with `workspace.in-use` before the registry,
junction, worktree, or branch changes. Successful removal deletes only a verified `Library`
junction and worktree and preserves the branch. Interrupted removals remain `cleanup-pending` and
can be retried.

`doctor` is a read-only Windows readiness report. It checks the runtime, Git, packaged storage
tools, service and receipt identity, registered projects, cache prerequisites, registry, and
Workspace repair/cleanup state. Warnings do not fail the command; blocking checks return exit code
`1`. It never installs, starts, repairs, or removes anything.

`cache prepare` is also the refresh operation: it publishes a new parent for future Workspaces.
Existing Workspaces remain attached to their original parent. A different-target Library junction
is never replaced by repair or remove.

## Desktop Workspace Workbench

Desktop is a small view over the same Workspace Core. It contains:

- Unity Hub discovery, manual project selection, and one-time Git clone onboarding;
- project preflight, registration, cache preparation, and cache state;
- Workspaces, branch/HEAD state, and changed files;
- a bounded Git diff viewer;
- an interactive PowerShell terminal rooted in the selected Workspace;
- create/attach, repair, and safe remove actions;
- explicit one-click CMD, PowerShell, VS Code, and exact-version Unity launches.

It has no Agent Manager, Run/DAG, approval, verified-patch, publish, or merge surface. The sandboxed
renderer receives only strict versioned DTOs through the preload bridge; filesystem, Git, storage,
process launch, and PTY authority stay in the main process. Git clone is onboarding only: HoneyBee
uses the system Git credential flow, does not store credentials, and preserves partial output on
failure. External tools are launched only when the user clicks an action; HoneyBee does not monitor,
restart, or orchestrate them. See the [Desktop Beta guide](docs/operations/windows-desktop-beta.md).

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
[ADR-032](docs/decisions/ADR-032-workspace-only-product-boundary.md) defines the product boundary,
and [ADR-033](docs/decisions/ADR-033-desktop-onboarding-and-tool-launch.md) constrains Desktop
onboarding and user-triggered tool launch. [ADR-034](docs/decisions/ADR-034-exclusive-library-removal.md)
defines fail-closed removal while an external process owns the Library volume.
The [decision index](docs/decisions/README.md) distinguishes active decisions from retained
historical control-plane decisions. Existing benchmark and validation evidence remains preserved
under `docs/benchmarks` and `docs/validation`; it is evidence, not a supported product surface.
