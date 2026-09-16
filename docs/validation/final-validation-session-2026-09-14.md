# Final validation session — 2026-09-14

This executes the approved fixed 16-gate contract. It adds no acceptance gate.
Session evidence: `output/final-validation/session-20260914-132941/`.

## Confirmed preparation

### VHDX information fix packaged as beta.29 QA source / beta.30 candidate

Completed build `output/final-release-builds/build-7vWh9X/result.json` after
assisted rollback completion. Beta.29 is the instrumented QA baseline only
(`hb13.topology6.qa-baseline`); beta.30 is the unsigned beta distribution
candidate (`hb13`). Both application packages and NSIS installers built, and
release manifests were signed with the existing Ed25519 release key. Authenticode
remains explicitly deferred. Signed service-replacement manifests cover the
reviewed beta.22→29 baseline transition and beta.29→30 qualification pair.
No package was installed, transferred to the guest, published or qualified.

Fixed production native SHA-256:
`3894968f49bd42e94ac9517446ed4de6c55cc3b50eba4c3fa3e0a9d55dcb8a48`.
Fixed instrumented native SHA-256:
`87a63f220a15dfba698130e07263ccbf00e27ff4f7aa8abe091d02f91d5e6ab9`.
Build inputs: `output/vhd-info-release-20260916/native-build.json`.
Candidate tool-integrity tests passed (4). Existing runtime/launcher builds,
assembly and distribution signature/hash checks succeeded. The old failed
power-off attempt and assisted recovery evidence remain unchanged.

Next execution must first transition the populated beta.22 installation to the
fixed beta.29 QA baseline with preservation checks, then perform the affected
automatic recovery qualification against beta.30. This is necessary because
the immutable old runtime selects the source companion during rollback; changing
only a target worker does not replace that source code. The reviewed completion
helper is not a distributed update implementation. No acceptance scope was added.

### Power-off recovery remains incomplete (2026-09-16)

User-reported native migration `migration-edc558bd8b9b57ab01064bfb9a2fa68a`
reached `RolledBack`; application transaction
`95e90eedf1a6cc822b8f9dfcbe7f6cc01c5ca7bef870e936c7796e50699bd311`
remains `RollingBack` with source beta.22 selected. Recovery `combined-eVM0JM`
reported an application-admission sharing violation. Subsequent process/handle
inspection did not identify a holder; this does not establish who held it at failure.
A single later ordinary CLI invocation produced `combined-WuVIW3`, exit 1,
`Access is denied.` Thus a persistent admission lock is not established as the
cause. Neither owner PID reuse nor an ACL fault has been confirmed.

Service-session failures now include the request operation; four transport tests
pass. This source change does not modify the VM's pinned recovery runtime.
The narrowly scoped diagnostic in
`output/recovery-product-20260916/access-diagnostic/` authenticates the installed
runtime/coordinator and issues only native `lookup` and `status` for transaction
`9261c18c1372e589a2553209649ec9ac0794826754556efc4d54d910968d4c4b`.
It does not recover, replace, detach, change application selection, or replay QA.
It uses the existing elevated session (and its maintenance lock) to read protected
records. The full power-off qualification remains failed/incomplete.

The first access probe incorrectly expected `resolveCombinedCoordinator` to be
exported by the VM runtime; that was a diagnostic compatibility defect. Corrected
source-companion authentication, native lookup and status all succeeded, reporting
`RolledBack`, source selection, undecided pair decision, context pin
`4576069775e0f57b5accea1967a1986b784a3d32d9df3efe9fadaba18e785bc1`.
The VM runtime exports only activation, release authorization and combined
transaction execution; it differs from the host beta.22 assembly runtime.

A pinned incident-only native access probe was compiled in the isolated native
build tree. It reads the recorded owner, SCM/source binding and mount topology,
opens image/volume handles for inspection and closes them without locking,
dismounting, detaching, starting/stopping services or recovering journals. The
host invocation correctly skips because it is not the pinned VM; no guest result
or recovery pass is claimed. Diagnostic binary SHA-256:
`e3d1781fb53f9147b82cf3e8ef02c358137233809a4ed543700a80b4a734b8a6`.

Guest probe `Native-4eec093581d7402eab2ccedc5f781d37` confirmed every
step through child file identity, including original-owner-not-alive and SCM/source
validation. `query-child-loaded` failed with access denied. Source inspection and
Microsoft's OpenVirtualDisk contract identified that reopening a permanently
attached image requires DETACH access even for information queries. The info
helper previously requested GET_INFO alone. It now requests GET_INFO|DETACH with
RWDepth=0, does not call detach, and labels path-inspection, open and query failures.
This is a documented API contract fix; whether it resolves this guest incident
remains unverified. Focused maintenance tests passed locally. No installed payload
or release artifact was replaced. Probe v2 SHA-256:
`edf43e062db69a6ee702a5dcdec4b3b431df87d27c960239a3930e21ac78059e`.

Probe v2 failed in the guest at OpenVirtualDisk(GET_INFO|DETACH, RWDepth=0),
evidence `Native-b1717eb77f6a482e93a893bb4c2b8f29`. The access-mask change did
not fix the incident. Subsequent user-admin file reads succeeded on both child
and parent. Both DACLs give SYSTEM/Administrators full access and the recorded
user read access; parent is ReadOnly, child is not. No ACL/attribute edits are
authorized by this evidence. Probe v3 compares V1 and V2 explicit read-only
information opens on both images, with/without parent-chain resolution, in a
single diagnostic run. No-parent opens are diagnostic only and never authorize
recovery. SHA-256 `5b5d1506c931f93c933b66e0ea4549d307fbf5e0d1065a6a33479a5095476f6f`.

Probe v3 evidence `Native-74b9dfb294784387b733f0da57d7f722` isolates an API
version difference: all parent opens work; all V1 child opens return code 5,
including NO_PARENTS; V2 GetInfoOnly/ReadOnly child opens return success and
IsLoaded=1 with the full parent chain. This rules out missing DETACH access and
parent-chain traversal alone as explanations of the observed failure.

Production information queries now use V2 GetInfoOnly=TRUE/ReadOnly=TRUE,
access NONE, flags NONE. Recovery volume validation uses this information handle
and a GENERIC_READ volume handle while retaining physical-disk/extent identity
checks and the admission guard. Destructive maintenance still uses its separately
admitted handles. No NO_PARENTS fallback or ACL/attribute change was added.
Windows ABI and admission-before-open regressions were added; focused maintenance
tests passed under the original host user (sandbox file-handle tests were denied).
Probe v4 exercises the corrected production inspection path; guest confirmation
and authenticated deployment remain pending. SHA-256:
`68dca1419e1dfb7b3e09b2e68e2c575332f804b124b404a788d65b811ed43779`.

Guest v4 evidence `Native-14436df121a6476c8c08fcefecb23507` passed child-loaded,
read-only volume identity and mount-path queries. This confirms the inspection
fix on the affected image, not application recovery or power-off qualification.

Prepared `output/recovery-product-20260916/reviewed-completion/` for assisted
completion of only app transaction `95e90eed...99bd311` / native transaction
`9261c18c...d968d4c4b`. Its isolated helper pins machine, transaction, protected
context hash, application root, migration, already-terminal native rollback and
source selection. Forward operations/other transactions are refused. It uses the
normal authenticated elevated session, source validation and mount verification;
it does not replace installed binaries or edit protected outcomes directly.
The external runner authenticates the installed runtime, invokes its existing
combined rollback with the hash-pinned fixed helper, checks strict before/after
preservation and then runs ordinary Doctor. Guard and ABI/admission tests passed.
Helper SHA-256 `7777564d53bbe986577356fe1e558b45f720eb384fe675433ed04fa256be2f7e`.
Guest assisted completion succeeded. User-reported evidence
`C:\HoneyBeeQA\reviewed-completion-20260916\Evidence-1789554348603` reports
app transaction `RolledBack`, `preserved:true`, `doctorReady:true`, `ok:true`.
The exact summary is retained in `reviewed-completion/guest-reported-result.json`;
original evidence remains in the VM and has not been independently collected.
The previously blocked application rollback is complete. This used an external
fixed helper, so the original automatic power-off recovery case remains failed,
and no acceptance gate is promoted. Installed binaries remain unchanged; future
distribution and automatic recovery still need the fixed production code.

### Reviewed Repair metadata admitted without weakening preservation checks

The first reviewed resume stopped before mutation because original preservation
included the full registry SHA and Workspace.updatedAt. The user-supplied diff
showed registry `9fc408def4aa791d8ff4886c56004a221ec40af419d076b44a6578ef09a59b04`
-> `02570755a84eb636281e984160d10606878be5037ea725f096959e0731da503a`, and the
known Workspace timestamp changed from 2026-09-14T15:04:06.552Z to the reported
Repair time 2026-09-16T03:50:57.510Z. The original runner did not account for this
explicitly authorized Repair; no power-off attempt was injected.

The QA-only `preserved-20260916T035057` review pins both complete registry hashes,
the exact Workspace ID, and both timestamps. It changes only those two expected
snapshot values before the ordinary full deep preservation comparison. All
file hashes, index, heads, branches, project state, lease/mount bindings and
other fields remain strict; there is no general timestamp/hash exclusion.
The successful reviewed-baseline journal retains this metadata review and
uses the actual post-Repair snapshot for subsequent strict comparisons.
Seventeen relevant regression tests passed; native/product artifacts are unchanged.
Handoff: `output/recovery-product-20260916/poweroff-resume-v2`, guest destination
`C:\HoneyBeeQA\poweroff-resume-v2-20260916`. Guest execution remains pending.

### User-reported Repair succeeded; reviewed preflight resume prepared

The user's ordinary CLI `workspace repair preserved --json` returned ready,
available=true, the original branch/HEAD, and the same tracked/untracked change
names (updatedAt=2026-09-16T03:50:57.510Z). Subsequent Doctor returned ready=true,
20 pass, zero warning/fail. This restores observed availability but does not
establish why the child detached or prove sustained availability. No new release
or power-off qualification pass is inferred.

`--resume-focused-baseline poweroff-service-replaced` is a reviewed QA-only
continuation. It requires the original preflight to be the sole journal entry,
fresh original-baseline preservation review, unchanged candidate/guest admission,
and no power-off attempt directory. It records resume intent before rerunning
source health and never retries a failed reviewed resume automatically. Once
baseline completion exists, the wrapper uses ordinary same-case recovery after
the power-off. Eleven focused/matrix tests and PowerShell parsing passed.
Patch: `output/recovery-product-20260916/poweroff-resume`.
Guest destination: `C:\HoneyBeeQA\poweroff-resume-20260916`.
The prior failed preflight and passing reboot evidence are retained.

### Power-off preflight blocked: source Workspace later observed detached

