# HoneyBee Windows Desktop Beta

HoneyBee Desktop 0.1.0 Beta 4 is a Workspace Workbench candidate for Windows 11 x64. It uses the
same registry and Workspace Core as the CLI. It does not schedule Agents or perform Git integration
work.

## First start

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

Dirty Workspace removal is disabled. Commit or discard changes first. Removal obtains an exclusive
lock on the exact Library volume before changing the registry, junction, or Git worktree. If an
external tool still holds it, close that tool and retry; HoneyBee does not terminate it. Successful
removal deletes the verified Git worktree and HoneyBee Library storage but always preserves the
branch. `cleanup-pending` removal can be retried with the same action. A different-target Library
junction is never replaced or deleted automatically.

## Reboot recovery

The retained-attach ordering fix and physical Windows reboot gate are complete for Beta 4. After a
reboot, a retained Workspace appears as `repair-required` until the user chooses **Repair**. Do not
open a tool in that Workspace until it returns to `ready`.

Desktop uses the same identity-checked Core repair as the CLI. It does not recreate missing Git
worktrees, modify dirty authored data, replace a different-target junction, or force-delete storage
whose ownership is uncertain.
