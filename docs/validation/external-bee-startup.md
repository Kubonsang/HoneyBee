# External Bee startup study — 2026-09-09 KST

Regenerating the Bee DAG while retaining Tundra build state removes the observed
30-second ILPP wait and retains most of the storage saving. In three fresh
five-cycle samples, **E-dag has a 357.56 MB child median**, a **373.29 MB observed
peak**, and **510.98 MB combined child plus private external Bee median**.
Preparation plus first open improves from **36.625 s to 32.140 s** against fresh
contemporaneous controls. All final timing gates pass.

The registered 350 MB child median gate is missed by **7.56 MB (2.16%)**; every
other registered storage/timing gate passes. The protocol therefore reports
`qualified: false`. This is a close candidate for the user's approximate size
goal, not a measured result below 300 MB or a qualified product release.

## Final comparison

| Metric                       | A — legacy |     E-dag | Registered candidate gate |
| ---------------------------- | ---------: | --------: | ------------------------- |
| Final child median           |  809.50 MB | 357.56 MB | <= 350 MB: miss           |
| Observed child peak          |  843.06 MB | 373.29 MB | <= 400 MB: pass           |
| Child + external Bee median  |  809.50 MB | 510.98 MB | <= 550 MB: pass           |
| First open                   |   34.200 s |  28.794 s | <= 110% of A: pass        |
| Preparation + first open     |   36.625 s |  32.140 s | <= 110% of A: pass        |
| Reopen                       |    8.107 s |   5.772 s | <= 110% of A: pass        |
| Edit/import + EditMode tests |    9.551 s |   9.440 s | <= 110% of A: pass        |

Child allocation decreases by **55.83%** and combined cache allocation by
**36.88%**. Shared parents and authored project/Git files are separate costs.
The total per-workspace cache is about 511 MB, not 358 MB.

All six final samples completed five edit/test cycles, yielding **1,560 passing
test executions**. Candidate preparation-plus-first-open times are 42.870 s,
32.020 s and 32.140 s; preparation alone is 12.876 s, 3.263 s and 3.346 s.
The slow preparation sample is retained in the result. The median improvement
does not establish consistently low cold preparation latency.

The DAG-only pilot initially failed preparation-plus-first-open timing against
earlier-session controls (42.837 s versus 35.654 s). After the interruption,
an explicitly recorded confirmation ran three fresh A/E-dag pairs in alternating
order, with no diagnostic snapshots in timed samples. No pilot result was
discarded, and no gate was changed. The final comparison supersedes the pilot
for repeated-workload timing, while its failed screening remains in the JSON.

The first final E-dag child owns only **41.53 MB** of sectors, with **310.79 MB**
of payload slack and **5.24 MB** of other file space. This is not a prediction
that the slack is directly reclaimable. Full filesystem/NTFS write-to-block
attribution and virtual-capacity experiments remain deferred.

## Completed original screening

The original ten fresh samples completed 40 phases and **520 passing test executions**.
Each policy has two diagnostic samples: first open, reopen, one code/resource
edit with 37 EditMode tests, and 15 PlayMode tests. All TestPlay runs used the
process backend. Read-only verification preserved allocation, and each sample
was archived and reclaimed after detachment.

MB below means 1,000,000 bytes. Two-sample medians are the mean of the two values.
These diagnostic pilots screen candidates; they are not final qualification.

| Policy                             | Final child median | Observed child peak | Child + external Bee median | First open | Preparation + first open |
| ---------------------------------- | -----------------: | ------------------: | --------------------------: | ---------: | -----------------------: |
| A — legacy control                 |          796.92 MB |           809.50 MB |                   796.92 MB |   33.394 s |                 35.654 s |
| E — original seed                  |          328.73 MB |           339.74 MB |                   482.22 MB |   57.900 s |                 61.270 s |
| E — preserve metadata              |          327.68 MB |           339.74 MB |                   481.17 MB |   58.067 s |                 61.704 s |
| E — remove ILPP PID                |          326.11 MB |           339.74 MB |                   479.59 MB |   59.635 s |                 63.036 s |
| E — regenerate DAG and build state |          474.48 MB |           475.00 MB |                   628.08 MB |   33.800 s |                 37.249 s |

