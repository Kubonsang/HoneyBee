# Child VHDX integration — 2026-09-08

The hb10 service is installed locally, with the public storage code commit pinned
in HoneyBee. Installed broker creation and retained attachment passed for both
old 2 MiB and new 1 MiB children, including one physical Windows reboot. Both
disposable children were removed after verification; the four original user
child images remain byte-identical. These native checks preceded Beta 8 packaging.

## Source and payload identity

- Storage code: `c238f283ded29f716f72e7d556cfeef3efd98639`, published to
  [feat/child-block-1mib](https://github.com/Kubonsang/unity-workspace-storage/tree/feat/child-block-1mib).
- Final source/provenance commit: `cfa606fd4143a13b2d229f9d1e24e48ae0ddb8fa`.
  This follow-up changes only provenance documentation and destination hashes.
- Go module: `v0.0.0-20260908094357-cfa606fd4143`, resolved from the public module
  proxy with recorded module checksums.
- Component version: `0.0.0+c238f283ded2.hb10`.
- Client: 4,544,000 bytes,
  SHA256 `b727c449298f036907bf36205f19bd694061d7fdf75efb04ded9fa5899a584c9`.
- Host: 5,614,592 bytes,
  SHA256 `63a66d74ce24f40f99e5da76d94daf1ad51fda50a562c316239405b90ad8f915`.

The client hash is unchanged because the broker performs child creation. The
module, prepared source revision, packaged tools and compatibility manifest
are pinned together. Both packages are under their app's `release-child-block/`
directory for the native qualification candidates. Beta 8 release packaging uses
the same hb10 runtime hashes with the updated application version and manifests.

## Checks completed

- Storage full Go tests, vet and native old/new child geometry test passed.
- HoneyBee lint, type checking, build, 90 tests across 22 suites, Go host tests
  and dependency checks passed. Security and production-license checks passed.
- Formatting passed for tracked files and task additions. The aggregate
  `pnpm verify` first stopped on two pre-existing user analysis documents; those
  documents were preserved and excluded from the subsequent source-format check.
- Lint configuration now excludes disposable checkout/output/package directories
  and fixes its TypeScript config root. This prevents nested experimental
  checkouts from changing lint results.
- CLI package smoke, Desktop IPC/UI smoke and packaged interactive PTY passed.
- hb9 host, receipt, broker config, registry and lease/retained journals were
  backed up before replacement. The installer returned `SWITCHED`; installed
  receipt, executable hash and Running service state matched hb10.
- All four pre-existing user child images had identical SHA256 values before
  and after service replacement. The user registry remained byte-identical.
- A disposable 2 MiB child created by hb9 was retained before installation.
  hb10 created a separate 1 MiB child using the same existing 2 MiB parent.
  Each passed three installed-broker attach/read/heartbeat/retain cycles.
  Probe content, child file identity, requested block size and actual mount GUID
  matched. Original user child inventories remained unchanged.

These installed probes exercise retention and reattachment using disposable
workspaces. They do not reproduce the historical ambiguous-volume repair failure
or drive the user's existing workspaces through the HoneyBee Repair UI. Existing
repair regression tests pass, and the hb9 recovery implementation is unchanged.

## Provenance publication

After explicit user approval, the exact
[provenance patch](../../integrations/storage/provenance-overlay.patch) was
published as `cfa606fd4143a13b2d229f9d1e24e48ae0ddb8fa`. All 48 active destination
checks passed, and the original 42-entry frozen manifest remains unchanged.
The earlier automatic approval-review block is resolved. Source/module pins now
reference this final commit; the hb10 runtime identifier remains anchored to the
unchanged code commit `c238f28`.

Rebuilding from the final source/module pin produced identical SHA256 values
and lengths for all three executables (client, host and usage helper). The
installed hb10 payload is therefore the same runtime that passed the retained
checks. Go tests and vet passed against the final dependency. Both packages were
rebuilt with the new source metadata; CLI and Desktop IPC/UI smoke passed again.
Evidence is in `output/child-block-provenance-validation.json` and the before/after
tool manifests. Service replacement was not needed for this metadata-only update.

## Physical reboot and cleanup completed

Windows LastBootUpTime advanced from `2026-09-08T06:12:39.5000000Z` to
`2026-09-08T09:50:44.5000000Z` (18:50:44 KST). The broker boot identity also
changed. Both the hb9-created 2 MiB child and hb10-created 1 MiB child passed
reattachment, marker-content, heartbeat, exact mount-GUID and original child-file
identity checks after that reboot. Block sizes remained unchanged.

After success, both fixtures were removed through broker removal transactions.
Their child files, lease/retained journals and workspace shells are absent.
Their final measured child allocation totalled 49,283,072 bytes before removal.
The service remains Running, with four original retained children, zero active
children, zero pending operations and zero quarantined children. No manual
recovery or GC block is reported.

All four original user VHDX files still match their full pre-upgrade SHA256
hashes. The original registry and child inventories also match. The
[machine-readable reboot record](child-vhdx-reboot-results.json) records the
completed checks without local ownership tokens or user paths.

This completes the planned installed-compatibility gate for this change. It
covers one physical reboot and disposable retained children; repeated reboot
cycles and the historical ambiguous-volume failure in the user's Repair UI are
outside this result. Public HoneyBee release publication remains a separate step.

## Procedure and evidence

The completed run used the installed user's normal token after Unity and
HoneyBee were closed:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File output/resume-child-block-reboot.ps1
```

The wrapper verified a newer physical boot, reattached both retained fixtures,
checked their marker contents and identities, and cleaned them up after success.
This checkpoint is complete; do not rerun its resume phase after fixture removal.

Local evidence (ignored by Git):

- `output/child-block-service-install.json`: installed version/hash and original
  child preservation; `output/child-block-service-backup/`: rollback material.
- `output/child-block-installed/state.json`: fixture identities and completed
  reboot/cleanup checkpoint; prepare/upgrade/reboot/cleanup logs are beside it.
- `output/child-block-physical-reboot.json`: old/new Windows boot times.
- `output/child-block-post-reboot-final.json`: original-child SHA256 preservation,
  installed service identity, final broker counts and exact fixture removal.
- `output/child-block-install-readiness.json`: source and package checks.
- `output/child-block-*-package.log`, `output/child-block-test-run.log` and the
  other named source-check logs: validation results.

Original performance evidence remains in the
[allocation benchmark report](child-vhdx-improvement.md): 18.84% lower median
persisted allocation in the measured GNF workload, with no qualifying timing
regression. The small installed marker probes are compatibility checks, not a
second Unity capacity benchmark.
