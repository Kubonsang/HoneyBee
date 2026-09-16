# ADR-065: Ordinary-launch automatic recovery after Windows restart

Status: automatic recovery after guest Windows restart passed, based on user-supplied console output.

## Scenario

The `startupReboot` mode combines the real Windows restart checkpoint from ADR-061
with the recovery-enabled ordinary launcher from ADR-064. It uses a fresh isolated
beta.12-to-beta.13 case, preserves the VM's original installation and service, and
stops the updater after target pointer replacement but before commitment.

The checkpoint saves and syncs the scenario binding and Windows boot identity.
The operator restarts Windows inside the QA VM, then runs the same QA command.
Resume checks a changed boot identity and the saved scenario path/hash. The
`startupRecovery` branch then launches the ordinary stable launcher and never
invokes `recoverPublishedUpdateWithDoctor` or another direct QA recovery function.

The launcher must invoke its pinned recovery runtime, restore the approved source
through real Doctor-backed recovery, and start a ready beta.12 Desktop. The driver
requires the source pointer byte-for-byte, a RolledBack journal record, successful
runtime evidence containing at least two ready Doctor checks, source and published
payload integrity, and original registry/service/installation preservation. After
closing Desktop, repeated stable CLI launch must report beta.12 without creating
another recovery attempt. Both boot identities are retained in the result.

## Operation and evidence

- Host bundle: `output/vm-qualification/startup-reboot-20260913-123358`.
- Transfer status: `output/vm-qualification/startup-reboot-transfer-result.json`.
  Delivery completed with `ok: true`, `stage: Delivered`, 407 files.
- Guest destination selected by transfer: `C:\HoneyBeeQA\startup-reboot-20260913-123412`.
- Guest command: `HoneyBee-Startup-Reboot-QA.cmd`, original user, without elevation.
- Wait for `REBOOT CHECKPOINT READY`, restart only the guest Windows, and run the
  exact same command again. No host reboot is needed.
- Retain `startup-reboot-result.json`, `reboot-pending.json`, `Cases`, activation
  records, Desktop logs and case-local `update/recovery-attempts` reports.
- Local JavaScript lint/format/syntax and Windows PowerShell parser checks passed;
  seven existing QA registry preservation tests passed.

## Guest result

The user supplied this result for the delivered bundle:

```text
Automatic startup recovery after reboot PASSED; retain startup-reboot-result.json and Cases
Two-version qualification PASSED
```

The automatic resume branch reports passage after checking the changed boot
identity, ordinary-launch recovery, source pointer restoration, real Doctor evidence,
Desktop readiness, repeat launch without another recovery attempt, and preserved
baseline described above. The full JSON and runtime logs have not been exported to
or independently inspected on the host; passage is attributed to the supplied
console output. Retain
`C:\HoneyBeeQA\startup-reboot-20260913-123412\startup-reboot-result.json` and its
adjacent `Cases` directory.

This remains a controlled normal-restart test,
not an abrupt power-loss or service-migration test. The launcher starts only when
invoked; this does not install a Windows startup task or background recovery service.
Prior QA restrictions remain, including fixture UI, `--no-sandbox`, empty project
and storage-parent requirements, pinned source-only recovery policy and the QA
baseline observer used to construct the interrupted update. The installer staging
publication lock documented in ADR-063 is separate; ADR-066 records successful
assembly with Orca fully exited and the remaining host-tool locking limitation.
