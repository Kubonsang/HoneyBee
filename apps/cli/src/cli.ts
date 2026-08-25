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
  UnityBatchConfigSchema,
  UnityBatchConfigV3Schema,
  UnityWorkConfigV1Schema,
  UnityWorkConfigV2Schema,
  type AnyOrchestrationEvent,
  type ControlAction,
  type DagWorkflowRunResult,
  type RunId,
  type VersionedOrchestrationJournal,
  type WorkflowConfigV3,
  type HoneyBeeCoreErrorCode,
  type OrchestrationEventV4,
  type OrchestrationEventV5,
} from "@honeybee/core";

import { loadUnityBatchConfig, loadUnityWorkConfig, loadWorkflowConfig } from "./config.js";
import {
  TestPlayCliAdapter,
  UnityAgentProcessRunner,
  UnityProjectBootstrap,
  UnityWorkspaceStorageCliAdapter,
} from "./unity-adapters.js";
import { UnityWorkTransaction, type UnityWorkRunResult } from "./unity-transaction.js";
import {
  UnityBatchWorkflow,
  inspectUnityBatchEvents,
  type UnityBatchRunResult,
} from "./unity-batch.js";
import { UnityPatchBuilder } from "./unity-patch.js";
import { FileUnityPatchControl } from "./unity-patch-control.js";
import { BatchLocalUnityResourceCoordinator } from "./unity-resource-control.js";
import { FileUnityResourceCoordinator } from "./unity-global-resource-control.js";
import { inspectUnityEditorBatchEvents } from "./unity-editor-batch.js";
import { HoneyBeeRuntimeFacade } from "./runtime-api.js";
import {
  assertUnityPathsDisjoint,
  createUnityEditorBatchWorkflow,
  createUnityEditorTransactionServices,
} from "./unity-runtime-services.js";

