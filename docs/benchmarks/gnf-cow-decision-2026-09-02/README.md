# GNF_ CoW architecture decision benchmark

## Outcome

**Adopt Git worktrees with Library-only CoW and retire Full-project CoW.** Full-project no-rewrite
won capacity and removal time, but it lost the two time-oriented primary metrics and failed the
pre-registered acceptance rule.

| Primary metric | A: Git worktree + Library CoW | B: Full-project CoW, no rewrite | Result |
| --- | ---: | ---: | --- |
| Workspace create, median of 20 | 12.346 s | 13.771 s | A; B was 11.54% slower |
| Eight-workspace host space delta | 13.704 GiB | 5.718 GiB | B; 58.27% less |
| Unity batch-ready, median of 3 | 61.862 s | 62.865 s | A; B was 1.62% slower |

The rule fixed before measurement required B to win at least two primary metrics and be no more than
10% slower on the third. B won one metric and was 11.54% slower on create, so it failed both parts.
HoneyBee prioritizes user waiting time and a smaller product boundary here; the capacity advantage is
real and intentionally accepted rather than hidden.

## Full result

| Metric | A | B | Difference |
| --- | ---: | ---: | ---: |
| Parent preparation, one observation | 69.510 s | 80.884 s | B +16.36% |
| Immutable parent allocation | 5.436 GiB | 6.900 GiB | B +26.95% |
| Existing-parent reuse validation | 166.5 ms | 167.1 ms | effectively equal |
| Workspace create, median of 20 | 12.346 s | 13.771 s | B +11.54% |
| Workspace remove, median of 20 | 3.143 s | 2.329 s | B 25.91% faster |
| Ready child allocation | 29 MiB | 589 MiB | B 20.31× A |
| One-workspace host space delta, median | 1.482 GiB | 0.579 GiB | B 60.94% less |
| Four-workspace host space delta | 5.961 GiB | 3.410 GiB | B 42.80% less |
| Eight-workspace host space delta | 13.704 GiB | 5.718 GiB | B 58.27% less |
| Unity batch-ready, median of 3 | 61.862 s | 62.865 s | B +1.62% |
| Child allocation after Unity, median | 1,021 MiB | 1,549 MiB | B +51.71% |

A's 29 MiB child contains only generated Library blocks; its ordinary Git checkout accounts for most
of the host footprint. B avoids that checkout copy but pays a roughly 589 MiB NTFS/VHDX child cost on
every mounted full-project volume even after eliminating `git reset --hard`.

## Experiment contract

- A: ordinary `git worktree add`, a retained Library-only differencing child, and a `Library`
  junction in the worktree.
- B: a retained full-project differencing child registered as a Git worktree with `--no-checkout`,
  `git worktree repair`, and index-only `git read-tree`; registration did not rewrite tracked files.
- Source: GNF_ commit `8d743466c728828a695500c9c0001d02173bafe8`, branch
  `codex/cross-pc-checkpoint-20260721`, with the same 38 pre-existing dirty source entries before and
  after measurement.
- Machine: Windows `10.0.26200`, Ryzen 9 9950X, 32 logical CPUs, 64 GiB RAM, Node 24.13.1, Unity
  6000.3.8f1.
- Sampling: one warm-up and 20 measured creates per mode, alternating A/B order; cumulative
  checkpoints at four and eight live workspaces; three Unity batch-ready runs per mode.
- Parent preparation was not repeated because creating two duplicate immutable parents would exceed
  the broker quota and retain about 13 GiB for the 30-day TTL. The report carries forward the fresh
  2026-09-01 preparation evidence for the exact same commit and parent IDs, while re-validating both
  parent IDs during this run.

Unity was launched directly with `-batchmode -nographics -quit`. All six runs exited successfully,
contained the batch-success marker, and reported zero C# compiler errors. Unity normalized
`Packages/packages-lock.json` in both modes; the benchmark recorded and restored that identical
change before deleting each disposable workspace. This metric is successful Unity batch open and
exit, not GUI first-frame or playable-scene readiness.

## Reboot and repair

The machine boot-session ID changed from `system-process-01dd29f187cfa41f` to
`system-process-01dd3a2dd52e448f`, and both retained children survived the reboot. Automatic repair
then failed on A before B timing could be measured. The broker's retained-attach path calls
`validateWorkspaceMount` while the detached volume's old `Library` mount point still exists. Its
native attach path already contains exact child/volume-GUID stale-mount cleanup, but validation
prevents execution from reaching it.

The result records reboot repair as a shared correctness failure, not as a timing win for either
mode. Cleanup used the broker's retained-removal path, which does reach native stale-mount cleanup.
Final active, retained, pending, and quarantine child counts were all zero; manual recovery and GC
blocking were false.

## Integrity and limitations

- Source HEAD and its 38-entry dirty state were unchanged.
- All 40 measured creates, both cumulative runs, and all six Unity runs completed.
- No benchmark Git worktree, `hb-bench/*` branch, child VHDX, or benchmark temp root remained.
- Host free-space deltas include filesystem metadata and unrelated low-level OS noise. Alternating
  order and 20 samples reduce but do not eliminate that noise.
- Parent preparation has one observation per mode and is secondary evidence.
- This is one machine and one large Unity project; it is an architecture decision for HoneyBee, not
  a universal VHDX performance claim.
- After adopting ADR-031, a separate Production Core smoke on the same GNF_ commit created a
  Library-only workspace in 13.165 s and removed it in 3.211 s. It verified that the worktree had
  `Assets` and `Library`, the child mount had no `Assets`, Git was clean, and cleanup returned to zero.

## Evidence

- [`decision.json`](decision.json) is the machine-readable verdict.
- [`raw/results.json`](raw/results.json) contains all samples, cumulative checkpoints, Unity evidence,
  boot IDs, repair failure, and final broker state.
- [`../gnf-cow-2026-09-01/raw/parent-preparation.json`](../gnf-cow-2026-09-01/raw/parent-preparation.json)
  contains fresh parent preparation observations for the reused immutable parents.
- [`scripts/benchmark-gnf-cow-decision.mjs`](../../../scripts/benchmark-gnf-cow-decision.mjs) is the
  measurement and cleanup harness. It is retained as audit evidence for the now-retired experimental
  Full-project path, not as a supported product smoke test after ADR-031.
