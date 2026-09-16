# ADR-079: Service migration transaction coordinator

Date: 2026-09-14

Status: Internal native coordinator implemented and tested with adapters. Not exposed
through CLI, elevation or Desktop; automatic service migration remains blocked.

## Why a separate transaction

Existing `service-evidence` captures executable/config/receipt bytes and SCM evidence
with `recoveryReady: false`. It is not a coherent backup of live store/Workspace data.
Existing `install --replace` replaces the binary and receipt in separate steps and
does not provide the complete service-plus-application recovery transaction. Neither
is treated as an automatic migration implementation by this change.

The new native coordinator binds a source component/evidence hash and target
component/signed-manifest hash to a journal. State records include the identity hash
and previous-record hash. Files are synced before exclusive hard-link publication;
partial aliases are retained. Loading checks sequence and allowed transitions, rejects
changed/discontinuous records, and gives partial files no state authority. This is
not a substitute for the fixed Windows power-interruption qualification.

```text
Prepared → BackingUp → BackupVerified → Stopping → Stopped
  → Replacing → Replaced → Validating → ReadyForAppCommit → Committed

interrupted mutation → RollingBack → RolledBack
incomplete backup + healthy unchanged source → Failed
```

Intent is recorded before stop, replacement and restoration. Backup capture and
verification must finish before stopping the source. A target service that passes
validation stops at ReadyForAppCommit; only confirmed target application selection
and target health can finish Committed. Unknown application selection refuses
rollback and commit. Recovery with the source still selected restores and validates
the source, including after a partially completed restore. A failed restore retains
RollingBack for explicit subsequent recovery; it never writes RolledBack early.

## Adapter requirements before production exposure

All callbacks are mandatory; none defaults to success. The caller must establish and
retain machine-wide transaction ownership, application exclusion, privileged protected
journal paths and independent release/source authorization. The journal hash chain
alone is not authority against an actor who can rewrite that protected directory.

CaptureBackup must quiesce every relevant writer and capture a coherent restorable
store/Workspace snapshot together with binary, receipt, config and SCM state.
VerifyBackup must validate that recovery unit. Replacing must use the approved
binary/config/receipt as a single recoverable unit. Target validation includes a
controlled start where necessary and actual health checks. RestoreSource must be
idempotent over every partially completed replacement/restoration state.

The source/target application selection callback must consult durable coordinated
application state, not infer success from a running service. An adapter must not
report target selection before the service reached ReadyForAppCommit. Existing
component-evidence backup explicitly does not satisfy these requirements.

No callbacks for real SCM mutation or coherent data backup are installed yet. No
ProgramData migration directory, scheduled recovery task or UAC request was created.
The existing app-only updater and `recoverable-service-migrator-not-implemented`
admission refusal remain unchanged. Next work is the protected backup and real
SCM adapter, followed by coordination with application activation.

## Validation

New tests cover backup capture/verification failures before stop, failures in stop/
replace/target validation, recovery at each mutation boundary, delayed application
commit, unknown application selection, lost ownership, changed backup, interrupted
restoration and journal tampering/partial preservation. They use injected adapters
and temporary files, not a real service migration or populated Workspace snapshot.

The Storage Host package tests passed. The existing protected-directory test was
sandbox-denied; the same package suite passed outside the sandbox. `go vet` passed.
No installed Windows service, project or Workspace was changed. Fixed acceptance
items 06/09 remain partial; no new manual VM gate was introduced.
