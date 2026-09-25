# Unified release verification

Docker owns portable checks. GitHub Actions owns Windows automation. A pinned
Windows 11 NTFS environment (including an isolated physical-host fixture) owns
actual installation, service and VHDX evidence. A container pass or Windows
Server CI pass is not Windows 11 native acceptance. Publishing remains a
separate, explicitly requested operation. The VM procedure below is historical
and must not be used to recreate the retired beta.36 VM.

## Change-scoped acceptance policy

Keep all sixteen gate IDs as the review ledger; do not rerun every interactive
journey. Compare the frozen source against the accepted baseline. An affected
behavior needs exact-candidate evidence; an unchanged behavior may reuse a
hashed, reviewed baseline record. Unclassified executable changes block
qualification until mapped. Every candidate still needs clean source, current
Docker/Windows automation, frozen distribution integrity, one actual
Setup/update/launch/Doctor observation, no pending native transaction and
explicit publication approval. A passing old receipt is never relabeled as
having run against new bytes.

For beta.36 the targeted changed behaviors are storage commit/recovery
(service migration, workspace preservation, drain/duplicates, capacity/locks,
interruption matrix), component compatibility/packaging (compatibility floors,
artifact integrity, Setup/WinGet), and public delivery (discovery/download,
artifact integrity, Setup/WinGet). The other journeys—fresh Setup prerequisite,
Git/UAC, ZIP adoption, consecutive updates, app rollback, service rollback and
Repair—can use the beta.35 review plus the exact beta.36 installation/update
smoke where relevant. A gate with changed and unchanged subcases uses current
evidence for the changed subcase and explicitly cites historical evidence for
the unchanged subcases. Parent-commit response loss, stalled progress, restart
and mismatched identity are verified by deterministic injected tests plus a
real long-running normal commit; no forced production-service interruption is
required.

The beta.35 accepted ledger predates `sourceCommit`. Do not edit it to add one.
For an unaffected gate's `reuse`, record the historical `candidate`, a hashed
`original` ledger, and a hashed `baseline` provenance JSON with
`schemaVersion:1`, `sourceCommit` equal to the plan baseline, matching
`candidate`, `acceptanceSha256`, nonempty `reviewedBy` and `reason`, and a
hashed `releaseCompletion` attachment whose completed candidate matches.
If this chain cannot be verified, the gate stays blocked until focused evidence
exists. An affected composite gate may cite unchanged historical subcases only
when `gate.delta` contains the current plan `source`, `candidate`, and a
nonempty `evidence` list also present in the gate's evidence. Passed or
partial current-candidate gates additionally need `attachments: [{path, sha256}]`;
the verifier reads and hashes each real file. An affected gate
cannot be passed using only `reuse`.

Policy-only source changes may carry native evidence forward only when the
newly frozen Setup and manifest hashes remain identical. Set
`sourceEquivalence: {commit, inventorySha256, distributionDirectory}` in the
new config to the original tested source and the new frozen distribution under
`output/`. The planner verifies Setup, manifest and application ZIP hashes
and that every intervening tracked change is under `scripts/qualification/`
or `docs/`; the old native receipt
keeps its original source and candidate. Docker and Windows receipts must be
regenerated for the new policy source. If an artifact hash differs, omit
`sourceEquivalence` and perform focused current-candidate qualification.

After the reviewed receipts and final acceptance JSON exist, import them in one
non-mutating-to-host pass into a fresh output directory:

```powershell
node scripts/qualification/compose-beta36-native.mjs output/verification-unification-20260920/beta36-native-aggregate-input.json output/verification-unification-20260920/beta36-native-delta-receipt.json
node scripts/qualification/release-delta.mjs output/candidate.json output/new-release-run --docker output/docker.json --windows output/windows.json --native output/native.json --acceptance output/acceptance.json
```

The beta.36 composer reads existing exact-source host/CI evidence and writes a
small native receipt. It explicitly does not claim physical-host fault injection;
the changed failure paths are covered by the named deterministic Windows tests.
The one-pass importer writes only the run/report under `output/`; it does not run Setup,
change the service/store, delete evidence or publish. Gate 04's real public URL
and gate 16's local WinGet install are checked after separately approved public
delivery, in a new final report. The unsigned-beta policy defers Authenticode
only, never delivery or missing tests.

## Common entry point

Create a configuration outside tracked source, for example `output/candidate.json`:

