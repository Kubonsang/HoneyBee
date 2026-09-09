# Private Bee compression product integration — 2026-09-09

**Deployment checkpoint:** local hb12 installation is reconciled. The running
host and receipt match, and diagnosis reports `executableDigestMatches: true`.
Normal-user upgrade, SCM restart and physical Windows reboot checks passed, including compressed-cache
inheritance, retained reattachment, removal abort and surviving-child checks.
The installed-service reboot qualification is complete. These results qualify the
storage payloads packaged for Beta 10; publication is recorded by its GitHub release.

HoneyBee now packages storage component **0.0.0+cfa606fd4143.hb12**. The broker
applies native NTFS compression to the private Bee data of **new workspaces**.
Existing parent seeds can be reused; existing retained caches keep their current
compressed or uncompressed state. No parent rebuild or in-place migration is
required.

The user accepted this integration after the [footprint study](workspace-footprint.md)
measured **483.80 → 392.31 MB combined cache (18.91% reduction)**, with all timing
regressions within 10%. Its original 20% qualification gate remains failed.
Product lifecycle acceptance is a separate decision; these measurements do not
guarantee a fixed allocation for every project or prolonged use.

## Behavior

- Compression runs after the broker copies the immutable seed into its new
  private `data` directory and before it grants Unity write access.
- The broker opens and pins the complete destination tree first. Reparse points,
  hard-linked files and conflicting writers are rejected before mutation.
  Compression uses the verified handles, flushes files, and propagates failures
  through the existing recoverable acquisition path.
- Directory compression attributes let subsequently created files inherit the
  policy. The mechanism supports mutable files; no `/EXE`/WOF compression is used.
- Reattachment validates existing ownership and junction identity without
  recopying or recompressing caches. VHDX containers, immutable parent seeds,
  source projects and compatibility keys retain their existing behavior.
- Broker quota/usage and the read-only usage companion already distinguish
  logical bytes from NTFS compressed allocation. Private Bee and child VHDX
  remain separately visible.

The reviewable implementation is in
[external-bee.patch](../../integrations/storage/external-bee.patch), pinned by
[external-bee-overlay.json](../../integrations/storage/external-bee-overlay.json).
Packaging applies the overlay to a clean checkout of
`cfa606fd4143a13b2d229f9d1e24e48ae0ddb8fa`, and records the overlay digest and
binary hashes. Desktop compatibility metadata selects hb12.

## Validation

The native lifecycle test passed compressed creation, an explicitly uncompressed
retained-cache compatibility case, private edits, broker recreation, busy-file
removal refusal, removal abort, interrupted removal recovery, surviving-child
content and parent GC. Ordinary NTFS tests cover content, allocation, inheritance
and hard-link rejection. Storage Go tests/vet and host tests passed.

The actual GNF campaign uses Unity 6000.6.0f1, TestPlay 0.11.0 and the same frozen
authored revision `4caf0731a0a5959ffa61f6c3d110f303f8779f80`. It creates two
independent broker-managed workspaces, checks compression after creation and
every edit/test phase, recreates the broker for three concurrent retained
rounds, then removes one workspace and tests its survivor. This validation is
isolated from the installed service and is not a new performance comparison.

The GNF campaign passed **572 tests in 22 TestPlay process runs**, with three
concurrent retained rounds and successful removal/survivor checks. Every
creation/test checkpoint retained compressed files and directory inheritance.
Both private caches and child images were removed through the broker.

| Last observed allocation | Workspace one | Workspace two |
| ------------------------ | ------------: | ------------: |
| Child VHDX               |     360.71 MB |     359.66 MB |
| Private Bee allocated    |      63.13 MB |      63.45 MB |
| Combined cache           |     423.84 MB |     423.12 MB |

These lifecycle observations precede detach and use a different workload from
the three-pair performance study. They do not replace its 392.31 MB median or
establish a new regression comparison. See
[machine-readable product results](bee-compression-product-results.json).

| Check                                           | Result                                                     |
| ----------------------------------------------- | ---------------------------------------------------------- |
| Storage Go suite / vet                          | Passed                                                     |
| Native compression and mixed retained lifecycle | Passed, 70.45 s                                            |
| Host Go suite / vet                             | Passed                                                     |
| Storage Linux cross-build                       | Passed                                                     |
| Frozen provenance parity                        | 48 active destinations passed; 42 frozen entries preserved |
| HoneyBee Vitest                                 | 22 files, 91 tests passed                                  |
| Python benchmark regressions                    | 46 tests passed                                            |
| CLI / desktop / interactive PTY package smoke   | Passed                                                     |
| Installed old-format fixture preparation        | Passed; two real user disk hashes recorded                 |
| Installed compression / SCM restart             | Passed; exact hb12 receipt and executable match            |
| Physical Windows reboot                         | Passed; legacy and compressed fixtures reattached          |

