# ADR-051: Bind published app updates to activation and recovery

## Status and scope

Implemented as internal `activatePublishedUpdate` and `recoverPublishedUpdate` in
`scripts/update/published-update.mjs`. This connects a completed ADR-050 publication
to ADR-049 pointer activation using the pinned ADR-047 plan. It does not implement
a Desktop update button, release authentication, application shutdown, Doctor
process execution, service migration or reboot startup orchestration.

The caller supplies the installation root, plan path and SHA-256, publication
journal directory, and (for recovery) activation transaction directory. Target
version, launch pin and old pointer pin come from the pinned plan, rather than
independent caller-supplied activation fields. Only app-only plans are accepted.

## Admission and activation

Both operations require explicit admission and health callbacks. Admission must
return exactly `true`; missing, false or undefined admission refuses execution.
There are no production default callbacks. The caller is responsible for
authenticating the selected release/plan, establishing exclusive application and
workspace quiescence, and maintaining it until the operation completes. The
installation lock only coordinates update processes; it does not stop Desktop,
CLI operations or external tools. Recovery admission must authorize safe recovery
and recheck service compatibility without requiring a healthy target.

Activation takes the existing pointer primitive's installation lock, obtains
admission, revalidates the live source plan, then verifies the published directory.
The new read-only `verifyPublishedVersion` checks the pinned plan location,
manifest, inventory, exact publication intent/completion records, reserved directory
identity, all payload files and launch digest. It never resumes publication or
repairs a published file.

Target health runs between whole-payload checks. After pre-switch health, live
source revalidation runs again to detect changes during that check. Post-switch
health likewise has full published-payload verification before and after it.
The real health implementation must validate runtime/service state for the explicit
version and phase passed to it; it must not assume the stable shim selects the
candidate before activation. A boolean synthetic health callback is test-only.

Pre-switch failures leave the pointer intact. Post-switch failures use the existing
conservative rollback primitive and its source health gate. No additional master
journal is introduced: publication and activation retain their separate durable
journals. The caller retains the pinned plan and journal locations. If interrupted
between publication and activation, the old pointer remains active and activation
can be requested again after revalidation. An incomplete activation must instead
use explicit recovery.

## Recovery is not source-plan revalidation

An interrupted activation may already have changed `current.json`. Requiring the
old live pointer would block precisely the rollback we need. Recovery therefore
binds the caller-pinned plan to the activation journal's saved source/target
pointers and obtains recovery admission, then delegates to ADR-049's conservative
source verification and health checks. A corrupt target does not prevent rollback
to a valid, healthy source. Unknown current pointer bytes still refuse replacement.

Terminal recovery now performs explicit `committed-health` or `rolled-back-health`
validation, then rechecks the selected version and exact pointer. For a committed
result the adapter also verifies the whole published target around the health
callback. A corrupt committed payload or unhealthy terminal version is reported
as a failure; this does not automatically initiate a new rollback after commitment.
For a rolled-back result, target corruption does not invalidate a healthy restored
source. Full source inventory validation remains part of the caller's recovery
admission/health contract; the primitive verifies source launch-critical files.

## Validation and limitations

Ten new integration tests exercise real package preparation, publication and pointer
operations in isolated Windows directories. They cover successful commit and
terminal verification, absent/refused admission, stale service evidence, incorrect
plan pins and publication markers, whole-payload mutation during target health,
source drift during health, post-switch health failure, corrupt-target recovery,
and actual child-process termination immediately after pointer replacement.
All cases preserve old-version bytes and the user-state sentinel; failure cases
assert the appropriate unchanged or restored source pointer.

The complete Node update suite passes 78 tests. ESLint and formatting checks pass.
Tests use synthetic executables, service observations and admission/health callbacks;
they do not qualify real Desktop/Doctor execution, power-loss durability, signing or
privileged migration. Existing installations and the QA VM were not changed.

The next production integration needs a bounded, version-specific health runner and
release trust/admission policy, followed by process quiescence and launcher recovery
orchestration. These internal APIs must not be exposed through a permissive UI or
CLI wrapper in the meantime.
