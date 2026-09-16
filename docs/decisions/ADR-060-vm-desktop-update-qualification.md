# ADR-060: VM qualification of Desktop-mediated two-version updates

Status: all four guest scenarios passed, based on user-supplied console output.

## Scope

The existing VM's installed beta.11 predates the Desktop session protocol. It is
preserved as user/service baseline. Qualification instead carries an isolated
beta.12 source and beta.13 candidate built from the current implementation. These
are QA versions, not published releases. No service migration is performed.

The existing guest driver supports an explicit `desktopLifecycle` bundle pin.
It copies source files from the bundle into unique `Cases/case-*` roots, stages and
publishes the candidate, runs real Doctor through the existing authorization hooks,
and uses `desktop-update-scenario.mjs` for Desktop lifecycle orchestration.

Scenarios:

- Commit: authenticate and close source Desktop, acquire activity, validate and
  commit beta.13, launch through the stable launcher and require a new ready session.
- Rollback: inject failure after real target post-switch Doctor execution, restore
  beta.12 through existing rollback, and require beta.12 Desktop readiness.
- Cancel: explicitly simulate coordinator cancellation before any shutdown request.
  The source Desktop must still report ready and the pointer must remain unchanged.
  This is not a native terminal-dialog cancellation test.
- Restart failure: inject launcher-dispatch failure after successful commit;
  beta.13 must remain selected and the result must preserve `Committed`/`Failed`.

Each case verifies source payload integrity and preservation of the original
installed pointer, registry (including absence), service receipt/configuration and
broker bytes. Existing empty-project/empty-storage-parent requirements remain.
The fixed QA baseline observer is not production service admission. UI uses isolated
fixture data and automation flags including `--no-sandbox`; Doctor remains real.
Normal cleanup requests authenticated shutdown only inside the fresh case root and
waits for exclusive activity. Failed cases retain diagnostics and files.

## Preparation evidence

- Source: `output/two-version-qa/build-oAnFPo/output/installations/0.1.0-beta.12-ZqqAp4/HoneyBee`.
- Candidate: `output/two-version-qa/build-OR7vBD/output/installations/0.1.0-beta.13-5E7d4M/HoneyBee`.
- Host bundle: `output/vm-qualification/desktop-update-8XgAji`.
- Guest destination: `C:\HoneyBeeQA\desktop-update-20260913-104604`.
- Transfer status: `output/vm-qualification/desktop-update-transfer-result.json`:
  `Delivered`, `ok: true`, 302 files, VM `HoneyBee-Setup-QA-20260910`.
- Changed JavaScript lint/format/syntax checks passed, Windows PowerShell transfer
  parser passed, and seven QA registry preservation tests passed.

Run `HoneyBee-Desktop-Update-QA.cmd` inside the guest as the original installing
user without elevation. Its PowerShell wrapper verifies host/SID, free space and
private Node digest. Retain `Cases`, failure/process logs and `two-version-result.json`.

## Guest results

The user supplied console output reporting all four scenarios and the overall
two-version qualification as PASSED for this bundle:

| Scenario                           | Case directory under `Cases` | Result |
| ---------------------------------- | ---------------------------- | ------ |
| Commit                             | `case-xa416u`                | PASSED |
| Rollback                           | `case-UHNo8S`                | PASSED |
| Cancel before shutdown request     | `case-31Cdlj`                | PASSED |
| Injected launcher dispatch failure | `case-q7iLbX`                | PASSED |

Evidence remains in the guest at
`C:\HoneyBeeQA\desktop-update-20260913-104604\Cases` and
`C:\HoneyBeeQA\desktop-update-20260913-104604\two-version-result.json`.
The full JSON and per-case logs have not been exported to or independently read
on the host; this record attributes passage to the supplied console result.
The scope and fixture limitations above still apply, including cancellation before
the shutdown request rather than interaction with the native terminal dialog.

The earlier crash/recovery scenario remains available in legacy mode; integrated
Desktop/update process interruption and reboot recovery still need separate
qualification after these scenarios.