```json
{
  "schemaVersion": 1,
  "version": "0.1.0-beta.36",
  "sourceCommit": "<full candidate commit>",
  "baselineRef": "v0.1.0-beta.35",
  "releaseMode": "unsigned-beta",
  "candidate": {
    "setupSha256": "<SHA-256 of frozen HoneyBeeSetup.exe>",
    "manifestSha256": "<SHA-256 of frozen release.json>"
  },
  "requiredRegressions": ["issue46-large-cache"]
}
```

The version is an example, not a reservation or permission to publish. Keep the
issue46 regression until its actual native qualification is complete. A storage
change also requires `native-commit-heartbeat` automatically. `candidate` may be
omitted for development planning; publication then remains blocked. The checkout
must descend from beta.35. A dirty checkout can be tested, but cannot qualify a
public candidate.
`releaseMode` defaults to `signed`. Choose `unsigned-beta` only under the existing
approved beta policy; it permits only the Authenticode deferral in gate sixteen,
not missing WinGet, integrity, or other acceptance evidence.

```powershell
pnpm release:verify -- plan output/candidate.json output/verification-candidate
pnpm release:verify -- run output/candidate.json output/verification-candidate --lane docker
pnpm release:verify -- run output/candidate.json output/verification-candidate --lane windows --import output/windows-quality/windows.json
pnpm release:verify -- run output/candidate.json output/verification-candidate --lane native --import output/native-export/native.json
pnpm release:verify -- report output/candidate.json output/verification-candidate --acceptance output/final-acceptance.json
```

Exit 1 on `run`/`report` can mean another required lane is still missing: read
`report.json`, rather than automatically rerunning a successful lane. Failed
receipts are archived before replacement; successful receipts cannot be replaced
within the same run. Source/configuration changes require a new plan. An abandoned
`run.lock` requires checking the owning work has stopped before manual removal.

Docker may also run independently with `node tests/docker/run.mjs`; the old
`tests/docker/run-wsl.ps1` is a compatibility wrapper. Linux CI uses the same Node
runner, Dockerfile, fixed dependencies and stage commands. Build-time downloads
are allowed; test containers are non-root, offline, unprivileged and limited to
4 GiB / 2 CPUs / 512 PIDs. No host source, credentials or Docker socket is mounted.

## Coverage and evidence

- The source inventory normalizes CRLF for identity across Windows/Linux checkouts;
  attachment hashes always describe the actual unmodified bytes.
- Unknown test locations and new PowerShell test suites require classification.
  The Windows lane remains a superset during migration, including the existing
  `pnpm verify`, packaging and smoke checks. Do not remove it merely to save CI time.
- The shared suite records per-test passes and skips. Explicit Windows skips are
  assigned to Windows; real Windows VHDX integration cases are assigned to the native lane.
  Upstream Unix-only CoW exclusions are recorded as outside the Windows product's
  scope, not as passes. Unknown skips and empty results fail coverage admission.
- Retired-machine-specific diagnostic probes are explicitly recorded as historical
  diagnostics, not rerun against another machine by changing their safety pins.
- Windows build-tag files are recorded by source and Go platform inventories.
  The Windows suite compiles/tests the pinned, patched upstream and all three local
  Go modules, including Windows-only tests. A Linux `no test files` result proves
  nothing about SCM.
- The final report resolves deferred test IDs against actual passes in their owning
  lane. Matching test names alone in an unexecuted plan are not evidence.

Lane receipt schema version 1 contains `lane`, `source` (`commit`,
`inventorySha256` from `plan.json`), `status`, `environment`, `completedAt`,
`unexpectedSkips`, `coverage` and hashed `attachments`. Attachment paths are
relative to the receipt or absolute; export the original logs together with the
receipt, not just the JSON summary. Docker additionally records `imageDigest`.

The native operator records a receipt only after the selected real scenarios:
`candidate` must match the frozen hashes; `updateLaunchPassed` must be true;
`pendingTransactions` must be zero; `regressions` lists completed regression IDs;
`coverage.passed` lists deferred test IDs actually exercised. Include the
physical host or VM identity, OS, filesystem and component identities in
`environment`. Never turn a simulator
or a small-cache pass into a large-cache pass. Missing native cases remain blocked;
the common runner imports evidence and does not fabricate or launch destructive
fault scenarios automatically.

