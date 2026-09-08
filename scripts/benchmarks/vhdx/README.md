# Child VHDX allocation benchmark

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

## Sources

- [VHDX blocks and sector bitmaps](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-vhdx/43b647c6-6e6c-48c3-a436-3deebd622f44)
- [Payload BAT states](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-vhdx/01da203b-b3d7-487d-928b-22a460bbe177)
- [CreateVirtualDisk parameters](https://learn.microsoft.com/en-us/windows/win32/api/virtdisk/ns-virtdisk-create_virtual_disk_parameters)
- [CompactVirtualDisk](https://learn.microsoft.com/en-us/windows/win32/api/virtdisk/nf-virtdisk-compactvirtualdisk)
- [WPR instance names](https://learn.microsoft.com/en-us/windows-hardware/test/wpt/wpr-command-line-options#instancename)
