# ADR-080: Cold backup preparation

Date: 2026-09-14

Status: Cold-backup transaction ordering, exclusive file-copy primitive and private
maintenance-area factory implemented.
The approved six-workstream plan is not complete. No automatic service migration is enabled.

Ordering update: [ADR-081](ADR-081-reserved-volume-maintenance.md) supersedes the
stop-before-reservation sequence below with protocol 3. Reserve and lock volumes
before service exit; the protocol-2 description below records the earlier decision.

## Transaction ordering

The approved implementation plan chooses offline backup, not copying mounted VHDX
files. This supersedes ADR-079's assumption that a coherent backup precedes service
stop. Stopping the service is distinct from replacing its binary/config/receipt.

New migration identities use schema 2. The loader refuses schema-1 journals rather
than interpreting old BackingUp/Stopped records with new recovery semantics.

```text
Prepared → Stopping → Stopped → Quiescing → Quiesced
  → BackingUp → BackupVerified → Replacing → Replaced
  → Validating → ReadyForAppCommit → Committed
```

Before replacement, an interruption or failed backup takes Resuming → Resumed:
restore original mounts/service and validate the original source, without reading
or applying an incomplete backup. After replacement intent, recovery still requires
a verified backup and takes RollingBack → RolledBack. Both resume and restore must
be idempotent. Unknown application selection and lost ownership block both paths.
The mandatory QuiesceDisks and ResumeSource adapters remain unbound; stop alone
does not prove volume quiescence.

Terminal recovery also checks the application selection: Committed requires the
target, while Resumed/RolledBack/Failed require the source. Unknown or contradictory
selection fails before health checks or further journal writes. Service health
alone cannot establish application/service compatibility.

## File-copy primitive

`captureColdFiles` accepts a bounded explicit recovery-file inventory and sustained
quiescence callback. It holds Windows exclusive read handles on every source file
and non-delete-sharing directory handles from the volume root down. Busy files,
reparse points, hard-linked sources, invalid/aliased entry names, destination overlap
and an existing destination are refused.

Before creating output, it checks logical file bytes plus 64 MiB of free-space
headroom. Copying streams bytes rather than loading VHDX files into memory; output
files are exclusively created, synced and read back for SHA-256 verification. Loss
of quiescence or write failure preserves partial output without a completed manifest.
A successful manifest pins the copied file names, sizes and hashes.

This is a file-copy primitive, not a coherent service backup adapter. It does not
enumerate the store, prove disk detachment, capture SCM/ACL/mount topology, create a
protected ProgramData maintenance root, or restore files. The eventual privileged
caller must establish those invariants and supply a protected destination. No CLI
entry exposes this function and it does not issue a recoveryReady assertion.

The dependency provides attachment/flush functions, but its public removal APIs are
not a general non-destructive maintenance interface. They must not be substituted
for safe disk quiescence merely because their names contain detach/removal.

## Protected maintenance area

`openMaintenanceArea` resolves ProgramData through the Windows known-folder API,
requires elevation and an existing service store, and opens the fixed maintenance
directory relative to held directory handles. It uses an exclusive operation-lock
handle. Child names cannot escape that directory; reparse points and hard-linked
lock files are refused. Existing objects with unsuitable permissions are refused,
not silently repaired.

The explicit protected DACL grants full access only to SYSTEM and Administrators;
the owner must also be one of those principals. Permissions are inspected through
the opened handle. This factory is not exposed through a CLI and has not been run
against the installed service. Its tests validate descriptor admission and path
refusal; actual elevated creation remains part of the final integrated qualification.

This does not yet make generic backup/journal output privileged recovery authority.
Their integration must create every descendant with protected ownership, bind the
actual admitted service identity, and retain exclusion for the operation's lifetime.

## Validation and next dependencies

Tests cover the changed cold ordering, every pre-replacement resume boundary,
quiescence failure before capture, incomplete backup refusal, schema-1 refusal,
exclusive file-copy hashes, busy sources, unsafe paths and retained partial output.
These use temporary ordinary files and fake service adapters, never a live VHDX.
Windows directory locking was sandbox-denied; equivalent isolated tests passed
outside the sandbox. No installed service or project was changed.
The complete storage-host root test suite passed outside the sandbox after these
changes; `go vet .` passed. No new acceptance gate or manual VM run was introduced.

Remaining approved work, in order:

1. Integrate protected maintenance ownership, complete store and mount inventory,
   non-forced disk quiescence/resume, and coherent backup verification/restoration.
2. Signed privileged SCM replacement and reboot recovery adapters.
3. Combined app/service activation and safe recovery on Desktop startup failure.
4. Shared installation Repair and registered-project ZIP adoption.
5. Final signed Setup/release assembly and local WinGet manifest validation.
6. One final integrated bundle under the existing 16-gate acceptance contract.

Keep all previously accepted qualification evidence. Do not introduce a manual VM
bundle for this internal change or present this file-copy test as gate 06/07/09 completion.