const VERSION = "0.6.0";
const HELP = `HoneyBee ${VERSION}

Usage:
  honeybee demo --task <text> [--json] [--state-root <path>]
  honeybee run --config <path> --task <text> [--json]
  honeybee unity run --config <path> --task <text> [--json]
  honeybee unity batch run --config <path> [--json]
  honeybee unity editor list [--json]
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
  unity batch run      Run a compatible v0.5 batch or v0.6 Editor-pool batch.
  unity editor list    Observe OS Unity Editors without claiming user-owned processes.
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
  | Readonly<{ command: "unity-batch-execute"; config?: string; json: boolean }>
  | Readonly<{ command: "unity-editor-list"; json: boolean }>
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
  if (args[0] === "unity" && args[1] === "batch" && args[2] === "run") {
    const config = optionValue(args, "--config");
    return {
      command: "unity-batch-execute",
      ...(config === undefined ? {} : { config }),
      json: args.includes("--json"),
    };
  }
  if (args[0] === "unity" && args[1] === "editor" && args[2] === "list") {
    return { command: "unity-editor-list", json: args.includes("--json") };
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
    if (event.schemaVersion === 3) {
      return "[workflow] started run=" + event.runId + " mode=unity-work-v1";
    }
    if (event.schemaVersion === 4) {
      return "[workflow] started run=" + event.runId + " mode=" + event.payload.mode;
    }
    if (event.schemaVersion === 5) {
      return "[workflow] started run=" + event.runId + " mode=" + event.payload.mode;
    }
    return "[workflow] started run=" + event.runId + " steps=" + event.payload.stepCount;
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

const stateRoot = (): string => {
  const configured = optionValue(process.argv.slice(2), "--state-root");
  return path.resolve(configured ?? path.join(process.cwd(), ".honeybee", "runs"));
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

const finishUnityBatchExecution = (
  result: UnityBatchRunResult,
  journalPath: string,
  json: boolean,
): void => {
  if (json) output({ ok: result.status === "completed", ...result, journalPath }, true);
  else output("Unity Batch " + result.runId + ": " + result.status, false);
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
    new UnityAgentProcessRunner(),
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

const unityBatchFor = (
  root: string,
  config: Exclude<ReturnType<typeof UnityBatchConfigSchema.parse>, { schemaVersion: 3 | 4 }>,
  journal: VersionedOrchestrationJournal,
  controls: FileRunControl,
): UnityBatchWorkflow => {
  const artifacts = new FileArtifactStore(root);
  const bootstrap = new UnityProjectBootstrap();
  const transaction = new UnityWorkTransaction(
    new UnityAgentProcessRunner(),
    artifacts,
    journal,
    controls,
    bootstrap,
    new UnityWorkspaceStorageCliAdapter(
      config.transaction.workspaceStorage.command,
      config.transaction.workspaceStorage.parentKey.provider,
      config.transaction.workspaceStorage.binarySha256,
    ),
    new TestPlayCliAdapter(config.transaction.testplay),
  );
  return new UnityBatchWorkflow(
    root,
    artifacts,
    journal,
    new FileRunRepository(root),
    controls,
    controls,
    transaction,
    config.schemaVersion === 2
      ? new FileUnityResourceCoordinator(root)
      : new BatchLocalUnityResourceCoordinator(),
    new UnityPatchBuilder(artifacts, bootstrap, path.join(root, ".patch-verification")),
  );
};

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
  const task = args.task;
  if (args.config === undefined) throw new Error("--config is required for unity run.");
  const config = await loadUnityWorkConfig(args.config);
  const runId = RunIdSchema.parse(randomUUID());
  const root = stateRoot();
  await assertUnityPathsDisjoint(root, config);
  await new FileRunRepository(root).create(runId);
  const controls = new FileRunControl(root);
  const executorLease = await controls.acquire(runId);
  const journal = new FileOrchestrationJournal(root);
  const journalPath = path.join(root, runId, "events.jsonl");
  try {
    const result =
      config.schemaVersion === 1
        ? await unityTransactionFor(root, config, journal, controls).run(runId, task, config)
        : await (async () => {
            const services = createUnityEditorTransactionServices(root, config, journal, controls);
            if (config.capabilities.length > 0) {
              await services.execution.pool.declare({
                poolId: config.editorPool.id,
                capacity: config.editorPool.capacity,
              });
            }
            return services.transaction.run(runId, task, config, services.execution);
          })();
    finishUnityExecution(result, journalPath, args.json);
  } catch (error) {
    throw new CliRunExecutionError(runId, journalPath, error);
  } finally {
    await executorLease.release();
  }
};

const executeUnityBatch = async (
  args: Extract<ParsedArguments, { command: "unity-batch-execute" }>,
): Promise<void> => {
  if (args.config === undefined) throw new Error("--config is required for unity batch run.");
  const config = await loadUnityBatchConfig(args.config);
  const runId = RunIdSchema.parse(randomUUID());
  const root = stateRoot();
  await assertUnityPathsDisjoint(root, config.transaction);
  await new FileRunRepository(root).create(runId);
  const controls = new FileRunControl(root);
  const executorLease = await controls.acquire(runId);
  const journal = new FileOrchestrationJournal(root);
  const journalPath = path.join(root, runId, "events.jsonl");
  try {
    const result =
      config.schemaVersion === 3 || config.schemaVersion === 4
        ? await createUnityEditorBatchWorkflow(root, config, journal, controls).run(runId, config)
        : await unityBatchFor(root, config, journal, controls).run(runId, config);
    finishUnityBatchExecution(result, journalPath, args.json);
  } catch (error) {
    throw new CliRunExecutionError(runId, journalPath, error);
  } finally {
    await executorLease.release();
  }
};

const listUnityEditors = async (
  args: Extract<ParsedArguments, { command: "unity-editor-list" }>,
): Promise<void> => {
  const { editors } = await new HoneyBeeRuntimeFacade({ stateRoot: stateRoot() }).listEditors();
  if (args.json) {
    output({ ok: true, editors }, true);
    return;
  }
  if (editors.length === 0) {
    output("No Unity Editors observed.", false);
    return;
  }
  output(
    editors
      .map(
        (editor) =>
          `${editor.editorId} pid=${editor.pid} ownership=${editor.ownership} state=${editor.state}` +
          `${editor.projectPath === undefined ? " project=<unknown>" : ` project=${editor.projectPath}`}`,
      )
      .join("\n"),
    false,
  );
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
    if (replay.status !== "indeterminate" && replay.events[0]?.schemaVersion === 5) {
      const start = replay.events[0];
      if (start.type !== "workflow.started")
        throw new HoneyBeeCoreError("run.indeterminate", "Run has no start event.");
      const artifacts = new FileArtifactStore(root);
      if (start.payload.mode === "unity-batch-v2") {
        const config = UnityBatchConfigV3Schema.parse(
          JSON.parse(await artifacts.get({ runId, artifact: start.payload.config })) as unknown,
        );
        await assertUnityPathsDisjoint(root, config.transaction);
        const result = await createUnityEditorBatchWorkflow(root, config, journal, controls).resume(
          runId,
        );
        finishUnityBatchExecution(result, journalPath, args.json);
        return;
      }
      if (start.payload.linkage.parentRunId !== undefined) {
        throw new HoneyBeeCoreError(
          "batch.child-managed",
          "A Unity v0.6 batch child can only be resumed through its parent Run.",
        );
      }
      const config = UnityWorkConfigV2Schema.parse(
        JSON.parse(await artifacts.get({ runId, artifact: start.payload.config })) as unknown,
      );
      await assertUnityPathsDisjoint(root, config);
      const services = createUnityEditorTransactionServices(root, config, journal, controls);
      const result = await services.transaction.resume(runId, config, services.execution);
      finishUnityExecution(result, journalPath, args.json);
      return;
    }
    if (replay.status !== "indeterminate" && replay.events[0]?.schemaVersion === 4) {
      const start = replay.events[0];
      if (start.type !== "workflow.started") {
        throw new HoneyBeeCoreError("run.indeterminate", "Run has no start event.");
      }
      if (start.payload.mode === "unity-work-v2") {
        throw new HoneyBeeCoreError(
          "batch.child-managed",
          "A Unity batch child can only be resumed through its parent Run.",
        );
      }
      const artifacts = new FileArtifactStore(root);
      const config = UnityBatchConfigSchema.parse(
        JSON.parse(await artifacts.get({ runId, artifact: start.payload.config })) as unknown,
      );
      if (config.schemaVersion === 3 || config.schemaVersion === 4)
        throw new HoneyBeeCoreError(
          "run.indeterminate",
          "A v0.5 Journal references a v0.6 config.",
        );
      await assertUnityPathsDisjoint(root, config.transaction);
      const result = await unityBatchFor(root, config, journal, controls).resume(runId);
      finishUnityBatchExecution(result, journalPath, args.json);
      return;
    }
    if (replay.status !== "indeterminate" && replay.events[0]?.schemaVersion === 3) {
      const start = replay.events[0];
      if (start.type !== "workflow.started") {
        throw new HoneyBeeCoreError("run.indeterminate", "Run has no start event.");
      }
      const artifacts = new FileArtifactStore(root);
      const config = UnityWorkConfigV1Schema.parse(
        JSON.parse(await artifacts.get({ runId, artifact: start.payload.config })) as unknown,
      );
      await assertUnityPathsDisjoint(root, config);
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
  if (replay.events[0]?.schemaVersion === 5) {
    const events = replay.events as readonly OrchestrationEventV5[];
    const start = events[0];
    if (start?.type !== "workflow.started")
      throw new HoneyBeeCoreError("run.indeterminate", "Run has no start event.");
    if (start.payload.mode === "unity-batch-v2") {
      const result = inspectUnityEditorBatchEvents(runId, events);
      const status =
        replay.status === "active" && !executorPresent ? "cleanup-pending" : result.status;
      output(
        args.json
          ? {
              ok: status === "completed",
              ...result,
              status,
              eventCount: events.length,
              executorPresent,
              requiresResume: replay.status === "active" && !executorPresent,
            }
          : `Unity Editor Batch ${runId}: ${status}`,
        args.json,
      );
      return;
    }
    const terminalStatus =
      replay.status === "terminal" ? replay.terminal.type.slice("workflow.".length) : undefined;
    const cleanupPending = replay.status === "active" && !executorPresent;
    const status = terminalStatus ?? (cleanupPending ? "cleanup-pending" : "running");
    const acquired = [...events].reverse().find((event) => event.type === "editor.pool-acquired");
    const released = events.some((event) => event.type === "editor.pool-released");
    const bridgeReady = events.some((event) => event.type === "editor.bridge-bound");
    const waitingForEditor =
      events.some((event) => event.type === "editor.pool-queued") && acquired === undefined;
    const capabilityEvent = [...events]
      .reverse()
      .find(
        (event) =>
          event.type === "capability.started" ||
          event.type === "capability.completed" ||
          event.type === "capability.failed",
      );
    const phase = waitingForEditor
      ? "Waiting for Editor"
      : acquired?.type === "editor.pool-acquired" && !released
        ? bridgeReady
          ? "Warm Bridge ready"
          : `${acquired.payload.slotId} leased`
        : status;
    output(
      args.json
        ? {
            ok: status === "completed",
            runId,
            status,
            phase,
            parentRunId: start.payload.linkage.parentRunId,
            workId: start.payload.linkage.workId,
            priority: start.payload.linkage.priority,
            assignedEditor:
              acquired?.type === "editor.pool-acquired" && !released
                ? acquired.payload.slotId
                : undefined,
            bridgeReady,
            currentCapability:
              capabilityEvent !== undefined && "capabilityId" in capabilityEvent.payload
                ? {
                    id: capabilityEvent.payload.capabilityId,
                    kind: capabilityEvent.payload.kind,
                    state: capabilityEvent.type.slice("capability.".length),
                  }
                : undefined,
            eventCount: events.length,
            executorPresent,
            requiresResume: cleanupPending,
          }
        : `Unity Editor Work ${runId}: ${phase}`,
      args.json,
    );
    return;
  }
  if (replay.events[0]?.schemaVersion === 4) {
    const start = replay.events[0];
    if (start.type !== "workflow.started") {
      throw new HoneyBeeCoreError("run.indeterminate", "Run has no start event.");
    }
    if (start.payload.mode === "unity-batch-v1") {
      const result = inspectUnityBatchEvents(
        runId,
        replay.events as readonly OrchestrationEventV4[],
      );
      const status =
        replay.status === "active" && !executorPresent ? "cleanup-pending" : result.status;
      output(
        args.json
          ? {
              ok: status === "completed",
              ...result,
              status,
              eventCount: replay.events.length,
              executorPresent,
              requiresResume: replay.status === "active" && !executorPresent,
            }
          : `Unity Batch ${runId}: ${status}`,
        args.json,
      );
      return;
    }
    const terminalStatus =
      replay.status === "terminal" ? replay.terminal.type.slice("workflow.".length) : undefined;
    const cleanupPending = replay.status === "active" && !executorPresent;
    const status = terminalStatus ?? (cleanupPending ? "cleanup-pending" : "running");
    const terminal = replay.status === "terminal" ? replay.terminal : undefined;
    output(
      args.json
        ? {
            ok: status === "completed",
            runId,
            status,
            parentRunId: start.payload.linkage.parentRunId,
            workId: start.payload.linkage.workId,
            patch:
              terminal?.type === "workflow.completed" && "patch" in terminal.payload
                ? terminal.payload.patch
                : undefined,
            eventCount: replay.events.length,
            executorPresent,
            requiresResume: cleanupPending,
          }
        : `Unity Batch child ${runId}: ${status}`,
      args.json,
    );
    return;
  }
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
  const start = replay.events[0];
  if (start?.schemaVersion === 5) {
    if (start.type !== "workflow.started")
      throw new HoneyBeeCoreError("run.indeterminate", "Run has no start event.");
    if (start.payload.mode === "unity-work-v3" && start.payload.linkage.parentRunId !== undefined) {
      throw new HoneyBeeCoreError(
        "batch.child-managed",
        "A Unity v0.6 batch child only accepts controls through its parent Run.",
      );
    }
    if (args.action !== "cancel") {
      throw new HoneyBeeCoreError(
        "validation.invalid-workflow",
        "Unity v0.6 Runs accept only run cancel.",
      );
    }
    if (
      start.payload.mode === "unity-work-v3" &&
      replay.events.some((event) => event.type === "transaction.outcome-decided")
    ) {
      throw new HoneyBeeCoreError(
        "run.not-resumable",
        "The Unity outcome is already decided; only cleanup resume remains.",
      );
    }
  }
  if (start?.schemaVersion === 4) {
    if (start.type !== "workflow.started" || start.payload.mode !== "unity-batch-v1") {
      throw new HoneyBeeCoreError(
        "batch.child-managed",
        "A Unity batch child only accepts controls through its parent Run.",
      );
    }
    if (args.action !== "cancel") {
      throw new HoneyBeeCoreError(
        "validation.invalid-workflow",
        "Unity batch Runs accept only run cancel.",
      );
    }
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
    const repository = new FileRunRepository(root);
    await repository.open(runId);
    const replay = await new FileOrchestrationJournal(root).replay(runId);
    const start = replay.status === "indeterminate" ? undefined : replay.events[0];
    if (
      start?.schemaVersion === 5 &&
      start.type === "workflow.started" &&
      start.payload.mode === "unity-work-v3" &&
      start.payload.linkage.parentRunId !== undefined
    ) {
      throw new HoneyBeeCoreError(
        "batch.child-managed",
        "A Unity v0.6 batch child can only be deleted with its parent Run.",
      );
    }
    if (
      start?.schemaVersion === 4 &&
      start.type === "workflow.started" &&
      start.payload.mode === "unity-work-v2"
    ) {
      throw new HoneyBeeCoreError(
        "batch.child-managed",
        "A Unity batch child can only be deleted with its parent Run.",
      );
    }
    if (
      replay.status === "indeterminate" ||
      (replay.status === "active" && [3, 4, 5].includes(replay.events[0]?.schemaVersion ?? 0))
    ) {
      throw new HoneyBeeCoreError(
        "run.cleanup-pending",
        "A Run with unconfirmed cleanup cannot be deleted.",
      );
    }
    if (
      replay.status === "terminal" &&
      start?.schemaVersion === 5 &&
      start.type === "workflow.started" &&
      start.payload.mode === "unity-batch-v2"
    ) {
      const childRunIds = replay.events
        .filter(
          (event): event is Extract<OrchestrationEventV5, { type: "work.registered" }> =>
            event.schemaVersion === 5 && event.type === "work.registered",
        )
        .map((event) => event.payload.childRunId)
        .sort();
      const childLeases: Array<{ release(): Promise<void> }> = [];
      try {
        for (const childRunId of childRunIds) childLeases.push(await controls.acquire(childRunId));
        const journal = new FileOrchestrationJournal(root);
        for (const childRunId of childRunIds) {
          const finish = replay.events.find(
            (event) =>
              event.schemaVersion === 5 &&
              event.type === "work.finished" &&
              event.payload.childRunId === childRunId,
          );
          if (
            finish?.schemaVersion === 5 &&
            finish.type === "work.finished" &&
            finish.payload.status === "cancelled" &&
            !finish.payload.started
          )
            continue;
          try {
            await repository.open(childRunId);
          } catch (error) {
            if (error instanceof HoneyBeeCoreError && error.code === "run.not-found") continue;
            throw error;
          }
          const childReplay = await journal.replay(childRunId);
          const childStart =
            childReplay.status === "indeterminate" ? undefined : childReplay.events[0];
          if (
            childReplay.status !== "terminal" ||
            childStart?.schemaVersion !== 5 ||
            childStart.type !== "workflow.started" ||
            childStart.payload.mode !== "unity-work-v3" ||
            childStart.payload.linkage.parentRunId !== runId
          )
            throw new HoneyBeeCoreError(
              "run.cleanup-pending",
              "A v0.6 batch child has no confirmed terminal cleanup state.",
            );
        }
        for (const childRunId of childRunIds) {
          try {
            await new FileUnityPatchControl(root).assertDeletionSafe(childRunId);
            await repository.delete(childRunId);
          } catch (error) {
            if (!(error instanceof HoneyBeeCoreError) || error.code !== "run.not-found")
              throw error;
          }
        }
      } finally {
        for (const childLease of childLeases.reverse()) await childLease.release();
      }
    }
    if (
      replay.status === "terminal" &&
      start?.schemaVersion === 4 &&
      start.type === "workflow.started" &&
      start.payload.mode === "unity-batch-v1"
    ) {
      const childRunIds = replay.events
        .filter((event) => event.schemaVersion === 4 && event.type === "work.registered")
        .map((event) => event.payload.childRunId)
        .sort();
      const childLeases: Array<{ release(): Promise<void> }> = [];
      try {
        for (const childRunId of childRunIds) {
          childLeases.push(await controls.acquire(childRunId));
        }
        const journal = new FileOrchestrationJournal(root);
        for (const childRunId of childRunIds) {
          const finish = replay.events.find(
            (event) =>
              event.schemaVersion === 4 &&
              event.type === "work.finished" &&
              event.payload.childRunId === childRunId,
          );
          if (
            finish?.schemaVersion === 4 &&
            finish.type === "work.finished" &&
            finish.payload.status === "cancelled" &&
            !finish.payload.started
          ) {
            continue;
          }
          try {
            await repository.open(childRunId);
          } catch (error) {
            if (error instanceof HoneyBeeCoreError && error.code === "run.not-found") continue;
            throw error;
          }
          const childReplay = await journal.replay(childRunId);
          const childStart =
            childReplay.status === "indeterminate" ? undefined : childReplay.events[0];
          if (
            childReplay.status !== "terminal" ||
            childStart?.schemaVersion !== 4 ||
            childStart.type !== "workflow.started" ||
            childStart.payload.mode !== "unity-work-v2" ||
            childStart.payload.linkage.parentRunId !== runId
          ) {
            throw new HoneyBeeCoreError(
              "run.cleanup-pending",
              "A batch child does not have a confirmed terminal cleanup state.",
            );
          }
        }
        for (const childRunId of childRunIds) {
          try {
            await new FileUnityPatchControl(root).assertDeletionSafe(childRunId);
            await repository.delete(childRunId);
          } catch (error) {
            if (!(error instanceof HoneyBeeCoreError) || error.code !== "run.not-found")
              throw error;
          }
        }
      } finally {
        for (const childLease of childLeases.reverse()) await childLease.release();
      }
    }
    await new FileUnityPatchControl(root).assertDeletionSafe(runId);
    await repository.delete(runId);
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
  if (args.command === "unity-batch-execute") return executeUnityBatch(args);
  if (args.command === "unity-editor-list") return listUnityEditors(args);
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
