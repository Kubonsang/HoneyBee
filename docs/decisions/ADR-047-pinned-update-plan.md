# ADR-047: Bind preparation and source observations into a pinned update plan

## Status

Implemented after ADR-046 as developer tooling. Planning now joins native package
preparation and current-service preflight; revalidation checks that neither side
has changed. No executor, update lock, service migration, active-version switch,
rollback or UI is enabled by this step. All results deny activation.

## Creation

`createUpdatePlan` accepts an installation root, its direct staging child, the
expected release-manifest digest, bootstrapper identity and channel. It invokes
the shared `observeUpdateSource` function extracted from the existing preflight
CLI; there is one production implementation of source observation.

Blocked source observations stop before extraction. An app-only candidate or a
migration-required observation may produce an advisory plan. The latter still
requires the unimplemented backup/migrator gates.

Creation performs a new `prepareRelease` operation against the pinned ZIP. It never
accepts an arbitrary caller-provided Prepared marker or self-declared inventory.
The resulting inventory hashes originate in verified archive extraction. A second
source observation must match the first on version, component, pointer digest,
service evidence fingerprint, manifest digest, parent count and plan classification.
The current pointer bytes are checked again before publication.

The new preparation attempt receives an exclusively created, file-synced `plan.json`:

- schema/state and `activationAllowed: false`;
- stage/preparation attempt names, constrained to direct children of `update`;
- release-manifest digest and source version/channel/bootstrapper requirements;
- the bound source observation;
- complete prepared-inventory digest and launch-manifest digest;
- remaining activation/migration gates.

The command returns the plan path and SHA-256 of its exact bytes. Plans are never
rewritten in place. Creation failure leaves the preparation evidence; it does not
publish a successful plan. A crash can leave a partial plan, which fails JSON/hash
validation. Retry creates another preparation attempt.

## Revalidation

`revalidateUpdatePlan` requires the installation root and the caller-retained plan
SHA-256. It verifies exact plan bytes, supported schema/state, attempt containment,
plain directories, pinned release metadata and source admission. It then observes
the live source, checks the bound inventory bytes, re-enumerates/re-hashes every
prepared file using ADR-043 validation, compares launch identity, observes the
source again, and rechecks the current pointer.

Changes to the plan, release manifest, inventory, payload, pointer, service evidence
or parent count reject revalidation. It returns `Revalidated` only as an in-memory
result and still sets `activationAllowed: false`; no mutable ready marker is written.
It does not rerun ZIP extraction at revalidation: the originally created plan pin
binds the inventory derived from the verified ZIP, and every extracted file is
checked against that inventory again.

Neither checksum authenticates the publisher or protects against a caller approving
new malicious bytes and a new checksum together. Production signature/release trust
remains a gate. The bootstrapper version is still a developer-supplied fact. The
plan pin is not an execution capability, signature or lease.

These checks detect observed changes but cannot freeze files, workspaces or SCM
state. Revalidation must eventually run under update/operation locks immediately
before mutation. There is deliberately no claim that a time-based expiration can
replace those locks. Partial observations, ABA changes and post-check mutation
remain reasons to keep activation disabled until the transaction exists.

## Commands

Build Core and the update package tool before using the developer entry points:

```powershell
node scripts/update/plan.mjs create ROOT STAGE MANIFEST_SHA256 BOOTSTRAPPER_VERSION CHANNEL
node scripts/update/plan.mjs revalidate ROOT PLAN_PATH PLAN_SHA256
```

`plan:update` exposes the same command through package scripts. The original
`preflight:update` output and exit-code behavior are retained through the extracted
source-observation function. Installed packages, the VM and real services were not
changed. Older source hosts lacking ADR-045 evidence still fail preflight.

## Validation

All 39 Node update tests passed. The new tests run real native ZIP creation,
staging, extraction and payload validation with injected service observations;
they do not call SCM. They cover unchanged revalidation, altered plan/inventory/
payload/manifest/pointer/service, source drift during creation/revalidation, and
blocked source refusal before preparation. Existing staged-download termination
and interrupted-preparation tests remain in the same suite.

Test fixtures were moved into a shared fixture module rather than duplicating the
assembly contract. Metadata reading keeps its 64 KiB default; inventory reads use
an explicit bounded 8 MiB limit. `test:update` builds Core before loading the
production observer, making the new tests runnable from a clean checkout.
Lint and formatting checks pass. Real Windows service integration, installer
capability rollout, operation ownership, durable commit and recovery remain open.
