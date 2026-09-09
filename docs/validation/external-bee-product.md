# External Bee product integration — 2026-09-09

Later checkpoint: hb11 is now installed and has passed SCM restart, physical
reboot and actual desktop checks. Both existing projects are ready and the
fixtures are removed; see [installed-service validation](external-bee-installed.md).
The sections below retain the earlier isolated implementation evidence.

The `external-bee-dag-v1` layout is implemented in HoneyBee and its storage
broker as local component `0.0.0+cfa606fd4143.hb11`. Desktop and CLI preview
packages build and pass their smoke checks. The installed hb10 service and
user workspaces were not upgraded or migrated. This is not a release.

## Result

An isolated broker using actual GNF Unity projects passed **364 tests across
14 TestPlay process runs** and 18 observed phases. Both workspaces retained and
reattached after broker recreation; removing the first workspace preserved the
second, whose final EditMode and PlayMode runs passed before removal.
Both removal receipts are committed and their child images/private Bee caches
were absent when the results validator ran.

| Workspace |      Last observed child VHDX | External Bee logical bytes |
| --------- | ----------------------------: | -------------------------: |
| one       | 340,787,200 bytes (340.79 MB) |          156,125,964 bytes |
| two       | 341,835,776 bytes (341.84 MB) |          156,225,566 bytes |

These phase measurements precede final detach. They are integration evidence,
not a new capacity qualification. The external column measures file lengths,
not NTFS allocation. The completed performance campaign remains **357.56 MB
median child / 510.98 MB combined cache**; its historical 350 MB median gate
remains failed. The user's approximate 300 MB objective is compatible with
evaluating this improvement without changing that recorded gate.

Machine-readable results: [external-bee-product-results.json](external-bee-product-results.json).
Unity version: 6000.6.0f1; TestPlay: 0.11.0; frozen authored GNF revision:
`4caf0731a0a5959ffa61f6c3d110f303f8779f80`.

## Implemented behavior

- New parent preparation requests the advertised layout before beginning a
  transaction. An old broker rejects the capability request. Legacy parents
  and retained records keep their existing layout.
- A parent contains a Bee-less image and an immutable, content-verified seed.
  A directory rename publishes the complete bundle atomically. Pinned handles,
  volume identity checks and link rejection protect privileged reads.
- Each child owns a separate Bee cache. Seeding omits only the allowlisted
  DAG/input files and retains compiled artifacts and Tundra state/map files.
  Reattachment validates the owner and exact junction target without reseeding.
- Removal reserves cache files before deleting the child. Busy files preserve
  the workspace; abort releases reservations. Interrupted cleanup retains its
  journal so a recreated broker can finish the removal.
- Shared seed and private Bee appear separately in usage. Quota, admission and
  GC include them; VHDX usage stays separate. Regular-file allocation uses NTFS
  allocation size, with the compressed/sparse fallback retained.
- Builds start from clean storage commit
  `cfa606fd4143a13b2d229f9d1e24e48ae0ddb8fa`, apply the pinned overlay in an
  isolated clone, and record component identity and patch hash.

## Validation

| Check                                            | Result                                                              |
| ------------------------------------------------ | ------------------------------------------------------------------- |
| HoneyBee Vitest                                  | 22 files, 91 tests passed                                           |
| Core/CLI and desktop TypeScript checks/builds    | Passed                                                              |
| Storage Go suite / vet / Linux cross-build       | Passed                                                              |
| HoneyBee host Go suite / vet                     | Passed                                                              |
| Python benchmark regressions                     | 35 tests passed                                                     |
| Storage provenance                               | 48 active destinations; original 42-entry frozen manifest unchanged |
| Native VHDX lifecycle                            | Four successive corrected runs passed                               |
| Actual GNF broker lifecycle                      | 364 tests passed                                                    |
| Packaged desktop IPC/UI, CLI and interactive PTY | Passed                                                              |
| Final three tool binaries rebuilt                | Identical byte lengths and SHA-256 hashes                           |

Native tests cover independent children, owner protection, retained reconnect,
busy-file refusal, abort, removal of one child while preserving the other,
and retry after an injected cleanup failure and broker recreation. A normal,
non-elevated user could write private cache data but could not modify its owner
marker. The first native run exposed a directory-handle sharing conflict;
enumeration was changed to use the held handle and the later runs passed.
The failed run's evidence is retained with the passing runs.

The final native run also checks NTFS allocation accounting. The GNF binary
predates that bookkeeping correction and the final unsupported-layout early
guard; those changes passed native or unit/build checks separately. The final
preview packages contain both corrections. In-process broker recreation tests
persisted state; it does not establish Windows SCM or physical-reboot behavior.

## Artifacts and cleanup

- Overlay: [external-bee.patch](../../integrations/storage/external-bee.patch),
  SHA-256 `0753739093fdfe953516541e6e31945023941d2c7e068e5822290b145fd94582`.
- GNF evidence: `output/bee-product-gnf-evidence.zip`, 160 files, 850,275 bytes,
  SHA-256 `7be2f0536fc8e5b83d3724a36c62fecb75016a2c671ed69d131b0450efab63ba`.
- Native evidence: `output/bee-native-evidence.zip`, 30 evidence files,
  12,102 bytes, SHA-256
  `4f4a8e89afeaa5f38f028466ea68ff04d67207b85c101e5e154cadd92dfaa359`.
- Desktop: `apps/desktop/release-bee-preview/HoneyBee-win32-x64/HoneyBee.exe`.
- CLI: `apps/cli/release-bee-preview/HoneyBee-cli-win32-x64/`.

Archive contents were checked with CRC and per-file SHA-256 before cache
cleanup. Exact owned roots, detached images and unexpected links are checked
by the cleanup script. Its outcome is recorded in
`output/bee-product-cleanup.json`; source patches and evidence archives are
retained. Installed storage and unrelated workspaces are outside that cleanup.

Cleanup completed at 04:01 KST on 2026-09-09: seven owned temporary roots were
removed, with 32,322 files inventoried before the first attempt. Protected seed
files required an elevated retry. Observed free space increased by
2,842,021,888 bytes (2.65 GiB), reaching 69,092,216,832 bytes (64.35 GiB).
Both remaining experiment VHDX files were detached before removal; the stale
mount point from the failed native run was removed without traversing its target.

## Remaining acceptance work

Upgrade the installed service to the reviewed component, then verify the GUI
with a newly prepared parent, existing legacy workspaces, SCM restart and a
physical reboot. Commit/push, release versioning and publication are separate
from the locally built previews documented here.
