# Integrated QA runner — 2026-09-14

> Historical checkpoint: the implementation described below was subsequently
> completed with the fixed interruption/rollback runner. See
> [the completion record](interruption-matrix-implementation-2026-09-14.md) for the
> new bundle and exact remaining execution/acceptance status.

## Exact status

The successful integrated sequence is implemented and packaged. **The complete
fixed 16-gate matrix is not ready to run, and the release is not published.**
Do not ask the user to run this as another per-feature manual qualification.
Keep this runner in the single final bundle while completing the remaining
matrix wiring. No existing acceptance result was changed by this work.

| Deliverable                                                       | Status                                                              |
| ----------------------------------------------------------------- | ------------------------------------------------------------------- |
| Production beta.12 Setup and authenticated update archive         | Built previously; bytes unchanged                                   |
| QA maintenance baseline Setup                                     | Built; separate from production and historical releases             |
| Service replacement input                                         | Signed QA admission variant; production application bytes unchanged |
| Consecutive beta.13 and beta.14 updates                           | Built and signed for QA only; unpublished                           |
| Registered project and populated Workspace preservation collector | Implemented; real Git tests passed                                  |
| Service → Repair → two app updates runner                         | Implemented and bundled; not executed in VM                         |
| Full fixed interruption/rollback matrix integration               | Incomplete                                                          |
| Final acceptance / public release                                 | Incomplete / unpublished                                            |
| Windows Authenticode                                              | Deferred by user; unchanged                                         |

## Frozen artifacts

Production Setup SHA-256:
`30f23bf7a5e60e63f6944ed143264df36c493d998592bcba3b40ed713e38fefa`.
Production manifest SHA-256:
`d854be16d07f0d4a94611eac57a0855f85f908373954be570a427c209dbe136f`.

`output/final-qualification-inputs.json` records the fixed candidate, three update
inputs, and the existing 16 acceptance gates. `output/current-integrated-qa.json`
locates the assembled bundle:
`output/integrated-qa/integrated-HWZtqq` (111 files, approximately 1.37 GB).
The bundle is neither transferred nor executed. `integratedSequenceReady: true`
does not mean `fullMatrixReady: true`; the latter remains false.

The QA baseline service is built from the same source code with a distinct Go
build identity and component version. Its host SHA-256 differs from production.
This can exercise real SCM replacement and VHDX preservation mechanisms, but
does not establish legacy hb12 migration, historical ABI compatibility, or store
schema migration support. The production release manifest still admits only its
original app-only update path. QA manifests do not replace it.

## Implemented sequence

1. Check pinned VM computer name and original user SID, refuse elevation, verify
   all artifact hashes, and require Git plus 16 GiB free space. Refuse any existing
   HoneyBee installation, service, or store; never delete them or reset the VM.
2. Run QA baseline Setup interactively. Only HoneyBee's service helper elevates.
3. Create one disposable Git-backed Unity directory using a Korean/spaced path,
   commit source, register it using the stable CLI, prepare a real storage parent,
   and create a ready Library CoW Workspace. Dirty tracked and untracked files in
   both worktrees. The cache seed is synthetic: this is not Unity import testing.
4. Record registry bytes, project and Workspace bindings, local branches, HEAD,
   index, status and source-file hashes. Run actual installed Doctor and compare
   installed service host hash/component/receipt/SID with the expected source.
5. Run the authenticated service update through the installed pinned worker.
   Require `Committed`, live service and Doctor health, and unchanged source data.
6. Run the matching production beta.12 Setup with `/REPAIR`, checking health and
   preservation. This tests idempotent Repair, not damaged-component reconstruction.
7. Apply the two app-only updates through the same worker, checking service hash,
   active version, Doctor and preservation after each transition.

Each action gets an exclusive, flushed `Started` event before it runs and a
separate `Completed` or `Failed` event afterward. An existing evidence directory
is refused; the QA driver never guesses whether an interrupted mutation may be
replayed. Product recovery remains responsible for its own durable transaction.
No result from this runner automatically promotes an acceptance gate or permits
publication.

## Local validation completed

- Six focused tests passed: ordering and no false release pass, preflight refusal
  before mutation, lost-edit/noncommit stop, exclusive evidence and persistence
  failure, real Git preservation, and rejection of an empty Workspace registry.
- ESLint and Prettier checks passed for the new JavaScript modules.
- Both PowerShell entry/inspection scripts parsed successfully.
- Copied bundle files were rehashed. The bundled Node runtime resolved the actual
  Setup update and integrated-flow dependency trees successfully.

These are local runner checks, not real-service acceptance passes. No host SCM,
VHDX, VM, project or installation was modified.

## Execution constraint and remaining scope

Read-only `Get-VM` and `Get-VMSnapshot` for
`HoneyBee-Setup-QA-20260910` failed because the current process lacks Hyper-V
administration rights, including outside the sandbox. This was a Windows access
denial, not an automatic approval-review rejection. No UAC process was started.
The guest's current state and clean checkpoints remain unverified.

Before user handoff, integrate the outstanding rollback/interruption scenarios
from the existing acceptance contract and attach retained evidence to unaffected
gates. Do not add gates, publish QA-only versions, claim historical migration
from the QA baseline, or ask for this successful-sequence runner as a separate
manual test. Public release remains subject to the previously agreed acceptance
contract, with Authenticode explicitly deferred.
