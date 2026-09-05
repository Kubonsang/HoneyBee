# Existing-install validation on the current Windows PC

This is the alternative evaluation route approved for Beta 5 when a separate Windows machine is
unavailable. It supplements the strict [zero-baseline dogfood](windows-cli-beta-dogfood.md); it does
not change that script's acceptance conditions. PR #39 was squash-merged as `246226e`.

## Scope and release decision

Use the exact CLI/Desktop archives from the successful final-head CI run. The locally retained
`artifacts/beta5-ci-46fca73/` evidence includes checksums and both the PR head and tested merge
checkout. Do not rebuild the apps for this procedure.

| Gate                                                        | Current-PC route                                                                                                                                              |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source, package, Desktop IPC/UI, PTY                        | Final candidate's existing automated evidence                                                                                                                 |
| Workspace isolation and lifecycle                           | Four disposable worktrees; two concurrent batch Editors; authored marker isolation; repair; dirty/open-handle refusal; attach/remove; branch preservation     |
| Preservation of existing data                               | Original registry hash; installed receipt hash; exact original lease/retained hashes; child file identity, length and modification time; no unknown child IDs |
| Reboot recovery                                             | Save a test Workspace, reboot at a convenient time, resume against both Windows and storage boot identities                                                   |
| Fresh Windows installation / Beta 3 service upgrade         | **Unverified**; unavailable environment, no pass inferred                                                                                                     |
| Interactive GUI Editor / external Codex and Claude sessions | **Unverified by this automation**; batch Editors and scripted Git commits are recorded as such                                                                |

After the functional and deferred reboot phases pass, the evidence can support a **limited Beta 5
evaluation for existing installations with the matching hb8 service**. The release description must
retain the limitations above. Broad installation/upgrade claims still require dedicated-environment
validation. This procedure neither publishes a release nor requests a reboot.

## Preconditions

- Use a normal Windows user account that already passes packaged Doctor with the installed service.
- Close Unity and other tools using HoneyBee Workspaces for the duration of the test. The service
  must have no active, pending, quarantined or manual-recovery state. Existing retained children
  are allowed and must stay idle.
- Select a real Unity Git repository and an installed matching Editor. Only its committed HEAD is
  cloned; original uncommitted changes are left in place. The source must ignore generated Unity
  directories. The first import must leave the disposable clone clean; unexpected changes stop
  the test for inspection.
- Choose a **new, absent** run directory outside the source repository. The harness creates its own
  source clone, Workspace root, registry and evidence under that directory. Do not put that directory
  under a junction or symlink. Keep sufficient free space for the clone, Library and four child disks.
- Do not use or modify the shared service concurrently. Folder separation does not isolate the
  machine-wide storage broker; drift is an abort condition, not something the harness repairs.

## Run the functional checks

From the HoneyBee repository, with absolute paths adjusted for the machine:

```powershell
node scripts/dogfood/windows-shared-host.mjs run `
  --run-root C:\HoneyBeeValidation\beta5-run1 `
  --cli-dir C:\HoneyBeeValidation\packages\HoneyBee-cli-win32-x64 `
  --source C:\Repos\MyGame `
  --unity-command C:\Users\me\AppData\Local\Unity\bin\unity.exe
```

For a Unity project nested inside its Git repository, add `--unity-relative Game`. `--source` must
be the Git repository root. The CLI and Unity CLI must already be installed/extracted. No service
installation, package upgrade, license activation or machine reboot is performed.

The harness reads storage journals to enumerate exact lease and retained identities. It hashes the
journals instead of copying ownership tokens to evidence. It stops if status counts disagree with
the inventory, an unknown child appears, an original child changes, or the service restarts. Child
file metadata checks are not a byte-for-byte proof of unchanged VHDX contents; the test requires
idle original Workspaces and makes no calls targeting them. Normal unused parent-cache retention
and storage GC still follow the broker's existing policy; this is not a zero-baseline storage benchmark.

Success records `phase: functional-passed` in `shared-host-state.json` and removes the four test
Workspaces and attach probe through HoneyBee. Their Git branches remain in the disposable clone.
Unity outputs are retained next to the state file. Scripted marker commits are not labelled as
Codex/Claude sessions.

If a successful first Unity import changes the disposable clone, review its diff before doing
anything with storage. Commit only understood import normalization in that clone, retain the diff
as evidence, then use `resume-import --run-root <same directory>`. This is accepted only before a
project or Workspace has been created, after a successful Unity exit, with a clean clone descended
from the original source HEAD and unchanged original storage. It does not ignore dirty files in
Workspaces or replay a partly completed Workspace run.

`resume-checks --run-root <same directory>` can continue the post-Unity checks only when all four
recorded batch executions succeeded, all four authored commit records exist, junction repair passed,
and none of the test Workspaces has been removed. It rechecks ownership and preserved originals.
When Unity leaves a tracked file with identical normalized content but stale Git index metadata,
the harness refreshes the disposable index only after checking the full diff against HEAD and
absence of untracked files; the staged diff must remain empty. Real edits still stop the run.

