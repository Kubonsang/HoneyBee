# External Bee product integration boundary

Implemented locally on 2026-09-09 as storage component
`0.0.0+cfa606fd4143.hb11`. The private Bee cache is now managed by the broker:
parent publication, child ownership, retained attachment, removal and usage
accounting share its lifecycle. The exact source is preserved in the
[reviewable overlay](../../integrations/storage/external-bee.patch).
See the [implementation and validation record](external-bee-product.md).

The scope below describes the implemented contract. The subsequent
[installed-service checkpoint](external-bee-installed.md) upgraded hb10 to hb11
and passed SCM restart, physical reboot and actual desktop storage checks.
Both existing projects are ready; the packages remain local previews.

## Implemented scope and remaining deployment checks

1. Add an opt-in parent layout identifier, `external-bee-dag-v1`, to the storage
   compatibility key and parent metadata. Existing parents without it retain
   their current behavior. New layout requests must fail against an old broker
   before a parent transaction begins. HoneyBee cache preparation selects the
   new layout only with a matching packaged client/host capability.
2. Commit a Bee-less parent and a verified, immutable Bee seed as one parent
   transaction. Publish `COMPLETE` only when both components are durable and
   verified. Abort, crash recovery and parent GC must handle both. Preserve the
   original user's Library and reject links or other paths escaping the owned
   staging area. Privileged reads must use a stable verified source; a path
   check followed by an unprotected read is insufficient.
3. Give each child an independent external Bee directory with ownership tied
   to its lease and parent. Seed it once, retaining compiled artifacts and
   `TundraBuildState.state`/`.map`, while omitting the allowlisted DAG/input files.
   Attach must validate the exact junction target and cache identity, not seed
   again or silently accept a replacement. Existing retained workspaces keep
   their original storage layout; no in-place migration is required.
4. Extend the existing prepare/commit/abort removal transaction to cover the
   private cache. Busy Unity instances, foreign junctions, missing ownership
   evidence and uncertain detach state must preserve data with a diagnosable
   result. A failed cleanup must remain retryable after a service restart.
5. Include immutable seed allocation in shared parent usage, and private Bee
   allocation in per-workspace usage, admission and GC accounting. Keep child
   VHDX bytes separately visible so a 358 MB child is not reported as a 358 MB
   total cache. Include external directories in the read-only usage companion
   only after validating ownership; avoid following arbitrary reparse points.
6. Package the exact reviewed storage source/patch and component identity.
   Run the installed-user tests against an isolated broker before replacing
   the current service. Carry out GUI, service-restart and physical-reboot
   checks separately from the batch Unity experiment.

## Affected code and contracts

| Area                                  | Implementation points                                                           |
| ------------------------------------- | ------------------------------------------------------------------------------- |
| HoneyBee parent preparation           | `packages/core/src/workspace-core.ts`: cache identity, begin/copy/commit/abort  |
| Client boundary and persisted records | `workspace-storage.ts`, `workspace-types.ts`, `workspace-registry.ts`           |
| User-visible accounting               | `workspace-usage.ts`, `tools/workspace-storage-host/cmd/honeybee-usage`         |
| Native storage source                 | `unity-workspace-storage/workspace/key.go`, `types.go`, `native_windows.go`     |
| Atomic lifecycle and recovery         | storage `store.go`, `broker.go`, `removal.go` and their failure-injection tests |
| Reproducible packaging                | `apps/desktop/scripts/prepare-tools.mjs`, storage module pin and provenance     |

The pinned storage source is `cfa606fd4143a13b2d229f9d1e24e48ae0ddb8fa`.
HoneyBee consumes it as a separate Go module and requires a clean,
exact source revision when packaging. Packaging applies the SHA-256-pinned
overlay to a temporary clone and records its hash in the tool manifest.
The installed hb10 service does not have
the external-Bee parent/cache contract. Changing only HoneyBee's TypeScript
cache copy would therefore create an incomplete integration.

## Required product regression cases

- Legacy parent and retained child still attach without external-cache fields.
- New parent commit interruption never publishes a half-complete seed/image.
- Two children cannot share a writable Bee directory, even with forged metadata.
- Reattach preserves the child's modified Bee; it never restores the original seed.
- Missing, swapped, linked or foreign cache paths fail before Unity is launched.
- Remove while Unity is busy preserves child and cache; retry after exit succeeds.
- Remove one child and its cache, then compile/test the surviving child.
- Crash/restart during removal leaves a recoverable journal and accurate usage.
- Shared seed is charged once; external child bytes affect quota and free-space admission.
- Old client/new host and new client/old host have explicit compatibility behavior.

The approximate-size result remains 357.56 MB median child and 510.98 MB combined
cache in the completed performance campaign. Its historical 350 MB gate stays
failed; lifecycle acceptance is recorded separately rather than rewriting it.
