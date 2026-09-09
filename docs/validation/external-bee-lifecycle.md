# External Bee retained lifecycle — 2026-09-09

E-dag passed the isolated native lifecycle campaign: **468 tests across 18
TestPlay process runs**, including concurrent reuse of two independent caches
and successful tests on the survivor after deleting the other workspace.
This completes native lifecycle verification, not product integration or release.

## Workload and result

The frozen GNF source is commit `4caf0731a0a5959ffa61f6c3d110f303f8779f80`.
The host used Unity `6000.6.0f1`, TestPlay `0.11.0`, 1 MiB child blocks,
4 KiB sectors and 64 GiB virtual capacity. Each new child had its own external
Bee cache, with the DAG-only seed policy established in the
[startup study](external-bee-startup.md).

| Stage             | Workload                                                        | Passed tests |
| ----------------- | --------------------------------------------------------------- | -----------: |
| Fresh samples     | First open, reopen and one edit/play cycle per sample           |          104 |
| Retained reuse    | Three concurrent attach/edit/play/detach rounds on both samples |          312 |
| Removal isolation | Delete sample 10, then another edit/play round on sample 11     |           52 |
| Total             | 18 process runs; 37 EditMode or 15 PlayMode tests per run       |          468 |

Each attach verified the parent and the exact private Bee junction target.
Every subsequent test phase checked that Unity had preserved the junction.
Sample 10's project, child and external Bee were removed before the final
survivor round; sample 11 was removed after that round. Cleanup receipts and
the absence of all named sample paths were independently checked by
`summarize_lifecycle.py`. Both samples' evidence was archived before removal.

The last test-phase observations were 337.64 / 340.79 MB of child allocation
and 153.79 / 153.65 MB of external Bee for samples 10 / 11 respectively. These
are phase observations, not final detached capacity qualification measurements.
This experiment has different timing/concurrency conditions from the performance
study and does not replace its **357.56 MB median child / 510.98 MB combined**
result. The historical 350 MB capacity gate remains failed; this run records
`lifecycleValidated: true` separately with `qualified: false`.

## Cleanup and retained evidence

All temporary sample caches, both experiment parents, the generated seed
Library and the authored export were removed. Before recursive deletion,
the cleanup verified exact owned paths, rejected reparse points, confirmed
both remaining parent images were detached, and checked the evidence archives.
The installed parent SHA-256 remained
`b20fd99c0adf27f13f0a1152d7c1c5f88fd264669265cc09bffd14ddc6c8ecbc`.

The final parent/source cleanup increased observed free space by
**3,828,293,632 bytes (3.57 GiB)**, leaving **65.40 GiB** free at completion.
This reclaimed newly generated experiment data; it is not another reduction
in the product's workspace storage. The four sample evidence archives and
the final campaign archive are retained under `output/`.

- Final archive: `output/startup-lifecycle-evidence.zip`, 4,943,845 bytes, 92 files.
- Archive SHA-256: `2b223683ad7277d2e9932def684bd799807946cf5117c72f07e4e1ddf557b778`.
- Sample archives: `output/startup-lifecycle-20260909-evidence/` (four verified ZIPs).
- Cleanup receipt: `output/startup-lifecycle-cleanup.json`.
- Machine-readable result: [external-bee-lifecycle-results.json](external-bee-lifecycle-results.json).

## Implementation and limits

The benchmark now exposes `--startup-lifecycle` independently of startup
qualification, and a dedicated evidence validator rejects shared cache paths,
missing survivor rounds, duplicate run identities, failed/mismatched tests and
incomplete sample cleanup. Go tests, vet and build passed; Python checks passed.
The final source also adds a preflight rejection for duplicate child identities,
shared cache paths and foreign parent paths. That additional guard was unit
tested after the native binary had been built; the native run itself used
distinct generated paths and verified actual junction targets at each attach.

The archived campaign metadata contains unused startup defaults (`pilotRuns`,
`qualificationRuns`, `qualificationCycles`) inherited from the shared entry
point. Its protocol, measurements and compatibility phase records establish
the actual workload above. The source now emits dedicated lifecycle counts;
the original measurement archive was preserved without rewriting it.

This campaign ran native disk operations and independent batch Unity processes.
It did not exercise the installed broker, GUI sessions, a service restart or a
physical reboot. Product support still requires transactional management of
the shared seed and private cache, removal/recovery handling, complete capacity
accounting and a reproducibly packaged storage service. The concrete change
scope and regression cases are in the
[product integration design](external-bee-product-integration.md).
