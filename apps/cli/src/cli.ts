#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ChildProcessAgentRunner,
  FileArtifactStore,
  FileOrchestrationJournal,
  FileRunRepository,
  HoneyBeeCoreError,
  OrchestrationWorkflow,
  RunIdSchema,
  StepIdSchema,
  type OrchestrationEventV1,
  type OrchestrationJournal,
  type WorkflowRunRequest,
} from "@honeybee/core";

import { loadWorkflowConfig } from "./config.js";

const VERSION = "0.2.0";
const HELP = `HoneyBee ${VERSION}

Usage:
  honeybee demo --task <text> [--json]
  honeybee run --config <path> --task <text> [--json]
  honeybee run show <run-id> [--json]
  honeybee run delete <run-id> --yes [--json]
  honeybee version

Commands:
  demo        Run a deterministic two-process sequential workflow.
  run         Run a schemaVersion 1 or 2 Agent configuration.
  run show    Replay the JSONL journal for one Run.
  run delete  Delete exactly one Run and its Artifacts.
`;

type ParsedArguments =
  | Readonly<{ command: "help"; json: boolean }>
  | Readonly<{ command: "version"; json: boolean }>
  | Readonly<{
      command: "execute";
      mode: "demo" | "run";
      task?: string;
      config?: string;
      json: boolean;
    }>
  | Readonly<{ command: "show"; runId: string; json: boolean }>
  | Readonly<{ command: "delete"; runId: string; yes: boolean; json: boolean }>;

