# HoneyBee

HoneyBee is a CLI-first orchestration kernel with a local Desktop control plane for durable Agent work and isolated Unity validation.

Version 0.6 assigns durable Editor-pool slots to isolated Unity Work Transactions, binds each owned Editor and Warm Bridge to one exact workspace, and runs config-selected compile/warm-test capabilities under that exclusive slot. The v0.5, v0.4, and v0.3 contracts remain compatible.

```text
prepare → acquire → one Agent → optional compile/warm-test → verified patch → release → residual 0
```

> The former VS Code Extension and Webview packages remain retired. The runtime boundary is `packages/core`, `packages/orchestration-contracts`, and `apps/cli`; `apps/desktop` observes and invokes that runtime through strict control-plane DTOs.

## Requirements

- Windows 11
- Node.js 24 or newer with Corepack
- Unity for Unity work
- TestPlay protocol 3 plus its Bridge only when compile or warm-test capabilities are enabled
- Codex and OpenCode only for optional real-Agent examples

The packaged Desktop includes the pinned `unity-workspace-storage` client and HoneyBee service host.
Component Manager installs those bundled bytes and Add Project provisions the neutral
`UnityWorkspaceStorage` machine service in the background, with one Windows elevation prompt when
first needed. No storage version, root, or activation control is exposed. TestPlay is
an optional, explicitly installed protocol-3 CLI/Bridge pair from HoneyBee's fixed URL/SHA-256
compatibility manifest.

## Quick start

```powershell
corepack enable
corepack pnpm install --frozen-lockfile
corepack pnpm build
corepack pnpm honeybee demo --task "count bees" --json
```

The deterministic demo starts two separate Node processes and requires no network or AI account.

## Unity work transaction v0.4

```powershell
corepack pnpm honeybee unity run --config unity-work.json --task "Implement and verify the Unity change" --json
corepack pnpm honeybee run show <run-id> --json
corepack pnpm honeybee run cancel <run-id>
corepack pnpm honeybee run resume <run-id>
```

The strict Unity config contains one `stdio-framed-v2` Agent, an absolute source project path, the broker-owned workspace root, the complete provisioned `parentKey`, and one absolute `unity-workspace-storage` executable with `contractCommit` and `binarySha256` pins. Storage command arguments and environment injection are rejected so the pinned executable is the complete execution payload. The config also declares the TestPlay/Unity commands. Parent construction and broker administration remain operator responsibilities.

The source project, broker workspace root, and HoneyBee Run-state root must be mutually disjoint. The CLI rejects overlapping roots before it creates a Run or prepares a shell.

Start from [the Unity work config example](examples/unity-work.v1.example.json) and replace every placeholder digest/path with the values from the provisioned parent and installed binaries.

The CLI bootstrap physically copies only `Assets`, `Packages`, and `ProjectSettings` into a transaction shell and verifies that `Library` is absent. This is an adapter detail, not a HoneyBee Core workspace abstraction. The storage provider mounts the writable `Library`; both the Agent and TestPlay run with the shell as their working project.

The v0.4 bootstrap rejects parent keys with `localPackagesDigest`; staging external `file:` Unity packages is intentionally deferred rather than allowing the isolated shell to reach back into the source tree.

TestPlay runs with `--no-bridge` and the same project path. HoneyBee imports `results.xml`, `summary.json`, `manifest.json`, `stdout.log`, `stderr.log`, and `events.ndjson` into its content-addressed Artifact Store before release. Raw paths, task text, process output, and Evidence bodies do not enter the Journal.

Failure and cancellation drain the active process and use an independent cleanup context for release. A failed or lost release response leaves the Run nonterminal as `cleanup-pending`; `run resume` reuses the durable request ID and performs cleanup only. It first drains any unmatched recorded child process incarnation and never repeats the Agent or TestPlay. A nonterminal Unity Run cannot be deleted before release is confirmed. `workflow.completed`, `workflow.failed`, or `workflow.cancelled` is appended only after `workspace.released`.

The adapter currently targets `Kubonsang/unity-workspace-storage` public contract schema 1 at commit `575c3b37896cd3dfa37a4705477837cc52ec6132`. Acquire validates the provider, parent digest, ready lease, and exact `<workspace>/Library` mount. Release accepts only `cleanupState: "released"`.

