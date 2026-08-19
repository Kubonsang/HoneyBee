import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  AgentIdSchema,
  AgentInputEnvelopeV2Schema,
  AgentWorkflowStepV3Schema,
  ArtifactIdSchema,
  EditorContainmentReceiptV1Schema,
  EditorLaunchIntentV1Schema,
  EditorOwnershipReceiptV1Schema,
  EventIdSchema,
  HarnessIdSchema,
  HoneyBeeCoreError,
  OrchestrationEventV5Schema,
  PortNameSchema,
  RunIdSchema,
  StepIdSchema,
  UnityEditorObservationV1Schema,
  UnityWorkConfigV2Schema,
  createDagAgentPrompt,
  parseDagAgentResponse,
  type AgentProcessResult,
  type AgentProcessRunner,
  type ArtifactKind,
  type ArtifactMediaType,
  type ArtifactRef,
  type ArtifactStore,
  type EditorContainmentReceiptV1,
  type EditorLaunchIntentV1,
  type FailureMetadata,
  type OrchestrationEventV5,
  type ResourceId,
  type RunControlPort,
  type RunId,
  type StepId,
  type UnityCapability,
  type UnityWorkConfigV2,
  type UnityWorkPriority,
  type VersionedOrchestrationJournal,
  type WarmBridgeBindingV1,
} from "@honeybee/core";

import type {
  SourceManifest,
  UnityCapabilityRunResult,
  UnityProjectBootstrap,
  UnityWorkspaceStorageCliAdapter,
  WorkspaceAcquireReceipt,
} from "./unity-adapters.js";
import type { WarmBridgeBindingResolver } from "./unity-bridge-binding.js";
import type { UnityEditorLauncher } from "./unity-editor-launcher.js";
import type {
  UnityEditorPoolCoordinator,
  UnityEditorPoolLease,
  UnityEditorPoolLocator,
} from "./unity-editor-pool.js";
import type { UnityEditorRegistry } from "./unity-editor-registry.js";
import { SystemUnityProcessControl, type UnityProcessControl } from "./process-control.js";
import type { UnityPatchBuilder } from "./unity-patch.js";
import type { UnityWorkRunResult } from "./unity-transaction.js";

const UNITY_STEP_ID = StepIdSchema.parse("unity-agent");
const UNITY_AGENT_ID = AgentIdSchema.parse("unity-agent");
const UNITY_HARNESS_ID = HarnessIdSchema.parse("stdio");
const CONTENT_PORT = PortNameSchema.parse("content");

type Decision =
  | Readonly<{ outcome: "completed" }>
  | Readonly<{ outcome: "failed"; failure: FailureMetadata }>
  | Readonly<{ outcome: "cancelled" }>;

interface CancellationWatcher {
  stop(): Promise<void>;
  error(): unknown;
}

export interface UnityCapabilityRunner {
  runCapability(
    runId: RunId,
    capability: UnityCapability,
    binding: WarmBridgeBindingV1,
    workspacePath: string,
    timeoutMs: number,
    signal: AbortSignal,
    lifecycle: Readonly<{
      onStarted(pid: number, metadata?: Readonly<{ containment?: "deferred-v1" }>): Promise<void>;
      onRegistered?(pid: number): Promise<void>;
      onExited(observation: UnityCapabilityRunResult["command"]): Promise<void>;
    }>,
  ): Promise<UnityCapabilityRunResult>;
}

export interface UnityWorkV5Execution {
  readonly parentRunId?: RunId;
  readonly workId: StepId;
  readonly poolId: ResourceId;
  readonly priority: UnityWorkPriority;
  readonly capabilities: readonly UnityCapability[];
  readonly pool: UnityEditorPoolCoordinator;
  readonly patchBuilder: UnityPatchBuilder;
}

class V5Writer {
  #sequence: number;
  #tail: Promise<void> = Promise.resolve();

  public constructor(
    private readonly journal: VersionedOrchestrationJournal,
    private readonly runId: RunId,
    initialSequence: number,
    private readonly now: () => Date,
    private readonly randomId: () => string,
  ) {
    this.#sequence = initialSequence;
  }

  public emit(
    type: OrchestrationEventV5["type"],
    payload: unknown,
    stepId?: StepId,
  ): Promise<void> {
    return this.emitEvent(type, payload, stepId).then(() => undefined);
  }

  public emitEvent(
    type: OrchestrationEventV5["type"],
    payload: unknown,
    stepId?: StepId,
  ): Promise<OrchestrationEventV5> {
    const operation = this.#tail.then(async () => {
      const event = OrchestrationEventV5Schema.parse({
        schemaVersion: 5,
        eventId: EventIdSchema.parse(this.randomId()),
        runId: this.runId,
        sequence: ++this.#sequence,
        timestamp: this.now().toISOString(),
        type,
        ...(stepId === undefined ? {} : { stepId }),
        payload,
      });
      await this.journal.append(this.runId, event);
      return event;
    });
    this.#tail = operation.then(() => undefined);
    void this.#tail.catch(() => undefined);
    return operation;
  }
}

const failureMetadata = (error: unknown): FailureMetadata => {
  const core = error instanceof HoneyBeeCoreError ? error : undefined;
  const details = core?.details;
  const number = (name: string): number | undefined => {
    const value = details?.[name];
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
  };
  const nullableNumber = (name: string): number | null | undefined => {
    const value = details?.[name];
    return value === null || typeof value === "number" ? value : undefined;
  };
  const nullableString = (name: string): string | null | undefined => {
    const value = details?.[name];
    return value === null || typeof value === "string" ? value : undefined;
  };
  return {
    errorCode: core?.code ?? "workflow.internal-error",
    ...(nullableNumber("exitCode") === undefined ? {} : { exitCode: nullableNumber("exitCode") }),
    ...(nullableString("signal") === undefined ? {} : { signal: nullableString("signal") }),
    ...(number("durationMs") === undefined ? {} : { durationMs: number("durationMs") }),
    ...(number("stdoutBytes") === undefined ? {} : { stdoutBytes: number("stdoutBytes") }),
    ...(number("stderrBytes") === undefined ? {} : { stderrBytes: number("stderrBytes") }),
  };
};

const sameManifest = (left: SourceManifest, right: SourceManifest): boolean =>
  left.digest === right.digest &&
  left.assetsDigest === right.assetsDigest &&
  left.packagesDigest === right.packagesDigest &&
  left.projectSettingsDigest === right.projectSettingsDigest &&
  left.fileCount === right.fileCount &&
  left.logicalBytes === right.logicalBytes;

const workspaceIdFor = (runId: RunId): string => `hb-${runId}`;
const acquireRequestIdFor = (runId: RunId): string => `hb-${runId}-acquire`;
const releaseRequestIdFor = (runId: RunId): string => `hb-${runId}-release`;

const lastEvent = <Type extends OrchestrationEventV5["type"]>(
  events: readonly OrchestrationEventV5[],
  type: Type,
): Extract<OrchestrationEventV5, { type: Type }> | undefined => {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === type) return event as Extract<OrchestrationEventV5, { type: Type }>;
  }
  return undefined;
};

const processMetadata = (
  value: UnityCapabilityRunResult["command"],
): Readonly<Record<string, unknown>> => ({
  pid: value.pid,
  exitCode: value.exitCode,
  signal: value.signal,
  durationMs: value.durationMs,
  stdoutBytes: value.stdoutBytes,
  stderrBytes: value.stderrBytes,
});

const poolRequestPayload = (
  value: Pick<UnityEditorPoolLease, "poolId" | "requestId" | "priority">,
) => ({
  poolId: value.poolId,
  requestId: value.requestId,
  priority: value.priority,
});

const poolLeasePayload = (value: UnityEditorPoolLease) => ({
  ...poolRequestPayload(value),
  ticket: value.ticket,
  leaseId: value.leaseId,
  slotId: value.slotId,
});

export class UnityEditorWorkTransaction {
  readonly #now: () => Date;
  readonly #randomId: () => string;
  readonly #processes: UnityProcessControl;

