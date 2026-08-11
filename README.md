# HoneyBee

HoneyBee is a CLI-first sequential orchestrator for handing work between real AI Agent processes.

Version 0.2 runs a static chain of two or more one-shot CLI Agents. HoneyBee validates and persists each Agent input, starts the process, validates its structured response, and passes the verified result to the next step.

```text
task Artifact -> step input Artifact -> Agent process -> step result Artifact
                                                    -> next step through HoneyBee Core
```

> The former VS Code Extension and Webview packages have been retired. `packages/core`, `packages/orchestration-contracts`, and `apps/cli` are the current product boundary.

## Requirements

- Windows 11
- Node.js 24 or newer with Corepack
- Codex and OpenCode only for the optional real-Agent example
- Git for Windows only for retained PTY regression tests outside the v0.2 execution path

## Quick start

```powershell
corepack enable
corepack pnpm install --frozen-lockfile
corepack pnpm build
corepack pnpm honeybee demo --task "count bees" --json
```

The deterministic demo starts two separate Node processes and requires no network or AI account.

## Workflow config

The canonical config format is `schemaVersion: 2` with a static ordered `steps` array:

```json
{
  "schemaVersion": 2,
  "steps": [
    { "id": "producer", "agent": { "command": "agent-a" } },
    { "id": "reviewer", "agent": { "command": "agent-b" } }
  ],
  "timeoutMs": 120000,
  "maxOutputBytes": 1048576
}
```

Step IDs must match `^[a-z][a-z0-9_-]{0,63}$` and be unique. Agent commands support optional `args`, `cwd`, and `env`. Relative working directories resolve from the config file. `${VARIABLE}` references in `command` and `cwd` resolve from the environment. Legacy schemaVersion 1 producer/reviewer configs are loaded as equivalent two-step v2 workflows.

SchemaVersion 2 objects are strict at the root, step, and Agent levels. Unknown fields are rejected instead of being silently ignored.

## Run Codex -> OpenCode

Install and authenticate both CLIs, then run:

```powershell
corepack pnpm honeybee run --config examples/codex-opencode.windows.json --task "Summarize this repository and check the summary"
```

HoneyBee sends a validated `AgentInputEnvelope` through stdin. The Agent returns one sentinel-delimited JSON response with `completed`, `blocked`, or `escalated` status. HoneyBee remains the only communication path between Agents.

## Run state and Artifacts

Each run is stored below `.honeybee/runs/<runId>/`:

```text
events.jsonl
blobs/sha256/<digest-prefix>/<digest-rest>
tmp/
```

The JSONL journal contains only typed lifecycle metadata and Artifact references. Task text, serialized Agent inputs, completed content, blocked reasons, and escalation questions are separate immutable Artifacts. Every Artifact read rechecks its byte length and SHA-256 digest.

Inspect or delete one exact run:

```powershell
corepack pnpm honeybee run show <run-id> --json
corepack pnpm honeybee run delete <run-id> --yes
```

A run is conclusive only when its final valid journal event is `workflow.completed`, `workflow.blocked`, `workflow.escalated`, or `workflow.failed`. Otherwise HoneyBee reports the run as indeterminate and does not infer, retry, or resume work.

If an Agent or workflow fails after Run creation, the CLI error includes `runId` and `journalPath` so the same Run can be investigated with `run show`.

## Quality and tests

```powershell
corepack pnpm verify
```

`verify` runs the public-source secret scan, production license allowlist, formatting, ESLint, strict package typechecks, TypeScript builds, Vitest, and dependency-cruiser architecture rules.

## Security

`.honeybee/` contains local plaintext task and Agent output Artifacts and is excluded from Git. JSONL error events use strict metadata allowlists and never serialize generic Error details, stdout, stderr, prompts, task text, results, reasons, or questions.

Before committing, run `corepack pnpm security:install-hooks` once per clone. See [SECURITY.md](SECURITY.md) for private vulnerability reporting.

## Scope

v0.2 is deliberately a small sequential orchestration kernel. DAGs, fan-out, parallel Agent execution, retries, restart resume, PTY/TUI orchestration, and Unity/testplay integration are out of scope. See [ADR-013](docs/decisions/ADR-013-core-cli-first-handoff-proof.md) and [ADR-014](docs/decisions/ADR-014-strict-sequential-orchestration-kernel.md).

## License

HoneyBee is available under the [MIT License](LICENSE).
