# Issue 46 cache preparation timeout

Implementation baseline: `release/beta35-verification` at `6ae6a41`, a descendant
of `v0.1.0-beta.35` (`7c175ea`). Work branch: `fix/issue-46-cache-timeout`.
The package version remains unchanged; the Git ancestry identifies the baseline.

## Behavior

Parent commit defaults to 600,000 ms and accepts
`HONEYBEE_PARENT_COMMIT_TIMEOUT_MS`. Other storage commands retain 120,000 ms.
Configuration is validated before parent creation and captured per storage instance.

The client tracks its own deadline rather than interpreting every killed process
as a timeout. A lost, malformed, or interrupted commit response produces
`storage.commit-outcome-unknown`. Core preserves the registered cache and skips
abort. Confirmed broker finalization failures still permit cleanup. Cleanup errors
preserve both the preparation error and the cleanup error.

The storage service and wire protocol are unchanged. This prevents Core from
racing abort against uncertain finalization; it does not add service cancellation,
transaction reconciliation, automatic recovery, or quarantine repair.

## Automated validation (2026-09-18)

- Focused Vitest suites: 84 tests passed across workspace storage, timeout policy,
  Core lifecycle, CLI JSON errors, and Desktop error transport/guidance.
- Beta.35 retained reconnection and reviewed baseline suites: 17 tests passed.
- Core and CLI TypeScript builds passed. Core, CLI, and all Desktop TypeScript
  configurations passed type checking.
- Desktop renderer, preload, and main production builds passed. Vite reported its
  bundle-size warning; there was no build failure.
- Desktop IPC/UI smoke passed using the development build and isolated smoke profile.
- Changed TypeScript files passed ESLint; changed files passed Prettier and Git
  whitespace checks.

Timeout tests use a fake clock to cover a 197-second successful commit, the
600-second deadline, configuration boundaries and capture, and unchanged ordinary
command deadlines. Core tests cover lost commit responses, mismatched parent IDs,
copy failure, and failed cleanup while preserving the registered cache.

The pnpm build entrypoint attempted an automatic dependency installation and
stopped at its non-interactive modules-removal guard. Dependencies were not purged;
the installed TypeScript and Vite executables were used directly for validation.

## Expanded verification (2026-09-18)

The follow-up verification used `pnpm_config_verify_deps_before_run=false` to
run the repository scripts against the installed dependencies without implicit
dependency installation. Evidence is retained under `output/issue-46-validation/`.

- Secret scan, license check, repository ESLint, all type checks, workspace build,
  and dependency-boundary checks passed.
- Root-directory Prettier traversal hit an access denial in an ignored historical
  QA directory. Explicit enumeration checked all 506 tracked/nonignored source
  files with the repository configuration and ignore rules; all passed.
- Full Vitest: 217 cases. The sandbox run passed 215 and failed two Windows activity
  ownership cases; all four tests in that affected suite passed outside the sandbox.
  The original failed output is preserved, not replaced.
- Remaining Node test groups passed all 410 cases: Setup (44), update (155),
  update trust (96), application repair (3), release keys (2), combined update (15),
  and qualification flow (95).
- Go tests passed for the storage host, launcher, and update package modules;
  launcher and update package vet checks also passed. Opt-in native VHDX scenarios
  are not implied by these ordinary Go test results.
- Separate CLI and Desktop candidates were built in their respective
  `release-issue46` directories. CLI package smoke, packaged Desktop IPC/UI smoke,
  and packaged interactive PTY smoke passed. PTY smoke required the ordinary user
  environment after sandbox GPU/profile failures.
- The CLI smoke allowlist was stale relative to beta.35. It now includes the five
  existing installation/update/recovery modules, while retaining exact-list checks.
- Both candidates contain the timeout setting and unknown-outcome code. Every
  bundled storage tool matches the prepared manifest SHA-256; candidate hashes
  are recorded in `package-identities.json`.
- The packaged CLI Core also passed a real-process test without fake timers:
  a synthetic response completed after 197,059 ms; a separate 500 ms override
  returned `storage.commit-outcome-unknown` after 512 ms and the timed-out client
  exited. `real-process-result.json` records the events. This exercised actual
  process waiting/termination, not native VHDX or service finalization.

No candidate was published or installed over the user's installation.

## Native qualification still required

The automated timing test is not evidence of a real 197-second VHDX operation.
Neither a large-Library native run nor a packaged Desktop large-cache run was
performed for this change. Existing installed storage and user caches were not
used for destructive or interruption testing.

Before release, use an isolated Windows storage installation and a disposable
Unity project whose parent commit exceeds 120 seconds. Exercise both the built
CLI and packaged Desktop at the default timeout; verify parent registration,
Doctor health, and preservation of previous caches, Workspaces, and Git changes.
In a separate disposable run, use a short override and verify no parent abort is
sent after expiry. Record the service's eventual result separately; Doctor alone
cannot establish the individual transaction outcome.

The user approved increasing the temporary VM disk budget from 32 GiB to 56 GiB.
The prior policy was backed up, both existing disks were preserved, and
`HoneyBee-Acceptance-beta32` (`ccc9250b-f335-483b-ae40-1323c39211f7`) was started.
An administrative monitor checks the 56 GiB disk limit and 12 GiB host free-space
floor every five seconds, pausing this VM on a limit breach or after six hours.
The two disks occupied 31.32 GiB before startup.

