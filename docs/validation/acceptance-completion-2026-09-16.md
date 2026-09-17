# beta.32 acceptance completion execution

## Fixed candidate and approved ordering

The existing beta.32 Setup (SHA-256
`8b4dc6b513e2a0190b1d429284070fbf1cc3df08e2877804fba6b22153a5b56e`)
and release manifest (`43fdd39e04c0d4a34bd5b0b92ead99e5044e2d41df82548621acd79741f2a9d3`)
remain unchanged. Gates 05/06/07/14 and the exact-candidate power-off recovery are
accepted and must not be rerun merely to regenerate a summary.

The user approved a temporary differencing VM and post-publication verification
of the actual public GitHub/WinGet route. All other gate requirements remain.
`publish-for-verification` is a distinct action, pinned to these two hashes and
version beta.32. It requires final passes for all other gates and recorded
prepublication coverage for gates 04/16. Neither remaining gate is marked passed
by this action. Ordinary `publish` retains the complete acceptance requirement.

Gate 04 records `prePublication: {status: "passed", evidence: [...]}` and
`publicDelivery: "pending"`; gate 16 records the same prepublication evidence,
`wingetManifestValidation: "passed"`, `wingetLocal: "pending"`, and
`authenticode: "deferred"`. Both retain partial status and final candidate binding.
The review configuration must explicitly supply
`deliveryApproval: "beta32-public-delivery-20260916"`.
Do not populate these fields until the referenced checks have actually passed.

After the actual Desktop/public download and WinGet install pass, record their
attributed evidence in the existing ledger: gate 04 passed, gate 16 partial with
WinGet passed and only signing deferred. `complete-public-beta.mjs` accepts the
review configuration and final release notes. It verifies anonymous downloads
without retaining another package copy, checks final readiness, and updates the
notes. A failure after identifying the pinned public release attempts withdrawal
to draft and records whether withdrawal succeeded. It does not claim downloaded
copies can be recalled. The completion command never promotes acceptance itself.

## Evidence disposition and bounded remaining execution

| Gate  | Existing coverage to retain                                                                                 | Remaining execution/review                                                                    |
| ----- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 01/02 | Setup service cancellation/unit paths                                                                       | Exact Setup, process-PATH Git absence, UAC cancellation/retry, actual Desktop in temporary VM |
| 03    | Core managed binding/adoption tests; installer adoption primitive                                           | Real compatible ZIP project adoption with dirty/untracked files and stable binding            |
| 04    | release-authentication and Desktop update-check tests; draft roundtrip hashes                               | Packaged UI integration, then public discovery/download/cancel/retry                          |
| 08    | Historical desktop rollback and restart-failure reports                                                     | Compare admission/lifecycle/runtime changes; only uncovered app failure cases                 |
| 09    | Native migration operation-failure tests and real interruption passes                                       | Bind actual adapter changes; service health-failure case if not covered                       |
| 10    | Desktop lifecycle/cancellation/activity tests                                                               | Real active-work cancellation and duplicate request UI                                        |
| 11    | stage-release source floor tests; core workspace-storage-update tests                                       | Explicit bidirectional component mapping against production manifest and binary lineage       |
| 12    | Ed25519 and stream damage tests, Go extractor path/digest/CRC tests, final draft hashes                     | Confirm native extractor identity as well as JS source match; map packaged UI binding         |
| 13    | Initial capacity refusal; restore metadata/directory injected disk-full tests; cold-backup busy-source test | Confirm extraction/write failure coverage and final native lineage; never fill host disk      |
| 15    | Six service reports, one exact-candidate power-off; older app reports                                       | Per-point impact comparison. Only affected/uncovered points from original ten                 |
| 16    | Exact manifest validation exit 0                                                                            | Actual public-URL local WinGet install; no external submission                                |

