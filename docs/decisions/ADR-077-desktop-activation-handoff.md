# ADR-077: Desktop activation handoff

Date: 2026-09-14

Status: App-only Update & Restart path wired. Production signing, service migration
and final integrated qualification remain incomplete.

## Flow

Desktop retains the preparation job identity internally and offers Update & Restart
after preparation. Apply IPC accepts no renderer arguments. Main creates an exclusive
activation request binding the preparation request hash, original current pointer,
its own Desktop session descriptor and launcher hash. The pinned worker supports
only the explicit prepare/activate request schemas and preserves claim/result files.
Duplicate clicks are blocked; download cancellation does not interrupt activation.
Existing terminal consent can cancel shutdown and return the UI to Prepared.

`activateAuthenticatedUpdate` reauthenticates staged metadata, binds the plan to that
release and its signed inventory, verifies both source and target recovery payloads,
and revalidates the real service/source observation and inactive publication before
requesting shutdown. The target must carry ADR-076 continuing recovery metadata.
Service replacement remains refused by this app-only path.

The coordinator supplies explicit admission, health-execution and restart authorization
to the existing Desktop session / activity / Doctor / pointer transaction composition.
These hooks verify complete approved payloads and retain the existing publication,
service compatibility, work drain and selected-session checks. The renderer never
supplies trust keys, observation overrides, executable paths or authorization callbacks.

Preparation and activation execute outside Desktop. Closing Desktop detaches its UI
observer; the worker continues. A normal completed transaction uses the existing
stable launcher and new-session readiness check. On a thrown lifecycle failure the
coordinator may invoke the pinned ordinary launcher after checking the source and
known version identities; pending-journal recovery remains the launcher's authority.
It never rewrites the pointer in this fallback. A commit followed by restart failure
remains committed with failure evidence, and is not reported as a successful restart.

## Evidence and remaining work

- Sixteen controller tests passed, including apply admission, duplicate calls,
  shutdown cancellation/retry and failure display.
- Thirteen job/dispatch/worker tests passed, including a real independent worker
  refusing activation without preparation evidence and preserving the source pointer.
- Four new coordinator tests use real signed metadata, native extraction/publication
  and source payload verification with a simulated service observer and lifecycle
  adapter. They cover valid admission/cancel and signature/source/target tampering
  before shutdown. They do not execute a real Desktop update.
- Seventeen existing lifecycle/session tests passed. Missing compiled session modules
  were rebuilt; sandbox-denied native activity helpers ran in the same isolated
  tests outside the sandbox. No installed service or user project was modified.
- Main/preload/renderer type checks, lint, three Vite builds and real Electron IPC/UI
  smoke passed. Fixture smoke does not qualify the signed production update journey.

The production key list is still empty. Existing installed bootstrappers must not
be assumed to contain the new runtime. Interrupted preparation jobs and completed
activation results are retained; a newly opened Desktop does not yet restore the
update panel from these records. This remains a result-presentation/retry integration
task, not permission to replay an interrupted activation.

No manual VM task or acceptance gate was added. Item 05 still needs its fixed
two-consecutive-update integrated qualification using the final rebuilt artifacts.
Service migration, shared Repair and release qualification remain within the
original unfinished scope.