The candidate bundle and qualification launcher were transferred successfully
to `C:\HoneyBeeQA` in the guest. The archive SHA-256 is
`024c655616474a29eeade978e1c5be88829d04656a34a6924d31e0dbabeb29ab`;
the launcher checks it and all 188 bundled file hashes before execution.
The prepared harness uses a disposable 3 GiB synthetic Library fixture, packaged
CLI and real Desktop IPC, preservation checks, and a separate short-timeout run.
The user ran the harness in the guest. The first attempt stopped with an explicit
capacity-admission failure during parent commit (17,238 ms, configured timeout
600,000 ms), not a timeout. Evidence remains in guest directory
`C:\HoneyBeeQA\issue46-20260918-a1\run-LTjN5p`. The long-commit, Desktop, and
short-timeout gates remain unproven. Host inspection after the failure showed
34,198,381,056 bytes of temporary disks, 63,319,732,224 host free bytes, and the
capacity monitor still running, so the external 56 GiB budget was not exhausted.
The user's read-only guest diagnostic established 17,495,519,232 bytes free
(approximately 16.29 GiB), a 20 GiB service free-space floor, a 2 GiB child
reservation, and a 32 GiB store quota with only 103,809,388 bytes allocated.
The guest free-space constraint, not the store quota or external VM budget,
blocks admission. Even without further allocations, admission requires at least
22 GiB free; the full qualification additionally needs dataset/staging/parent
headroom. The harness's initial greater-than-20-GiB check was insufficient.

The supplied process log confirms failure at `small-baseline`, before creation
of the preservation Workspace or large dataset. The broker returned explicit
`storage-capacity-unavailable` for `commit-parent-capacity`; Core then aborted
that same transaction, and the abort returned `ok: true` after 164 ms. This is
the expected confirmed-failure cleanup path, not an unknown-outcome abort.
Subsequent status reports zero pending and quarantined transactions. These
observations do not establish the separate preservation or long-commit gates.
No automatic rerun, manual cleanup, or service-policy reduction was performed.
The user subsequently approved guest storage expansion. A disposable child VHDX
was successfully expanded from 1 to 2 GiB with the parent SHA-256 unchanged and
`Test-VHD` passing. The actual QA leaf VHDX was then expanded online from 64 to
96 GiB on its verified SCSI attachment. Its parent paths and parent file metadata
were unchanged, and `Test-VHD` passed afterward. Both shared ancestors were left
untouched. The host-side 56 GiB consumption budget remains in force.

The guest's C: partition has not yet been expanded: partition 4 is a 930,086,912
byte Windows recovery partition immediately following C:. A guest backup script
was prepared to copy the recovery files, compare the original and backup WinRE
image SHA-256, and report encryption status before any partition relocation.
It requests guest elevation when needed. No recovery partition was deleted,
Windows RE was not disabled, and no partition relocation has occurred yet.

The first recovery backup attempt failed with Robocopy error 53 while accessing
the volume GUID path; its failure evidence is retained. A revised helper uses
a fresh temporary folder mount, copies the recovery directory, verifies all
copied files with SHA-256, and removes only the temporary mount in `finally`.
This exact helper passed against a newly created 128 MiB test VHDX with a GPT
recovery-type partition, two synthetic files, and verified mount removal. This
is a backup-mechanism test, not a backup of the real guest's Windows RE image.
The user executed the revised guest backup successfully. All four recovery files
were copied and hash-verified; the temporary mount was removed. The verified
backup is `C:\HoneyBeeQA\winre-backup-v2-b2ba4c9d97b5400ea0383263b299b25a`.
Its 791,540,317-byte WinRE image has SHA-256
`2A99A47B94943F751F880770C47437B284FC02FF744C4D694F26BCBF25216C6E`.
Windows RE remained enabled at disk 0, partition 4. BitLocker reports used-space
encryption at 100%, unlocked, protection off, and no key protectors. Encryption
settings have not been changed.

A staged relocation script has been prepared: verify the pinned backup and exact
disk layout, create a new 2 GiB recovery partition at the disk end, restore and
verify the files, and register/enable Windows RE at the new location. It retains
the old partition and does not expand C: yet. Final removal of the old partition
and C: expansion must wait for confirmation of the new Windows RE registration.
The storage portion passed on a new 512 MiB test VHDX: recovery GPT type and
`0x8000000000000001` attributes, restore/hash comparison, temporary mounting, and
unchanged old partition layout. Windows RE registration itself was not tested
on the host. An initial check incorrectly used a CIM property not exposed by
this Windows build; it was replaced by direct GPT attribute and hidden-state
checks. One elevated launch was canceled; its replacement completed successfully.
The first guest relocation attempt stopped before mutation at the manifest-count
guard. Windows PowerShell 5.1 nested the JSON array inside `@(pipeline)`, yielding
one item instead of four. This was reproduced on 5.1.26100.9444; assigning the
parsed value first and then normalizing it fixes both counting and iteration.
A regression check passed four-file and invalid-count fixtures. The corrected
guest script is delivered separately as `prepare-new-winre-v2.ps1`; the original
guest script and failure evidence remain preserved. At that point no recovery
partition had been created or removed by the guest relocation script.

