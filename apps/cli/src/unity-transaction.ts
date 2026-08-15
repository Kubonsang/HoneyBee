import { randomUUID } from "node:crypto";
import path from "node:path";

import {
  AgentIdSchema,
  AgentInputEnvelopeV2Schema,
  AgentWorkflowStepV3Schema,
  ArtifactIdSchema,
  EventIdSchema,
  HarnessIdSchema,
  HoneyBeeCoreError,
  OrchestrationEventV3Schema,
  OrchestrationEventV4Schema,
  PortNameSchema,
  RunIdSchema,
  StepIdSchema,
  createDagAgentPrompt,
  parseDagAgentResponse,
  type AgentProcessResult,
  type AgentProcessRunner,
  type ArtifactKind,
  type ArtifactMediaType,
  type ArtifactRef,
  type ArtifactStore,
  type EventId,
  type FailureMetadata,
  type OrchestrationEventV3,
  type OrchestrationEventV4,
  type ResourceId,
  type RunControlPort,
  type RunId,
  type StepId,
  type UnityWorkConfigV1,
  type VersionedOrchestrationJournal,
} from "@honeybee/core";

import type {
  TestPlayCliAdapter,
  UnityProjectBootstrap,
  UnityWorkspaceStorageCliAdapter,
  SourceManifest,
  TestPlayEvidenceFile,
  TestPlayRunResult,
  WorkspaceAcquireRequest,
  WorkspaceAcquireReceipt,
} from "./unity-adapters.js";
import { SystemUnityProcessControl, type UnityProcessControl } from "./process-control.js";
import type { UnityPatchBuilder } from "./unity-patch.js";
import type { UnityResourceCoordinator, UnityResourceLease } from "./unity-resource-control.js";

const UNITY_STEP_ID = StepIdSchema.parse("unity-agent");
const UNITY_AGENT_ID = AgentIdSchema.parse("unity-agent");
const UNITY_HARNESS_ID = HarnessIdSchema.parse("stdio");
const CONTENT_PORT = PortNameSchema.parse("content");

type TransactionDecision =
  | Readonly<{ outcome: "completed" }>
  | Readonly<{ outcome: "failed"; failure: FailureMetadata }>
  | Readonly<{ outcome: "cancelled" }>;

export interface UnityWorkRunResult {
  readonly runId: RunId;
  readonly status: "completed" | "failed" | "cancelled" | "cleanup-pending";
  readonly sourceBefore?: ArtifactRef;
  readonly sourceAfter?: ArtifactRef;
  readonly agentOutput?: ArtifactRef;
  readonly evidence?: ArtifactRef;
  readonly release?: ArtifactRef;
  readonly patch?: ArtifactRef;
  readonly resultManifest?: ArtifactRef;
  readonly failure?: FailureMetadata;
}

export interface UnityWorkV4Execution {
  readonly parentRunId: RunId;
  readonly workId: StepId;
  readonly resourceId: ResourceId;
  readonly resourceScope: "batch-local-v1" | "global-file-v1";
  readonly resources: UnityResourceCoordinator;
  readonly patchBuilder: UnityPatchBuilder;
}

type UnityEvent = OrchestrationEventV3 | OrchestrationEventV4;

class UnityEventWriter {
  #sequence: number;
  #tail: Promise<void> = Promise.resolve();

  public constructor(
    private readonly journal: VersionedOrchestrationJournal,
    private readonly runId: RunId,
    initialSequence: number,
    private readonly now: () => Date,
    private readonly randomId: () => string,
    public readonly schemaVersion: 3 | 4,
  ) {
    this.#sequence = initialSequence;
  }

  public emit(type: UnityEvent["type"], payload: unknown, stepId?: StepId): Promise<void> {
    return this.emitEvent(type, payload, stepId).then(() => undefined);
  }

  public emitEvent(
    type: UnityEvent["type"],
    payload: unknown,
    stepId?: StepId,
  ): Promise<UnityEvent> {
    const operation = this.#tail.then(async () => {
      const value = {
        schemaVersion: this.schemaVersion,
        eventId: EventIdSchema.parse(this.randomId()),
        runId: this.runId,
        sequence: ++this.#sequence,
        timestamp: this.now().toISOString(),
        type,
        ...(stepId === undefined ? {} : { stepId }),
        payload,
      };
      const event =
        this.schemaVersion === 3
          ? OrchestrationEventV3Schema.parse(value)
          : OrchestrationEventV4Schema.parse(value);
      await this.journal.append(this.runId, event);
      return event;
    });
    this.#tail = operation.then(() => undefined);
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

const observationDetails = (
  value: Readonly<{
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    durationMs: number;
    stdoutBytes: number;
    stderrBytes: number;
  }>,
): Readonly<Record<string, unknown>> => ({
  exitCode: value.exitCode,
  signal: value.signal,
  durationMs: value.durationMs,
  stdoutBytes: value.stdoutBytes,
  stderrBytes: value.stderrBytes,
});

const sameManifest = (before: SourceManifest, after: SourceManifest): boolean =>
  before.digest === after.digest &&
  before.assetsDigest === after.assetsDigest &&
  before.packagesDigest === after.packagesDigest &&
  before.projectSettingsDigest === after.projectSettingsDigest &&
  before.fileCount === after.fileCount &&
  before.logicalBytes === after.logicalBytes;

const workspaceIdFor = (runId: RunId): string => "hb-" + runId;
const acquireRequestIdFor = (runId: RunId): string => "hb-" + runId + "-acquire";
const releaseRequestIdFor = (runId: RunId): string => "hb-" + runId + "-release";

const lastEvent = <Type extends UnityEvent["type"]>(
  events: readonly UnityEvent[],
  type: Type,
): Extract<UnityEvent, { type: Type }> | undefined => {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === type) {
      return event as Extract<UnityEvent, { type: Type }>;
    }
  }
  return undefined;
};

export class UnityWorkTransaction {
  readonly #now: () => Date;
  readonly #randomId: () => string;
  readonly #processControl: UnityProcessControl;

  public constructor(
    private readonly runner: AgentProcessRunner,
    private readonly artifacts: ArtifactStore,
    private readonly journal: VersionedOrchestrationJournal,
    private readonly controls: RunControlPort,
    private readonly bootstrap: UnityProjectBootstrap,
    private readonly storage: UnityWorkspaceStorageCliAdapter,
    private readonly testplay: TestPlayCliAdapter,
    options: Readonly<{
      now?: () => Date;
      randomId?: () => string;
      processControl?: UnityProcessControl;
    }> = {},
  ) {
    this.#now = options.now ?? (() => new Date());
    this.#randomId = options.randomId ?? randomUUID;
    this.#processControl = options.processControl ?? new SystemUnityProcessControl();
  }

