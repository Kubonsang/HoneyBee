# ADR-083: Independent update integration while manual qualification is deferred

Date: 2026-09-14

Status: Implementation in progress; not release-qualified.

The user asked to continue work without their participation, keeping workstream 1
and manual/VM qualification paused. This change adds no acceptance gates and does
not operate the installed service, VM, projects, signing credentials or releases.

## Implemented

### Workstream 2: native signature prerequisite

`tools/workspace-storage-host/release_authentication_windows.go` verifies the same
domain-separated Ed25519 envelope as `scripts/update/release-authentication.mjs`.
It bounds metadata and key counts, pins SHA-256 of exact manifest bytes and SPKI
public keys, rejects duplicate/untrusted keys and noncanonical signatures, and
returns a private copy of the authenticated bytes. The caller must supply trust
from the trusted host build or protected policy, never from the user request.

This is deliberately not privileged package admission: the native host must still
parse supported migration policy, bind initiating SID and protected source evidence,
verify extracted package contents and obtain a coherent recovery point. There is
no new command exposing service replacement. Authentication alone grants no SCM
authority. A test covers changed bytes, missing/duplicate trust, trailing metadata,
size bounds, domain separation and ownership of returned bytes; it is not yet run.

### Workstream 3: concrete validation dispatch

`runInstalledCombinedUpdate` composes the coordinator with the installed Desktop
transport. Its transaction identity is computed once through
`combinedUpdateIdentity`; the target directory must equal the admitted candidate.
`options.validation` supplies `version` and `targetPointerSha256` (and optionally
`timeoutMs`), while the Launcher pin comes from `options.clients`. Required
`authorizeCandidate` and `verifyRelease` hooks remain explicit trust boundaries.

`validation-dispatch.mjs` rechecks protected candidate authorization, the exact
selected pointer, complete authenticated release and Launcher digest immediately
before dispatch through the stable Launcher. Process creation is not readiness:
the authenticated Desktop session must still report its renderer ready.

Validation profiles now use a deterministic hash of executable path and transaction
identity in the current user's temporary directory. Repeated dispatch therefore
uses Electron's single-instance lock even before the first process publishes its
session descriptor. Profiles are isolated from normal userData and retained.
They must eventually have bounded cleanup after terminal transaction state and
proven process exit; this change does not delete profiles or recovery evidence.

Production UI dispatch remains disabled for service-changing updates. Native SCM,
paired pointer selection, protected commit and boot recovery adapters are still
required; missing adapters do not fall back to mock success or app-only activation.

### Workstream 4: Repair after A/B updates

`verifyRepairApplication` authenticates the active version, stable Launcher and CLI
shim against the supplied Setup inventory. It accepts an increased pointer
generation only when the selected launch manifest matches that inventory. Inactive
versions and mutable recovery approval records are preserved and excluded from
active-app corruption checks. Unexpected or modified active files still fail.

`/REPAIR` uses this admission instead of requiring the entire installation to equal
the original fresh-install inventory. It acquires managed activity, rechecks the
payload under that lease, and uses the shared service/Doctor primitives. Evidence
is kept in a new `update/repairs/repair-*` directory and its path is reported in the
Setup result. Repair refuses pre-protocol installations rather than proceeding
without coordination. Ordinary fresh-install retry semantics remain unchanged.

This admits intact active apps for component/service repair. It does not yet
replace corrupted app files, change a conflicting service, import unknown ZIP
folders, or remove preserved application versions. Reconstructing active app
bytes needs its own Launcher-recognized interruption journal before any live
rename; an in-place overwrite is not an acceptable shortcut.

### Workstreams 5–6: candidate-bound handoff

`prepare:distribution` now writes `acceptance-input.json` automatically. It contains
the exact Setup/manifest hashes and exactly the 16 approved gates, all pending.
Earlier evidence may be attached, but is never automatically a final candidate pass.

`pnpm review:distribution <config.json> <new-report.json>` re-authenticates the
manifest using independently supplied public keys, rehashes ZIP/Setup, checks
Setup's Authenticode publisher and product version, compares the local WinGet
manifest to the candidate, and binds the acceptance results to the same hashes.
Config fields are `directory`, `acceptancePath`, `trustedPublicKeys` (public PEM
strings) and `publisherThumbprint`. Use absolute paths. No private keys are needed.

The output separates `artifactsVerified` from `acceptanceReady`. Evidence references
remain human/qualification-runner claims (`evidenceVerifiedByTool: false`). The tool
does not run qualification, publish, overwrite existing output or grant release
authorization (`publicationAllowed: false`). It can review pending acceptance.

## Checks performed

- ESLint and formatting for changed JavaScript/TypeScript files.
- Desktop main TypeScript compilation with `--noEmit`.
- Service host Go compilation with `-buildvcs=false`, output isolated under `output`.
- Native source and deferred test files formatted with gofmt.

Regression tests, NSIS build/execution, signed-artifact review execution and VM/manual
checks were deferred. New test source is not evidence of a passing runtime test.

## Remaining implementation dependencies

| Workstream | Remaining implementation                                                                               | Dependency                                                                     |
| ---------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| 1          | Coherent live-service maintenance and final recovery integration                                       | Paused by user                                                                 |
| 2          | Protected package policy/content admission; real SCM replacement/restore and boot entry                | Native maintenance/recovery contract from 1; designated supported service pair |
| 3          | Paired app-pointer commit/compensation, protected native bridge and production UI dispatch             | 2 must provide real durable commit/recovery authority                          |
| 4          | Authenticated damaged-app reconstruction and its interrupted-repair recovery; complete ZIP adoption UX | Repair journal and Launcher recovery integration; no destructive fallback      |
| 5          | Production trust, signing-provider invocation and complete final Setup/upgrade composition             | Real approved key/certificate inputs; completed component integration          |
| 6          | Assemble the single final candidate and run the fixed 16 gates                                         | Completed integration and user-resumed qualification                           |

Workstream 4 still contains independent implementation work. This document does
not claim that all work possible without user input is complete. No new manual
bundle or acceptance scope should be introduced when these dependencies resume.