The user subsequently executed the corrected relocation successfully. The new
2 GiB recovery partition is disk 0 partition 5, offset 100,930,682,880, with GPT
attributes `0x8000000000000001`. Four files were restored and verified, Windows RE
was registered and enabled there, and the temporary mount was removed. Evidence:
`C:\HoneyBeeQA\winre-relocation-5cf822ca23d644bd9c8d05a190064d50`.
The old partition 4 still exists and C: has not yet grown.

A final-expansion script was prepared to reverify the pinned backup, active new
WinRE image/registration, exact partition layout, and unlocked/protection-off
encryption state before removing only old partition 4 and extending C: up to the
new recovery partition. It retains backup evidence and checks C: health, new
WinRE registration/image, EFI/MSR metadata, and encryption protection/lock state
afterward. These final guest operations have not yet run. The remove-and-extend
mechanism passed on a new 512 MiB test VHDX with file hashes preserved; this was
not a BitLocker test or a Windows RE boot test.

The user ran the final expansion successfully. Evidence is retained at
`C:\HoneyBeeQA\final-expansion-083a3f5268774d55946a3cc51f108f95`.
Only the old 887 MiB recovery partition was removed; the verified backup and new
active WinRE partition were retained. C: grew from 67,559,751,680 to
100,703,141,888 bytes, with 50,114,363,392 bytes free afterward. The final script
confirmed WinRE enabled at partition 5, unchanged recovery image SHA-256,
unchanged EFI/MSR metadata, and unchanged BitLocker protection/lock state.
This was not a boot into WinRE, and the cache qualification has not yet rerun.

Qualification v2 now checks actual service capacity against its free-space floor,
child reservation, and planned growth, both initially (16 GiB growth allowance)
and between major stages. Pending/quarantined work blocks a fresh commit. Nine
capacity-preflight regression tests pass, including rejection of the original
16.29 GiB-free guest and acceptance of the expanded guest. The original 188-file
package inventory and separately pinned updated helper hashes are verified by
the new launcher. Prior failed runs and the original helpers remain preserved.

The user executed qualification v2 in guest run
`C:\HoneyBeeQA\issue46-20260918-a1\run-BKKjS8`. Small-baseline preparation and
Workspace creation completed, and the 49,152-file/3 GiB fixture was generated.
The CLI large-cache parent commit exceeded the 600,000 ms default and returned
`storage.commit-outcome-unknown` after 600,120 ms. Request:
`hb-parent-commit-01727a88-38db-4bae-89d3-fdb5b6fd5b6c`; transaction:
`parent-82d4aceb2d7e53525f677d7a39465e38`. Thus the default-timeout completion gate
did not pass; Desktop and the separate five-second override test were not reached.
No default timeout increase or automatic retry was made in response.

Read-only host inspection afterward showed the VM Running, its capacity monitor
alive, 51,388,736,000 temporary-disk bytes, and 41,109,725,184 host free bytes.
There was no monitor stop record. Transaction outcome and no-abort/preservation
evidence still require guest inspection. A diagnostic was prepared to inspect
the original run and send only read-only status/hello queries; hello uses the
original request ID to obtain its cached result or join its in-flight response,
without resubmitting commit. A query deadline is not treated as a service failure.

## Confirmed late failure and recovery race investigation (2026-09-19)

The user's diagnostic completed in guest evidence directory
`C:\HoneyBeeQA\issue46-20260918-a1\run-BKKjS8\unknown-inspection-lWgFtD`.
The original request's cached response confirms `parent-commit-failed` at
`commit-parent`, with `workspace ownership mismatch`; it did not eventually
publish successfully. The diagnostic did not resubmit commit, send abort, or
restart the service. The large-run process log contains no abort. The registered
cache still points to baseline parent
`58228a2a43febb984828504eaa9d6a1d17846095adff1dbad0a0653f726ac87a`.
All four checked source/Workspace fixture files matched expected contents, and
the installed receipt, service executable, and original user registry hashes
were unchanged. These establish the observed timeout/no-abort/preservation path,
not the default completion, Desktop, or separate five-second override gates.

Service status reports zero pending entries, one quarantine entry,
`manualRecoveryRequired: true`, and `gcBlocked: true` because quarantine is
non-empty. No quarantine data has been removed or repaired. The capacity monitor
later paused the VM at 2026-09-18 15:30:39 UTC (00:30:39 KST), its six-hour deadline;
disk usage was 51,388,736,000 bytes and host free space 39,639,900,160 bytes, so
neither capacity threshold caused this pause. The VM was not automatically resumed.

The pinned upstream storage implementation contains a plausible matching race:
`Broker.Recover` calls `Store.RecoverPending` without excluding its active parent
sessions. A pending record older than the grace period with a non-live client
PID can be moved to quarantine. `Store.CommitParent` then maps a missing pending
record to ownership mismatch even when its in-memory ownership token matches.
The managed service runs recovery every five seconds with a 30-second grace.
Moreover, the Windows adapter defaults a parent-begin owner PID to its own
short-lived CLI process; this path can become eligible independently of the later
commit client's timeout. Do not infer that killing the commit client alone caused
the observed failure.

