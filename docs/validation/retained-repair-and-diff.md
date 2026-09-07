# Retained repair and change review follow-up

## Failure and implementation

Repair does not require a clean Git worktree. Dirty-state protection applies to
removal. The reported repair failure instead compares the actual Library volume
GUID with an older retained-lease journal GUID.

The hb8 retained-attach path does not persist the new physical path and volume
GUID returned by a reattach. The storage follow-up checkpoints that identity
before exposing the mount and commits the session identity before success.
Legacy mismatches require proof that the observed volume belongs to the exact
recorded VHDX and parent. Arbitrary targets remain rejected. Existing files are
preserved; migration to another Workspace is only a fallback after identity
reconciliation cannot safely recover the original.

HoneyBee maps both the new `retained-mount-identity-mismatch` code and hb8's
specific nested `validate-stale-mount-target` failure to
`storage.mount-identity-mismatch`, while preserving the upstream diagnostic code.
The UI explains that committing files or rebooting alone will not fix the issue.

## Change review

The file list and unified diff stay visible together. File categories describe
paths, not authorship: code/content, Unity settings, metadata and other files.
Settings and `.meta` changes are never automatically discarded or hidden.

The viewer supports line numbers, addition/deletion colors, file search, bounded
new-file previews and per-file scroll restoration. A long patch renders at most
180 rows at once. Both patch and preview reads retain the 1 MiB limit. Untracked
previews reject links and hard links. Binary files are identified separately.

Diff remains the combined working-file difference from HEAD. An empty combined
diff can coexist with staged/unstaged changes; the viewer does not infer a clean
worktree from empty text. The existing Git deletion protection is unchanged.

## Validation and outstanding gates

- HoneyBee full verification passed 87 tests in 21 suites, Go host tests,
  formatting, lint, type/build and dependency checks.
- Electron smoke verifies simultaneous file list/preview, untracked contents,
  large-patch windowing, file-switch/refresh scroll preservation and stale-response
  isolation, alongside the existing PowerShell continuity and lifecycle checks.
- Screenshots were inspected at 1280x820 and 960x820.
- Storage tests cover repeated GUID/boot changes, checkpoint failure preservation,
  idempotent retain and identity error reporting; all Go tests, vet and race checks
  passed. Frozen-source verification retains the original manifest and records
  subsequent changes in its explicit overlay.
- The read-only native probe verified the recorded child file identity and parent,
  but Windows assigned a volume GUID different from the stale mount target.
  The current reconciliation gate therefore cannot qualify that legacy mount.
  A follow-up partition-identity inspection was cancelled at Windows elevation.
  Actual recovery, service replacement and repeated physical reboot validation
  remain pending. No live Workspace recovery is claimed.
- Storage commit `796514b475bece93635df504a32e1bcb54b95493` is published in
  [storage PR #4](https://github.com/Kubonsang/unity-workspace-storage/pull/4).
  All five storage CI jobs passed, including Windows, Linux and macOS tests.
- Beta 7 pins the public Go module, bundled client/host and compatibility hashes
  together as `0.0.0+796514b475be.hb9`. Integrated verification again passed all
  87 tests, and both candidate package smoke checks and packaged PTY passed.
  These are review candidates; no new public release is qualified by this record.
