# ADR-027: Native Agent Host foundation

## Status

Accepted for the Native Terminal PR 1 foundation. Native Work creation, schema v7 events, task
materialization, verified patches, Desktop UI, and the default-mode decision remain outside this PR.
Existing schema v6 structured automation remains unchanged.

## Decision

HoneyBee packages a repo-owned, SHA-256-pinned, deterministically built Windows Go executable named
`honeybee-native-agent-host.exe`. The Desktop invokes it through a TypeScript controller. Provider
commands and environments travel only over volatile stdio activation IPC; durable launch intent and
receipts contain identity and lifecycle metadata only.

Every launch uses a fresh UUID `launchId` and 256-bit nonce. Neither value is reused. A retry creates
a new launch directory and identity, including after `abandoned-before-registration`.

### Windows containment and activation boundary

The executable has a bootstrap supervisor role and a long-lived Host role:

1. The supervisor creates an unnamed bootstrap Job with `KILL_ON_JOB_CLOSE`.
2. It creates the Host suspended, assigns it to that Job, and resumes the Host.
3. The Host publishes its own PID/creation identity receipt before returning `host-registered`.
4. After HoneyBee verifies and durably records that receipt, the command is sent over volatile IPC.
5. The Host creates the provider suspended and assigns it to an unnamed Host-owned Job with
   `KILL_ON_JOB_CLOSE`.
6. The Host publishes its provider PID/creation identity receipt before returning
   `process-registered`.
7. Only after HoneyBee verifies and durably records that receipt may it send `activate`.
8. The Host resumes the provider and the supervisor receives `provider-resumed`.
9. A Windows process cannot be detached from a Job. The supervisor therefore clears
   `KILL_ON_JOB_CLOSE` on the bootstrap Job with `SetInformationJobObject`, then closes its sole Job
   handle.
10. The supervisor sends `bootstrap-released`; only then does the Host publish the activation
    receipt and return `activated`.

The order in steps 9–10 is mandatory. A crash before the flag is cleared kills the Host tree. A
crash after the handle is closed but before activation publication leaves a living, durably
registered Host/provider pair that reconciliation treats as occupied until cancellation/drain. An
activation receipt can therefore never claim that bootstrap containment was released before the
actual Win32 boundary.

The provider Job handle is unnamed, non-inheritable, and held only by the Host. It is never
duplicated into the supervisor, Desktop, provider, or descendants. Consequently Host termination
implies that Windows closed the last `KILL_ON_JOB_CLOSE` handle and terminated the provider tree.
That invariant is what permits recovery to return a slot when both Host and provider are gone but
an exit receipt is missing; the Run remains visibly `indeterminate`.

### Receipt authority and capacity

No durable capacity lease is introduced. Capacity is a derived index reconstructed on every
controller start from immutable intent and Host/process/activation/exit receipts:

- a fresh intent without a Host receipt is occupied until registration reconciliation completes;
- a live registered Host is occupied in every non-terminal phase;
- a durable exit or abandonment receipt is not occupied;
- a missing/reused Host identity after provider registration is `indeterminate`, not silently
  successful, but the Host-only Job invariant proves descendant drain and permits slot return.

Capacity is four. Waiting candidates are ordered `interactive`, `validation`, `background`, then
FIFO by `createdAt`, with the stable candidate ID as the final tie-breaker. Awaiting-verification
capacity semantics belong to Native Work (PR 3), not this Host-only PR.

### Crash matrix

| Durable boundary                                | Recovery result                                                     |
| ----------------------------------------------- | ------------------------------------------------------------------- |
| no intent                                       | no launch                                                           |
| intent, no Host receipt, within timeout         | occupied while registration is reconciled                           |
| intent, no Host receipt, timeout elapsed        | durable `abandoned-before-registration`; slot returned              |
| Host receipt, no provider receipt, Host live    | occupied                                                            |
| provider receipt, no activation, Host live      | occupied; cancel/drain before cleanup                               |
| before bootstrap `KILL_ON_JOB_CLOSE` clear      | supervisor close kills Host; Host close kills provider Job          |
| after clear, before sole bootstrap handle close | still bootstrap-contained and occupied                              |
| after handle close, before activation receipt   | registered processes remain occupied until reconciled               |
| activation receipt, Host live                   | active and occupied                                                 |
| Host missing, no exit receipt                   | `indeterminate`; Host-only Job invariant proves descendants drained |
| durable exit receipt                            | terminal and unoccupied                                             |

Immutable receipts are published by private temporary file, file flush, no-overwrite hard link, and
temporary-name removal. Readers recover only the known same-inode link window and then use
open/fstat/bounded-read validation. Unknown hard links fail closed.

## Verification

The repo owns a fake provider source under `tools/native-agent-host/testdata`. Integration tests
build real Windows executables and prove:

- the provider cannot create its marker before the process receipt is verified and activation is
  sent;
- cancellation kills provider descendants before `descendantsDrained: true` is published;
- capacity four is reconstructed after a new controller instance;
- priority/FIFO selection is deterministic;
- a never-registered intent is durably abandoned after its registration deadline;
- two deterministic Host builds have identical size and SHA-256.

The PR 2 entry gate must separately spike and prove Work-specific ACL confinement for VHDX workspace
roots before Native Work writes are allowed. That filesystem policy is not smuggled into this Host
foundation.

## Consequences

The provider retains its native terminal and product UI. HoneyBee owns only containment, durable
process identity, capacity reconstruction, and later workspace verification. The Host is not a
general security sandbox and does not claim to defend against arbitrary same-user local tampering.