A tiny local fixture using the exact pinned upstream module reproduced the
recovery/publication ordering: live-client control preserved pending, while the
dead-client case moved staging to quarantine and subsequent publication returned
ownership mismatch despite a matching token. Evidence:
`output/issue-46-validation/pending-race-repro-2576967308/result.json`.
This is a deterministic Store-level reproduction, not proof of the precise
timing of this guest incident. The quarantined transaction journal must still be
correlated with the failed request before claiming that complete causal chain.
No upstream dependency/service implementation has been changed in this investigation.

## Authorized service recovery fix: hb14 candidate (2026-09-19)

After the user approved expanding the implementation to this race, the existing
SHA-pinned external Bee overlay was updated on the same cfa606fd4143 upstream
base. The HoneyBee branch still descends from `v0.1.0-beta.35`. The new component
identity is `0.0.0+cfa606fd4143.hb14`, not a new app release or installed version.

`Broker.Recover` now snapshots matching service-owned parent sessions before
pending recovery. Transaction ID, compatibility digest, and ownership token
must match; a stale/dead begin CLI PID cannot override that ownership. A separate
mutex excludes recovery from the durable-journal/native-session registration
gap. Finalize does not hold that mutex, so pending recovery can finish while
large finalization remains in progress. Successful commit/abort removes session
protection; a restarted broker still applies the existing orphan rules.
Abandoned or failed sessions retained by a running broker remain protected until
explicit lifecycle completion or restart. This deliberately favors preserving
uncertain data over reclaiming it from PID/grace alone. This change does not
repair existing quarantine, increase the timeout, or lower capacity safeguards.

Validation completed for this candidate:

- Six regression tests cover an exited begin CLI, recovery during gated Finalize,
  the unregistered begin-journal gap, restart/orphan quarantine, mismatched
  ownership, and explicit abort. With only the old recovery call restored, the
  exited-CLI and concurrent-Finalize tests both fail by observing quarantine;
  restoring the fix makes them pass.
- Patched storage `go test -race ./... -count=1 -timeout=180s` and `go vet ./...`
  pass. All six recovery tests also passed 100 race-enabled repetitions.
- Host `go test -race ./...` and `go vet ./...` pass with a Go workspace explicitly
  replacing the pinned module with the patched source. The sandbox run encountered
  Windows ACL failures; the same suite passed under the ordinary user outside
  the sandbox. This is not an installed SCM/VHDX test.
- Normalized destination provenance check passes 50 destinations, including the
  original 42 frozen entries and 23 overlay entries; the frozen manifest is intact.
- Production `prepare-tools.mjs` successfully applies the cumulative patch to a
  fresh pinned clone and builds all three executables. Existing tool outputs were
  copied to `output/issue-46-validation/pre-hb14-tools` first. Original packaged
  hb13 QA artifacts and all guest evidence remain unchanged.

Patch SHA-256:
`49649cd9661afb67185521092a4916fcf9fb77f22640823f5e4078a337aa4eff`.
Candidate host SHA-256:
`70079f275d3d981c338dde6df6d76cdb1a8358bfbf846b2a0af89676227cdcf3`.
Build identities are in `apps/desktop/.tools/win32-x64/manifest.json`; test logs
are `output/issue-46-validation/hb14-storage-tests.log` and `hb14-host-tests.log`.

Remaining gates: correlate the preserved guest quarantine journal; prepare and
hash-bind hb14 QA packages; safely install the candidate only in the guest with
the prior evidence preserved; rerun real large-cache CLI and Desktop completion,
the separate short-timeout preservation path, and restart recovery. The existing
quarantine blocks blindly rerunning qualification. Neither native qualification
nor the issue as a whole is complete. No VM resume, service installation/restart,
quarantine cleanup, commit, or push was performed for this candidate.

## Guest diagnostic handoff (2026-09-19)

The user approved proceeding with guest qualification. Fresh host inspection
found the VM Off (not Paused), with no remaining monitor. Its sole attached disk
was the expected `fresh-beta35.vhdx`; temporary disks totaled 51,376,153,088 bytes
and host free space was 25,371,398,144 bytes. The VM was booted under a new
six-hour capacity monitor retaining the approved 56 GiB disk budget and 12 GiB
host floor. Boot may run the existing service's startup recovery; no separate
service restart or candidate installation was issued.

The read-only diagnostic was transferred successfully to
`C:\HoneyBeeQA\inspect-hb14-quarantine.ps1`. It binds the specific failed
transaction, compatibility digest, SID and staging path against the quarantined
`pending.json`, refuses reparse-point source paths, and preserves a hash-verified
journal copy in a fresh subdirectory of the existing failed run. The guest user
must execute it and return its output before installation/recovery decisions.
It does not delete, move or repair any store entries. Host transfer evidence is
`output/issue-46-validation/hb14-diagnostic-transfer.json`; monitor heartbeat and
stop records have an `hb14-capacity-` prefix and do not replace the old records.
Only about 8.2 GiB of the temporary-disk budget remains. Recalculate native-test
growth before launching a fresh large fixture; no large test has been rerun.