Windows CI also supplies `native-tests/manifest.json` and small precompiled Go
test executables; the selected Windows 11 native environment needs no Go/Node
build toolchain. Verify each executable's
manifest SHA-256 and source identity before running it. Run only named cases with
`-test.v -test.run '^CaseName$'`, record the complete output, and require the named
`--- PASS` (a zero exit containing `--- SKIP` is not success):

| Case                                     | Requirement                                                                                                 |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `TestExternalBeeNativeLifecycle`         | Elevated native environment; `HONEYBEE_BEE_NATIVE_ROOT` points to a new, nonexistent QA path                |
| `TestInstalledUserCanWriteMountedParent` | Original non-elevated user and isolated installed candidate broker; `TESTPLAY_VHDX_INSTALLED_USER_ACCESS=1` |
| `TestDifferencingChildGeometry`          | Native NTFS; `UNITY_WORKSPACE_STORAGE_GEOMETRY_TEST=1`                                                      |
| `TestNativeChildGeometry`                | Native NTFS; `HONEYBEE_VHDX_GEOMETRY_TEST=1`                                                                |

The manifest contains their exact package-qualified IDs for `coverage.passed`.
These small checks do not replace Setup/update/launch or issue46 large-cache
qualification. Preserve fixtures on failure and inspect transaction status before
any retry. Dedicated native artifacts are qualification-only, never public assets.

The sixteen gate IDs remain fixed. The change classifier selects affected
behaviors and blocks unknown executable paths. Reuse includes `reason`,
`environment`, the original `candidate` and `original: {path, sha256}`.
Historical ledgers without `sourceCommit` require the separately hashed
`baseline` provenance above. Keep the original candidate identity intact.
The current conclusion is a reviewed attribution, not a claim that old
binaries were retested.

Add `verificationReportPath` to the existing publish review configuration. New
publications require the unified report, re-read its attachments and receipts and
check its source/candidate immediately before publication. Existing beta.32 and
beta.35 delivery exceptions are not extended to new versions. Manifest signature,
distribution integrity and the fixed acceptance checks remain independent gates.

## Historical bounded VM lifecycle (not active for beta.36)

### beta.36 conditional public delivery (approved 2026-09-20)

The user approved keeping the existing VM budget and withholding publication if
required native regression cannot fit. They also approved publishing beta.36 for
delivery verification only after all other required checks pass, followed by
withdrawal on failed public delivery. This is not approval for another version.

After freezing artifacts, create a separate operator approval JSON with
`schemaVersion: 1`, `id: "beta36-public-delivery-20260920"`,
`version: "0.1.0-beta.36"`, `sourceCommit`, `setupSha256`, `manifestSha256`, and
`wingetManifestSha256`. Do not put candidate hashes back into source and rebuild:
the external record avoids that circular identity. In the distribution review
configuration pin its absolute `deliveryApprovalPath`, `deliveryApprovalSha256`,
the same `deliveryApproval` ID and `releaseCommit`. These are reviewed operator
inputs, not authorization supplied by downloaded artifacts.

Use `releaseMode: "unsigned-beta"` and bind `verificationReportPath` to the final
source/candidate. `publish-for-verification` re-evaluates every lane, deferred test,
native regression, attachment and reuse record before publication and immediately
before the GitHub mutation. The only permitted report blocker is the fixed final
acceptance check: gate 04 and gate 16 must have passed prepublication evidence and
only their public delivery portions may remain pending. The ordinary report stays
`ready: false`; this does not grant ordinary publication or release completion.

The release includes the pinned WinGet YAML. Disclose both
`Windows Authenticode: not signed` and `Public delivery verification pending`.
After real Desktop/public download and local WinGet success, produce a new final
verification run with the same source/candidate, import the existing immutable
lane receipts, and supply the final acceptance record. Do not overwrite an
existing run's acceptance snapshot. Invoke `complete-public-beta.mjs` with that
final report and notes without the pending-delivery statement. It rechecks the
report and anonymous asset hashes before declaring completion. Validation failure
after identifying the pinned public release attempts to return it to draft and
records whether withdrawal succeeded. Never replace assets under the same tag.

The three small native checks completed on 2026-09-20 remain partial evidence for
source inventory `02f3537f51ec9a0036d0d888839b4f6dc941c5ab1c4ea1b21d9b2f71ae7563f7`.
They are not evidence for these subsequent release-policy changes, installed-user
access, or the actual large-cache/heartbeat regression. The lifecycle wall-clock
discrepancy is unresolved and must not be used as a performance measurement.