The original E cuts combined cache cost by about 39.5% in this shorter workload.
It does not replace the previous five-cycle campaign's 492.31 MB result; the
workloads and contemporaneous controls differ.

## What the evidence supports

All six first runs across original E, metadata-preserving E and PID-removing E
report a **30.17–30.19 second** additional Tundra run. Their logs repeatedly
show `ILPP-Configuration Library/ilpp-configuration.nevergeneratedoutput` busy.
The control's corresponding additional run takes 0.26–0.27 seconds. Both graph
reset samples remove that extra run and the busy messages.

This isolates a stale build-graph/session dependency as a useful next target.
It does not establish the exact Unity RPC or process-liveness mechanism, or
prove that every form of externally generated Bee cache behaves identically.
Metadata preservation covers creation/access/write timestamps, directory
timestamps and supported DOS attributes. It does not preserve NTFS file IDs,
ACLs or a previous process identity.

In original E, 329 common Bee files change content on first open and 64 files
are added; another 363 retain content while metadata changes. The two samples
are consistent. The size of changed files is not write volume: snapshots do
not distinguish identical-content rewrites, repeated writes or partial writes.
The graph reset changes more metadata and updates 1,107 build nodes rather
than the roughly 465 updated by the warm-cache path. Child growth accompanies
that wider refresh; full causal file-to-block attribution has not been done.

## Follow-up and acceptance

The implemented `E-dag` refinement removes DAG/input files while retaining
`TundraBuildState.state` and its map. Both pilot samples and all three final
samples remove the additional Tundra run and ILPP busy messages. The final
samples update 465 build items, preserving the warm build-state behavior
instead of the graph-and-state reset's 1,107 updates. This supports retaining
build state while regenerating the session-dependent graph; it still does not
prove Unity's exact internal RPC/liveness mechanism.

The practical gates are child median <= 350 MB, observed child peak <= 400 MB,
combined cache median <= 550 MB, and at most 10% regression versus A in first
open, reopen, edit/test and preparation-plus-first-open time. Diagnostic
snapshots are excluded from the eventual final timing samples. Shared parent
creation remains a separate one-time cost.

A passing pilot automatically advances to three fresh samples per policy with
five edit/test cycles each, then two independent Unity batch processes, three
retained reattachment rounds and a survivor test after removing its peer.
The six final qualification samples ran. The conditional concurrent/retained
compatibility stage did **not run**, because the final child median exceeds
the registered gate; its two reserved samples were reclaimed. No GUI session,
installed-broker migration, workspace lifecycle integration or actual reboot
is claimed. Given the approximate capacity goal, the next useful product step
is lifecycle/concurrency validation of this candidate before integrating it,
rather than automatically expanding the capacity experiments.

## Separate first-open write traces

Two fresh diagnostic samples captured named WPR FileIO sessions and each passed
37 EditMode plus 15 PlayMode tests. Their timings and allocations are excluded
from qualification. Both traces report zero lost buffers/events and zero
unresolved global write events in the decoded FileIO stream. Xperf emits
invalid-event warnings for provider `{e13c0d23-ccbc-4e12-931b-d9cc2eee27e4}`;
the warning logs are retained. No warning for the selected FileIO provider
`{90cbdc39-4a3e-11d1-84f4-0000f80464e3}` was observed.

| Requested first-open writes | Original E |     E-dag |
| --------------------------- | ---------: | --------: |
| Mounted Library             |   39.12 MB |  41.55 MB |
| Private external Bee        |  521.75 MB | 389.04 MB |
| Library `$Mft`              |   19.83 MB |  20.06 MB |
| Library `$LogFile`          |    5.41 MB |   5.39 MB |

Repeated writes and System writeback count repeatedly. These numbers are not
unique changed content, physical-device traffic or VHDX allocated bytes. In
E-dag, `$Mft` and `$LogFile` alone account for about 61% of the observed Library
requested write bytes. NTFS metadata contribution is therefore observed, but
the share of allocated payload blocks caused by those writes is still unknown.

