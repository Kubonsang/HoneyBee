import { createHash, randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import path from "node:path";

import {
  ArtifactIdSchema,
  EventIdSchema,
  HoneyBeeCoreError,
  OrchestrationEventV5Schema,
  RunIdSchema,
  UnityBatchConfigV3Schema,
  UnityWorkConfigV2Schema,
  type ArtifactRef,
  type ArtifactStore,
  type FailureMetadata,
  type OrchestrationEventV5,
  type RunControlPort,
  type RunId,
  type RunLeaseManager,
  type RunRepository,
  type StepId,
  type UnityBatchConfigV3,
  type UnityWorkConfigV2,
  type VersionedOrchestrationJournal,
} from "@honeybee/core";

import type { UnityBatchRunResult, UnityBatchStatus, UnityBatchWorkResult } from "./unity-batch.js";
import type { UnityEditorPoolCoordinator } from "./unity-editor-pool.js";
import type { UnityWorkV5Execution } from "./unity-editor-transaction.js";
import type { UnityPatchBuilder } from "./unity-patch.js";
import type { UnityWorkRunResult } from "./unity-transaction.js";

const CONTROL_POLL_INTERVAL_MS = 100;

interface Registration {
  readonly work: UnityBatchConfigV3["works"][number];
  readonly childRunId: RunId;
}

export interface UnityEditorWorkExecutor {
  run(
    runId: RunId,
    task: string,
    config: UnityWorkConfigV2,
    execution: UnityWorkV5Execution,
  ): Promise<UnityWorkRunResult>;
  resume(
    runId: RunId,
    config: UnityWorkConfigV2,
    execution: UnityWorkV5Execution,
  ): Promise<UnityWorkRunResult>;
}

class BatchV5Writer {
  #sequence: number;
  #tail: Promise<void> = Promise.resolve();

  public constructor(
    private readonly journal: VersionedOrchestrationJournal,
    private readonly runId: RunId,
    sequence: number,
    private readonly now: () => Date,
    private readonly randomId: () => string,
  ) {
    this.#sequence = sequence;
  }

  public emit(type: OrchestrationEventV5["type"], payload: unknown): Promise<void> {
    const operation = this.#tail.then(async () => {
      const event = OrchestrationEventV5Schema.parse({
        schemaVersion: 5,
        eventId: EventIdSchema.parse(this.randomId()),
        runId: this.runId,
        sequence: ++this.#sequence,
        timestamp: this.now().toISOString(),
        type,
        payload,
      });
      await this.journal.append(this.runId, event);
    });
    this.#tail = operation;
    return operation;
  }
}

const childRunIdFor = (parentRunId: RunId, workId: StepId): RunId => {
  const bytes = createHash("sha256")
    .update("honeybee-unity-editor-batch-child-v1\0", "utf8")
    .update(parentRunId, "utf8")
    .update("\0", "utf8")
    .update(workId, "utf8")
    .digest()
    .subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return RunIdSchema.parse(
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
  );
};

const finishedEvent = (events: readonly OrchestrationEventV5[], workId: StepId) =>
  [...events]
    .reverse()
    .find(
      (event): event is Extract<OrchestrationEventV5, { type: "work.finished" }> =>
        event.type === "work.finished" && event.payload.workId === workId,
    );

const workFromFinished = (
  event: Extract<OrchestrationEventV5, { type: "work.finished" }>,
): UnityBatchWorkResult => ({
  workId: event.payload.workId,
  childRunId: event.payload.childRunId,
  status: event.payload.status,
  ...(event.payload.status === "completed" ? { patch: event.payload.patch } : {}),
  ...(event.payload.status === "failed" ? { failure: event.payload.failure } : {}),
});

const summary = (works: readonly UnityBatchWorkResult[]) => ({
  total: works.length,
  completed: works.filter((work) => work.status === "completed").length,
  failed: works.filter((work) => work.status === "failed").length,
  cancelled: works.filter((work) => work.status === "cancelled").length,
});

