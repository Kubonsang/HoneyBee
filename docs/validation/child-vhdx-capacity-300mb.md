# Child VHDX 300 MB capacity experiment

No candidate meets the registered 300 MB child-allocation threshold. External
Bee is the only candidate with a large observed reduction, but its VHDX still
exceeds the target during repeated editing. This campaign therefore does not
qualify a new HoneyBee storage default or a release.

E reduces median child allocation from **775.95 MB to 338.69 MB (56.35%)**.
Including its private external Bee directory, median per-workspace cache cost
is **492.31 MB**, a **36.55%** reduction. Its maximum observed child allocation
is **373.29 MB**, and first-open time increases by **70.89%**. Both the capacity
and first-open timing gates fail.

## Full campaign result — 2026-09-08–09 KST

All 15 samples completed, with 180 phases and **3,900 passing test executions**
across 150 TestPlay process runs. Every child requested and reported 1 MiB
blocks. Final read-only manifests were collected without changing child
allocation in all 15 samples. Detached allocation inspection succeeded for all
15 children, and no selected-file extent queries failed. The original installed
parent's SHA-256 was unchanged at campaign completion.

| Candidate                     | Final child median | Maximum observed child | External Bee median | Combined median | Combined savings vs A |
| ----------------------------- | -----------------: | ---------------------: | ------------------: | --------------: | --------------------: |
| A — legacy                    |          775.95 MB |              809.50 MB |                   0 |       775.95 MB |              baseline |
| B — fresh                     |          767.56 MB |              776.99 MB |                   0 |       767.56 MB |                 1.08% |
| C — omit Bee                  |          791.67 MB |              809.50 MB |                   0 |       791.67 MB |                −2.03% |
| D — copy hot directories last |          786.43 MB |              809.50 MB |                   0 |       786.43 MB |                −1.35% |
| E — external Bee              |          338.69 MB |              373.29 MB |           153.67 MB |       492.31 MB |                36.55% |

Final child bytes are measured after detach. The maximum includes the 250 ms
observed peaks, phase checkpoints and final detached allocation. Combined
medians are computed from each sample's child-plus-external sum; independently
computed component medians need not add to the combined median. E's three final
children were 336.59, 338.69 and 348.13 MB; their peaks were 339.74, 339.74 and
373.29 MB. Even the smallest detached result exceeds 300 MB.

| Median timed phase                     |        A |        B |        C |        D |        E |
| -------------------------------------- | -------: | -------: | -------: | -------: | -------: |
| First Unity open and exit              | 38.527 s | 34.282 s | 45.982 s | 34.202 s | 65.839 s |
| Reopen and exit                        |  6.687 s |  6.733 s |  7.306 s |  6.875 s |  6.867 s |
| Recompile, reimport and EditMode tests | 11.686 s | 11.346 s | 11.255 s | 11.429 s | 11.526 s |
| PlayMode tests                         | 29.933 s | 29.719 s | 29.965 s | 29.841 s | 29.789 s |

C's first open regresses by 19.35%; E's regresses by 70.89%. B and D satisfy
the timing gate but miss the capacity target. E's reopen and edit/test medians
stay within 10%, so its measured performance problem is concentrated in the
first-open phase. In the first A/E pair, Unity reports initial asset refresh
times of 34.462 s and 58.640 s respectively. That local log observation does
not establish which cache operation causes the additional time.

Shared parents are separate fixed costs: A 1,331.69 MB, B 1,402.99 MB,
C 1,197.47 MB, D 1,411.38 MB. E uses the exact same parent file as C, rather
than another copy. A selected layout needs its own applicable parent cost once;
these parent costs are not added to every workspace or presented as five
simultaneous product requirements. Authored files, TestPlay evidence and
machine-global cache growth are outside the per-workspace cache totals above.

The [machine-readable results](child-vhdx-capacity-results.json) retain individual
samples, all timing ratios, allocation components, selected-file block overlaps,
parent costs and evidence archive hashes without absolute user paths.

## Allocation findings

E's median allocation decomposes into **41.05 MB of child-sourced sectors**,
**292.39 MB of payload slack**, and **5.24 MB of other file space**. There is
substantial block amplification left after Bee separation. This is measured
allocation, not a claim that 292.39 MB can be compacted away.

Fresh-parent B and reordered-parent D contain the same seed files, but D does
not improve final allocation: 786.43 MB versus B's 767.56 MB. In their first
samples, selected Bee files overlap 321 allocated blocks for B and 339 for D.
The serial copy order changes placement; it does not demonstrate that later
Unity writes stay confined to fewer blocks.

For E's first sample, selected Library-root files overlap 41 allocated blocks
and ScriptAssemblies files overlap six. This partial extent selection does not
explain all 316 allocated payload blocks in that sample, so it does not justify
choosing the next directory to move based on its apparent folder size.

## Scope and protocol

This is an isolated developer benchmark on Windows with Unity 6000.6.0f1 and
TestPlay v0.11.0. It does not change the installed HoneyBee broker, its runtime
defaults, existing workspaces, or parent images. The authored project is an
export of GNF commit `4caf0731a0a5959ffa61f6c3d110f303f8779f80`; uncommitted
changes in the user's project are excluded. MB means 1,000,000 bytes.

Five candidates use explicitly requested 1 MiB child payload blocks, 4096-byte
sectors and 64 GiB virtual capacity:

