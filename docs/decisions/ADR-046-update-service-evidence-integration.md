# ADR-046: Bind update preflight to native service evidence

## Status

ADR-045's read-only service evidence command is now connected to the Core update
planner and therefore the developer `preflight:update` command. The normal Doctor,
Setup and project-operation admission paths keep their existing behavior. No
backup, UAC, service replacement or activation is triggered by this integration.

## Evidence port and decoding

`WorkspaceStoragePort.serviceEvidence` is optional for compatibility with existing
ports, but mandatory for update planning. `WindowsWorkspaceStorage` dispatches
exactly `service-evidence` to the selected, pinned control companion. It does not
pass a backup destination or an elevation flag, nor resolve a second host from PATH.

The decoder requires a successful schema-1 envelope and evidence, schema-2 receipt,
valid SHA-256 strings, absolute normalized local Windows paths, and explicit
`recoveryReady: false`. It checks receipt/executable digest agreement, service name,
LocalSystem account, automatic start, standalone Win32 type and running state.
Missing fields and unknown schemas fail without defaults. Receipt and SCM command
semantics remain enforced by the pinned native host's ADR-045 validator; Core does
not introduce a different Windows command-line parser.

The decoder constructs a fresh typed observation in a fixed property order. Future
protocol versions must be explicitly supported. Additional unknown properties do
not grant capability or recovery authority.

## Planner sequence

After source tool hashes are validated, planning now:

1. Requires the native evidence capability and captures the first observation.
2. Matches receipt component identity to the source requirement and actual service
   executable SHA-256 to the source package's pinned control digest.
3. Runs the shared compatible-service diagnostic/status inspection.
4. Requires its workspace root to match the evidence receipt root.
5. Captures evidence again and rejects any change to the decoded observation.
6. Includes `sourceEvidenceSha256`, the hash of the canonical decoded observation,
   in a successful advisory plan.

This detects an executable that agrees with its receipt but differs from the
approved source package, and drift in receipt/config/SCM identity during planning.
Same-protocol service builds with different hashes are conservatively blocked;
release qualification must not silently treat them as equivalent.

`verify-scm-and-receipt-identity` is replaced by the explicit remaining gate
`recheck-scm-and-receipt-under-lock`. Two observations are not an atomic transaction:
an administrator or another process can change state after the last query. The
fingerprint is an observation identifier, not a signature, lease or permission to
replay a stale plan. Parent counts do not prove that operations are quiescent.

All successful plans still return `activationAllowed: false`; migration remains
blocked on coherent data backup, restoration, operation locks and durable recovery.
The planner does not request ADR-045's component backup automatically.

## Compatibility and rollout

Older host binaries reject the new command. Optional ports that lack it, command
failures, access denial and malformed evidence all block update planning; there
is no fallback to the weaker diagnose-only candidate. Existing Doctor/project
operations continue to use their established diagnose/status path.

This change is source-level integration. Existing approved packages and the user's
VM were not rebuilt or modified. Before distribution, the new host and Core must
be packaged together through the pinned-source build and compatibility digest
workflow. An old installed source cannot become eligible merely by installing a
new target ZIP: capability rollout for that source must be explicitly qualified,
without silently weakening this gate.

## Verification

53 focused tests passed across the Storage adapter, update planner, Doctor and
project adoption. They cover pinned control dispatch, malformed/schema-invalid
responses, recovery-authority rejection, unsupported old hosts, mismatched source
binary, changing evidence and inconsistent workspace roots. Existing health and
adoption checks continue to pass. Core typecheck/build, lint, formatting and
repository dependency checks pass. These are fixture-based service observations;
actual Windows SCM/VM integration qualification remains outstanding.
