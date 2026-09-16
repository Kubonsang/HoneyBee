# ADR-068: Qualify automatic recovery from a Setup-installed case

Date: 2026-09-13

Status: VM Setup-installed crash recovery passed, based on user-supplied console output.

## Scenario

ADR-067 fixes Setup's omitted recovery payload. This follow-up exercises the
installation made by the actual NSIS EXE as the source of a beta.12-to-beta.13
interrupted update. The existing ordinary-launch crash recovery scenario is reused.

With `setupSource: true`, each fresh empty `Cases/case-*` root is populated by
the pinned Setup EXE using `/S` and an explicit `/D` destination. No source files
are copied over the result. Before starting the update, the driver checks the
complete installed inventory, successful Setup health with `serviceAction: none`,
the source pointer, source version bytes, stable launcher/shim and recovery pin.
It preserves `setup-source-result.json` in the case and rechecks the original
installation, registry and service baseline.

The existing driver then interrupts the updater after pointer replacement, checks
tampered runtime/source refusal, and invokes the ordinary launcher to perform its
pinned Doctor-backed rollback. Desktop readiness, restored pointer, preserved
source/target files, repeat CLI launch without another recovery attempt, and the
original baseline are required. Successful output includes
`Setup-installed automatic recovery PASSED`. The final JSON binds the Setup hash.

This is an app-only update and process-interruption test with an already installed
compatible service. Silent Setup never requests service installation or elevation.
No VM reboot is required. The guest must be the original non-elevated user and
have empty project/workspace state as required by the existing QA admission checks.
Fixture Desktop and QA baseline-observer limitations from ADR-064 remain.

## Implementation and local checks

- `setup-source.mjs` admits only an empty, ordinary case directory beneath this
  bundle's `Cases`, checks EXE/inventory hashes, invokes silent Setup and validates
  its actual output. An error prevents the update scenario from starting.
- `guest-two-version.mjs` loads that helper only for the new opt-in mode; existing
  bundles do not gain an installation-module dependency.
- `build-setup-recovery-bundle.mjs` binds the packaged Setup inventory to every
  matching source file in a previously qualified startup-recovery bundle, and
  retains the target, helper, source and recovery pins.
- Eight new helper tests and seven existing registry tests passed (15 total).
  These helper tests use an injected Setup runner; they are not a VM result.
- Changed JavaScript passed ESLint; formatting and transfer PowerShell parsing
  passed. ADR-067 separately records a real packaged Setup smoke pass.

## Operation

- Bundle: `output/vm-qualification/setup-recovery-RL8k06`.
- Setup SHA-256: `AD15D5C56E03EA55788EF58165C7EE5460842BE448A95BD09575CF8DC1C1F187`.
- Transfer script: `output/vm-qualification/transfer-setup-recovery.ps1`.
- Transfer result: `output/vm-qualification/setup-recovery-transfer-result.json`.
- Intended VM: `HoneyBee-Setup-QA-20260910`.
- Guest command: `HoneyBee-Setup-Recovery-QA.cmd`, run without elevation in the
  exact destination returned by successful transfer.
- Retain `Cases`, `two-version-result.json`, case `setup-source-result.json`,
  `.setup-pending`, activation journals and recovery-attempt logs.

The first transfer attempt (`20260913-131601`) failed at the host Hyper-V permission
check, before copying files. Tool sandbox escalation did not grant Windows
administrator rights. The subsequent administrator-run transfer succeeded:
`20260913-131723`, 411 files, `ok: true`, `stage: Delivered`, destination
`C:\HoneyBeeQA\setup-recovery-20260913-131723`. The assistant read the saved host
transfer result and confirmed it matches the user-supplied delivery report.

## Guest result

The user supplied:

```text
crash PASSED
Setup-installed automatic recovery PASSED; retain Cases and two-version-result.json
Two-version qualification PASSED; retain Cases and two-version-result.json
Two-version qualification PASSED
```

Record the Setup-installed process-interruption recovery gate as passed for this
bundle, attributed to that console output. The driver reaches these messages only
after the Setup admission, installed payload checks, ordinary-launch recovery and
preservation checks described above. Full guest JSON and logs have not been exported
to or independently inspected on the host. Keep
`C:\HoneyBeeQA\setup-recovery-20260913-131723\two-version-result.json` and adjacent
`Cases`, including Setup and recovery evidence.

This result does not qualify a Windows restart from this Setup-installed source,
abrupt power loss, populated workspaces, or a Storage Service migration. The earlier
restart gate (ADR-065) used an assembled QA source installation.
