# Workspace starting-point selection — 2026-09-10 KST

Desktop now selects a starting commit from local branches, tags, and locally available remote
branches. Commit messages, authors, and dates are shown; SHA entry is optional under Advanced.
Selection passes a full commit ID through the existing `base` field. CLI behavior and registry
schema are unchanged.

## Query and storage boundaries

- Reference pages contain at most 100 entries; history pages contain at most 50 commits. Symbolic
  remote HEAD aliases are omitted. Each Git process is limited to 5 seconds and 1 MiB of output;
  page offsets are capped at 100,000. Oversized queries fail with a retryable UI error.
- The main process coalesces identical in-flight requests. The renderer ignores obsolete responses
  and keeps only the current reference/history page. Older history uses the original resolved tip.
- Queries use local Git metadata with optional locks and lazy fetching disabled. There is no
  background fetch, clone, permanent index, or cache preparation on selection.
- Creation retains the existing Git worktree and Library-only CoW path, including compressed private
  Bee storage. The selected SHA becomes both the new branch HEAD and recorded `baseCommit`.

## Paired Core/Git measurement

Run `corepack pnpm build`, then `node scripts/benchmarks/workspace-base-selection.mjs` from the
repository root. The script writes isolated fixtures and raw results under
`output/workspace-base-selection/run-*`; it does not touch registered user projects or services.
The baseline Core source is read from the current Git HEAD and transpiled into the isolated fixture.
For this run the baseline was `543378fefd30959876bef48b153b9e6155826b92`.

Environment: Windows 11 (`10.0.26200`), Node `24.13.1`; a local fixture with 101 commits,
four tracked files and a 32 KiB Library. Both implementations used the same repository, commit,
registry and prepared parent, with alternating order across 10 pairs after one warm-up each.
Other validation processes were running concurrently; this is an overhead check, not an isolated
hardware benchmark.

| Measurement                                      |      Result | Gate                                |
| ------------------------------------------------ | ----------: | ----------------------------------- |
| References + first history page, 20 queries, p95 |   191.14 ms | Core query target ≤500 ms: pass     |
| Baseline create median                           | 3,190.74 ms | Comparison baseline                 |
| Updated create median                            | 3,195.61 ms | +4.88 ms / +0.15%                   |
| Allowed create regression                        |   159.54 ms | max(100 ms, 5% of baseline): pass   |
| Query-created or modified fixture files          |        None | File size/mtime snapshots unchanged |
| Additional storage operations per create         |        None | Identical call counts in every pair |

Each create used zero parent builds, one acquire, one retain, and one retained attach.
The [raw results](workspace-base-selection-results.json) include all pairs and query timings.

**Measurement limitation:** storage was a directory-backed test adapter, not a native VHDX service.
The measured query interval covers Core/Git retrieval, not Electron rendering. No physical disk
allocation, large-project checkout, or Unity first-import performance claim follows from these
numbers. Native storage behavior is unchanged and its existing tests are run separately.

## Functional validation

- Real Git tests cover historical content and HEAD, branch movement, lightweight/annotated tags,
  remote refs, detached HEAD, Unicode metadata, bounded pagination, and invalid/non-commit inputs.
- Historical creation reuses the prepared parent; invalid references create neither a worktree nor
  storage. Existing create, attach, repair and safe-removal regression scenarios remain covered.
- Desktop smoke covers initial lookup failure/retry, stale asynchronous responses, invalid advanced
  input, selecting a historical commit without SHA input, and matching creation HEAD.
- Visual captures verify the loaded dialog at normal and minimum window sizes.

Validation results: all 95 Vitest cases passed across the Core regression run, the corrected
starting-point test timeout rerun, and the remaining 22 test files. Desktop interaction/visual smoke,
type checking, builds, ESLint, dependency boundaries, security scanning, production license auditing,
and Go storage-host tests passed. The license audit and Windows ACL test needed execution outside
the restricted sandbox.

The aggregate `pnpm verify` command stops at formatting warnings in two pre-existing untracked
documents, `workspace-storage-analysis-2026-09-07.md` and its ` copy.md` counterpart. They were left
unchanged. Every file changed for starting-point selection passes the formatter.

Release follow-up: `pnpm verify` passed in an isolated Beta 11 checkout containing the intended
release files and no personal documents: 23 Vitest files / 95 tests, Go storage-host tests and all
remaining quality gates. `pnpm audit --audit-level=low` reported no known vulnerabilities.
`pnpm package:release` also passed: packaged CLI smoke, Desktop IPC/UI smoke, and packaged
interactive PTY smoke. Packaging verified the unchanged hb12 payload hashes. The CLI package's
explicit JavaScript inventory now includes the new `workspace-bases.js` module.
The first GitHub Windows run exposed a pre-existing benchmark fixture issue with 8.3 TEMP aliases.
The failure was reproduced locally with an actual short path. Canonicalizing the ordinary host
fixture directory fixes the test while retaining exact junction-target and content assertions;
production storage code and payloads are unchanged.
The subsequent CI run passed source and CLI checks plus Desktop UI assertions, then hit a transient
Chromium `DIPS` profile lock during smoke cleanup. The harness now waits for process closure and
retries locked-file cleanup with a bounded limit, retaining failure on an unreleased lock. Updated
packaged Desktop and PTY smoke tests passed locally.
