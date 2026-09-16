# ADR-059: Desktop session shutdown and restart readiness

Status: implemented and qualified for same-version packaged restart; update UI pending.

## Decision

Managed Desktop instances with application activity participation now open a
per-run Windows named pipe after window loading. Each uses a random session UUID
and 256-bit capability token. A descriptor under
`update/desktop-sessions/<session-id>.json` binds the pipe, installation root and
running version. The updater selects an explicit descriptor, never broadcasts to
all processes or guesses ownership from a PID.

`update-session.ts` serves bounded `status` and `shutdown` requests. Both require
the capability, installation root, session identity and request ID. Responses echo
the identity. Unsupported requests and unauthenticated clients cannot initiate
shutdown. Requests have size/time bounds and a connection limit. Tokens must not
be copied into logs or release manifests. The descriptor inherits protection from
the per-user installation directory; this is a same-user capability mechanism,
not isolation from malicious code running as that user or an administrator.
Redirected descriptor paths are refused. This does not support shared machine-wide
application directories with permissive ACLs.

`DesktopUpdateShutdown` reuses the existing activity drain and terminal consent.
It waits for accepted work before prompting, reopens admission on decline, and
cancels pending shutdown when the request connection disappears. The server writes
an explicit accepted response before scheduling `app.quit()`. Accepted consent is
not proof of process exit: the updater must still acquire exclusive activity.
Queued drain callbacks recheck closing state so cancellation cannot trigger a late
quit. Simultaneous shutdown requests do not start multiple confirmation flows.

The normal packaged Desktop publishes this endpoint; portable and pre-protocol
applications do not. Shutdown uses existing terminal consent, with no additional
dialog when there are no running terminals. Endpoint access alone does not grant
release/service trust or authorize a version switch.

## Restart

`desktop-session.mjs` provides the real client and
`updateAndRestartDesktopWithDoctor`. This composition checks the chosen session
against the active source version, uses the existing update admission and Doctor
callbacks, and wires shutdown and readiness into ADR-058.

Immediately before restart it snapshots session records. Readiness requires a new
session, the selected version, an authenticated live response and a loaded window.
The source session, stale records and startup responses cannot satisfy readiness.
The coordinator rechecks the active pointer after readiness and returns `Ready`.
Readiness failure returns `Failed` while preserving the committed or rolled-back
activation result. `renderer-loaded` is intentionally narrower than Doctor health,
React interaction readiness, or end-user workflow qualification.

Descriptor cleanup on normal quit is best effort. Crash leftovers never count as
live readiness and are not automatically deleted based on a PID. More than 256
records fails closed and requires diagnostics; stale-record maintenance remains
separate work. Existing durable activation recovery remains unchanged.

## Evidence

On 2026-09-13:

- 41 Node tests passed: six real named-pipe/shutdown tests, eleven lifecycle tests,
  sixteen publication/Doctor/rollback tests and eight activity tests.
- Eight Desktop drain/PTY tests passed, plus Desktop main TypeScript and changed-code
  ESLint/format checks.
- A new isolated candidate was built at
  `output/two-version-qa/build-oAnFPo/output/installations/0.1.0-beta.12-ZqqAp4/HoneyBee`.
- `node scripts/qualification/desktop-session-smoke.mjs` passed using that actual
  packaged Electron and stable launcher. It authenticated the first Desktop,
  received accepted shutdown, acquired exclusive activity, launched a replacement,
  observed a different session ID at beta.12 with a loaded window, shut it down,
  and reacquired exclusive activity. `current.json` remained byte-identical.
- Evidence: `output/desktop-session-smoke/case-56Voaa/qualification.json`.

The packaged test uses isolated fixture data and profiles, hidden windows and
Chromium automation flags including `--no-sandbox`. It uses the production session
server and shutdown controller, but does not create terminals or click a consent
dialog. Pending work/cancellation are covered by the transport/controller tests.
No service, project or installed active version was modified.

## Next qualification

The actual session transport is connected to Desktop and the internal update
composition. A user-facing Update & Restart button and production update entry
point are not enabled. The next qualification must combine two distinct packaged
versions, real Doctor and this transport in the VM, covering commit, validation
rollback, cancellation and restart failure. Same-version restart evidence must not
be reported as that full end-to-end update qualification. Readiness after reboot
and restart replay also remain outside this change.
