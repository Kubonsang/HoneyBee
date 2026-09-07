# Shared TestPlay cache and Workspace storage usage

This is an opt-in follow-up to Beta 7. It retains ordinary Git worktrees and the
existing hb9 Library-only VHDX service. No service replacement is required.

## Measure first

In Desktop, open the Workspace's **Storage / 용량** tab and choose **Measure /
refresh**. Measurements run only on request. From the CLI:

```powershell
honeybee workspace usage --json
honeybee workspace usage combat --project <project-id> --json
```

The report separates ordinary files, local TestPlay cache, child VHDX, shared
parent VHDX and the shared TestPlay store. `knownAllocatedBytes` deduplicates
physical file identities across the complete report. Per-entry allocated bytes
deduplicate hardlinks within that entry; summing entries can double-count links
between entries. Shared-store totals include other Workspaces and are not a
prediction of what deleting one Workspace would recover.

`null` means unknown. A partial entry reports observed bytes alongside errors;
it must not be treated as a complete measurement. Library junction contents are
excluded from ordinary files. Shared parents are counted once even when an
unavailable Workspace retains their child. Measurements are live observations,
not filesystem snapshots; directory/MFT overhead and the shared Git repository
are outside this accounting.

The companion uses [FILE_STANDARD_INFO allocation size](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_standard_info)
for ordinary files and compressed-file allocation for sparse/compressed files.
It does not attach volumes, repair leases or change journals.

## TestPlay opt-in

The installed TestPlay v0.11.0 does not understand these settings or commands.
Use the matching follow-up build and keep the previous executable available.
Add the following fields to the existing config without replacing its test,
timeout or Unity settings:

```json
{
  "workspace": {
    "cache_mode": "shared-content"
  }
}
```

The default store is `%LOCALAPPDATA%\TestPlay\Cache\v1`. An optional absolute
`workspace.cache_root` selects another store outside the Unity project. The mode
applies to the legacy shadow provider; it does not force shadow execution or
change Bridge selection. Explicit image/VHDX providers cannot be combined with
this mode. An absent setting or `"local"` retains existing behavior.
The first run without a compatible shared manifest builds a new cache; warm-run
timings do not describe that initial cost.

Each Workspace retains its own compatibility key and file manifest. Only equal
file contents share storage. Unity runs against independent restored files;
writable Library databases and package files are not linked across runs.
File contents are verified during publication and restore. Interrupted writes
leave the prior manifest in place; unreferenced blobs can be collected later.
Successful publication also collects blobs that no project manifest references,
under the store lock. A failed maintenance step is reported as a warning and
leaves the published cache usable. This prevents repeated successful runs from
accumulating obsolete generations.
Run the selected tests successfully before considering removal of a local cache.

## Preview and perform cleanup

```powershell
testplay cache usage --json
testplay cache prune --dry-run
testplay cache prune --execute
testplay cache retire-local --config .\testplay.json --dry-run
testplay cache retire-local --config .\testplay.json --execute
```

Pass `--store-root <absolute-path>` to usage/prune when using a custom store.
Those two commands operate on the selected shared store; they do not infer a
store from the current project. Prune defaults to a preview and only collects
blobs with no manifest references. Readers hold an OS lock throughout restore,
so writers and pruning cannot remove a blob being copied. Locks are released by
the OS when a process exits.

Retire-local reads the selected config, checks its current compatibility key,
verifies all referenced shared contents, verifies the old cache key and rejects
tracked files, links, unexpected cache entries, Unity locks and remaining shadow
directories. It targets only that project's `.testplay/cache`. Preview reports
logical bytes, not a guarantee of physical space recovery. Results, logs, Git
state, Assets and the project's main Library are preserved. `--clear-cache`
invalidates only the selected project's shared manifest; it does not clear the
whole common store.

No existing user cache or recovery copy is removed by installing HoneyBee or
TestPlay. Keep recovery copies and old cache data until their preservation
requirements have been resolved separately.

## Implementation and validation

TestPlay changes are implemented in the isolated checkout
`tmp/testplay-shared-cache`, based on commit
`95d65521ec2d56419b5b0e2351a70e0e1b2059ee`. The accompanying patch under
`integrations/testplay` preserves those changes for review and application to
the TestPlay repository. HoneyBee does not acquire test orchestration authority.

See [validation](../validation/shared-cache-usage.md) for measured savings,
performance results and qualification limits.
