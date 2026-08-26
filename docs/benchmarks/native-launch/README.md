# Native Agent launch baseline

This directory contains reviewed, immutable PR 0 baselines for the Native Agent Terminal work.
No Native Agent product code or default-mode change may begin until a complete baseline is reviewed
and frozen here.

The generated Evidence stays under the ignored
`dogfood/evidence/native-launch/<session-id>/` directory. A reviewed baseline is copied here only by
the explicit `freeze` command; the runner never chooses or silently changes gate values.

## What PR 0 measures

The same run measures one small disposable Unity fixture and one actual-scale Unity project. The
HoneyBee leg may read the configured source project because the existing runtime prepares and
acquires an isolated workspace. The Direct CLI leg never runs in that source: the runner creates a
disposable project-root copy first and excludes generated top-level roots such as `Library`, `Temp`,
`Logs`, `obj`, and `.honeybee`.

For each project the baseline records:

- HoneyBee warm Parent: 20 samples.
- HoneyBee cold Parent: 5 samples, each using a distinct, already provisioned schema-2 Parent.
- Direct CLI process creation: 20 samples against the disposable copy.
- Operator-observed Direct CLI prompt readiness: 5 samples against the disposable copy.

Every Direct CLI sample compares the complete remaining project-root manifest before and after.
Any new, removed, or changed file fails the sample and the copy is discarded. No task is submitted.

HoneyBee timings use durable Journal timestamps:

- prepare: `workflow.started` to `workspace.prepared`;
- acquire: `workspace.acquire-started` to `workspace.acquired`.

Reports contain the median, maximum, sample count, and raw values. They deliberately do not label a
five- or twenty-sample maximum as p95. Cold Parent values are absolute gates; they are not compared
with a nonexistent Direct CLI cold leg.

## Cold Parent constraint

The current workspace-storage public contract can begin, commit, and abort parent staging, but it
does not expose deletion of a committed immutable Parent. The benchmark therefore refuses to make
up compatibility keys or purge machine-global storage state. Supply five distinct Parent configs
that Setup Center provisioned for benchmark inputs. An immutable committed Parent is provider cache,
not a residual; each measured Work must still release its child workspace/VHDX with residual zero.

If `coldBatchConfigPaths` is empty, warm/direct/primitive collection remains usable, but the report
stays `incomplete` and cannot be frozen.

## Primitive activation budget

PR 0 also records 20 raw samples for:

- small-file write plus fsync;
- one real `FileOrchestrationJournal.append()`;
- one real `FileArtifactStore.put()`;
- immutable hard-link publication, crash-window recovery, open/fstat verification, and bounded read;
- suspended Windows process creation;
- Windows Job Object creation and process assignment.

The unapproved proposal is:

```text
4 * journalAppend.maxMs
+ immutablePublication.maxMs
+ suspendedProcessCreate.maxMs
+ jobObjectCreateAssign.maxMs
```

Reviewers may approve a different explicit budget, but implementation work cannot edit an already
frozen baseline to make a candidate pass.

## Run the baseline

Build the runtime first and copy `dogfood/native-benchmark.spec.example.json` to an ignored local
path. Use a clean tracked worktree and replace both project/config paths. The configured storage
binaries and provider executable are SHA-256 pinned into the session.

```powershell
corepack pnpm build
py dogfood/native_benchmark.py init --spec C:\HoneyBeeBench\native-baseline.json
py dogfood/native_benchmark.py run <session-id>
py dogfood/native_benchmark.py prompt-ready <session-id> --project fixture
py dogfood/native_benchmark.py prompt-ready <session-id> --project actual
py dogfood/native_benchmark.py finalize <session-id>
```

`run` is resumable and writes each sample immediately. Before every sample it rechecks the Git
commit/tracked status, provider and storage digests, config digests, Defender mode, host identity,
and source input manifest. A mismatch stops the session instead of combining incomparable data.

The Evidence directory contains:

- `session.json`: pinned inputs and resumable raw sample state;
- `metrics.json`: median/max/raw statistics and completion diagnostics;
- `events.ndjson`: sample-labelled copies of authoritative HoneyBee Journal events;
- `summary.md`: human review summary;
- `journals/`: exact per-sample JSONL copies;
- `logs/`: bounded probe/provider stdout and stderr.

After the Evidence and proposed gate values are explicitly approved, prepare a local gate JSON with
`schemaVersion`, `approvedAt`, `approvedBy`, project-specific warm/cold prepare/acquire maxima, and a
native activation `formula` plus `budgetMs`. Then freeze it:

```powershell
py dogfood/native_benchmark.py freeze <session-id> `
  --gates C:\HoneyBeeBench\approved-gates.json `
  --output docs\benchmarks\native-launch\2026-08-26.json
```

PR 3 may expose Native Terminal only as opt-in. The default can change only in PR 4 after the same
runner is rerun on the candidate and the frozen gates pass.