  public async run(
    runIdValue: RunId,
    taskValue: string,
    config: UnityWorkConfigV1,
    execution?: UnityWorkV4Execution,
  ): Promise<UnityWorkRunResult> {
    const runId = RunIdSchema.parse(runIdValue);
    const task = taskValue.trim();
    if (task.length === 0) {
      throw new HoneyBeeCoreError("validation.invalid-task", "The task cannot be empty.");
    }
    const configArtifact = await this.#put(
      runId,
      "workflow-config",
      "application/json",
      JSON.stringify(config),
    );
    const taskArtifact = await this.#put(runId, "task", "text/plain; charset=utf-8", task);
    const schemaVersion = execution === undefined ? 3 : 4;
    const writer = new UnityEventWriter(
      this.journal,
      runId,
      0,
      this.#now,
      this.#randomId,
      schemaVersion,
    );
    await writer.emit(
      "workflow.started",
      execution === undefined
        ? { mode: "unity-work-v1", config: configArtifact, task: taskArtifact }
        : {
            mode: "unity-work-v2",
            config: configArtifact,
            task: taskArtifact,
            linkage: {
              parentRunId: execution.parentRunId,
              workId: execution.workId,
              resourceId: execution.resourceId,
              resourceScope: execution.resourceScope,
            },
          },
    );
    await writer.emit("artifact.stored", { artifact: configArtifact });
    await writer.emit("artifact.stored", { artifact: taskArtifact });
    return this.#runFresh(runId, config, taskArtifact, writer, execution);
  }

  public async resume(
    runIdValue: RunId,
    config: UnityWorkConfigV1,
    execution?: UnityWorkV4Execution,
  ): Promise<UnityWorkRunResult> {
    const runId = RunIdSchema.parse(runIdValue);
    const replay = await this.journal.replay(runId);
    if (replay.status === "indeterminate") {
      throw new HoneyBeeCoreError("run.indeterminate", replay.message);
    }
    const schemaVersion = replay.events[0]?.schemaVersion;
    if (schemaVersion !== 3 && schemaVersion !== 4) {
      throw new HoneyBeeCoreError("run.not-resumable", "Run is not a Unity work transaction.");
    }
    if (schemaVersion === 4 && execution === undefined) {
      throw new HoneyBeeCoreError(
        "run.not-resumable",
        "A schema v4 Unity child needs its batch context.",
      );
    }
    if (schemaVersion === 4) {
      const start = replay.events[0];
      if (
        start?.type !== "workflow.started" ||
        start.payload.mode !== "unity-work-v2" ||
        execution === undefined ||
        start.payload.linkage.parentRunId !== execution.parentRunId ||
        start.payload.linkage.workId !== execution.workId ||
        start.payload.linkage.resourceId !== execution.resourceId ||
        start.payload.linkage.resourceScope !== execution.resourceScope
      ) {
        throw new HoneyBeeCoreError(
          "run.indeterminate",
          "Unity child linkage does not match its batch execution context.",
        );
      }
    }
    const events = replay.events as readonly UnityEvent[];
    if (replay.status === "terminal") return this.#resultFrom(events);
    const writer = new UnityEventWriter(
      this.journal,
      runId,
      events.length,
      this.#now,
      this.#randomId,
      schemaVersion,
    );
    return this.#resumeCleanup(runId, config, events, writer, execution);
  }

  async #runFresh(
    runId: RunId,
    config: UnityWorkConfigV1,
    taskArtifact: ArtifactRef,
    writer: UnityEventWriter,
    execution?: UnityWorkV4Execution,
  ): Promise<UnityWorkRunResult> {
    const workspaceId = workspaceIdFor(runId);
    const workspacePath = path.resolve(config.workspaceStorage.workspaceRoot, workspaceId);
    let sourceBefore: ArtifactRef | undefined;
    let sourceBeforeValue: SourceManifest | undefined;
    let prepared = false;
    let acquireStarted = false;
    let acquired: WorkspaceAcquireReceipt | undefined;

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
      prepared = true;
      const preparedManifest = await this.bootstrap.manifest(workspacePath);
      if (!sameManifest(sourceBeforeValue, preparedManifest)) {
        throw new HoneyBeeCoreError(
          "workspace.invalid-project",
          "Prepared Unity workspace does not match the source snapshot.",
        );
      }
      await writer.emit("workspace.prepared", {
        workspaceId,
        sourceManifest: sourceBefore,
      });
      const acquireRequest = this.#acquireRequest(runId, config, workspaceId);
      const requestArtifact = await this.#storeJson(
        writer,
        runId,
        "workspace-acquire-request",
        acquireRequest,
      );
      await writer.emit("workspace.acquire-started", {
        request: requestArtifact,
        requestId: acquireRequest.requestId,
      });
      acquireStarted = true;
      acquired = await this.storage.acquire(acquireRequest, workspacePath);
      const acquireReceipt = await this.#storeJson(
        writer,
        runId,
        "workspace-acquire-receipt",
        acquired,
      );
      await writer.emit("workspace.acquired", {
        workspaceId,
        leaseId: acquired.lease.leaseId,
        receipt: acquireReceipt,
      });
    } catch (error) {
      const metadata = failureMetadata(error);
      if (acquired !== undefined) {
        return {
          runId,
          status: "cleanup-pending",
          ...(sourceBefore === undefined ? {} : { sourceBefore }),
          failure: metadata,
        };
      }
      if (
        acquireStarted &&
        (metadata.errorCode === "workspace.command-ambiguous" ||
          metadata.errorCode === "workspace.protocol-invalid")
      ) {
        return {
          runId,
          status: "cleanup-pending",
          ...(sourceBefore === undefined ? {} : { sourceBefore }),
          failure: metadata,
        };
      }
      if (acquireStarted) await writer.emit("workspace.acquire-failed", { failure: metadata });
      if (prepared) {
        await this.bootstrap.cleanupUnacquired(config.workspaceStorage.workspaceRoot, workspaceId);
      }
      await writer.emit("workflow.failed", { failure: metadata });
      return {
        runId,
        status: "failed",
        ...(sourceBefore === undefined ? {} : { sourceBefore }),
        failure: metadata,
      };
    }

    const aborter = new AbortController();
    if (await this.#acceptPendingCancel(runId, writer)) aborter.abort();
    const watcher = this.#watchCancellation(runId, writer, aborter);
    let decision: TransactionDecision;
    let unsafeProcessFailure: FailureMetadata | undefined;
    let agentOutput: ArtifactRef | undefined;
    let evidence: ArtifactRef | undefined;
    let resourceLease: UnityResourceLease | undefined;
    let patch: ArtifactRef | undefined;
    let resultManifest: ArtifactRef | undefined;
    try {
      if (aborter.signal.aborted) {
        throw new HoneyBeeCoreError(
          "agent.cancelled",
          "Unity transaction was cancelled before Agent execution.",
        );
      }
      agentOutput = await this.#runAgent(
        runId,
        config,
        taskArtifact,
        workspacePath,
        writer,
        aborter.signal,
      );
      if (aborter.signal.aborted) {
        throw new HoneyBeeCoreError(
          "agent.cancelled",
          "Unity transaction was cancelled before TestPlay.",
        );
      }
      if (execution !== undefined) {
        resourceLease = await this.#acquireResource(runId, execution, writer, aborter.signal);
      }
      const verification = await this.#runTestPlay(runId, workspacePath, writer, aborter.signal);
      evidence = verification.evidence;
      if (verification.failure !== undefined) throw verification.failure;
      decision = { outcome: "completed" };
    } catch (error) {
      const pollingError = watcher.error();
      const operationFailure = failureMetadata(error);
      if (operationFailure.errorCode === "process.drain-failed") {
        unsafeProcessFailure = operationFailure;
      }
      decision =
        pollingError !== undefined
          ? { outcome: "failed", failure: failureMetadata(pollingError) }
          : aborter.signal.aborted || operationFailure.errorCode === "agent.cancelled"
            ? { outcome: "cancelled" }
            : { outcome: "failed", failure: operationFailure };
    }

    if (unsafeProcessFailure !== undefined) {
      await watcher.stop();
      return {
        runId,
        status: "cleanup-pending",
        sourceBefore,
        ...(agentOutput === undefined ? {} : { agentOutput }),
        failure: unsafeProcessFailure,
      };
    }

    if (resourceLease !== undefined && execution !== undefined) {
      try {
        await this.#releaseResource(execution, resourceLease, writer);
      } catch (error) {
        await watcher.stop();
        return {
          runId,
          status: "cleanup-pending",
          sourceBefore,
          ...(agentOutput === undefined ? {} : { agentOutput }),
          ...(evidence === undefined ? {} : { evidence }),
          failure: failureMetadata(error),
        };
      }
    }

    let sourceAfter: ArtifactRef | undefined;
    try {
      const sourceCheck = await this.#checkSource(
        runId,
        config,
        sourceBeforeValue,
        sourceBefore,
        writer,
      );
      sourceAfter = sourceCheck.after;
      if (!sourceCheck.unchanged) {
        decision = { outcome: "failed", failure: { errorCode: "source.modified" } };
      }
      if (decision.outcome === "completed" && execution !== undefined) {
        const verified = await execution.patchBuilder.build({
          runId,
          sourceProjectPath: config.sourceProjectPath,
          workspacePath,
          baseManifest: sourceBefore,
          verifySource: async () => {
            const current = await this.bootstrap.manifest(config.sourceProjectPath);
            if (!sameManifest(sourceBeforeValue, current)) {
              throw new HoneyBeeCoreError("source.modified", "The original Unity project changed.");
            }
          },
          publishBytes: async (kind, mediaType, content) =>
            this.#storeBytes(writer, runId, kind, mediaType, content),
          publishJson: async (kind, value) => this.#storeJson(writer, runId, kind, value),
        });
        patch = verified.patch;
        resultManifest = verified.resultManifest;
        await writer.emit("patch.verified", {
          patch,
          baseManifest: sourceBefore,
          resultManifest,
        });
      }
    } catch (error) {
      decision = { outcome: "failed", failure: failureMetadata(error) };
    }
    await watcher.stop();
    if (aborter.signal.aborted && decision.outcome === "completed") {
      decision = { outcome: "cancelled" };
    }
    if (watcher.error() !== undefined && decision.outcome !== "failed") {
      decision = { outcome: "failed", failure: failureMetadata(watcher.error()) };
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
      ...(sourceAfter === undefined ? {} : { sourceAfter }),
      ...(agentOutput === undefined ? {} : { agentOutput }),
      ...(evidence === undefined ? {} : { evidence }),
      ...(patch === undefined ? {} : { patch }),
      ...(resultManifest === undefined ? {} : { resultManifest }),
    });
  }

  async #resumeCleanup(
    runId: RunId,
    config: UnityWorkConfigV1,
    events: readonly UnityEvent[],
    writer: UnityEventWriter,
    execution?: UnityWorkV4Execution,
  ): Promise<UnityWorkRunResult> {
    const workspaceId = workspaceIdFor(runId);
    const workspacePath = path.resolve(config.workspaceStorage.workspaceRoot, workspaceId);
    const baseline = events.find((event) => event.type === "source.baselined");
    const sourceBefore =
      baseline?.type === "source.baselined" ? baseline.payload.manifest : undefined;
    const acquiredEvent = lastEvent(events, "workspace.acquired");
    let leaseId = acquiredEvent?.payload.leaseId;

    if (acquiredEvent?.type !== "workspace.acquired") {
      const acquireFailure = lastEvent(events, "workspace.acquire-failed");
      if (acquireFailure !== undefined) {
        await this.bootstrap.cleanupUnacquired(config.workspaceStorage.workspaceRoot, workspaceId);
        await writer.emit("workflow.failed", {
          failure: acquireFailure.payload.failure,
        });
        return {
          runId,
          status: "failed",
          ...(sourceBefore === undefined ? {} : { sourceBefore }),
          failure: acquireFailure.payload.failure,
        };
      }
      const acquireStart = lastEvent(events, "workspace.acquire-started");
      if (acquireStart?.type !== "workspace.acquire-started") {
        // A process can die after mkdir/copy but before workspace.prepared is
        // durable. The run-derived path is safe to probe, and cleanup refuses
        // any shell that already has provider ownership markers.
        await this.bootstrap.cleanupUnacquired(config.workspaceStorage.workspaceRoot, workspaceId);
        const failure = { errorCode: "transaction.interrupted" };
        await writer.emit("workflow.failed", { failure });
        return {
          runId,
          status: "failed",
          ...(sourceBefore === undefined ? {} : { sourceBefore }),
          failure,
        };
      }
      const request = JSON.parse(
        await this.artifacts.get({ runId, artifact: acquireStart.payload.request }),
      ) as WorkspaceAcquireRequest;
      let receipt: WorkspaceAcquireReceipt;
      try {
        receipt = await this.storage.acquire(request, workspacePath);
      } catch (error) {
        const failure = failureMetadata(error);
        if (
          failure.errorCode === "workspace.command-ambiguous" ||
          failure.errorCode === "workspace.protocol-invalid"
        ) {
          return {
            runId,
            status: "cleanup-pending",
            ...(sourceBefore === undefined ? {} : { sourceBefore }),
            failure,
          };
        }
        await writer.emit("workspace.acquire-failed", { failure });
        await this.bootstrap.cleanupUnacquired(config.workspaceStorage.workspaceRoot, workspaceId);
        await writer.emit("workflow.failed", { failure });
        return {
          runId,
          status: "failed",
          ...(sourceBefore === undefined ? {} : { sourceBefore }),
          failure,
        };
      }
      const receiptArtifact = await this.#storeJson(
        writer,
        runId,
        "workspace-acquire-receipt",
        receipt,
      );
      await writer.emit("workspace.acquired", {
        workspaceId,
        leaseId: receipt.lease.leaseId,
        receipt: receiptArtifact,
      });
      leaseId = receipt.lease.leaseId;
    }

    try {
      await this.#drainInterruptedChildren(events, writer);
    } catch (error) {
      return {
        runId,
        status: "cleanup-pending",
        ...(sourceBefore === undefined ? {} : { sourceBefore }),
        failure: failureMetadata(error),
      };
    }
    if (execution !== undefined) {
      try {
        await this.#recoverResource(events, writer, execution);
      } catch (error) {
        return {
          runId,
          status: "cleanup-pending",
          ...(sourceBefore === undefined ? {} : { sourceBefore }),
          failure: failureMetadata(error),
        };
      }
    }

    const released = lastEvent(events, "workspace.released");
    const decisionEvent = lastEvent(events, "transaction.outcome-decided");
    let decision = decisionEvent?.payload as TransactionDecision | undefined;
    const sourceAfter = lastEvent(events, "source.checked");
    let after = sourceAfter?.payload.after;
    let sourceUnchanged = sourceAfter?.payload.unchanged;
    let recoveredEvidence: ArtifactRef | undefined;
    const verifiedPatch = lastEvent(events, "patch.verified");
    let patch = verifiedPatch?.type === "patch.verified" ? verifiedPatch.payload.patch : undefined;
    let resultManifest =
      verifiedPatch?.type === "patch.verified" ? verifiedPatch.payload.resultManifest : undefined;
    if (decision === undefined) {
      const exited = lastEvent(events, "testplay.exited");
      const storedEvidence = lastEvent(events, "testplay.evidence-stored");
      if (exited !== undefined && storedEvidence === undefined) {
        try {
          const recovered = await this.testplay.recoverEvidence(workspacePath);
          if (recovered.length > 0) {
            recoveredEvidence = await this.#storeRecoveredTestPlayEvidence(
              runId,
              writer,
              recovered,
              exited.payload,
            );
            await writer.emit("testplay.evidence-stored", {
              evidence: recoveredEvidence,
            });
          }
        } catch (error) {
          decision = { outcome: "failed", failure: failureMetadata(error) };
        }
      }
      if (sourceBefore !== undefined && sourceAfter === undefined) {
        try {
          const beforeValue = JSON.parse(
            await this.artifacts.get({ runId, artifact: sourceBefore }),
          ) as SourceManifest;
          const checked = await this.#checkSource(runId, config, beforeValue, sourceBefore, writer);
          after = checked.after;
          sourceUnchanged = checked.unchanged;
        } catch (error) {
          decision = { outcome: "failed", failure: failureMetadata(error) };
        }
      }
      if (decision === undefined) {
        const acceptedCancel = lastEvent(events, "control.accepted");
        if (sourceUnchanged === false) {
          decision = { outcome: "failed", failure: { errorCode: "source.modified" } };
        } else if (
          acceptedCancel !== undefined ||
          (await this.#acceptPendingCancel(runId, writer))
        ) {
          decision = { outcome: "cancelled" };
        } else if (
          execution !== undefined &&
          lastEvent(events, "testplay.verified") !== undefined
        ) {
          try {
            if (sourceBefore === undefined) {
              throw new HoneyBeeCoreError(
                "run.indeterminate",
                "Unity child has no source baseline.",
              );
            }
            if (patch === undefined || resultManifest === undefined) {
              const beforeValue = JSON.parse(
                await this.artifacts.get({ runId, artifact: sourceBefore }),
              ) as SourceManifest;
              const verified = await execution.patchBuilder.build({
                runId,
                sourceProjectPath: config.sourceProjectPath,
                workspacePath,
                baseManifest: sourceBefore,
                verifySource: async () => {
                  const current = await this.bootstrap.manifest(config.sourceProjectPath);
                  if (!sameManifest(beforeValue, current)) {
                    throw new HoneyBeeCoreError(
                      "source.modified",
                      "The original Unity project changed.",
                    );
                  }
                },
                publishBytes: async (kind, mediaType, content) =>
                  this.#storeBytes(writer, runId, kind, mediaType, content),
                publishJson: async (kind, value) => this.#storeJson(writer, runId, kind, value),
              });
              patch = verified.patch;
              resultManifest = verified.resultManifest;
              await writer.emit("patch.verified", {
                patch,
                baseManifest: sourceBefore,
                resultManifest,
              });
            }
            decision = { outcome: "completed" };
          } catch (error) {
            decision = { outcome: "failed", failure: failureMetadata(error) };
          }
        } else if (acceptedCancel === undefined) {
          decision = {
            outcome: "failed",
            failure: { errorCode: "transaction.interrupted" },
          };
        }
      }
      if (decision === undefined) {
        throw new HoneyBeeCoreError("run.indeterminate", "Unity transaction outcome is missing.");
      }
      await writer.emit("transaction.outcome-decided", decision);
    }
    if (decision === undefined) {
      throw new HoneyBeeCoreError("run.indeterminate", "Unity transaction outcome is missing.");
    }
    const evidenceEvent = lastEvent(events, "testplay.evidence-stored");
    const evidence =
      recoveredEvidence ??
      (evidenceEvent?.type === "testplay.evidence-stored"
        ? evidenceEvent.payload.evidence
        : undefined);
    if (released?.type === "workspace.released") {
      return this.#appendTerminal(
        runId,
        writer,
        decision,
        sourceBefore,
        after,
        evidence,
        released.payload.receipt,
        undefined,
        patch,
        resultManifest,
      );
    }
    if (leaseId === undefined) {
      throw new HoneyBeeCoreError(
        "run.indeterminate",
        "Unity transaction has no acquired lease identity.",
      );
    }
    const eventTypes = events.map((event) => event.type);
    const lastReleaseStarted = eventTypes.lastIndexOf("workspace.release-started");
    const lastReleaseFailed = eventTypes.lastIndexOf("workspace.release-failed");
    return this.#releaseAndFinish({
      runId,
      config,
      writer,
      workspaceId,
      leaseId,
      decision,
      releaseAlreadyStarted: lastReleaseStarted > lastReleaseFailed,
      ...(sourceBefore === undefined ? {} : { sourceBefore }),
      ...(after === undefined ? {} : { sourceAfter: after }),
      ...(evidence === undefined ? {} : { evidence }),
      ...(patch === undefined ? {} : { patch }),
      ...(resultManifest === undefined ? {} : { resultManifest }),
    });
  }

  async #runAgent(
    runId: RunId,
    config: UnityWorkConfigV1,
    taskArtifact: ArtifactRef,
    workspacePath: string,
    writer: UnityEventWriter,
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
    let result: AgentProcessResult;
    let startedEventId: EventId | undefined;
    let deferred = false;
    try {
      result = await this.runner.run(
        {
          runId,
          stepId: UNITY_STEP_ID,
          prompt:
            "Work only inside the isolated Unity project in your current working directory. " +
            "Do not access or modify the original project. Validate changes through the declared output contract.\n\n" +
            createDagAgentPrompt(JSON.stringify(envelope)),
          command: {
            ...config.agent.command,
            cwd: workspacePath,
            env: {
              ...config.agent.command.env,
              HONEYBEE_UNITY_PROJECT_PATH: workspacePath,
            },
          },
          timeoutMs: config.agent.timeoutMs ?? 600_000,
          maxOutputBytes: config.agent.maxOutputBytes ?? 1024 * 1024,
          signal,
        },
        {
          onStarted: async (pid, metadata) => {
            deferred = metadata?.containment === "deferred-v1";
            startedEventId = await this.#emitProcessStarted(
              writer,
              "agent.started",
              pid,
              metadata?.containment,
              UNITY_STEP_ID,
            );
          },
          onRegistered: () =>
            this.#emitContainmentRegistered(writer, "agent", startedEventId, UNITY_STEP_ID),
          onExited: (observation) => writer.emit("agent.exited", observation, UNITY_STEP_ID),
        },
      );
    } catch (error) {
      if (error instanceof HoneyBeeCoreError && error.code === "agent.input-write-failed") {
        await writer.emit("agent.input-write-failed", failureMetadata(error), UNITY_STEP_ID);
      }
      throw error;
    }
    if (deferred) {
      await this.#emitProcessDrainCompleted(writer, "agent", startedEventId, UNITY_STEP_ID);
    }
    if (result.termination !== "exited") {
      const code =
        result.termination === "cancelled"
          ? "agent.cancelled"
          : result.termination === "timed-out"
            ? "agent.timed-out"
            : "agent.output-limit";
      throw new HoneyBeeCoreError(
        code,
        "Unity Agent did not exit normally.",
        UNITY_STEP_ID,
        observationDetails(result),
      );
    }
    if (result.exitCode !== 0) {
      throw new HoneyBeeCoreError(
        "agent.non-zero-exit",
        "Unity Agent returned a non-zero exit code.",
        UNITY_STEP_ID,
        observationDetails(result),
      );
    }
    const response = parseDagAgentResponse(result.stdout, runId, step);
    if (response.status !== "completed") {
      throw new HoneyBeeCoreError(
        "workflow.step-failed",
        "Unity Agent did not produce a completed semantic outcome.",
        UNITY_STEP_ID,
      );
    }
    const outputValue = response.outputs[CONTENT_PORT];
    if (outputValue === undefined) {
      throw new HoneyBeeCoreError(
        "protocol.invalid-agent-response",
        "Unity Agent omitted its content output.",
        UNITY_STEP_ID,
      );
    }
    const output = await this.#put(
      runId,
      "step-output",
      outputValue.mediaType,
      outputValue.content,
    );
    await writer.emit("artifact.stored", { artifact: output }, UNITY_STEP_ID);
    return output;
  }

  async #runTestPlay(
    runId: RunId,
    workspacePath: string,
    writer: UnityEventWriter,
    signal: AbortSignal,
  ): Promise<{ evidence: ArtifactRef; failure?: HoneyBeeCoreError }> {
    let startedEventId: EventId | undefined;
    let deferred = false;
    const result = await this.testplay.run(runId, workspacePath, signal, {
      onStarted: async (pid, metadata) => {
        deferred = metadata?.containment === "deferred-v1";
        startedEventId = await this.#emitProcessStarted(
          writer,
          "testplay.started",
          pid,
          metadata?.containment,
        );
      },
      onRegistered: () => this.#emitContainmentRegistered(writer, "testplay", startedEventId),
      onExited: (observation) => writer.emit("testplay.exited", observation),
    });
    if (deferred) {
      await this.#emitProcessDrainCompleted(writer, "testplay", startedEventId);
    }
    const evidence = await this.#storeTestPlayEvidence(runId, writer, result);
    await writer.emit("testplay.evidence-stored", { evidence });
    const required = new Set([
      "results.xml",
      "summary.json",
      "manifest.json",
      "stdout.log",
      "stderr.log",
      "events.ndjson",
    ]);
    for (const file of result.evidence) required.delete(file.name);
    const response = result.response;
    const validResponse =
      typeof response === "object" &&
      response !== null &&
      !Array.isArray(response) &&
      (response as Record<string, unknown>).schema_version === "1" &&
      typeof (response as Record<string, unknown>).run_id === "string" &&
      Number.isInteger((response as Record<string, unknown>).total) &&
      ((response as Record<string, unknown>).total as number) > 0;
    if (
      result.command.termination !== "exited" ||
      result.command.exitCode !== 0 ||
      !validResponse ||
      required.size > 0
    ) {
      return {
        evidence,
        failure: new HoneyBeeCoreError(
          "testplay.failed",
          "TestPlay did not complete with the required Evidence.",
          undefined,
          observationDetails(result.command),
        ),
      };
    }
    await writer.emit("testplay.verified", { evidence });
    return { evidence };
  }

  async #storeTestPlayEvidence(
    runId: RunId,
    writer: UnityEventWriter,
    result: TestPlayRunResult,
  ): Promise<ArtifactRef> {
    const commandOutput = await this.#put(
      runId,
      "testplay-evidence",
      result.response === undefined ? "text/plain; charset=utf-8" : "application/json",
      result.response === undefined ? result.command.stdout : JSON.stringify(result.response),
    );
    await writer.emit("artifact.stored", { artifact: commandOutput });
    const files: Array<{ name: string; artifact: ArtifactRef }> = [];
    for (const file of result.evidence) {
      const artifact = await this.#put(runId, "testplay-evidence", file.mediaType, file.content);
      await writer.emit("artifact.stored", { artifact });
      files.push({ name: file.name, artifact });
    }
    return this.#storeJson(writer, runId, "testplay-evidence", {
      schemaVersion: 1,
      command: commandOutput,
      files,
      observation: {
        exitCode: result.command.exitCode,
        signal: result.command.signal,
        durationMs: result.command.durationMs,
        stdoutBytes: result.command.stdoutBytes,
        stderrBytes: result.command.stderrBytes,
        stdoutDigest: result.command.stdoutDigest,
        stderrDigest: result.command.stderrDigest,
      },
    });
  }

  async #storeRecoveredTestPlayEvidence(
    runId: RunId,
    writer: UnityEventWriter,
    recovered: readonly TestPlayEvidenceFile[],
    observation: Extract<UnityEvent, { type: "testplay.exited" }>["payload"],
  ): Promise<ArtifactRef> {
    const files: Array<{ name: string; artifact: ArtifactRef }> = [];
    for (const file of recovered) {
      const artifact = await this.#put(runId, "testplay-evidence", file.mediaType, file.content);
      await writer.emit("artifact.stored", { artifact });
      files.push({ name: file.name, artifact });
    }
    return this.#storeJson(writer, runId, "testplay-evidence", {
      schemaVersion: 1,
      recoveredAfterCrash: true,
      files,
      observation,
    });
  }

  async #checkSource(
    runId: RunId,
    config: UnityWorkConfigV1,
    before: SourceManifest,
    beforeRef: ArtifactRef,
    writer: UnityEventWriter,
  ): Promise<{ after: ArtifactRef; unchanged: boolean }> {
    let afterValue: SourceManifest;
    try {
      afterValue = await this.bootstrap.manifest(config.sourceProjectPath);
    } catch (error) {
      throw new HoneyBeeCoreError(
        "source.check-failed",
        "The original Unity project could not be revalidated.",
        undefined,
        { cause: error instanceof Error ? error.message : String(error) },
      );
    }
    const after = await this.#storeJson(writer, runId, "unity-source-manifest", afterValue);
    const unchanged = sameManifest(before, afterValue);
    await writer.emit("source.checked", { before: beforeRef, after, unchanged });
    return { after, unchanged };
  }

  async #releaseAndFinish(
    input: Readonly<{
      runId: RunId;
      config: UnityWorkConfigV1;
      writer: UnityEventWriter;
      workspaceId: string;
      leaseId: string;
      decision: TransactionDecision;
      sourceBefore?: ArtifactRef;
      sourceAfter?: ArtifactRef;
      agentOutput?: ArtifactRef;
      evidence?: ArtifactRef;
      patch?: ArtifactRef;
      resultManifest?: ArtifactRef;
      releaseAlreadyStarted?: boolean;
    }>,
  ): Promise<UnityWorkRunResult> {
    const requestId = releaseRequestIdFor(input.runId);
    if (input.releaseAlreadyStarted !== true) {
      await input.writer.emit("workspace.release-started", {
        leaseId: input.leaseId,
        requestId,
      });
    }
    try {
      const response = await this.storage.release(
        input.leaseId,
        requestId,
        input.config.workspaceStorage.workspaceRoot,
      );
      await this.bootstrap.verifyReleased(
        input.config.workspaceStorage.workspaceRoot,
        input.workspaceId,
      );
      const release = await this.#storeJson(
        input.writer,
        input.runId,
        "workspace-release-receipt",
        { response, workspaceAbsent: true },
      );
      await input.writer.emit("workspace.released", {
        leaseId: input.leaseId,
        receipt: release,
        cleanupState: "released",
      });
      return this.#appendTerminal(
        input.runId,
        input.writer,
        input.decision,
        input.sourceBefore,
        input.sourceAfter,
        input.evidence,
        release,
        input.agentOutput,
        input.patch,
        input.resultManifest,
      );
    } catch (error) {
      const failure = failureMetadata(error);
      await input.writer.emit("workspace.release-failed", {
        leaseId: input.leaseId,
        failure,
      });
      return {
        runId: input.runId,
        status: "cleanup-pending",
        ...(input.sourceBefore === undefined ? {} : { sourceBefore: input.sourceBefore }),
        ...(input.sourceAfter === undefined ? {} : { sourceAfter: input.sourceAfter }),
        ...(input.agentOutput === undefined ? {} : { agentOutput: input.agentOutput }),
        ...(input.evidence === undefined ? {} : { evidence: input.evidence }),
        ...(input.patch === undefined ? {} : { patch: input.patch }),
        ...(input.resultManifest === undefined ? {} : { resultManifest: input.resultManifest }),
        failure,
      };
    }
  }

  async #emitProcessStarted(
    writer: UnityEventWriter,
    type: "agent.started" | "testplay.started",
    pid: number,
    containment?: "deferred-v1",
    stepId?: StepId,
  ): Promise<EventId> {
    const processIdentity = await this.#processControl.captureIdentity(pid);
    const event = await writer.emitEvent(
      type,
      {
        pid,
        ...(processIdentity === undefined ? {} : { processIdentity }),
        ...(containment === undefined ? {} : { containment }),
      },
      stepId,
    );
    return event.eventId;
  }

  async #emitContainmentRegistered(
    writer: UnityEventWriter,
    process: "agent" | "testplay",
    startedEventId: EventId | undefined,
    stepId?: StepId,
  ): Promise<void> {
    if (startedEventId === undefined) {
      throw new HoneyBeeCoreError(
        "process.registration-failed",
        "The containment process registered without a durable start event.",
      );
    }
    await writer.emit("process.containment-registered", { process, startedEventId }, stepId);
  }

  async #emitProcessDrainCompleted(
    writer: UnityEventWriter,
    process: "agent" | "testplay",
    startedEventId: EventId | undefined,
    stepId?: StepId,
  ): Promise<void> {
    if (startedEventId === undefined) {
      throw new HoneyBeeCoreError(
        "process.drain-failed",
        "The containment process drained without a durable start event.",
      );
    }
    await writer.emit("process.drain-completed", { process, startedEventId }, stepId);
  }

  async #drainInterruptedChildren(
    events: readonly UnityEvent[],
    writer: UnityEventWriter,
  ): Promise<void> {
    for (const [startedType, exitedType] of [
      ["agent.started", "agent.exited"],
      ["testplay.started", "testplay.exited"],
    ] as const) {
      const started = lastEvent(events, startedType);
      if (started === undefined) continue;
      const exited = lastEvent(events, exitedType);
      const hasExited = exited !== undefined && exited.sequence > started.sequence;
      const deferred = started.payload.containment === "deferred-v1";
      if (hasExited && !deferred) continue;
      const processType = startedType === "agent.started" ? "agent" : "testplay";
      const registered = events.some(
        (event) =>
          event.type === "process.containment-registered" &&
          event.payload.process === processType &&
          event.payload.startedEventId === started.eventId,
      );
      const drained = events.some(
        (event) =>
          event.type === "process.drain-completed" &&
          event.payload.process === processType &&
          event.payload.startedEventId === started.eventId,
      );
      if (drained) continue;
      await this.#processControl.drain(
        started.payload.pid,
        started.payload.processIdentity,
        deferred && (!registered || hasExited) ? "safe" : "unsafe",
      );
      await writer.emit(
        "process.drain-completed",
        { process: processType, startedEventId: started.eventId },
        startedType === "agent.started" ? started.stepId : undefined,
      );
    }
  }

  async #appendTerminal(
    runId: RunId,
    writer: UnityEventWriter,
    decision: TransactionDecision,
    sourceBefore: ArtifactRef | undefined,
    sourceAfter: ArtifactRef | undefined,
    evidence: ArtifactRef | undefined,
    release: ArtifactRef,
    agentOutput?: ArtifactRef,
    patch?: ArtifactRef,
    resultManifest?: ArtifactRef,
  ): Promise<UnityWorkRunResult> {
    if (decision.outcome === "completed") {
      if (
        evidence === undefined ||
        sourceAfter === undefined ||
        (writer.schemaVersion === 4 && (patch === undefined || resultManifest === undefined))
      ) {
        throw new HoneyBeeCoreError(
          "run.indeterminate",
          "Completed Unity transaction is missing durable Evidence.",
        );
      }
      await writer.emit(
        "workflow.completed",
        writer.schemaVersion === 4
          ? { evidence, patch, resultManifest, release, sourceAfter }
          : { evidence, release, sourceAfter },
      );
      return {
        runId,
        status: "completed",
        ...(sourceBefore === undefined ? {} : { sourceBefore }),
        sourceAfter,
        ...(agentOutput === undefined ? {} : { agentOutput }),
        evidence,
        release,
        ...(patch === undefined ? {} : { patch }),
        ...(resultManifest === undefined ? {} : { resultManifest }),
      };
    }
    if (decision.outcome === "cancelled") {
      await writer.emit("workflow.cancelled", {
        release,
        ...(sourceAfter === undefined ? {} : { sourceAfter }),
      });
      return {
        runId,
        status: "cancelled",
        ...(sourceBefore === undefined ? {} : { sourceBefore }),
        ...(sourceAfter === undefined ? {} : { sourceAfter }),
        ...(agentOutput === undefined ? {} : { agentOutput }),
        ...(evidence === undefined ? {} : { evidence }),
        release,
      };
    }
    await writer.emit("workflow.failed", {
      failure: decision.failure,
      release,
      ...(sourceAfter === undefined ? {} : { sourceAfter }),
    });
    return {
      runId,
      status: "failed",
      ...(sourceBefore === undefined ? {} : { sourceBefore }),
      ...(sourceAfter === undefined ? {} : { sourceAfter }),
      ...(agentOutput === undefined ? {} : { agentOutput }),
      ...(evidence === undefined ? {} : { evidence }),
      release,
      failure: decision.failure,
    };
  }

  #watchCancellation(
    runId: RunId,
    writer: UnityEventWriter,
    aborter: AbortController,
  ): Readonly<{ stop: () => Promise<void>; error: () => unknown }> {
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

  async #acceptPendingCancel(runId: RunId, writer: UnityEventWriter): Promise<boolean> {
    const pending = await this.controls.pending(runId);
    const cancel = pending.find((request) => request.action === "cancel");
    if (cancel === undefined) return false;
    await writer.emit("control.accepted", {
      requestId: cancel.requestId,
      action: "cancel",
    });
    await this.controls.acknowledge(cancel);
    return true;
  }

  async #acquireResource(
    runId: RunId,
    execution: UnityWorkV4Execution,
    writer: UnityEventWriter,
    signal: AbortSignal,
  ): Promise<UnityResourceLease> {
    const requestId = EventIdSchema.parse(this.#randomId());
    await writer.emit("resource.acquire-started", {
      resourceId: execution.resourceId,
      requestId,
    });
    try {
      const ticket = await execution.resources.enqueue({
        resourceId: execution.resourceId,
        requestId,
        ownerRunId: runId,
      });
      await writer.emit("resource.queued", {
        resourceId: ticket.resourceId,
        requestId: ticket.requestId,
        ticket: ticket.ticket,
      });
      const locator = { resourceId: execution.resourceId, requestId };
      const lease = await execution.resources.acquire(locator, signal);
      await writer.emit("resource.acquired", {
        resourceId: lease.resourceId,
        requestId: lease.requestId,
        ticket: lease.ticket,
        leaseId: lease.leaseId,
      });
      return lease;
    } catch (error) {
      const locator = { resourceId: execution.resourceId, requestId };
      const observation = await execution.resources.status(locator);
      if (observation.state === "queued") {
        await execution.resources.cancel(locator);
      } else if (observation.state === "active") {
        await execution.resources.release(observation.lease);
      }
      if (signal.aborted || observation.state === "cancelled") {
        if (observation.state !== "missing") {
          await writer.emit("resource.acquire-cancelled", {
            resourceId: execution.resourceId,
            requestId,
          });
        }
        throw new HoneyBeeCoreError("agent.cancelled", "Unity resource wait was cancelled.");
      }
      const failure = failureMetadata(error);
      await writer.emit("resource.acquire-failed", {
        resourceId: execution.resourceId,
        requestId,
        failure,
      });
      throw new HoneyBeeCoreError(
        "resource.acquire-failed",
        "Unity resource could not be acquired.",
      );
    }
  }

  async #recoverResource(
    events: readonly UnityEvent[],
    writer: UnityEventWriter,
    execution: UnityWorkV4Execution,
  ): Promise<void> {
    const started = lastEvent(events, "resource.acquire-started");
    if (started === undefined) return;
    if (
      lastEvent(events, "resource.released") !== undefined ||
      lastEvent(events, "resource.acquire-cancelled") !== undefined ||
      lastEvent(events, "resource.acquire-failed") !== undefined
    ) {
      return;
    }
    const acquired = lastEvent(events, "resource.acquired");
    if (acquired === undefined) {
      if (execution.resourceScope === "global-file-v1") {
        const queued = lastEvent(events, "resource.queued");
        const locator = {
          resourceId: started.payload.resourceId,
          requestId: started.payload.requestId,
        };
        const observation = await execution.resources.status(locator);
        const observedIdentity =
          observation.state === "queued" || observation.state === "cancelled"
            ? observation.ticket
            : observation.state === "active" || observation.state === "released"
              ? observation.lease
              : undefined;
        if (
          (observation.state === "missing" && queued !== undefined) ||
          (observedIdentity !== undefined &&
            (observedIdentity.resourceId !== started.payload.resourceId ||
              observedIdentity.requestId !== started.payload.requestId ||
              observedIdentity.ownerRunId !== events[0]?.runId ||
              (queued !== undefined && observedIdentity.ticket !== queued.payload.ticket)))
        ) {
          throw new HoneyBeeCoreError(
            "resource.release-failed",
            "Recovered global resource history does not match the child Journal.",
          );
        }
        if (observation.state === "queued") {
          await execution.resources.cancel(locator);
        } else if (observation.state === "active") {
          await execution.resources.release(observation.lease);
        }
      }
      await writer.emit("resource.acquire-cancelled", {
        resourceId: started.payload.resourceId,
        requestId: started.payload.requestId,
      });
      return;
    }
    const payload = {
      resourceId: acquired.payload.resourceId,
      requestId: acquired.payload.requestId,
      ticket: acquired.payload.ticket,
      leaseId: acquired.payload.leaseId,
    };
    const releaseStarted = lastEvent(events, "resource.release-started");
    const releaseFailed = lastEvent(events, "resource.release-failed");
    if (
      releaseStarted === undefined ||
      (releaseFailed !== undefined && releaseFailed.sequence > releaseStarted.sequence)
    ) {
      await writer.emit("resource.release-started", payload);
    }
    if (execution.resourceScope === "global-file-v1") {
      const observation = await execution.resources.status({
        resourceId: acquired.payload.resourceId,
        requestId: acquired.payload.requestId,
      });
      const expected = {
        ...payload,
        ownerRunId: events[0]?.runId,
      };
      const matches =
        (observation.state === "active" || observation.state === "released") &&
        observation.lease.resourceId === expected.resourceId &&
        observation.lease.requestId === expected.requestId &&
        observation.lease.ownerRunId === expected.ownerRunId &&
        observation.lease.ticket === expected.ticket &&
        observation.lease.leaseId === expected.leaseId;
      if (!matches) {
        throw new HoneyBeeCoreError(
          "resource.release-failed",
          "Recovered global resource lease does not match the child Journal.",
        );
      }
      if (observation.state === "active") {
        await execution.resources.release(observation.lease);
      }
    }
    await writer.emit("resource.released", payload);
  }

  async #releaseResource(
    execution: UnityWorkV4Execution,
    lease: UnityResourceLease,
    writer: UnityEventWriter,
  ): Promise<void> {
    const payload = {
      resourceId: lease.resourceId,
      requestId: lease.requestId,
      ticket: lease.ticket,
      leaseId: lease.leaseId,
    };
    try {
      await writer.emit("resource.release-started", payload);
    } catch (error) {
      // The batch-local lease is process memory, so it must not block siblings
      // merely because its durable release-start marker could not be written.
      await execution.resources.release(lease);
      throw error;
    }
    try {
      await execution.resources.release(lease);
      await writer.emit("resource.released", payload);
    } catch (error) {
      const failure = failureMetadata(error);
      await writer.emit("resource.release-failed", { ...payload, failure });
      throw new HoneyBeeCoreError(
        "resource.release-failed",
        "Unity resource release was not confirmed.",
      );
    }
  }

  #acquireRequest(
    runId: RunId,
    config: UnityWorkConfigV1,
    workspaceId: string,
  ): WorkspaceAcquireRequest {
    return {
      schemaVersion: 1,
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
    writer: UnityEventWriter,
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
    writer: UnityEventWriter,
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

  #resultFrom(events: readonly UnityEvent[]): UnityWorkRunResult {
    const runId = events[0]?.runId;
    if (runId === undefined) {
      throw new HoneyBeeCoreError("run.indeterminate", "Unity transaction Journal is empty.");
    }
    const baseline = events.find((event) => event.type === "source.baselined");
    const checked = lastEvent(events, "source.checked");
    const evidence = lastEvent(events, "testplay.evidence-stored");
    const release = lastEvent(events, "workspace.released");
    const verifiedPatch = lastEvent(events, "patch.verified");
    const terminal = events.at(-1);
    if (
      terminal?.type !== "workflow.completed" &&
      terminal?.type !== "workflow.failed" &&
      terminal?.type !== "workflow.cancelled"
    ) {
      throw new HoneyBeeCoreError("run.indeterminate", "Unity transaction has no terminal event.");
    }
    const status = terminal.type.slice("workflow.".length) as "completed" | "failed" | "cancelled";
    const failure =
      terminal.type === "workflow.failed" && !("summary" in terminal.payload)
        ? terminal.payload.failure
        : undefined;
    return {
      runId,
      status,
      ...(baseline?.type === "source.baselined" ? { sourceBefore: baseline.payload.manifest } : {}),
      ...(checked?.type === "source.checked" ? { sourceAfter: checked.payload.after } : {}),
      ...(evidence?.type === "testplay.evidence-stored"
        ? { evidence: evidence.payload.evidence }
        : {}),
      ...(release?.type === "workspace.released" ? { release: release.payload.receipt } : {}),
      ...(verifiedPatch?.type === "patch.verified"
        ? {
            patch: verifiedPatch.payload.patch,
            resultManifest: verifiedPatch.payload.resultManifest,
          }
        : {}),
      ...(failure === undefined ? {} : { failure }),
    };
  }
}
