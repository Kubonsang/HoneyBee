# HoneyBee Desktop MVP dogfood checklist

This checklist validates the Desktop as a thin control plane over the v0.6 runtime. Use a disposable
Unity fixture project and an isolated workspace-storage broker/store. Do not use a production source
project for fault injection.

## 1. Build and executable boundary

1. Run `corepack pnpm install --frozen-lockfile`.
2. Run `corepack pnpm --filter honeybee-desktop package:smoke`.
3. Confirm the generated executable is
   `apps/desktop/release/HoneyBee-win32-x64/HoneyBee.exe` and the smoke reports
   `Desktop IPC/UI smoke passed.`

## 2. Project and Doctor

1. Start the packaged executable, open Setup Center, and select the fixture Unity project.
2. Confirm the exact project Unity version is preferred and the read-only bundled
   `unity-workspace-storage` path is populated. Select OpenCode and the broker-owned workspace root.
   Enable the optional TestPlay capability backend for this full-flow dogfood run, then select
   TestPlay and its Bridge package.
3. Run **Install & prepare environment** and approve its single storage-service elevation prompt.
   Confirm Setup reaches `setup.completed`, the source tree
   remains unchanged, the staging project shell is removed, and the immutable parent is reusable.
4. Change only a fixture file under `Assets` and provision again. Confirm the compatibility key and
   parent stay the same. Restore it, change a copy of Packages/required ProjectSettings/Bridge, and
   confirm a different compatibility key is required.
5. Restart Desktop and confirm the managed project remains in Recent Projects.
6. Run Doctor. Unity, HoneyBee runtime, TestPlay version and protocol 3 compile/warm-test command
   surface, Agent, bundled workspace-storage pin/service, managed compatibility inputs, project/config
   binding, and physical path isolation must pass. An Agent probe may remain skipped unless it was
   explicitly configured.
7. Change one harmless pinned path and confirm Doctor and Work start fail closed without starting an
   Agent. Restore it before continuing.

## 3. Batch, queue, and live detail

1. Submit at least two Works with distinct tasks and priorities; select compile and warm-test on at
   least one Work.
2. Confirm Agent phases overlap when `maxParallelWorks` permits it.
3. With Editor capacity lower than Work count, confirm only Unity capability phases wait and the
   Command Center shows priority/FIFO queue order, assigned slot, and Editor ownership.
4. Open each Work Detail and confirm Agent lifecycle, capability lifecycle, typed Evidence
   references, bounded log previews, and Run History update without exposing raw filesystem access
   to the renderer.
5. Confirm user-owned and unknown Editors are observable but never assigned or offered a terminate
   action.

## 4. Verified patch disposition

1. For a completed Work, open the verified patch and inspect every add/modify/delete before/after
   view plus compile and test Evidence.
2. On a clean source tree, choose Apply and confirm the resulting full tree matches the verified
   result manifest. Restart Desktop and confirm the durable disposition still reads applied.
3. On another completed fixture Run, change one source file after verification and before Apply.
   Apply must fail closed with source drift/conflict and leave the source exactly as it was at the
   start of the Apply attempt.
4. Choose Reject on a fresh completed patch, confirm no source file changes, and confirm the
   rejected disposition survives restart.

## 5. Recovery and residual zero

1. During separate disposable Runs, terminate HoneyBee while an Agent is active, while a Work waits
   for an Editor, while a capability is active, and while workspace release is pending.
2. Restart Desktop. The affected Run must explain `cleanup-pending` or `indeterminate`; it must not
   present an invented success.
3. Use Cancel before outcome decision where allowed, and Resume to finish durable cleanup. A parent
   batch controls its child Runs.
4. Confirm the terminal Journal ends after workspace release and that no terminal event receives a
   later append.
5. Run the real environment E2E described in README with `HONEYBEE_UNITY_E2E_CONFIG` and confirm
   the workspace-storage status reports all four counters as zero.
6. Confirm the Editor pool has no active or queued lease for the finished Runs, the Editor Registry
   has no live HoneyBee-owned Editor for them, and no recorded containment/Agent/TestPlay process
   incarnation remains alive.

The dogfood result is accepted only when the source project is unchanged before explicit Apply,
every acquired workspace is released, Editor/pool/process residuals are zero, and each patch has one
durable terminal disposition or remains intentionally pending.

## 6. Reproducible measurement session

Use the read-only launcher and observer in [dogfood/README.md](../../dogfood/README.md) for a
packaged executable run. It creates a session-isolated Electron userData directory and preserves
metrics.json, normalized events.ndjson, summary.md, and bounded logs below
dogfood/evidence/<session-id>/.

Finalize one sequential baseline and one 3- or 4-Work parallel candidate with the same workloadId,
then run dogfood/session.py compare. Do not hand-edit generated measurements: rerun finalize so the
observer replays the authoritative Journal and re-verifies every referenced Artifact.
