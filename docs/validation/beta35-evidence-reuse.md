# beta.35 evidence reuse review

Candidate: Setup `643a944173291018a9d2a357f7edf52874f874dfd644f01e9b1b60ace2c40c04`,
manifest `5d895f4e603c423ea99e3387e61f2e2fa02dd54a7f9436a9be7b68e8179c7df4`.

The source comparison is `output/reboot-fix-20260917/change-impact.json`.
Desktop sources and update modules are identical to beta.32; CLI differs only in
the version constant. Native storage binaries and their manifest are identical.
The runtime changes add a recovery-only strict heartbeat option and reconnect
retained workspaces when recovery Doctor fails exclusively on workspace repair.
Default heartbeat behavior remains unchanged and is regression tested. The
changed recovery branch passed the real beta.35 reboot case with original
project/registry/Git preservation and unchanged service receipt, according to the
attributed guest report. Publication policy changes do not alter Setup execution.

| Gate                                               | Decision and retained evidence                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 01 Fresh Setup                                     | Exact Setup SHA matches `reported-fresh35-uac-pass.json`. The attributed guest report confirms a fresh installation, ready Doctor and usable real Desktop on the separate clean disk.                                                                                                                                                                                                                                                      |
| 02 Missing Git and UAC                             | Same report confirms actual UAC cancellation followed by successful retry. Missing-Git behavior reuses the unchanged prerequisite implementation and previously recorded test. Earlier failed attempts remain preserved.                                                                                                                                                                                                                   |
| 03 ZIP adoption                                    | Reuse beta.32 pass. Setup adoption entry and managed binding implementation are unchanged; original exact registry backup and service receipt checks remain the evidence.                                                                                                                                                                                                                                                                  |
| 05 Consecutive updates                             | Reuse beta.32→33→34 pass. Signed source approval, preparation, activation, session and update modules are unchanged. New recovery behavior is covered separately by the beta.35 reboot pass.                                                                                                                                                                                                                                               |
| 06 Service migration                               | Reuse the accepted supported QA-source→production migration pass. Production service bytes and coordinator are unchanged. This does not qualify migration from public hb12.                                                                                                                                                                                                                                                                |
| 07 Workspace preservation                          | Reuse original dirty/untracked/Unicode fixture evidence, supplemented by exact snapshot comparison through manual beta.35 baseline preparation and automatic reboot recovery.                                                                                                                                                                                                                                                              |
| 10 Drain, terminal cancellation, duplicate updates | Attributed beta.35 VM report confirms real Desktop terminal cancellation, terminal close and preservation. Exact packaged lifecycle smoke confirms retained/released activity ownership. The unchanged native executable's seven lock tests cover duplicate updater exclusion, drain wait and timeout. Focused Desktop drain/update controller tests passed 21 checks, including single preparation/apply dispatch and cancellation retry. |
| 11 Compatibility floors                            | Exact beta.35 shipped admission run: 16 checks passed at `output/reboot-fix-20260917/admission-CHt1vO/result.json`. This uses the changed beta.35 source floor, not beta.32's floor.                                                                                                                                                                                                                                                       |
| 12 Artifact integrity                              | Beta.35's authenticated signature, untrusted signer and tamper checks pass. The unchanged native extractor hash is covered by beta.32's 11 black-box path/digest/truncation cases. Desktop source binds discovery to authenticated staging and preparation before apply; those modules are byte-identical in the runtime comparison. No failed archive is treated as an activated application.                                             |
| 14 Repair                                          | Reuse the matching beta.32 Setup Repair pass. Repair composition, default storage heartbeat semantics and native component tools are unchanged. The manual beta.35 fixture preparation is not counted as a Repair test.                                                                                                                                                                                                                    |

Reuse means a reviewed applicability decision for the new candidate, not a
claim that the original guest tests ran against beta.35. All original hashes,
failures and evidence paths remain attached. No service interruption point or
service-health rollback is promoted by the table above.

Additional local evidence: exact beta.35 packaged Desktop/launcher lifecycle
smoke passed at `output/desktop-lifecycle-smoke/case-GkCZsG/qualification.json`.
The consent response is automated inside the existing smoke mode; the separate
guest report `output/reboot-fix-20260917/reported-remaining-ui.json` now supplies
actual dialog observation. Its update status is only `YES`, so no actual update
screen status or public download is inferred. Focused test results are recorded in
`output/reboot-fix-20260917/drain-duplicates-vitest.json`. WinGet manifest validation
returned exit 0, with Git.Git dependency resolution not checked by that command.
Neither result is a public download/install pass.

Following the 2026-09-17 remaining-service completion report, gates 08, 09, 13
and 15 are covered. Gate 08 combines retained app-health rollback with the actual
native process-start failure fixture and corrected beta.35 reboot. Gate 13 combines
unchanged-source capacity admission, native restore guards, exact-binary lock
checks and retained real disk-full write failure plus successful fresh-path retry.
The original disk-full exit code and volume measurements were lost to a QA regex
failure; these values are not inferred or claimed as recorded.

The attributed `output/reboot-fix-20260917/reported-remaining-service-pass.json`
completes four service kill points, service reboot and service-health rollback with
preservation. It exercised the instrumented beta.31 source and beta.32 target,
whose native host hash is identical to beta.35. Along with the retained app kills,
service power-off and corrected beta.35 app reboot, this completes the fixed
interruption matrix. The subsequent production handoff also completed. Original
failed attempts and UAC cancellations remain preserved; they are not relabeled.

Fourteen gates now pass. Only gates 04 and 16 remain partial for public delivery
and local WinGet installation (plus the approved Authenticode deferral). The actual
Desktop terminal runner passed in the populated VM. Fresh Setup/UAC
passed on a separate clean system disk; the populated disk remains preserved. Public
discovery/download and local WinGet installation remain after prepublication
readiness. The user explicitly approved the beta.35 public-verification order on
2026-09-17; see `beta35-public-verification.md`. This does not mark those public
checks passed or complete acceptance.
