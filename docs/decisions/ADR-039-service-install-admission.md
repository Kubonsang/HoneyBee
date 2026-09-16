# ADR-039: Storage installation admission before mutation

## Status

Accepted as the service-side prerequisite for limited setup elevation. ADR-040 now
connects this contract to the repackaged interactive setup preview. Actual UAC and
service creation still require clean-VM qualification.

## Change

Under the existing global installer mutex, `install` now reads SCM and filesystem
state before creating directories, applying ACLs or reconciling receipts/binaries.
Only `ERROR_SERVICE_DOES_NOT_EXIST` means absence. Access denied, a service marked
for deletion, and other SCM failures stop the operation.

Admission validates local non-overlapping store/workspace paths, existing reparse
points, current and interrupted receipt identities, binary hashes and service
configuration. An existing service must have the expected executable/config command
and run as LocalSystem. Unknown, corrupt or foreign recovery evidence is retained
and rejected. A lone uncommitted next receipt does not establish ownership.

Without a receipt, both store and workspace roots must be missing or empty. This
prevents fresh setup from applying a new ACL to existing user data. A matching
receipt permits retry of an interrupted fresh installation. A missing service with
an older receipt is not treated as a supported migration, even with `--replace`.

After directory handles are secured, admission repeats before ACL changes to check
mutable file evidence again. Existing handle-based reparse protection remains in
place. This is not a complete defense against every concurrent file mutation or
an authenticated elevated payload handoff; those remain elevation design concerns.

## Fresh-install contract

The service host accepts:

```text
install --fresh-only --workspace-root <absolute-path> --user-sid <initiating-SID> --component-version <approved-version>
```

`--fresh-only` rejects an existing service under the mutex, even when an unelevated
caller previously observed absence. It cannot be combined with `--replace`. Legacy
explicit installation/replacement commands remain supported subject to the stricter
admission checks. A valid previous receipt can still establish interrupted ownership;
malformed evidence now requires manual recovery instead of automatic deletion.

The future elevation bridge must capture the original user's SID before UAC, use
an approved fixed host and exact arguments, wait for completion, and run health
validation again as the original user. It must not reinterpret rejection as permission
to replace the service. Cancelled UAC must leave the published app available for
retry/diagnostics. No installed service or user project was changed to validate this
source change.

## Validation and remaining work

Tests cover fresh read-only inspection, SCM failures, unowned data/service conflicts,
receipt user/root/version conflicts, interrupted receipt preservation, config/binary
mismatches, service command matching, overlapping/volume roots and fresh-only races.
The existing Windows host, usage and benchmark unit suites and Go vet also run.

These tests do not exercise actual SCM creation, ACL mutation on a real service,
UAC cancellation/alternate credentials, hard reboot, or binary replacement rollback.
Clean Windows VM qualification, rebuilt host hashes, and the elevation bridge are
still required before enabling automatic service installation in Setup. Existing
binary/receipt backup cleanup and general migration rollback are unchanged.
