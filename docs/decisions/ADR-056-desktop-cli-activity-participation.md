# ADR-056: Desktop and CLI activity participation

## Implemented boundary

Managed builds advertising activity protocol 1 now acquire a shared activity lease
through `acquireInstalledActivity` in Core. Desktop does so before window/IPC
initialization and retains the lease until accepted application quit. CLI acquires
before command dispatch, retains it across the awaited command and releases it in
`finally`. Failure to acquire prevents execution. Portable builds and managed
installations without activity metadata retain legacy behavior and return no lease;
they must never be counted as participating clients by update admission.

The lease helper is the fixed per-version `runtime/honeybee-lifecycle.exe`, copied
from the native update-package tool. Core checks managed installation metadata,
its launch-bound digest, the helper's digest and unredirected paths before starting
the hidden native helper. Invalid declared capability or missing/modified helper
fails; there is no portable fallback for a broken declared protocol.

Helper ownership loss aborts the lease signal and causes later IPC admission and
CLI completion checks to fail. This does not cancel an already-issued Storage
operation or prove that a client with a failed helper has finished. Production
admission must still account for this failure case before trusting exclusive
activity ownership alone.

## Desktop shutdown

All registered request/reply IPC handlers pass through an activity admission/drain
wrapper. A quit request closes new IPC admission while accepted handlers complete.
After the last handler settles, the app retries quit. Existing terminal quit
confirmation remains in place; cancellation reopens IPC admission and retains the
activity lease. Accepted quit releases the lease at `will-quit`. No new force-kill
or update-specific terminal-consent bypass is introduced.

This tracks awaited IPC handlers, not arbitrary detached work or external tools.
Existing terminal shutdown behavior is reused, not newly qualified as proof that
all shell descendants have exited. No updater-to-Desktop quit request/acknowledgment
channel or automatic restart action is implemented in this step.

## Doctor exception

The CLI entry bypasses shared activity only when its first command is exactly
`doctor`. Doctor is observational and must be runnable by the authorized updater
while exclusive activity is held. This applies to ordinary Doctor invocation too;
there is no environment-variable bypass for mutating CLI commands. It does not
weaken the separate version pin, full-payload authorization or service evidence
checks required by the updater. This exception assumes Doctor remains read-only.

## Package contract

The existing packagers emit `activity-client.json` with schema/protocol 1 when the
built CLI entry/Desktop main contains the new acquisition integration. This is a
build consistency marker, not cryptographic evidence of process participation.
Assembly requires matching markers from both packages; a mixed pair refuses.
When both participate, assembly copies the helper and adds:

```json
"activity": { "protocol": 1, "helperSha256": "<sha256>" }
```

to `installation.json`, already bound by the launch manifest. If neither package
advertises support, assembly remains a legacy installation. Package preparation
checks the helper against its declared digest and both client markers, in addition
to full inventory verification. Old signed/pinned manifests are not rewritten.
The isolated QA builder now copies the update-tool build output as a prerequisite.

## Verification and limits

- Core/CLI integration verifies portable and legacy behavior, coexisting shared
  leases, modified-helper rejection and a real CLI process refusing execution
  while an updater holds exclusive activity, then succeeding after release.
- Desktop drain tests verify accepted work completion, rejection of new work,
  quit cancellation and failed-handler cleanup.
- Four package tests cover valid activity metadata, missing markers, wrong helper
  digest and unsupported protocol. Existing package/activity regression tests pass.
- TypeScript checks for Core, CLI and Desktop main, lint and formatting pass.

A complete new QA beta.12 build was assembled at
`output/two-version-qa/build-JxlsN2/output/installations/0.1.0-beta.12-Y5gkTn/HoneyBee`.
Its real private Node/CLI refused exclusive admission and reported beta.12 after
release; its pointer remained byte-identical. Evidence is
`output/two-version-qa/build-JxlsN2/activity-smoke.json`. This newer build is distinct
from the earlier beta.12 bundle used for guest two-version qualification. Neither
that guest run nor the new CLI smoke qualifies this Desktop UI's shutdown/restart.

The next gate is packaged Desktop testing with pending work and terminal consent,
then explicit shutdown acknowledgment and restart orchestration. Existing older
clients, nonparticipating installations and external tools remain separate admission
concerns. No production Update & Restart flow is enabled yet.
