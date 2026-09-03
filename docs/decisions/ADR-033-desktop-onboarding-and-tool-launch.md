# ADR-033: Desktop onboarding and user-triggered tool launch

## Status

Accepted for HoneyBee 0.1.0 Beta 3.

## Context

ADR-032 removed the Agent control plane and provider-specific launch configuration. A practical
Workspace Workbench still needs a safe way to find a Unity project, prepare it, and let the user open
ordinary tools in a ready Workspace. Those conveniences must not make HoneyBee a Git client or
process orchestrator again.

## Decision

Desktop may discover Unity Hub projects, accept a manually selected Unity project, and clone one Git
repository as a one-time onboarding step. Clone accepts HTTPS or SSH remotes without embedded
credentials, invokes `git.exe` without a shell, uses the system credential flow, refuses an existing
destination, and never deletes partial output after failure. Desktop does not expose pull, push,
merge, rebase, commit, or pull-request operations.

Desktop may launch CMD, PowerShell, VS Code, or the exact Unity Hub editor recorded in
`ProjectSettings/ProjectVersion.txt`. Launch is an explicit user action for a ready Workspace (or the
source project during setup). HoneyBee does not persist process identity, monitor output, restart a
tool, infer completion, or turn the process into an Agent session. The CLI does not regain
`workspace launch`.

The Electron main process owns Unity Hub file access, folder dialogs, Git execution, Core calls, and
process creation. The sandboxed renderer receives strict versioned DTOs and normalized errors only.
Project setup remains fail-closed: HoneyBee does not install or repair the storage service and does
not edit `.gitignore` automatically.

## Consequences

- Desktop shortens first-use setup without expanding the Workspace-only product boundary.
- Authentication remains with Git Credential Manager or SSH; HoneyBee stores no credentials.
- Clone failures and setup blockers require an explicit user decision instead of automatic cleanup.
- Tool availability and exact Unity version failures are actionable UI errors, not supervised jobs.
- ADR-031 storage safety, repair limits, branch preservation, and reboot blocker remain unchanged.
