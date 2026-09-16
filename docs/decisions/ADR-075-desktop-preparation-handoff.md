# ADR-075: Desktop preparation handoff

Date: 2026-09-13

Status: Desktop dispatch and preparation result handling implemented. Activation
handoff and continuing recovery approval remain pending.

## Behavior

After authenticating a downloaded release, Desktop automatically creates an
ADR-074 preparation job and launches the installed bootstrapper with its fixed
job arguments. The renderer cannot supply a path, executable, key or request body.
The process uses detached execution, hidden windows and no inherited stdio.
Desktop observes completion while open; disposal detaches controller observation
without requesting worker cancellation. The bootstrapper retains its execution
timeout and the worker's durable job records.

The display moves from Downloading to Preparing to Prepared. Preparing blocks
duplicate checks/downloads and does not offer download cancellation; the panel
can still close. Failed preparation uses the existing retryable failure display.
Prepared explicitly says the new version has not been activated. No Update &
Restart button, application shutdown or service replacement is enabled here.

A zero worker exit is insufficient: the dispatcher reads bounded, ordinary job
files, rechecks the request digest, requires a positive result for that request,
and compares the release version/hash/signer, stage and source pointer. It also
requires `activationAllowed: false`. Completion is display evidence, not authority
for a future activation operation. Raw job paths and errors stay out of renderer
status. Interrupted jobs are preserved; reopening Desktop does not yet discover
or resume them automatically.

The existing empty production key policy still disables discovery. Older pinned
runtimes and sources without approved recovery fail safely through ADR-074. A
recovery-enabled rebuilt installation is required to use this worker; this change
does not replace already-installed bootstrappers or expand source approval.

## Validation and remaining scope

- Twelve job/dispatcher tests passed, including six new completion-binding cases.
  The dispatcher runner is injected in those six tests: they do not claim real
  packaged Desktop-to-bootstrapper lifetime qualification.
- Fourteen Desktop controller tests passed, including single dispatch, cancellation
  boundaries, failure display and disposal during preparation.
- Main/preload/renderer type checks, ESLint, all three Vite builds and the real
  Electron IPC/UI smoke passed. The smoke uses the existing fixture mode; it is
  not a successful production update with signing keys.
- No additional VM qualification or acceptance gate was introduced. Existing
  recovery passes remain valid within their documented scope.

Acceptance item 05 remains partial. Continuing source recovery approval and
activation handoff are the next implementation dependencies, before final combined
qualification of the complete Update & Restart flow.
