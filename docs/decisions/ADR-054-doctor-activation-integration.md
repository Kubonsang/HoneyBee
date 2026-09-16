# ADR-054: Doctor health in app-only activation and recovery

## Scope

`scripts/update/doctor-update.mjs` adds internal
`activatePublishedUpdateWithDoctor` and `recoverPublishedUpdateWithDoctor` entry
points. They compose ADR-051's published update adapter with the explicit-version
Doctor runner and its Windows Job Object transport. No permissive health callback
is installed into the older primitive. No Desktop UI or automatic startup caller
is introduced, and existing installations are not changed by importing this module.

The caller must supply explicit update admission and Doctor execution authorization
callbacks. Admission must authenticate the release, validate source evidence and
maintain application/workspace quiescence through completion. Doctor authorization
receives the selected version, launch digest, installation root and phase, and
must validate the complete selected payload before execution. Both decisions remain
mandatory; a passing Doctor is not release trust or service migration permission.

## Pinned version selection

The adapter reads the caller-pinned app-only plan. During activation, it binds the
current pointer bytes to the plan's source pointer SHA-256. During recovery, it
reads `source.json` from the explicitly selected activation journal and verifies
the same pin. The journal must be an immediate, nonredirected activation directory
inside this installation. The existing activation adapter subsequently rechecks
the plan and full pointer journal under its installation lock.

Source version and launch digest come from those exact saved pointer bytes; the
target comes from the pinned plan. Health phase dispatch is fixed:

| Phase                | Selected version |
| -------------------- | ---------------- |
| source-health        | Source           |
| target-before-switch | Target           |
| target-after-switch  | Target           |
| rollback             | Source           |
| committed-health     | Target           |
| rolled-back-health   | Source           |

Unknown phases, roots or version identities fail. The stable shim is never used
to choose which Doctor runs. Therefore a candidate-selected pointer cannot cause
rollback health to inspect the candidate accidentally. The default transport is
the real bounded Job Object helper; transport injection is an internal test seam.

## Failure and evidence

Pre-switch Doctor failure blocks replacement. A post-switch failure triggers the
existing conservative rollback, including another source Doctor check. If source
health also fails, the operation requires explicit recovery and retains the journal.
The recovery path does not demand the old live pointer or a healthy target before
restoring the pinned source.

Completed operations return phase-tagged `healthChecks` alongside their committed
or rolled-back result. Thrown operation errors expose `healthChecks` and preserve
the original error as their cause. These reports are in-memory evidence, not
new durable journal records; a future orchestrator must persist them if required.
Nonzero Doctor exit remains failed health even if its diagnostic JSON claims
readiness. The current committed-recovery policy reports unhealthy committed state
without starting a new automatic rollback transaction.

## Validation and next gates

Four integration tests cover source/target selection through commit and terminal
recovery, absent/refused execution authorization, pre-switch process failure,
post-switch failure followed by source rollback, and saved-source recovery while
the candidate pointer is selected. They also verify preserved source files and user
state. The combined published-update, Doctor and containment suites passed 36 tests.
Lint and formatting checks passed.

These new integration tests use synthetic executable files and injected Doctor
transport. The real packaged Doctor/Job Object path separately passed in the QA
guest as recorded in the [qualification report](../validation/packaged-doctor-job-qualification.md).
That earlier pass is not an actual version-switch qualification for this adapter.

No service migration, project rebinding, Desktop UI readiness, signing, process
quiescence implementation or automatic reboot recovery is added here. Next steps
are a concrete release admission/quiescence implementation and an isolated real
two-version activation qualification before exposing an Update & Restart action.