The deterministic CI suite uses real child processes with storage, Agent, and TestPlay contract fixtures. Run the environment-gated Unity E2E against an isolated broker/store and a disposable fixture project with:

```powershell
$env:HONEYBEE_UNITY_E2E_CONFIG = "C:\absolute\unity-work.json"
$env:HONEYBEE_UNITY_E2E_TASK = "Apply the fixture change and make its Unity test pass."
corepack pnpm build
corepack pnpm exec vitest run apps/cli/src/unity-real.e2e.test.ts
```

The gated test requires the transaction source configured for the fixture to be disposable and the broker store to be isolated; it asserts the terminal event order and all four child/pending/quarantine residual counters are zero.

## Unity parallel batch v0.5

The batch command does not change the accepted v0.4 transaction:

```powershell
corepack pnpm honeybee unity batch run --config unity-batch.json --json
corepack pnpm honeybee run show <parent-run-id> --json
corepack pnpm honeybee run cancel <parent-run-id>
corepack pnpm honeybee run resume <parent-run-id>
```

Start from [the global batch config example](examples/unity-batch.v2.example.json). Every Work receives a separate child Run, physical shell, and storage lease. Agent phases run up to `maxParallelWorks`; Works sharing a capacity-1 resource use a FIFO lease around TestPlay only. Parent and child lifecycle events use Journal schema v4, while the v0.4 single transaction remains on schema v3.

Batch config schema 2 requires `resourceScope: "global-file-v1"`. Resource queue events are immutable files under `<state-root>/.unity-resources/v1/<resource-id>/events`, protected by short cross-process metadata leases. FIFO order and the active lease therefore survive a HoneyBee process exit. An active resource lease is never stolen merely because its owner process disappeared: parent `run resume` first drains any recorded Agent/TestPlay process tree, then explicitly releases or cancels the matching durable resource identity before workspace cleanup. A missing or mismatched global history leaves the child and parent `cleanup-pending`.

Batch config schema 1 remains accepted with its original process-local queue for compatibility; [the v1 example](examples/unity-batch.v1.example.json) does not coordinate with another HoneyBee process. Global coordination is limited to processes on one host that use the same HoneyBee state root. The resource event journal is operational coordination state, not workflow authority; child and parent JSONL Journals remain authoritative for Run outcomes.

A completed child stores a `unity-verified-patch` manifest before workspace release. Added and modified file bodies are separate `unity-patch-content` binary Artifacts in the existing content-addressed store; the manifest contains only Artifact references and delete metadata. HoneyBee verifies the patch against a clean source copy, and the original project remains unchanged.

Git Worktrees remain outside the CLI batch executor: its Agents still run in workspace-storage isolation. The Desktop can now project a completed verified text patch into approval-gated Work and integration branches after validation. Distributed scheduling, Semantic IR, and Recipe systems remain out of scope. See [ADR-017](docs/decisions/ADR-017-parallel-unity-batch-local-resources.md), [ADR-018](docs/decisions/ADR-018-global-unity-resource-leases.md), and [ADR-028](docs/decisions/ADR-028-project-first-desktop-workbench.md).

## Unity Editor pool v0.6

v0.6 adds strict single-Work config schema 2 and batch config schema 3. Desktop Agent Manager runs materialize compatible batch config schema 4, which adds one immutable Agent snapshot to every Work while retaining the same Editor-pool semantics. A Work declares its priority and ordered capabilities; it never selects an Editor or slot:

    corepack pnpm honeybee unity run --config unity-work.v2.json --task "Implement, compile, and warm-test the change" --json
    corepack pnpm honeybee unity batch run --config unity-batch.v3.json --json
    corepack pnpm honeybee unity editor list --json

Start from [the v0.6 Work example](examples/unity-work.v2.example.json) or [the v0.6 batch example](examples/unity-batch.v3.example.json). An empty `capabilities` list is a valid Agent-only Work: it does not require TestPlay, a Bridge, or an Editor-pool lease. When capabilities are present, the shared pool uses priority classes interactive, validation, and background; requests are FIFO within one class, active leases are never preempted, and a free stable slot such as editor-1 is assigned by the pool. Only Editor-pool ownership is a global lease. There are no separate warm-bridge or TestPlay leases.