| Candidate                     | Parent and Bee placement                                                            |
| ----------------------------- | ----------------------------------------------------------------------------------- |
| A — legacy                    | Hash-verified copy of the existing GNF parent                                       |
| B — fresh                     | New parent from an isolated, freshly imported Library                               |
| C — omit Bee                  | Same fresh seed, with Bee omitted from the parent                                   |
| D — copy hot directories last | Same content as B, with Bee and ScriptAssemblies copied last                        |
| E — external Bee              | Exact C parent, plus a private external Bee directory seeded from the fresh Library |

Each candidate has three fresh samples. Each sample opens Unity twice, then
performs five code revision and resource reimport cycles. Every cycle runs
37 EditMode tests (36 GNF tests plus one compilation/import consistency probe)
and 15 PlayMode tests. The probe verifies that the newly compiled revision and
the reimported TextAsset agree. TestPlay must use its process backend with
`--no-bridge`; no shadow Library is involved. Candidate order rotates between
iterations. Read-only content verification runs outside timed phases.

The registered capacity gate requires every measured child allocation,
including observed peaks sampled at 250 ms, to stay at or below 300,000,000
bytes. Median first-open, reopen, and compilation-plus-EditMode-test times may
regress by at most 10% relative to A. The combined child and external Bee cost
must decrease. Shared parent allocation and authored source files are reported
separately from per-workspace cache cost. A qualifying candidate then requires
independent concurrent-workspace and retained-reattachment validation.

## Pilot corrections

The first pilot created an empty external Bee directory. Unity replaced that
junction with a normal directory in this experiment, so its result is invalid
as a Bee-separation measurement. E now receives a copy of the fresh seed's Bee
content before first launch. The native reparse target is checked after every
Unity or TestPlay phase. Each workspace owns its external directory; this is
not a writable cache shared between Unity editors.

The pilot also exposed a traversal issue when collecting NTFS file extents at
a mounted volume root. The full campaign uses explicit mounted-root traversal,
rejects an empty candidate list, and records partition offset and cluster size.
The empty pilot extent report is not evidence about file placement. A separate
seeded E pilot passed its 52 tests and retained the junction, but pilots do not
qualify the capacity target.

## Interpretation limits

Observed peaks are samples rather than a mathematical upper bound. Timings
include process startup and tests, not isolated compiler CPU time. This is one
GNF project on one host, with batch Unity sessions and a warm host cache; it
does not establish long-term interactive-editor behavior or cold-boot timing.
The machine-global Bee cache is not redirected by this experiment.
Timed phases exclude parent preparation, authored-file copies and E's initial
external Bee copy. They do not measure end-to-end workspace creation latency.

VHDX sector ownership describes which disk supplies reads. It is neither a
semantic file diff nor a count of live filesystem bytes. Allocated payload
slack is not a promise that Windows compaction can recover that space.
The [VHDX specification](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-vhdx/43b647c6-6e6c-48c3-a436-3deebd622f44)
defines the block and sector-bitmap distinction. File/block overlap uses
NTFS extents, the recorded partition offset, and child allocation metadata;
it is not write attribution. Extent collection covers the 80 largest selected
Bee, ScriptAssemblies and Library-root files, not all filesystem data or NTFS
metadata. Overlapping directory groups must not be added together.

The earlier [block-size experiment](child-vhdx-improvement.md) used two Unity
opens per child. Its sizes and write traces are a different workload and must
not be presented as this campaign's results or the user's current Room size.

## Next implementation decision

Use E as the starting point for a separate write-attribution experiment. Trace
the first open and first few edit/test cycles, correlate exact Library file
writes with owned VHDX sectors, and account for NTFS metadata and new allocation.
The present top-file extent sample cannot identify every contributor to the
remaining VHDX cost. Select any additional cache separation from those measured
writes, then repeat the same capacity and combined-cost gates; moving a large
folder is not evidence that it removes the blocks causing the remaining cost.

The child already uses 1 MiB payload blocks, the
[VHDX minimum](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-vhdx/ec0e9d25-69e4-439e-806a-e0c23f0e1ae6).
Reducing that setting again is not an available route. Copy order alone did not
solve this workload, and payload slack must not be treated as an automatic
compaction opportunity. A later candidate must establish a repeatable margin
below 300 MB and pass concurrent-editor, retained/reboot, repair and removal
checks before it becomes a product option.

The first-open regression must be investigated alongside further space savings.
The current E layout is a useful experimental lead, but its 65.839 s median
first open does not satisfy the registered performance requirement.

## Validation and evidence

Go package tests and `go vet ./...` pass. All 25 Python benchmark tests pass,
including incomplete-campaign rejection, peak-based qualification, external
cost accounting, timing regression, VHDX metadata validation and NTFS partition
offset correlation. The real Windows junction test also verifies seeded content,
target identity and preservation of the external directory when removing its link.

The separate concurrent/retained gate was not run because no candidate passed
the capacity gate. The implementation includes that verification mode for a
future qualifying candidate; this campaign does not claim concurrent-editor,
reboot or installed-service validation of external Bee.

Local evidence archives contain 1,673 full-campaign files and 187 pilot files.
Every entry was SHA-256 checked after archiving, and both ZIPs passed CRC
verification. Raw Unity/TestPlay logs, manifests, extent records, phase JSON
and campaign identities remain in those local archives. Standalone allocation
and layout reports are also retained under `output/`. Disposable images and
project copies are excluded from the archives.

Cleanup completed on 2026-09-09 at 00:11 KST. The two campaign roots and frozen
export were removed only after archive identity/hash checks, exact-path checks,
reparse-point rejection and confirmation that all 29 experiment VHDX files were
detached. No experiment Unity or benchmark process remained. The installed
service, its existing parent/child files and the user's Room workspace were
outside the cleanup roots. The local cleanup receipt records the exact paths;
the public results contain only their experiment names.
