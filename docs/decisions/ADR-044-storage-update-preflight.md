# ADR-044: Read-only Storage update preflight

## Status

Implemented as a Core planning primitive and developer CLI after ADR-043.
This step observes the current Storage service and describes the necessary update
operations. It does not install, stop, replace, repair, migrate or roll back a
service, and never removes workspaces. All plan results deny activation.

## Shared current-service admission

`inspectCompatibleStorage` now contains the admission previously inside
`requireCompatibleStorage`; the latter remains an async void wrapper, preserving
existing callers in managed project operations, adoption and Setup. Inspection
returns the diagnostic and status observations only after checking a running
service, valid receipt, existing executable matching its receipt digest, original
user match, accessible workspace root, exact source component identifier, and
storage responsiveness without manual recovery required.

Status must explicitly contain a nonnegative safe-integer `parentCount` and a
boolean `manualRecoveryRequired`. The Windows storage adapter previously treated
missing/malformed values as zero/false; it now throws `storage.invalid-response`.
The pinned upstream v2 status contract declares both JSON fields without omitempty,
so valid healthy responses retain their behavior. Unknown/older incomplete
responses fail safely rather than resembling an empty store. Counts describe
Storage parents, not projects, mounted workspaces or active operations.

The planner validates the source's managed client/control file hashes before
running these read-only probes. Only current source tools are queried; it never
executes the incoming Desktop, CLI or service executable. Probe failures, damaged
tools, unknown installation ownership, unavailable service or required recovery
block planning. Unknown state never authorizes fresh service installation.

## Result contract

`planStorageUpdate(storage, sourceTools, requirement)` accepts the manifest's
Storage compatibility/migration requirement and returns a schema-1 advisory plan:

| Status               | Meaning                                                                                                  | Intended elevation                                |
| -------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `app-only-candidate` | Source is currently healthy and target declares the exact same compatibility with no service replacement | None                                              |
| `migration-required` | Healthy supported source, with explicitly declared service replacement                                   | Service operation only, after the migrator exists |
| `blocked`            | Source cannot be admitted or transition is unsupported/inconsistent                                      | None                                              |

Every result has `activationAllowed: false`, a reason, target component identity,
steps and remaining gates. A successful observation also includes source identity
and parent count. Explicit service replacement is honored even if source/target
compatibility strings are equal. Conversely, different strings with migration
`none` are rejected. There is no numeric inference from hb11/hb12 names.

Nonzero parent counts do not prevent an app-only candidate. Zero parents do not
prove that service replacement is safe: migration always requires a qualified
backup and rollback implementation, regardless of count. Plans never propose
workspace deletion or project re-registration as automatic preparation.

For app-only candidates, intended steps are to quiesce operations, recheck service
compatibility, validate target Doctor, commit the active version and restart.
Service migration adds backup, migration and post-migration service validation.
These are descriptive step names, not executable instructions or manifest-provided
commands. No executor consumes them in this increment.

## Important limits of existing diagnostics

The current diagnostic checks the broker executable against its installation
receipt but does not bind the complete SCM command/account/configuration to that
receipt. It also does not expose the installed executable hash for comparison with
a target service payload. Equal compatibility identifiers therefore establish an
app-only candidate, not proof that every service binary is identical or current.

Every candidate retains gates for authenticated release metadata, prepared inventory,
SCM/receipt identity, project bindings, update/operation locks, fresh source probes
and durable activation/recovery. Migration additionally requires qualified backup
and rollback. A caller must not remove these gates because Doctor passed or the
parent count is zero. Registry-wide adoption checks, active-operation quiescence,
backup feasibility and actual SCM admission remain separate future work.

Observation is not atomic with other HoneyBee processes or administrators. A plan
has no durable authority and cannot be replayed to skip checks. Source facts must
be re-observed under the future operation lock immediately before mutation.

## Developer entry point

After building Core:

```powershell
node scripts/update/preflight.mjs INSTALL_ROOT MANIFEST_PATH MANIFEST_SHA256 BOOTSTRAPPER_VERSION CHANNEL
```

The equivalent package script is `preflight:update`. The CLI reads the active
pointer, verifies its launch-manifest hash, and resolves managed source tools from
that active version using existing `readInstalledStorage`/`WorkspaceToolResolver`.
It verifies the caller-pinned release manifest, version/channel/bootstrapper
admission and supported source component before probing the live service. It
rechecks exact active-pointer bytes after observation and prints JSON with the
source/target versions, observation time and manifest/pointer digests.

The CLI uses this checkout's built Core, not arbitrary code from the target ZIP.
It writes no journal or installation files and requests no UAC. Exit 0 means only
an app-only candidate; exit 2 means blocked or migration-required; exit 1 means
invalid inputs or failed metadata/source admission. Bootstrapper version remains
a developer-supplied fact until distribution identity is implemented. The SHA pin
is still not publisher authentication.

## Validation

Tests cover app-only updates with existing parents, required migration with zero
and nonzero parents, same-identifier replacement, unsupported/undeclared transitions,
invalid ownership/receipt/executable state, stopped or mismatched services, recovery
required, failed probes and tampered local tools. Only diagnose/status spies exist
in the planner's service fixture; the successful path checks one call to each.
Adapter tests cover missing, negative, fractional and incorrectly typed status
fields. Existing adoption/Doctor/Core/CLI tests verify shared-admission behavior.
No real host or guest service is mutated or migrated by this work. Actual elevation,
service backup/rollback, SCM identity capture and reboot qualification remain open.
