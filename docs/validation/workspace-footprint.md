# Workspace cache footprint study — 2026-09-09 KST

Follow-up: the user accepted the practical result for
[product integration](bee-compression-product.md). The measurements and failed
20% benchmark gate below remain unchanged.

Native NTFS compression of private external Bee reduces median combined cache
allocation from **483.80 MB to 392.31 MB (18.91%, 91.49 MB per workspace)**.
All five median timing gates pass: first open increases 0.54%, preparation plus
first open 1.92%, edit/test 9.01% and PlayMode 2.69%; reopen improves 4.51%.

The registered 20% reduction gate is missed by **5.27 MB**, so qualification
remains **false**. This is a useful approximately 390 MB candidate, with little
timing margin left in edit/test. It is not an enabled product feature. No
candidate advanced to concurrent retained/survivor validation in this campaign.

## Final comparison

| Metric                         | E-dag control | Compressed external Bee |    Change |
| ------------------------------ | ------------: | ----------------------: | --------: |
| Final child median             |     328.20 MB |               329.25 MB |  +1.05 MB |
| External Bee allocation median |     155.56 MB |                63.04 MB |   -59.48% |
| Combined cache median          |     483.80 MB |               392.31 MB |   -18.91% |
| Observed combined peak         |     497.34 MB |               421.79 MB |   -15.19% |
| Observed child peak            |     339.74 MB |               339.74 MB | unchanged |
| First open                     |      38.737 s |                38.947 s |    +0.54% |
| Preparation + first open       |      45.206 s |                46.073 s |    +1.92% |
| Reopen                         |       7.521 s |                 7.182 s |    -4.51% |
| Edit/import + EditMode tests   |      12.678 s |                13.820 s |    +9.01% |
| PlayMode                       |      30.764 s |                31.591 s |    +2.69% |

Combined values are medians of per-sample sums, not sums of independent component
medians. The three compressed combined allocations are **389.15, 392.31 and
402.68 MB**; controls are **483.80, 481.67 and 495.04 MB**. Compressed edit/test
sample medians are 13.820, 13.992 and 9.981 seconds; controls are 12.678, 13.952
and 10.283 seconds. All samples are retained. These three samples on one host
do not establish a universal performance bound or long-term cache growth rate.

All six final samples completed five cycles and **1,560 passing test executions**.
The compression benefit persisted after repeated edits; all 1,359 Bee files in
each final compressed sample retained the compressed attribute.
The approximately 350 MB combined stretch objective remains unmet.

## Capacity screening

| Virtual capacity / policy | Combined cache median, exploratory |
| ------------------------- | ---------------------------------: |
| 64 GiB E-dag              |                          465.81 MB |
| 64 GiB, compressed Bee    |                          375.53 MB |
| 32 GiB E-dag              |                          526.60 MB |
| 16 GiB E-dag              |                          533.98 MB |
| 8 GiB E-dag               |                          516.69 MB |

Every smaller-volume pilot increases child allocation and fails to provide
combined savings. Each row has two fresh samples and one edit/test cycle; the
ordinary-file accounting limitation below applies to this table. It is useful
for rejecting these large regressions, not for claiming precise final savings.
Full compression passed pilot timing, so artifacts-only compression was not
needed. No volume/compression combination or additional directory was selected.

## Remaining child allocation

The first precise final control has **308 allocated payload blocks**: 193 fully
explained by filesystem/directory metadata, 67 by one regular-file group, 14
mixed and 34 unresolved. Its 328.20 MB container contains 41.54 MB of
child-sourced sectors, 281.42 MB of payload slack and 5.24 MB of other space.
Slack is not a promise that offline compaction can reclaim it.

The separately traced first-open sample has 295 blocks: 196 metadata-only,
71 regular-only, 22 mixed and 6 unresolved. No measured inventory supplies an
additional directory with the required conservative net 50 MB opportunity.
For example, copying BurstCache privately costs about 111.35 MB, more than the
25 exclusive payload blocks identified in the first final control. The results
support keeping 64 GiB and prioritizing external Bee compression over another
folder-size-based split; they do not prove a universal minimum child size.

