# HoneyBee Windows CLI Beta

HoneyBee 0.1.0 Beta 8 is an unsigned Windows 11 x64 prerelease. It requires Node.js 24 or
newer, Git for Windows, and storage component `0.0.0+c238f283ded2.hb10`.
HoneyBee does not install or upgrade the Windows service automatically. This
release qualifies an existing hb9-to-hb10 upgrade; fresh installation and older
service/protocol migrations remain unqualified.

## 1. Extract and verify

Extract the complete CLI ZIP. Keep honeybee.cmd, dist, this README, and the license together.
Verify the ZIP against the published SHA256SUMS.txt, then run:

    .\honeybee.cmd --version
    .\honeybee.cmd doctor --json

Doctor is read-only. A missing service or receipt is expected before the one-time setup below.

## 2. Upgrade an existing hb9 storage service

Extracting this ZIP does not upgrade the service. Close Unity, HoneyBee and tools
using its Workspaces. Back up the existing install receipt, broker executable,
broker config and Workspace registry before replacement. Preserve the recorded
storage root and user SID. A same-user hb9 installation can retain its existing
2 MiB children during this upgrade; do not remove authored Workspaces just to
enable the new block size.

From an elevated PowerShell opened as the same installed user, change to the
extracted CLI directory. Inspect the existing receipt and use its identity:

```powershell
$ReceiptPath = Join-Path $env:ProgramData 'UnityWorkspaceStorage\install-receipt.json'
$Receipt = Get-Content -LiteralPath $ReceiptPath -Raw | ConvertFrom-Json
$CurrentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
if ($Receipt.userSid -ne $CurrentSid) { throw 'The installation belongs to another user.' }
if ($Receipt.componentVersion -notin @('0.0.0+796514b475be.hb9', '0.0.0+c238f283ded2.hb10')) {
    throw 'This service version requires a separately validated migration.'
}
& '.\dist\honeybee-workspace-storage-host.exe' install `
    --workspace-root $Receipt.workspaceRoot --user-sid $Receipt.userSid `
    --component-version '0.0.0+c238f283ded2.hb10' --replace
if ($LASTEXITCODE -ne 0) { throw 'Service upgrade failed; inspect the original diagnostic.' }
```

For Desktop, replace `dist\honeybee-workspace-storage-host.exe` with
`resources\win32-x64\honeybee-workspace-storage-host.exe`. Never use `--replace`
to take over an unrelated service or change an existing installation's root/SID.
Keep the complete archive and compare it with the published checksums first.

New children use 1 MiB blocks. Existing children retain their geometry and size;
the upgrade does not compact or rewrite them. One physical reboot with both
geometries passed, including child identity and content preservation.

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