  public constructor(
    private readonly root: string,
    private readonly runner: AgentProcessRunner,
    private readonly artifacts: ArtifactStore,
    private readonly journal: VersionedOrchestrationJournal,
    private readonly controls: RunControlPort,
    private readonly bootstrap: UnityProjectBootstrap,
    private readonly storage: UnityWorkspaceStorageCliAdapter,
    private readonly capabilities: UnityCapabilityRunner,
    private readonly launcher: UnityEditorLauncher,
    private readonly registry: UnityEditorRegistry,
    private readonly bridge: WarmBridgeBindingResolver,
    options: Readonly<{
      now?: () => Date;
      randomId?: () => string;
      processControl?: UnityProcessControl;
    }> = {},
  ) {
    this.#now = options.now ?? (() => new Date());
    this.#randomId = options.randomId ?? randomUUID;
    this.#processes = options.processControl ?? new SystemUnityProcessControl();
  }

  public async run(
    runIdValue: RunId,
    taskValue: string,
    configValue: UnityWorkConfigV2,
    executionValue?: UnityWorkV5Execution,
  ): Promise<UnityWorkRunResult> {
    const runId = RunIdSchema.parse(runIdValue);
    const config = UnityWorkConfigV2Schema.parse(configValue);
    const task = taskValue.trim();
    if (task.length === 0)
      throw new HoneyBeeCoreError("validation.invalid-task", "The task cannot be empty.");
    const execution = executionValue ?? {
      workId: StepIdSchema.parse("unity-work"),
      poolId: config.editorPool.id,
      priority: config.priority,
      capabilities: config.capabilities,
      pool: undefined,
      patchBuilder: undefined,
    };
    if (execution.pool === undefined || execution.patchBuilder === undefined) {
      throw new HoneyBeeCoreError(
        "validation.invalid-workflow",
        "Unity v0.6 execution services are required.",
      );
    }
    if (
      execution.poolId !== config.editorPool.id ||
      execution.priority !== config.priority ||
      JSON.stringify(execution.capabilities) !== JSON.stringify(config.capabilities)
    ) {
      throw new HoneyBeeCoreError(
        "validation.invalid-workflow",
        "Unity execution context differs from config.",
      );
    }
    const configArtifact = await this.#put(
      runId,
      "workflow-config",
      "application/json",
      JSON.stringify(config),
    );
    const taskArtifact = await this.#put(runId, "task", "text/plain; charset=utf-8", task);
    const writer = new V5Writer(this.journal, runId, 0, this.#now, this.#randomId);
    await writer.emit("workflow.started", {
      mode: "unity-work-v3",
      config: configArtifact,
      task: taskArtifact,
      linkage: {
        ...(execution.parentRunId === undefined ? {} : { parentRunId: execution.parentRunId }),
        workId: execution.workId,
        poolId: execution.poolId,
        priority: execution.priority,
        capabilityCount: execution.capabilities.length,
      },
    });
    await writer.emit("artifact.stored", { artifact: configArtifact });
    await writer.emit("artifact.stored", { artifact: taskArtifact });
    return this.#runFresh(
      runId,
      config,
      execution as Required<Pick<UnityWorkV5Execution, "pool" | "patchBuilder">> &
        UnityWorkV5Execution,
      taskArtifact,
      writer,
    );
  }

  public async resume(
    runIdValue: RunId,
    configValue: UnityWorkConfigV2,
    execution: UnityWorkV5Execution,
  ): Promise<UnityWorkRunResult> {
    const runId = RunIdSchema.parse(runIdValue);
    const config = UnityWorkConfigV2Schema.parse(configValue);
    const replay = await this.journal.replay(runId);
    if (replay.status === "indeterminate")
      throw new HoneyBeeCoreError("run.indeterminate", replay.message);
    const events = replay.events as readonly OrchestrationEventV5[];
    const start = events[0];
    if (
      start?.schemaVersion !== 5 ||
      start.type !== "workflow.started" ||
      start.payload.mode !== "unity-work-v3"
    ) {
      throw new HoneyBeeCoreError("run.not-resumable", "Run is not a Unity v0.6 Work.");
    }
    if (
      start.payload.linkage.parentRunId !== execution.parentRunId ||
      start.payload.linkage.workId !== execution.workId ||
      start.payload.linkage.poolId !== execution.poolId ||
      start.payload.linkage.priority !== execution.priority
    )
      throw new HoneyBeeCoreError("run.indeterminate", "Unity v0.6 Work linkage changed.");
    if (replay.status === "terminal") return this.#resultFrom(events);
    const writer = new V5Writer(this.journal, runId, events.length, this.#now, this.#randomId);
    return this.#recover(runId, config, execution, events, writer);
  }

  async #runFresh(
    runId: RunId,
    config: UnityWorkConfigV2,
    execution: UnityWorkV5Execution & Required<Pick<UnityWorkV5Execution, "pool" | "patchBuilder">>,
    taskArtifact: ArtifactRef,
    writer: V5Writer,
  ): Promise<UnityWorkRunResult> {
    const workspaceId = workspaceIdFor(runId);
    const workspacePath = path.resolve(config.workspaceStorage.workspaceRoot, workspaceId);
    let sourceBefore: ArtifactRef | undefined;
    let sourceBeforeValue: SourceManifest | undefined;
    let acquired: WorkspaceAcquireReceipt | undefined;
    let acquireStarted = false;
    let agentOutput: ArtifactRef | undefined;
    let poolLease: UnityEditorPoolLease | undefined;
    let containment: EditorContainmentReceiptV1 | undefined;
    let containmentArtifact: ArtifactRef | undefined;
    let launchIntent: EditorLaunchIntentV1 | undefined;
    let ownership: ReturnType<typeof EditorOwnershipReceiptV1Schema.parse> | undefined;
    let editorStopStarted = false;
    let editorExited = false;
    let containmentDrained = false;
    let binding: WarmBridgeBindingV1 | undefined;
    let lastEvidence: ArtifactRef | undefined;
    let patch: ArtifactRef | undefined;
    let resultManifest: ArtifactRef | undefined;
    let decision: Decision | undefined;
    let activeCapabilityFailure: FailureMetadata | undefined;
    const aborter = new AbortController();

    try {
      await this.storage.preflight();
      sourceBeforeValue = await this.bootstrap.manifest(config.sourceProjectPath);
      sourceBefore = await this.#storeJson(
        writer,
        runId,
        "unity-source-manifest",
        sourceBeforeValue,
      );
      await writer.emit("source.baselined", { manifest: sourceBefore });
      await this.bootstrap.prepare(
        config.sourceProjectPath,
        config.workspaceStorage.workspaceRoot,
        workspaceId,
      );
      const preparedManifest = await this.bootstrap.manifest(workspacePath);
      if (!sameManifest(sourceBeforeValue, preparedManifest)) {
        throw new HoneyBeeCoreError(
          "workspace.invalid-project",
          "Prepared Unity workspace differs from source.",
        );
      }
      await writer.emit("workspace.prepared", { workspaceId, sourceManifest: sourceBefore });
      const request = this.#acquireRequest(runId, config, workspaceId);
      const requestArtifact = await this.#storeJson(
        writer,
        runId,
        "workspace-acquire-request",
        request,
      );
      await writer.emit("workspace.acquire-started", {
        request: requestArtifact,
        requestId: request.requestId,
      });
      acquireStarted = true;
      acquired = await this.storage.acquire(request, workspacePath);
      const receipt = await this.#storeJson(writer, runId, "workspace-acquire-receipt", acquired);
      await writer.emit("workspace.acquired", {
        workspaceId,
        leaseId: acquired.lease.leaseId,
        receipt,
      });
    } catch (error) {
      const failure = failureMetadata(error);
      if (
        acquired !== undefined ||
        (acquireStarted &&
          ["workspace.command-ambiguous", "workspace.protocol-invalid"].includes(failure.errorCode))
      ) {
        return {
          runId,
          status: "cleanup-pending",
          ...(sourceBefore === undefined ? {} : { sourceBefore }),
          failure,
        };
      }
      if (acquireStarted) await writer.emit("workspace.acquire-failed", { failure });
      await this.bootstrap
        .cleanupUnacquired(config.workspaceStorage.workspaceRoot, workspaceId)
        .catch(() => undefined);
      await writer.emit("workflow.failed", { failure });
      return {
        runId,
        status: "failed",
        ...(sourceBefore === undefined ? {} : { sourceBefore }),
        failure,
      };
    }

    if (await this.#acceptPendingCancel(runId, writer)) aborter.abort();
    const watcher = this.#watchCancellation(runId, writer, aborter);
    try {
      if (aborter.signal.aborted)
        throw new HoneyBeeCoreError("agent.cancelled", "Unity Work was cancelled.");
      agentOutput = await this.#runAgent(
        runId,
        config,
        taskArtifact,
        workspacePath,
        writer,
        aborter.signal,
      );

      const requestId = EventIdSchema.parse(this.#randomId());
      const request = {
        poolId: execution.poolId,
        requestId,
        ownerRunId: runId,
        ownerWorkId: execution.workId,
        priority: execution.priority,
      };
      await writer.emit("editor.pool-requested", poolRequestPayload(request));
      try {
        await execution.pool.declare({
          poolId: execution.poolId,
          capacity: config.editorPool.capacity,
        });
        const ticket = await execution.pool.enqueue(request);
        await writer.emit("editor.pool-queued", {
          ...poolRequestPayload(ticket),
          ticket: ticket.ticket,
        });
        poolLease = await execution.pool.acquire(request, aborter.signal);
      } catch (error) {
        if (aborter.signal.aborted) {
          await execution.pool.cancel(request).catch(() => undefined);
          await writer.emit("editor.pool-cancelled", poolRequestPayload(request));
        } else {
          await execution.pool.cancel(request).catch(() => undefined);
          await writer.emit("editor.pool-acquire-failed", {
            ...poolRequestPayload(request),
            failure: failureMetadata(error),
          });
        }
        throw error;
      }
      await writer.emit("editor.pool-acquired", poolLeasePayload(poolLease));

      const executablePath = path.resolve(config.testplay.unityPath);
      const executableDigest = `sha256:${createHash("sha256")
        .update(await readFile(executablePath))
        .digest("hex")}` as const;
      const launchId = EventIdSchema.parse(this.#randomId());
      const intent = EditorLaunchIntentV1Schema.parse({
        schemaVersion: 1,
        launchId,
        nonce: randomBytes(32).toString("hex"),
        poolId: execution.poolId,
        slotId: poolLease.slotId,
        poolLeaseId: poolLease.leaseId,
        ownerRunId: runId,
        ownerWorkId: execution.workId,
        workspaceId,
        projectPath: workspacePath,
        unityExecutablePath: executablePath,
        unityExecutableDigest: executableDigest,
        containmentReceiptPath: path.join(this.root, runId, "control", `editor-${launchId}.json`),
        registrationTimeoutMs: config.editorPool.registrationTimeoutMs,
        activationTimeoutMs: config.editorPool.activationTimeoutMs,
        shutdownTimeoutMs: config.editorPool.shutdownTimeoutMs,
      });
      const intentArtifact = await this.#storeJson(writer, runId, "editor-launch-intent", intent);
      await writer.emit("editor.launch-intended", {
        launchId,
        slotId: poolLease.slotId,
        leaseId: poolLease.leaseId,
        intent: intentArtifact,
      });
      launchIntent = intent;

      const handle = await this.launcher.launch(
        intent,
        {
          command: executablePath,
          args: [
            "-batchmode",
            "-nographics",
            "-projectPath",
            workspacePath,
            "-logFile",
            path.join(this.root, runId, "unity-editor.log"),
          ],
          cwd: workspacePath,
          env: { HONEYBEE_WORKSPACE_ID: workspaceId, HONEYBEE_EDITOR_LAUNCH_ID: launchId },
        },
        {
          onContainmentReady: async (receiptValue) => {
            containment = EditorContainmentReceiptV1Schema.parse(receiptValue);
            containmentArtifact = await this.#storeJson(
              writer,
              runId,
              "editor-containment-receipt",
              containment,
            );
            await writer.emit("editor.containment-registered", {
              launchId,
              pid: containment.containmentPid,
              processIdentity: containment.processIdentity,
              receipt: containmentArtifact,
            });
          },
          onActivated: () => writer.emit("editor.activated", { launchId }),
          onEditorStarted: async (editor) => {
            if (containmentArtifact === undefined)
              throw new HoneyBeeCoreError(
                "editor.receipt-invalid",
                "Containment receipt is not durable.",
              );
            const editorId = EventIdSchema.parse(this.#randomId());
            const receiptValue = EditorOwnershipReceiptV1Schema.parse({
              schemaVersion: 1,
              launchId,
              nonce: intent.nonce,
              editorId,
              editorPid: editor.pid,
              editorProcessIdentity: editor.processIdentity,
              containment: containmentArtifact,
              poolId: execution.poolId,
              slotId: poolLease?.slotId,
              poolLeaseId: poolLease?.leaseId,
              ownerRunId: runId,
              ownerWorkId: execution.workId,
              workspaceId,
              projectPath: workspacePath,
              unityExecutablePath: executablePath,
              unityExecutableDigest: executableDigest,
              establishedAt: this.#now().toISOString(),
            });
            const ownershipArtifact = await this.#storeJson(
              writer,
              runId,
              "editor-ownership-receipt",
              receiptValue,
            );
            await writer.emit("editor.ownership-established", {
              launchId,
              editorId,
              slotId: poolLease?.slotId,
              pid: editor.pid,
              processIdentity: editor.processIdentity,
              receipt: ownershipArtifact,
            });
            ownership = receiptValue;
            await this.registry.recordOwned(
              UnityEditorObservationV1Schema.parse({
                schemaVersion: 1,
                editorId,
                pid: editor.pid,
                processIdentity: editor.processIdentity,
                executablePath,
                projectPath: workspacePath,
                workspaceId,
                ownership: "honeybee",
                ownerRunId: runId,
                ownerWorkId: execution.workId,
                slotId: poolLease?.slotId,
                launchId,
                state: "alive",
                pathObservation: "confirmed",
                observedAt: this.#now().toISOString(),
              }),
            );
          },
        },
      );
      if (ownership === undefined)
        throw new HoneyBeeCoreError(
          "editor.ownership-failed",
          "Editor ownership was not established.",
        );
      binding = await this.bridge.bind({
        editor: UnityEditorObservationV1Schema.parse({
          schemaVersion: 1,
          editorId: ownership.editorId,
          pid: ownership.editorPid,
          processIdentity: ownership.editorProcessIdentity,
          executablePath,
          projectPath: workspacePath,
          workspaceId,
          ownership: "honeybee",
          ownerRunId: runId,
          ownerWorkId: execution.workId,
          slotId: poolLease.slotId,
          launchId,
          state: "alive",
          pathObservation: "confirmed",
          observedAt: this.#now().toISOString(),
        }),
        workspaceId,
        workspacePath,
        timeoutMs: config.editorPool.bridgeReadyTimeoutMs,
        signal: aborter.signal,
      });
      const bindingArtifact = await this.#storeJson(writer, runId, "warm-bridge-binding", binding);
      await writer.emit("editor.bridge-bound", {
        editorId: binding.editorId,
        bridgeSessionId: binding.bridgeSessionId,
        binding: bindingArtifact,
      });

      for (const [index, capability] of execution.capabilities.entries()) {
        lastEvidence = await this.#runCapability(
          runId,
          capability,
          index,
          binding,
          workspacePath,
          config,
          writer,
          aborter.signal,
        );
      }
      await writer.emit("editor.stop-started", { editorId: ownership.editorId, launchId });
      editorStopStarted = true;
      await handle.stop();
      await writer.emit("editor.exited", {
        editorId: ownership.editorId,
        launchId,
        pid: ownership.editorPid,
        processIdentity: ownership.editorProcessIdentity,
      });
      editorExited = true;
      await this.registry.recordExited(ownership.editorId);
      if (containment === undefined || containmentArtifact === undefined)
        throw new HoneyBeeCoreError("editor.receipt-invalid", "Containment receipt was lost.");
      await writer.emit("editor.containment-drained", { launchId, receipt: containmentArtifact });
      containmentDrained = true;
      containment = undefined;
      containmentArtifact = undefined;
      ownership = undefined;
      await this.#releasePool(execution.pool, poolLease, writer);
      poolLease = undefined;
      decision = { outcome: "completed" };
    } catch (error) {
      const pollingError = watcher.error();
      const failure = failureMetadata(pollingError ?? error);
      activeCapabilityFailure = failure;
      decision =
        pollingError === undefined &&
        (aborter.signal.aborted || failure.errorCode === "agent.cancelled")
          ? { outcome: "cancelled" }
          : { outcome: "failed", failure };
    }

    await watcher.stop();
    if (decision.outcome === "completed" && aborter.signal.aborted)
      decision = { outcome: "cancelled" };
    if (decision.outcome !== "failed" && watcher.error() !== undefined)
      decision = { outcome: "failed", failure: failureMetadata(watcher.error()) };

    const processCleanupFailure = await this.#drainInterruptedProcesses(
      runId,
      writer,
      activeCapabilityFailure,
    );
    if (processCleanupFailure !== undefined) {
      return {
        runId,
        status: "cleanup-pending",
        sourceBefore,
        ...(agentOutput === undefined ? {} : { agentOutput }),
        failure: processCleanupFailure,
      };
    }

    if (launchIntent !== undefined && containment === undefined && !containmentDrained) {
      try {
        const recovered = await this.launcher.recoverPublishedReceipt(launchIntent);
        if (recovered === undefined) {
          await writer.emit("editor.launch-abandoned", { launchId: launchIntent.launchId });
        } else {
          containment = recovered;
          containmentArtifact = await this.#storeJson(
            writer,
            runId,
            "editor-containment-receipt",
            recovered,
          );
          await writer.emit("editor.containment-registered", {
            launchId: recovered.launchId,
            pid: recovered.containmentPid,
            processIdentity: recovered.processIdentity,
            receipt: containmentArtifact,
          });
        }
      } catch (error) {
        return {
          runId,
          status: "cleanup-pending",
          sourceBefore,
          ...(agentOutput === undefined ? {} : { agentOutput }),
          failure: failureMetadata(error),
        };
      }
    }

    const cleanupFailure = await this.#cleanupEditorAndPool({
      writer,
      execution,
      ...(poolLease === undefined ? {} : { poolLease }),
      ...(containment === undefined ? {} : { containment }),
      ...(containmentArtifact === undefined ? {} : { containmentArtifact }),
      ...(ownership === undefined ? {} : { ownership }),
      editorStopStarted,
      editorExited,
      shutdownTimeoutMs: config.editorPool.shutdownTimeoutMs,
    });
    if (cleanupFailure !== undefined) {
      return {
        runId,
        status: "cleanup-pending",
        sourceBefore,
        ...(agentOutput === undefined ? {} : { agentOutput }),
        failure: cleanupFailure,
      };
    }

    let sourceAfter: ArtifactRef | undefined;
    try {
      const afterValue = await this.bootstrap.manifest(config.sourceProjectPath);
      sourceAfter = await this.#storeJson(writer, runId, "unity-source-manifest", afterValue);
      const unchanged = sameManifest(sourceBeforeValue, afterValue);
      await writer.emit("source.checked", { before: sourceBefore, after: sourceAfter, unchanged });
      if (!unchanged) decision = { outcome: "failed", failure: { errorCode: "source.modified" } };
      if (decision.outcome === "completed") {
        const verified = await execution.patchBuilder.build({
          runId,
          sourceProjectPath: config.sourceProjectPath,
          workspacePath,
          baseManifest: sourceBefore,
          verifySource: async () => {
            if (
              !sameManifest(
                sourceBeforeValue,
                await this.bootstrap.manifest(config.sourceProjectPath),
              )
            ) {
              throw new HoneyBeeCoreError("source.modified", "The original Unity project changed.");
            }
          },
          publishBytes: (kind, mediaType, content) =>
            this.#storeBytes(writer, runId, kind, mediaType, content),
          publishJson: (kind, value) => this.#storeJson(writer, runId, kind, value),
        });
        patch = verified.patch;
        resultManifest = verified.resultManifest;
        await writer.emit("patch.verified", { patch, baseManifest: sourceBefore, resultManifest });
      }
    } catch (error) {
      decision = { outcome: "failed", failure: failureMetadata(error) };
      if (sourceAfter === undefined) {
        sourceAfter = await this.#storeJson(
          writer,
          runId,
          "unity-source-manifest",
          sourceBeforeValue,
        );
        await writer.emit("source.checked", {
          before: sourceBefore,
          after: sourceAfter,
          unchanged: false,
        });
      }
    }
    await writer.emit("transaction.outcome-decided", decision);
    return this.#releaseAndFinish({
      runId,
      config,
      writer,
      workspaceId,
      leaseId: acquired.lease.leaseId,
      decision,
      sourceBefore,
      sourceAfter,
      ...(agentOutput === undefined ? {} : { agentOutput }),
      ...(lastEvidence === undefined ? {} : { lastEvidence }),
      ...(patch === undefined ? {} : { patch }),
      ...(resultManifest === undefined ? {} : { resultManifest }),
    });
  }

  async #runAgent(
    runId: RunId,
    config: UnityWorkConfigV2,
    taskArtifact: ArtifactRef,
    workspacePath: string,
    writer: V5Writer,
    signal: AbortSignal,
  ): Promise<ArtifactRef> {
    const task = await this.artifacts.get({ runId, artifact: taskArtifact });
    const step = AgentWorkflowStepV3Schema.parse({
      id: UNITY_STEP_ID,
      type: "agent",
      agentRef: UNITY_AGENT_ID,
      harnessRef: UNITY_HARNESS_ID,
      outputs: { content: { mediaType: "text/plain; charset=utf-8" } },
    });
    const envelope = AgentInputEnvelopeV2Schema.parse({
      schemaVersion: 2,
      runId,
      step: { id: UNITY_STEP_ID, attempt: 1 },
      task: { artifact: taskArtifact, content: task },
      inputs: {},
      outputs: step.outputs,
    });
    const input = await this.#put(
      runId,
      "step-input",
      "application/json",
      JSON.stringify(envelope),
    );
    await writer.emit("artifact.stored", { artifact: input }, UNITY_STEP_ID);
    let startedEvent: OrchestrationEventV5 | undefined;
    let deferred = false;
    let result: AgentProcessResult;
    try {
      result = await this.runner.run(
        {
          runId,
          stepId: UNITY_STEP_ID,
          prompt:
            "Work only inside the isolated Unity project. Do not launch Unity; HoneyBee owns Editor capabilities.\n\n" +
            createDagAgentPrompt(JSON.stringify(envelope)),
          command: {
            ...config.agent.command,
            cwd: workspacePath,
            env: { ...config.agent.command.env, HONEYBEE_UNITY_PROJECT_PATH: workspacePath },
          },
          timeoutMs: config.agent.timeoutMs ?? 600_000,
          maxOutputBytes: config.agent.maxOutputBytes ?? 1024 * 1024,
          signal,
        },
        {
          onStarted: async (pid, metadata) => {
            deferred = metadata?.containment === "deferred-v1";
            const processIdentity = await this.#processes.captureIdentity(pid);
            startedEvent = await writer.emitEvent(
              "agent.started",
              {
                pid,
                ...(processIdentity === undefined ? {} : { processIdentity }),
                ...(deferred ? { containment: "deferred-v1" } : {}),
              },
              UNITY_STEP_ID,
            );
          },
          onRegistered: async () => {
            if (startedEvent === undefined)
              throw new HoneyBeeCoreError("process.identity-failed", "Agent start is not durable.");
            await writer.emit(
              "process.containment-registered",
              { process: "agent", startedEventId: startedEvent.eventId },
              UNITY_STEP_ID,
            );
          },
          onExited: (observation) => writer.emit("agent.exited", observation, UNITY_STEP_ID),
        },
      );
    } catch (error) {
      if (error instanceof HoneyBeeCoreError && error.code === "agent.input-write-failed") {
        await writer.emit("agent.input-write-failed", failureMetadata(error), UNITY_STEP_ID);
      }
      throw error;
    }
    if (deferred && startedEvent !== undefined) {
      await writer.emit(
        "process.drain-completed",
        { process: "agent", startedEventId: startedEvent.eventId },
        UNITY_STEP_ID,
      );
    }
    if (result.termination !== "exited" || result.exitCode !== 0) {
      const code =
        result.termination === "cancelled"
          ? "agent.cancelled"
          : result.termination === "timed-out"
            ? "agent.timed-out"
            : result.termination === "output-limit"
              ? "agent.output-limit"
              : "agent.non-zero-exit";
      throw new HoneyBeeCoreError(
        code,
        "Unity Agent failed.",
        UNITY_STEP_ID,
        processMetadata(result),
      );
    }
    const response = parseDagAgentResponse(result.stdout, runId, step);
    if (response.status !== "completed")
      throw new HoneyBeeCoreError(
        "workflow.step-failed",
        "Unity Agent did not complete.",
        UNITY_STEP_ID,
      );
    const value = response.outputs[CONTENT_PORT];
    if (value === undefined)
      throw new HoneyBeeCoreError(
        "protocol.invalid-agent-response",
        "Unity Agent omitted content.",
        UNITY_STEP_ID,
      );
    const output = await this.#put(runId, "step-output", value.mediaType, value.content);
    await writer.emit("artifact.stored", { artifact: output }, UNITY_STEP_ID);
    return output;
  }

  async #runCapability(
    runId: RunId,
    capability: UnityCapability,
    index: number,
    binding: WarmBridgeBindingV1,
    workspacePath: string,
    config: UnityWorkConfigV2,
    writer: V5Writer,
    signal: AbortSignal,
  ): Promise<ArtifactRef> {
    const identity = { capabilityId: capability.id, index, kind: capability.kind } as const;
    await writer.emit("capability.started", identity);
    let started: OrchestrationEventV5 | undefined;
    let deferred = false;
    try {
      await this.bridge.verify(binding, signal);
      const result = await this.capabilities.runCapability(
        runId,
        capability,
        binding,
        workspacePath,
        config.editorPool.capabilityTimeoutMs,
        signal,
        {
          onStarted: async (pid, metadata) => {
            deferred = metadata?.containment === "deferred-v1";
            const processIdentity = await this.#processes.captureIdentity(pid);
            started = await writer.emitEvent("capability.process-started", {
              ...identity,
              pid,
              ...(processIdentity === undefined ? {} : { processIdentity }),
              ...(deferred ? { containment: "deferred-v1" } : {}),
            });
          },
          onRegistered: async () => {
            if (started === undefined)
              throw new HoneyBeeCoreError(
                "process.identity-failed",
                "Capability start is not durable.",
              );
            await writer.emit("capability.process-registered", {
              ...identity,
              startedEventId: started.eventId,
            });
          },
          onExited: (observation) =>
            writer.emit("capability.process-exited", {
              ...identity,
              ...processMetadata(observation),
            }),
        },
      );
      if (deferred && started !== undefined) {
        await writer.emit("capability.process-drained", {
          ...identity,
          startedEventId: started.eventId,
        });
      }
      if (result.command.termination !== "exited" || result.command.exitCode !== 0) {
        throw new HoneyBeeCoreError(
          result.command.termination === "cancelled" ? "agent.cancelled" : "capability.failed",
          "Unity capability process failed.",
          capability.id,
          processMetadata(result.command),
        );
      }
      if (capability.kind === "warm-test") {
        const response = result.response;
        const total =
          typeof response === "object" && response !== null && "total" in response
            ? (response as { readonly total?: unknown }).total
            : undefined;
        if (typeof total !== "number" || !Number.isInteger(total) || total <= 0) {
          throw new HoneyBeeCoreError(
            "capability.failed",
            "Warm Test completed without executing tests.",
            capability.id,
          );
        }
      }
      await this.bridge.verify(binding, signal);
      const files: Array<Readonly<{ name: string; artifact: ArtifactRef }>> = [];
      for (const file of result.evidence) {
        const artifact = await this.#put(runId, "testplay-evidence", file.mediaType, file.content);
        await writer.emit("artifact.stored", { artifact });
        files.push({ name: file.name, artifact });
      }
      const evidence = await this.#storeJson(writer, runId, "unity-capability-evidence", {
        schemaVersion: 1,
        capability: identity,
        bridge: {
          editorId: binding.editorId,
          editorPid: binding.editorPid,
          workspaceId: binding.workspaceId,
          bridgeSessionId: binding.bridgeSessionId,
        },
        files,
      });
      await writer.emit("capability.completed", { ...identity, evidence });
      return evidence;
    } catch (error) {
      if (started === undefined) {
        await writer.emit("capability.failed", {
          ...identity,
          failure: failureMetadata(error),
        });
      }
      throw error;
    }
  }

  async #drainInterruptedProcesses(
    runId: RunId,
    writer: V5Writer,
    activeCapabilityFailure: FailureMetadata = { errorCode: "agent.interrupted" },
  ): Promise<FailureMetadata | undefined> {
    const replay = await this.journal.replay(runId);
    if (replay.status === "indeterminate") return { errorCode: "run.indeterminate" };
    const events = replay.events as readonly OrchestrationEventV5[];
    const agentStarted = lastEvent(events, "agent.started");
    const agentExited = lastEvent(events, "agent.exited");
    const agentDrained = lastEvent(events, "process.drain-completed");
    const agentNeedsDrain =
      agentStarted !== undefined &&
      agentDrained === undefined &&
      (agentStarted.payload.containment === "deferred-v1" || agentExited === undefined);
    try {
      if (agentNeedsDrain && agentStarted !== undefined) {
        const identity = agentStarted.payload.processIdentity;
        if (identity === undefined) return { errorCode: "process.identity-failed" };
        await this.#processes.drain(agentStarted.payload.pid, identity, "unsafe");
        await writer.emit(
          "process.drain-completed",
          { process: "agent", startedEventId: agentStarted.eventId },
          UNITY_STEP_ID,
        );
      }

      const activeCapability = [...events]
        .reverse()
        .find(
          (event) =>
            event.type === "capability.started" ||
            event.type === "capability.completed" ||
            event.type === "capability.failed",
        );
      if (activeCapability?.type !== "capability.started") return undefined;
      const processStarted = [...events]
        .reverse()
        .find(
          (event): event is Extract<OrchestrationEventV5, { type: "capability.process-started" }> =>
            event.type === "capability.process-started" &&
            event.payload.capabilityId === activeCapability.payload.capabilityId &&
            event.payload.index === activeCapability.payload.index &&
            event.payload.kind === activeCapability.payload.kind,
        );
      const processDrained = [...events]
        .reverse()
        .find(
          (event) =>
            event.type === "capability.process-drained" &&
            event.payload.capabilityId === activeCapability.payload.capabilityId &&
            event.payload.index === activeCapability.payload.index &&
            event.payload.kind === activeCapability.payload.kind &&
            event.payload.startedEventId === processStarted?.eventId,
        );
      const processExited = [...events]
        .reverse()
        .find(
          (event) =>
            event.type === "capability.process-exited" &&
            event.payload.capabilityId === activeCapability.payload.capabilityId &&
            event.payload.index === activeCapability.payload.index &&
            event.payload.kind === activeCapability.payload.kind,
        );
      const processNeedsDrain =
        processStarted !== undefined &&
        processDrained === undefined &&
        (processStarted.payload.containment === "deferred-v1" || processExited === undefined);
      if (processNeedsDrain && processStarted !== undefined) {
        const identity = processStarted.payload.processIdentity;
        if (identity === undefined) return { errorCode: "process.identity-failed" };
        await this.#processes.drain(processStarted.payload.pid, identity, "unsafe");
        await writer.emit("capability.process-drained", {
          ...activeCapability.payload,
          startedEventId: processStarted.eventId,
        });
      }
      await writer.emit("capability.failed", {
        ...activeCapability.payload,
        failure: activeCapabilityFailure,
      });
      return undefined;
    } catch (error) {
      return failureMetadata(error);
    }
  }

  async #cleanupEditorAndPool(
    input: Readonly<{
      writer: V5Writer;
      execution: UnityWorkV5Execution;
      poolLease?: UnityEditorPoolLease;
      containment?: EditorContainmentReceiptV1;
      containmentArtifact?: ArtifactRef;
      ownership?: ReturnType<typeof EditorOwnershipReceiptV1Schema.parse>;
      editorStopStarted: boolean;
      editorExited: boolean;
      shutdownTimeoutMs: number;
    }>,
  ): Promise<FailureMetadata | undefined> {
    try {
      if (input.containment !== undefined && input.containmentArtifact !== undefined) {
        if (input.ownership !== undefined && !input.editorStopStarted) {
          await input.writer.emit("editor.stop-started", {
            editorId: input.ownership.editorId,
            launchId: input.ownership.launchId,
          });
        }
        await this.launcher.drainContainment(input.containment, input.shutdownTimeoutMs);
        if (input.ownership !== undefined && !input.editorExited) {
          await input.writer.emit("editor.exited", {
            editorId: input.ownership.editorId,
            launchId: input.ownership.launchId,
            pid: input.ownership.editorPid,
            processIdentity: input.ownership.editorProcessIdentity,
          });
        }
        if (input.ownership !== undefined)
          await this.registry.recordExited(input.ownership.editorId);
        await input.writer.emit("editor.containment-drained", {
          launchId: input.containment.launchId,
          receipt: input.containmentArtifact,
        });
      }
      if (input.poolLease !== undefined)
        await this.#releasePool(input.execution.pool, input.poolLease, input.writer);
      return undefined;
    } catch (error) {
      return failureMetadata(error);
    }
  }

  async #releasePool(
    pool: UnityEditorPoolCoordinator,
    lease: UnityEditorPoolLease,
    writer: V5Writer,
  ): Promise<void> {
    const payload = poolLeasePayload(lease);
    await writer.emit("editor.pool-release-started", payload);
    try {
      await pool.release(lease);
      await writer.emit("editor.pool-released", payload);
    } catch (error) {
      await writer.emit("editor.pool-release-failed", {
        ...payload,
        failure: failureMetadata(error),
      });
      throw error;
    }
  }

  async #recover(
    runId: RunId,
    config: UnityWorkConfigV2,
    execution: UnityWorkV5Execution,
    originalEvents: readonly OrchestrationEventV5[],
    writer: V5Writer,
  ): Promise<UnityWorkRunResult> {
    const events = [...originalEvents];
    const workspaceId = workspaceIdFor(runId);
    const workspacePath = path.resolve(config.workspaceStorage.workspaceRoot, workspaceId);
    const start = events[0];
    if (start?.type !== "workflow.started" || start.payload.mode !== "unity-work-v3") {
      throw new HoneyBeeCoreError("run.not-resumable", "Run is not a Unity v0.6 Work.");
    }

    const agentStarted = lastEvent(events, "agent.started");
    if (
      agentStarted !== undefined &&
      lastEvent(events, "process.drain-completed") === undefined &&
      (agentStarted.payload.containment === "deferred-v1" ||
        lastEvent(events, "agent.exited") === undefined)
    ) {
      const identity = agentStarted.payload.processIdentity;
      if (identity === undefined)
        return {
          runId,
          status: "cleanup-pending",
          failure: { errorCode: "process.identity-failed" },
        };
      try {
        await this.#processes.drain(agentStarted.payload.pid, identity, "unsafe");
        await writer.emit(
          "process.drain-completed",
          { process: "agent", startedEventId: agentStarted.eventId },
          UNITY_STEP_ID,
        );
      } catch (error) {
        return { runId, status: "cleanup-pending", failure: failureMetadata(error) };
      }
    }

    const acquireStart = lastEvent(events, "workspace.acquire-started");
    const acquiredEvent = lastEvent(events, "workspace.acquired");
    let workspaceLeaseId = acquiredEvent?.payload.leaseId;
    if (
      acquireStart !== undefined &&
      workspaceLeaseId === undefined &&
      lastEvent(events, "workspace.acquire-failed") === undefined
    ) {
      try {
        const request = JSON.parse(
          await this.artifacts.get({ runId, artifact: acquireStart.payload.request }),
        ) as Parameters<UnityWorkspaceStorageCliAdapter["acquire"]>[0];
        const receiptValue = await this.storage.acquire(request, workspacePath);
        const receipt = await this.#storeJson(
          writer,
          runId,
          "workspace-acquire-receipt",
          receiptValue,
        );
        await writer.emit("workspace.acquired", {
          workspaceId,
          leaseId: receiptValue.lease.leaseId,
          receipt,
        });
        workspaceLeaseId = receiptValue.lease.leaseId;
      } catch (error) {
        return { runId, status: "cleanup-pending", failure: failureMetadata(error) };
      }
    }
    if (workspaceLeaseId === undefined) {
      const failure = { errorCode: "agent.interrupted" } as const;
      await this.bootstrap
        .cleanupUnacquired(config.workspaceStorage.workspaceRoot, workspaceId)
        .catch(() => undefined);
      await writer.emit("workflow.failed", { failure });
      return { runId, status: "failed", failure };
    }

    const poolRequested = lastEvent(events, "editor.pool-requested");
    const poolQueued = lastEvent(events, "editor.pool-queued");
    const poolAcquired = lastEvent(events, "editor.pool-acquired");
    let poolLease = this.#poolLeaseFrom(events);
    if (poolRequested !== undefined && lastEvent(events, "editor.pool-released") === undefined) {
      const locator: UnityEditorPoolLocator = {
        poolId: poolRequested.payload.poolId,
        requestId: poolRequested.payload.requestId,
      };
      const status = await execution.pool.status(locator);
      if (status.state === "active" || status.state === "released") {
        poolLease = status.lease;
        if (poolAcquired === undefined) {
          if (poolQueued === undefined) {
            await writer.emit("editor.pool-queued", {
              ...poolRequestPayload(status.lease),
              ticket: status.lease.ticket,
            });
          }
          await writer.emit("editor.pool-acquired", poolLeasePayload(status.lease));
        }
      } else if (status.state === "queued") {
        await execution.pool.cancel(locator);
        await writer.emit("editor.pool-cancelled", poolRequested.payload);
      } else if (status.state === "cancelled") {
        await writer.emit("editor.pool-cancelled", poolRequested.payload);
      } else if (status.state === "missing" && poolQueued === undefined) {
        const startEvent = events[0];
        if (
          startEvent?.type !== "workflow.started" ||
          startEvent.payload.mode !== "unity-work-v3"
        ) {
          throw new HoneyBeeCoreError("run.indeterminate", "Unity Work linkage is missing.");
        }
        await execution.pool.enqueue({
          poolId: poolRequested.payload.poolId,
          requestId: poolRequested.payload.requestId,
          ownerRunId: runId,
          ownerWorkId: startEvent.payload.linkage.workId,
          priority: poolRequested.payload.priority,
        });
        await execution.pool.cancel(locator);
        await writer.emit("editor.pool-cancelled", poolRequested.payload);
      } else if (status.state === "missing") {
        throw new HoneyBeeCoreError(
          "run.indeterminate",
          "Durable Editor queue state is missing from the coordinator.",
        );
      }
    }

    const intentEvent = lastEvent(events, "editor.launch-intended");
    const containmentEvent = lastEvent(events, "editor.containment-registered");
    let containment: EditorContainmentReceiptV1 | undefined;
    let containmentArtifact = containmentEvent?.payload.receipt;
    let intent: EditorLaunchIntentV1 | undefined;
    if (intentEvent !== undefined) {
      intent = EditorLaunchIntentV1Schema.parse(
        JSON.parse(
          await this.artifacts.get({ runId, artifact: intentEvent.payload.intent }),
        ) as unknown,
      );
      if (containmentEvent === undefined) {
        containment = await this.launcher.recoverPublishedReceipt(intent);
        if (containment !== undefined) {
          containmentArtifact = await this.#storeJson(
            writer,
            runId,
            "editor-containment-receipt",
            containment,
          );
          await writer.emit("editor.containment-registered", {
            launchId: containment.launchId,
            pid: containment.containmentPid,
            processIdentity: containment.processIdentity,
            receipt: containmentArtifact,
          });
        } else {
          await writer.emit("editor.launch-abandoned", { launchId: intent.launchId });
        }
      } else {
        containment = EditorContainmentReceiptV1Schema.parse(
          JSON.parse(
            await this.artifacts.get({ runId, artifact: containmentEvent.payload.receipt }),
          ) as unknown,
        );
      }
    }

    const ownershipEvent = lastEvent(events, "editor.ownership-established");
    let ownership: ReturnType<typeof EditorOwnershipReceiptV1Schema.parse> | undefined;
    if (ownershipEvent !== undefined) {
      ownership = EditorOwnershipReceiptV1Schema.parse(
        JSON.parse(
          await this.artifacts.get({ runId, artifact: ownershipEvent.payload.receipt }),
        ) as unknown,
      );
    }

    const activeCapability = [...events]
      .reverse()
      .find(
        (event) =>
          event.type === "capability.started" ||
          event.type === "capability.completed" ||
          event.type === "capability.failed",
      );
    if (activeCapability?.type === "capability.started") {
      const processStarted = [...events]
        .reverse()
        .find(
          (event): event is Extract<OrchestrationEventV5, { type: "capability.process-started" }> =>
            event.type === "capability.process-started" &&
            event.payload.capabilityId === activeCapability.payload.capabilityId &&
            event.payload.index === activeCapability.payload.index &&
            event.payload.kind === activeCapability.payload.kind,
        );
      if (processStarted !== undefined) {
        const processDrained = [...events]
          .reverse()
          .find(
            (event) =>
              event.type === "capability.process-drained" &&
              event.payload.capabilityId === activeCapability.payload.capabilityId &&
              event.payload.index === activeCapability.payload.index &&
              event.payload.kind === activeCapability.payload.kind &&
              event.payload.startedEventId === processStarted.eventId,
          );
        const processExited = [...events]
          .reverse()
          .find(
            (event) =>
              event.type === "capability.process-exited" &&
              event.payload.capabilityId === activeCapability.payload.capabilityId &&
              event.payload.index === activeCapability.payload.index &&
              event.payload.kind === activeCapability.payload.kind,
          );
        const processNeedsDrain =
          processDrained === undefined &&
          (processStarted.payload.containment === "deferred-v1" || processExited === undefined);
        if (processNeedsDrain) {
          if (processStarted.payload.processIdentity === undefined)
            return {
              runId,
              status: "cleanup-pending",
              failure: { errorCode: "process.identity-failed" },
            };
          try {
            await this.#processes.drain(
              processStarted.payload.pid,
              processStarted.payload.processIdentity,
              "unsafe",
            );
            await writer.emit("capability.process-drained", {
              ...activeCapability.payload,
              startedEventId: processStarted.eventId,
            });
          } catch (error) {
            return {
              runId,
              status: "cleanup-pending",
              failure: failureMetadata(error),
            };
          }
        }
      }
      await writer.emit("capability.failed", {
        ...activeCapability.payload,
        failure: { errorCode: "agent.interrupted" },
      });
    }

    let recoveredEditorExited = lastEvent(events, "editor.exited") !== undefined;
    if (
      containment !== undefined &&
      containmentArtifact !== undefined &&
      lastEvent(events, "editor.containment-drained") === undefined
    ) {
      try {
        if (ownership !== undefined && lastEvent(events, "editor.stop-started") === undefined) {
          await writer.emit("editor.stop-started", {
            editorId: ownership.editorId,
            launchId: ownership.launchId,
          });
        }
        await this.launcher.drainContainment(containment, config.editorPool.shutdownTimeoutMs);
        if (ownership !== undefined && lastEvent(events, "editor.exited") === undefined) {
          await writer.emit("editor.exited", {
            editorId: ownership.editorId,
            launchId: ownership.launchId,
            pid: ownership.editorPid,
            processIdentity: ownership.editorProcessIdentity,
          });
          recoveredEditorExited = true;
        }
        if (ownership !== undefined && recoveredEditorExited)
          await this.registry.recordExited(ownership.editorId);
        await writer.emit("editor.containment-drained", {
          launchId: containment.launchId,
          receipt: containmentArtifact,
        });
      } catch (error) {
        return { runId, status: "cleanup-pending", failure: failureMetadata(error) };
      }
    }
    if (
      ownership !== undefined &&
      recoveredEditorExited &&
      lastEvent(events, "editor.containment-drained") !== undefined
    ) {
      try {
        await this.registry.recordExited(ownership.editorId);
      } catch (error) {
        return { runId, status: "cleanup-pending", failure: failureMetadata(error) };
      }
    }

    if (poolLease !== undefined && lastEvent(events, "editor.pool-released") === undefined) {
      try {
        const releaseStarted = lastEvent(events, "editor.pool-release-started");
        const releaseFailed = lastEvent(events, "editor.pool-release-failed");
        if (
          releaseStarted !== undefined &&
          (releaseFailed === undefined || releaseFailed.sequence < releaseStarted.sequence)
        ) {
          await execution.pool.release(poolLease);
          await writer.emit("editor.pool-released", poolLeasePayload(poolLease));
        } else {
          await this.#releasePool(execution.pool, poolLease, writer);
        }
      } catch (error) {
        return { runId, status: "cleanup-pending", failure: failureMetadata(error) };
      }
    }

    let sourceAfter = lastEvent(events, "source.checked")?.payload.after;
    const sourceBefore = lastEvent(events, "source.baselined")?.payload.manifest;
    if (sourceBefore === undefined)
      throw new HoneyBeeCoreError("run.indeterminate", "Unity source baseline is missing.");
    if (sourceAfter === undefined) {
      const beforeValue = JSON.parse(
        await this.artifacts.get({ runId, artifact: sourceBefore }),
      ) as SourceManifest;
      let afterValue: SourceManifest;
      try {
        afterValue = await this.bootstrap.manifest(config.sourceProjectPath);
      } catch {
        afterValue = beforeValue;
      }
      sourceAfter = await this.#storeJson(writer, runId, "unity-source-manifest", afterValue);
      await writer.emit("source.checked", {
        before: sourceBefore,
        after: sourceAfter,
        unchanged: sameManifest(beforeValue, afterValue),
      });
    }
    const previousDecision = lastEvent(events, "transaction.outcome-decided")?.payload;
    const decision: Decision = previousDecision ?? {
      outcome: "failed",
      failure: { errorCode: "agent.interrupted" },
    };
    if (previousDecision === undefined) await writer.emit("transaction.outcome-decided", decision);
    const recoveredEvidence = lastEvent(events, "capability.completed")?.payload.evidence;
    const recoveredPatch = lastEvent(events, "patch.verified")?.payload;
    const recoveredRelease = lastEvent(events, "workspace.released")?.payload.receipt;
    return this.#releaseAndFinish({
      runId,
      config,
      writer,
      workspaceId,
      leaseId: workspaceLeaseId,
      decision,
      sourceBefore,
      sourceAfter,
      ...(recoveredEvidence === undefined ? {} : { lastEvidence: recoveredEvidence }),
      ...(recoveredPatch === undefined
        ? {}
        : {
            patch: recoveredPatch.patch,
            resultManifest: recoveredPatch.resultManifest,
          }),
      ...(recoveredRelease === undefined ? {} : { release: recoveredRelease }),
      ...(lastEvent(events, "workspace.release-started") !== undefined &&
      recoveredRelease === undefined &&
      lastEvent(events, "workspace.release-failed") === undefined
        ? { releaseAlreadyStarted: true }
        : {}),
    });
  }

  #poolLeaseFrom(events: readonly OrchestrationEventV5[]): UnityEditorPoolLease | undefined {
    const start = events[0];
    const acquired = lastEvent(events, "editor.pool-acquired");
    if (
      start?.type !== "workflow.started" ||
      start.payload.mode !== "unity-work-v3" ||
      acquired === undefined
    )
      return undefined;
    return {
      ...acquired.payload,
      ownerRunId: start.runId,
      ownerWorkId: start.payload.linkage.workId,
    };
  }

  async #releaseAndFinish(
    input: Readonly<{
      runId: RunId;
      config: UnityWorkConfigV2;
      writer: V5Writer;
      workspaceId: string;
      leaseId: string;
      decision: Decision;
      sourceBefore: ArtifactRef;
      sourceAfter: ArtifactRef;
      agentOutput?: ArtifactRef;
      lastEvidence?: ArtifactRef;
      patch?: ArtifactRef;
      resultManifest?: ArtifactRef;
      release?: ArtifactRef;
      releaseAlreadyStarted?: boolean;
    }>,
  ): Promise<UnityWorkRunResult> {
    const requestId = releaseRequestIdFor(input.runId);
    let release = input.release;
    try {
      if (release === undefined) {
        if (input.releaseAlreadyStarted !== true) {
          await input.writer.emit("workspace.release-started", {
            leaseId: input.leaseId,
            requestId,
          });
        }
        const response = await this.storage.release(
          input.leaseId,
          requestId,
          input.config.workspaceStorage.workspaceRoot,
        );
        await this.bootstrap.verifyReleased(
          input.config.workspaceStorage.workspaceRoot,
          input.workspaceId,
        );
        release = await this.#storeJson(input.writer, input.runId, "workspace-release-receipt", {
          response,
          workspaceAbsent: true,
        });
        await input.writer.emit("workspace.released", {
          leaseId: input.leaseId,
          receipt: release,
          cleanupState: "released",
        });
      } else {
        await this.artifacts.get({ runId: input.runId, artifact: release });
      }
      if (input.decision.outcome === "completed") {
        if (
          input.lastEvidence === undefined ||
          input.patch === undefined ||
          input.resultManifest === undefined
        ) {
          throw new HoneyBeeCoreError(
            "run.indeterminate",
            "Completed Unity Work is missing durable output Artifacts.",
          );
        }
        await input.writer.emit("workflow.completed", {
          evidence: input.lastEvidence,
          patch: input.patch,
          resultManifest: input.resultManifest,
          release,
          sourceAfter: input.sourceAfter,
        });
        return {
          runId: input.runId,
          status: "completed",
          sourceBefore: input.sourceBefore,
          sourceAfter: input.sourceAfter,
          ...(input.agentOutput === undefined ? {} : { agentOutput: input.agentOutput }),
          evidence: input.lastEvidence,
          patch: input.patch,
          resultManifest: input.resultManifest,
          release,
        };
      }
      if (input.decision.outcome === "cancelled") {
        await input.writer.emit("workflow.cancelled", { release, sourceAfter: input.sourceAfter });
        return {
          runId: input.runId,
          status: "cancelled",
          sourceBefore: input.sourceBefore,
          sourceAfter: input.sourceAfter,
          ...(input.agentOutput === undefined ? {} : { agentOutput: input.agentOutput }),
          release,
        };
      }
      await input.writer.emit("workflow.failed", {
        failure: input.decision.failure,
        release,
        sourceAfter: input.sourceAfter,
      });
      return {
        runId: input.runId,
        status: "failed",
        sourceBefore: input.sourceBefore,
        sourceAfter: input.sourceAfter,
        ...(input.agentOutput === undefined ? {} : { agentOutput: input.agentOutput }),
        ...(input.lastEvidence === undefined ? {} : { evidence: input.lastEvidence }),
        release,
        failure: input.decision.failure,
      };
    } catch (error) {
      const failure = failureMetadata(error);
      if (release === undefined) {
        await input.writer
          .emit("workspace.release-failed", { leaseId: input.leaseId, failure })
          .catch(() => undefined);
      }
      return {
        runId: input.runId,
        status: "cleanup-pending",
        sourceBefore: input.sourceBefore,
        sourceAfter: input.sourceAfter,
        ...(input.agentOutput === undefined ? {} : { agentOutput: input.agentOutput }),
        ...(input.lastEvidence === undefined ? {} : { evidence: input.lastEvidence }),
        ...(input.patch === undefined ? {} : { patch: input.patch }),
        ...(input.resultManifest === undefined ? {} : { resultManifest: input.resultManifest }),
        failure,
      };
    }
  }

  #watchCancellation(
    runId: RunId,
    writer: V5Writer,
    aborter: AbortController,
  ): CancellationWatcher {
    let stopped = false;
    let watcherError: unknown;
    const task = (async () => {
      while (!stopped && !aborter.signal.aborted) {
        try {
          if (await this.#acceptPendingCancel(runId, writer)) {
            aborter.abort();
            return;
          }
        } catch (error) {
          watcherError = error;
          aborter.abort();
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    })();
    return {
      stop: async () => {
        stopped = true;
        await task;
      },
      error: () => watcherError,
    };
  }

  async #acceptPendingCancel(runId: RunId, writer: V5Writer): Promise<boolean> {
    const pending = await this.controls.pending(runId);
    const request = pending.find((candidate) => candidate.action === "cancel");
    if (request === undefined) return false;
    await writer.emit("control.accepted", { requestId: request.requestId, action: "cancel" });
    await this.controls.acknowledge(request);
    return true;
  }

  #acquireRequest(runId: RunId, config: UnityWorkConfigV2, workspaceId: string) {
    return {
      schemaVersion: 1 as const,
      requestId: acquireRequestIdFor(runId),
      consumerId: runId,
      workspaceId,
      parentKey: config.workspaceStorage.parentKey,
      clientPid: process.pid,
      ...(config.workspaceStorage.storeMaxAllocatedBytes === undefined
        ? {}
        : { storeMaxAllocatedBytes: config.workspaceStorage.storeMaxAllocatedBytes }),
      ...(config.workspaceStorage.minimumHostFreeBytes === undefined
        ? {}
        : { minimumHostFreeBytes: config.workspaceStorage.minimumHostFreeBytes }),
    };
  }

  async #storeJson(
    writer: V5Writer,
    runId: RunId,
    kind: ArtifactKind,
    value: unknown,
  ): Promise<ArtifactRef> {
    const artifact = await this.#put(
      runId,
      kind,
      kind === "unity-verified-patch"
        ? "application/vnd.honeybee.unity-patch+json"
        : "application/json",
      JSON.stringify(value),
    );
    await writer.emit("artifact.stored", { artifact });
    return artifact;
  }

  async #storeBytes(
    writer: V5Writer,
    runId: RunId,
    kind: ArtifactKind,
    mediaType: ArtifactMediaType,
    content: Uint8Array,
  ): Promise<ArtifactRef> {
    const artifact = await this.artifacts.putBytes({
      runId,
      artifactId: ArtifactIdSchema.parse(this.#randomId()),
      kind,
      mediaType,
      content,
    });
    await writer.emit("artifact.stored", { artifact });
    return artifact;
  }

  #put(
    runId: RunId,
    kind: ArtifactKind,
    mediaType: ArtifactMediaType,
    content: string,
  ): Promise<ArtifactRef> {
    return this.artifacts.put({
      runId,
      artifactId: ArtifactIdSchema.parse(this.#randomId()),
      kind,
      mediaType,
      content,
    });
  }

  #resultFrom(events: readonly OrchestrationEventV5[]): UnityWorkRunResult {
    const start = events[0];
    if (start?.type !== "workflow.started" || start.payload.mode !== "unity-work-v3") {
      throw new HoneyBeeCoreError("run.indeterminate", "Unity v0.6 start event is invalid.");
    }
    const terminal = events.at(-1);
    const sourceBefore = lastEvent(events, "source.baselined")?.payload.manifest;
    const agentOutput = [...events]
      .reverse()
      .find(
        (event) =>
          event.type === "artifact.stored" && event.payload.artifact.kind === "step-output",
      );
    if (terminal?.type === "workflow.completed" && "patch" in terminal.payload) {
      return {
        runId: start.runId,
        status: "completed",
        ...(sourceBefore === undefined ? {} : { sourceBefore }),
        sourceAfter: terminal.payload.sourceAfter,
        ...(agentOutput?.type === "artifact.stored"
          ? { agentOutput: agentOutput.payload.artifact }
          : {}),
        evidence: terminal.payload.evidence,
        patch: terminal.payload.patch,
        resultManifest: terminal.payload.resultManifest,
        release: terminal.payload.release,
      };
    }
    if (terminal?.type === "workflow.cancelled" && !("summary" in terminal.payload)) {
      return {
        runId: start.runId,
        status: "cancelled",
        ...(sourceBefore === undefined ? {} : { sourceBefore }),
        ...(terminal.payload.sourceAfter === undefined
          ? {}
          : { sourceAfter: terminal.payload.sourceAfter }),
        ...(terminal.payload.release === undefined ? {} : { release: terminal.payload.release }),
      };
    }
    if (terminal?.type === "workflow.failed" && !("summary" in terminal.payload)) {
      return {
        runId: start.runId,
        status: "failed",
        ...(sourceBefore === undefined ? {} : { sourceBefore }),
        ...(terminal.payload.sourceAfter === undefined
          ? {}
          : { sourceAfter: terminal.payload.sourceAfter }),
        ...(terminal.payload.release === undefined ? {} : { release: terminal.payload.release }),
        failure: terminal.payload.failure,
      };
    }
    throw new HoneyBeeCoreError("run.indeterminate", "Unity v0.6 terminal event is invalid.");
  }
}