const runtimeConfig = (
  config: UnityBatchConfigV3,
  work: UnityBatchConfigV3["works"][number],
): UnityWorkConfigV2 =>
  UnityWorkConfigV2Schema.parse({
    ...config.transaction,
    schemaVersion: 2,
    ...(config.transaction.testplay === undefined
      ? {}
      : { testplay: { ...config.transaction.testplay, bridgeProtocolVersion: 3 } }),
    editorPool: config.editorPool,
    priority: work.priority,
    capabilities: work.capabilities,
  });

export const inspectUnityEditorBatchEvents = (
  runIdValue: RunId,
  events: readonly OrchestrationEventV5[],
): UnityBatchRunResult => {
  const runId = RunIdSchema.parse(runIdValue);
  const start = events[0];
  if (start?.type !== "workflow.started" || start.payload.mode !== "unity-batch-v2") {
    throw new HoneyBeeCoreError("run.not-resumable", "Run is not a Unity v0.6 batch.");
  }
  const registered = events.filter(
    (event): event is Extract<OrchestrationEventV5, { type: "work.registered" }> =>
      event.type === "work.registered",
  );
  const works = registered.map((event) => {
    const finished = finishedEvent(events, event.payload.workId);
    return finished === undefined
      ? {
          workId: event.payload.workId,
          childRunId: event.payload.childRunId,
          status: "pending" as const,
        }
      : workFromFinished(finished);
  });
  const terminal = events.at(-1);
  const status: UnityBatchStatus =
    terminal?.type === "workflow.completed"
      ? "completed"
      : terminal?.type === "workflow.failed"
        ? "failed"
        : terminal?.type === "workflow.cancelled"
          ? "cancelled"
          : works.some((work) => work.status === "pending") ||
              works.length < start.payload.workCount
            ? "running"
            : "cleanup-pending";
  const failure =
    terminal?.type === "workflow.failed" && "summary" in terminal.payload
      ? terminal.payload.failure
      : undefined;
  return {
    runId,
    status,
    works,
    summary: { ...summary(works), total: start.payload.workCount },
    ...(failure === undefined ? {} : { failure }),
  };
};

export class UnityEditorBatchWorkflow {
  readonly #now: () => Date;
  readonly #randomId: () => string;

  public constructor(
    private readonly root: string,
    private readonly artifacts: ArtifactStore,
    private readonly journal: VersionedOrchestrationJournal,
    private readonly repository: RunRepository,
    private readonly controls: RunControlPort,
    private readonly leases: RunLeaseManager,
    private readonly transaction: UnityEditorWorkExecutor,
    private readonly pool: UnityEditorPoolCoordinator,
    private readonly patchBuilder: UnityPatchBuilder,
    options: Readonly<{ now?: () => Date; randomId?: () => string }> = {},
  ) {
    this.#now = options.now ?? (() => new Date());
    this.#randomId = options.randomId ?? randomUUID;
  }