After the Agent exits, HoneyBee launches an Editor for the assigned workspace through a deferred containment process. The launcher first publishes its own PID, process creation identity, launch ID, and nonce as an immutable containment receipt. HoneyBee verifies and journals that receipt before activation. Editor ownership is established in a separate receipt only after the exact Editor PID/incarnation is observed. Before ownership exists, recovery drains only the recorded containment tree and never kills an observed Editor PID directly.

The OS Editor Registry and Warm Bridge binding are separate contracts. HoneyBee-owned Editors carry exact Run, Work, workspace, slot, launch, PID, and process-incarnation linkage. User-owned or path-unknown Editors remain observable only: they are never assigned, leased, adopted, or terminated. Bridge protocol 3 proves an exact owned Editor/workspace/session binding; it does not own scheduling or lifecycle.

Capabilities are selected by HoneyBee config, not by Agent output. compile and warm-test execute sequentially inside the child Run while its assigned Editor slot is exclusive. HoneyBee accepts Evidence only when the TestPlay protocol 3 response matches the requested capability, Editor/workspace/session binding, process exit, and durable summary/manifest; Warm Test must also report at least one executed test. Capture, Semantic IR, Recipe systems, distributed workers, preemption, and automatic capacity optimization remain out of scope.

Parent and stable v0.6 child Journals use schema v5; an opt-in structured Agent session child uses the v5-compatible schema v6 extension. Crash recovery does not rerun the Agent or a capability: it drains unmatched recorded processes/containment, closes the Editor-pool lease, verifies the source, preserves any verified patch Artifact, and releases the workspace. Terminal success follows workspace release, and deterministic E2E coverage asserts Editor, pool, child-process, and workspace residual zero. See [ADR-019](docs/decisions/ADR-019-unity-editor-pool-and-capabilities.md).

## Desktop control plane MVP

The Electron Desktop is a thin operator surface over `honeybee-cli/runtime`; it does not implement a second scheduler or transaction state machine. Its sandboxed renderer can only call the versioned preload API. The main process owns project profiles, Doctor requests, and Work starts under an explicit application-data state root.

```powershell
corepack pnpm --filter honeybee-desktop build
corepack pnpm --filter honeybee-desktop start
corepack pnpm --filter honeybee-desktop package:smoke
```

`package:smoke` produces `apps/desktop/release/HoneyBee-win32-x64/HoneyBee.exe` and launches that
packaged executable with an isolated temporary user-data directory. The smoke requires Electron
`app.ready`, the sandboxed preload API, the renderer Projects home, preferences IPC, and runtime
bootstrap IPC to all succeed. A second smoke loads packaged `node-pty` from asar and starts a real
PowerShell ConPTY. The scripts force-close only their own process trees and remove temporary profiles.

Desktop always opens in a Unity Hub-style Projects home. Selecting one managed project replaces the
whole shell with **Workbench**, **Work Map**, **Runs**, **Worktrees**, and **Project** views; background
Runs continue when the operator navigates elsewhere. Workbench provides a bounded read-only project
Explorer, up to eight source tabs, a provider-owned native Agent CLI, a project PowerShell, and the
durable structured Run stream. Interactive PTYs are process-local conveniences and are closed on app
exit; durable Work evidence remains in the Run Journal and Artifact Store.

New Work uses a plan-first UI gate. The operator reviews the independent Work nodes, selected Agents,
capabilities, parallel limit, and final review/integration node before approval starts execution. The
Work Map then exposes the durable parent/child Runs as a live DAG.

Open **Agents** first to connect Codex, Claude Code, OpenCode, or a custom `stdio-framed-v2` CLI.
HoneyBee stores global execution profiles, not provider credentials: official CLI login remains
provider-owned, while HoneyBee records only bounded readiness and version results. Existing managed
profiles are migrated by extracting and deduplicating their embedded Agent command.

**stdio-framed-v2** remains the stable default. The Agent editor also offers explicit Experimental
profiles for exactly Codex CLI 0.146.0 (app-server --stdio) and OpenCode 1.18.16 (acp).
These profiles use one Desktop-local capacity-four priority/FIFO scheduler rather than another
durable lease. Root approval requests appear in Desktop and support only **Allow once** or
**Deny**; the decision Artifact is flushed before delivery. Current capabilities are intentionally
limited to tool approval and observe-only Skill discovery/materialization. Plan, resume, steer,
plugins, structured questions, and subagent approval remain unsupported. See
[ADR-026](docs/decisions/ADR-026-structured-agent-sessions.md).

