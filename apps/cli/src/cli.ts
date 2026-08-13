#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  AgentIdSchema,
  ChildProcessAgentRunner,
  DagOrchestrationWorkflow,
  EventIdSchema,
  FileArtifactStore,
  FileOrchestrationJournal,
  FileRunControl,
  FileRunRepository,
  HarnessIdSchema,
  HoneyBeeCoreError,
  RunIdSchema,
  StepIdSchema,
  WorkflowConfigV3Schema,
  UnityWorkConfigV1Schema,
  type AnyOrchestrationEvent,
  type ControlAction,
  type DagWorkflowRunResult,
  type RunId,
  type VersionedOrchestrationJournal,
  type WorkflowConfigV3,
  type HoneyBeeCoreErrorCode,
} from "@honeybee/core";

import { loadUnityWorkConfig, loadWorkflowConfig } from "./config.js";
import {
  TestPlayCliAdapter,
  UnityProjectBootstrap,
  UnityWorkspaceStorageCliAdapter,
} from "./unity-adapters.js";
import { UnityWorkTransaction, type UnityWorkRunResult } from "./unity-transaction.js";

const VERSION = "0.4.0";
const HELP = `HoneyBee ${VERSION}

Usage:
  honeybee demo --task <text> [--json]
  honeybee run --config <path> --task <text> [--json]
  honeybee unity run --config <path> --task <text> [--json]
  honeybee run show <run-id> [--json]
  honeybee run pause <run-id> [--json]
  honeybee run resume <run-id> [--json]
  honeybee run cancel <run-id> [--json]
  honeybee run approve <run-id> <step-id> [--json]
  honeybee run reject <run-id> <step-id> [--json]
  honeybee run resolve-attempt <run-id> <step-id> --retry|--fail [--json]
  honeybee run delete <run-id> --yes [--json]
  honeybee version

Commands:
  demo                 Run a deterministic two-process compatible workflow.
  run                  Run a strict schemaVersion 1, 2, or 3 configuration.
  unity run            Run one isolated Unity work transaction.
  run show             Replay durable Run and Step state.
  run pause/resume     Pause at a checkpoint or resume from the Journal.
  run approve/reject   Resolve a durable human approval gate.
  run cancel           Cancel in-flight work with a bounded grace period.
  run resolve-attempt  Explicitly resolve an interrupted Agent attempt.
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
  | Readonly<{
      command: "unity-execute";
      task?: string;
      config?: string;
      json: boolean;
    }>
  | Readonly<{ command: "show"; runId: string; json: boolean }>
  | Readonly<{ command: "resume"; runId: string; json: boolean }>
  | Readonly<{ command: "delete"; runId: string; yes: boolean; json: boolean }>
  | Readonly<{
      command: "control";
      runId: string;
      action: ControlAction;
      stepId?: string;
      json: boolean;
    }>;

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
  if (args[0] === "unity" && args[1] === "run") {
    const task = optionValue(args, "--task");
    const config = optionValue(args, "--config");
    return {
      command: "unity-execute",
      ...(task === undefined ? {} : { task }),
      ...(config === undefined ? {} : { config }),
      json: args.includes("--json"),
    };
  }
  if (args[0] === "run" && args[1] !== undefined) {
    const subcommand = args[1];
    if (
      [
        "show",
        "resume",
        "delete",
        "pause",
        "cancel",
        "approve",
        "reject",
        "resolve-attempt",
      ].includes(subcommand)
    ) {
      const runId = args[2];
      if (runId === undefined || runId.startsWith("--")) throw new Error("run-id is required.");
      const json = args.includes("--json");
      if (subcommand === "show" || subcommand === "resume")
        return { command: subcommand, runId, json };
      if (subcommand === "delete")
        return { command: "delete", runId, yes: args.includes("--yes"), json };
      if (subcommand === "pause" || subcommand === "cancel") {
        return { command: "control", runId, action: subcommand, json };
      }
      const stepId = args[3];
      if (stepId === undefined || stepId.startsWith("--")) throw new Error("step-id is required.");
      if (subcommand === "approve" || subcommand === "reject") {
        return { command: "control", runId, stepId, action: subcommand, json };
      }
      const action = args.includes("--retry")
        ? "retry"
        : args.includes("--fail")
          ? "fail"
          : undefined;
      if (action === undefined)
        throw new Error("resolve-attempt needs exactly one of --retry or --fail.");
      if (args.includes("--retry") && args.includes("--fail"))
        throw new Error("Use only one resolution.");
      return { command: "control", runId, stepId, action, json };
    }
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

const eventLine = (event: AnyOrchestrationEvent): string => {
  if (event.type === "workflow.started") {
    return event.schemaVersion === 3
      ? "[workflow] started run=" + event.runId + " mode=unity-work-v1"
      : "[workflow] started run=" + event.runId + " steps=" + event.payload.stepCount;
  }
  if (event.type === "artifact.stored") {
    return `[artifact] stored kind=${event.payload.artifact.kind} id=${event.payload.artifact.artifactId}`;
  }
  if (event.type === "agent.started")
    return `[${event.stepId}] agent started pid=${event.payload.pid}`;
  if (event.type === "agent.exited") {
    return `[${event.stepId}] agent exited pid=${event.payload.pid} code=${String(event.payload.exitCode)} duration=${event.payload.durationMs}ms`;
  }
  return `[${event.stepId ?? "workflow"}] ${event.type}`;
};

const demoConfig = (): WorkflowConfigV3 => {
  const demoAgentPath = fileURLToPath(new URL("./demo-agent.js", import.meta.url));
  const harnessId = HarnessIdSchema.parse("stdio");
  return WorkflowConfigV3Schema.parse({
    schemaVersion: 3,
    agents: ["producer", "reviewer"].map((id) => ({
      id: AgentIdSchema.parse(id),
      command: process.execPath,
      args: [demoAgentPath, id],
    })),
    harnesses: [{ id: harnessId, kind: "stdio-framed-v2", protocolVersion: 2 }],
    steps: [
      {
        id: StepIdSchema.parse("producer"),
        type: "agent",
        agentRef: AgentIdSchema.parse("producer"),
        harnessRef: harnessId,
        outputs: { content: { mediaType: "text/plain; charset=utf-8" } },
      },
      {
        id: StepIdSchema.parse("reviewer"),
        type: "agent",
        agentRef: AgentIdSchema.parse("reviewer"),
        harnessRef: harnessId,
        needs: [StepIdSchema.parse("producer")],
        inputs: { previous: { from: { stepId: "producer", output: "content" } } },
        outputs: { content: { mediaType: "text/plain; charset=utf-8" } },
      },
    ],
    outputs: { result: { from: { stepId: "reviewer", output: "content" } } },
    defaultTimeoutMs: 10_000,
    maxParallelism: 1,
  });
};

const stateRoot = (): string => path.resolve(process.cwd(), ".honeybee", "runs");

const pathsOverlap = (left: string, right: string): boolean => {
  const relativeLeft = path.relative(left, right);
  const relativeRight = path.relative(right, left);
  return (
    relativeLeft === "" ||
    (!relativeLeft.startsWith(".." + path.sep) &&
      relativeLeft !== ".." &&
      !path.isAbsolute(relativeLeft)) ||
    (!relativeRight.startsWith(".." + path.sep) &&
      relativeRight !== ".." &&
      !path.isAbsolute(relativeRight))
  );
};

const assertUnityPathsDisjoint = (
  root: string,
  config: ReturnType<typeof UnityWorkConfigV1Schema.parse>,
): void => {
  if (
    pathsOverlap(root, config.sourceProjectPath) ||
    pathsOverlap(root, config.workspaceStorage.workspaceRoot) ||
    pathsOverlap(config.sourceProjectPath, config.workspaceStorage.workspaceRoot)
  ) {
    throw new Error(
      "HoneyBee Run state, sourceProjectPath, and workspaceStorage.workspaceRoot must be disjoint.",
    );
  }
};

const output = (value: unknown, json: boolean): void => {
  process.stdout.write(json ? `${JSON.stringify(value)}\n` : `${String(value)}\n`);
};

class CliRunExecutionError extends Error {
  public override readonly name = "CliRunExecutionError";
  public constructor(
    public readonly runId: RunId,
    public readonly journalPath: string,
    public override readonly cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
  }
}

const workflowFor = (
  root: string,
  journal: VersionedOrchestrationJournal,
  controls: FileRunControl,
): DagOrchestrationWorkflow =>
  new DagOrchestrationWorkflow(
    new ChildProcessAgentRunner(),
    new FileArtifactStore(root),
    journal,
    controls,
  );

const printableResult = (result: DagWorkflowRunResult) => ({
  ...result,
  steps: result.steps.map((step) => ({ ...step, status: step.state })),
});

const finishExecution = (
  result: DagWorkflowRunResult,
  journalPath: string,
  json: boolean,
): void => {
  if (json)
    output({ ok: result.status === "completed", ...printableResult(result), journalPath }, true);
  else
    output(
      `Run ${result.runId}: ${result.status}${result.result === undefined ? "" : `\n${result.result}`}`,
      false,
    );
  if (result.status === "failed") process.exitCode = 1;
  else if (result.status === "blocked") process.exitCode = 2;
  else if (result.status === "escalated") process.exitCode = 3;
  else if (result.status === "paused" || result.status === "interrupted") process.exitCode = 4;
  else if (result.status === "cancelled") process.exitCode = 130;
};

const finishUnityExecution = (
  result: UnityWorkRunResult,
  journalPath: string,
  json: boolean,
): void => {
  if (json) output({ ok: result.status === "completed", ...result, journalPath }, true);
  else output("Unity Run " + result.runId + ": " + result.status, false);
  if (result.status === "failed") process.exitCode = 1;
  else if (result.status === "cleanup-pending") process.exitCode = 4;
  else if (result.status === "cancelled") process.exitCode = 130;
};

const unityTransactionFor = (
  root: string,
  config: ReturnType<typeof UnityWorkConfigV1Schema.parse>,
  journal: VersionedOrchestrationJournal,
  controls: FileRunControl,
): UnityWorkTransaction =>
  new UnityWorkTransaction(
    new ChildProcessAgentRunner(),
    new FileArtifactStore(root),
    journal,
    controls,
    new UnityProjectBootstrap(),
    new UnityWorkspaceStorageCliAdapter(
      config.workspaceStorage.command,
      config.workspaceStorage.parentKey.provider,
      config.workspaceStorage.binarySha256,
    ),
    new TestPlayCliAdapter(config.testplay),
  );

const execute = async (args: Extract<ParsedArguments, { command: "execute" }>): Promise<void> => {
  if (args.task === undefined || args.task.trim().length === 0)
    throw new Error("--task is required.");
  const config =
    args.mode === "demo"
      ? demoConfig()
      : await (async () => {
          if (args.config === undefined) throw new Error("--config is required for run.");
          return loadWorkflowConfig(args.config);
        })();
  const runId = RunIdSchema.parse(randomUUID());
  const root = stateRoot();
  await new FileRunRepository(root).create(runId);
  const controls = new FileRunControl(root);
  const lease = await controls.acquire(runId);
  const fileJournal = new FileOrchestrationJournal(root);
  const eventOutput = args.json ? process.stderr : process.stdout;
  const journal: VersionedOrchestrationJournal = {
    append: async (eventRunId, event) => {
      await fileJournal.append(eventRunId, event);
      if (
        event.schemaVersion === 2 &&
        event.type === "step.attempt.started" &&
        event.stepId !== undefined
      ) {
        const step = config.steps.find((candidate) => candidate.id === event.stepId);
        const source = Object.values(step?.inputs ?? {})[0]?.from.stepId;
        if (source !== undefined) eventOutput.write(`[handoff] ${source} -> ${event.stepId}\n`);
      }
      eventOutput.write(`${eventLine(event)}\n`);
    },
    replay: (eventRunId) => fileJournal.replay(eventRunId),
  };
  const journalPath = path.join(root, runId, "events.jsonl");
  try {
    const result = await workflowFor(root, journal, controls).run({
      runId,
      task: args.task,
      config,
    });
    if (result.status === "failed") {
      throw new HoneyBeeCoreError(
        (result.failure?.errorCode ?? "workflow.step-failed") as HoneyBeeCoreErrorCode,
        "One or more workflow steps failed.",
      );
    }
    finishExecution(result, journalPath, args.json);
  } catch (error) {
    throw new CliRunExecutionError(runId, journalPath, error);
  } finally {
    await lease.release();
  }
};

const executeUnity = async (
  args: Extract<ParsedArguments, { command: "unity-execute" }>,
): Promise<void> => {
  if (args.task === undefined || args.task.trim().length === 0) {
    throw new Error("--task is required.");
  }
  if (args.config === undefined) throw new Error("--config is required for unity run.");
  const config = await loadUnityWorkConfig(args.config);
  const runId = RunIdSchema.parse(randomUUID());
  const root = stateRoot();
  assertUnityPathsDisjoint(root, config);
  await new FileRunRepository(root).create(runId);
  const controls = new FileRunControl(root);
  const executorLease = await controls.acquire(runId);
  const journal = new FileOrchestrationJournal(root);
  const journalPath = path.join(root, runId, "events.jsonl");
  try {
    const result = await unityTransactionFor(root, config, journal, controls).run(
      runId,
      args.task,
      config,
    );
    finishUnityExecution(result, journalPath, args.json);
  } catch (error) {
    throw new CliRunExecutionError(runId, journalPath, error);
  } finally {
    await executorLease.release();
  }
};

const resumeRun = async (args: Extract<ParsedArguments, { command: "resume" }>): Promise<void> => {
  const runId = RunIdSchema.parse(args.runId);
  const root = stateRoot();
  await new FileRunRepository(root).open(runId);
  const controls = new FileRunControl(root);
  const lease = await controls.acquire(runId);
  const journalPath = path.join(root, runId, "events.jsonl");
  try {
    const journal = new FileOrchestrationJournal(root);
    const replay = await journal.replay(runId);
    if (replay.status !== "indeterminate" && replay.events[0]?.schemaVersion === 3) {
      const start = replay.events[0];
      if (start.type !== "workflow.started") {
        throw new HoneyBeeCoreError("run.indeterminate", "Run has no start event.");
      }
      const artifacts = new FileArtifactStore(root);
      const config = UnityWorkConfigV1Schema.parse(
        JSON.parse(await artifacts.get({ runId, artifact: start.payload.config })) as unknown,
      );
      assertUnityPathsDisjoint(root, config);
      const result = await unityTransactionFor(root, config, journal, controls).resume(
        runId,
        config,
      );
      finishUnityExecution(result, journalPath, args.json);
      return;
    }
    const result = await workflowFor(root, new FileOrchestrationJournal(root), controls).resume(
      runId,
    );
    if (result.status === "failed") {
      throw new HoneyBeeCoreError(
        (result.failure?.errorCode ?? "workflow.step-failed") as HoneyBeeCoreErrorCode,
        "One or more workflow steps failed.",
      );
    }
    finishExecution(result, journalPath, args.json);
  } catch (error) {
    throw new CliRunExecutionError(runId, journalPath, error);
  } finally {
    await lease.release();
  }
};

const showRun = async (args: Extract<ParsedArguments, { command: "show" }>): Promise<void> => {
  const runId = RunIdSchema.parse(args.runId);
  const root = stateRoot();
  await new FileRunRepository(root).open(runId);
  const journal = new FileOrchestrationJournal(root);
  const replay = await journal.replay(runId);
  if (replay.status === "indeterminate") {
    const payload = {
      ok: false,
      runId,
      status: "indeterminate",
      code: replay.code,
      message: replay.message,
    };
    if (args.json) output(payload, true);
    else output(`이 Run은 비정상 종료되었고 결과를 확정할 수 없음 (${runId})`, false);
    process.exitCode = 1;
    return;
  }
  const executorPresent = await new FileRunControl(root).executorPresent(runId);
  if (replay.events[0]?.schemaVersion === 3) {
    const terminalStatus =
      replay.status === "terminal" ? replay.terminal.type.slice("workflow.".length) : undefined;
    const cleanupPending = replay.status === "active" && !executorPresent;
    const status = terminalStatus ?? (cleanupPending ? "cleanup-pending" : "running");
    output(
      args.json
        ? {
            ok: status === "completed",
            runId,
            status,
            eventCount: replay.events.length,
            executorPresent,
            requiresResume: cleanupPending && !executorPresent,
          }
        : "Unity Run " + runId + ": " + status,
      args.json,
    );
    return;
  }
  if (replay.events[0]?.schemaVersion === 1) {
    const terminal = replay.status === "terminal" ? replay.terminal : undefined;
    const status = terminal?.type.slice("workflow.".length) ?? "indeterminate";
    output(
      args.json
        ? { ok: true, runId, status, terminal, eventCount: replay.events.length, executorPresent }
        : `Run ${runId}: ${status}`,
      args.json,
    );
    return;
  }
  if (replay.status === "terminal") {
    const status = replay.terminal.type.slice("workflow.".length);
    const steps = new Map<
      string,
      { stepId: string; status: string; attempt?: number; pid?: number }
    >();
    for (const event of replay.events) {
      if (event.schemaVersion !== 2 || event.stepId === undefined) continue;
      const current = steps.get(event.stepId) ?? { stepId: event.stepId, status: "pending" };
      if (event.type === "step.attempt.started") {
        current.status = "running";
        current.attempt = event.payload.attempt;
      } else if (event.type === "agent.started") {
        current.pid = event.payload.pid;
      } else if (event.type.startsWith("step.")) {
        const semantic = event.type.slice("step.".length);
        if (
          ["completed", "blocked", "escalated", "failed", "skipped", "cancelled"].includes(semantic)
        ) {
          current.status = semantic;
        }
      }
      steps.set(event.stepId, current);
    }
    output(
      args.json
        ? {
            ok: status !== "failed",
            runId,
            status,
            terminal: replay.terminal,
            steps: [...steps.values()],
            eventCount: replay.events.length,
            executorPresent,
          }
        : `Run ${runId}: ${status}`,
      args.json,
    );
    return;
  }
  const result = await workflowFor(root, journal, new FileRunControl(root)).inspect(runId);
  output(
    args.json
      ? {
          ok: !["failed", "indeterminate"].includes(result.status),
          ...printableResult(result),
          eventCount: replay.events.length,
          executorPresent,
        }
      : `Run ${runId}: ${result.status}`,
    args.json,
  );
};

const submitControl = async (
  args: Extract<ParsedArguments, { command: "control" }>,
): Promise<void> => {
  const runId = RunIdSchema.parse(args.runId);
  const root = stateRoot();
  await new FileRunRepository(root).open(runId);
  const replay = await new FileOrchestrationJournal(root).replay(runId);
  if (replay.status === "indeterminate") {
    throw new HoneyBeeCoreError("run.indeterminate", replay.message);
  }
  if (replay.status === "terminal") {
    throw new HoneyBeeCoreError("run.terminal", "A terminal Run cannot accept control requests.");
  }
  if (replay.events[0]?.schemaVersion === 3 && args.action !== "cancel") {
    throw new HoneyBeeCoreError(
      "validation.invalid-workflow",
      "Unity work transactions accept only run cancel.",
    );
  }
  if (
    replay.events[0]?.schemaVersion === 3 &&
    replay.events.some((event) => event.type === "transaction.outcome-decided")
  ) {
    throw new HoneyBeeCoreError(
      "run.not-resumable",
      "The Unity outcome is already decided; run resume is required only for cleanup.",
    );
  }
  const stepId = args.stepId === undefined ? undefined : StepIdSchema.parse(args.stepId);
  const request = {
    requestId: EventIdSchema.parse(randomUUID()),
    runId,
    action: args.action,
    ...(stepId === undefined ? {} : { stepId }),
    timestamp: new Date().toISOString(),
  } as const;
  const controls = new FileRunControl(root);
  await controls.submit(request);
  const executorPresent = await controls.executorPresent(runId);
  const disposition = executorPresent ? "queued" : "queued-awaiting-executor";
  output(
    args.json
      ? {
          ok: true,
          runId,
          requestId: request.requestId,
          action: request.action,
          pending: true,
          disposition,
          executorPresent,
          requiresResume: !executorPresent,
        }
      : executorPresent
        ? `Queued ${request.action} for Run ${runId}.`
        : `Queued ${request.action} for Run ${runId}; no executor is active, so run resume is required.`,
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
  const root = stateRoot();
  const controls = new FileRunControl(root);
  const lease = await controls.acquire(runId);
  try {
    await new FileRunRepository(root).delete(runId);
  } finally {
    await lease.release();
  }
  output(args.json ? { ok: true, runId, deleted: true } : `Deleted Run ${runId}.`, args.json);
};

const main = async (): Promise<void> => {
  const args = parseArguments(process.argv.slice(2));
  if (args.command === "help") return void process.stdout.write(HELP);
  if (args.command === "version") return void process.stdout.write(`${VERSION}\n`);
  if (args.command === "execute") return execute(args);
  if (args.command === "unity-execute") return executeUnity(args);
  if (args.command === "show") return showRun(args);
  if (args.command === "resume") return resumeRun(args);
  if (args.command === "control") return submitControl(args);
  return deleteRun(args);
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
