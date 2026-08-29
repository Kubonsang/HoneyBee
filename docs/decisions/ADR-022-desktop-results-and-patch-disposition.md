# ADR-022: Desktop results and verified patch disposition

- Status: Accepted
- Date: 2026-08-18

## Context

The Desktop must observe v0.6 Runs and let an operator accept or reject a verified Unity change
after the transaction workspace has already been released. A workflow terminal event must remain
the final Journal event, so post-run product decisions cannot be appended to the orchestration
Journal. Patch application also writes the original Unity project and therefore needs stronger
source-drift and crash-recovery boundaries than a renderer file copy.

## Decision

The Command Center polls a read-only HoneyBeeRuntimeFacade snapshot. Run summaries, phases,
Evidence, Editor Pool state, Editor Registry observations, and allowed Resume/Cancel actions are
derived from authoritative Journals and existing coordinators. Only Artifacts with a local
artifact.stored event are readable from a Run; a parent reference to a child Artifact does not
grant access to the parent's Artifact Store.

Newly produced verified patches use manifest schema version 2. The manifest remains reference-only:
it contains a detailed base tree manifest, the result tree manifest, ordered add, modify, or delete
entries, digests, and Artifact references. Before/after file bodies are independent
unity-patch-content blobs in the existing content-addressed Artifact Store. Bounded text previews
are returned to the renderer; binary and oversized content is metadata-only.

Apply and Reject use a separate strict patch-disposition.json record inside the child Run. They do
not modify its terminal orchestration Journal. The existing executor lease serializes actions and
Run deletion. Reject writes a terminal disposition without touching source.

Apply first re-reads every referenced Artifact and compares the physical source tree with the
durable base tree. It then uses deterministic same-directory temporary and backup files. Each
completed entry advances an atomically replaced, fsynced checkpoint. Resume reconciles base,
backup, temporary, and result digests. A conflict rolls completed entries back in reverse order and
is terminal only after the base tree is reproduced. If safe rollback cannot be proven, disposition
is indeterminate and Run deletion is denied. Result commit is accepted only after the tree,
excluding the exact private action sidecars, matches the durable result manifest; sidecars are then
removed.

Patch schema version 1 remains parseable for history and may be rejected. Apply is not offered
because it has no detailed durable base tree. No compatibility data is synthesized into a terminal
Journal.

## Consequences

The Desktop can display file-by-file results and apply a v0.6 change without retaining its
workspace. Source drift fails closed before mutation, Apply/Reject are idempotent per action, and a
process crash leaves a resumable checkpoint or an explicitly indeterminate disposition. This is
single-host process-crash durability, not full power-loss durability.

Git integration, merge strategies, automatic conflict resolution, editor-side patching, and
multi-patch composition remain outside the Desktop MVP.