## Defer the actual reboot

```powershell
node scripts/dogfood/windows-shared-host.mjs prepare-reboot --run-root C:\HoneyBeeValidation\beta5-run1
```

This creates one owned `reboot-probe`, tests open-handle refusal, commits an authored marker, and
saves the lease, authored and Library marker hashes, junction target, branch HEAD, registry hash
and both boot identities. Keep the run
directory and exact extracted package. Do not use the probe before resuming. Other retained
Workspaces must remain untouched if their original metadata is to remain a comparable baseline.

After a normal Windows reboot, run:

```powershell
node scripts/dogfood/windows-shared-host.mjs resume-reboot --run-root C:\HoneyBeeValidation\beta5-run1
```

Running this before an actual reboot must fail and leave the checkpoint pending. A service restart
alone is insufficient. After a reboot the harness checks preserved originals, repairs only its own
probe, checks the same lease and authored marker, runs Unity, removes the probe, and checks that
only the original children remain. It never invokes `Restart-Computer` or `shutdown`.

If post-reboot Unity succeeded but normal removal returned `workspace.in-use`, keep the checkpoint
and let the relevant tools finish. Use `finish-reboot --run-root <same directory>` to retry cleanup.
This requires the recorded successful post-reboot Unity result, a changed Windows/storage boot,
unchanged original inventory, the same test lease, branch HEAD, authored/Library hashes and junction
target. It uses normal removal and never bypasses the open-handle protection or repeats repair of an
already repaired Workspace.

## On failure

Stop and inspect `shared-host-state.json`, the original baseline and logs. The harness deliberately
does not perform broad automatic cleanup after an unexpected failure. Do not remove VHDX files,
registry entries or journals manually, and do not rerun `run` into the same directory.

For an interrupted test, first compare the original identities and the dedicated registry. Resolve
only the recorded test Workspace IDs using the same extracted CLI and `--data-root <run>\registry`.
Close its tools and inspect dirty work before normal `workspace remove`. Never run recursive folder
cleanup while the run contains a Library junction or retained child. A passing rerun must produce
new evidence; do not edit a failed result into a pass.

## 2026-09-05 current-PC result

- Exact CI candidate: `0.1.0-beta.5`, PR head `46fca73`, existing service hb8. The CLI storage host
  SHA-256 matches the installed receipt. The app package was not rebuilt during this validation.
- Functional route **passed** on a disposable committed clone of the registered Unity project,
  using Unity 6000.3.8f1. All four batch runs exited 0; pairs were launched together. Authored marker
  commits stayed on their own branches. Missing-junction repair, dirty refusal, repeated removal,
  branch preservation and existing-branch attach/removal passed.
- Five functional test Workspaces were removed through HoneyBee. The exact original child metadata
  and original registry hash matched the baseline afterward. Open-handle removal refusal also
  passed while preparing the reboot probe.
- The run resumed after a Git LFS clone-hook initialization conflict, reviewed first-import trailing
  whitespace normalization (recorded only in the disposable clone), and harness fixes for unchanged
  Git index metadata and stderr error JSON. Failed-attempt logs remain available; this is a completed
  phased run, not an uninterrupted fresh-install test.
- Current phase: **existing-install-validation-passed**. The user rebooted Windows; its boot time
  changed from `2026-09-05T07:15:30.5Z` to `2026-09-05T10:25:19.5Z`, and the storage boot identity
  also changed. The same lease, junction target, authored marker, Library marker and branch HEAD
  survived repair. Unity 6000.3.8f1 exited 0 after repair.
- The first immediate cleanup returned `workspace.in-use` and preserved the Workspace. Once no
  Unity processes remained, identity-checked normal removal and repeated removal succeeded via
  `finish-reboot`. No force removal or service change was used. The test registry is empty, the
  original retained child is unchanged, and active/pending/quarantined counts are zero. Final
  packaged Doctor passed **19 checks, zero warnings and zero failures**.
- All six test Workspaces, including the reboot probe, have been removed; their branches remain
  in the disposable clone. The earlier premature-resume rejection is retained as negative-test
  evidence. Release publication, fresh install and Beta 3 upgrade have not been performed.
- Evidence: `tmp/beta5-shared-host-20260905-b/shared-host-state.json`, redacted `*.unity.log`,
  `preservation-result.json`, and `output/beta4-release-validation/shared-host-*.log`. The guard tests
  cover original identity changes, unknown/missing children, malformed inventory, path overlap,
  pending state, real-boot requirements and Unity log credential redaction.

The current machine's checkpoint is complete. Do not rerun resume commands against it. Final
evidence is in `reboot-observed.json`, `final-doctor.json`, `shared-host-state.json` and
`preservation-result.json` under the recorded run directory. The exact original ZIPs are eligible
for the limited existing-hb8-install evaluation described above; general installation and upgrade
claims remain outside this evidence.
