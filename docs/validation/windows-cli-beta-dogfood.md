# Windows CLI Beta dogfood gate

This gate must run against a disposable clone of a real, large Unity project. Toy fixtures and
GitHub-hosted package smoke do not satisfy it.

## Preconditions

- Windows 11 x64, Node.js 24, Git for Windows, and the project's real Unity Editor.
- A clean disposable clone with a generated, ignored source Library.
- Dedicated empty Git Workspace and HoneyBee data roots.
- A complete Beta 2 CLI package whose doctor report has no blocking failure.
- No active storage leases at the metrics baseline.

Run the repository harness from a normal PowerShell:

    .\scripts\dogfood\windows-cli-beta.ps1 -HoneyBee <honeybee.cmd> -ProjectPath <project> -WorkspaceRoot <workspaces> -DataRoot <registry> -EvidencePath <result.json>

The harness creates combat, ui, enemy-ai, and level on unique branches. It then pauses. The operator
must open at least two Workspace projects in Unity simultaneously, wait for import/compile, make and
commit isolated changes in all four Workspaces, and confirm that one Workspace's import or Git
changes do not appear in another.

Before the operator phase the harness verifies four distinct Library junction targets and repairs one
deliberately removed owned junction. After confirmation it verifies clean status, dirty-remove
refusal, clean remove, repeated remove, existing-branch attach/remove, branch-head preservation,
final doctor state, timings, and storage allocated-byte deltas. It never deletes branches or
performs forced cleanup after a failure.

## Pass criteria

- project init, cache prepare, create, attach with a preserved existing branch, list, status, repair
  without reboot, and remove pass.
- Four Git worktrees and distinct branches coexist.
- Four Library junctions resolve to distinct retained mounts.
- Two Unity Editors import/compile concurrently without cross-Workspace Library changes.
- Authored Git changes remain isolated.
- Dirty and untracked removal is rejected.
- Clean removal and repeated removal succeed, with branch HEADs unchanged.
- No cleanup-pending, repair-required, active lease, or manual-recovery state remains.
- The evidence records cache time, all create/remove times and medians, ready child allocation
  deltas, post-Unity allocation, and final storage allocation.

Performance values are observations for this Beta, not invented release thresholds. Any timeout,
capacity failure, cross-Workspace mutation, ownership ambiguity, or residual state fails the gate.

Reboot is deliberately excluded. The ADR-031 upstream retained-attach gate remains separate.
