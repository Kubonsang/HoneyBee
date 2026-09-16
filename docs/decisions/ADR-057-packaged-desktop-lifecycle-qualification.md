# ADR-057: Packaged Desktop lifecycle qualification

Status: accepted for internal qualification; production update orchestration remains pending.

## Decision

Window close and application quit use the same admission/drain/terminal-consent
path. Previously, window close could close terminals before accepted IPC work
finished. Pending work now completes before terminal consent; cancellation
reopens admission and retains the application's shared activity lease.

The lifecycle branch of the existing Desktop smoke mode runs a real hidden
packaged Electron window and a real PowerShell PTY with `-NoProfile`. It holds a
synthetic pending operation through the same drain used by IPC, requests window
close, verifies rejection of new work, completes the operation, declines terminal
consent, and verifies that the terminal and activity lease remain available. A
controller acknowledgment then accepts application quit.

`node scripts/qualification/desktop-lifecycle-smoke.mjs` consumes the isolated
candidate produced by `build-two-version-candidate.mjs`. It runs Desktop directly,
then launches it again through the stable launcher. Each run has its own profile
and evidence directory. Exclusive activity must fail while quit is cancelled and
succeed after quit is accepted; `current.json` must remain byte-identical.

The GUI launcher deliberately detaches and exits immediately. Its successful exit
is not Desktop shutdown acknowledgment. Qualification waits for the Desktop smoke
record and then exclusive activity, instead of treating launcher lifetime as app
lifetime. On controller failure, a per-run continuation file lets the detached
smoke finish; the smoke also has a bounded wait. Activity-helper errors retain a
bounded stderr tail and exit status for diagnosis.

## Evidence

Host Windows packaged qualification passed on 2026-09-12:

- Candidate: `output/two-version-qa/build-lSxsAq/output/installations/0.1.0-beta.12-1bxZTw/HoneyBee`.
- Result: `output/desktop-lifecycle-smoke/case-isrErI/qualification.json`.
- Both direct Desktop and stable-launcher runs passed cancellation ownership,
  accepted-quit release, and pointer preservation.
- Eight Desktop drain/PTY tests and eight native activity-wrapper tests passed.
- Desktop main TypeScript, changed-code ESLint and formatting checks passed.

Earlier attempts are retained as failed evidence. The controller initially
mistook detached launcher exit for Desktop exit, leaving its test instance alive
until the smoke deadline and causing subsequent exclusive-drain timeouts. The
successful run occurred after those instances had exited.

## Limits and next gate

Consent is scripted at the existing terminal-confirmation callback; this does not
qualify mouse interaction with the native dialog. Pending work is synthetic and
does not mutate a workspace. Chromium GPU/sandbox disabling flags are used for
this automation run, including `--no-sandbox`; ordinary sandboxed UI launch still
needs separate qualification. The run verifies activity release, not complete
termination of every terminal descendant or explicit production shutdown IPC.

No service replacement, registry migration, production update, active-version
switch, or post-commit restart was performed. Earlier VM two-version results
predate this candidate and must not be attributed to it. The next integration is
explicit application shutdown acknowledgment and updater-controlled stable-launcher
restart, with cancellation preventing activation and failed validation preserving
the previous version.
