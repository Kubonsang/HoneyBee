# HoneyBee

HoneyBee is a CLI-first, durable DAG orchestrator for handing work between real AI Agent processes.

Version 0.3 adds dependency-aware parallel execution, Artifact fan-in, conditional branches, bounded retry, approval gates, pause/resume, cancellation, and Journal-based recovery while preserving v0.2 sequential configs.

> The former VS Code Extension and Webview packages remain retired. `packages/core`, `packages/orchestration-contracts`, and `apps/cli` are the product boundary.

## Requirements

- Windows 11
- Node.js 24 or newer with Corepack
- Codex and OpenCode only for the optional real-Agent example

## Quick start

```powershell
corepack enable
corepack pnpm install --frozen-lockfile
corepack pnpm build
corepack pnpm honeybee demo --task "count bees" --json
```

The deterministic demo starts two separate Node processes and requires no network or AI account.

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
  "maxParallelism": 2,
  "maxOutputBytes": 1048576
}
```

IDs must match `^[a-z][a-z0-9_-]{0,63}$`. Config objects are strict at every level, graph references and output ports must exist, and combined dependency/data/condition edges must be acyclic. Omitting `maxParallelism` defaults to `1`.

SchemaVersion 1 producer/reviewer and schemaVersion 2 ordered-step configs are translated to equivalent v3 linear DAGs with `maxParallelism: 1`.

The optional [Codex → OpenCode example](examples/codex-opencode.windows.json) uses the same v3 Agent/Harness separation.

## Agent protocol

HoneyBee stores the exact validated `AgentInputEnvelopeV2` as a `step-input` Artifact before starting a process. Named inputs are always re-read from the Artifact Store and integrity-checked. A completed Agent response returns exactly the declared named outputs; `blocked` and `escalated` remain semantic outcomes independent of exit code.

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

One executor lease owns Journal writes for a Run. Other CLI processes publish idempotent control requests that become authoritative only after the executor records `control.accepted`.

Pause stops new scheduling and waits for in-flight attempts to finish. Cancel stops scheduling, signals in-flight processes, and force-terminates them after the configured grace period. Approval is a non-Agent step that stores an approved/rejected decision Artifact for subsequent conditional branches.

Resume reconstructs completed, skipped, retry-waiting, approval-waiting, and pending steps from Journal v2 without repeating completed work. If HoneyBee stopped after `agent.started` but before a semantic result, the attempt becomes `interrupted`; it is not rerun until `resolve-attempt --retry|--fail` is supplied.

## Run state and Artifacts

Each Run is stored below `.honeybee/runs/<runId>/`:

```text
events.jsonl
executor.lock
control/inbox/<requestId>.json
blobs/sha256/<digest-prefix>/<digest-rest>
tmp/
```

The JSONL Journal contains typed lifecycle metadata and Artifact references only. Prompts, tasks, Agent output, reasons, questions, stdout, and stderr remain outside the Journal. Every Artifact read recalculates byte length and SHA-256 digest.

Journal v2 permits valid nonterminal states such as paused, waiting approval, retry wait, and interrupted. A terminal workflow event must still be the final valid event. Malformed JSON, sequence gaps, mixed event versions, impossible transitions, or events after terminal make the Run `indeterminate`. Orphan blobs do not affect Run state.

## Quality, security, and scope

```powershell
corepack pnpm verify
```

`.honeybee/` contains local plaintext Artifacts and is excluded from Git. Run `corepack pnpm security:install-hooks` once per clone and see [SECURITY.md](SECURITY.md) for vulnerability reporting.

v0.3 remains a local CLI kernel. Distributed workers, a daemon, arbitrary condition code, binary Agent payloads, automatic replay of uncertain side effects, full power-loss durability, PTY/TUI orchestration, and Unity/testplay integration are out of scope. See [ADR-014](docs/decisions/ADR-014-strict-sequential-orchestration-kernel.md) and [ADR-015](docs/decisions/ADR-015-durable-dag-orchestration-kernel.md).

## License

HoneyBee is available under the [MIT License](LICENSE).