Native source lineage is not proven by the 199-file JS/TS audit. Do not promote
native-dependent gates solely on that report. Historical interrupted-service
results precede changes to handle opening, volume reservation and recovery; those
changes must be accounted for explicitly. There are no new interruption points.
The maximum unresolved interruption set is the original nine other points, not a
second power-off cycle. Existing app/service health failure cases are separate
gates 08/09, not new matrix points.

## Temporary environment and current execution

Source VM: `a4693938-ec51-4427-a453-1e44739d7db2`, unchanged.
Clean checkpoint: `02b6a046-98fd-45c6-910e-12dbce3d7469`.
Temporary VM: `HoneyBee-Acceptance-beta32`,
`ccc9250b-f335-483b-ae40-1323c39211f7`.
Its child references the checkpoint disk directly; no parent rename or full copy.
The Hyper-V cmdlet rejected the AVHDX suffix before creating a disk. The reviewed
retry used the documented V2 CreateVirtualDisk API with an explicit VHDX parent
type; the failure record is retained.

The administrator capacity watcher pauses only the temporary VM at 10 GiB
additional VM files or less than 12 GiB host free space. It expires after two days,
pausing a still-running VM. Guest initial admission remains 16 GiB. No checkpoint
merge/removal, original VM shutdown, or source data cleanup was performed.

Host records: `output/acceptance-completion-20260916/`.
Guest installer runner: `C:\HoneyBeeQA\acceptance-completion-20260916\acceptance-install-journey.ps1`.
It refuses the original VM by the guest integration VM name, runs unelevated,
pins the Setup hash, and requires an absent installation/store/service. It uses
process-only PATH isolation for unavailable Git, not uninstalling system Git.
It refuses automatic replay and writes exclusive per-phase records. User UI
confirmation is recorded separately from Doctor health.

The user reported successful beta.32 installation health, a running LocalSystem
service, Doctor exit 0 (12 passes, one no-project warning), and a usable Desktop
after manually invoking the stable launcher. The attributed host summary is
`output/acceptance-completion-20260916/reported-installed-observation.json`.
Original guest evidence remains in `Evidence-installed-observation-2cc217dbfe4648f188743dd33a12955e`.
This establishes current installed health and manual launch, not automatic Setup
launch or UAC cancellation. The earlier journey stopped because a service existed
after the cancellation step. Its reported exit code and successful health record
remain unreconciled; preserve both. No acceptance gate was promoted by this
observation. Do not repeat installation merely to collect the same health result.

The ZIP adoption runner is prepared in `scripts/qualification/acceptance-zip-adoption.ps1`
and `.mjs`. It admits only the empty temporary beta.32 installation, creates one
synthetic project and a real storage Workspace using compatible portable tool
paths, then invokes the unchanged Setup with `/ADOPT`. It requires the original
registry backup to match exactly, allows only the new managed binding in the
registry, and compares Git branches, HEAD, index, status and file hashes for both
worktrees. The service receipt and active pointer must remain unchanged. It does
not claim to qualify unsupported hb12 migration or actual Unity import.

Before transfer, the capacity monitor reported the temporary VM paused at
11,014,361,636 bytes with 23,962,415,104 host bytes free. The original approved
10 GiB cap paused the VM as designed. On September 17 the user explicitly
approved raising this temporary VM's cap to 14 GiB while retaining the 12 GiB
host floor. The original policy is retained in a `resume-14gib-*` evidence
directory. The updated watcher was started and remained alive before resuming
the pinned VM. Resume and transfer of the two adoption scripts succeeded;
the original VM was unchanged and no test was replayed. The adoption test is
completed according to the user's supplied result: portable binding adoption,
registry backup, source/Workspace preservation, unchanged service receipt and
Doctor readiness all passed. The attributed report is
`output/acceptance-completion-20260916/reported-zip-adoption.json`. Gate 03 is
reviewed as passed for the pinned candidate; the guest runner itself did not
promote acceptance. The ledger now has five passed and eleven partial gates.
This is not aggregate release approval.

## Remaining execution on September 17