The initial `pnpm verify` formatting stage reports two pre-existing, untracked
user analysis documents. They are preserved. Formatting with those two paths
excluded, security/license checks, lint, typechecks, build, tests and dependency
checks pass; desktop IPC/UI, packaged PTY and CLI smoke checks pass.

## Installed validation and recovery

`scripts/dogfood/external-bee-upgrade.mjs` supports the explicit
`HONEYBEE_BEE_COMPRESSION_UPGRADE=1` profile. It checks exact hb11/hb12 tool and
receipt identities, preserves hashes of real user disks and registry metadata,
and verifies compression attributes and inheritance in newly created fixtures.
SCM restart and physical Windows reboot are recorded separately. Reboot fixtures
are preserved until the resume phase observes a changed Windows boot identity.

Recovery completed at 19:06 KST. The service restarted from PID 36344 to 35924
at 19:08 KST without a Windows reboot. Both normal-user phases passed. Of three
installed fixtures, one compressed fixture was removed and its compressed
survivor verified; one legacy and one compressed fixture were preserved for reboot.
The old hb11 executable and receipt remain in the evidence directory for rollback.

The first replacement had failed while deleting `.replacement-previous.exe`,
leaving an hb11 receipt beside the new executable. Its subsequent UAC retry was
canceled. The resumed installer reconciled this state successfully. During the
new preflight, both real user VHDX hashes differed from their earlier baseline;
their modification times matched the interrupted replacement at 18:00:32 KST.
File IDs, lengths, lease journals and retained journals were unchanged, no
clients were active, and repeated current hashes were stable. The precise byte
changes are not known. The original evidence is preserved, and a separate
recovery baseline was recorded before proceeding. Successful preservation checks
apply from that recovery baseline, **not across the earlier interrupted install**.
The workspace registry hash remained unchanged.

The physical reboot changed the Windows boot timestamp from
`2026-09-09T05:59:25.5000000Z` to `2026-09-09T10:21:32.5000000Z` (19:21 KST),
and the broker boot identity also changed. Normal-user `resume-reboot` passed
after that reboot: both fixtures reattached with their saved contents and mount
identity intact; the compressed fixture preserved its Bee junction, ownership
record, file/directory compression and inherited compression on the private file.
Post-reboot diagnosis confirmed running hb12 with a matching executable digest.
This is installed-service fixture validation, not another Unity performance run.

The subsequent normal-user `cleanup` passed. All three installed test children
are now removed, including the two preserved for reboot; their VHDX files,
private Bee data and workspace shells were checked absent. Final broker status
has only the two original retained user children, with zero active children,
pending operations or quarantine entries. User disk and journal hashes still
match the recovery baseline, and the registry hash is unchanged. The small
shared test parent (90,177,536-byte image plus a 32-byte allocated Bee seed)
remains under the ordinary broker retention policy; no global GC was forced.

Evidence: `output/bee-compression-installed/resume-reboot-result.json`,
`output/bee-compression-installed/cleanup-result.json`,
`output/bee-compression-post-reboot-environment.json` and
`output/bee-compression-post-reboot-diagnose.json`. No further reboot checkpoint
is pending for this qualification.

The GNF evidence archive is verified at `output/bee-compression-gnf-evidence.zip`
(SHA-256 `22de06b1eef3d83482c275fdb05a095b091ddc272a16d12f1129b4f26da069a1`).
The isolated native/GNF roots were removed at 19:12 KST after evidence validation.
GC had retained the unused experimental parent because there was no capacity
pressure. Cleanup verified its exact path, recorded content hash, detached state
and empty child/lease/pending/quarantine directories before deleting that isolated
fixture. Free space rose from 60,653,117,440 to 63,331,983,360 bytes: an observed
**2.49 GiB increase**, leaving **58.98 GiB free** at that checkpoint. This free-space
delta can include concurrent system activity. The installed reboot fixtures were
subsequently removed as recorded above. The source export and shared test parent
remain; Windows hibernation settings were not changed.

The archived summary predates a wording correction: compressed-campaign Bee
allocation uses compressed/sparse allocation or ordinary file allocation, with
logical lengths reported separately. Raw measurements and the archive hash are
unchanged. The current summarizer and product results carry the corrected wording.

Preview packages are written to `release-bee-compressed-preview` under each app.
The previously published Beta 9 artifacts are preserved. The Beta 10 release
packages are rebuilt from the tagged source and verified against these qualified
storage payload hashes.
