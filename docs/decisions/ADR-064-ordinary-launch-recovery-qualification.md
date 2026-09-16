# ADR-064: Ordinary-launch automatic recovery qualification

Status: ordinary-launch recovery scenario passed, based on user-supplied console output.

## Scenario

The `startupRecovery` QA mode uses the pinned recovery-enabled bootstrapper and
runtime from ADR-063, with the approved beta.12 source and beta.13 candidate.
The VM's original installation remains a watched baseline. A fresh case copies
the runtime and stable shim in addition to the source release and launcher.

The driver starts source Desktop, authenticates its shutdown, and kills only the
updater child after target pointer replacement but before commitment. It then:

1. Temporarily modifies the case-local recovery startup module and invokes the
   stable CLI. The bootstrapper must refuse the modified runtime and preserve the
   target pointer. The original module bytes are restored in `finally`.
2. Temporarily modifies the case-local source CLI and invokes the stable CLI.
   The approved-source check must refuse recovery and preserve the target pointer.
   The original CLI bytes are restored in `finally`.
3. Starts `HoneyBeeLauncher.exe` normally. The driver does not call a recovery
   function in this branch. The launcher must invoke the pinned recovery runtime,
   pass real source Doctor, roll back, revalidate the journal and launch Desktop.
4. Requires a ready source-version Desktop, byte-exact source pointer and a
   `RolledBack` record. A successful runtime report must contain at least two ready
   Doctor checks. The driver then closes Desktop through the real session transport.
5. Invokes the stable CLI again and requires beta.12 output without a new recovery
   attempt. Source/published payload checks and original installation, service and
   registry preservation checks still apply.

The recovery-enabled runtime is copied unchanged, so its compiled bootstrapper
inventory pin remains valid. Source changes are confined to fresh case files, not
the original installation or shared source bundle. Runtime and source-file tamper
refusal do not substitute for a dedicated actual service/Doctor failure injection.

## Evidence and operation

- Host bundle: `output/vm-qualification/startup-recovery-20260913-120328`.
- Transfer status: `output/vm-qualification/startup-recovery-transfer-result.json`.
- User-supplied transfer result: `Delivered`, `ok: true`, 406 files, destination
  `C:\HoneyBeeQA\startup-recovery-20260913-122739`.
- Guest entry: `HoneyBee-Startup-Recovery-QA.cmd`, original user, without elevation.
- This run needs no Windows restart: it tests process interruption and ordinary
  launch. A reboot followed by ordinary launch remains a separate qualification.
- Retain `Cases`, `two-version-result.json`, activation journals, Desktop process
  logs and case-local `update/recovery-attempts/startup-*/result.json` reports.
- Local checks: launcher Go tests passed (the existing privilege-dependent symlink
  case remains skippable), changed JavaScript lint/format/syntax passed, and Windows
  PowerShell parser checks passed.

## Guest result

The user supplied this console result for the delivered bundle:

```text
Scenario crash: C:\HoneyBeeQA\startup-recovery-20260913-122739\Cases\case-5x3DIu
crash PASSED
Two-version qualification PASSED; retain Cases and two-version-result.json
Two-version qualification PASSED
```

In this bundle, `crash PASSED` includes the tamper-refusal checks, automatic recovery
through the ordinary launcher, real Doctor evidence checks, Desktop readiness,
repeat CLI launch without another recovery attempt, and baseline preservation
described above. The full JSON and runtime reports have not been exported to or
independently inspected on the host; passage is attributed to the supplied output.
Retain the guest case directory and the bundle's `two-version-result.json`.

The existing QA restrictions remain: empty
projects/storage parents, fixture UI with automation flags including `--no-sandbox`,
and the QA baseline observer for constructing the interrupted update. Automatic
recovery itself uses the pinned runtime's source policy and actual Doctor. The
source-only approval restriction and unresolved assembler publication lock from
ADR-063 are unchanged; this is not production installer qualification.