const optionValue = (args: readonly string[], name: string): string | undefined => {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} needs a value.`);
  return value;
};

const parseArguments = (args: readonly string[]): ParsedArguments => {
  if (args.length === 0 || args[0] === "help" || args.includes("--help") || args.includes("-h")) {
    return { command: "help", json: false };
  }
  if (args[0] === "version" || args.includes("--version")) {
    return { command: "version", json: false };
  }
  if (args[0] === "run" && (args[1] === "show" || args[1] === "delete")) {
    const runId = args[2];
    if (runId === undefined || runId.startsWith("--")) throw new Error("run-id is required.");
    return args[1] === "show"
      ? { command: "show", runId, json: args.includes("--json") }
      : {
          command: "delete",
          runId,
          yes: args.includes("--yes"),
          json: args.includes("--json"),
        };
  }
  if (args[0] !== "demo" && args[0] !== "run") {
    throw new Error(`Unknown command: ${args[0] ?? ""}`);
  }
  const task = optionValue(args, "--task");
  const config = optionValue(args, "--config");
  return {
    command: "execute",
    mode: args[0],
    ...(task === undefined ? {} : { task }),
    ...(config === undefined ? {} : { config }),
    json: args.includes("--json"),
  };
};

const eventLine = (event: OrchestrationEventV1): string => {
  switch (event.type) {
    case "workflow.started":
      return `[workflow] started run=${event.runId} steps=${event.payload.stepCount}`;
    case "artifact.stored":
      return `[artifact] stored kind=${event.payload.artifact.kind} id=${event.payload.artifact.artifactId}`;
    case "step.assigned":
      return `[${event.stepId}] assigned ${event.payload.stepIndex + 1}/${event.payload.totalSteps}`;
    case "agent.started":
      return `[${event.stepId}] agent started pid=${event.payload.pid}`;
    case "agent.exited":
      return `[${event.stepId}] agent exited pid=${event.payload.pid} code=${String(event.payload.exitCode)} duration=${event.payload.durationMs}ms`;
    case "handoff.created":
      return `[handoff] ${event.payload.fromStepId} -> ${event.payload.toStepId}`;
    case "step.completed":
    case "step.blocked":
    case "step.escalated":
    case "step.failed":
      return `[${event.stepId}] ${event.type.slice("step.".length)}`;
    case "workflow.completed":
    case "workflow.blocked":
    case "workflow.escalated":
    case "workflow.failed":
      return `[workflow] ${event.type.slice("workflow.".length)}`;
  }
};

const demoRequest = (runId: WorkflowRunRequest["runId"], task: string): WorkflowRunRequest => {
  const demoAgentPath = fileURLToPath(new URL("./demo-agent.js", import.meta.url));
  return {
    runId,
    task,
    steps: [
      {
        id: StepIdSchema.parse("producer"),
        agent: { command: process.execPath, args: [demoAgentPath, "producer"] },
      },
      {
        id: StepIdSchema.parse("reviewer"),
        agent: { command: process.execPath, args: [demoAgentPath, "reviewer"] },
      },
    ],
    timeoutMs: 10_000,
  };
};

const stateRoot = (): string => path.resolve(process.cwd(), ".honeybee", "runs");

const output = (value: unknown, json: boolean): void => {
  process.stdout.write(json ? `${JSON.stringify(value)}\n` : `${String(value)}\n`);
};

class CliRunExecutionError extends Error {
  public override readonly name = "CliRunExecutionError";

  public constructor(
    public readonly runId: ReturnType<typeof RunIdSchema.parse>,
    public readonly journalPath: string,
    public override readonly cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
  }
}

const execute = async (args: Extract<ParsedArguments, { command: "execute" }>): Promise<void> => {
  if (args.task === undefined || args.task.trim().length === 0)
    throw new Error("--task is required.");
  const config =
    args.mode === "run"
      ? await (async () => {
          if (args.config === undefined) throw new Error("--config is required for run.");
          return loadWorkflowConfig(args.config);
        })()
      : undefined;
  const runId = RunIdSchema.parse(randomUUID());
  const root = stateRoot();
  const repository = new FileRunRepository(root);
  await repository.create(runId);
  const fileJournal = new FileOrchestrationJournal(root);
  const eventOutput = args.json ? process.stderr : process.stdout;
  const journal: OrchestrationJournal = {
    append: async (eventRunId, event) => {
      await fileJournal.append(eventRunId, event);
      eventOutput.write(`${eventLine(event)}\n`);
    },
    replay: (eventRunId) => fileJournal.replay(eventRunId),
  };
  const journalPath = path.join(root, runId, "events.jsonl");
  let request: WorkflowRunRequest;
  if (args.mode === "demo") {
    request = demoRequest(runId, args.task);
  } else {
    if (config === undefined) throw new Error("--config is required for run.");
    request = {
      runId,
      task: args.task,
      steps: config.steps,
      ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
      ...(config.maxOutputBytes === undefined ? {} : { maxOutputBytes: config.maxOutputBytes }),
    };
  }
  const result = await new OrchestrationWorkflow(
    new ChildProcessAgentRunner(),
    new FileArtifactStore(root),
    journal,
  )
    .run(request)
    .catch((error: unknown) => {
      throw new CliRunExecutionError(runId, journalPath, error);
    });

  if (args.json) {
    output({ ok: result.status === "completed", ...result, journalPath }, true);
  } else if (result.status === "completed") {
    output(`\nFinal result\n${result.result}\nRun: ${runId}`, false);
  } else if (result.status === "blocked") {
    output(`\nBlocked\n${result.reason}\nRun: ${runId}`, false);
  } else {
    output(`\nEscalated\n${result.reason}\n${result.question}\nRun: ${runId}`, false);
  }
  if (result.status === "blocked") process.exitCode = 2;
  if (result.status === "escalated") process.exitCode = 3;
};

const showRun = async (args: Extract<ParsedArguments, { command: "show" }>): Promise<void> => {
  const runId = RunIdSchema.parse(args.runId);
  const root = stateRoot();
  await new FileRunRepository(root).open(runId);
  const replay = await new FileOrchestrationJournal(root).replay(runId);
  if (replay.status === "indeterminate") {
    const payload = {
      ok: false,
      status: "indeterminate",
      code: replay.code,
      message: replay.message,
    };
    if (args.json) output(payload, true);
    else output(`이 Run은 비정상 종료되었고 결과를 확정할 수 없음 (${runId})`, false);
    process.exitCode = 1;
    return;
  }
  const status = replay.terminal.type.slice("workflow.".length);
  output(
    args.json
      ? { ok: true, runId, status, terminal: replay.terminal, eventCount: replay.events.length }
      : `Run ${runId}: ${status}`,
    args.json,
  );
};

const deleteRun = async (args: Extract<ParsedArguments, { command: "delete" }>): Promise<void> => {
  const runId = RunIdSchema.parse(args.runId);
  if (!args.yes) {
    output(`Refusing to delete Run ${runId} without --yes.`, args.json);
    process.exitCode = 1;
    return;
  }
  await new FileRunRepository(stateRoot()).delete(runId);
  output(args.json ? { ok: true, runId, deleted: true } : `Deleted Run ${runId}.`, args.json);
};

const main = async (): Promise<void> => {
  const args = parseArguments(process.argv.slice(2));
  if (args.command === "help") {
    process.stdout.write(HELP);
    return;
  }
  if (args.command === "version") {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (args.command === "execute") return execute(args);
  if (args.command === "show") return showRun(args);
  if (args.command === "delete") return deleteRun(args);
};

void main().catch((error: unknown) => {
  const runError = error instanceof CliRunExecutionError ? error : undefined;
  const cause = runError?.cause ?? error;
  const payload =
    cause instanceof HoneyBeeCoreError
      ? {
          ok: false,
          code: cause.code,
          stepId: cause.stepId,
          message: cause.message,
          ...(runError === undefined
            ? {}
            : { runId: runError.runId, journalPath: runError.journalPath }),
        }
      : {
          ok: false,
          code: "cli.invalid-request",
          message: cause instanceof Error ? cause.message : String(cause),
          ...(runError === undefined
            ? {}
            : { runId: runError.runId, journalPath: runError.journalPath }),
        };
  process.stderr.write(`${JSON.stringify(payload)}\n`);
  process.exitCode = 1;
});