Open Projects and choose **Add project**. The one-time Environment Profile step discovers local
Unity and asks only for a changeable preferred Agent from the global library; HoneyBee then installs or reuses the immutable `unity-workspace-storage` version
and its private workspace root without asking for storage settings. The legacy
`TestPlayStorageBroker` service is never adopted, replaced, or stopped. TestPlay and its Bridge are one optional
Component Manager unit for compile/warm-test; only releases in HoneyBee's fixed compatibility
manifest can be installed. Starting Setup provisions or reuses one immutable Library parent and
stores a strict schema-3 profile with exact component locks—no handwritten batch config or external
storage installation is required. Existing v0.6 batch configs remain importable as legacy profiles.

The parent compatibility key is canonical and intentionally excludes `Assets`. It includes the Unity project version, Unity executable SHA-256, Packages manifest/lock, the required ProjectSettings manifest, `StandaloneWindows64`, scripting backend, Bridge overlay digest, and Bridge protocol version. Ordinary game-code changes therefore reuse the parent; changes that can invalidate Library reuse do not.

For schema-2 parent creation, storage returns a `stagingPath` that is the provider-owned `Library` mount. Setup derives `projectRoot = dirname(stagingPath)`, prepares only `Assets`, `Packages`, and `ProjectSettings` beneath that root, and never creates, overwrites, or removes `Library`. The pinned Unity process runs behind the same deferred containment boundary as Unity Runs. Commit occurs only after source, Bridge, Library identity, and non-empty Library checks; failure/cancel replays an ambiguous begin request when necessary, aborts it, and removes only the proven HoneyBee-owned project shell.

Doctor validates Unity project structure/version, physical path isolation, the preferred global Agent readiness, the bundled storage pin/service, and managed compatibility inputs without running an Agent task. If TestPlay is configured, Doctor also validates its side-effect-free version and protocol 3 compile/warm-test command surface; otherwise it reports the capability backend as optional and unavailable. After Doctor passes, the Task Composer maps one Work to the existing single transaction and two or more Works to the existing v0.6 batch workflow. A batch has one default Agent and each Work may override it; main validates every selected profile before workspace acquisition and persists the exact commands in the Run config Artifact. Compile/warm-test controls stay disabled until the optional TestPlay pair is configured.

The Command Center shows live Work phases, the priority/FIFO Editor queue, Editor ownership, Run History, typed Journal activity, and bounded Evidence previews. Cleanup-pending Runs expose only runtime-authorized Resume/Cancel actions. A completed child Run exposes its local verified patch as file-by-file before/after views.

For a clean named Git source branch, **Worktrees** can materialize a pending verified text patch as a
real `honeybee/work/<run-id>` commit. Each Work merge into
`honeybee/integration/<parent-run-id>` requires explicit approval. Conflicts remain visible as an
Integration Work; a clean integration can reach the source only by a separate fast-forward approval.
Generated worktree folders are removed after success while both branch histories remain. Binary or
truncated previews fail closed and continue to use the existing durable patch-disposition path.

New patches use a reference-only manifest v3 with detailed base/result trees, separate
content-addressed before/after blobs, and explicit workspace-integrity/compile/warm-test verification
states. Agent-only patches record compile and warm-test as `not-run`. Apply verifies the complete
source tree, uses a durable same-directory backup/checkpoint transaction, and rolls back on conflict;
Reject never changes source. Patch disposition is separate from the immutable terminal orchestration
Journal. Existing manifest v1 results remain viewable/rejectable but are not applied because they
lack a durable detailed base tree. See [ADR-022](docs/decisions/ADR-022-desktop-results-and-patch-disposition.md).

Profiles are stored as strict atomic JSON below Electron's `userData` directory. Runtime state is stored separately below `<userData>/runtime/runs`. Setup recovery records only typed lifecycle metadata in its own fsynced local journal; Work authority remains the existing Run Journal and Artifact Store. Context isolation, renderer sandboxing, disabled Node integration, navigation denial, a restrictive CSP, and strict request/response validation keep filesystem and process authority in the main process. See [ADR-020](docs/decisions/ADR-020-desktop-runtime-control-plane.md), [ADR-021](docs/decisions/ADR-021-desktop-shell-and-project-profiles.md), and [ADR-024](docs/decisions/ADR-024-desktop-setup-center.md).

