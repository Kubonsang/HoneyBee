# ADR-061: Interrupted Desktop update and reboot qualification

Status: reboot recovery passed, based on user-supplied console output.

## Scenarios

The `interruption` QA bundle mode reuses the isolated beta.12 source and beta.13
candidate from ADR-060. It never updates the VM's original installation or service.
Both scenarios authenticate and shut down source Desktop through the real session
transport, acquire exclusive activity and interrupt the updater at `switched`:
the target pointer has been replaced but post-switch validation and commitment have
not completed. The existing durable activation journal remains recovery authority.

1. Process death: the parent kills only its own updater child at the checkpoint,
   waits for exit, acquires exclusive activity, and runs existing Doctor-backed
   recovery. The pointer must return byte-for-byte to the source. The stable launcher
   must start a ready beta.12 Desktop, followed by cleanup and baseline checks.
2. Windows restart: the child syncs a checkpoint and a bundle-local pending record
   containing the scenario path, scenario SHA-256 and Windows boot identity, then
   waits at the same point. The console prints `REBOOT CHECKPOINT READY`. The operator
   restarts Windows inside the QA VM and runs the same command again. No host reboot
   or automatic guest power-off is performed by these scripts.

The PowerShell wrapper obtains `LastBootUpTime` from Windows. Resume refuses an
unchanged boot identity, a scenario outside the bundle's Cases directory or changed
scenario bytes. It reuses the saved baseline and transaction rather than creating
a new case. Recovery must return `RolledBack`, restore the source pointer, pass real
Doctor, start a ready Desktop through the launcher, and preserve source payload and
original registry/service/install files. A second recovery call must also return
`RolledBack` with successful terminal health validation.

Scenario configuration and checkpoint records are written with exclusive creation
and file sync. Normal Windows restart is the intended VM test; abrupt power loss,
storage-controller cache durability and interruption of service migration are not
qualified by it. Restarting the same QA command is explicit test recovery, not a
production automatic startup/recovery mechanism.

## Preparation and evidence

- Host bundle: `output/vm-qualification/interruption-20260913-105837`.
- Guest destination: `C:\HoneyBeeQA\interruption-20260913-105901`.
- Transfer status: `output/vm-qualification/interruption-transfer-result.json`.
  Delivery completed with `ok: true`, `stage: Delivered`, 303 files.
- Command inside the guest: `HoneyBee-Interruption-QA.cmd`, original user, without
  elevation. Run it again after the checkpoint and guest Windows restart.
- Retain `Cases/*/scenario.json`, `crash-journal.json`, activation journals,
  `Cases/*/result.json`, `reboot-pending.json`, `reboot-result.json` and process logs.
- Local regression: 31 publication/Doctor/recovery/activity/registry tests passed.
  Changed JavaScript lint/format/syntax checks and Windows PowerShell parser checks
  passed. These results do not establish that the new guest scenarios passed.

Existing QA limits remain: empty projects/storage parents, fixture Desktop data,
automation flags including `--no-sandbox`, pinned local bundles and the QA-only
service-baseline observer. Production release trust, real terminal consent, and
service migration are separate gates.

## Guest result

The user supplied the following output for this qualification:

```text
Reboot recovery PASSED; retain reboot-result.json and Cases
Two-version qualification PASSED
```

The reboot resume branch reports passage only after checking a changed Windows
boot identity, recovering the source pointer, running real Doctor, observing source
Desktop readiness, checking preserved state and successfully repeating recovery.
The final wrapper message does not independently re-run the process-death scenario.
The intended driver reaches the reboot checkpoint after the process-death case
passes, but the supplied excerpt contains no separate `crash PASSED` line; retain
the pre-reboot case result as its direct evidence.

Evidence remains at
`C:\HoneyBeeQA\interruption-20260913-105901\reboot-result.json` and the adjacent
`Cases` directory. The full JSON and case logs have not been exported to or
independently inspected on the host. This result qualifies explicit QA resume
after a normal guest Windows restart, not production automatic startup recovery
or abrupt power-loss durability.