  public async run(
    runIdValue: RunId,
    configValue: UnityBatchConfigV3,
  ): Promise<UnityBatchRunResult> {
    const runId = RunIdSchema.parse(runIdValue);
    const config = UnityBatchConfigV3Schema.parse(configValue);
    if (config.works.some((work) => work.capabilities.length > 0)) {
      await this.pool.declare({
        poolId: config.editorPool.id,
        capacity: config.editorPool.capacity,
      });
    }
    const configArtifact = await this.#putConfig(runId, config);
    const writer = new BatchV5Writer(this.journal, runId, 0, this.#now, this.#randomId);
    await writer.emit("workflow.started", {
      mode: "unity-batch-v2",
      config: configArtifact,
      workCount: config.works.length,
      maxParallelWorks: config.maxParallelWorks,
      poolId: config.editorPool.id,
      poolCapacity: config.editorPool.capacity,
    });
    await writer.emit("artifact.stored", { artifact: configArtifact });
    const registrations: Registration[] = [];
    for (const work of config.works) {
      const childRunId = childRunIdFor(runId, work.id);
      await writer.emit("work.registered", {
        workId: work.id,
        childRunId,
        priority: work.priority,
        capabilityCount: work.capabilities.length,
      });
      registrations.push({ work, childRunId });
    }
    return this.#execute(runId, config, registrations, writer, []);
  }

  public async resume(runIdValue: RunId): Promise<UnityBatchRunResult> {
    const runId = RunIdSchema.parse(runIdValue);
    const replay = await this.journal.replay(runId);
    if (replay.status === "indeterminate")
      throw new HoneyBeeCoreError("run.indeterminate", replay.message);
    const events = replay.events as readonly OrchestrationEventV5[];
    const start = events[0];
    if (
      start?.schemaVersion !== 5 ||
      start.type !== "workflow.started" ||
      start.payload.mode !== "unity-batch-v2"
    ) {
      throw new HoneyBeeCoreError("run.not-resumable", "Run is not a Unity v0.6 batch.");
    }
    if (replay.status === "terminal") return inspectUnityEditorBatchEvents(runId, events);
    const config = UnityBatchConfigV3Schema.parse(
      JSON.parse(await this.artifacts.get({ runId, artifact: start.payload.config })) as unknown,
    );
    if (
      start.payload.poolId !== config.editorPool.id ||
      start.payload.poolCapacity !== config.editorPool.capacity
    ) {
      throw new HoneyBeeCoreError(
        "run.indeterminate",
        "Editor pool config changed after batch start.",
      );
    }
    if (config.works.some((work) => work.capabilities.length > 0)) {
      await this.pool.declare({
        poolId: config.editorPool.id,
        capacity: config.editorPool.capacity,
      });
    }
    const registered = events.filter(
      (event): event is Extract<OrchestrationEventV5, { type: "work.registered" }> =>
        event.type === "work.registered",
    );
    const writer = new BatchV5Writer(this.journal, runId, events.length, this.#now, this.#randomId);
    const registrations: Registration[] = [];
    for (const work of config.works) {
      const childRunId = childRunIdFor(runId, work.id);
      const durable = registered.find((event) => event.payload.workId === work.id);
      if (
        durable !== undefined &&
        (durable.payload.childRunId !== childRunId ||
          durable.payload.priority !== work.priority ||
          durable.payload.capabilityCount !== work.capabilities.length)
      )
        throw new HoneyBeeCoreError(
          "run.indeterminate",
          "Batch Work registration differs from config.",
        );
      if (durable === undefined) {
        await writer.emit("work.registered", {
          workId: work.id,
          childRunId,
          priority: work.priority,
          capabilityCount: work.capabilities.length,
        });
      }
      registrations.push({ work, childRunId });
    }
    return this.#execute(runId, config, registrations, writer, events);
  }

  public async inspect(runIdValue: RunId): Promise<UnityBatchRunResult> {
    const runId = RunIdSchema.parse(runIdValue);
    const replay = await this.journal.replay(runId);
    if (replay.status === "indeterminate")
      throw new HoneyBeeCoreError("run.indeterminate", replay.message);
    return inspectUnityEditorBatchEvents(runId, replay.events as readonly OrchestrationEventV5[]);
  }

  async #execute(
    parentRunId: RunId,
    config: UnityBatchConfigV3,
    registrations: readonly Registration[],
    writer: BatchV5Writer,
    existing: readonly OrchestrationEventV5[],
  ): Promise<UnityBatchRunResult> {
    for (const registration of registrations) await this.#ensureChildRun(registration.childRunId);
    const results = new Map<StepId, UnityBatchWorkResult>();
    for (const registration of registrations) {
      const finished = finishedEvent(existing, registration.work.id);
      if (finished !== undefined) results.set(registration.work.id, workFromFinished(finished));
    }
    const accepted = [...existing].reverse().find((event) => event.type === "control.accepted");
    let cancelling = existing.some((event) => event.type === "workflow.cancelling");
    if (accepted?.type === "control.accepted") {
      if (!cancelling) {
        await writer.emit("workflow.cancelling", { requestId: accepted.payload.requestId });
        cancelling = true;
      }
      const request = (await this.controls.pending(parentRunId)).find(
        (candidate) => candidate.requestId === accepted.payload.requestId,
      );
      if (request !== undefined) await this.controls.acknowledge(request);
    }
    const running = new Map<StepId, Promise<void>>();
    let fatal: unknown;

    const recoverable: Registration[] = [];
    if (existing.length > 0) {
      for (const registration of registrations.filter((value) => !results.has(value.work.id))) {
        if (await this.#childJournalExists(registration.childRunId)) recoverable.push(registration);
      }
    }
    const recovered = await Promise.allSettled(
      recoverable.map(async (registration) => {
        const result = await this.#executeChild(parentRunId, config, registration, cancelling);
        await this.#recordResult(writer, registration, result, results);
      }),
    );
    const rejected = recovered.find(
      (value): value is PromiseRejectedResult => value.status === "rejected",
    );
    if (rejected !== undefined) throw rejected.reason;
    if ([...results.values()].some((value) => value.status === "cleanup-pending")) {
      return this.#result(parentRunId, "cleanup-pending", this.#ordered(registrations, results));
    }

    while (results.size < registrations.length) {
      if (
        fatal !== undefined ||
        [...results.values()].some((value) => value.status === "cleanup-pending")
      )
        break;
      try {
        const request = (await this.controls.pending(parentRunId)).find(
          (candidate) => candidate.action === "cancel",
        );
        if (request !== undefined && !cancelling) {
          await writer.emit("control.accepted", { requestId: request.requestId, action: "cancel" });
          await writer.emit("workflow.cancelling", { requestId: request.requestId });
          await this.controls.acknowledge(request);
          cancelling = true;
          await Promise.allSettled(
            registrations
              .filter((value) => running.has(value.work.id))
              .map((value) => this.#cancelChild(value.childRunId)),
          );
        }

        let progressed = false;
        for (const registration of registrations) {
          if (results.has(registration.work.id) || running.has(registration.work.id)) continue;
          if (cancelling) {
            const started = await this.#childJournalExists(registration.childRunId);
            if (!started) {
              await writer.emit("work.finished", {
                workId: registration.work.id,
                childRunId: registration.childRunId,
                status: "cancelled",
                started: false,
              });
              results.set(registration.work.id, {
                workId: registration.work.id,
                childRunId: registration.childRunId,
                status: "cancelled",
              });
            } else {
              const operation = this.#executeChild(parentRunId, config, registration, true)
                .then((result) => this.#recordResult(writer, registration, result, results))
                .catch((error: unknown) => {
                  fatal = error;
                })
                .finally(() => running.delete(registration.work.id));
              running.set(registration.work.id, operation);
            }
            progressed = true;
            continue;
          }
          if (running.size >= config.maxParallelWorks) break;
          const operation = this.#executeChild(parentRunId, config, registration, false)
            .then((result) => this.#recordResult(writer, registration, result, results))
            .catch((error: unknown) => {
              fatal = error;
            })
            .finally(() => running.delete(registration.work.id));
          running.set(registration.work.id, operation);
          progressed = true;
        }
        if (running.size > 0) {
          await Promise.race([
            ...running.values(),
            new Promise<void>((resolve) => setTimeout(resolve, CONTROL_POLL_INTERVAL_MS)),
          ]);
          continue;
        }
        if (!progressed) break;
      } catch (error) {
        fatal = error;
        break;
      }
    }

    const unsafe =
      fatal !== undefined ||
      [...results.values()].some((value) => value.status === "cleanup-pending");
    if (unsafe && !cancelling) {
      await Promise.allSettled(
        registrations
          .filter((value) => running.has(value.work.id))
          .map((value) => this.#cancelChild(value.childRunId)),
      );
    }
    await Promise.allSettled(running.values());
    if (fatal !== undefined) throw fatal;
    const works = this.#ordered(registrations, results);
    if (works.some((value) => value.status === "cleanup-pending" || value.status === "pending")) {
      return this.#result(parentRunId, "cleanup-pending", works);
    }
    const batchSummary = summary(works);
    if (batchSummary.failed > 0 || (!cancelling && batchSummary.cancelled > 0)) {
      const failure = {
        errorCode:
          batchSummary.failed > 0 ? "batch.work-failed" : "batch.work-cancelled-for-safety",
      };
      await writer.emit("workflow.failed", { failure, summary: batchSummary });
      return this.#result(parentRunId, "failed", works, failure);
    }
    if (cancelling || batchSummary.cancelled > 0) {
      await writer.emit("workflow.cancelled", { summary: batchSummary });
      return this.#result(parentRunId, "cancelled", works);
    }
    await writer.emit("workflow.completed", { summary: batchSummary });
    return this.#result(parentRunId, "completed", works);
  }

  async #executeChild(
    parentRunId: RunId,
    config: UnityBatchConfigV3,
    registration: Registration,
    cancelling: boolean,
  ): Promise<UnityWorkRunResult> {
    await this.#ensureChildRun(registration.childRunId);
    if (cancelling) await this.#cancelChild(registration.childRunId);
    const lease = await this.leases.acquire(registration.childRunId);
    const childConfig = runtimeConfig(config, registration.work);
    const execution: UnityWorkV5Execution = {
      parentRunId,
      workId: registration.work.id,
      poolId: config.editorPool.id,
      priority: registration.work.priority,
      capabilities: registration.work.capabilities,
      pool: this.pool,
      patchBuilder: this.patchBuilder,
    };
    try {
      return (await this.#childJournalExists(registration.childRunId))
        ? this.transaction.resume(registration.childRunId, childConfig, execution)
        : this.transaction.run(
            registration.childRunId,
            registration.work.task,
            childConfig,
            execution,
          );
    } finally {
      await lease.release();
    }
  }

  async #recordResult(
    writer: BatchV5Writer,
    registration: Registration,
    result: UnityWorkRunResult,
    results: Map<StepId, UnityBatchWorkResult>,
  ): Promise<void> {
    const work: UnityBatchWorkResult = {
      workId: registration.work.id,
      childRunId: registration.childRunId,
      status: result.status,
      ...(result.patch === undefined ? {} : { patch: result.patch }),
      ...(result.failure === undefined ? {} : { failure: result.failure }),
    };
    results.set(registration.work.id, work);
    if (result.status === "cleanup-pending") return;
    if (result.status === "completed") {
      if (result.patch === undefined)
        throw new HoneyBeeCoreError("run.indeterminate", "Completed Work has no verified patch.");
      await writer.emit("work.finished", {
        workId: work.workId,
        childRunId: work.childRunId,
        status: "completed",
        patch: result.patch,
      });
    } else if (result.status === "failed") {
      await writer.emit("work.finished", {
        workId: work.workId,
        childRunId: work.childRunId,
        status: "failed",
        failure: result.failure ?? { errorCode: "workflow.internal-error" },
      });
    } else {
      await writer.emit("work.finished", {
        workId: work.workId,
        childRunId: work.childRunId,
        status: "cancelled",
        started: true,
      });
    }
  }

  #ordered(
    registrations: readonly Registration[],
    results: ReadonlyMap<StepId, UnityBatchWorkResult>,
  ): UnityBatchWorkResult[] {
    return registrations.map(
      (registration) =>
        results.get(registration.work.id) ?? {
          workId: registration.work.id,
          childRunId: registration.childRunId,
          status: "pending" as const,
        },
    );
  }

  #cancelChild(runId: RunId): Promise<void> {
    return this.controls.submit({
      requestId: EventIdSchema.parse(this.#randomId()),
      runId,
      action: "cancel",
      timestamp: this.#now().toISOString(),
    });
  }

  async #childJournalExists(runId: RunId): Promise<boolean> {
    try {
      await access(path.join(this.root, runId, "events.jsonl"));
      return true;
    } catch {
      return false;
    }
  }

  async #ensureChildRun(runId: RunId): Promise<void> {
    try {
      await this.repository.open(runId);
    } catch (error) {
      if (!(error instanceof HoneyBeeCoreError) || error.code !== "run.not-found") throw error;
      await this.repository.create(runId);
    }
  }

  #putConfig(runId: RunId, config: UnityBatchConfigV3): Promise<ArtifactRef> {
    return this.artifacts.put({
      runId,
      artifactId: ArtifactIdSchema.parse(this.#randomId()),
      kind: "workflow-config",
      mediaType: "application/json",
      content: JSON.stringify(config),
    });
  }

  #result(
    runId: RunId,
    status: UnityBatchStatus,
    works: readonly UnityBatchWorkResult[],
    failure?: FailureMetadata,
  ): UnityBatchRunResult {
    return {
      runId,
      status,
      works,
      summary: summary(works),
      ...(failure === undefined ? {} : { failure }),
    };
  }
}
