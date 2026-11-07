# App-driven Setup recovery

Managed installations can prepare a preserving update or a repair of their current
version from Storage recovery. Preparation verifies signed metadata and downloads
Setup; it does not execute it. A separate review action starts the verified Setup.
Matching-storage application upgrades continue to use the application updater.
Portable/development builds cannot adopt or replace an installation through this API.

Recovery is limited to the [supported paths](storage-recovery.md#supported-recovery-paths).
Publisher authentication does not establish installation ownership or migration
admission. Setup and the existing native engine recheck those conditions.

## Release contract

`release.json` and `release.sig.json` retain their v1 contract. After the final Setup
binary is built (and Authenticode-signed, when applicable), generate `setup.json`
and `setup.sig.json` using `scripts/update/sign-setup.mjs`. Its arguments are the
Setup file, application manifest, application signature, protected release-key
location, approved public-key location and an existing new output directory.
Private key material is never included in release output.

The descriptor binds the product version, exact application manifest digest,
official Setup URL, size and SHA-256. Its Ed25519 signature uses the separate
`HoneyBee Setup descriptor signature v1` context and the same publisher key as the
application release. This avoids a circular hash: Setup embeds the application
manifest, while the descriptor is signed after Setup is frozen.

Starting with beta.40, distribution preparation requires `setupDescriptorPath` and
`setupSignaturePath`. Distribution review authenticates them again, and publication
and public-download verification include both assets and their checksums. Existing
releases are not rewritten to retrofit this contract.

## Execution and interruption

The renderer submits only a fixed action and opaque job ID over IPC v2. Main chooses
all paths, commands, keys and URLs. Downloaded jobs remain under
`update/setup-recovery`; incomplete downloads and failures retain their evidence.
They cannot become executable merely because a file exists.

A version-scoped worker is included in the signed application inventory, outside
ASAR. It survives Desktop shutdown and reauthenticates the source, plan and Setup.
A Windows helper holds a read lease denying executable writes and deletion from
hash verification through Setup exit. Separate recovery and execution locks prevent
overlapping coordinators and Setup processes. The original root launcher and
recovery runtime are not replaced by this flow.

Setup runs interactively at the original installation root. `/REPAIR` is used only
for the matching product/storage version; `/INSTALLSERVICE` enters the existing
admitted service-transition path. Windows approval prompts still require the user.
An interrupted operation resumes its recorded job; uncertain results are not
silently converted into success or discarded before another attempt.

Success requires installation-scoped Doctor checks and observed target renderer
readiness. Exit code zero alone is insufficient. A rollback/cancellation label must
come from transaction evidence bound to the source pointer and target manifest.
Project-specific problems do not make an otherwise healthy installation fail Repair.

This protocol requires packaged Windows qualification for each release. Source
tests and mocked downloads do not establish that UAC, native replacement, Setup
relaunch or Workspace preservation worked on that release's binaries.

## Progress and local diagnostics

Desktop's additive IPC v2 operation view exposes the stage, elapsed time, last real
progress record and next user action. Existing v1 update actions stay compatible.
Downloads show received bytes; installation and service work do not show estimated
percentages. A long pause prompts inspection of Setup and Windows approval windows
without claiming that a security prompt was detected. Cancellation is available
only during preparation or before execution; it never terminates service migration.

Setup streams bounded human-readable stages into its own window, so progress remains
visible while Desktop is closed. The [NSIS ExecToLog interface](https://nsis.sourceforge.io/NsExec_plug-in)
captures command output without a separate console window. Completed Setup closes
automatically; errors keep their recovery guidance visible.

**Save diagnostics** writes a user-selected local JSON file. The explicit allowlist
contains product/storage versions, installation type, known check results, operation
states and known error codes. It excludes diagnostic messages, paths, account names,
project names, terminal contents and credentials. Nothing is uploaded automatically.
An unknown preservation result remains unknown even when installation health passes.
