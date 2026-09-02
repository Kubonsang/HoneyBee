# GNF_ Library-only vs full-project CoW benchmark

Measured on 2026-09-01 using the two HoneyBee workspace paths that existed at the time of the run. On this project and implementation, **Library-only CoW reached a usable filesystem workspace faster and with a much smaller child VHDX**.

## Result

| Current implementation | Ready median |  Measured range |     Mean | Median child allocation |
| ---------------------- | -----------: | --------------: | -------: | ----------------------: |
| Library-only CoW       |      9.242 s |   9.148–9.311 s |  9.231 s |                  36 MiB |
| Full-project CoW       |     13.421 s | 12.983–15.224 s | 13.642 s |               2,094 MiB |

For the measured workflow, full-project CoW was 4.179 seconds, or 45.2%, slower than Library-only CoW at the median. Its ready child allocated 58.2 times as many bytes. Equivalently, Library-only used 31.1% less of the full-project ready time.

The primary result excludes parent creation. It answers: “Given an already prepared immutable parent, how long does the current HoneyBee path take to return a workspace that contains `Assets` and `Library` and, where applicable, is a valid Git worktree at the requested commit?” It does **not** measure Unity Editor startup, asset refresh, domain reload, or first playable frame.

## What was measured

- Source: `GNF_` at commit `8d743466c728828a695500c9c0001d02173bafe8`.
- Source branch: `codex/cross-pc-checkpoint-20260721`.
- Source state: 38 dirty entries. The benchmark read but did not modify, stash, reset, or launch Unity against the source.
- Library snapshot: 55,935 files and 5,857,516,216 bytes.
- Tracked files present at the pinned commit: 11,474 files and 1,541,715,971 bytes.
- Machine: Windows `10.0.26200`, AMD Ryzen 9 9950X, 32 logical CPUs, 64 GiB RAM, Node 24.13.1.
- Sampling: one warm-up per mode followed by six measured samples per mode. Measured order alternated by pair to reduce ordering bias. The OS cache was not flushed.

The Library-only path copied `Assets`, `Packages`, and `ProjectSettings` from a clean detached worktree, then acquired a differencing child whose parent contained `Library`. Its measured median was 7.258 seconds for the source copy and 1.978 seconds for storage acquire.

The full-project path acquired a child whose parent contained the clean tracked project tree plus the same Library snapshot. It then created the logical junction, registered a real Git worktree and branch, repaired the worktree pointer, ran `git reset --hard` to the requested branch, retained and reattached the child, and persisted the ready registry record. The 13.421-second figure includes all of those steps.

These paths do not provide identical semantics. Library-only currently produces the legacy bootstrap layout and does not register that layout as a branch-managed Git worktree. Full-project CoW does. The result is therefore a comparison of the two current product paths, not a claim that Library-only filesystem CoW is inherently faster than every possible full-project CoW design.

## Why the full-project child grew

The full-project parent already held the tracked files, but worktree registration finishes with `git reset --hard` inside the differencing volume. The measured child allocation indicates that this rewrote a substantial part of the tracked tree into child blocks: the median was 2.045 GiB versus 36 MiB for the Library child.

That causal explanation is an inference from the implementation and allocation evidence, not a block-level write trace. It is strong enough to identify the next optimization target: register and validate the Git worktree without rewriting files that are already identical to the parent. The benchmark should be rerun after that change.

## Parent preparation and persistent capacity

Parent preparation was observed once during integration preflight and is kept separate from the repeated ready-time result:

| Parent       | One-shot preparation | Immutable parent allocation |
| ------------ | -------------------: | --------------------------: |
| Library-only |             69.510 s |                   5.436 GiB |
| Full-project |             80.884 s |                   6.900 GiB |

The full parent occupied 1.465 GiB, or 26.9%, more. These timings were sequential, order- and cache-sensitive diagnostics rather than repeated samples. The tested parents remain provider cache and are subject to the broker's 30-day parent TTL. At both the start and end of the measured run, the broker contained five parents totaling 22,284,337,152 bytes; this benchmark did not silently delete machine-global parent cache.

## Integrity and cleanup

After the final sample:

- source HEAD remained `8d743466c728828a695500c9c0001d02173bafe8`;
- source dirty count remained 38;
- no `hb-bench/*` branch, registered benchmark worktree, or benchmark root remained;
- broker active, retained, pending, and quarantine child counts were all zero;
- `manualRecoveryRequired` and `gcBlocked` were both false.

The run also exposed integration failures before measurement: Unicode path handling in parent materialization, broker workspace-shell creation, cross-volume `.git` pointer relocation, Git safe-directory handling on broker-owned mounts, a benchmark release invoked from the workspace being deleted, and authenticated named-pipe control. Those paths were fixed before the recorded run; the relevant Core, CLI, Desktop, and Go host tests passed.

## Evidence and reproduction

- [`raw/results.json`](raw/results.json) contains all warm-up and measured samples plus broker state before and after.
- [`raw/parent-preparation.json`](raw/parent-preparation.json) records the one-shot parent preparation observations and immutable parent sizes.
- [`scripts/benchmark-gnf-cow.mjs`](../../../scripts/benchmark-gnf-cow.mjs) is the benchmark harness.

The checked-in result redacts only local user-profile path prefixes and the Windows user SID; its `redactions` field lists both transformations.

Run from the repository root after building `@honeybee/core` and `honeybee-cli`:

```powershell
node scripts\benchmark-gnf-cow.mjs `
  'C:\path\to\GNF_' `
  'C:\path\to\unity-workspace-storage.exe' `
  'docs\benchmarks\gnf-cow-2026-09-01\raw\results.json' `
  6 `
  '<library-parent-id>' `
  '<full-project-parent-id>'
```

This is one machine, one project snapshot, and six samples per mode. It is direct local evidence for the current implementation, not a universal storage benchmark or a performance gate.
