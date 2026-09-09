# Child VHDX allocation benchmark

## Beta 9 footprint study

See the [2026-09-09 measured results](../../../docs/validation/workspace-footprint.md)
for the compression/capacity decision, trace attribution and verified cleanup.

`--footprint-study` compares the current E-dag behavior with native NTFS
compression of its private external Bee and 32/16/8 GiB virtual disks. It does
not compress VHDX files or change the installed broker, user workspaces, Windows
last-access policy, or hibernation settings. Use a frozen authored export with
no Library, Unity 6000.6.0f1 and the existing GNF capacity probe/test contract.

```powershell
go -C tools/workspace-storage-host build -o ../../output/honeybee-footprint-study.exe ./cmd/honeybee-vhdx-bench
# Elevated terminal, from repository root; use a NEW root under tmp.
./output/honeybee-footprint-study.exe --footprint-study --root "$PWD/tmp/footprint-study" `
  --source '<frozen-export>' --unity '<Unity.exe>' --testplay '<testplay.exe>'
```

The runner preserves Tundra state and regenerates the DAG for every policy.
Compression and independent Bee copying count toward preparation time. Two fresh
one-cycle samples screen each policy, reversing order in the second round.
If full Bee compression misses a timing gate, artifacts-only compression gets
two samples. Independently passing compression/geometry candidates also receive
a combined pilot. Every candidate needs at least 5% combined savings to advance
to three fresh five-cycle samples alongside contemporaneous E-dag controls.

Qualification requires at least 20% combined cache savings and no more than 10%
median regression in preparation-plus-first-open, first-open, reopen, edit/test
or PlayMode. Observed combined peaks must not exceed control; child peaks are
reported separately as a component. Child
allocation is sampled at 250 ms; combined allocation at approximately one second
and phase checkpoints. These are observations, not absolute peak bounds.
The smallest qualifying candidate wins; within 5% of the smallest combined
allocation, prefer lower preparation-plus-first-open latency. Only a qualifying
winner proceeds to two independent children, three concurrent reattachments and
a surviving-child test after removing its peer.

Ordinary files use `FILE_STANDARD_INFO.AllocationSize`. Compressed/sparse files
use `GetCompressedFileSizeW`. The latter reports EOF for ordinary files, so it
cannot replace the first counter. Samples identify corrected accounting as
`native-allocated-v2`. An older completed campaign can explicitly obtain fresh
confirmation with `--footprint-confirm --root '<existing-root>'`; prior evidence
is retained and never silently relabeled. Confirmation refuses duplicate starts.

The same 35 GiB initial free-space requirement, 20 GiB reserve and 15 GiB
experiment budget as the startup study apply. Samples are archived, hash/CRC
verified and reclaimed only after confirming detachment and exact owned paths.
Parent/source fixtures remain until final analysis and verified campaign cleanup.

`--footprint-diagnostic --root '<terminal-root>'` creates one separately traced
E-dag sample, excluded from timing gates. Complete Library extent inventories
and owned VHDX sector runs distinguish regular data, directory/system metadata,
mixed blocks and unresolved sectors. NTFS v3 metadata records are queried with
read-only `FSCTL_GET_NTFS_FILE_RECORD`; inaccessible or partial records remain
explicit unknowns. No filesystem repair or metadata rewriting is performed.

```powershell
python scripts/benchmarks/vhdx/analyze_footprint.py '<root>' --output output/footprint-attribution.json
python scripts/benchmarks/vhdx/correlate_footprint_writes.py '<root>' `
  --xperf '<xperf.exe>' --output output/footprint-write-correlation.json
```

Write correlation translates offsets only for matching before/after extent maps.
It does not establish intermediate file identity, exclusive first-touch writes,
or causal amplification. A directory is eligible for a separate experiment only
when the conservative exclusive-block screening estimate, minus the entire
private directory copy, reaches 50 MB. Otherwise no directory is selected.
The first campaign does not automatically introduce an unmeasured extra layout.

After terminal confirmation, `--footprint-edit-diagnostic --root '<root>'`
captures one independent edit/import plus EditMode/PlayMode cycle. Its before
inventory and sector bitmap are collected while detached or attached read-only;
the after inventory uses another read-only attachment. Analyze its trace with
`correlate_footprint_writes.py --phase edit` to distinguish newly allocated
payload blocks from blocks the child already owned before editing. First-open
and edit-cycle tracing are separate and excluded from qualification timings.

