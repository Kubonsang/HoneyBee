# ADR-069: Setup-installed recovery after Windows restart

Date: 2026-09-13

Status: Setup-installed recovery after guest Windows restart passed, based on user-supplied console output.

## Scenario

Extend the passed Setup-installed crash scenario (ADR-068) with the actual Windows
restart checkpoint from ADR-065. The builder's opt-in `--reboot` sets `setupSource`,
`startupRecovery`, `startupReboot` and `interruption` in a fresh bundle. The original
crash bundle and VM evidence are preserved.

Silent Setup installs into an empty isolated case. Its verified EXE/inventory pins
and the hash of `setup-source-result.json` are bound into the durable scenario.
The updater stops after changing the active pointer and before commitment. The
operator restarts guest Windows. Re-running the same command requires a changed
boot identity, an unchanged scenario binding and unchanged successful Setup evidence.
Resume does not reinstall Setup or copy an assembled source over the case.

The ordinary stable launcher performs pinned source-only recovery with real Doctor
validation. The existing checks require a restored source pointer, RolledBack
journal, ready Desktop, preserved source/target and original installation/service
baseline, and repeated stable CLI launch without another recovery attempt.
`startup-reboot-result.json` now identifies the Setup hash for this mode. Successful
output additionally includes `Setup-installed recovery after reboot PASSED`.

## Local validation

- Setup-source and registry tests: 15 passed. These do not simulate a Windows reboot.
- Modified JavaScript passed ESLint, Prettier and syntax checking.
- Fresh bundle generation verified its Setup/source contents and existing pins.
- Transfer PowerShell parser and all four required mode flags passed checks.
- No application or service was installed on the host during this phase.

## Operation

- Bundle: `output/vm-qualification/setup-reboot-ZADD9c`.
- Setup: the ADR-067 EXE, SHA-256
  `AD15D5C56E03EA55788EF58165C7EE5460842BE448A95BD09575CF8DC1C1F187`.
- Run `output/vm-qualification/transfer-setup-reboot.ps1` from host administrator
  PowerShell. Previous attempts established that the assistant's host process
  lacks Hyper-V permissions; tool sandbox escalation does not grant those rights.
- After `Delivered`, run `HoneyBee-Setup-Reboot-QA.cmd` in that exact guest folder
  as the original user, without elevation.
- Wait for `REBOOT CHECKPOINT READY`, restart Windows inside the QA VM only, and
  run the same CMD again from the same folder. Do not reboot the host.
- Preserve `startup-reboot-result.json`, `reboot-pending.json`, `Cases`, Setup
  evidence, activation journals and recovery-attempt logs.

## Guest result

The saved host transfer result was read and confirms `ok: true`, `stage: Delivered`,
411 files and destination `C:\HoneyBeeQA\setup-reboot-20260913-132834` on
`HoneyBee-Setup-QA-20260910` (attempt `20260913-132834`).

The user supplied:

```text
Automatic startup recovery after reboot PASSED; retain startup-reboot-result.json and Cases
Setup-installed recovery after reboot PASSED
Two-version qualification PASSED
```

Record this bundle's Setup-installed restart recovery gate as passed, attributed
to the supplied console output. The full guest result JSON and recovery logs have
not been exported to or independently inspected on the host. Preserve
`C:\HoneyBeeQA\setup-reboot-20260913-132834\startup-reboot-result.json` and adjacent
`Cases`, including Setup evidence and recovery-attempt reports.

This remains a controlled Windows
restart test with empty QA project/storage state and an already compatible service,
not abrupt power loss, service migration or populated-workspace qualification.
Fixture UI and pinned source-only recovery restrictions from ADR-065/068 remain.
