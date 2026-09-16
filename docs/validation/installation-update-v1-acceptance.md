# Installation and update v1: fixed acceptance contract

Approved by the user on 2026-09-13. This is the complete v1 acceptance scope,
not a growing list of suggested qualifications. Do not add gates without a new
user decision. Reuse recorded passes; rerun only cases affected by changed code.
Deliver one final integrated VM bundle after the remaining implementation is ready.

## Approved unsigned beta exception (2026-09-14)

The user approved a public GitHub prerelease with Windows Authenticode signing
deferred. This is an explicit exception for that part of gate 16 only. The release
must use `releaseMode: "unsigned-beta"`, the beta channel and a beta version; release
manifest Ed25519 authentication and all integrity checks remain mandatory.

Gates 01–15 still require coverage. Reuse unaffected recorded evidence, run tests
for changed code, then deliver one final integrated VM bundle. A failed case causes
only that case and its affected dependencies to run again. Do not add a gate or a
new per-feature manual bundle. Existing reports are not silently relabeled as
qualification of different artifacts.

Gate 16 remains `partial` with `authenticode: "deferred"`, `wingetLocal: "passed"`,
`scope: "final"` and final candidate hashes/evidence after its non-signing work
passes. The aggregate `ready` remains false until all 16 gates pass; the separate
`unsignedBetaReady` decision permits the specifically approved beta publication
only after gates 01–15 pass and the remainder of gate 16 is covered. It never
permits a stable release or a failed/unknown Authenticode signature disguised as
an unsigned artifact. WinGet external submission remains excluded.

## Acceptance ledger

`Partial` means existing evidence is accepted but does not cover the entire final
behavior. It is not an instruction to repeat the earlier fixture scenario.
Guest console reports remain valid attributed evidence; exporting full logs is not
a new acceptance gate. No public release readiness is claimed by this ledger.

| ID  | Fixed gate                                                             | Current evidence and remaining work                                                                                                                                                                                                                                                                                                   |
| --- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 01  | Fresh Setup, app/service health, real Desktop launch                   | Partial: ADR-038–041, 067. Qualify final signed candidate's complete UI path.                                                                                                                                                                                                                                                         |
| 02  | Missing Git; UAC cancellation and retry                                | Partial: existing prerequisite/service tests and QA. Final UI integration remains.                                                                                                                                                                                                                                                    |
| 03  | ZIP adoption with preserved projects and stable paths                  | Partial: ADR-035–037. Registered-project transition remains.                                                                                                                                                                                                                                                                          |
| 04  | GitHub update discovery, download progress, cancel and retry           | Partial: ADR-070 authenticated discovery/staging; ADR-071/072 Desktop check/download/progress/cancel UI. Production trust and final integration remain.                                                                                                                                                                               |
| 05  | Two consecutive app updates with continuing recovery support           | Partial: ADR-060 app transition; ADR-073 authenticated inactive preparation; ADR-074 independent preparation worker. ADR-075 Desktop preparation dispatch. ADR-076 signed continuing source approval. ADR-077 app-only activation handoff; ADR-078 restarted Desktop outcome display. Final consecutive-update qualification remains. |
| 06  | Supported real service-version migration                               | Partial: ADR-079 coordinator; ADR-080/081 reserved-volume ordering, exclusive backup verification and private maintenance factory. Coherent backup, real SCM adapters and application integration remain.                                                                                                                             |
| 07  | Registered project and populated Workspace preservation                | Remaining: one fixed disposable Unity project dataset.                                                                                                                                                                                                                                                                                |
| 08  | App health/start failure rollback                                      | Partial: ADR-060, 064, 068. Reuse primitives in final UI.                                                                                                                                                                                                                                                                             |
| 09  | Service replacement/health failure rollback                            | Partial: ADR-079/080 coordinator tests, pre-replacement resume and terminal application-selection refusal. Real service rollback adapters and qualification remain.                                                                                                                                                                   |
| 10  | Work drain, terminal cancellation and duplicate updates                | Partial: ADR-055–060. Final UI behavior remains.                                                                                                                                                                                                                                                                                      |
| 11  | Both-direction incompatible components and source floor refusal        | Partial: existing manifest/preflight/Doctor gates. Service integration remains.                                                                                                                                                                                                                                                       |
| 12  | Signature/hash/truncation/archive path refusal                         | Partial: staging/extraction checks and ADR-070 signature verification. Production trust and UI binding remain.                                                                                                                                                                                                                        |
| 13  | Insufficient disk before/during writes and locked files                | Partial: fail-safe publication; ADR-066 host lock diagnosis; ADR-070 download capacity admission. Extraction/service capacity and final integration remain.                                                                                                                                                                           |
| 14  | Repair app/service components through shared primitives                | Remaining: final Repair composition without project reset.                                                                                                                                                                                                                                                                            |
| 15  | Fixed interruption/restart matrix below                                | Partial: ADR-064, 065, 068, 069. Preserve these passes; qualify changed consecutive-update/service paths.                                                                                                                                                                                                                             |
| 16  | Signed final Setup and UI journey, WinGet local manifest/install check | Remaining: production trust inputs, distribution assembly and final integrated candidate.                                                                                                                                                                                                                                             |

## Fixed environment and data

Windows 11 x64, NTFS, per-user app and system service; the existing QA VM is the
baseline. Use one disposable Unity test project with a registered project, real
Library-backed Workspace, committed content, dirty tracked content and an untracked
file. Include a Korean/space-containing path. Compare project ID/path, branches,
HEAD, Git status, source bytes and Workspace binding across update/migration/rollback.
Library regeneration is permissible; source/user-edit loss is not.

## Fixed interruption matrix

- Process termination: app candidate prepared; app pointer switched; app validation
  finished before commit; service backup finished; old service stopped; new service
  placed; new service validated before app commit. Seven points total.
- Guest Windows restart: app pointer switched; new service placed. Two points.
- Guest forced power-off: new service placed before validation. One point; not a
  physical-disk failure guarantee.

## Delivery and stopping rule

Implement first, run related automated checks locally, then bind final Setup, app,
service, manifest hashes and supported migration pair into one QA specification.
No new per-feature manual VM bundles. Preserve result/log/hash/rollback evidence,
check disk space before each case, and remove only redundant generated payloads
after preserving evidence and confirming they are no longer recovery inputs.

For full signed-release qualification, finish when the 16 gates and change-related automated checks pass, with no unresolved
data-loss, security or unusable-installation defect, and the result table is recorded.
A failed in-scope gate remains incomplete; fix and rerun that case and its affected
dependencies, not the whole matrix. Missing signing credentials block production
distribution, not unrelated development. The explicit unsigned beta exception above
supersedes the signing requirement for this prerelease only; no other gate is waived.

Excluded: ARM64, Windows 10, other filesystems, simultaneous Windows users, every
historical ZIP/Unity version, large-project/load/endurance matrices, power loss at
every checkpoint, Chocolatey/Scoop, and external WinGet submission/review waiting.