Before power-off injection the user reported Doctor 19 pass / 1 fail:
`workspace.repair-required` for `preserved`. Service, receipt, component and
cache checks passed. The follow-up Workspace listing still showed branch
`qa-preserved`, HEAD `58cdb8b966a1ae7a82fb6b19c519fd806a6075bd`, tracked edits
and the untracked Korean filename. These observations are not byte-hash proof.
Lease `lease-43d0116a8935f0e309d631b1488da3b2` reported ready/clientPid=12172,
updatedAt=2026-09-15T16:43:43.4882441Z; Get-DiskImage reported Attached=false
and DevicePath=null. Actual attachment and persisted lease state disagree.
No power-off checkpoint was reached. The earlier reboot pass remains a scoped
observation, not proof of sustained availability; release readiness is blocked
until this later source-health failure is understood. Existing Workspace Repair
validates the retained Library junction, heartbeats or attaches the retained
child, repairs Git worktree metadata and updates the registry. It does not
reset or clean source edits. Repair execution/result are not yet reported;
do not replay the interrupted focused baseline automatically.

### Next existing case: focused service-replacement forced power-off

`output/recovery-product-20260916/poweroff-handoff` prepares only
`poweroff-service-replaced` against the same beta.26 inputs and populated beta.22
source. It verifies the previous focused reboot's completed rollback and
preservation, identical candidate/inputs/machine/user/installation, and its
original >=16 GiB admission before allowing the existing continuation allowance.
This does not lower product download, backup or migration capacity checks.
Setup and subsequent app ZIPs remain deferred on the host; service media and
all metadata remain required. No previously passed case is rerun.

At the held checkpoint the guest prints the exact host PowerShell command with
the bound case directory and nonce. The existing host-poweroff script turns off
only the pinned VM, starts it and delivers the power-off witness. Guest resume
requires that witness within the five-minute checkpoint window, then ordinary
Launcher rollback, source health and preservation. Native or installed recovery
binaries are unchanged. Ten focused/matrix regression tests and the handoff's
PowerShell parsing passed. Guest execution and the case result remain pending.

### Current result: focused automatic service-replacement reboot recovery passed

The user reported automatic guest reboot, then ran the same focused command.
It resumed the admitted run at 15.01 GiB free with product capacity checks
enabled and returned focusedCasePassed=true for `reboot-service-replaced`.
Guest evidence:
`C:\HoneyBeeQA\recovery-continuation-20260916\Evidence-focused-reboot-service-replaced`.
The supplied output is recorded in
`output/recovery-product-20260916/focused-reboot-user-result.json`; raw guest
records have not been copied back to the host. Unlike the earlier incident,
no assisted mount recovery was performed in this focused attempt. The runner's
success requires rollback, source health and preservation checks; do not infer
any additional test coverage from it. This closes this specific failed case for
the beta.26 QA candidate. Do not repeat it or mark the entire interruption gate
passed. Full qualification and release publication remain incomplete. Continue
only the remaining original scope, including forced-power-off recovery and the
successful migration/Repair/consecutive-update sequence. Deferred Setup/app
payloads must be restored from the verified host copies when needed.

### Host duplicate cleanup completed; replacement media built

User-authorized cleanup removed only generated binary/archive copies whose
SHA-256 matched a retained copy. The durable mapping is
`output/recovery-product-20260916/verified-duplicate-cleanup.json`; completion is
`duplicate-cleanup-result.json`. Host free space rose from 2,273,222,656 to
29,427,728,384 bytes before replacement packaging. VM disks, user data, JSON
records, logs, and current candidate builds were excluded. Builds with locked
files were protected, and their already removed copies were restored and hashed.
No process was forcibly stopped. Historical artifact paths listed as removed
are reconstructible from the mapping, not runnable intact installations.

Replacement beta.26/27/28 media finished building under
`output/final-release-builds/build-aDPwGS/result.json`. All three update manifests
and the explicit QA service-pair manifest were signed with the existing Ed25519
key. Setup remains an unsigned beta; none is guest-qualified or published.
Beta.26 Setup SHA-256 is
`f6e08c3770670ac44d7eb800a1e1e9e69a79317ad38e7917279dbd1730040872`;
its production manifest SHA-256 is
`02fe9d16ede883e4dc75ddabfd593dce0d4dc8fa084818b00ff45308824a0375`.
After all packaging and the new 1.09 GiB QA bundle, host free space was
17,670,385,664 bytes. The cleanup recovered approximately 25.3 GiB; replacement
builds consumed approximately 11 GiB of that space.

The new `-OnlyCase reboot-service-replaced` runner uses the ordinary durable
matrix records, native fault injection, recovery and preservation checks. It
records a focused result with full completion and acceptance promotion false.
Restart resumes the same case without injecting again. A later full run can
reuse the matching completed case, but never an old candidate's evidence.
Focused flow, matrix and integrated-flow regression tests passed (16 tests).
PowerShell parsing and working-tree whitespace checks passed. These local
tests are not the 16 guest acceptance gates.

The replacement bundle is
`output/final-release-builds/build-aDPwGS/continuation/integrated-TNuW5c`.
Its transfer destination is `C:\HoneyBeeQA\recovery-continuation-20260916`.
Run only `HoneyBee-Reboot-Recovery-QA.cmd` there for the next affected case;
do not start the full matrix anew. Guest execution has not occurred.
Host elevated transfer completed: Delivered, 122 files. The pinned copy operation
did not execute QA or change the installed service. The handoff and post-build
free space are recorded in
`output/recovery-product-20260916/continuation-handoff.json`.

The user's first focused invocation stopped at initial capacity admission:
15,561,506,816 bytes available versus 17,179,869,184 required. No checkpoint or
service operation was reached. Host cleanup did not reclaim guest filesystem
space. A separate guest cleanup runner was delivered to
`C:\HoneyBeeQA\transport-cleanup-20260916` (3 files, Delivered). It admits only
nine exact obsolete transport ZIP/Setup paths, verifies SHA-256 against copies
reverified on the host, rejects redirected paths, and flushes removal intent.
It preserves VM disks, installations, backup stores, datasets and evidence.
Absent old copies are skipped; the new active bundle is excluded. After cleanup
it invokes only the focused reboot case if the unchanged 16 GiB floor is met.
Manifest and runner: `output/recovery-product-20260916/guest-cleanup/`.
Guest cleanup and the resumed qualification are pending user execution.

The user reported the first guest cleanup completed: four files removed,
15,561,285,632 -> 16,636,018,688 free bytes, installedDataChanged=false.
The other obsolete transports were already absent. The 16 GiB floor still
refused execution; evidence is
`C:\HoneyBeeQA\transport-cleanup-20260916\Cleanup-bf59442fa18b438b951ec17ce5649073`.

The focused service-reboot runner can now defer exactly Setup and the two later
app-update ZIPs to their verified host copies (855,625,344 bytes). It still
requires all manifest/signature metadata and the service package; the full
runner still requires every artifact. Immutable inputs and acceptance scope
are unchanged. The bounded patch and cleanup are in
`output/recovery-product-20260916/focused-cleanup`. Old and new runner hashes
are pinned, removal paths are restricted to the three transports, and guest
execution remains conditional on the unchanged 16 GiB floor. Focused/matrix
tests passed (9), including full-run artifact requirements and restart replay
protection; PowerShell parsing and deletion path checks passed. Guest execution
has not yet been reported. Restore the deferred payloads from the host before
any later full integrated run; do not treat the focused result as full completion.

### Product recovery integration built

Retired-worker rearming is now connected to authenticated product recovery
admission and commit/recovery callbacks, not just the incident helper. Candidate
signature/hash and protected context verification precede rearming. Only an
otherwise identical Stopped/Disabled registration can regain Automatic startup;
ordinary first registration still refuses mismatched services. The detached
broker admission and original-topology restore remain part of this product build.

`output/recovery-product-20260916/build-result.json` records successful full native
tests for production and qualification tags, vet, and these binaries:

- Production: `592c4955a7ab1373510a0851e2c7828096f87ffdf504b94dfb27b59ce2da04d7`.
- QA: `2fd85ae5339e35360b150f50585df003588c712526b00ff9dc0ea0bda7545dc5`.

These are built artifacts, not installed or qualified guest releases. Existing
beta.23 media still lacks these changes. Host free space was 2,273,222,656 bytes
before this build. A proposed cleanup of three old root node_modules paths was
refused by the reparse-point guard before deletion; do not remove shared caches
through those paths. Initial recursive logical size totals followed such paths
and must not be interpreted as independently reclaimable disk usage. New media
assembly is now in progress following the cleanup above; the affected guest
reboot qualification remains pending.

### Guest restored and Doctor healthy after assisted mount recovery

The user reported helper v2 success: mountsRestored=true,
installedFilesChanged=false, qualificationPassed=false, migration
`migration-4ae3ce60c650dd155129709d6a73ad5b`.
Guest evidence:
`C:\HoneyBeeQA\detached-recovery-20260916\Evidence-54ebaa460bd64e7e86f9fe6227b57f0c`.
The subsequent non-elevated stable CLI Doctor returned ready=true, pass=20,
warning=0, fail=0, exit=0. Storage component remains
`0.0.0+cfa606fd4143.hb13.topology5.qa-baseline`; the registered project and
`preserved` Workspace (`8934fa61-ed64-4851-8535-261ce5109487`) are ready.
These are attributed user-supplied guest observations. Doctor readiness does not
independently prove the dirty-file byte hashes or qualify automatic reboot recovery.

The incident's immediate availability problem is resolved. Do not rerun the
original failed reboot case against unchanged installed recovery binaries: v2
was a separate assisted recovery tool. Remaining product work must package the
detached-broker fix and handle a legitimately retired recovery authority through
an authenticated, durable lifecycle before the affected automatic recovery case
can pass. Retired-worker handling is now in the product build described above,
but has not shipped or passed guest qualification. Existing beta.23 media is superseded
for release readiness, and public publication remains blocked. The acceptance
scope stays the original fixed 16 gates; retain all unaffected prior evidence.

### Incident helper v2: retired recovery worker admission

The first incident helper stopped before broker disruption at
`recovery boot registration changed`. An elevated SCM query subsequently showed
the recovery services retained as Stopped/Disabled. Non-elevated enumeration had
omitted these administrator-only services; absence from that query was not proof
of deletion. All old services must not be enabled indiscriminately.

The isolated helper v2 authenticates the candidate through installed release
trust and held protected payload handles, matches the existing recovery context
and command, then permits only its exactly matching Stopped/Disabled registration
to return to Automatic. It starts and verifies the registered worker before any
broker pause. The maintenance lock holds that worker off while mount recovery
runs. Other accounts, commands, dependencies, startup modes or process states
are rejected. No installed executable or application decision is changed.

The full native fixture suite and qualification-tagged vet passed. The v1 helper
is preserved as `HoneyBee-Detached-Recovery-v1.exe`; v2 digest and scope are in
`output/detached-broker-recovery-20260916/build-result-v2.json`. The same host
`Transfer-Recovery.ps1` and guest administrator `Invoke-Detached-Recovery.ps1`
now pin v2. Guest execution and actual mount restoration remain pending; this
assisted operation cannot qualify the automatic reboot case.

### Reboot mount restoration failure and bounded detached-broker recovery

Guest evidence for `reboot-service-replaced-attempt-000` reached Replaced, then
recorded recovery failures `combined-dYkpKq` and `combined-88aDkH` with
`restored attachment set differs`. The earlier successful `combined-jRUJF1`
belongs to a different pre-reboot attempt, not this recovery. Current pointer is
beta.22 generation 2. The lease says ready, clientPid=10196, while the service is
Running/Auto with PID=3716 and the child VHDX reports Attached=false.

