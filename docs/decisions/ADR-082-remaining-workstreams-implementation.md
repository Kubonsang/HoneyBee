# ADR-082: Workstreams 2–6 implementation with qualification deferred

Date: 2026-09-14. Status: implementation in progress, not release qualified.

The user paused workstream 1 and requested independent work on 2–6, deferring
verification. The original 16 acceptance gates remain unchanged. This change does
not claim all independent work or any complete remaining workstream is finished.

## Service and application coordination (2–3)

`scripts/update/combined-update.mjs` adds an internal, resumable coordinator:

Prepared → ServiceReady → AppSelected → DesktopReady → Committing → Committed.

Failures before Committing enter RollingBack → RolledBack. The rollback sequence
stops the validation Desktop, proves quiescence, restores service and application,
validates source health, then restarts the source. Committing is a durable decision:
recovery repeats the protected commit operation rather than guessing whether the
machine-side commit happened. Journal publication uses synced temporary files and
non-overwriting hard links, preserving partial evidence.

All service/app adapters are required, idempotent and explicitly authorized. The
user-writable journal is not privileged authority. Native admission must bind it to
the protected service transaction. A candidate Desktop must acknowledge an isolated
`update-validation` mode before Doctor and commit. This mode and the production
adapters are not yet wired; ordinary app-only updates do not call this coordinator.

The native migration coordinator now requires `AuthorizeCommit` before moving from
ReadyForAppCommit to Committed. Target app selection alone no longer authorizes that
transition. Existing fake-test admission is explicit; a missing production adapter
fails closed. No installed service or workstream-1 backup implementation was changed.

## Shared component Repair (4)

Setup supports `/REPAIR`, passed to `setup-entry.mjs` as `--repair`. It verifies the
already published installation against that Setup's inventory, then uses the same
`ensureSetupService` primitive as fresh installation and runs the shared core Doctor.
Service-only elevation remains inside the existing install adapter. Silent Repair
does not enable service installation implicitly. Repair records outcomes in the
existing Setup evidence folder and does not reset project registrations/workspaces.

This currently repairs an absent service for an intact matching Setup installation.
It refuses corrupt application payloads and conflicting existing services. Repair
after an app update, authenticated app-file restoration and the final Desktop Repair
UI remain to be integrated. This is not a replacement for Workspace
Repair, which has a different scope.

Setup also supports `/ADOPT` (`--adopt-projects`). After service validation it plans
all existing project tool-binding transitions using the core's adoption API, refuses
to begin when any plan is blocked, and applies each ready plan with its project digest.
Each attempt records the plan and completed IDs. A concurrent registry change causes
the affected transition to fail without rolling an entire registry backward. The next
attempt skips projects already adopted. No project is re-registered or copied. This
uses existing registry entries; discovery/import of arbitrary ZIP folders and final
UI presentation remain separate integration work.

## Distribution tooling (5)

- `pnpm sign:release-manifest <release.json> <private.pem> <approved-public.pem> <new-signature-path>`
  signs exact manifest bytes using the existing domain-separated Ed25519 format and
  verifies against the separately supplied approved public key before writing. It
  neither generates nor outputs private keys and refuses to overwrite output.
- `pnpm prepare:distribution <config.json>` consumes already signed Setup/application
  artifacts. Config fields are `manifestPath`, `signaturePath`, `trustedPublicKeys`
  (public PEM strings), `applicationPath`, `setupPath`, `publisherThumbprint`, and
  `outputRoot`. Use absolute paths. Private keys do not belong in this config.
- The tool authenticates the release, hashes the ZIP, copies to a new review folder,
  verifies Setup Authenticode publisher/timestamp and PE product/version, rehashes
  copied artifacts, and emits `distribution.json` plus a local WinGet YAML manifest.
  The receipt explicitly says qualification pending and publication disallowed.
- Setup now carries product/version resources needed for that check. The build is
  still a preview; this does not relabel it as a finished production installer.

Signing order remains: sign native/Electron payloads, rebuild inventories/archive,
sign final Setup, sign the final release metadata, then prepare distribution. Real
Authenticode signing-provider integration, production trust configuration, release
packaging automation and the designated target service build remain outstanding.
No artifacts were signed, published, submitted to WinGet or uploaded in this change.