Gate 11 subsequently passed exact-candidate compatibility/floor review; see
`beta32-admission-review.md`. Six gates are passed and ten remain partial.

Seven additional exact-native-binary checks passed in
`output/acceptance-completion-20260916/native-locks-OzChBP/result.json`: duplicate
update exclusion, EOF/termination lock release, shared-work drain with newcomer
exclusion, timeout/disconnected-owner recovery, destination non-overwrite, and
locked-archive refusal followed by successful retry. These support gates 10/13;
they are not Desktop UI or disk-full tests and do not independently complete
either gate. No installation, service, or VM state changed in these host tests.

The app recovery batch was delivered to the temporary VM's
`C:\HoneyBeeQA\acceptance-completion-20260916\app-recovery` directory. It uses the
already signed beta.33 QA media, preserves the adopted project, and checks only
the three app kill points, app-health rollback, and reboot-app-selected from the
original contract. It reuses authenticated preparation across cases, checks the
unchanged service receipt, and compares the complete registry/Git baseline after
recovery. Completed cases are skipped; failures require review. The last case
requests a normal VM reboot and the same runner resumes validation afterward.
No normal-update, Repair or power-off pass is repeated.

The fault worker now passes its already digest-verified activation job identity
to the activation API, as the ordinary Setup activation path does. This is a QA
runner fix; the published candidate bytes were not changed. Fourteen existing
matrix, preparation-reuse and polling tests passed. Bundle imports, PowerShell
syntax and lint passed. The transfer contains 77 files (217,194,490 bytes), with
no additional host copy of the large archive.

The user subsequently supplied the guest inspection recorded in
`output/acceptance-completion-20260916/reported-app-recovery.json`. All three app
kill cases and app-health rollback completed with automatic launcher rollback
and preservation. They must not be replayed. The remaining reboot case reached
app-selected at 15:28:49 UTC and rebooted at 15:29:44, inside its checkpoint hold
window. Source beta.32 Doctor then failed only `workspace.repair-required` for
`zip-preserved`; the other 19 checks passed, including the running storage
service. Automatic rollback stopped before restoring the pointer, which remains
beta.33 generation 2. This is a failed case, not a successful recovery or a
checkpoint timing failure. Publication remains blocked.

Code inspection confirms recovery requires source Doctor readiness before
pointer restoration. Workspace readiness also requires a valid Library junction
and an active broker lease; a running service alone is insufficient. An inactive
retained lease after reboot is a hypothesis, not yet established by the supplied
inspection. `inspect-reboot-workspace.ps1` collects the specific workspace's
registry, junction, lease and ownership identities and Git status without
running recovery, Doctor, repair or broker requests. A manual repair must not be
used to relabel this failed automatic recovery attempt as passed.

The follow-up guest connection inspection reports Git status exit 0 with the
expected modified and untracked entries, matching retained/owner identities,
and an existing Library junction targeting the recorded mount. The lease still
records boot session `system-process-01dd45e807882805` (14:31:15 UTC), preceding
the 15:29:44 reboot. This does not prove all file contents preserved or an active
broker session. See `reported-reboot-connection.json` for the attributed summary.
Dependency source inspection shows Broker.Recover preserves retained journals
without populating its new in-memory child session map; heartbeat rejects a
missing session with `lease-not-active`. This explains why journal state and
visible junctions alone cannot satisfy workspace readiness after service restart.

The working-tree fix adds reconnect-workspaces.mjs to the authenticated recovery
runtime. It runs inside admitted transaction health under exclusive activity,
only after Doctor reports exclusively workspace repair failures. It authenticates
the source tool selection, checks service compatibility and the complete managed
workspace identity set, then attaches only leases explicitly reported inactive.
Missing/non-ready leases, mismatched ownership/paths, evidence write errors and
lost locks stop recovery. It does not repair Git or create junctions or rewrite
the registry. Doctor must subsequently pass before pointer rollback.