The existing Running-service path cannot deliver StartService resume arguments.
The source fix distinguishes a fully validated missing attachment from unknown
or foreign attachment errors. Only a completely detached, unchanged ownership
and file-identity set can restart: pause/drain, revalidate, protected reservation
and no-delete guards, verified stop/process exit, then resume with the immutable
original topology and validate before automatic startup. Mixed attachments fail
closed. The original topology record is never replaced by the detached snapshot.

Native regression tests and vet passed using the pinned external Bee overlay.
Sandbox ACL fixture failures were rerun with the ordinary host user's ACL access;
the isolated source tree's expected public trust fixture was supplied before the
successful full run. No installed service was used by those tests.

`output/detached-broker-recovery-20260916` contains a separate QA-only helper bound
to this VM, initiating SID, source executable hash, original application pointer,
protected recovery context and migration `migration-4ae3ce60c650dd155129709d6a73ad5b`.
It holds the maintenance lock, checks that the update owner exited and verifies
the existing registered recovery authority. It restores mounts only; it does not
replace installed binaries, edit application decisions or mark QA passed.
Helper SHA-256: `3840637aa3d83ef1e6a7f5e9125a53b29bdf9cd962152c4865285c7b257a7c2a`.
The extra incident command exists only in the isolated helper source copy.

Host administrator entry: `Transfer-Recovery.ps1` in that output directory.
Guest administrator entry after delivery:
`C:\HoneyBeeQA\detached-recovery-20260916\Invoke-Detached-Recovery.ps1`.
Execution remains pending. Helper success is assisted recovery, not an automatic
reboot qualification pass. The affected reboot scenario still needs qualification
with packaged fixed recovery code. Existing beta.23 media predates this product
fix and must not be published as containing it; publication remains blocked.

### Resume capacity correction after the first prepared candidate

The guest's reviewed retry stopped at the unconditional 16 GiB preflight, before
any new matrix action. That allowance was charged again after initial preparation
had already consumed space. Initial runs still require 16 GiB. Resumes now first
validate the completed preflight's candidate, inputs, machine, user and installation
binding and its original capacity admission; they retain 64 MiB for QA evidence.
This is not a claim that 64 MiB suffices for the update: product download checks,
native cold-backup size-plus-headroom checks and service replacement capacity
checks remain enabled and can still stop safely. No files are deleted by this fix.

Ten focused capacity and integrated-flow tests passed, as did ESLint and transfer
PowerShell parsing. Deliver the cumulative four-file patch using host administrator
`output/final-validation/session-20260914-132941/transfer-continuation-resume-space.ps1`.
In the guest, retry only `kill-service-backup-verified` using the existing
`run-integrated.ps1`. The prior failed attempt and completed stages are retained.
Application packages, final candidate hashes and inputs.json remain unchanged.

### Continuation admission correction: obsolete beta.11 controller pin

The guest reported completed preflight, reused baseline, dataset and baseline
health, then `Native QA controller failed: Not the bound QA baseline installation`.
The native fault controller still hard-coded beta.11 although the reviewed source
is beta.22. This rejection precedes checkpoint arming and spawning the update
worker; it is not evidence of a failed service replacement.

The controller now binds source version and host digest to the bundle service
pair, the first update's source/manifest and the active installation pointer.
Installed host hashing and instrumented capability checks remain enforced.
The pure PowerShell admission check accepted beta.11 and beta.22 fixtures and
rejected eight mismatches without service operations. Controller and transfer
PowerShell parsing passed.

Deliver only the controller and runner inventory with
`output/final-validation/session-20260914-132941/transfer-continuation-baseline-binding.ps1`
from the host administrator shell. Then use the guest's existing
`scripts/qualification/run-integrated.ps1 -RetryCase kill-service-backup-verified`
under `C:\HoneyBeeQA\final-continuation-20260915`, as the original non-elevated
user. This retains the failed attempt and completed flow phases. Do not resend
the original full bundle over this correction. No Setup or application artifacts
changed; the final candidate identity and fixed acceptance scope are unchanged.

### Current handoff: final beta.23 candidate and populated continuation prepared

The final distribution is
`output/final-release-builds/build-NnP55f/finalize-29qfc7/distribution/distribution-KvDKI8`.
Setup SHA-256: `47c70fc22889334ad43df717583f2ce71bde31214fcc7df950a0378d15011f9a`.
Manifest SHA-256: `bd467582d7dc1a425634d3da5230ee082d406bfff37f2f3f8f79aa8ecfc85c80`.
The rebuilt Setup includes the validation activity fix in its recovery runtime.
Production storage SHA-256 is
`56699ca022662257e2187ed4476a83d27a5e60fb97a48782f51cde33a357811c`.
The final offline distribution review verified artifacts and Ed25519 signatures;
Authenticode remains explicitly deferred. Publication is not yet allowed.

The continuation bundle is
`output/final-release-builds/build-NnP55f/finalize-29qfc7/continuation/integrated-kKMiA8`.
Its 104 runner entries, 15 artifacts and 46-module import closure were verified.
Seven focused baseline/cleanup guard tests passed, as did ESLint and the host
transfer script's PowerShell parser check. No guest execution is claimed here.

