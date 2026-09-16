# ADR-074: Independent preparation worker

Date: 2026-09-13

Status: Preparation worker foundation implemented; Desktop dispatch and activation
remain pending. This adds no acceptance gate or manual VM qualification.

## Decision

Use the bootstrapper's existing hash-pinned private runtime for a separate Node
preparation process. `HoneyBeeLauncher.exe --update-job <job-name> <request-sha256>`
accepts only the fixed `scripts/update/worker.mjs` entry, a constrained job name
and a SHA-256 digest. The CLI shim cannot dispatch jobs. Pending activation blocks
admission. The bootstrapper verifies the runtime inventory, worker and packaged
`update-trust.json` before execution, filters Node injection environment variables
and bounds execution to 30 minutes.

The runtime builder copies the existing Desktop trust policy into that inventory.
It does not introduce another key source or enable updates with the currently empty
production key list. Older runtime inventories lacking the worker/policy refuse
dispatch; ordinary startup recovery retains its existing entry point.

`createPrepareJob` writes and syncs an exclusive request under `update/jobs/job-*`.
The request binds an installation-local staging directory, selected release hash
and exact source pointer bytes. It cannot specify executable paths, arbitrary
operations, trust keys or an observation override.

The worker verifies the request digest, exclusively claims it with `started.json`,
checks the source pointer and the pinned recovery approval, and hashes the approved
source payload. It then runs ADR-073 preparation with the real source/service
observer and records a synced `result.json`. It checks the source pointer again
before reporting success. Neither successful preparation nor a process exit code
authorizes activation.

## Failure and recovery boundaries

A duplicate or interrupted job is not replayed automatically: the existing claim
and any partial output remain for diagnosis. A new request can be created after
the previous process has stopped. Input failures before admission exit without
claiming the job; admitted failures record a negative result when storage permits.
Disk failure or interruption can leave `started.json` without a complete result;
consumers must treat that as incomplete, never success.

This worker does not close Desktop, change the active pointer, execute the target,
replace the service, or install a startup task. The bootstrapper currently waits
for the independent process; Desktop detachment, progress/result consumption and
activation handoff are still to be connected. Runtime approval still covers only
the initial installed source, so a later source is refused safely. Consecutive
source recovery support remains required before enabling the final UI flow.

## Validation

- Six Node tests passed: exclusive requests and source preservation, invalid
  stage/hash rejection, separate-process source-change failure and replay refusal,
  missing recovery approval, changed recovery payload, and request tampering before claim.
- The complete native launcher test suite passed, including new fixed-entry,
  argument, pinned trust/worker tampering, CLI and pending-recovery refusal tests
  and existing startup recovery regressions.
- Worker subprocess tests exercise refusal and durable failure evidence; they do
  not claim an end-to-end successful production update or service migration.
- Existing ADR-073 preparation tests cover inactive publication. They are reused;
  no new VM bundle or repeat of accepted reboot qualifications is requested here.

Acceptance item 05 remains partial. Next implementation work connects Desktop to
the worker and resolves continuing recovery approval before application activation.