The user returned successful guest quarantine inspection at 09:23:17 UTC.
Transaction ID, compatibility digest, SID, and original staging path all match
the failed commit. The journal's created/updated timestamp is
`2026-09-18T13:05:54.5614991Z`, with client PID 7092. Its SHA-256 is
`a75b7789561ed3083673ed3b05931aacc64ea16d170913d4bf900fb05c870a21`.
The preserved directory contains `bee-seed`, a 3,372,220,416-byte staging VHDX,
and the 1,505-byte journal. Evidence copy:
`C:\HoneyBeeQA\issue46-20260918-a1\run-BKKjS8\quarantine-inspection-b32f9a7289014638902a1e377ea01975`.
There are zero pending entries and one quarantine entry; hb13 is still Running
with its expected executable digest. Guest free space is 44,387,323,904 bytes.
This correlates the quarantine with the failed transaction, but does not measure
the precise quarantine/finalization timing or explain the full 600-second runtime.

A guest-only hb14 installer handoff was prepared. It pins the old/new executable
hashes, checks user/root identity and idle status, preserves verified copies of
the old executable/config/receipt/journal, and invokes the existing installer
with explicit replacement. A one-shot marker prevents blind reexecution after
an installation attempt. Postchecks require hb14 identity, service Running,
unchanged config/journal, zero pending/active children, and the original single
quarantine. No cache test or quarantine cleanup is included. Installation is
not considered completed until the user returns its result.

The user confirmed successful guest installation at 09:36:00 UTC. Evidence:
`C:\HoneyBeeQA\issue46-hb14-20260919\install-evidence-35968e303c474224ac469b9973391c3f`.
The old executable/config/receipt/journal backup was verified. The service is
Running as hb14 with SHA-256
`70079f275d3d981c338dde6df6d76cdb1a8358bfbf846b2a0af89676227cdcf3`.
Config and quarantine journal remain unchanged; the original quarantine entry
remains and `gcBlocked` is true. Guest free space is 44,368,785,408 bytes. No cache
test ran and no quarantine was removed. Clearing the store's quarantine by
archiving the exact failed transaction elsewhere requires a separate, explicit
recovery decision; it is not implied by candidate installation. A same-volume
archive preserves evidence but does not free guest/host disk space, so the
remaining native-test growth budget must still be assessed independently.

The user approved archiving the specific failed quarantine transaction without
deletion. `archive-hb14-quarantine.ps1` was prepared for elevated guest execution:
it binds guest/SID/component/journal identity, requires idle status, stops the
service, refuses pending work or attached/unknown VHDX state, and inventories all
files (SHA-256) and directories without traversing reparse points. It moves only
the exact transaction directory to a fresh same-volume QA archive, verifies an
identical post-move inventory, and only then restarts the service and checks
unblocked status plus unchanged parent/retained-child counts. A failure preserves
all evidence and may intentionally leave the service stopped; a one-shot marker
prevents blind retry. No deletion, VHDX detach, GC, or cache prepare is included.

The inventory helpers passed Windows PowerShell 5.1 fixture tests for file/empty
directory coverage, equal inventories after a same-volume move, and detection of
same-length byte changes. This is helper validation, not guest recovery success.
Actual archival remains pending the user's returned execution result.

The user confirmed successful archival at 10:06:20 UTC. Destination:
`C:\HoneyBeeQA\issue46-hb14-20260919\quarantine-archive-9989820688504652b3b0dee38f7120cb\parent-82d4aceb2d7e53525f677d7a39465e38-parent`.
Before/after inventories both contain 49,155 files and 49,348 total entries;
both manifest hashes are
`8337d842dbe72ae9b0ce0918a83a630f21362e2928ff2dcb32e74148be51c4e2`.
The VHDX was confirmed detached before movement. No files were deleted. The
service is Running with pending/quarantine/active-child counts all zero,
`manualRecoveryRequired: false`, and `gcBlocked: false`. The two parents and
two retained children remain. Guest free space is 44,460,974,080 bytes.

The next full fresh-run capacity gate is not yet satisfied on the host. Monitor
heartbeat at 10:12:40 UTC reports 51,376,153,088 temporary-disk bytes (47.85 GiB)
under the approved 56 GiB cap, leaving 8.15 GiB. Host free space is
23,725,182,976 bytes (22.10 GiB), leaving about 10.10 GiB above its 12 GiB floor.
The existing harness requires 16 GiB initial growth headroom and 11 GiB before
the large CLI stage; a fresh complete run must not be launched under these
limits. Guest free space alone is not sufficient evidence of host capacity.
Proposed readiness targets, not authorized changes: at least 28 GiB host free
space and a 64 GiB temporary-disk cap, preserving the 12 GiB host floor. Each
later phase still needs fresh measurements; these targets do not guarantee all
phases fit. No budget was increased and no old fixture/archive was deleted.

## Authorized output cleanup before rerun (2026-09-19)

