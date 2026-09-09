# External Bee installed-service checkpoint — 2026-09-09

Storage component `0.0.0+cfa606fd4143.hb11` is installed and Running. The
installed broker passed legacy attachment, external Bee creation/reattachment,
one Windows SCM restart, one physical reboot, removal abort and removal of one
private cache while preserving the other. Both user projects are now ready;
all disposable children have been removed. **This is not a release.**

The [machine-readable checkpoint](external-bee-installed-results.json) records
completed installation, reboot, cleanup and user-project readiness checks.

## Completed physical reboot and user repair

Windows boot advanced from `2026-09-08T17:21:08.5000000Z` to
`2026-09-09T05:59:25.5000000Z` (14:59:25 KST). Both remaining fixtures passed
post-reboot attachment, marker/identity checks and transactional removal.
Their child images, private cache, lease/retained journals and workspace shells
are absent. Before repairing user workspaces, both original user VHDX files,
journals and registry still matched the pre-upgrade hashes.

The supported `initProject` API then updated both registered storage tool paths
to the hb11 desktop preview. `repairWorkspace` reconnected `combat` and `Room`
without rebuilding their parents or changing their lease/parent identities.
Both report `ready`, `available` and `libraryConnected`. Their 21 changed files
(17 in combat, four in Room), Git HEADs and indexes were byte-identical before
and after repair. The registry was intentionally updated by these supported
operations; its before/after copies are retained. Image hashes are not claimed
unchanged after the intentional writable reattachment.

The actual packaged GUI now passes all **27 doctor checks, zero warnings and
zero failures**, with both workspaces ready. No Unity editor/test workload was
launched against the user's dirty worktrees. The original GNF Unity evidence
remains in the separate product integration report.

Final broker state: four parents, zero active children, two original retained
children, zero pending operations and zero quarantine; no manual recovery or
GC block. Free space is approximately 64.17 GiB. The small fixture parent stays
subject to the broker's ordinary retention policy; no global GC was performed.

Evidence: `output/external-bee-physical-reboot.json`,
`output/external-bee-installed/resume-reboot-result.json`, `cleanup-result.json`,
`output/external-bee-user-repair/` and
`output/external-bee-desktop-post-reboot/`. The remaining sections document the
earlier installation checkpoint and the issues resolved afterward.

## Installation and preservation

- Previous component: `0.0.0+c238f283ded2.hb10`.
- New host SHA-256:
  `9b790d02c399d1b47aa94cab1863dfe092fb3a89775714b00f01ccc3ca6141aa`.
- The installer returned `SWITCHED`; receipt, executable hash and Running state
  matched the packaged candidate.
- Two original user child images, their lease/retained journals and the user
  registry remained byte-identical, including after the GUI checks.
- The previous host, receipt, broker configuration, registry and journals are
  backed up under `output/external-bee-service-backup/`.

This machine currently has two original retained workspaces. The older hb10
report's four-child inventory belongs to its earlier checkpoint.

## Installed broker checks

The normal-user script
[external-bee-upgrade.mjs](../../scripts/dogfood/external-bee-upgrade.mjs)
created a disposable legacy child under hb10, then reattached it under hb11.
It created an external Bee parent through the packaged schema-2 client and
two independent children through the installed service. Probe contents,
child identity, exact mount GUID, private junction target, retained Tundra
state and omitted DAG file were verified. The normal user could write private
data but could not overwrite the cache ownership marker.

The actual service process changed from PID 14100 to 36044 during SCM restart;
Windows did not reboot. All three fixtures reattached with their contents and
identities intact. One external fixture was then removed, and the surviving
external fixture passed another attach/read/heartbeat/retain cycle.

The usage companion reported separate child/private Bee entries and exactly
one shared seed entry for the new parent. The remaining legacy and external
fixtures total **32,505,856 allocated child bytes**. These tiny marker fixtures
test compatibility and persistence, not GNF capacity or Unity performance.

Two harness assumptions were corrected during this run: abort keeps the
session attached, so it must be released before another attach; successful
broker removal can already remove the workspace shell. The committed receipt
and absence of the exact owned child/cache/shell were checked before resuming.
Timestamp comparisons normalize ISO precision. These corrections did not
change the installed storage binaries.

## Actual desktop verification and packaging correction

The local preview was opened with its real preload/IPC and installed service,
without smoke fixtures. It listed two registered projects and two workspaces,
queried their usage and passed all storage checks, including bundled hash,
installed version and broker responsiveness. Evidence and a screenshot are in
`output/external-bee-desktop/`.

This check found stale compatibility hashes embedded in the previously built
desktop main bundle, despite current resource files and executable hashes.
The main bundle was rebuilt and the preview repackaged. Packaging now rejects
a main bundle missing the approved version or payload hashes before replacing
output directories. A deliberately stale hash was rejected; the exact good
bundle was restored and packaged successfully. The packaged desktop smoke and
real-service GUI check then passed again. The check and result are recorded in
`output/external-bee-package-guard.json`.

Before the completed user repair, the doctor reported 23 passes and four failures. GNF and
UndergroundMazeVerticalSlice still reference prior registered storage tools;
`Room` and `combat` report `repair-required` with Library disconnected. The
user registry and authored changes were preserved. These existing workspaces
were inspected, not repaired or migrated in this checkpoint. After reboot,
update their tool registrations through the supported project flow and repair
the connections while preserving dirty files. Disposable legacy attachment
passing does not establish that these two user workspaces have been repaired.

## Archived pre-reboot checkpoint

Pre-reboot state: four parents, zero active children, four retained children
(two original plus two fixtures), zero pending operations and zero quarantine.
There was no manual recovery or GC block. The two disposable fixtures were
retained until post-reboot verification. Free space was approximately 64.19 GiB
at this checkpoint; no large Unity workload was repeated.

Recorded Windows boot: `2026-09-08T17:21:08.5000000Z`.
The normal-user command below completed successfully after reboot. Do not rerun
it after fixture cleanup:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File output/resume-external-bee-reboot.ps1
```

The wrapper requires a newer Windows boot, verifies both retained fixtures and
original-user preservation, then removes only the fixtures through broker
transactions. A failed check keeps uncertain data for inspection. The tiny
new parent remains a broker-managed cache subject to normal retention; no
global GC is run against unrelated parents.

Local evidence: `output/external-bee-service-install.json`,
`output/external-bee-scm-restart.json`,
`output/external-bee-installed/*-result.json`, usage reports and removal receipt.
No commit, push, installer publication or release was performed in this step.
