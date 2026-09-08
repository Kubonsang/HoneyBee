# Child VHDX improvement validation — 2026-09-08

The explicit 1 MiB child candidate passed the native Unity benchmark. Median
persisted child allocation fell by **177,209,344 bytes (18.84%)** after two Unity
sessions. This qualified the storage candidate for integration. The subsequent
[hb10 integration record](child-vhdx-integration.md) tracks package pins,
installed service checks and remaining release gates.

## Measured result

Windows build 26200, Unity 6000.6.0f1, one frozen GNF project seed, one shared
2 MiB parent, 4096-byte sectors, 64 GiB virtual capacity. Three fresh children per
geometry were run in alternating order, with a first open and reopen each.
Timings below exclude tracing and hash verification. MB means decimal MB.

| Median                                  | 2 MiB child | 1 MiB child |  Change |
| --------------------------------------- | ----------: | ----------: | ------: |
| Persisted allocation after final detach |   940.57 MB |   763.36 MB | −18.84% |
| First Unity open and exit               |    27.564 s |    26.885 s |  −2.46% |
| Second Unity open and exit              |     5.741 s |     5.684 s |  −0.99% |

All six children completed both Unity sessions successfully. Parent identity and
requested geometry checks passed. Final manifests were read through read-only
attachments; backing allocation was unchanged by verification. The two compacted
copies retained every Library file hash. The registered gate was at least 5%
capacity savings and at most 10% regression in either median timing, with three
untraced paired samples per geometry. All conditions passed.

This is one project on one host, with a warm host cache and only two Unity
sessions per child. It does not establish cold-boot performance, long-term growth,
or a universal savings percentage. See the [machine-readable results](child-vhdx-windows-results.json)
for individual samples and trace aggregates.

## Why the backing file grows

Separate WPR FileIO captures covered first open and reopen for one fresh child
per geometry. All four traces reported zero lost events and buffers. On first
open, exact-Library-path write requests totalled 360,261,462 bytes for 2 MiB and
356,784,566 bytes for 1 MiB. `Library/Bee` accounted for 345,964,595 and
342,319,763 bytes respectively, about 96% in both cases. Leading files included
the build graph `.dag`, `.dag.json`, `.dag.payloads`, `tundra.log.json`, and
compiled/post-processed DLLs. This workload points to build-cache regeneration
as the main observed writer, rather than inferring writes from folder size.

These are cumulative requested bytes, including repeated writes and System
writeback, not unique changed content or physical disk traffic. Backing VHDX
paths outside Library are excluded to avoid counting that layer again. Xperf
reported unrelated .NET event-version decoder warnings; FileIO decoded, no write
names were unresolved, and malformed CSV bytes outside the matched Library rows
were preserved and counted. Traced timings are excluded from the acceptance gate.

The first untraced pair illustrates allocation amplification: the 2 MiB child
occupied 930,086,912 bytes, of which 222,871,552 bytes were child-sourced sectors
and 701,972,480 bytes were unused capacity inside allocated payload blocks.
The 1 MiB child occupied 773,849,088 bytes, with 214,859,776 child-sourced sector
bytes and 553,746,432 payload slack bytes. Each had 5 MiB of other file space.
Sector ownership is not a semantic diff or live filesystem usage; slack is not
a promise that compaction can reclaim it. FILE_STANDARD_INFO allocation and
backing file length agreed for these detached fixtures.

## Compaction and measurement correction

Offline `CompactVirtualDisk` on a detached copy reclaimed **0 bytes** in both
geometries: 930,086,912 → 930,086,912 and 773,849,088 → 773,849,088. Calls took
3.098 s and 3.007 s, and content checks passed. Automatic compaction is therefore
not justified by this experiment. Attached read-only compaction and longer-lived
user children were not tested.

The preliminary campaign hashed Library on writable mounts between Unity runs.
This host reports NTFS last-access updates enabled (`disablelastaccess = 2`), and
allocation changed around verification. That campaign is excluded from
qualification. The final `readonly-verification-v2` protocol measures first,
detaches, and then hashes through a read-only attachment. The summarizer rejects
legacy measurements or any allocation change during final verification.

## Implementation and checks

- [Storage patch](../../integrations/storage/child-block-1mib.patch): explicitly
  requests 1 MiB blocks for new children. Existing 2 MiB parents are reusable;
  retained children keep their geometry. Native tests disproved parent-only
  tuning: an unspecified child block size remained 2 MiB even with a 1 MiB parent.
- Isolated storage candidate: full Go suite, vet, build, native geometry and
  parent-identity tests passed. Patch applies to the exact hb9 base.
- HoneyBee benchmark tools: full Go suite, vet, build and native geometry test
  passed. Python allocation, acceptance-gate and FileIO tests: 18 passed.
- Original source content hashes matched. All three disposable experiment trees
  were removed after disk detachment checks and verified artifact archival.
  Raw ETLs are kept locally as gzip files whose decompressed hashes were checked.

Local evidence is under `output/child-vhdx-native/`: preliminary campaign
`child-vhdx-bench-20260908-a` (excluded), qualified campaign
`child-vhdx-bench-20260908-b`, and traced campaign
`child-vhdx-trace-20260908-b`. Each has allocation data, logs, manifests, archive
hash receipts and a successful cleanup receipt. FileIO summaries, trace statistics
and compression receipts are in `output/child-vhdx-*`. Raw system traces stay local.

## Remaining product integration

The [integration record](child-vhdx-integration.md) records the later publication
and installation of hb10. Those release gates remain separate from this passing
benchmark. No installed service, production workspace or release was changed
during the allocation experiment itself. The machine-readable benchmark record
retains the shipping status at benchmark completion.

Reproduction commands and source references are in the
[benchmark guide](../../scripts/benchmarks/vhdx/README.md).
