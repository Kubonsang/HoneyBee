# ADR-066: Assembly publication lock diagnosis

Date: 2026-09-13

Status: Assembly publication qualification passed with Orca exited; host-tool locking remains a limitation.

## Findings

After the user reported ordinary-launch recovery after reboot passing (ADR-065),
we reproduced the remaining ADR-063 assembly publication failure. Both the
ordinary tool execution and execution outside the tool sandbox failed at the final
Node directory rename. Fresh generated attempts `0.1.0-beta.12-jaJmHP` and
`0.1.0-beta.12-YbWzeQ` under `output/two-version-qa/build-oAnFPo/output/installations`
remain preserved. No existing installation, service, workspace or VM was changed.

A read-only Windows handle probe requested DELETE access with all sharing flags
and immediately closed each handle. Only the generated Desktop `resources/app.asar`
returned Win32 error 32 (sharing violation). Restart Manager resource registration
and process enumeration identified Orca, PID 13156, as a process using that exact
file. We did not call Restart Manager shutdown/restart or terminate any process.
This establishes the observed handle owner, not why Orca opened the file or whether
every earlier failure had the same owner.

Local diagnostic evidence:

- `output/assembly-lock-probe.cs` and `output/assembly-lock-probe-result.json`
- `output/assembly-restart-probe.cs` and `output/assembly-restart-probe-result.json`

The process enumeration uses the documented [Restart Manager functions](https://learn.microsoft.com/en-us/windows/win32/rstmgr/functions).

## Decision

Keep the current single directory rename as the build publication boundary. Do not
substitute a recursive move (which previously partially moved an attempt), publish
a partly assembled tree, or automatically kill an unrelated desktop application.
This is a build-host problem observed before a package was published, not evidence
of a guest update rollback or Storage Service failure.

An external PowerShell retry is prepared at
`output/vm-qualification/retry-assembly.ps1`. It creates a fresh attempt using the
prepared beta.12 QA inputs, then checks that staging is absent, that the published
path is the expected unique output, and that runtime inventory, approved source
inventory, launch hash and both launcher binaries match their prepared inputs.
It writes `assembly-retry-result.json` and prints failure details. It never retries
an old partially moved tree. Run without elevation in a PowerShell window opened
outside Orca with Orca fully exited. The successful fresh publication recorded
below closes this assembly gate; merely verifying the copied ADR-063 package
would not close it.

The scripts are local QA artifacts with fixed prepared paths, not a distributed
updater or a general release qualification tool. They do not establish publisher
signing, service migration readiness, or durability under power loss.

## Checks performed

The retry scripts passed Node syntax checking and PowerShell parser checking.
The verifier passed against the preserved ADR-063 copied package: 101 runtime files,
186 approved source files, launch hash and both launcher binaries. That result is
explicitly marked `verificationOnly: true`; it does not assert successful directory
publication. `git diff --check` passed.

The user's external PowerShell retry also failed at the final rename, preserving
`0.1.0-beta.12-NBpmQw/staging`. A new Restart Manager query for this attempt's
`desktop/resources/app.asar` again reported Orca PID 13156. Evidence is saved at
`output/assembly-external-restart-probe-result.json`. Changing the invoking shell
did not prevent the observed handle. A fresh retry with Orca fully exited was
therefore requested. The assistant did not terminate Orca.

That retry passed at `2026-09-13T13:05:33.076Z`, publishing
`output/two-version-qa/build-oAnFPo/output/installations/0.1.0-beta.12-i7e90K/HoneyBee`.
The user supplied a successful console result and exit code 0. The assistant also
read the saved `output/vm-qualification/assembly-retry-result.json`, confirming
`ok: true`, `verificationOnly: false`, 101 runtime files and 186 source files.
This run completed the directory rename and the verifier's staging-absence,
inventory, source launch hash and launcher binary checks. It was a fresh assembly,
not the earlier copy workaround. No product code change was needed for this gate.

The observed workaround is to assemble with Orca fully exited. The mechanism by
which Orca acquires the handle and a permanent host-tool fix remain unestablished.
This does not qualify all future build hosts or any further installer/service flows.
