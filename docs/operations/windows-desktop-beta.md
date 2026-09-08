# HoneyBee Windows Desktop Beta

HoneyBee Desktop 0.1.0 Beta 8 is a Workspace Workbench prerelease for Windows 11 x64. It uses the
same registry and Workspace Core as the CLI. It does not schedule Agents or perform Git integration
work.

## First start

Extract the complete archive and keep its `resources` directory beside the executable. The archive
includes `STORAGE-SETUP.md` for the qualified hb9-to-hb10 service upgrade. It requires
storage version `0.0.0+c238f283ded2.hb10`; extracting the ZIP does not update that service.
Fresh installation and older migrations are not qualified by this release. For Desktop, use
`resources\win32-x64\honeybee-workspace-storage-host.exe` in place of the CLI guide's
`dist\honeybee-workspace-storage-host.exe`; the service/root/user and upgrade requirements are the
same. Diagnostics and ordinary Workspace use run without elevation.

If a project is already registered, Desktop opens the most recently used project. Otherwise choose:

- **Unity Hub projects** to discover `%APPDATA%\UnityHub\projects-v1.json` or browse to a Unity
  project manually.
- **Import Git URL** to clone one HTTPS or SSH remote into a new destination. Embedded credentials
  and existing destinations are rejected. HoneyBee uses the system Git credential flow and leaves
  partial output in place if clone fails.

Project setup checks the Unity layout, Git repository, source `Library`, Git ignore rule, packaged
storage tools, Windows service, and install receipt. Choose a Workspace root outside the repository.
HoneyBee then runs project registration and cache preparation sequentially. It never edits
`.gitignore` or installs/repairs the service automatically.

If the source `Library` is missing, use **Open in Unity**. Desktop reads
`ProjectSettings\ProjectVersion.txt` and opens the exact installed Unity Hub editor. Close Unity
before checking again or preparing the cache.

## Workspace Workbench

The left pane lists Workspace name, branch, lifecycle state, and changed-file count. The detail pane
shows Git state, HEAD, Library connection, path, changed files, bounded diff, and a user-operated
PowerShell terminal. Create supports a new branch with an optional base or attachment of an existing
branch.

Quick actions open CMD, PowerShell (PowerShell 7 preferred), VS Code, or the exact Unity editor in the
selected ready Workspace. These are detached user tools: HoneyBee does not watch, restart, verify, or
interpret them.

The diff viewer keeps the changed-file list beside a unified preview of changes relative to HEAD,
including staged and unstaged edits. It includes bounded previews of untracked text, file search,
line numbers and per-file scroll restoration. Large diffs are explicitly truncated
at 1 MiB. Setup shows bilingual corrective guidance, with the original diagnostic and remediation
available under diagnostic details; use **Check again** after completing the indicated action.

Dirty Workspace removal is disabled. Commit or discard changes first. Removal obtains an exclusive
lock on the exact Library volume before changing the registry, junction, or Git worktree. If an
external tool still holds it, close that tool and retry; HoneyBee does not terminate it. Successful
removal deletes the verified Git worktree and HoneyBee Library storage but always preserves the
branch. `cleanup-pending` removal can be retried with the same action. A different-target Library
junction is never replaced or deleted automatically.

## Reboot recovery

Beta 8 uses 1 MiB blocks for new child VHDX. Existing 2 MiB parents are reused and
existing children keep their geometry. The Storage view measures Workspace usage
on request, distinguishes shared parents from per-Workspace files and shows
unknown/partial results explicitly. The change does not automatically shrink
existing children or install the separate optional TestPlay shared-cache feature.

The retained-attach ordering fix and physical Windows reboot gate are complete for Beta 4. After a
reboot, a retained Workspace appears as `repair-required` until the user chooses **Repair**. Do not
open a tool in that Workspace until it returns to `ready`.

Desktop uses the same identity-checked Core repair as the CLI. It does not recreate missing Git
worktrees, modify dirty authored data, replace a different-target junction, or force-delete storage
whose ownership is uncertain.