At the user's request, removed 159 SHA-256-identical historical generated binary
copies while retaining and re-verifying their canonical copies, plus the unused
Windows evaluation ISO after checking all VM DVD references and host mount state.
No VM disk/parent or issue #46 evidence was removed. Observed host free space
increased by about 9.14 GiB to 30.66 GiB. Deletion/restore mappings and ISO receipt:
`output/cleanup-20260919/`. The ISO requires re-download if needed; duplicate
binaries are recoverable from the recorded canonical copies. The earlier 56 GiB
VM disk-use cap remains unchanged, so the separate growth-budget gate remains.

After native testing completes, the user requested a Docker feasibility review
for test execution, including which native Windows storage gates still require
the VM. That review is deferred until the current tests finish.

## hb14 CLI rerun handoff (2026-09-19)

The user approved revalidation after cleanup. The temporary VM disk-use cap is
now 64 GiB (not a VHDX resize); the 12 GiB host-free-space floor is unchanged.
The old 56 GiB policy was backed up, a new six-hour monitor was verified before
stopping the old monitor, and no existing VM/evidence file was deleted.

Core/CLI were rebuilt and packaged separately at
`apps/cli/release-issue46-hb14/HoneyBee-cli-win32-x64`. Packaged CLI smoke and all
nine capacity-helper tests pass. The CLI-only guest stage preserves the existing
3 GiB/49,152-file fixture specification, default 600-second parent commit limit,
and greater-than-120-second timing gate. It creates a fresh source/registry and
baseline Workspace, stops after CLI completion/preservation checks, and does not
claim Desktop, short-timeout, or restart qualification. Any operation failure
stops with evidence preserved and no automatic rerun.

The 94-file candidate bundle is 9,499,610 compressed / 17,138,588 payload bytes,
SHA-256 `7bda95808f89530bc3129b84739fe63b44f1044a7c6d164f2d4cdb672ddfca9b`.
It reuses the old guest Node runtime only after verifying its pinned digest.
The old packages and runs are unchanged. Transfer succeeded at 11:50:33 UTC:
host free space 32,798,638,080 bytes, temporary disks 51,376,153,088 bytes,
planned growth 16 GiB plus transfer overhead. The launcher requires this host
readiness record to be at most 30 minutes old, independently of the live monitor.
Run `C:\HoneyBeeQA\run-hb14-cli.ps1` as the normal guest user. No native rerun
result has yet been received. Desktop hb14 packaging/compatibility binding and
later phases remain pending; do not run the old full harness against hb14.

## hb14 native CLI deadline exceeded — outcome pending (2026-09-19)

The user ran the new CLI stage in
`C:\HoneyBeeQA\issue46-hb14-cli-20260919\run-QnIBxS`.
Initialization, small baseline, Workspace creation and the 49,152-file fixture
completed. The large commit returned `storage.commit-outcome-unknown` after
600,112 ms, with request
`hb-parent-commit-25a27fd5-935a-40fd-983c-ebcb18f12147` and transaction
`parent-a1151dd192ee871fef142a15e375a366`.
The 600-second native completion gate therefore still fails with hb14. This
alone does not establish a repeated ownership/quarantine failure or the eventual
service outcome. No deadline increase, retry, abort, cleanup or service restart
was performed in response.

Host monitor heartbeat at 12:15:41 UTC remained live with 53,859,181,056 temporary
disk bytes under the 64 GiB cap and 23,379,394,560 host free bytes above the 12 GiB
floor. A new read-only diagnostic binds the exact new request/transaction/run,
checks baseline cache and fixture preservation, obtains the cached/in-flight
response through hello (not a resubmitted commit), and records storage status
before and after the query. The diagnostic can take up to approximately two
minutes. Service outcome remains unconfirmed until its returned evidence arrives.

## hb14 eventual commit confirmed; default completion still fails (2026-09-19)

The user returned diagnostic evidence from
`C:\HoneyBeeQA\issue46-hb14-cli-20260919\run-QnIBxS\unknown-inspection-CRUEMV`.
The exact original request completed successfully after the client deadline.
Commit started at 12:03:46.100 UTC and parent metadata was published at
12:19:46.338 UTC; broker `parentVerifyMs` is 960,142 ms (about 16 minutes).
That metric wraps the broker commit path, not only a checksum operation.
Begin-to-commit-start was 66,240 ms. The child-process observer measured
600,088 ms at client exit; the outer CLI error reported 600,112 ms.

The diagnostic first observed pending=1/quarantine=0, and then pending=0,
quarantine=0, parentCount=4 after receiving the successful original response.
`gcBlocked` and `manualRecoveryRequired` remained false. The published immutable
parent is `76c92d104f3cbf775e4b61ef005812bac9fed0b26288fc81c33a3eaa23ef6a41`.
Its VHDX is 3,372,220,416 bytes; Bee seed logical bytes are 3,221,225,487.
The registered cache remains the original baseline
`cae71ea8a4e72aeb8329ac6fdbbd5f6fdbc156065a21ac59a5b7c1bd70176d97`.
No abort appears in the large-run process log. The four checked source/Workspace
files, installed receipt/service, and original user registry are unchanged.
No commit resubmission, service restart, or cleanup was issued by the diagnostic.

This execution supports active-session recovery protection and the real native
unknown-outcome/no-abort/preservation behavior. It does not pass the default
600-second completion gate, register the late parent in Core, or prove Desktop,
the separate short-timeout gate, or restart recovery. Do not manually rewrite
the application registry merely because a late parent now exists.