The separate edit diagnostic observes **31 newly allocated payload blocks**
between detached snapshots and **16.28 MB of requested writes across 32,782
Library write events**. ArtifactDB writes overlap 10 new blocks, SourceAssetDB
8 and DataStore/uds.db 3; these counts are not exclusive and must not be summed.
The snapshots bracket reattachment and the edit/PlayMode cycle, so newly
allocated blocks cannot all be attributed exclusively to the traced tests.
Changed/missing extents leave 1.34 MB of requested writes unmapped, with another
0.025 MB outside mapped extents. Both trace loss counters are zero. Its 18,746
decoder warnings identify only the CLR provider. The final inventory has 309
blocks: 206 metadata-only, 75 regular-only, 22 mixed and 6 unresolved.

## Scope and reproducibility

The objective is allocated **child VHDX plus private external Bee**, with shared
parents and authored project/Git files reported as separate costs. MB means
1,000,000 bytes; disk free-space figures use GiB (1,073,741,824 bytes).
The control uses Beta 9's E-dag seed policy: regenerate the copied DAG/input
files while retaining Tundra build state and compiled artifacts.

Inputs are Unity **6000.6.0f1**, TestPlay **0.11.0**
(`b7e59fa7340a86df4953e1ab7de60da7332e85d6`), and the frozen GNF authored
revision `4caf0731a0a5959ffa61f6c3d110f303f8779f80`. The source ZIP SHA-256 is
`c5b2cbfb1aef1ca31655411df379d42f04320ad73636b336d90c859c8e79a82e`.
Experiments use independent disposable projects and private Bee directories;
all TestPlay executions use the process backend. There is no installed broker,
GUI, service restart or physical reboot validation in this study.

Two fresh one-cycle pilots compare uncompressed 64 GiB E-dag, native NTFS
compression of external Bee, and uncompressed 32/16/8 GiB capacities. All use
1 MiB payload blocks and 4 KiB sectors. Smaller capacities must preserve seed
headroom. A screened candidate needs at least 5% combined savings and no more
than 10% regression in each timing metric.

Fresh confirmation uses three samples per policy, five edit/test cycles per
sample, in alternating policy order. EditMode must pass 37 tests and PlayMode
15 tests on every cycle. Timings use per-sample cycle medians followed by the
median across fresh samples. Compression/copy preparation is included in the
preparation-plus-first-open metric. Traced diagnostic runs are excluded from
performance decisions.

The registered final gate is at least **20% combined allocation reduction**,
at most **10% median regression** in first open, reopen, edit/test, PlayMode and
preparation-plus-first-open, and no increase in observed combined peak.
Child allocation is sampled at 250 ms and combined allocation approximately
once per second plus phase/final-detach checkpoints. These are sampled peaks,
not guaranteed instantaneous maxima. Only a qualifying candidate advances to
the concurrent retained/survivor lifecycle experiment.

## Measurement corrections

The initial pilot executable used `GetCompressedFileSizeW` for ordinary files,
which reports EOF rather than ordinary NTFS cluster allocation. Final samples
use `FILE_STANDARD_INFO.AllocationSize` for ordinary files and the compressed
size API for compressed/sparse files, identified as `native-allocated-v2`.
Pilot measurements remain exploratory and are not relabeled as final evidence.
This distinction follows the documented
[GetCompressedFileSize behavior](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getcompressedfilesizew).

The pilot also applied an unintended child-only peak condition during screening,
leaving its original `advanced` list empty. Explicit confirmation preserves that
result and records why compression is admitted under the intended combined-cache
screening rule. The final gate measures combined peak; component child peak is
reported separately. Fresh iterations 200–202 provide the final comparison.
The final 20% savings and 10% timing thresholds were not lowered.

## Implemented tools

The benchmark now supports native mutable-file NTFS compression of private Bee,
capacity screening, fresh confirmation, complete Library extent inventories,
read-only NTFS metadata record queries, sector bitmap inspection, and separate
first-open/edit-cycle FileIO tracing. The independent Python report validator
checks geometry, expected executed tests, complete repeated workloads, precise
allocation accounting and unchanged allocation after read-only verification.

