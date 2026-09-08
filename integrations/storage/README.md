# 1 MiB child VHDX integration

Runtime change is published on `feat/child-block-1mib` as storage commit
`c238f283ded29f716f72e7d556cfeef3efd98639`. The provenance-only follow-up is
`cfa606fd4143a13b2d229f9d1e24e48ae0ddb8fa`; HoneyBee's Go module and prepared
source pin now reference that final commit. Client, host and compatibility
metadata retain `0.0.0+c238f283ded2.hb10`, the unchanged runtime identifier.

The hb10 service is installed locally. A retained child created by hb9 kept its
2 MiB blocks; a new child created by hb10 uses 1 MiB. Each passed three attach,
read, heartbeat and retain cycles. Four pre-existing user child images retained
their whole-file hashes across the upgrade and subsequent physical reboot.
Both fixture geometries passed post-reboot reattachment and were then removed.
See the [integration record](../../docs/validation/child-vhdx-integration.md).

`child-block-1mib.patch` targets unity-workspace-storage commit
`796514b475bece93635df504a32e1bcb54b95493`. It explicitly requests 1 MiB payload
blocks for newly created differencing children. Parent geometry, compatibility
keys, existing retained children, and their attach path are unchanged. Existing
2 MiB parents can be reused; no new parent cache is required for this change.

The Windows API test found that a zero child block size produces a 2 MiB child
even from a 1 MiB parent. The patch also corrects the old CreateOptions comment
that said children inherit all parent geometry.

The isolated implementation is `tmp/storage-child-1mib`. Apply only to an
isolated checkout at the exact base:

```powershell
git apply --check <path-to-child-block-1mib.patch>
git apply <path-to-child-block-1mib.patch>
go test ./...
go vet ./...
$env:UNITY_WORKSPACE_STORAGE_GEOMETRY_TEST = '1'
go test ./storage -run TestDifferencingChildGeometry -v
```

The full Go suite, vet, build, and opt-in unmounted native test passed on
2026-09-08. The native test checks a new 1 MiB child, the retained 2 MiB child,
and their 2 MiB parent including sector size, virtual size, and parent identity.

The actual Unity benchmark passed: three fresh children per geometry reduced median final
allocation from 940,572,672 to 763,363,328 bytes (18.84%), with no timing regression
against the registered gate. Separate FileIO traces identified Bee build-cache
writes as the main observed writer. Offline compaction reclaimed no space; all
compaction content checks passed. See the
[native results](../../docs/validation/child-vhdx-improvement.md) and
[benchmark protocol](../../scripts/benchmarks/vhdx/README.md).

Existing children are not rewritten or shrunk by the change.

## Published provenance record

`provenance-overlay.patch` applies to `c238f283ded29f716f72e7d556cfeef3efd98639`
and updates only `PROVENANCE.md` and `provenance/post-rc-destination-sha256.tsv`.
The repository's layered destination check requires the two new normalized
source hashes. With the overlay applied it passes all 48 active destinations;
the original 42-entry frozen manifest stays unchanged. The patch does not alter
runtime source. The user explicitly approved publication, and the exact patch
was committed and pushed as `cfa606fd4143a13b2d229f9d1e24e48ae0ddb8fa`.

The patch is retained as a review artifact. The build checkout and module pin use
the published follow-up. All three runtime executables reproduced byte-for-byte,
and Go tests/vet plus both package smoke checks passed against the final pin.
The planned installed-compatibility gate passed, including one physical reboot
and exact fixture cleanup. See HoneyBee's changelog for consuming app releases.