Source inspection identifies candidate costs, not a measured bottleneck:
`windowsParentSession.Finalize` externalizes Bee, flushes/detaches, remounts for
verification, then hashes the VHDX; `beeTree.copyTo` syncs every copied file,
and seed digest/usage validation walks the pinned tree multiple times including
commit validation. The next diagnostic should measure these phases separately
before changing durability semantics or increasing the timeout. No such runtime
optimization or timeout increase has been made. Preserve this completed run for
comparison; Docker feasibility review remains after native test completion.
See the local
`output/issue-46-validation/native-execution-plan.md` for exact scope and gates.

## hb15 heartbeat contract — local validation (2026-09-19)

The fixed 600-second parent-commit deadline is superseded by request-specific
heartbeat and worker-progress observation. This is not a larger total timeout.
The original synchronous commit has no total execution timer; its pipe remains
part of normal service drain handling. An authenticated, uncached observation
request binds the original request ID, transaction ID and broker instance.
Polling does not advance the worker progress counter.

Core polls every 5 seconds with a 10-second query deadline. Heartbeat loss is
bounded by a 30-second threshold (plus polling/query granularity); actual worker
inactivity defaults to 120 seconds. `HONEYBEE_PARENT_COMMIT_IDLE_TIMEOUT_MS`
configures inactivity, not total duration. The obsolete
`HONEYBEE_PARENT_COMMIT_TIMEOUT_MS` is rejected before parent preparation.
Missing capability prevents commit submission. Service restart, stalled work or
lost transport triggers one read-only reconciliation; an unconfirmed outcome
preserves the transaction without automatic abort, cleanup or resubmission.
Opaque native calls without checkpoints can still reach the inactivity guard;
that is uncertainty, not proof of service failure.

Candidate component version: `0.0.0+cfa606fd4143.hb15`.
Overlay SHA-256:
`f36bbbfddc507c1e07b59eac895dd90e3512fa67f740fdc88505934b0b1a3951`.
CLI SHA-256:
`48529ff2d085f391d8bd26165ca832977e25edd8a78cb2e6a497102150881cf6`.
Host SHA-256:
`9dc849478158472a7f9e473b93603047ee76ea18fe79e02c67724ea16cad9532`.
Desktop compatibility metadata binds those exact payloads. Separate
`apps/cli/release-issue46-hb15` and `apps/desktop/release-issue46-hb15` packages
preserve previous candidates.

Local validation passed:

- All 210 Vitest tests across 35 files in one ordinary-user run, including
  23 heartbeat tests and a simulated 90-minute progressing commit.
- Workspace build and typecheck; ESLint for the changed storage/test files.
- Patched upstream Go race tests and vet; nine focused progress/recovery tests
  repeated ten times with race detection.
- Host Go race tests and vet against the patched upstream module.
- Frozen-source provenance verification (52 active files, 25 overlay entries).
- CLI packaged smoke and Desktop packaged IPC/UI smoke.

The guest is still on hb14. No hb15 service installation, native cache rerun,
restart recovery qualification or release has occurred. The old total-timeout
harness must be updated before native revalidation: prove completion beyond
600 seconds while progressing, plus heartbeat loss/stall preservation and final
cache publication. Existing hb14 evidence and the late committed parent remain
untouched. Docker feasibility remains deferred until native testing finishes.

## User-approved Docker transition and VM retirement (2026-09-19)

The user explicitly changed the sequence: export evidence, retire the QA VM,
and move portable tests to Docker before completing hb15 native qualification.
The previous guest-retention/Docker-deferral note above is historical.

The latest guest was shut down normally and both QA leaves were mounted
read-only for export. The archive at
`output/issue46-vm-retirement-20260919` preserves 205,065 latest-guest files and
7,433 older-guest files, per-file SHA-256 manifests, eight link/reparse records,
guest WinRE/installation/quarantine backups, storage images and VM configuration.
A 12 GiB host-space guard paused copying safely; content deduplication and
retiring the already-exported older leaf provided room to finish.
The archive README documents independent restore overrides for 12 locked
`app.asar` paths; their verified `.payload` copies must be retained.

After export and dependency checks, VM
`ccc9250b-f335-483b-ae40-1323c39211f7` and exactly four dedicated disk files were
removed: `acceptance.vhdx`, `fresh-beta35.vhdx`, `shared-parent.vhdx`, and
`system.vhdx` under the acceptance-completion directory. Approximately 106.6 GiB
of logical disk files were removed. The guest OS is no longer recoverable as a
bootable VM from this evidence-only archive. Existing host evidence and unrelated
small VHDX test fixtures were retained. See the archive's retirement receipts
and `summary.json` for exact byte counts and final free space.

Docker Engine Community 29.8.1 / Buildx 0.37.1 were installed using Docker's
official Ubuntu repository in the existing `Ubuntu-24.04` WSL distribution.
No Docker Desktop or new WSL distribution was installed. Engine/socket/containerd
automatic startup is disabled; all three services were stopped after testing.