Host administrator command:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Users\user\Documents\HoneyBee\output\final-validation\session-20260914-132941\transfer-final-continuation.ps1"
```

After Delivered, run inside the existing VM as bonsang without elevation:

```powershell
& 'C:\HoneyBeeQA\final-continuation-20260915\HoneyBee-Integrated-QA.cmd'
```

The runner admits only the recorded successful beta.22 transaction and unchanged
preserved dataset. It continues the existing service interruption matrix and
beta.22 QA-to-production beta.23 transition, matching Setup Repair, and consecutive
application updates to beta.24 and beta.25. It does not reinstall the baseline or
recreate projects. It is not fresh-install evidence for beta.23. Normal restart
checkpoints may instruct the user to sign back in and run the same entry point;
failed scenarios retain evidence and must not be replayed automatically.

To offset the new 1.09 GiB transfer, the runner may remove only seven allowlisted
obsolete QA Setup/ZIP transport copies after validating their hashes against
preserved host copies. It validates the complete list before deletion and writes
intent/completion evidence under the new bundle's Cleanup directory. Installation
versions, storage backups, VHDX files, projects and QA evidence are excluded.

Remaining limitations are explicit: the existing installation's old immutable
recovery runtime is not replaced; the continuation uses the reviewed external
coordinator. Historical hb12 migration is not qualified by this candidate. The
distribution's new candidate-bound acceptance ledger remains unapproved, rather
than transferring old candidate passes blindly. Prior evidence is retained and
must be assessed for reuse under the same fixed 16-gate contract, not rerun as an
expanded test scope. Release notes are drafted beside the distribution. Neither
the public release nor existing current-distribution pointers have been changed.

### Current handoff: populated beta.11 to beta.22 transition PASSED

The user supplied the guest console result after running
`HoneyBee-Activity-Transition.cmd`: state=Committed,
currentVersion=0.1.0-beta.22, preserved=true, doctorReady=true.
Transaction: `8a79bcbce67c3e19da9e718536dccb6259dd17de54efac491c5c03b5d079b707`.
Guest evidence: `C:\HoneyBeeQA\final-integrated-20260914\Transitions\topology6\Execution`.
This is attributed guest-reported evidence; host export is not required as a new gate.
Do not repeat this successful transition. The guest's source baseline is now beta.22,
not beta.11; old pinned-source transition commands must not be reused.

This confirms the authenticated populated service/application transition, candidate
Desktop readiness, commit and preserved data/Doctor checks in this external-runner
attempt. It does not qualify every interruption case or the immutable recovery
runtime: the activity fix was delivered in the external runner, not installed into
that runtime. Remaining implementation must package the fix into distributed and
recovery artifacts before claiming their readiness. Reuse unaffected prior passes;
the original fixed acceptance contract and Authenticode deferral are unchanged.

Before the successful attempt, the 16 GiB preflight stopped safely at 15.63 GiB.
Host copies of the obsolete optical/quiesce/backup media ZIPs were verified against
their recorded hashes before instructions to delete only those guest duplicates.
No storage backups, VHDX files, installation versions or evidence were selected.

### Previous fix: validation activity deadlock in external runner

The user ran beta.22. Combined transaction
`dc4e70bf74fbd3b507c4e8a5e591c5e049f4f32fcbb977193e1707050440d076`
reported `Validation Desktop readiness timed out`, restored beta.11, and reported
preserved=true/doctorReady=true. The attribute error no longer occurred in this
attempt. The code explains a deterministic lock conflict: withDesktopUpdateLifecycle
holds exclusive activity through runCombinedApplicationTransaction, while the
candidate Desktop always requires shared activity before opening its session.

The coordinator can now change activity mode. Protected candidate authorization
precedes shared mode, and the pending combined journal continues to reject ordinary
managed clients. The installation update lock remains held. Validation shutdown is
followed by exclusive reacquisition (waiting for the shared client to exit) before
native commit, rollback or pointer mutation. Missing exclusive ownership cannot
authorize these mutations. Failed drain leaves recovery pending rather than
terminating a client or proceeding with mutation. Timeout values were not increased.

Windows process tests cover the old blocked-shared condition, shared validation
admission, waiting for validation exit before exclusive reacquisition, and failed
drain preventing mutation. Existing activity/lifecycle/combined tests passed (25
in the first batch); the final activity/predecessor/preparation-reuse batch passed
25 tests. Sandbox ACL failures were rerun under the original host user. These are
local checks, not a claim of completed guest qualification.

This retry reuses the same authenticated beta.22 media and proven preparation;
no installed version is overwritten and no new large package is generated.

- Patch: session `topology-activity/patch.json`, 9 files, 71877 bytes.
- Host administrator: session `transfer-activity-transition.ps1`.
- Guest original user: `HoneyBee-Activity-Transition.cmd`.
- New evidence: `Transitions/topology6/Execution`.
- Admission pins the beta.22 rollback above and original preserved dataset.
- Verified all 119 runner inventory entries and 43 imported modules, pinned media
  signature/hash, unchanged native host and PowerShell syntax.

Transfer and guest execution subsequently passed as recorded above. The patched coordinator is currently
in the external QA runner; the immutable installed recovery runtime was not changed.
Do not claim startup recovery qualification for the new lock transition from local
tests or promote release artifacts until the agreed existing gates are satisfied.

### Previous handoff: Bee compression incompatibility fixed; beta.22 prepared

Beta.21 identified the failing entry as the retained child's `.bee/data` directory,
attributes `0x2810`, unsupported `0x800` (NTFS compression). Transaction
`4e76687a86ba4a9763b0e37bb651a5828b2248189b49dc5ba6a4f76b59cb2b2c`
rolled back with preservation and Doctor readiness reported. The pinned external
Bee overlay deliberately compresses newly created private Bee data. The updater's
inventory policy rejected that normal product-created attribute.

Inventory now admits compressed entries only after the held handle confirms NTFS
LZNT1 format. Unknown formats, sparse+compressed combinations, redirects, ADS and
other unsupported attributes still fail closed. Inventory v1's compressed bit
unambiguously records the admitted LZNT1 format. Recovery applies FSCTL compression
after durable metadata intent and verifies its format, then restores ordinary
attributes/security and checks exact readback. Compression is excluded from
FileBasicInfo writes. Metadata adapters request data write access, falling back
to metadata-only access on AccessDenied for read-only replay; a needed compression
mutation still fails if write access was unavailable.

Windows semantics: [compression state](https://learn.microsoft.com/en-us/windows/win32/fileio/compression-state).
Directory compression affects newly created children, so restoration verifies each
entry independently. Native composition now covers a compressed directory and file,
backup logical bytes/inventory, interruption and replay. A separate native test
checks intent failure before compression mutation, compression replay, decompression
and preserved bytes. Full native tests and vet passed against the actual pinned
overlay build; 13 QA admission checks passed. No guest acceptance is claimed yet.

- Native build: `output/topology-fix-builds/build-jJ44at/build.json`.
- QA SHA-256: `1b682e160f77a6e56be0096c612f881220dc5c432da1dae287b3dc41624ef31b`.
- Signed beta.22: `output/compression-transition-builds/build-w2tqFV/result.json`.
- Manifest: `5212d7056e87a948efd001c61fc6daf735b4ca9023fa086aa4561f6a5e083afb`.
- Component: `0.0.0+cfa606fd4143.hb13.topology5.qa-baseline`.
- Session transfer: `transfer-compression-transition.ps1` (host administrator).
- Guest: `HoneyBee-Compression-Transition.cmd` (original user, service UAC only).
- Evidence: `Transitions/topology5/Execution`; beta.21 predecessor is pinned.

Patch verification passed for 10 files (219327400 bytes), 117 runner entries,
43 imported modules, signature/package/native hashes and PowerShell syntax.
Previous installation versions and QA records were not overwritten by preparation.
Transfer and guest execution remain pending. The acceptance scope is unchanged.

### Previous handoff: beta.20 rolled back on store attribute validation

On the user's request to resolve this, a single new signed QA beta.21 bridge was
prepared with the detailed attribute/type/path diagnostics. This is diagnostic
instrumentation, not a confirmed repair or an expansion of supported attributes.
No installed guest files or service were changed by preparation.

- Native build: `output/topology-fix-builds/build-6mfyPX/build.json`.
- QA host SHA-256: `0b32a8df98cce82458f8a72de0d3d388fdd0b1211067790c9b6adb5302b20db9`.
- Candidate: `output/backup-transition-builds/build-s4baVc/result.json`.
- Manifest: `fd1e6a6b5be5712a45e024e5dbd561665770b34bff3871beb6493a667d290d2a`.
- Component: `0.0.0+cfa606fd4143.hb13.topology4.qa-baseline`.
- Patch: session `topology-backup/patch.json`, 10 files, 219322568 bytes.
- Host admin transfer: session `transfer-backup-transition.ps1`.
- Guest original-user entry: `HoneyBee-Backup-Transition.cmd`.
- New evidence: guest `Transitions/topology4/Execution`; prior attempts retained.

Admission pins the reviewed beta.20 rollback, original dataset and source pointer,
and independently checks the prior terminal journal. The bridge uses the existing
authenticated migration and recovery primitives. Twelve focused JS checks passed;
native attribute/inventory/ADS checks passed against the actual overlay build.
Ed25519 authentication, package/native hashes, all 115 guest runner entries and 43
imported modules were verified. PowerShell syntax and diff checks passed. Transfer
and guest execution remain pending; no new acceptance gate is introduced.

The user ran the beta.20 transition. Combined transaction
`ec7a06a0bfe48ba53a70e46c2cbcb093be10590ccf18e0245387ee23a650cdb0`
reported RolledBack with `store entry has unsupported NTFS attributes`.
The result reported beta.11 active, preserved=true and doctorReady=true.
The subsequent completed scan on DESKTOP-9LT0JVV found zero unsupported
attributes in the live store, excluding maintenance. This does not inspect the
stopped/detached state or establish which native validation call failed.
The old message also covered an expected-directory/type mismatch.

Checkout diagnostics now distinguish unsupported bits from type mismatch, include
numeric attributes and expected/actual type, and retain entry paths during live
inventory and recorded inventory validation. Backup inventory failures identify
before/after capture. The accepted attributes and rejection policy are unchanged.
Focused attribute/inventory/ADS tests passed outside the filesystem sandbox;
the sandbox run failed on directory access. These diagnostic changes are not yet
packaged or delivered to the guest. No update qualification passed on this turn.
The user supplied the retained beta.20 journal: Prepared, Reserving, Reserved,
Stopping, Stopped, Quiescing, Quiesced, BackingUp, Resuming, Resumed.
Its identity digest is
`8e911d0be825aa950f0ba78baf54296eef76eb4a04bc736552568c42729a2fcf`;
the target manifest matches the beta.20 bridge. This confirms quiescence completed
and CaptureBackup failed before BackupVerified or Replacing. Service replacement
did not start in this attempt. The call graph narrows the attribute error to live
store inventory before/after capture or validation of that inventory; restore
metadata calls are not part of CaptureBackup. The journal does not distinguish
those inventory calls or provide the failing path/bits. Do not claim the original
attribute/type cause is known, automatically replay, or clear file attributes.

### Previous preparation: guarded detached-image reconciliation and beta.20

The user explicitly requested a fix. The production path required an old device
handle to remain usable after service exit, with no reconciliation for an image
that was already automatically detached. Windows documents automatic detach on
attachment-handle lifetime end without PERMANENT_LIFETIME:
[DetachVirtualDisk](https://learn.microsoft.com/en-us/windows/win32/api/virtdisk/nf-virtdisk-detachvirtualdisk).
This is a concrete missing lifecycle case. It is consistent with the reported
post-stop ERROR_DEV_NOT_EXIST, but the guest's exact failed API was not observed;
do not claim its root cause is conclusively established by the retired probes.

Only ERROR_DEV_NOT_EXIST from native device operations can now request a second,
independent proof. Topology admission supplies that proof while the original
no-delete image handle and ancestor guards remain held. It rechecks maintenance
ownership, compares the original image file identity, opens a fresh information
handle and requires IS_LOADED=false, then rechecks ownership. Missing/replaced
images, query errors, an image still loaded, and lost authority all fail closed.
The same proof checks a successful native detach, avoiding dependence on a stale
device handle. AccessDenied/invalid-handle errors receive no exception. Standalone
unadmitted handles cannot use this reconciliation. The batch checks the source
is stopped before and after each detach; a restarted source cannot reach backup.
Native errors retain API/stage/disk context. No force-detach, deletion or lock
bypass was introduced.

Ten disappearance/proof cases, no-proof rejection and source-restart rejection
were added. Full native module tests and go vet passed in the checkout and in the
exact pinned external-Bee overlay build. Nineteen QA adapter tests passed, covering
the new reviewed predecessor and existing admission rules. JS/PowerShell syntax
and diff whitespace checks passed. No new acceptance gate was added.

Native build: `output/topology-fix-builds/build-tBBa6j/build.json`.
Production SHA-256 `dbc39895f8e029d14d23cc46993a152d99dccd9894d1676a8429966a6a5cb443`;
QA SHA-256 `5f25bf7dd52beff8baadd13ff7797e514ac7d3d58468c4cbd137f5a71365d7b2`.
Single new immutable QA beta.20 bridge (component hb13.topology3.qa-baseline):
`output/quiesce-transition-builds/build-Uc55ey`.
Ed25519 manifest SHA-256 `4a769bd45f101b5bf7a5489c6460096e2a118e37ae96af4999d445375b361287`;
ZIP SHA-256 `29ff70f7ceee7f987d9b154d9811401875a39584392004d92d07b0bc9bdc78c2`.
The protected existing signing key was used; signature/package hash verification
passed. This is QA media, not a public release; Authenticode remains deferred.

The `--quiesce` runner admits only the exact beta.19 rolled-back predecessor
059ba7a6... with the observed device-unavailable reason, original dataset, original
source pointer, ready Doctor and a independently validated terminal journal. It
creates `Transitions/topology3/Execution` exclusively and never replays an old job.
`--quiesce-recover` addresses only that new context. The runner now prints state,
actual reason, transaction path, current version and preservation/Doctor results
before the final commit assertion, so failures do not need another manual result
extraction command. Source beta.11 and inactive beta.15/beta.19 remain immutable.

Delivery: session `topology-quiesce/`, 10 files / 219,317,432 bytes. Verification
checked all patch hashes, 113 guest runner inventory entries, 43 imported modules,
and the native host embedded in the assembled candidate. Replaced runner files
and old inventory are preserved locally. Use `transfer-quiesce-transition.ps1`
in HOST administrator PowerShell, then run the new
`C:\HoneyBeeQA\final-integrated-20260914\HoneyBee-Quiesce-Transition.cmd` in the
VM as unelevated bonsang and accept the service UAC prompt. This is the actual
update path, not another standalone fixture probe. Transfer and guest activation
remain pending. No acceptance result or publication is claimed.

### Previous status: separate-process probe also failed; retire this reproduction sequence

The user ran the separate-process SYSTEM probe at 2026-09-15 21:37. Evidence:
`C:\Program Files\HoneyBeeQuiesceDiagnostics\61d08fd452c0489ca4cf6a764f1c0c93`;
attempt `quiesce-process-2554794538`, fixture `quiesce-fixture-814103481`.
The owner PID was 2116 and coordinator PID 8672. OpenVirtualDisk(GET_INFO|DETACH)
still returned AccessDenied before reservation, despite separate SYSTEM processes.
The source worker's original Quiescing failure has not been reproduced.

Stop this sequence of fixture retries. The observations rule out the tested
descriptor, RWDepth and identity/process separation changes as sufficient fixes
for the fixture's open failure. Do not present them as root-cause fixes, request
another unchanged run, or promote any diagnostic to acceptance evidence. Preserve
all artifacts. The failure remains unresolved; beta.11 was last confirmed ready
after the beta.19 rollback, and no subsequent update or installed service mutation
has been performed by these diagnostics.

Code comparison confirms the shipped native worker was built against the pinned
external-Bee overlay in build-Fy5M11, while these test executables were compiled
from the checkout module, and the fixture is a new dynamic disk instead of the
retained differencing-child topology. Neither difference is proven causal.
The next investigation must establish parity or obtain API-level failure evidence
from the actual admitted path; no new runtime exception or guard relaxation is
justified by the current data. In particular, a generic device-unavailable error
must not be treated as proof of a safely detached image. Current production-path
changes record operation context; they have not been delivered into the VM's
installed application. Further QA execution is not prepared by this result.

### Previous handoff: SYSTEM result falsifies identity-only explanation; separate process fixture

The user ran the SYSTEM task successfully at 2026-09-15 21:30 (guest local time).
The transcript confirms SYSTEM, but OpenVirtualDisk(GET_INFO|DETACH) still returned
AccessDenied before reservation. Evidence is retained at
`C:\Program Files\HoneyBeeQuiesceDiagnostics\34b71a74792741d2a6c48a6df94b21f0`,
fixture `quiesce-fixture-602165582`. Therefore neither process identity alone nor
RWDepth/attachment descriptor adjustments explain the diagnostic failure. The
original integrated post-stop error is still unresolved. No service changed and
no qualification passed.

The fixture had one process both attach and reopen the image, unlike the actual
broker and coordinator. The new diagnostic separates those roles: a child of the
protected SYSTEM test executable creates/attaches a new 64 MiB fixture and retains
its attachment handle. The coordinator opens/reserves it while the child lives,
then closes only the child stdin and waits for confirmed child exit before quiesce.
The owner writes a protected ready record and its own log. The coordinator checks
the record's image path belongs to its unique attempt. It never opens SCM, existing
VHDX files or registered projects; prior fixtures/tasks are not replayed. This is
still a dynamic disk fixture, not a full differencing-chain migration. Whether
process separation resolves the discrepancy must be observed, not assumed.

Session `native-quiesce-process-probe.exe` SHA-256:
`74412e1d032b913ca8b5152895cda2e93843a329324737d145f74b0ff3379173`.
Guest script `Run-Quiesce-Process-Diagnostic.ps1` SHA-256:
`d20e6d376800070b083caecd9b0f7b867f46b8ca23f203f8112acb58abb561e6`.
The existing protected scheduled-task wrapper is reused with new pinned file
names/hashes. Compilation and outer/embedded PowerShell parsing passed. Host runs
correctly skip both VM and child-only entries. Guest execution remains pending.
Use `transfer-quiesce-process-probe.ps1` in HOST administrator PowerShell, then
`Run-Quiesce-Process-Diagnostic.ps1` in VM administrator PowerShell. All previous
probe outputs are retained as failed diagnostics, not acceptance evidence.

### Previous handoff: stop elevated-user probes; match actual SYSTEM worker identity

Probe v3 still failed OpenVirtualDisk(GET_INFO|DETACH) with AccessDenied on its new
`Diagnostics/quiesce-fixture-1311790500/diagnostic.vhdx`, before reservation. Neither
the SID descriptor adjustment nor RWDepth reduction resolved this failure. No
conclusion about the original post-stop Quiescing failure follows from these probes.

Repository inspection confirms the actual recovery worker is registered as
LocalSystem (`service_recovery_registration_windows.go`), whereas all three probes
ran under elevated bonsang. This is a confirmed environment difference, not yet a
confirmed explanation of AccessDenied. Further same-identity probe retries are stopped.

`TestMaintenanceQuiesceSystemDiagnostic` now requires the pinned QA VM, SYSTEM SID,
and an executable located in a dedicated attempt beneath
`C:\Program Files\HoneyBeeQuiesceDiagnostics`. It creates a new bounded 64 MiB
fixture there, uses the original bonsang SID for the attachment's security descriptor,
and follows the same reserve/close-original-handle/quiesce sequence. It never opens
HoneyBee's service or registered data. This still models handle closure in one
process, not a differencing chain or real service shutdown; results must retain
that limitation. All previous fixtures and binaries remain intact.

The guest script verifies binary hashes before and after copying into a unique
protected directory with only SYSTEM/Administrators full access. It creates one
uniquely named, triggerless SYSTEM scheduled task to run the fixed test, with a
four-minute execution limit. The protected runner saves transcript/result files.
On completion the caller verifies the task action/identity and unregisters only
that task; it never deletes the fixture or evidence. Timeout retains task/evidence.
This temporary diagnostic task is a real machine change, separate from HoneyBee's
installed services, and requires guest administrator execution.

Artifacts in the session directory:
`native-quiesce-system-probe.exe` SHA-256
`a79357f5d35a3e5e9ad831c2a9cae70303cb4e507b9af295cde9a9c1650d35d7`;
`Run-Quiesce-System-Diagnostic.ps1` SHA-256
`ae13b40802edd9469a14d173c7d1bd547642c225c6947f02598a537712d4c233`.
Compilation and outer/embedded PowerShell parsing passed. The host test invocation
correctly skipped the VM-only entry. SYSTEM execution has not been observed.
Use `transfer-quiesce-system-probe.ps1` in HOST administrator PowerShell, then
`Run-Quiesce-System-Diagnostic.ps1` in VM administrator PowerShell. Do not rerun
the old probes or integrated update. No additional acceptance gate is introduced.

### Previous handoff: probe v3 removes unnecessary backing-store write request

Probe v2 still failed before reservation: OpenVirtualDisk(GET_INFO|DETACH) returned
AccessDenied for its fresh `Diagnostics/quiesce-fixture-1469025475/diagnostic.vhdx`.
The explicit broker-style SID descriptor was used. Thus security-descriptor parity
alone did not resolve the diagnostic failure. Neither probe reached the original
integrated failure after service stop; that root cause remains unconfirmed.

The maintenance open parameters requested RWDepth=1 even for GET_INFO and
GET_INFO|DETACH handles. These operations require no backing-store write access.
Both now use a shared version-1 parameter constructor with RWDepth=0. This changes
the backing-store access request, not the required detach permission, ownership
proofs, volume write/lock permissions or failure policy. The Windows contract
specifies 0 for read-only backing-store operations:
[OPEN_VIRTUAL_DISK_PARAMETERS](https://learn.microsoft.com/en-us/windows/win32/api/virtdisk/ns-virtdisk-open_virtual_disk_parameters).
Whether this resolves the observed AccessDenied must still be measured; it is not
yet a confirmed fix for the integrated Quiescing error.

Full native module tests and go vet passed as the original host user outside the
sandbox after the sandbox denied existing native file-ACL tests. Probe v3 compiled;
host invocation correctly skipped the VM-only fixture. Transfer parsing and diff
whitespace checks passed. No installation, service, or VM mutation was performed.

Session `native-quiesce-probe-v3.exe` SHA-256:
`e7971b31b98551b17dafb238baa630d48d1f2315ec1291fec9788ca592569e51`.
Run `transfer-quiesce-probe-v3.ps1` in HOST administrator PowerShell, then the
new guest executable with `'-test.run=^TestMaintenanceQuiesceIsolatedDiagnostic$'
'-test.v'` in VM administrator PowerShell. Like v2 it operates only on a new
bounded diagnostic VHDX and retains prior fixtures/binaries. No additional
acceptance gate, full update retry or release publication is included.

### Previous handoff: isolated probe v2 corrects fixture attachment security

The user ran the first isolated probe. It created the new fixture at
`Diagnostics/quiesce-fixture-2765620206`, volume
`\\?\Volume{9529d32d-a396-41c2-a8e7-44ba79fc4ef7}\`, then failed with
`Access is denied.` at openMaintenanceVolume before reservation or quiesce.
This is not a reproduction of the integrated post-stop error. Keep that fixture.

The fixture previously used OpenAndAttach's default security descriptor, whereas
the broker uses Open + AttachForUser(false, userSID). Probe v2 now uses that same
explicit user descriptor. This difference is confirmed in code; whether it caused
the diagnostic AccessDenied remains unconfirmed. openMaintenanceVolume now labels
path inspection, OpenVirtualDisk(GET_INFO|DETACH), GetVirtualDiskPhysicalPath and
CreateFile(READ|WRITE) failures with the relevant image/volume. Existing fail-closed
behavior is unchanged. Focused volume/reservation/batch tests passed and the updated
diagnostic compiled. Its host invocation correctly skips the VM-only fixture.

Session `native-quiesce-probe-v2.exe` SHA-256:
`9a3f4e0ba2755885436384d0f72bf37ec437f810e6e25235454c3563f1c36716`.
`transfer-quiesce-probe-v2.ps1` pins the new filename/hash and original VM; parsing
passed. It preserves the v1 binary and fixture. Run transfer in HOST administrator
PowerShell, then the v2 executable in VM administrator PowerShell with the same
quoted isolated-test flags. It creates only a new bounded 64 MiB fixture, never
opens the installed service or user workspaces, and retains failures without retry.
The actual Quiescing cause remains unresolved; no update retry is authorized by
this diagnostic result and no qualification gate is newly passed.

### Previous handoff: beta.19 passed reservation; isolated quiesce diagnosis

The user delivered and ran the optical transition. Combined transaction
`059ba7a6e18a488ccc3eea96ed2f9e53be18361f478a9fe32d15ce5c22f1d629` rolled back
with `The specified network resource or device is no longer available.` and
restarted beta.11 (`renderer-loaded`). Its saved result followed the runner's
preservation and Doctor checks. Native worker digest matches the optical fix:
`39a230a6edbf0949f7d5fdea07e6c89add3b8c0be614387ef9c397750590e14d`.
Migration `migration-492b9e05eb9655b23c37eef26a55676b` reached
`Prepared -> Reserving -> Reserved -> Stopping -> Stopped -> Quiescing -> Resuming -> Resumed`.
Thus the optical reservation blocker is cleared. Cold backup and replacement
were not reached. Quiesce's exact failing native call remains unconfirmed.

The native quiesce errors now retain operation name, admitted disk number and the
wrapped Windows error. Identity checks distinguish physical-path from disk-extents
queries; detach labels dismount, DetachVirtualDisk and post-detach IS_LOADED.
No error code is ignored and no locking or rollback guard is relaxed. Focused
volume/reservation/batch tests and a Windows error identity/context test passed.

To avoid another full update attempt, `TestMaintenanceQuiesceIsolatedDiagnostic`
creates one new dynamic VHDX (maximum logical size 64 MiB) under the original
bundle's Diagnostics directory. It mounts and writes only that fresh fixture,
reserves it, closes its original attachment handle to model process exit, and
runs the production detach path. It never opens SCM or any registered project,
workspace or service VHDX. Handles close on return and the fixture is retained;
there is no recursive deletion or automatic retry. This is a diagnostic of the
existing failed gate, not a new acceptance gate. It does not fully model a
differencing chain or a separate service process; a pass would narrow the cause,
not prove the integrated transition works.

Session `native-quiesce-probe.exe` SHA-256:
`d5e857291ffc93ffd2865c9ae1ea01c5f23671b24321d091e0741eb99b0de1ba`.
Compilation succeeded; the host invocation correctly skipped the VM-gated test.
Use session `transfer-quiesce-probe.ps1` in HOST administrator PowerShell, then
run the guest executable with `'-test.run=^TestMaintenanceQuiesceIsolatedDiagnostic$'
'-test.v'` in VM administrator PowerShell. Elevation is needed for the new fixture
VHDX. Transfer script parsing passed. Guest diagnostic execution is pending;
do not rerun either the beta.19 transition or integrated runner.

### Previous handoff: signed optical correction beta.19

The user authorized continuing after the optical-volume fix. The single corrected
bridge package is prepared in `output/optical-transition-builds/build-eBFSPb`.
It targets a new immutable QA beta.19, component
`0.0.0+cfa606fd4143.hb13.topology2.qa-baseline`, from the unchanged beta.11 baseline.
No beta.15 directory, previous media, Setup, final input pointer, or VM state was
overwritten. No additional Setup or consecutive-update packages were rebuilt.

Bridge manifest SHA-256:
`9fc02181af8ea32ce4190f0a74e5d7f4121ff145a4f8828e2896a838b6fd258f`.
Application ZIP SHA-256:
`8c39bb3006dce9a4d4dbeccac817e6ff1ec698e9c15e844fe398331cdf1f10d3`.
The existing DPAPI-backed Ed25519 release key signed the manifest, and the public
key verification passed. Authenticode remains deferred; this is QA media, not a
published release. The assembled native host digest matches build-Fy5M11.

`guest-topology-transition.mjs --optical` uses `Transitions/topology2/Execution`
and `updates/topology-optical`. Its predecessor guard requires the exact previous
rolled-back transaction and `Incorrect function.` reason, original dataset and
preservation snapshot, and an independently read terminal combined journal whose
selected source bytes match current.json. Normal source Doctor, signature,
publication, source-state, free-space and service checks remain. A fresh directory
is created exclusively; it never replays the beta.15 job. `--optical-recover`
recovers only the new context without starting another activation.

Eighteen focused JavaScript tests passed (candidate tool binding, previous rollback
admission and unchanged prepared-version reuse/preparation rules). Runner syntax,
PowerShell parsing and diff whitespace checks passed. Delivery verification checked
all 10 patch files, 111 guest inventory entries and the 43-module import closure
against the actual layered guest runner files, not just the newer host checkout.

Delivery is `output/final-validation/session-20260914-132941/topology-optical/`
(219,296,223 bytes); original replaced runner files and inventory are preserved
locally under its `original/`. Transfer pins the VM ID, destination, ordered file
allowlist and SHA-256; the new inventory is copied last. Run
`transfer-optical-transition.ps1` in HOST administrator PowerShell. After Delivered,
run `C:\HoneyBeeQA\final-integrated-20260914\HoneyBee-Optical-Transition.cmd`
inside the existing VM as bonsang without elevation. Accept the service UAC prompt.
Do not run the old preparation retry or integrated entry. Retain the new Execution
records and all old evidence. Transfer and guest activation are still pending.
No acceptance result was promoted, no gate added and no release published.

### Previous status: optical-volume failure confirmed and native correction built

The user ran the read-only volume probe on the existing VM. Four volumes returned
valid single-disk extents (three on disk 0, one on disk 1). The remaining volume,
`\\?\Volume{da10baf7-ada3-11f1-ab73-806e6f6e6963}\`, reported device type 2,
drive type 5 and `extentErrorCode: 1`, `Incorrect function.`. This identifies the
optical-volume disk-extents query as the observed Reserving failure.

`admitMaintenanceDiskVolumes` now permits this precise non-disk case only when
the extent query returns ERROR_INVALID_FUNCTION, a complete 12-byte
STORAGE_DEVICE_NUMBER response identifies FILE_DEVICE_CD_ROM, and GetDriveType
independently reports DRIVE_CDROM. It still rejects an optical identity matching
any expected VHDX volume. Other errors, inconsistent/unknown classifications and
truncated responses refuse maintenance. Expected-disk completeness and additional
volume checks remain unchanged. Open/query errors now include the volume name.
API contracts: [STORAGE_DEVICE_NUMBER](https://learn.microsoft.com/en-us/windows/win32/api/winioctl/ns-winioctl-storage_device_number)
and [GetDriveType](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getdrivetypea).

Ten focused optical classification cases passed. Full native module tests and
`go vet ./...` passed both in the repository and against the pinned external-Bee
overlay in the isolated build. Sandbox Go cache access was denied; these checks
ran successfully as the original host user outside the sandbox, without installing
or modifying any service. Host-only diagnostic execution remains skipped by design.

Corrected binaries: `output/topology-fix-builds/build-Fy5M11/build.json`.
Production SHA-256 `939e9cb089f49a5e201115ad6eaf09e7b10ab200dff82786c3267de29c23d8ff`;
QA SHA-256 `39a230a6edbf0949f7d5fdea07e6c89add3b8c0be614387ef9c397750590e14d`.
They are built only: not signed into application media, delivered, or installed.
The already published beta.15 guest directory must not be overwritten with these
bytes. The next delivery requires a new immutable candidate and a reviewed new
transition attempt that preserves the previous rolled-back attempt. Do not rerun
the preparation-retry entry or old integrated runner. No acceptance gate was added
or newly passed; no release was published.

### Previous handoff: Reserving rollback; read-only volume diagnostic

The preparation-admission patch was delivered and the reviewed retry reached
native activation. It rolled back with `Incorrect function.`; the saved result
reports beta.11 restarted with `renderer-loaded`. The bridge runner saved that
result only after checking the original dataset/registry snapshot, Doctor,
source pointer and source service digest. No qualification gate passed.

The user reported migration `migration-4bda97eea821234c99829e9faeb98e2d`
states `Prepared -> Reserving -> Resuming -> Resumed`, with worker SHA-256
`3021624f2f152d20a01277a93e6fbb16ddb20ca0d439f7fdf844e5f90fcc241a`.
This confirms the corrected worker ran, but service stop, cold backup and
replacement states were not reached. Combined transaction:
`6c55ec2fe97e259bca01e40d60a7496ace9cc43b380ae895f2d2785e86f5e9b6`.
The preparation-resume entry must not be reused now that activation records exist.

`admitMaintenanceDiskVolumes` queries disk extents for every enumerated volume
and currently returns an unlabelled native error. A non-disk volume such as the
VM's optical media is a hypothesis, not a confirmed cause. No production guard
has been relaxed. `TestMaintenanceVolumeExtentDiagnostic` records volume GUID,
drive/device type and the exact extent query result/error using read-only calls.
It never pauses the service, locks a volume, mounts or detaches an image.

The diagnostic binary was compiled and the host-only invocation correctly skipped
the VM-gated test. Guest execution remains pending. It is stored separately as
`native-volume-probe.exe` in the session directory, SHA-256
`046b6548cea250253db041662be6f4758232dd86a311f9d434eb937236c245f4`.
Use `transfer-volume-probe.ps1` in host administrator PowerShell, then run the
guest binary with quoted flags `'-test.run=^TestMaintenanceVolumeExtentDiagnostic$'
'-test.v'` in guest administrator PowerShell. A diagnostic PASS only means the
enumeration completed; it is not an acceptance pass. Retain its output and all
previous attempts. This diagnoses the existing failed gate, without adding gates.

### Previous handoff: bridge preparation admission fix

The user ran the bridge and reported `Service update requires interactive Setup`
with `false !== true`. The adapter inferred service admission from the media folder
name `service`, but the bridge's folder is `topology-bridge`. Its signed migration
manifest was correctly rejected because `allowServiceUpdate` was false. This guard
is before staging/preparation-job dispatch or native service activation in
`prepareSetupUpgrade`; no service replacement was reached on this code path.

`prepareMatrixUpdate` now accepts an explicit boolean `step.serviceUpdate`, which
the bridge sets to true. Both fresh preparation and authenticated prepared-version
reuse carry that classification. Existing service/app defaults and signature,
source-state, publication and UAC checks remain intact. This is an external QA
adapter correction; no application archive or signature changed.

The original `Execution/intent.json` and `Execution/failed.json` remain unchanged.
The new `-ResumePreparation` entry only accepts that exact assertion, matching
original intent/state, and an attempt containing exactly those two files (no job
or other records). It rechecks source pointer, service bytes, Doctor and the original
Git/registry snapshot, then creates `Execution/PreparationRetry` exclusively.
Another retry, unrelated failure or any activation evidence refuses this entry.
`-Recover` locates this new attempt when it exists; it never starts a new activation.

Eight focused tests passed, covering fresh/reused bridge admission, existing
preparation refusal rules, exact failure admission, state changes, activation-job
presence and repeat-resume refusal. JavaScript syntax and PowerShell parsing passed.
The small patch is 6 files / 37,971 bytes under the session's
`topology-preparation-fix`, with prior runner files preserved locally and the new
inventory copied last. Run `transfer-topology-preparation-fix.ps1` in HOST admin
PowerShell, then `HoneyBee-Topology-Preparation-Retry.cmd` inside the original
guest as unelevated bonsang. The original Setup gate was not removed. Delivery and
this reviewed resume have not yet been observed; qualification remains incomplete.

### Signed bridge preparation and first guest attempt

The populated QA installation can advance without replacing an existing version
directory. `output/topology-transition-builds/build-ySLwDx/result.json` records
fresh QA beta.15 and target beta.16/beta.17/beta.18 packages. The signed bridge
from beta.11 to beta.15 declares a real service replacement from
`0.0.0+cfa606fd4143.hb13.qa-baseline` to
`0.0.0+cfa606fd4143.hb13.topology1.qa-baseline`. Distinct component identities are
required by native migration admission; no same-component exception was added.
Bridge manifest SHA-256:
`d824146588cd80b4e99a33f5b05e5702a89340481fb82a75af8668043191e6d9`.

`guest-topology-transition.mjs` uses the installed launcher's verified recovery
trust, ordinary authenticated preparation and the existing combined transaction.
The reviewed external runner selects only the fully authenticated target native
coordinator; the normal default remains the source coordinator. The selection is
persisted as `nativeCoordinator: target` in the combined context. New recovery
code reauthenticates that target on resume; the unchanged legacy installed runtime
does not know this optional selection. If interrupted, the explicitly invoked
`run-topology-transition.ps1 -Recover` uses the external corrected runner and the
original durable job/context. The protected native recovery worker is already the
admitted target executable. No receipt, existing executable, bootstrapper or
recovery-runtime pin is edited to make the transition pass. No QA fault is armed
for the bridge manifest. A failed or rolled-back bridge is not automatically replayed.

The runner binds the original input hash, source pointer, host digest, original
guest/SID and baseline preservation snapshot. It requires source Doctor readiness,
then compares registry, project/workspace bindings and dirty Git files again after
the operation. Transition evidence is separate at
`Transitions/topology1/Execution`; original `Evidence` and `Matrix` stay intact.
The resulting beta.15 baseline must be explicitly linked to a new matrix evidence
namespace before the existing fixed service matrix continues. That follow-on
matrix handoff is pending the real bridge result; the old integrated command is
not yet the continuation command. Old candidate observations are not new-candidate
passes. The fixed 16-gate scope is unchanged; Authenticode remains deferred.

Fifteen focused tests pass, including authenticated-source/target refusal before
the external coordinator callback, legacy coordinator selection, target selection
after context reconstruction and target tamper refusal. Windows package-tool
fixture tests require the original host user rather than the sandbox token. An
initial test declaration was accidentally nested; that local test run was stopped,
the declaration was moved to module scope, and the final complete run passed.
The bridge and three later application manifests plus the service-pair manifest
were signed with the existing DPAPI key. Two Setup executables were built. None
has been installed, qualified, or published by this local build.

Delivery is 12 files / 219,303,487 bytes into the original guest bundle. Local
patch files and originals are in the session's `topology-transition` directory.
Run `transfer-topology-transition.ps1` from this session directory in HOST admin
PowerShell, then run `C:\HoneyBeeQA\final-integrated-20260914\HoneyBee-Topology-Transition.cmd`
inside the original guest as unelevated bonsang. Only the service operation asks
for UAC. There is no new VM, data cleanup or destructive baseline reset. Transfer
and guest execution remain pending; retain their actual output before advancing.

### Earlier package preparation (superseded by the bridge version sequence)

The corrected package build completed successfully in
`output/topology-package-builds/build-6aCu29`. `result.json` lists every installation
and Setup path; `lineage.json` binds the old and new input identities without
rewriting original evidence. Four isolated application installations (QA beta.11,
target beta.12, consecutive beta.13/beta.14), two Setup executables and three
application archives were produced. All four release manifests (three application
releases plus the service-admission variant) were signed with the existing DPAPI
Ed25519 key. Authenticode remains explicitly deferred for unsigned beta.

New target Setup SHA-256:
`b3baea8837e0eb0ae1d76a65888f1ca881b260e5247c20dad2bbc03e41e1ab81`.
Production manifest SHA-256:
`5a71af68d37ea142f14e2a3e92ea1709e4f5b2abca64bc061b47ba013f418fd1`.
QA service manifest SHA-256:
`6d073753abba83eecfc82e2306a7c2b8e4a7acbe5625a0da9c4813832be49172`.

Candidate assembly now accepts an isolated `HONEYBEE_QA_TOOLS_ROOT` and validates
the copied manifest/tool hashes before binding Desktop compatibility metadata.
Both production and QA builds receive actual payload hashes; QA-only tools cannot
enter the production build mode. Three focused tests pass. Existing assembly,
Setup embedded-media validation, signing authentication and final-input checks
also completed. The fixed 16 gates, interruption list and dataset requirements
match the previous inputs exactly. No acceptance pass was added.

The VM, original integrated bundle and active distribution/QA pointers have not
changed. The generic `output/two-version-qa/candidate.json` build scratch pointer
advanced normally; its previous value is preserved in `previous.json`.
No additional VM, guest bundle or disk cleanup was performed.

**Retry is not ready.** The existing installed beta.11 source companion executes
the native migration; replacing only beta.12 media cannot repair that coordinator.
The corrected source and target reuse version names already present in the VM but
have different hashes. Matching Setup Repair intentionally requires the original
approved bytes and cannot be used to overwrite them with this new build. The next
implementation must provide a recoverable, explicitly recorded QA baseline
transition, preserving the existing registry, Git edits, lease/VHDX state and all
prior recovery records. That transition is not implemented or executed by this
package build. Do not rerun the old failed case, overwrite executables/receipts,
or replace old evidence bindings as a shortcut. After transition, resume the
existing failed service case under the new identity; retain prior observations
with their original candidate scope. Publication remains disallowed.

### Native diagnosis and earlier handoffs

Latest confirmed result: TestMaintenanceParentAttachmentDiagnostic passed on the
original VM. The parent reported loaded=true/directlyAttached=false; the child
reported loaded=true/directlyAttached=true. The test performed no disk mutation.
`topology-probe-user-result.json` attributes this to user-provided console output.
The PowerShell command uses quoted whole arguments
`'-test.run=^TestMaintenanceParentAttachmentDiagnostic$' '-test.v'` to avoid the
earlier flag-tokenization failure.

Both fixed host binaries were built in isolated
`output/topology-fix-builds/build-FFzP8A`, using the pinned storage commit and the
validated external-Bee overlay. Production host SHA-256:
14e3124b26c84d57343bd39b634846d8c07acf8f730738e790e04cfc9ad21da5
(8,017,920 bytes). QA host SHA-256:
3021624f2f152d20a01277a93e6fbb16ddb20ca0d439f7fdf844e5f90fcc241a
(8,052,224 bytes). The actual overlay-linked host module tests passed. The first
isolated test invocation lacked its repository-relative Desktop public trust
fixture; copying the actual unchanged public trust file resolved this and all
tests passed. The earlier sandbox-owned clone attempt remains retained separately.

These binaries were initially built without packaging; the completed packaging
is recorded above. They are still not installed in the VM. The source companion coordinates
service migration, so rebuilding only the target package cannot fix the currently
installed QA source. Existing source receipts, launch/recovery manifests, signed
target migration admission and candidate-bound evidence must remain attributable
to their original bytes. Do not overwrite an executable and edit its receipt or
replace the original Evidence inputs to force a pass. Next packaging work must
produce a new authenticated source/target build and an explicit evidence lineage,
preserving the original project/workspace data and successful prior observations.
No fresh cleanup or deletion is authorized by this finding. The fixed 16-gate
scope is unchanged; only affected migration evidence needs the corrected build.

Current blocker is native topology admission: the worker returned RolledBack with
`unaccounted mounted image` for the known parent cache, restart Ready and source
Desktop beta.11. The requested checkpoint was not reached. User Get-DiskImage
evidence showed parent Attached=false/DevicePath=null and child Attached=true at
PhysicalDrive1. The IsLoaded-only orphan scan cannot distinguish a loaded backing
image from a directly attached disk. The native source now narrowly exempts a
validated, attached child's parent only when GetVirtualDiskPhysicalPath reports
ERROR_DEV_NOT_EXIST. Direct parent attachments, unrelated loaded images, and
other query errors remain refusals. Child reservation and cold backup/detach
IsLoaded checks are unchanged. API reference:
https://learn.microsoft.com/en-us/windows/win32/api/virtdisk/nf-virtdisk-getvirtualdiskphysicalpath

Full host-module tests passed outside the sandbox after restricted-token ACL tests
failed inside it; go vet passed. A five-case admission regression covers the narrow
exception and refusals. The read-only native-topology-probe.exe executes only
TestMaintenanceParentAttachmentDiagnostic on the pinned VM's existing two image
paths to verify actual provider behavior before rebuilding signed packages. The
error-code behavior still requires that guest observation. Probe delivery/execution
and replacement candidate packaging are pending. No installed service or pinned
candidate byte was replaced; existing final qualification remains incomplete.

Latest guest preparation failure: job-4tsrZG refused to overwrite beta.12, while
job-Fg6PEH had already completed ReadyForActivation for the same signed manifest
4525cf4d015f7a60fd5efad15628a62a4554b86889f41258eb753f5762dc3d41
and source pointer 16d3c33362da615fb60131f2099881f1f41f53e65bf7836954ff0483cd47b708.
The QA adapter incorrectly prepared the same immutable candidate again per case.
`prepared-reuse.mjs` now discovers one successful preparation bound to the current
pointer and expected manifest/version, authenticates staged media, revalidates
the source/plan and verifies published bytes before returning its original job.
Ambiguous, altered or unverifiable records fail; no directory is deleted, adopted
or overwritten. Fresh candidates still use normal Setup preparation. Both matrix
cases and the following normal QA activation use this helper; the production
activation path independently repeats its existing checks. This does not qualify
production installer retry UX. Nonce retirement also searches earlier attempts
when the immediately prior attempt failed before creating a controller config.
Twelve focused tests passed. Four support/inventory files are ready under
`prepared-reuse-fix`; guest execution remains pending. Resume only
`-RetryCase kill-service-backup-verified`; retain all prior preparation and failure
records. This change adds no gate and changes no production package.

Subsequent guest diagnostics found the original Git branch and dirty/untracked
files, the expected Library junction, and a ready retained lease journal
`lease-43d0116a8935f0e309d631b1488da3b2`. The broker nevertheless returned
`lease-not-active`; the persisted journal does not establish an in-memory session.
The earlier garbled Library lookup was a missing PowerShell UTF-8 decoding option,
not evidence of a deleted folder. A different-SID diagnostic was excluded; the user
subsequently confirmed the pinned guest computer/SID and repeated the lookup.

The bounded `resume-retained-qa.mjs` helper reuses the broker's `attach-retained`
operation (also used by Workspace Repair), retaining the exact registry and Git
preservation baseline. It requires the original guest/source pair, single first
matrix attempt, original lease/run/workspace identity and unchanged baseline
snapshot; it only attaches after `lease-not-active`. It persists intent/result in
Diagnostics, verifies returned lease/mount identity, compares the original full
snapshot again and requires Doctor readiness. Four local tests passed. Guest
reconnection remains pending; this is recovery of QA source readiness, not proof
of an update rollback or a new acceptance gate. Do not reset the snapshot or run
registry-rewriting Repair to manufacture preservation success.

On September 15 the user reported `dataset: Completed` and `baseline-health:
Completed`. The first service case stopped opening `native-ready.json` with EBUSY
in `kill-service-backup-verified-attempt-000`. The call is before spawning the
update worker, so this report is not evidence of an interrupted service migration.
The native controller may have armed its nonce; the existing explicit retry
passes that previous nonce to the privileged controller for retirement.

The controller previously created the final evidence pathname with FileShare.None
and then wrote/flushed it while the runner polled. It now writes and flushes a
unique sibling file, closes it, and moves it without overwrite to the final name.
Polling tolerates only EBUSY within its original deadline; malformed JSON,
permissions and native error records still fail. Readiness failures now emit a
bound cancellation record before returning, even if no update worker was spawned.
Eight focused JS tests and Windows PowerShell 5.1 publication/overwrite checks
passed. Three support/inventory files are prepared under `native-evidence-fix/`.
The guest run is pending. Use `transfer-native-evidence.ps1` on the administrator
host, then `run-integrated.ps1 -RetryCase kill-service-backup-verified` in the guest.
This keeps attempt 000, rechecks source health/data preservation and creates attempt
001 for this case. Completed Setup/dataset/health steps are retained. No production
artifact changed, gate expanded or acceptance promoted.

#### Dataset preparation failure after the collector fix

The user subsequently reported `preflight: Completed` and
`baseline-setup: Completed`, followed by failure in `dataset` at `cache prepare`
for project `25e6825e-4c06-4095-8721-0b4cc2acd985`. The CLI returned
`storage.operation-failed` with `The system cannot find the file specified.`
This does not identify the missing file or prove its cause. Do not rerun the
non-matrix dataset action or delete its partially registered project.

The provider-neutral adapter retains the upstream error code/operation but drops
its path; the CLI message alone is insufficient. The read-only diagnostic uses
the installed companion's `diagnose` and `control` entry points. It reads recent
parent request IDs from the existing client claim records and sends only `hello`
queries with those IDs: the inspected broker returns its cached response if
available, otherwise performs a harmless hello. It never issues another parent
creation, abort, repair or service restart. Diagnostic evidence is written under
the same bundle's `Diagnostics`, separate from the append-only QA sequence.
The returned diagnostic showed a valid running service and an already successful
cached parent-begin response, no registered cache/workspace, and empty SID storage
directories. A cached response does not establish that its mount is still live.
Source inspection identified a definite fixture defect: the synthetic Library
contains only `qa-cache.txt`, while `external-bee-dag-v1` finalization unconditionally
opens `Library/Bee`. The missing Bee tree explains the observed missing-file error;
the VM retry must still establish whether this is the only cause.

`integrated-dataset.mjs` now creates a regular synthetic Bee seed for fresh QA
datasets. `-ResumeMissingBeeDataset` explicitly admits only this pinned guest,
bundle and project, with the original single-commit clean Git dataset, no cache or
Workspace, and empty native state. The runner rechecks baseline health before
adding the missing seed. It never re-registers the project, repeats Setup, resets
Git, deletes state or aborts an unknown transaction. Original Started/Failed
events remain; ReviewedResumeStarted is durably appended before recovery, and
Completed is recorded only after actual cache/Workspace creation and dirty test
data succeed. A failed recovery cannot replay automatically or with that switch.

Fifteen focused local tests passed, including retained native/project state,
one-attempt evidence preservation and Windows CRLF checkout. Both PowerShell
scripts parse on 5.1.26100.9444; all 101 patched runner inventory entries match.
Five small helper/inventory files are prepared in `missing-bee-fix/`, with original
bytes and hashes retained. No candidate Setup, service, archive, release manifest
or inputs binding changed. Guest delivery and actual recovery remain pending.
Use `transfer-dataset-resume.ps1` on the administrator host, then the same bundle's
`scripts/qualification/run-integrated.ps1 -ResumeMissingBeeDataset` as the original
unelevated guest. Subsequent reboot resumes use the normal CMD entry point.

#### First preflight correction

The first guest run stopped before evidence-directory creation or installation:
the empty CIM service result became `{}` rather than JSON `null` when piped through
`Select-Object` on Windows PowerShell 5.1. This is a collector serialization bug,
not proof of a remaining service. `inspect-integrated-guest.ps1` now handles the
empty result explicitly. The regression test reproduces failure against the
original bundled collector; the fix passes absence, presence and failed-query
cases on PowerShell 5.1. No service operations are performed by these tests.

Only the collector and `runner-files.json` are patched in the same bundle. Original
bytes and before/after hashes are preserved under `preflight-null-fix/`. Candidate
Setup/archive/service/manifest bytes and input bindings are unchanged. Once the
two-file delivery is confirmed, the reviewed preflight failure may be retried
using the same command; no cleanup or completed migration is repeated. If a later
restore uses the clean checkpoint, reapply this QA patch because that checkpoint
contains the original collector. The acceptance gates are not promoted by this fix.

The user returned successful reuse evidence: `cleanBaseline: true`,
`readyForQualification: true`, and 29,282,254,848 bytes free before bundle transfer
(27.27 GiB). The empty old service registration is removed; old installation,
service files, user data and retained QA records remain in
`C:\HoneyBeeQA\Preserved-final-20260914`. See `reuse-success-user-report.json`.

All 117 integrated bundle files have now been delivered to
`C:\HoneyBeeQA\final-integrated-20260914`. Windows PowerShell 5.1 hashtable grouping
initially rejected the delivery inventory before copying; PSCustomObject records
fixed it, and a targeted 5.1 check covered unique and duplicated entries. The next
attempt transferred every file and created the clean checkpoint. Its immediate
chain check did not settle; a fresh full-chain read subsequently verified both
recovery points. Original attempt records are retained.

- Original state: `b59b1f40-cd3b-412b-a301-1d7775179aca`.
- Clean state with the bundle: `02b6a046-98fd-45c6-910e-12dbce3d7469`, named
  `HoneyBee-clean-final-bundle-20260914`.
- Authoritative handoff: `final-checkpoint-verified.json`. It records the full
  three-disk parent chain, candidate hashes, destination and approximately 60.8 GiB
  remaining host space. No restore test or actual installation test is claimed.

Run `HoneyBee-Integrated-QA.cmd` from that guest directory as the original
unelevated user. This starts the prepared service/app/rollback/interruption block;
it does not complete the separate production fresh-Setup UI/WinGet gates. The
clean checkpoint retains the same delivered bundle for those later checks. Before
any eventual restore, preserve new evidence; do not reset a failed case to hide it.
The fixed ten interruption points and affected-case-only retry rule are unchanged.

The host power-off helper is already available at
`scripts/qualification/host-poweroff.ps1`. The first forced-power-off case directory
is `C:\HoneyBeeQA\final-integrated-20260914\Matrix\poweroff-service-replaced-attempt-000`.
Only invoke that helper with the nonce actually reported at its held checkpoint,
within the five-minute window. It is not executed by bundle delivery.

### Earlier preparation records

- Candidate: production beta.12 in `output/distributions/distribution-mKs3Fp`.
- Integrated bundle: `output/integrated-qa/integrated-MtgfoJ`; 116 payload/runner
  files verified against their pinned sizes and SHA-256. The inventory file itself
  is the 117th file. Candidate hashes match the retained acceptance input.
- Existing evidence retained for all 16 gates in `acceptance-retained.json`;
  `verification-worksheet.json` maps each gate to its remaining coverage. No gate
  was promoted merely by preparing this session. Unchanged tests were not rerun.
- Elevated host inspection succeeded: pinned QA VM is running, guest file copy is
  enabled, approximately 70.6 GiB host space was free, and no checkpoints existed
  at the initial inspection. A preservation checkpoint has since been created.
- Two small read-only inspection scripts were delivered to
  `C:\HoneyBeeQA\final-inspection-20260914-132941`. The 1.37 GB bundle has not been
  transferred again; guest capacity and start state must be confirmed first.

## Current execution dependency

### User decision: reuse the existing VM

The user declined a second 64 GiB virtual disk and authorized preserving the
necessary state, then cleaning and reusing the existing QA VM. This supersedes
the separate-VM proposal below. The fixed 16 acceptance gates do not change.
First inventory registered projects/workspaces, QA payload sizes and preservation
records without following reparse points. Retain a recoverable baseline and
verify the preservation material before removing any selected old QA payload or
test installation. A size inventory alone does not authorize recursive deletion
or establish that user data has been backed up. No second VM is to be created.

The user returned the size inventory: no registered projects/workspaces, no
skipped/reparse paths, 20,630,066,769 bytes under `C:\HoneyBeeQA`, and only three
files (5,769,210 bytes) in the service store. The six explicitly selected old QA
directories account for approximately 19 GiB. Their ordinary files/results/logs
will be copied and hash-verified; excluded package binary bytes remain recoverable
in the checkpoint. The app, roaming data and service store are preserved by move,
not discarded. The service helper refuses any nonempty Workspace, nonempty
registry, unexpected store file, service identity or recovery-service registration.

Checkpoint `HoneyBee-before-final-cleanup-20260914`, ID
`b59b1f40-cd3b-412b-a301-1d7775179aca`, now preserves the original disk and running
state. Creation succeeded; the immediate lookup raced and failed, so a subsequent
fresh read verified the checkpoint and active child-to-original-parent disk chain.
Both records are retained (`vm-preservation.json`, `vm-preservation-verified.json`).
This is a same-host recovery point, not a second full disk copy or an independently
tested backup. Do not remove it during qualification. Guest deletion frees guest
space; it does not reclaim the original bytes retained by this checkpoint on host.

The VM-bound `reuse-guest.ps1 -Execute` preserves records, removes only the six
fixed old QA trees, requests service-only UAC, removes the proven empty service
registration and moves old application/service/user-data directories into
`C:\HoneyBeeQA\Preserved-final-20260914`. Changed files, reparse paths, active old
app/QA processes and existing preservation attempts stop execution. A failed
attempt is reviewed, not automatically repeated. The scripts passed syntax and
wrong-host refusal checks. The user's subsequent console output reached
`PreservingEmptyService` and reported a cancelled elevation request. In this
runner that stage follows completed QA record preservation and directory cleanup;
the service helper did not launch successfully. The attributed output is retained
as `reuse-uac-cancellation-user-report.json`.

`resume-reuse-guest.ps1` resumes only this interruption: it requires the completed
six-directory cleanup marker, the pinned checkpoint and unchanged service helper,
and refuses an already-started service/app preservation step. It does not delete
or repeat any QA tree cleanup. It requests service UAC again, preserves the old
installation and reports final clean-baseline/space conditions. A duplicate resume
is serialized with an exclusive file handle. Old evidence remains intact. Syntax
and wrong-host refusal passed; guest service reset and final readiness still await
execution.

The original user returned the guest inspection. It is retained as attributed
console evidence in `guest-inspection-user-report.json`; no repeat inspection is
required. The pinned computer/SID and unelevated user match. Git and WinGet are
available. HoneyBee, its ProgramData store and the running LocalSystem service
remain installed. Guest free space is 9.27 GiB, 6.73 GiB below the 16 GiB admission
minimum. The clean-baseline check failed. No installation test was started.

The host still has 70.57 GiB free. The retained Windows 11 evaluation ISO matches
its previously pinned SHA-256
`A61ADEAB895EF5A4DB436E0A7011C92A2FF17BB0357F58B13BBC4062E535E7B9`;
another download is unnecessary. The proposed recovery of test readiness is a
separate clean QA VM with the existing VM preserved, the same Windows 11 x64/NTFS
scope, 4 GiB RAM, two processors and a 64 GiB dynamic OS disk. This needs Windows
installation and new VM/user identity binding for the existing final bundle,
including the host power-off helper. Do not use the old VM-ID helper on a new VM.
No new VM or disk has been created; no current VM data has been deleted.

The command below is retained for evidence attribution, not a request to rerun it.

Run as the original, unelevated user inside the QA VM:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\HoneyBeeQA\final-inspection-20260914-132941\Inspect-Guest.ps1"
```

