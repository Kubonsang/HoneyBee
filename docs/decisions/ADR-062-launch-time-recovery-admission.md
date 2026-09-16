# ADR-062: Launch-time admission for interrupted activation

Status: read-only launch guard implemented; automatic recovery dispatch pending.

## Finding and decision

The stable launcher previously validated `current.json` and the selected payload
without inspecting activation history. After interruption immediately following
pointer replacement, that could start a candidate that had not completed health
validation. The successful explicit QA recovery in ADR-061 did not close this
ordinary-startup gap.

Both `HoneyBeeLauncher.exe` and the stable CLI shim now inspect
`update/activations` before resolving a launch and again after payload verification.
No update directory or activation history remains a supported legacy installation.
Existing history must have complete, bound terminal records before launch proceeds.

`recovery.go` checks bounded metadata, ordinary directories/files, transaction names,
intent and pointer hashes, state-to-intent hashes, generation/version progression,
and commit/rollback history consistency. The active pointer must equal the outcome
of the highest recorded terminal generation. Conflicting outcomes for a generation
are rejected independently of directory enumeration order. This also prevents
launching a still-selected failed target after a recorded rollback.

Incomplete, corrupt, redirected, unknown or conflicting journals stop launch. The
error identifies recovery as required and includes the journal path when available.
The guard does not change pointers, repair metadata, delete journals, run Doctor,
execute journal-specified programs or guess a rollback target. Source payload and
user state remain available for the authorized recovery coordinator.

## Validation

Go tests and vet passed for the launcher, including interrupted/conflicting states,
CLI and Desktop refusal, pointer preservation, valid terminal histories, tampered
bindings, incomplete/unknown entries, rolled-back target rejection and version
ordering. A redirect test runs when the environment permits symlink creation.
The final launcher was rebuilt into `output/launcher`; the existing real Windows
stable A/B, arguments and stream smoke passed. Previously delivered QA bundles and
the VM installation were not overwritten with this new launcher.

## Boundaries and next integration

This is detection and fail-closed startup admission, not automatic recovery. Existing
Doctor recovery requires explicit release/service authorization; the QA baseline
observer is not a safe production default. A trusted recovery runtime and production
authorization adapter must be packaged and bound before ordinary launch can dispatch
recovery and retry launch. No service migration is authorized by this guard.

The scan is read-only and is not an atomic lock spanning process creation. Existing
application activity remains necessary, and racing update/startup still needs
qualification. Direct execution inside a version directory bypasses the stable
launcher guard. Internal recovery Doctor intentionally invokes its pinned Node/CLI
directly rather than this blocked public shim.

The guard supports at most 256 transaction directories and 32 entries per journal.
Unknown schema/files and excess retained history fail closed. History retention and
installer replacement must preserve a coherent pointer/history contract; this change
does not add journal garbage collection or retrofit already installed launchers.
Ordinary-launch VM qualification with an interrupted journal is the next test for
this new bootstrapper binary, separate from the earlier explicit recovery test.