The digest-pinned Linux image passed all 41 selected tests (23 heartbeat,
18 tool-pair), with no skips, using a non-root container, no runtime network or
host mounts, dropped capabilities, a 1 GiB memory limit and two CPUs.
`tests/docker/run-wsl.ps1` was tested on PowerShell 7 and Windows PowerShell 5.1;
final evidence is `output/docker-issue46-e3162c4840644abdab13166c1bf31f66`.
The image is approximately 747 MB; no stopped containers or Docker volumes remain.

These are mocked portable contract tests, not native Windows VHDX/SCM/NTFS,
worker-progress, crash/restart recovery or Desktop acceptance tests. hb15 native
qualification is still unperformed; completing it requires a new Windows test
environment. The issue is not declared fully qualified or released.

## Release request preflight (2026-09-19)

The user requested completion of verification and publication. GitHub inspection
confirmed beta.35 remains the latest public prerelease and no issue-46 PR exists.
The working feature branch is based on beta.35 and its follow-up commits.
No new tag, release, PR, push or installed service mutation was performed in this
preflight. The retired QA VM was not silently recreated.

`pnpm verify` passed secret and production-license checks, then stopped at two
pre-existing private analysis Markdown files excluded by `.git/info/exclude`:
`workspace-storage-analysis-2026-09-07.md` and its ` copy.md` counterpart.
Their content was not edited and they must not enter a release commit.
This aggregate command is not recorded as passed.

The remaining canonical commands were run separately and passed: `pnpm lint`,
`pnpm typecheck`, `pnpm build`, `pnpm test:run`, and `pnpm deps:check`.
The test run includes 210 Vitest tests and 413 node:test cases (623 total), plus
the Go host/launcher/updater checks. hb15's patched upstream source also passed
fresh `go test -race ./... -count=1 -timeout=180s` and `go vet ./...`.
Evidence is in `output/issue-46-validation/release-*.log`.

Inspection found the candidate builder still admitted only hb13 production
tools. Its explicit allowlist now also admits hb15; seven focused tests pass,
including rejection of hb15 qualification-only tools and an unreviewed hb16.
This corrects candidate construction, not acceptance or publication readiness.

Actual hb15 Windows VHDX/SCM and affected update/preservation/recovery cases remain
unproven. Docker's 41 mocked contracts cannot supply that evidence. A separate
Windows 11 test PC or renewed, explicitly budgeted temporary Windows 11 VM is
needed before final acceptance and public release. The user was asked to choose
the environment; the existing host service is not an implicitly authorized target.
The fixed release gates and candidate-hash binding remain enforced.

## Docker-first expansion (2026-09-20)

At the user's request, `tests/docker/run-wsl.ps1` now defaults to the full
portable lane; `-Suite contract` retains the original 41-test focused lane.
No additional VM installation, cache generation, disk expansion or cleanup was
performed during this expansion. The fresh NTFS VM remains reserved for
Windows-only checks; its guest preflight found no Git or HoneyBee service.

Final successful evidence:
`output/docker-issue46-d949baba07f241259b850a42df66cb01`.
All 27 stages passed, including source secret scanning, production-license audit,
scoped source formatting, lint, typecheck, CLI/Desktop build, test-module build,
dependency boundaries, the test suites and Go vet/race checks.

| Suite                   |   Passed |                     Explicitly skipped |
| ----------------------- | -------: | -------------------------------------: |
| Vitest                  |      207 |                 3 Windows-native cases |
| Node contracts          |      323 |      90 Windows lifecycle-helper cases |
| Python analysis         |       46 |                                      0 |
| Go top-level tests      |      113 | 10 platform/filesystem-dependent cases |
| Pure PowerShell scripts | 2 suites |     1 Windows-identity inspector suite |

Go's 181 passing results including subtests must not be added to its 113
top-level count. Eight Go skips require native CoW unavailable on this container
filesystem, and two require Windows launcher behavior. Windows build-tagged Go
tests are listed in platform inventories, not executed; in particular, the
storage-host Linux package's no-test-files result is not native service proof.

Linux portability changes affect test fixtures and platform annotations, not
production behavior: real Linux Git is exposed under the `git.exe` name, registry
fixtures use absolute paths, the Library ignore rule covers both junctions and
symlinks, and Doctor still reports Linux as unsupported. Windows-only test bodies
remain runnable in Windows CI. Runtime containers use a non-root account, no
network, no host mounts, no extra capabilities, and are removed after execution.

The expanded race run exposed a pre-existing test-fake race in upstream
`TestRetainedRemovalAbortAndExpiryReleaseReservation`. An explicit test-only
patch changes its counter to `atomic.Int32`; the full race suite and 50 repeated
runs of that case pass. Patch SHA-256:
`3977d6b74dcd9879bf89331c9def2735953d091efec0eebce079085f61149fb2`.
The preparation step allows only `workspace/broker_test.go` and
`workspace/removal_test.go` in that patch. Production overlay SHA-256 and hb15
binary identities are unchanged. The original failed race evidence remains in
`output/docker-issue46-4c01ab6e831148f48407357b117ac8a6`.

This passes the portable lane, not Windows acceptance. Actual installed-service
communication, NTFS/VHDX operations, packaged Windows UI/PTY, affected update and
preservation checks, and real long-running worker liveness remain separately
unproven for hb15. No tag, public release, PR or push was made by this Docker work.