Validation: Core typecheck/build and scoped lint passed; seven reconnect tests,
29 existing activation/health tests and six storage adapter tests passed. The
native-process tests initially encountered sandbox access denied and passed on
the same scoped rerun outside the sandbox. The fix has not been built into a new
Setup or installed in the VM. The original beta.32 candidate and its failed reboot
attempt remain unchanged; release acceptance is not promoted. A new candidate
and an affected recovery qualification are still required.

The beta.35 candidate is now packaged at
`output/reboot-fix-20260917/distributions/distribution-TYOtp7`. Setup SHA-256 is
`643a944173291018a9d2a357f7edf52874f874dfd644f01e9b1b60ace2c40c04`; signed release
manifest SHA-256 is `5d895f4e603c423ea99e3387e61f2e2fa02dd54a7f9436a9be7b68e8179c7df4`.
The signed beta.36 QA update uses manifest
`db87e1afae7985fee7fc4fdc6a0f68887d620a443f4db32954e7f05aa352da16`.
Neither is published or accepted. Existing production storage binaries were reused.

The user explicitly approved increasing the same temporary VM cap from 14 GiB
to 18 GiB. The original policy is retained in the `resume-18gib-*` evidence folder;
the replacement monitor is running with the unchanged 12 GiB host floor. No
original VM or test result was changed. New-build duplicate files were removed
only after hashing their retained completed-artifact counterparts; locked copies
were skipped. The cleanup record is `output/reboot-fix-20260917/duplicate-cleanup-result.json`.

Six files were delivered to the guest's `acceptance-completion-20260916/reboot-fix`
folder. `Prepare-Reboot-Fix.ps1` is a one-shot, explicitly manual fixture setup:
it captures the original Git/registry/service receipt baseline, archives only
deployment and update entries beneath `qualification-backup-beta32-reboot-failure`,
installs beta.35, reconnects retained leases and requires Doctor plus exact
preservation checks. Workspace data and original Matrix/Evidence remain in place.
This is necessary because ordinary upgrades preserve the initial bootstrapper.
The script is syntax checked but has not yet been executed in the guest; it
must not be presented as a successful fresh install or automatic recovery test.

The user subsequently reported `baselineReady:true`, `preserved:true`,
`testsRun:0`, `automaticRecoveryQualified:false`; this is recorded in
`output/reboot-fix-20260917/reported-baseline-ready.json`. The new runner uses
beta.35's inventoried runtime modules and authenticated beta.36 media, selects
only `reboot-app-selected`, retains a separate Matrix/Evidence directory, and
requires exact source pointer restoration, source Doctor readiness, unchanged
service receipt and the original project/Git/registry snapshot. Its wrapper and
module syntax/import checks passed. This is a new-candidate qualification; the
old beta.32 failure and four completed cases are preserved.

The user reported the beta.35 `reboot-app-selected` result as passed, with project
preservation and unchanged service receipt. The attributed report is
`output/reboot-fix-20260917/reported-reboot-pass.json`. The runner requires actual
launcher recovery to restore the exact source pointer, followed by source Doctor
readiness and original snapshot equality; no manual reconnect runs in this case.
This closes the observed app-reboot recovery defect for beta.35. It does not
retroactively pass beta.32, promote the complete interruption gate, or authorize
publication.

`output/reboot-fix-20260917/change-impact.json` compares the snapshotted beta.32
and beta.35 source trees. Desktop source and update modules are unchanged; the
CLI source differs only in its version constant. Production storage executable,
control companion and tool manifest are byte-identical. Runtime changes are the
strict recovery-only heartbeat option and retained-workspace reconnect before
retrying failed recovery health. Other source changes are release review and
publication orchestration, with their existing policy tests. Existing successes
retain their original candidate hashes; no completed guest case is replayed by
this review. Remaining fixed-gate gaps still include installer/UAC UI evidence,
download/drain UI, service-health rollback, capacity handling and local WinGet
delivery. The old ledger remains bound to beta.32 until a candidate-specific
reuse review is completed.