The script reports computer/SID, installation/store/service presence, C: free
space, Git/WinGet availability and boot time, and saves a uniquely named JSON
record. It changes no installation, service or VM setting. Preserve and return
that output. Do not run the integrated installer yet.

If existing installation/store/service state remains, stop baseline preparation.
There is no clean checkpoint to restore. Preserve that state; do not uninstall,
delete data, reset the VM, or treat an installation over it as a fresh-install
pass. Establishing a clean baseline needs a concrete preservation/recovery action
after the guest facts are known.

## Fixed execution checklist

| Gates     | Remaining execution / review                                                                                                            |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 01–02     | Final production Setup UI, fresh service and Desktop/Doctor; Git prerequisite and service UAC cancellation/retry.                       |
| 03        | Compatible ZIP registered-project adoption, preserved custom references and stable CLI paths.                                           |
| 04, 10    | Final discovery/download/progress/cancel/retry UI; work drain and duplicate request behavior.                                           |
| 05–09, 15 | Integrated populated-workspace sequence, two app updates, actual SCM migration, two rollback cases, fixed ten interruptions.            |
| 11–13     | Reuse unaffected refusal/capacity/lock tests; review changed integration and final trust binding without filling host/guest disks.      |
| 14        | Shared app Repair and identical service restart; distinguish safe refusal of unsupported service damage from successful reconstruction. |
| 16        | Local WinGet manifest/install and production Setup journey. Authenticode remains deferred.                                              |

The runner's order is baseline Setup, populated registered project, service fault
matrix, normal service update, matching Setup Repair, app fault matrix, and two
consecutive app updates. Seven kills, two guest reboots and one forced QA VM
power-off are the complete interruption scope. Sign in and resume the same runner
after each reboot; retain completed cases. The host power-off helper must be ready
before entering its five-minute held checkpoint.

The QA service source is instrumented; it is not a historical hb12 release. Local
QA update success is not public GitHub delivery evidence. The release-list query
in this session showed public beta.11 as newest; do not assume the beta.12 URL in
the production WinGet manifest can already be downloaded. Keep local installation
coverage and public delivery coverage separately attributed. No QA beta.13/14
publication or signature bypass is authorized by this checklist.

## Stopping rule

A failed case and its affected dependencies are retried after correction; other
cases and historical evidence remain accepted within their actual scope. Preserve
all failure evidence. Never reset the project to manufacture a preservation pass.

Finish when gates 01–15 pass and gate 16's non-Authenticode work passes with exact
candidate evidence. Keep gate 16 partial with Authenticode deferred; the separate
unsigned-beta readiness decision controls release eligibility. No release was
published, and no real VM migration/rollback case has run in this session.
