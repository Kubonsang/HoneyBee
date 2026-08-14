# HoneyBee

HoneyBee is a CLI-first orchestration kernel for durable Agent work and isolated Unity validation.

Version 0.4 adds one deliberately sequential Unity work transaction while preserving the v0.3 DAG kernel:

```text
prepare → acquire → one Agent → TestPlay → Evidence → release → residual 0
```

> The former VS Code Extension and Webview packages remain retired. `packages/core`, `packages/orchestration-contracts`, and `apps/cli` are the product boundary.

## Requirements

- Windows 11
- Node.js 24 or newer with Corepack
- A running `unity-workspace-storage` broker and a provisioned immutable parent for Unity work
- TestPlay and Unity for Unity work
- Codex and OpenCode only for optional real-Agent examples

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

v0.4 remains a local CLI kernel. Its Unity path is exactly one transaction and one Agent. Multiple Unity Agents, parallel Unity execution, a scheduler, retained workspaces, provider fallback, parent provisioning, GUI, Semantic IR, warm-editor bridge integration, and TestPlay shadow/scenario orchestration are out of scope. Full power-loss durability remains outside the guarantee; durable cleanup recovery targets HoneyBee/Agent/adapter process interruption. See [ADR-014](docs/decisions/ADR-014-strict-sequential-orchestration-kernel.md), [ADR-015](docs/decisions/ADR-015-durable-dag-orchestration-kernel.md), and [ADR-016](docs/decisions/ADR-016-single-unity-work-transaction.md).

## License

HoneyBee is available under the [MIT License](LICENSE).