The largest Bee writes are DAG/JSON/payload files. For example, requested writes
to the main DAG decrease from 112.91 MB to 82.29 MB. Regenerating the graph
reduces repeated graph work while retaining build state. The captured logs
reproduce the original E's additional Tundra wait and its absence in E-dag;
the sanitized JSON includes exact log-derived values and trace run IDs.

Raw ETLs occupy 2.58 GB and 2.22 GB before compression. Verified sample ZIPs retain
them in about 223.56 MB and 199.84 MB respectively. Analysis uses streamed xperf
stdout, whose behavior is documented by [Microsoft](https://learn.microsoft.com/en-us/windows-hardware/test/wpt/processing),
and materializes no CSV. Each extracted ETL is removed after aggregation. Exact
Library and external Bee roots are filtered separately; all reported file names
are relative to those roots.

## Storage cleanup and reproducibility

Before the study, two unused generated Library trees were reclaimed:
`tmp/beta5-shared-host-20260905-b/source/Library` and
`tmp/unity-multi-agent-showcase/Library`. Exact paths, absence of reparse
points/VHDX files and lack of Unity processes were checked first. Authored
files, Git/LFS objects, installed storage and user workspaces were preserved.
The receipt records **5,651,488,768 bytes (5.26 GiB)** of observed free-space
gain. This is a host free-space delta, not an exact per-file allocation sum.

The runner requires 35 GiB free initially, reserves 20 GiB of host free space,
polls free space every five seconds and checks a 15 GiB experiment budget
between samples, including evidence archives and a 2 GiB admission reserve.
Every completed sample is SHA-256/CRC verified in an archive before its VHDX,
project and private Bee cache are removed. All **20** samples have been
reclaimed. After verifying all sample archives and the final campaign archive,
the isolated source, two parent VHDX files and authored export were also removed.
That final cleanup records **4,345,864,192 bytes (4.05 GiB)** of observed free-space
gain from newly created experiment data. Do not add it to the initial 5.26 GiB
as permanent savings: these are separate cleanup stages. An unrelated running
TestPlay process was preserved; the final process check uses the exact study path.

The study uses Unity 6000.6.0f1, TestPlay v0.11.0 and the authored GNF export at
`4caf0731a0a5959ffa61f6c3d110f303f8779f80`. Children use 1 MiB blocks,
4096-byte sectors and 64 GiB capacity. The installed parent hash remained
`b20fd99c0adf27f13f0a1152d7c1c5f88fd264669265cc09bffd14ddc6c8ecbc`.
The experiment changes no installed HoneyBee storage defaults or releases.

Local evidence:

- `output/startup-final-evidence.zip`: 625 campaign JSON/log/profile files,
  54,831,907 bytes, SHA-256
  `0958a153a02c40bd6b83560adaf946e22e6d47501d741520bb584d530fe8561c`.
- `output/startup-initial-evidence.zip`: 255 campaign JSON/log/profile files,
  31,033,921 bytes, SHA-256
  `ea5754a39c2110c3a911e57a141781652cb1e5e80cd9f4abaad23a381b23c8f5`.
- `output/startup-study-20260909-evidence/`: 20 verified sample ZIPs, including
  individual TestPlay evidence; each has a receipt with SHA-256 and file count.
- `output/startup-precleanup.json` and `output/startup-final-cleanup.json`:
  cleanup and free-space receipts.
- [Sanitized sample data, trace findings and archive hashes](external-bee-startup-results.json).
- [Runner and reproduction commands](../../scripts/benchmarks/vhdx/README.md).

Tool verification: `go test ./...`, `go vet ./...` and the Windows benchmark
build pass; the Python benchmark suite passes **30 tests**. Including original
screening, DAG refinement, final comparison and two diagnostic traces, the native
campaign completed **20 samples, 128 phases and 2,288 passing tests** across 88
TestPlay process runs. Individual run IDs and results are retained in the sample
archives; diagnostic trace run IDs are also in the sanitized JSON.
