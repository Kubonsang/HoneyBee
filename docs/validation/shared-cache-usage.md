# Shared cache and storage usage validation

## Baseline and capacity

The 2026-09-07 analysis described three Workspaces. The current read-only
registry/usage measurement includes four, with the recovery Workspace separate
from the preserved original. Raw local evidence is in
`output/shared-cache-usage-baseline.json`.

Two existing GNF TestPlay Library caches contained 59,177 files totalling
2,377,941,667 logical bytes. Content hashes identify 1,581,605,171 unique bytes:
796,336,496 logical bytes are duplicates. Both manifests were restored into new
validation directories and every file's bytes were verified while restoring.
Source caches were only read.

| Measured contents                          |          Allocated bytes |
| ------------------------------------------ | -----------------------: |
| Two original Library caches                |            2,441,425,328 |
| Shared blobs, both manifests and lock file |            1,630,328,792 |
| Net reduction                              | **811,096,536 (33.22%)** |

This includes shared-store manifest overhead. It excludes directory/MFT overhead
and does not count relocating data as savings. The validation copies were separate
from user Workspaces; their generated data was removed after evidence was archived.
Evidence: `output/shared-cache-content-fixture.json` and
`output/shared-cache-content-allocation.json`.

## Correctness and packages

- Full `pnpm verify` passed in `tmp/shared-cache-verify`, an isolated copy of the
  tracked source plus this implementation. It reused the installed dependencies
  with `pnpm_config_verify_deps_before_run=false` to prevent automatic reinstall;
  every verification step ran unchanged. This kept unrelated user analysis
  documents and old output files out of formatting/lint scope without editing
  them. Full output is in `output/shared-cache-verify.log`.
- HoneyBee: 90 TypeScript tests across 22 suites passed, including unknown usage
  values and helper response validation. Native tests cover hardlink accounting,
  missing paths and excluding Library from ordinary file totals.
- TestPlay: full Go tests and vet passed. Shared-cache/runsvc race checks passed.
  Tests cover deduplication, independent restore, compatible keys, corrupted
  content, malformed manifests, cancellation, active reader locks, concurrent
  writers/GC and preservation of legacy local cache during real service calls.
- Retire-local checks cover preview, rejection of tracked cache files and
  preservation of the source Library and shared store.
- Desktop IPC/UI smoke and packaged interactive PowerShell PTY passed. Both CLI
  and Desktop packages include the standalone read-only measurement companion.
  The pinned hb9 service payload and compatibility contract are unchanged.
- Screenshots were inspected at 1280x820 and 960x820, including the Storage tab's
  partial/unknown/shared states. New measurements require an explicit button click.
- Disposable native project copies, shared stores and capacity-test restores were
  removed after archiving results and verifying evidence copies. The cleanup
  receipt is `output/shared-cache-native/cleanup.json`. Original user caches,
  recovery Workspaces and the installed TestPlay were preserved.

## Native comparison

Candidate provenance:

- TestPlay source base: `95d65521ec2d56419b5b0e2351a70e0e1b2059ee`.
- Candidate executable: `output/testplay-shared-cache-qualified.exe`, SHA-256
  `a98df80f47fdd6ef3d4639fe176023322e0af546ed9338e7132222f6dd89f194`.
- Exported patch SHA-256:
  `0fc0e607feab7e34aaa46e908a166fd83c46faa645ac8d3630ed668f133891db`.
  `git apply --check` passed against the unchanged base checkout.

The benchmark uses two new project copies under `tmp/shared-cache-native`, the
same Unity 6000.6.0f1 installation, forced shadow execution, and the 22 EditMode
tests in `Combat.Tests.CombatSimulationTests`. Neither original Workspace is
opened by Unity. `scripts/benchmarks/shared-cache-windows.ps1` records raw JSON,
stderr, run IDs and durations; warm comparisons alternate mode order.
Both modes use the same candidate executable. Its Windows metrics measure actual
file allocation for both the local and shared cache. Peak is the maximum observed
at lifecycle boundaries, including old and newly published cache generations
before collection. This is not continuous, system-wide disk sampling.

Windows allocation uses batched
[FILE_ID_BOTH_DIR_INFO](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_id_both_dir_info)
directory queries, with individual sparse/compressed-file queries and a fallback
for unsupported directory APIs. A read-only comparison on the populated local
validation Library measured 207 ms for batches and 2,119 ms for individual file
handles; both returned 1,173,565,830 logical and 1,205,331,520 allocated bytes.
Regression tests cover multiple result buffers, Unicode names, paths longer than
260 characters and sparse files. This avoids adding per-file handle overhead to
normal local-mode runs.

The final sequence starts from populated caches. Earlier exploratory measurements
are archived separately and are excluded from warm medians. Obsolete blobs from
the exploratory implementation were collected before qualification started.

The first serial implementation passed all 22 tests in each cold run but had
slow cache publication (shared 142 seconds, local 24 seconds, with other
validation IO running). This led to bounded eight-worker publication/restore;
those exploratory cold timings are not final performance qualification.

Final results: ten warm runs per mode, all 440 tests passed, identical test names
and results, no fallback and no warnings.

| Metric                           |         Local | Shared-content | Change |
| -------------------------------- | ------------: | -------------: | -----: |
| Median total                     |      92.995 s |       67.560 s | -27.4% |
| Median preparation               |      16.018 s |       17.374 s |  +8.5% |
| Median cache write-back          |      29.253 s |        9.002 s | -69.2% |
| Maximum observed allocated bytes | 3,620,987,512 |  2,554,362,144 | -29.5% |

All agreed warm gates pass for this workload: identical successful tests, total
and preparation medians within 110% of local, and no increase in observed peak.
The capacity test's 811,096,536 allocated-byte reduction also exceeds 90% of the
796,336,496-byte logical duplicate candidate. Logical candidates and allocated
savings are stated separately because cluster allocation affects their sizes.
After ten shared runs, inspection found **zero unreferenced blob bytes**.

The compact [machine-readable evidence](shared-cache-windows-results.json)
contains every final run ID and measurement plus executable/patch hashes. Raw
JSON, stderr, XML results, logs and manifests are archived locally under
`output/shared-cache-native`. `scripts/benchmarks/summarize-shared-cache.mjs`
recomputes the gates and refuses incomplete ten-run datasets. Exploratory runs
are retained separately and are not included in the medians.

The feature is qualified for opt-in use on this tested warm workload. The default
remains local; no user configuration or legacy cache has been changed. This is a
single-machine, single-test-suite comparison, not a general Unity performance
guarantee. Cold startup cost is not qualified by the warm results. TestPlay remains
a separate, unpublished follow-up patch; HoneyBee's storage service is unchanged.