WinGet output uses the official singleton 1.6.0 schema, Windows 11 x64, interactive
per-user installation and Git.Git dependency. UpgradeBehavior is deny until Setup
upgrade composition is implemented; it must not uninstall an earlier installation.
The local manifest/install check remains gate 16, not a new gate.

## Fixed acceptance reporting (6)

`pnpm report:acceptance <input.json> <new-output.json>` aggregates exactly these IDs:

`fresh-setup`, `git-uac`, `zip-adoption`, `discovery-download`, `consecutive-updates`,
`service-migration`, `workspace-preservation`, `app-rollback`, `service-rollback`,
`drain-duplicates`, `compatibility-floors`, `artifact-integrity`, `capacity-locks`,
`repair`, `interruption-matrix`, `signed-setup-winget`.

Input contains `schemaVersion: 1`, `candidate: { setupSha256, manifestSha256 }`, and
`gates`. Every gate has `id`, `status` and an `evidence` array of references. Allowed
statuses are pending, partial, passed, failed, blocked. A passed gate additionally
needs `scope: "final"` and the identical `candidate` binding. Earlier console/fixture
evidence can remain partial; it is not discarded or promoted automatically. The
tool reports counts and readiness, but explicitly does not verify evidence contents
and never executes tests. It refuses an existing output report.

## Deferred checks and remaining integration

Only formatting, JavaScript syntax and ESLint checks were run for this change.
New native commit refusal coverage was written but not executed. Defer combined
coordinator interruption/commit/rollback tests, Repair cancellation and Doctor tests,
distribution signature/hash refusal tests, NSIS compilation, and final VM/WinGet
qualification until the user resumes verification. No new acceptance scope is added.

Production completion still requires protected SCM/mount/boot adapters (2),
combined UI/worker wiring (3), authenticated app Repair and ZIP adoption
(4), the complete signed Setup flow (5), and one integrated qualification bundle (6).

Reference: [Microsoft WinGet singleton schema 1.6.0](https://raw.githubusercontent.com/microsoft/winget-cli/master/schemas/JSON/manifests/v1.6.0/manifest.singleton.1.6.0.json).

## Isolated Desktop and combined admission follow-up

The packaged Desktop now accepts `--honeybee-update-validation=<identitySha256>`.
It allocates a separate temporary Electron user profile before the single-instance
lock, keeps its window hidden, blocks renderer IPC, and reports readiness only
after the renderer app shell is present. Its authenticated session includes
`mode: update-validation` and the combined transaction identity. Ordinary restart
readiness explicitly excludes these sessions. Temporary validation profiles are
currently retained; a bounded retention policy remains to be implemented.

The session transport can locate, start, wait for, and request shutdown of exactly
the matching validation instance. Candidate authorization and process dispatch
remain explicit adapters. Shutdown acknowledgment is not process-exit evidence:
rollback still requires exclusive activity before restoring either component.
After protected paired commit the coordinator requests validation shutdown and
ordinary target restart. Restart failure is recorded in the result without
silently reversing an already committed machine decision.

Launcher and managed Desktop/CLI activity admission now validate the bounded,
hash-chained combined journal and refuse ordinary work while a transaction is
pending. Only the matching validation Desktop can enter AppSelected, DesktopReady
or Committing. The journal provides a user-level execution gate, never authority
to perform privileged service operations. The existing read-only direct CLI
Doctor bypass is unchanged. Automatic combined recovery dispatch is not wired;
pending combined state currently requires the coordinator recovery path.

Fresh combined transactions must authenticate both complete application payloads,
check their packaged combined-client capability markers, pin the Launcher hash,
and query its capabilities before creating the transaction journal or changing
the service. Unsupported clients require a Setup/bootstrapper upgrade. Existing
transactions skip fresh client admission so a damaged target can still reach
protected rollback; every attempt still requires the protected `admit` adapter.
Source and target directories and the trusted Launcher digest are supplied in
`options.clients`; `hooks.verifyRelease` must authenticate a complete payload.

This follow-up passed ESLint, core/Desktop TypeScript compilation, and Launcher
Go compilation (`-buildvcs=false`, because sandbox Git ownership prevented VCS
stamping). No regression suite, packaging execution, service mutation, VM run or
manual qualification was performed. Runtime readiness, crash/duplicate-session
behavior and recovery integration remain deferred within the existing gates.