Reuse the existing VM; do not provision a second VM or install build toolchains in
it. Keep one standalone dynamic 64 GiB VHDX, no automatic checkpoints or differencing
chains, and a 40 GiB budget for the entire VM directory. Keep needed runtime tools,
the current candidate, the previous good package and a small deterministic dataset.
Keep the previous installation until update/rollback checks finish.

`scripts/qualification/release-vm.ps1` takes a pin with `schemaVersion: 1`, `vmId`
and an absolute `vmRoot` below repository `output/`. It never creates, grows or
automatically resumes a VM:

```powershell
# Elevated host PowerShell; Inspect is read-only.
./scripts/qualification/release-vm.ps1 -PinPath output/vm-pin.json -Mode Inspect
./scripts/qualification/release-vm.ps1 -PinPath output/vm-pin.json -Mode Admit -GuestCapacityPath output/guest-capacity.json -ExpectedGrowthBytes 1073741824
./scripts/qualification/release-vm.ps1 -PinPath output/vm-pin.json -Mode Watch
# After terminal success and verified export, using a fresh native receipt:
./scripts/qualification/release-vm.ps1 -PinPath output/vm-pin.json -Mode Finish -ExportReceipt output/native-export/native.json
```

Watch samples every five seconds and pauses at 38 GiB or host free space at/below
22 GiB. It is not a filesystem quota. Reestablish the monitor before every native
operation. Use `capacity(snapshot, expectedGrowthBytes)` for admission: preserve
20 GiB guest service floor plus 2 GiB child reserve and include peak temporary
growth, not only final VHDX size. A case that cannot fit stays blocked; do not lower
the floor or enlarge the disk automatically. Finish verifies exported hashes and
uses graceful shutdown only. Unknown commit outcomes prohibit finish/cleanup.
Admit also requires `computerName` in the pin and a less-than-five-minute-old guest
observation with `computer`, `filesystem`, `guestFreeBytes`, and UTC `at` fields.
Supply the scenario's estimated peak growth, not the illustrative 1 GiB above.

## Retention and cleanup

- Successful native runs may provide `cleanupManifest` entries in configuration:
  `{path, retainedCopy, sha256}`. Both paths must be regular files under the run;
  only `transport/` or `context/` duplicates are removable, and the retained copy
  must be outside those temporary directories. Cleanup requires exclusive terminal
  success, verifies both hashes, and records intent and completion. No recursive
  deletion, symlink/junction traversal, disk deletion or store recovery is allowed.
- Preserve current/previous good packages and reports. Existing archives, failed
  or uncertain transactions, quarantine, active versions and recovery inputs never
  expire automatically. Old package retirement is a separate reviewed action.
- A dedicated `honeybee-verification` BuildKit builder targets 8 GB cache with
  20 GB free-space policy. It does not alter the shared/default builder's settings.
  Ephemeral GitHub-hosted Linux runners use a separate 2 GiB free-space guard and
  a 2 GB builder free-space policy; this never lowers the physical host or VM floor.
  Successful test images retain the current and previous successful image; older
  runner-owned successful tags are removed without force when no container uses
  them. Failed-run images and images outside this runner's history are preserved.
  CI evidence upload retains logs/manifests for fourteen days; retain release
  evidence outside that expiring cache before relying on it for future reuse.
- File deletion does not guarantee the WSL/VM VHDX shrinks on the host. Record guest
  free space and host disk usage separately. Offline compaction is separate,
  explicitly reviewed maintenance, never an automatic part of a test run.

## Current rollout

Windows metadata replay fixtures establish auto-inheritance before capturing
their backup inventory. This makes positive tests independent of a runner's
legacy inherited ACL defaults; it does not normalize production backups.
Restoration still requires exact security-descriptor readback. If Windows adds
the auto-inherited control flag to a recorded legacy descriptor during replay,
restoration fails closed rather than claiming exact recovery. Separate negative
tests cover that mismatch and changed access permissions; protected ACL replay
is also tested. See Microsoft's
[automatic propagation rules](https://learn.microsoft.com/en-us/windows/win32/secauthz/automatic-propagation-of-inheritable-aces).

The first integrated report for issue46 is expected to remain blocked until its
Windows CI and real native evidence exist for the same final source/candidate.
The old Docker pass is historical evidence, not a pass for newly changed code.
No VM expansion, forced shutdown, evidence retirement or public release is part
of adopting this workflow.
