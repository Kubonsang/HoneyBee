# ADR-020: Desktop runtime control-plane boundary

- Status: Accepted
- Date: 2026-08-18

## Context

HoneyBee v0.6 has durable Unity transactions, Editor ownership, and a global Editor pool, but its
only operator surface is the CLI. A long-running Desktop process needs stable read and command
contracts without reimplementing orchestration or reading private files directly.

## Decision

`honeybee-cli/runtime` exports `HoneyBeeRuntimeFacade`. The facade composes the same v0.6
transaction and batch objects used by the CLI. It does not define a second workflow engine.

The facade always receives an explicit absolute `stateRoot`. The CLI keeps its compatible default
of `<cwd>/.honeybee/runs` and accepts `--state-root`. Desktop will use its application-data runtime
directory. Source, workspace, and state roots remain physically disjoint.

`@honeybee/control-plane-contracts` owns strict, versioned Zod DTOs for Doctor, Run summaries and
details, Editor Registry and pool snapshots, referenced Artifacts, controls, and Work starts.
Unknown fields are rejected at the process boundary.

Run History has no mutable index. `FileRunRepository.list()` enumerates only branded UUID Run
directories, and the facade derives status, timestamps, linkage, failure, and allowed actions from
the authoritative Journal. A Journal that remains corrupt after a short stable-read retry is
reported as `indeterminate`; it receives no mutation actions.

Artifact reads require the requested Artifact ID to occur as a complete `ArtifactRef` in the
validated Run Journal. `FileArtifactStore` then performs its normal byte-length and digest check.
Arbitrary paths and unreferenced blobs are never exposed.

Doctor is read-only. It validates the selected Unity project, physical path isolation, strict v0.6
config, executable availability, and the workspace-storage binary pin. It starts an Agent only when
the project profile contains an explicit bounded probe. Process output and raw parser errors are
not returned in Doctor DTOs.

The Editor pool exposes a read-only snapshot of capacity, active leases, and the effective
priority/FIFO queue. The snapshot does not grant, release, or reorder leases.

## Consequences

Desktop renderer code can use one narrow API and cannot import filesystem or orchestration
adapters. Existing v0.6 durability and cleanup rules remain authoritative. Patch disposition and
source mutation are intentionally deferred to the later Desktop patch-application slice.
