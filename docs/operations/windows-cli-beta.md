# HoneyBee Windows CLI Beta

HoneyBee 0.1.0 Beta 2 is an unsigned Windows 11 x64 evaluation build. It requires Node.js 24 or
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
    & ".\dist\honeybee-workspace-storage-host.exe" install --workspace-root $StorageRoot --user-sid $UserSid --component-version "0.0.0+e69fb8a0c55c.hb5"

The storage mount root is machine-global and is separate from the Git Workspace root passed to
project init. Do not point either root inside the source Git repository.

If doctor reports that an existing HoneyBee receipt has the same machine identity but an older
component version, repeat the command with --replace. Never use --replace to take over an unrelated
service or a receipt belonging to another user/root.

Run doctor again from a normal, non-elevated PowerShell. Do not proceed while it reports a blocking
failure.

## 3. Register and prepare a project

The source must be a Git repository containing Assets, Packages, and ProjectSettings. Open it in
Unity once to create Library, close every Unity Editor using it, and ensure Library is ignored by
Git.

    .\honeybee.cmd project init "D:\Repos\MyGame" --workspace-root "D:\HoneyBee\MyGame"
    .\honeybee.cmd cache prepare

Cache prepare always builds a new immutable parent from the current source Library. Existing
Workspaces keep their recorded parent and are not switched. An old parent remains protected while
retained children use it, then becomes eligible for the storage component's TTL/capacity cleanup.
There is no separate cache refresh command.

## 4. Work and remove

    .\honeybee.cmd workspace create combat --branch agent/combat
    Set-Location (.\honeybee.cmd workspace path combat)

Run Unity, an IDE, or an AI CLI yourself and commit authored changes normally.

    .\honeybee.cmd workspace status combat
    .\honeybee.cmd workspace remove combat

Remove refuses tracked and untracked changes, never deletes the branch, and is safe to retry after
an interrupted response. A different-target Library junction or ordinary directory is never
replaced or deleted.

## Known reboot limitation

Automatic repair after reboot is not released. Remove all Beta Workspaces before a planned reboot
and do not depend on reboot recovery. HoneyBee does not contain an unsafe stale-mount workaround.