File writes are mapped through matching endpoint NTFS extents to VHDX payload
blocks. The edit diagnostic additionally excludes blocks already allocated
before its cycle. This is correlation, not exclusive first-touch or causal
attribution: intermediate file identity, freed/reallocated extents and resident
data can remain unresolved. Overlapping per-file block counts cannot be summed.
The first-open trace reports zero lost buffers/events. Its 8,255 decoder warnings
all identify the separate
[CLR provider](https://learn.microsoft.com/en-us/dotnet/framework/performance/controlling-logging);
none identify the FileIO provider. The analyzer records these warnings and rejects
unclassified or non-CLR decoder failures instead of silently trusting them.

Additional directory candidates require at least 50 MB of conservative screening
opportunity after subtracting an entire private directory copy. This estimate
only selects a separate experiment; it does not predict measured savings.

The experiment requires 35 GiB free to start, monitors a 20 GiB reserve, and
uses a 15 GiB fixture/evidence budget. Completed samples are archived with
SHA-256/CRC verification before reclaiming their detached child and private Bee.
Final cleanup checks parent identities, detachment, registry references, links,
active workers and all evidence archives before deleting the exact owned root.

Native NTFS compression is applied to mutable Bee files using the standard
[Windows compression mechanism](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/compact).
The VHDX container itself is not compressed; Windows documents attachment
restrictions for images hosted on compressed storage in
[AttachVirtualDisk](https://learn.microsoft.com/en-us/windows/win32/api/virtdisk/nf-virtdisk-attachvirtualdisk).
Read-only metadata decoding follows Microsoft's
[file record header](https://learn.microsoft.com/en-us/windows/win32/devnotes/file-record-segment-header)
and [attribute mapping pairs](https://learn.microsoft.com/en-us/windows/win32/devnotes/attribute-record-header).

Commands and safety checks are documented in the
[benchmark README](../../scripts/benchmarks/vhdx/README.md).

## Product boundary

The changes are benchmark and analysis tooling. They do not enable compression
in the installed product, migrate existing workspaces or change global Windows
last-access/hibernation settings. Hibernation storage is unrelated to the
per-workspace cache objective. Beta 9 remains the installed/released baseline.

## Validation and evidence

- Go host/benchmark tests and `go vet ./...`: passed.
- Python benchmark regression suite: **46 tests passed**.
- PowerShell cleanup parser validation: passed.
- Native GNF workloads: **2,184 passing test executions**, comprising 520 pilot,
  1,560 final and 104 separate diagnostic executions.
- Every completed child was detached, inspected, archived with verification and
  reclaimed. Read-only content/extent verification preserved its allocation.
- Concurrent/retained/survivor, installed service, GUI and reboot validation:
  not run for compression; the capacity qualification gate did not pass.

[Machine-readable results](workspace-footprint-results.json) preserve per-sample
values, the original screening decision, fresh confirmation provenance, decoded
block classes and trace uncertainty. Complete local evidence is retained under
`output/footprint-study-20260909-evidence` and `output/footprint-final-evidence.zip`;
raw system-wide traces stay in local verified archives. They are not included
in the repository report.

Final cleanup verified **18 sample archives** and the **41.20 MB campaign
archive**, then removed 30,269 files from the exact experiment root, including
all four detached parent images and the generated source Library. Actual C:
free space increased by **5.72 GiB**, from **56.80 GiB to 62.52 GiB** at cleanup.
This is the final cleanup's measured delta, not a sum of repeatedly reclaimed
temporary space or a claim that all host disk usage returned to its initial
value. The approximately 31 MiB authored input export and approximately
0.53 GiB of sample evidence remain available for reproduction.

The user registry hash stayed
`cf708f55fc2808ba690c03597da02ad21a5c3bb978a595a5df3c1bd81ad42a7c`.
The campaign archive SHA-256 is
`2dd72a53bbad9907f3ab4cbf821a0cb805f7981ba7f6fc1683c604831b627b27`.
Actual projects, workspaces, installed storage and Windows hibernation/page
files were preserved. The cleanup receipt is included in the JSON report.

The next product decision is whether the measured approximately 390 MB result
is worth adopting despite the unchanged 20% benchmark miss. If it is, retain
64 GiB and validate native external Bee compression through the broker's
creation, concurrent use, retained/reboot, quota and removal paths before
changing defaults. The present evidence does not justify further copy-order,
capacity-size or arbitrary directory externalization experiments.