Use the [Desktop MVP dogfood checklist](docs/validation/desktop-mvp-dogfood.md) for a real v0.6
Unity batch. The checklist treats source preservation, patch disposition, cleanup recovery, and
workspace/Editor/process residual zero as release gates rather than UI-only demonstrations.

## Workflow config v3

Agents define executable programs. Harnesses define how HoneyBee communicates with them. Steps reference both by strict IDs and connect named Artifact ports.

```json
{
  "schemaVersion": 3,
  "agents": [
    { "id": "draft", "command": "agent-a" },
    { "id": "review", "command": "agent-b" },
    { "id": "select", "command": "agent-c" }
  ],
  "harnesses": [{ "id": "stdio", "kind": "stdio-framed-v2", "protocolVersion": 2 }],
  "steps": [
    {
      "id": "draft",
      "type": "agent",
      "agentRef": "draft",
      "harnessRef": "stdio",
      "outputs": { "content": { "mediaType": "text/plain; charset=utf-8" } }
    },
    {
      "id": "review",
      "type": "agent",
      "agentRef": "review",
      "harnessRef": "stdio",
      "outputs": { "content": { "mediaType": "text/plain; charset=utf-8" } }
    },
    {
      "id": "select",
      "type": "agent",
      "agentRef": "select",
      "harnessRef": "stdio",
      "needs": ["draft", "review"],
      "inputs": {
        "draft": { "from": { "stepId": "draft", "output": "content" } },
        "review": { "from": { "stepId": "review", "output": "content" } }
      },
      "outputs": { "content": { "mediaType": "text/plain; charset=utf-8" } },
      "timeoutMs": 120000
    }
  ],
  "outputs": {
    "result": { "from": { "stepId": "select", "output": "content" } }
  },
  "maxParallelism": 2,
  "maxOutputBytes": 1048576
}
```

IDs must match `^[a-z][a-z0-9_-]{0,63}$`. Config objects are strict at every level, graph references and output ports must exist, and combined dependency/data/condition edges must be acyclic. Omitting `maxParallelism` defaults to `1`.

The CLI convenience `result` is emitted only when `workflow.outputs.result` explicitly binds a step output. With no such binding, DAG execution still returns every completed step Artifact in `outputs`, but omits `result`; config order never chooses an implicit leaf.

SchemaVersion 1 producer/reviewer and schemaVersion 2 ordered-step configs are translated to equivalent v3 linear DAGs with `maxParallelism: 1`. Their commands continue to receive `AgentInputEnvelopeV1` and return the legacy `content` response through the `stdio-framed-v1` compatibility harness; loading an old config never silently switches its Agent protocol.

The optional [Codex → OpenCode example](examples/codex-opencode.windows.json) uses the same v3 Agent/Harness separation.

## Agent protocol

HoneyBee stores the exact validated Agent input envelope as a `step-input` Artifact before starting a process. A v3 `AgentInputEnvelopeV2` includes an authoritative `outputs` map declaring every required port and media type. Named inputs are always re-read from the Artifact Store and integrity-checked. A completed Agent response returns exactly those declared named outputs; `blocked` and `escalated` remain semantic outcomes independent of exit code.

UTF-8 text and JSON output Artifacts are supported. JSON Artifact values can drive the restricted `all`, `any`, `not`, `stepOutcome`, and JSON Pointer comparison condition DSL. Arbitrary JavaScript and shell conditions are not executed.

Retry is per step, bounded by `maxAttempts`, and applies only to explicitly listed error codes, exit codes, or an opted-in timeout. Backoff is deterministic and persisted as `notBefore`; blocked and escalated outcomes are never retried.

## Run control and recovery

```powershell
corepack pnpm honeybee run --config workflow.json --task "Do the work"
corepack pnpm honeybee run show <run-id> --json
corepack pnpm honeybee run pause <run-id>
corepack pnpm honeybee run resume <run-id>
corepack pnpm honeybee run approve <run-id> <step-id>
corepack pnpm honeybee run reject <run-id> <step-id>
corepack pnpm honeybee run cancel <run-id>
corepack pnpm honeybee run resolve-attempt <run-id> <step-id> --retry
corepack pnpm honeybee run delete <run-id> --yes
```

