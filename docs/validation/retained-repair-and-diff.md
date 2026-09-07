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
- Actual legacy-volume reconciliation, service replacement and repeated physical
  reboot validation are still pending. The read-only elevation request was
  cancelled before execution. No live Workspace recovery is claimed.
- The storage change is locally committed; upstream publication and the atomic
  HoneyBee dependency/compatibility pin update remain pending. No new public
  release is qualified by this record.
