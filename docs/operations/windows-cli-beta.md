# HoneyBee Windows CLI Beta

HoneyBee 0.1.0 Beta 5 is an unsigned Windows 11 x64 evaluation candidate. It requires Node.js 24 or
newer, Git for Windows, and a one-time elevated installation of the bundled
UnityWorkspaceStorage service. HoneyBee does not install or repair the service automatically.

## 1. Extract and verify

Extract the complete CLI ZIP. Keep honeybee.cmd, dist, this README, and the license together.
Verify the ZIP against the published SHA256SUMS.txt, then run:

    .\honeybee.cmd --version
    .\honeybee.cmd doctor --json

Doctor is read-only. A missing service or receipt is expected before the one-time setup below.

## 2. Install the storage service

Open PowerShell as Administrator, change to the extracted CLI directory, and run:

    $StorageRoot = Join-Path $env:ProgramData "HoneyBeeStorageWorkspaces"
    $UserSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    & ".\dist\honeybee-workspace-storage-host.exe" install --workspace-root $StorageRoot --user-sid $UserSid --component-version "0.0.0+68e05e0bf0e4.hb8"

The storage mount root is machine-global and is separate from the Git Workspace root passed to
project init. Do not point either root inside the source Git repository.

If doctor reports that an existing HoneyBee receipt has the same machine identity but an older
component version, remove every Workspace with the old CLI first, verify that their branches remain,
then repeat the command with --replace. The broker protocol changed in Beta 4, so do not replace a
service that still owns an older retained child. Never use --replace to take over an unrelated
service or a receipt belonging to another user/root.

Run doctor again from a normal, non-elevated PowerShell. Do not proceed while it reports a blocking
failure.

## 3. Register and prepare a project

The source must be a Git repository containing Assets, Packages, and ProjectSettings. Open it in
Unity once to create Library, close every Unity Editor using it, and ensure Library is ignored by
Git.

    .\honeybee.cmd project init "D:\Repos\MyGame" --workspace-root "D:\HoneyBee\MyGame"
    .\honeybee.cmd cache prepare

`cache prepare` is also the refresh operation. Every invocation prepares a new immutable parent;
there is no separate `cache refresh` command. Existing Workspaces remain attached to their original
parents. If the new parent cannot be verified, published, or admitted with capacity for its first
child, HoneyBee aborts the new transaction and leaves the previously registered cache unchanged.
Remove unused Workspaces or free disk space before retrying a capacity failure.

An old parent remains protected while retained children use it, then becomes eligible for the
storage component's TTL/capacity cleanup.

## 4. Work and remove

    .\honeybee.cmd workspace create combat --branch agent/combat
    Set-Location (.\honeybee.cmd workspace path combat)

Run Unity, an IDE, or an AI CLI yourself and commit authored changes normally.

    .\honeybee.cmd workspace status combat
    .\honeybee.cmd workspace remove combat

Remove refuses tracked and untracked changes and never deletes the branch. It also asks the storage
service to lock the exact Library volume before HoneyBee changes the registry, junction, or Git
worktree. `workspace.in-use` means Unity or another process still has an open handle: close tools
rooted in that Workspace and retry the same command. HoneyBee does not kill processes. A lost
response is safe to retry, and a different-target Library junction or ordinary directory is never
replaced or deleted.

## Reboot recovery

The retained-attach ordering defect is fixed in the pinned storage component without a
HoneyBee-side unlink workaround, and the physical Windows reboot gate passed for Beta 4. Recovery
is explicit rather than automatic:

    .\honeybee.cmd workspace status combat
    .\honeybee.cmd workspace repair combat
    .\honeybee.cmd workspace status combat

After a reboot, do not open Unity or another tool in a Workspace while status reports
`repair-required`. Repair reconnects the exact retained Library storage, restores its owned
Library junction, runs `git worktree repair`, and returns the registry state to `ready`.

Repair does not recreate a missing Git worktree, change dirty authored files, replace a junction
that targets something else, or delete a VHDX whose ownership is uncertain. Those cases remain
fail-closed and require investigation.
