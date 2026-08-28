# Desktop dogfood observer

This directory contains a dogfood-only launcher and read-only observer for the packaged
HoneyBee.exe. It does not submit Works, alter runtime state, apply patches, or implement a second
orchestration model. HoneyBee's Journal, Artifact Store, Editor Pool Journal, Registry tombstones,
patch disposition records, runtime API, and workspace-storage status remain authoritative.

## Built-in Desktop Debug Mode

For day-to-day dogfood, open `Settings → Developer` in HoneyBee Desktop and enable **Dogfood
Metrics**. The Command Center then exposes an explicit recording control:

1. Select a project and click **Start Recording**.
2. Run one or more Works, inspect their patches, and Apply or Reject each result.
3. Resolve cleanup-pending Runs, then click **Stop & Finalize**.
4. Use **Open Evidence Folder** to inspect `metrics.json`, `events.ndjson`, `summary.md`, and bounded
   Journal logs.

Built-in Evidence is stored under Electron userData at `dogfood/evidence/<session-id>/`. An
unfinished recording is reconnected after Desktop restarts. Finalizing while Work or cleanup is
still active produces `incomplete`; **Refresh Finalize** regenerates the same session after cleanup.
Debug Mode is off by default and does not read dogfood state while disabled.

The Python launcher below remains useful for isolated `--user-data-dir` comparisons and controlled
sequential-versus-parallel benchmark runs. It is not required for the built-in recorder.

Generated state and Evidence are ignored by Git:

- dogfood/state/<session-id>/: one isolated Electron userData directory and runtime root.
- dogfood/evidence/<session-id>/: immutable session inputs plus regenerated measurements.

## Prerequisites

From the repository root:

    corepack pnpm install --frozen-lockfile
    corepack pnpm --filter honeybee-desktop package:smoke
    py -m unittest discover -s dogfood\tests -v

Use a v0.6 schema-3 batch config whose pinned workspace-storage binary is installed, and a
disposable Unity project for the first run. TestPlay is required only when compile or warm-test is
selected. The observer hashes the packaged executable, config, and Git revision into session.json.

## Run a session

Create the baseline:

    py dogfood\session.py run --mode sequential --workload-id inventory-dogfood-v1 --project C:\Unity\InventoryFixture --config C:\HoneyBeeConfigs\inventory-batch.v3.json

Create the 3-Work candidate with the same workload-id:

    py dogfood\session.py run --mode parallel --expected-works 3 --workload-id inventory-dogfood-v1 --project C:\Unity\InventoryFixture --config C:\HoneyBeeConfigs\inventory-batch.v3.json

The script launches the packaged executable with a session-specific --user-data-dir. In Desktop:

1. Select the project and run Doctor.
2. Submit the expected Works with config-owned Agent, priority, compile, and warm-test choices.
3. Observe Agent overlap and the Editor Pool queue.
4. Inspect Evidence and every verified patch diff.
5. For the parallel 3-Work session, Reject B, Apply A, then verify the remaining patch reports source
   drift before Rejecting it. This exercises Reject, clean Apply, and drift protection.
6. Resume or cancel cleanup-pending Runs until cleanup is terminal, then close Desktop.

Ctrl+C stops only the observer. It deliberately does not terminate Desktop, Unity, Agents, or
TestPlay. Reconnect without changing the isolated runtime:

    py dogfood\session.py resume <session-id>

## Finalize and compare

Desktop exit automatically finalizes the session. The explicit command is idempotent and is useful
after an observer interruption or to regenerate Evidence from unchanged authoritative state:

    py dogfood\session.py finalize <session-id>
    py dogfood\session.py compare --baseline <sequential-id> --candidate <parallel-id>

Finalize fails the verdict unless Doctor passed, the expected Works completed, every requested
capability completed in order, source stayed unchanged before disposition, the disposition scenario
completed, all Journal-referenced Artifacts pass byte-length and SHA-256 verification, and residuals
are zero. Agent-only Work does not fail merely because TestPlay is not installed or no capability
was requested.

Each finalized session contains:

- metrics.json: schema-versioned timings, Work outcomes, test counts, changed files, throughput,
  source state, diagnostics, and residual inventory.
- events.ndjson: timestamp-ordered copies of authoritative Journal events with Run identity.
- summary.md: human-readable acceptance report.
- logs/: bounded copies of known TestPlay Evidence logs and Unity Editor logs. Files are capped at
  16 MiB each and 64 MiB per session; the full source digest and truncation status remain recorded.
- preflight-doctor.json, desktop.stdout.log, and desktop.stderr.log.

Comparison output is written below dogfood/evidence/comparisons/. Only sessions with the same
workloadId can be compared. It reports runtime and full-session verified changes/hour plus observed
Agent concurrency.

## Native Agent PR 0 baseline

The Desktop session observer above measures end-to-end dogfood work. The separate
`native_benchmark.py` runner measures the prerequisite isolation/activation cost before Native
Agent Terminal product work begins. It uses the production Runtime Facade and stdio containment,
runs the checked-in no-change demo Agent, protects Direct CLI measurements with disposable full-root
copies, and reports median plus maximum rather than a low-sample fake p95. Cold Parent measurements
are non-blocking diagnostics until workspace-storage exposes a safe committed-Parent reset operation;
source or cleanup failures in any collected cold sample still fail closed.

See [the Native launch baseline protocol](../docs/benchmarks/native-launch/README.md) and
`native-benchmark.spec.example.json`. Generated Evidence remains under
`dogfood/evidence/native-launch/` and is ignored; only explicitly approved frozen baselines belong in
`docs/benchmarks/native-launch/`.

## Timing definitions

All runtime timings are differences between durable Journal timestamps. Agent process duration uses
the corresponding exit metadata while overlap uses agent.started/agent.exited. Workspace,
Editor Pool, Editor launch, Bridge readiness, capability, patch verification, and release intervals
are similarly derived from their durable boundary events. Apply/Reject duration comes from the
runtime-owned patch disposition record.

Residual zero means: no workspace shell remains, no session Editor Pool request remains queued or
active, owned Editor exit tombstones exist, no recorded Desktop/Agent/capability/containment/Editor
process incarnation remains alive, and workspace-storage reports zero active, retained, pending, and
quarantined children. Unknown process identity or unavailable provider status fails closed.
