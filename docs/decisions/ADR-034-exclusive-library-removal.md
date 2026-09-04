# ADR-034: Exclusive Library-volume removal

## Status

Accepted for HoneyBee 0.1.0 Beta 4. Real Windows active-handle removal and physical reboot recovery
validation passed on 2026-09-04.

## Context

HoneyBee deliberately does not launch or supervise Unity, IDEs, shells, Codex, Claude Code, or their
children. Those processes can still keep files open in a Workspace `Library`. Removing the junction,
Git worktree, or retained child while such a handle exists would turn an external-tool lifetime into
silent partial cleanup.

Process discovery and termination are not a reliable ownership boundary. HoneyBee may not know the
full child-process tree, a PID can be reused, and a process can hold the volume without having been
launched by HoneyBee. The storage volume itself is the authoritative resource.

## Decision

Retained removal uses a schema-3 broker transaction with three operations:

1. `prepare-retained-removal` verifies the retained identity and mount target, then obtains an
   exclusive Windows volume lock before HoneyBee changes durable registry or Git state.
2. `commit-retained-removal` flushes and dismounts while the lock is held, removes the exact mount,
   detaches and deletes the exact child, and records a durable completion receipt.
3. `abort-retained-removal` releases only the reservation and volume lock.

HoneyBee uses a stable transaction ID per Workspace removal and a fresh request ID per attempt.
Prepared transactions expire and auto-abort after five minutes. A repeated prepare or commit for the
same transaction converges after a lost response or broker restart; a conflicting transaction is
rejected.

If the volume lock cannot be obtained, the broker returns `retained-in-use` and HoneyBee exposes the
stable `workspace.in-use` error. This happens before registry state, the Library junction, the Git
worktree, or the branch changes. The message instructs the user to close tools and retry. HoneyBee
does not enumerate or kill processes and does not add a Job Object or agent supervisor.

The broker wire schema is version 3. Existing lease journals and retained records keep their current
on-disk schemas. The named-pipe endpoint remains `unity-workspace-storage-v2`: the pipe name is the
installed service identity, not the message schema, and keeping it stable allows the existing
identity-checked `--replace` flow.

## Consequences

- `Library` remains the only storage-owned part of a Workspace.
- Busy removal is fail-closed and non-mutating; closing the holder and retrying is the recovery path.
- Once commit begins, a failure becomes `cleanup-pending` and the same remove command resumes it.
- Git dirty checks and exact-junction identity checks remain independent safety gates.
- Branches are preserved on every successful or retried removal.
- PID diagnostics and forced termination may be considered separately, but are not Beta 4
  requirements and cannot weaken the volume-lock gate.
