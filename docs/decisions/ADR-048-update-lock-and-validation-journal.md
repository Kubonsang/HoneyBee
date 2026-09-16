# ADR-048: Installation update lock and recoverable validation journal

## Status

Implemented for the developer update-transaction entry point after ADR-047.
This transaction serializes and journals plan revalidation only. It has no app
publication, service replacement, restore, rollback or activation operation.
Every result retains `activationAllowed: false`.

## Windows ownership

The native update package helper now supports `lock UPDATE_DIRECTORY`. It opens
`installation-update.lock` with Windows sharing disabled and holds the handle
until its stdin closes. It checks the directory and lock handle for redirection.
The file may remain after exit; file existence never means ownership. There are no
PID files, stale-timeout deletion, or process-ID reuse heuristics.

The Node wrapper waits for the helper's LOCKED response before entering the
transaction. It asserts ownership around the work and journal publication, closes
the pipe in finally, and observes helper exit. A second owner fails immediately.
Separate installation roots have independent locks. Startup/shutdown waits are
bounded; no UAC or service privilege is requested.

Windows releases the handle if the helper dies. If the Node owner is killed, its
pipe closes and the helper exits. This was tested with a real parent-process kill.
The lock prevents cooperating transaction processes from running concurrently;
it does not freeze administrators, unrelated processes, service operations, or
project mutations. Existing installer and workspace-operation locks are separate.
Legacy standalone staging/preparation/plan commands remain isolated, non-activating
developer operations. Every future mutating updater must enter this ownership path.

## Journal

Transactions live under `update/transactions/txn-<unique>`:

```text
001-Created.json
002-Validating.json
003-Validated.json
```

Each record binds the exact plan path and caller-retained plan SHA-256 and explicitly
denies activation. Records are first exclusively created under a unique `.partial`
name, file-synced and closed, then renamed to a sequential final name. Partial files
remain as evidence and carry no state authority. Final JSON records must be bounded,
contiguous, schema-valid, plan-consistent and follow the supported transitions.
Malformed final records stop recovery; they are never treated as completed work.
The journal is bounded to 100 records per transaction.

Transitions are:

```text
Created -> Validating -> Validated
Created | Validating | Recovering -> Failed
Validating | Failed | Recovering -> Recovering -> Validating
Created | Validating | Failed | Recovering -> Abandoned
```

An interrupted Created can go directly back to Validating. An orphan attempt with
no published Created record can begin with the caller's supplied plan: no mutating
operation can have occurred in this protocol. These recovery rules must not be
reused unchanged after adding app/service mutation states.

Before starting new work, the owner scans existing transactions. Anything other
than Validated or Abandoned requires explicit recovery first. Recovering an existing
transaction requires the original plan path and pin, then reruns the full live-source
and payload validation. A changed source/plan remains a failure, not a reason to
skip a check. Successful revalidation does not grant permission to perform later
work after the ownership handle has been released.

Because this protocol has no installation mutations, an obsolete failed plan can
be explicitly abandoned under the same lock without querying the service or deleting
any files. Abandonment retains the original plan binding and all evidence and lets
a new plan proceed. It is not rollback. Corrupt final journals cannot be abandoned
through normal replay; they require diagnosis rather than guessed state recovery.

## Commands

Build Core and the update package helper, then use:

```powershell
node scripts/update/transaction.mjs validate ROOT PLAN_PATH PLAN_SHA256
node scripts/update/transaction.mjs recover ROOT PLAN_PATH PLAN_SHA256 TRANSACTION_DIRECTORY
node scripts/update/transaction.mjs abandon ROOT PLAN_PATH PLAN_SHA256 TRANSACTION_DIRECTORY
```

`transaction:update` exposes the CLI. Failures identify the transaction directory
where possible and leave evidence. No command switches `current.json`, executes
target payloads or starts/stops a service. The helper remains developer tooling;
installed Setup/VM packages were not rebuilt or changed.

## Verification and remaining work

All 47 Node update tests passed, together with Go tests/vet for the native update
tool and lint/format checks. New cases cover two competing Windows owners, separate
installation roots, release/reacquisition, durable validation, failed-transaction
blocking, wrong recovery pin, explicit abandonment, corrupted journals, redirected
update directories, and killing a real transaction process after Validating then
recovering it successfully. Service observations use fixtures; archive operations
and locks use the real native helper in isolated output directories.

This demonstrates process-interruption recovery for validation. It is not machine
reboot/power-loss qualification or a service data recovery test. File sync plus
rename still needs Windows crash qualification before a commit protocol depends
on directory-entry durability. Remaining work includes shared operation quiescence,
coherent workspace/service backup, authenticated recovery authority, durable
application commit and rollback, and source-host capability rollout.