One executor lease owns Journal writes for a Run. Its owner record binds the PID to the OS process creation identity so PID reuse cannot keep a stale lease alive. Lease publication and stale takeover use atomic ownership-directory transitions, and `run delete` must hold the same exclusive lease while removing the Run. Other CLI processes publish idempotent control requests that become authoritative only after the executor records `control.accepted`.

Control commands remain asynchronous. Their JSON response reports `disposition: "queued"` while an executor is present, or `"queued-awaiting-executor"` with `requiresResume: true` when a paused/interrupted Run has no executor. In the latter case the request stays pending until `run resume` starts an executor.

Pause stops new scheduling and waits for in-flight attempts to finish. Cancel stops scheduling, signals in-flight processes, and force-terminates them after the configured grace period. Approval is a non-Agent step that stores an approved/rejected decision Artifact for subsequent conditional branches.

Resume reconstructs completed, skipped, retry-waiting, approval-waiting, and pending steps from Journal v2 without repeating completed work. If HoneyBee stopped after `agent.started` but before a semantic result, the attempt becomes `interrupted`; it is not rerun until `resolve-attempt --retry|--fail` is supplied.

## Run state and Artifacts

Each Run is stored below `.honeybee/runs/<runId>/`:

```text
events.jsonl
control/inbox/<requestId>.json
blobs/sha256/<digest-prefix>/<digest-rest>
tmp/
```

Executor ownership is stored separately at `.honeybee/runs/.leases/active/<runId>/owner.json` so deleting one Run cannot erase the lease that serializes deletion.

The JSONL Journal contains typed lifecycle metadata and Artifact references only. Prompts, tasks, Agent output, reasons, questions, stdout, and stderr remain outside the Journal. Every Artifact read recalculates byte length and SHA-256 digest.

Journal v2 permits valid nonterminal states such as paused, waiting approval, retry wait, and interrupted. A terminal workflow event must still be the final valid event. Malformed JSON, sequence gaps, mixed event versions, impossible transitions, or events after terminal make the Run `indeterminate`. Orphan blobs do not affect Run state.

## Quality, security, and scope

```powershell
corepack pnpm verify
```

`.honeybee/` contains local plaintext Artifacts and is excluded from Git. Run `corepack pnpm security:install-hooks` once per clone and see [SECURITY.md](SECURITY.md) for vulnerability reporting.

HoneyBee remains a local CLI kernel with a thin Desktop operator surface. v0.6 adds a same-host Editor pool, owned-Editor registry, exact Warm Bridge binding, config-owned compile/warm-test capabilities, a local Setup Center, and a fixed-manifest Component Manager for bundled storage plus optional TestPlay. Desktop post-validation Git integration is local and approval-gated; Agent execution inside Git Worktrees, distributed scheduling, retained execution workspaces, provider fallback, arbitrary component sources, a plugin ecosystem, Semantic IR, Recipe systems, capture/GPU scheduling, preemption, and automatic capacity optimization are out of scope. Full power-loss durability remains outside the guarantee; durable cleanup recovery targets HoneyBee/Agent/adapter process interruption. See [ADR-014](docs/decisions/ADR-014-strict-sequential-orchestration-kernel.md), [ADR-015](docs/decisions/ADR-015-durable-dag-orchestration-kernel.md), [ADR-016](docs/decisions/ADR-016-single-unity-work-transaction.md), [ADR-017](docs/decisions/ADR-017-parallel-unity-batch-local-resources.md), [ADR-018](docs/decisions/ADR-018-global-unity-resource-leases.md), [ADR-019](docs/decisions/ADR-019-unity-editor-pool-and-capabilities.md), [ADR-020](docs/decisions/ADR-020-desktop-runtime-control-plane.md), [ADR-021](docs/decisions/ADR-021-desktop-shell-and-project-profiles.md), [ADR-024](docs/decisions/ADR-024-desktop-setup-center.md), [ADR-025](docs/decisions/ADR-025-component-manager-v1.md), and [ADR-028](docs/decisions/ADR-028-project-first-desktop-workbench.md).

## License

HoneyBee is available under the [MIT License](LICENSE).