Once both analysis and evidence validation finish, use
`cleanup-footprint.ps1 -Root '<root>' -Archive '<checkout>/output/footprint-evidence.zip'`.
It refuses active experiment processes, unexpected/nested disks, linked paths,
changed parent images or references from the user registry. It verifies all
sample archives and the final campaign archive before removing the experiment
root, then records actual free-space recovery. The input authored export is
preserved because it may be supplied by the caller rather than created by this
runner.

Native metadata parsing follows Microsoft's
[file record header](https://learn.microsoft.com/en-us/windows/win32/devnotes/file-record-segment-header)
and [attribute mapping pairs](https://learn.microsoft.com/en-us/windows/win32/devnotes/attribute-record-header).
NTFS compression uses the standard mutable-file mechanism documented by
[Microsoft](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/compact),
not `/EXE` compression intended for files that are seldom modified.

## External Bee startup study

`--startup-study` runs a separate `startup-v2` experiment with the current external
Bee seed, metadata preservation, removal of the copied ILPP PID, and regeneration
of the top-level DAG/state files while keeping compiled artifacts. An unchanged
legacy parent is measured as a contemporaneous control. Two short diagnostic
samples screen each policy; a selected candidate and the control then receive
three fresh samples with five edit/test cycles each.

The current practical gates are a 350 MB median child, 400 MB observed child
peak, 550 MB median child plus external cache, and at most 10% regression in
first-open, reopen, edit/test and preparation-plus-first-open medians. A passing
candidate proceeds to two independent batch Unity processes, three retained
reattachment rounds, and a survivor test after deleting the other sample.
This does not constitute GUI or reboot validation or change product defaults.

The study requires 35 GiB free before starting, reserves 20 GiB of host free
space, and checks a 15 GiB experiment budget with a 2 GiB admission reserve
between samples. Host free space is polled every five seconds. Tree scans,
compression and verification are outside timed phases. Each completed sample
is archived with verified SHA-256 entries before reclaiming its project, VHDX
and private Bee directory. Only two candidate samples are retained for the
compatibility tests. An uncertain attachment or unverified archive prevents
deletion. A failed experiment retains diagnostic state for explicit recovery.

```powershell
go -C tools/workspace-storage-host build -o ../../output/honeybee-startup-study.exe ./cmd/honeybee-vhdx-bench
# Run elevated, with a new root and an authored-file export containing no Library.
./output/honeybee-startup-study.exe --startup-study --root "$PWD/tmp/startup-study" `
  --source '<frozen-export>' --legacy-parent '<parent.vhdx>' `
  --unity '<Unity.exe>' --testplay '<testplay.exe>'
python scripts/benchmarks/vhdx/summarize_startup.py tmp/startup-study --output output/startup-results.json
```

Policy snapshots include hashes and timestamps but do not prove that unchanged
content was never rewritten. First-run Bee profiles and raw Unity logs are
archived separately from timing qualification. Metadata preservation covers
creation/access/write times and supported basic DOS attributes; it does not
clone NTFS file IDs, ACLs or a running ILPP process identity.

If the original pilot completes successfully without selecting a candidate,
`--startup-refine` tests `E-dag`: regenerate the same DAG/input files but retain
`TundraBuildState.state` and its map. It reuses the immutable isolated parents,
preserves the original terminal status, and applies the same screening and
qualification gates. It refuses already-refined or qualified campaigns.

```powershell
./output/honeybee-startup-study.exe --startup-refine --root "$PWD/tmp/startup-study" `
  --unity '<Unity.exe>' --testplay '<testplay.exe>'
# Separate diagnostic run after the study is terminal; never counted as qualification timing.
./output/honeybee-startup-study.exe --startup-trace E-control --iteration 90 `
  --root "$PWD/tmp/startup-study" --unity '<Unity.exe>' --testplay '<testplay.exe>'
```

Trace runs capture their own named WPR FileIO session during first open. The
verified sample archive includes the ETL before deleting the loose trace and
sample caches. Decode a trace separately with the FileIO commands below; hash
snapshots alone cannot distinguish repeated writes of identical content.

`--startup-confirm` explicitly advances a completed, nonqualifying two-sample
DAG pilot to three fresh contemporaneous A/E-dag pairs. It preserves both pilot
statuses and writes the confirmation rationale before running. This is useful
when an interrupted session makes earlier controls a weak timing comparison;
it does not change gates or turn pilot failure into a pass. It refuses any
campaign that has already started final qualification. All final samples,
including the first pair, remain in the reported result.

See the [startup findings](../../../docs/validation/external-bee-startup.md)
for measured results, cleanup receipts and outstanding validation.

## 300 MB capacity campaign

The [2026-09-08–09 results](../../../docs/validation/child-vhdx-capacity-300mb.md)
show that none of the five candidates passed the registered capacity gate.
External Bee reduced combined cache cost by 36.55%, but missed both the 300 MB
child target and the first-open timing gate.

`run-capacity.ps1` and the benchmark's `--capacity` mode compare five isolated
layouts: A (a copy of the existing parent), B (fresh Library), C (fresh parent
without Bee), D (fresh Library with Bee and ScriptAssemblies copied last), and E
(the same parent as C, with an individually owned external Bee junction seeded
from the fresh Library's Bee directory). The empty-junction pilot was replaced
by Unity with a normal directory; each phase now verifies the exact link target.
No installed broker or existing workspace is mutated. Export the selected Git
commit into a new source directory first; never supply a live project Library.
The export must contain the GNF map/combat tests used by this campaign.

```powershell
go -C tools/workspace-storage-host build -o ../../output/honeybee-vhdx-capacity.exe ./cmd/honeybee-vhdx-bench
# Run elevated; the wrapper requires a new output root under this checkout's tmp.
./scripts/benchmarks/vhdx/run-capacity.ps1 -SourceProject '<frozen-export>' `
  -LegacyParent '<immutable-parent.vhdx>' -Unity '<Unity.exe>' -TestPlay '<testplay.exe>' `
  -OutputRoot "$PWD/tmp/capacity-campaign" -Runs 3 -Cycles 5
python scripts/benchmarks/vhdx/summarize_capacity.py tmp/capacity-campaign --output output/capacity-results.json
```

Use `-Runs 1 -Cycles 1` for a pilot, which cannot qualify a candidate. Each full
sample opens twice, then performs five code revision/resource reimport cycles.
Every cycle runs 37 EditMode tests (36 project tests plus one revision/import
probe) and 15 PlayMode tests. TestPlay must report the process backend; no shadow
Library is created. Edit timings include compilation and tests rather than
claiming to isolate compiler time. External Bee allocation is measured separately
and included in combined bytes; the machine-global Bee cache is not redirected.

The primary threshold is 300,000,000 allocated child bytes at all checkpoints and
observed peaks (250 ms polling). All three timing medians must stay within 10%
of A; combined child + external Bee allocation must also decrease. Source assets
and shared parents are separate costs. Native allocation inspection must run on
detached samples; final manifests/extents use read-only attachments. LCN extent
records describe placement within NTFS, not physical offsets in the VHDX file.
Neither matching content nor unallocated sector ownership alone proves a live
disk's reclaimable size. Qualified candidates still require separate concurrent,
retained reattachment, and removal checks before any product integration.
`--capacity-verify <mode>` performs three concurrent retained cycles on samples
0 and 1 in a completed campaign, with a different code/resource revision in each
workspace. It writes a separate compatibility report and changes those owned
sample children, so collect the capacity allocation report first.

After the campaign, inspect the detached sample children with `inspect_vhdx.py`.
`correlate_capacity_layout.py` combines that allocation report with the recorded
NTFS cluster size, partition offset and top-file extents. File/block overlap is
descriptive, not write attribution; overlapping groups must not be summed.

The campaign leaves its owned disks and artifacts for inspection. Cleanup must
verify exact paths, disk detachment and absence of reparse points before removing
anything. Never recursively remove a mounted Library or an existing user workspace.
`archive_capacity.py` preserves terminal campaign JSON, logs and TestPlay result
evidence without archiving disposable VHDX or Library contents. It verifies each
archived file's SHA-256 and writes an archive receipt. Collect allocation and
layout reports before removing the disks, and retain those reports alongside
the evidence archive:

```powershell
python scripts/benchmarks/vhdx/archive_capacity.py tmp/capacity-campaign output/capacity-evidence.zip
```

## Block-size campaign

This is a developer experiment, not an installed HoneyBee command. It uses the
pinned storage library, one fresh 2 MiB parent, and explicit 2 MiB / 1 MiB
children. It never calls the broker, changes the installed service, or mutates an
existing user child. All created disks stay under a newly claimed checkout/tmp
directory. There is no recursive automatic cleanup.

## What is measured

- A frozen, hash-verified copy of Assets, Packages, ProjectSettings, and Library
  from a closed Unity source project. Original source hashes are checked again
  at completion.
- Three fresh children per geometry, alternating execution order. Each child
  opens and exits Unity twice, with successful batch exit and no C# errors.
- Physical allocation after creation, first Unity exit, second Unity exit, and
  final detach. No Library hash traversal occurs between timed Unity runs.
- A final Library manifest through a read-only attachment after detach. Physical
  allocation must be identical before and after verification. Changed-content totals count complete
  added/changed files, not write traffic or child-specific allocation.
- Offline CompactVirtualDisk on a separate copy of the first child per geometry.
  The copy is reattached read-only, its parent identity checked, and every Library file
  hash compared with the pre-compaction manifest.
- Optional WPR FileIO traces around Unity. Each trace uses its own instance name
  and a PID sidecar; traced timings cannot qualify performance.

## Build and check

Run from the HoneyBee checkout:

```powershell
go -C tools/workspace-storage-host build -o ../../output/honeybee-vhdx-bench.exe ./cmd/honeybee-vhdx-bench
go -C tools/workspace-storage-host test ./...
go -C tools/workspace-storage-host vet ./...
python -m unittest discover -s scripts/benchmarks/vhdx -v
$env:HONEYBEE_VHDX_GEOMETRY_TEST = '1'
go -C tools/workspace-storage-host test ./cmd/honeybee-vhdx-bench -run TestNativeChildGeometry -v
```

The opt-in native test creates temporary, unmounted images. It confirms that a
1 MiB child can use a 2 MiB parent. Setting only the parent's block size does not
work on the measured Windows host: an unspecified child block size became 2 MiB.

## Native run

Close Unity editors. Use an elevated PowerShell terminal from this checkout;
Windows requires elevation to attach the disposable benchmark disks. Keep enough
free space for the frozen source, parent, six children, two compaction copies,
and Unity-generated files. The runner refuses an existing output directory and
ancestor reparse points. It does not remove partially completed experiments.

```powershell
./scripts/benchmarks/vhdx/run-windows.ps1 `
  -SourceProject 'C:\path\to\UnityProject' `
  -Unity 'C:\Program Files\Unity\Hub\Editor\6000.6.0f1\Editor\Unity.exe' `
  -OutputRoot "$PWD\tmp\child-vhdx-benchmark" -Runs 3
python scripts/benchmarks/vhdx/summarize.py tmp/child-vhdx-benchmark
```

For file write attribution, run a separate fresh experiment with `-Runs 1
-TraceWrites`. Open each `*-first.log.etl` or `*-reopen.log.etl` in Windows
Performance Analyzer, filter File I/O by the Unity PID in the adjacent
`.process.json` plus its worker processes and the exact experiment Library path,
and group Write events by file path. WPR is system-wide; keep raw ETL files local.
Hash manifests alone cannot detect a rewrite whose final bytes are unchanged.
If stopping a trace fails, the error names this experiment's instance. Stop that
instance explicitly; do not cancel other WPR sessions.

With Windows Performance Toolkit installed, export the kernel FileIO provider
and aggregate by exact Library path (including System writeback):

```powershell
xperf -i '<sample>-first.log.etl' -o output/fileio.csv -e output/xperf-errors.log -a dumper -provider '{90cbdc39-4a3e-11d1-84f4-0000f80464e3}'
xperf -i '<sample>-first.log.etl' -o output/trace-stats.txt -a tracestats
python scripts/benchmarks/vhdx/summarize_fileio.py output/fileio.csv --library 'C:\exact\experiment\Library' --output output/fileio-summary.json
```

Check trace event/buffer loss and decoder errors before interpreting counts.
The CSV reader preserves undecodable bytes and reports affected rows; use
`--encoding` for a known export code page. Verify that matched Library rows have
no decoding issues. Requested bytes count repeated writes; they cannot be
equated to unique changed bytes, child allocation or physical disk traffic.
The [2026-09-08 results](../../../docs/validation/child-vhdx-improvement.md) include
the qualified measurements and separate trace aggregates.

## Decision rule registered before Unity measurements

The candidate qualifies this benchmark only if all samples finish, all
compaction content checks pass, the median persisted child allocation after the final
detach falls by at least 5%, and median first-open and second-open times each
regress by no more than 10%. At least three untraced samples per geometry and
paired, unique iterations are required. Protocol `readonly-verification-v2` is
required: legacy writable hash scans can change NTFS last-access metadata and
are rejected even if all Unity runs passed. `summarize.py` refuses incomplete or
traced input. Passing this benchmark does not replace installed broker,
retained/reboot, or packaging validation. Compaction has a separate measured
benefit and must not be enabled automatically based on the block-size result.

## Inspect existing children without attaching

```powershell
python scripts/benchmarks/vhdx/inspect_vhdx.py 'C:\path\child.vhdx' --output output/child-analysis.json
```

The inspector validates header/region CRC32C, geometry, BAT bounds, bitmap
presence, non-overlapping extents, and repeated stable reads. An active metadata
log or changing image fails inspection; the tool never replays the log. Stable
reads are observational, not a frozen snapshot. `childSourcedSectorBytes` is the
read source, not semantic changes, live file usage, or cumulative writes.
`modeledOneMiBPayloadBytes` keeps sector ownership/offsets fixed and is an
estimate, not observed savings. `payloadSlackBytes` is not a compaction promise.

## External Bee retained lifecycle

Run the DAG-only candidate independently of the historical startup capacity
gate. Use a new absolute root, a frozen authored export without Library, and
the same Unity, TestPlay and legacy-parent inputs as the startup study:

```powershell
./output/honeybee-vhdx-bench.exe --startup-lifecycle --root 'C:\path\new-study' --source 'C:\path\frozen-export' --unity 'C:\path\Unity.exe' --testplay 'C:\path\testplay.exe' --legacy-parent 'C:\path\parent.vhdx'
python scripts/benchmarks/vhdx/summarize_lifecycle.py 'C:\path\new-study' --output output/lifecycle-results.json
```

This elevated experiment prepares two fresh, private external Bee caches,
runs three concurrent attach/edit/play/detach rounds, removes one sample, and
tests the survivor. It archives evidence before deleting each sample's caches.
The parent images and frozen export need separate verified cleanup. It retains
the startup study's 35 GiB admission requirement and 20 GiB free-space floor.
`lifecycleValidated` is independent of `qualified`; this mode never changes the
historical capacity decision. It does not exercise the installed broker, GUI,
service restart or reboot. See the [measured lifecycle results](../../../docs/validation/external-bee-lifecycle.md)
and [product integration scope](../../../docs/validation/external-bee-product-integration.md).

## Broker-managed external Bee integration

The `--broker-bee` mode exercises actual broker transactions with two private
Unity workspaces. Build the benchmark with a Go workspace selecting the patched
storage module described in `integrations/storage/external-bee-overlay.json`.
The default pinned module lacks this capability; the runner rejects it before
creating a VHDX. Use a fresh experiment root under HoneyBee's `tmp` directory
and an isolated authored export without Library:

```powershell
./output/bee-product-gnf.exe --broker-bee --root 'C:\Users\user\Documents\HoneyBee\tmp\new-bee-study' --source 'C:\path\frozen-export' --unity 'C:\path\Unity.exe' --testplay 'C:\path\testplay.exe'
python scripts/benchmarks/vhdx/summarize_broker_bee.py 'C:\Users\user\Documents\HoneyBee\tmp\new-bee-study' --output output/broker-bee-results.json
python scripts/benchmarks/vhdx/archive_capacity.py 'C:\Users\user\Documents\HoneyBee\tmp\new-bee-study' output/broker-bee-evidence.zip
```

The elevated runner requires 35 GiB free and monitors a 20 GiB floor. It
prepares a parent, acquires two children, runs edit/play cycles, retains and
reconnects after broker recreation, removes one and tests the survivor. It
does not replace the installed service. Archive evidence before separately
cleaning the exact experiment/export roots. Uncertain failures retain data.
See the [product results](../../../docs/validation/external-bee-product.md).

## Sources

- [VHDX blocks and sector bitmaps](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-vhdx/43b647c6-6e6c-48c3-a436-3deebd622f44)
- [Payload BAT states](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-vhdx/01da203b-b3d7-487d-928b-22a460bbe177)
- [CreateVirtualDisk parameters](https://learn.microsoft.com/en-us/windows/win32/api/virtdisk/ns-virtdisk-create_virtual_disk_parameters)
- [CompactVirtualDisk](https://learn.microsoft.com/en-us/windows/win32/api/virtdisk/nf-virtdisk-compactvirtualdisk)
- [WPR instance names](https://learn.microsoft.com/en-us/windows-hardware/test/wpt/wpr-command-line-options#instancename)
