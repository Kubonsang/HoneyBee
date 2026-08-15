import { createHash, randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import path from "node:path";

import {
  ArtifactIdSchema,
  EventIdSchema,
  HoneyBeeCoreError,
  OrchestrationEventV4Schema,
  RunIdSchema,
  UnityBatchConfigSchema,
  type ArtifactRef,
  type ArtifactStore,
  type FailureMetadata,
  type OrchestrationEventV4,
  type RunControlPort,
  type RunId,
  type RunLeaseManager,
  type RunRepository,
  type StepId,
  type UnityBatchConfig,
  type VersionedOrchestrationJournal,
} from "@honeybee/core";

import type { UnityPatchBuilder } from "./unity-patch.js";
import type { UnityResourceCoordinator } from "./unity-resource-control.js";
import type { UnityWorkRunResult, UnityWorkV4Execution } from "./unity-transaction.js";

export type UnityBatchStatus = "running" | "completed" | "failed" | "cancelled" | "cleanup-pending";
const CONTROL_POLL_INTERVAL_MS = 100;

export interface UnityBatchWorkResult {
  readonly workId: StepId;
  readonly childRunId: RunId;
  readonly status: UnityWorkRunResult["status"] | "pending";
  readonly patch?: ArtifactRef;
  readonly failure?: FailureMetadata;
}

export interface UnityBatchRunResult {
  readonly runId: RunId;
  readonly status: UnityBatchStatus;
  readonly works: readonly UnityBatchWorkResult[];
  readonly summary: Readonly<{
    total: number;
    completed: number;
    failed: number;
    cancelled: number;
  }>;
  readonly failure?: FailureMetadata;
}

interface Registration {
  readonly work: UnityBatchConfig["works"][number];
  readonly childRunId: RunId;
}

export interface UnityWorkExecutor {
  run(
    runId: RunId,
    task: string,
    config: UnityBatchConfig["transaction"],
    execution: UnityWorkV4Execution,
  ): Promise<UnityWorkRunResult>;
  resume(
    runId: RunId,
    config: UnityBatchConfig["transaction"],
    execution: UnityWorkV4Execution,
  ): Promise<UnityWorkRunResult>;
}

class BatchEventWriter {
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

  public emit(type: OrchestrationEventV4["type"], payload: unknown): Promise<void> {
    const operation = this.#tail.then(async () => {
      const event = OrchestrationEventV4Schema.parse({
        schemaVersion: 4,
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

const finishedEvent = (
  events: readonly OrchestrationEventV4[],
  workId: StepId,
): Extract<OrchestrationEventV4, { type: "work.finished" }> | undefined =>
  [...events]
    .reverse()
    .find(
      (event): event is Extract<OrchestrationEventV4, { type: "work.finished" }> =>
        event.type === "work.finished" && event.payload.workId === workId,
    );

const childRunIdFor = (parentRunId: RunId, workId: StepId): RunId => {
  const bytes = createHash("sha256")
    .update("honeybee-unity-batch-child-v1\0", "utf8")
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

const workFromFinished = (
  event: Extract<OrchestrationEventV4, { type: "work.finished" }>,
): UnityBatchWorkResult => ({
  workId: event.payload.workId,
  childRunId: event.payload.childRunId,
  status: event.payload.status,
  ...(event.payload.status === "completed" ? { patch: event.payload.patch } : {}),
  ...(event.payload.status === "failed" ? { failure: event.payload.failure } : {}),
});

const batchSummary = (works: readonly UnityBatchWorkResult[]) => ({
  total: works.length,
  completed: works.filter((work) => work.status === "completed").length,
  failed: works.filter((work) => work.status === "failed").length,
  cancelled: works.filter((work) => work.status === "cancelled").length,
});

const resourceScopeFor = (config: UnityBatchConfig) =>
  config.schemaVersion === 2 ? config.resourceScope : ("batch-local-v1" as const);

export const inspectUnityBatchEvents = (
  runIdValue: RunId,
  events: readonly OrchestrationEventV4[],
): UnityBatchRunResult => {
  const runId = RunIdSchema.parse(runIdValue);
  const start = events[0];
  if (start?.type !== "workflow.started" || start.payload.mode !== "unity-batch-v1") {
    throw new HoneyBeeCoreError("run.not-resumable", "Run is not a Unity batch.");
  }
  const registered = events.filter(
    (event): event is Extract<OrchestrationEventV4, { type: "work.registered" }> =>
      event.type === "work.registered",
  );
  if (registered.length > start.payload.workCount) {
    throw new HoneyBeeCoreError("run.indeterminate", "Batch registrations exceed the config.");
  }
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
  if (
    terminal !== undefined &&
    ["workflow.completed", "workflow.failed", "workflow.cancelled"].includes(terminal.type) &&
    registered.length !== start.payload.workCount
  ) {
    throw new HoneyBeeCoreError("run.indeterminate", "Terminal batch registration is incomplete.");
  }
  const status =
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
    summary: { ...batchSummary(works), total: start.payload.workCount },
    ...(failure === undefined ? {} : { failure }),
  };
};

export class UnityBatchWorkflow {
  readonly #now: () => Date;
  readonly #randomId: () => string;

  public constructor(
    private readonly root: string,
    private readonly artifacts: ArtifactStore,
    private readonly journal: VersionedOrchestrationJournal,
    private readonly repository: RunRepository,
    private readonly controls: RunControlPort,
    private readonly leases: RunLeaseManager,
    private readonly transaction: UnityWorkExecutor,
    private readonly resources: UnityResourceCoordinator,
    private readonly patchBuilder: UnityPatchBuilder,
    options: Readonly<{ now?: () => Date; randomId?: () => string }> = {},
  ) {
    this.#now = options.now ?? (() => new Date());
    this.#randomId = options.randomId ?? randomUUID;
  }

  public async run(runIdValue: RunId, configValue: UnityBatchConfig): Promise<UnityBatchRunResult> {
    const runId = RunIdSchema.parse(runIdValue);
    const config = UnityBatchConfigSchema.parse(configValue);
    const configArtifact = await this.#putConfig(runId, config);
    const writer = new BatchEventWriter(this.journal, runId, 0, this.#now, this.#randomId);
    await writer.emit("workflow.started", {
      mode: "unity-batch-v1",
      config: configArtifact,
      workCount: config.works.length,
      maxParallelWorks: config.maxParallelWorks,
      resourceScope: resourceScopeFor(config),
    });
    await writer.emit("artifact.stored", { artifact: configArtifact });
    const registrations: Registration[] = [];
    for (const work of config.works) {
      const childRunId = childRunIdFor(runId, work.id);
      await writer.emit("work.registered", {
        workId: work.id,
        childRunId,
        resourceId: work.resourceRef,
      });
      registrations.push({ work, childRunId });
    }
    return this.#execute(runId, config, registrations, writer, []);
  }

  public async resume(runIdValue: RunId): Promise<UnityBatchRunResult> {
    const runId = RunIdSchema.parse(runIdValue);
    const replay = await this.journal.replay(runId);
    if (replay.status === "indeterminate") {
      throw new HoneyBeeCoreError("run.indeterminate", replay.message);
    }
    const events = replay.events as readonly OrchestrationEventV4[];
    const start = events[0];
    if (
      start?.schemaVersion !== 4 ||
      start.type !== "workflow.started" ||
      start.payload.mode !== "unity-batch-v1"
    ) {
      throw new HoneyBeeCoreError("run.not-resumable", "Run is not a Unity batch.");
    }
    if (replay.status === "terminal") return inspectUnityBatchEvents(runId, events);
    const config = UnityBatchConfigSchema.parse(
      JSON.parse(await this.artifacts.get({ runId, artifact: start.payload.config })) as unknown,
    );
    if (start.payload.resourceScope !== resourceScopeFor(config)) {
      throw new HoneyBeeCoreError(
        "run.indeterminate",
        "Batch resource scope does not match its durable config.",
      );
    }
    const registeredEvents = events.filter(
      (event): event is Extract<OrchestrationEventV4, { type: "work.registered" }> =>
        event.type === "work.registered",
    );
    for (const event of registeredEvents) {
      if (!config.works.some((work) => work.id === event.payload.workId)) {
        throw new HoneyBeeCoreError(
          "run.indeterminate",
          "Batch Journal registered an unknown Work.",
        );
      }
    }
    const registrations: Registration[] = [];
    const writer = new BatchEventWriter(
      this.journal,
      runId,
      events.length,
      this.#now,
      this.#randomId,
    );
    for (const work of config.works) {
      const event = registeredEvents.find((candidate) => candidate.payload.workId === work.id);
      const childRunId = childRunIdFor(runId, work.id);
      if (
        event !== undefined &&
        (work.resourceRef !== event.payload.resourceId || event.payload.childRunId !== childRunId)
      ) {
        throw new HoneyBeeCoreError(
          "run.indeterminate",
          "Batch Work registration does not match config.",
        );
      }
      if (event === undefined) {
        await writer.emit("work.registered", {
          workId: work.id,
          childRunId,
          resourceId: work.resourceRef,
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
    const events = replay.events as readonly OrchestrationEventV4[];
    const start = events[0];
    if (start?.type !== "workflow.started" || start.payload.mode !== "unity-batch-v1") {
      throw new HoneyBeeCoreError("run.not-resumable", "Run is not a Unity batch.");
    }
    return inspectUnityBatchEvents(runId, events);
  }

  async #execute(
    parentRunId: RunId,
    config: UnityBatchConfig,
    registrations: readonly Registration[],
    writer: BatchEventWriter,
    existing: readonly OrchestrationEventV4[],
  ): Promise<UnityBatchRunResult> {
    for (const registration of registrations) {
      await this.#ensureChildRun(registration.childRunId);
    }
    const results = new Map<StepId, UnityBatchWorkResult>();
    for (const registration of registrations) {
      const finished = finishedEvent(existing, registration.work.id);
      if (finished !== undefined) results.set(registration.work.id, workFromFinished(finished));
    }
    const acceptedCancel = [...existing]
      .reverse()
      .find((event) => event.type === "control.accepted");
    let cancelling = existing.some((event) => event.type === "workflow.cancelling");
    if (acceptedCancel?.type === "control.accepted") {
      if (!cancelling) {
        await writer.emit("workflow.cancelling", { requestId: acceptedCancel.payload.requestId });
        cancelling = true;
      }
      const acceptedRequest = (await this.controls.pending(parentRunId)).find(
        (request) => request.requestId === acceptedCancel.payload.requestId,
      );
      if (acceptedRequest !== undefined) await this.controls.acknowledge(acceptedRequest);
    }
    const running = new Map<StepId, Promise<void>>();
    let fatal: unknown;

    // A resumed parent must settle every child that has durable state before it
    // dispatches new work. This preserves v0.4 cleanup ordering across a parent crash.
    const recovery = registrations.filter(
      (registration) => !results.has(registration.work.id) && existing.length > 0,
    );
    const recoverable: Registration[] = [];
    for (const registration of recovery) {
      if (await this.#childJournalExists(registration.childRunId)) recoverable.push(registration);
    }
    const recovered = await Promise.allSettled(
      recoverable.map(async (registration) => {
        const result = await this.#executeChild(parentRunId, config, registration, cancelling);
        await this.#recordResult(writer, registration, result, results);
      }),
    );
    const recoveryFailure = recovered.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (recoveryFailure !== undefined) throw recoveryFailure.reason;
    if ([...results.values()].some((result) => result.status === "cleanup-pending")) {
      return this.#result(
        parentRunId,
        "cleanup-pending",
        registrations.map(
          (registration) =>
            results.get(registration.work.id) ?? {
              workId: registration.work.id,
              childRunId: registration.childRunId,
              status: "pending" as const,
            },
        ),
      );
    }

    while (results.size < registrations.length) {
      if (fatal !== undefined) break;
      if ([...results.values()].some((result) => result.status === "cleanup-pending")) break;
      try {
        const pendingCancel = (await this.controls.pending(parentRunId)).find(
          (request) => request.action === "cancel",
        );
        if (pendingCancel !== undefined && !cancelling) {
          await writer.emit("control.accepted", {
            requestId: pendingCancel.requestId,
            action: "cancel",
          });
          await writer.emit("workflow.cancelling", { requestId: pendingCancel.requestId });
          await this.controls.acknowledge(pendingCancel);
          cancelling = true;
          for (const registration of registrations) {
            if (running.has(registration.work.id)) {
              await this.controls.submit({
                requestId: EventIdSchema.parse(this.#randomId()),
                runId: registration.childRunId,
                action: "cancel",
                timestamp: this.#now().toISOString(),
              });
            }
          }
        }

        let progressed = false;
        for (const registration of registrations) {
          if (results.has(registration.work.id) || running.has(registration.work.id)) continue;
          if (cancelling) {
            const eventPayload = {
              workId: registration.work.id,
              childRunId: registration.childRunId,
              status: "cancelled" as const,
              started: await this.#childJournalExists(registration.childRunId),
            };
            if (eventPayload.started) {
              const operation = this.#executeChild(parentRunId, config, registration, true)
                .then(async (result) => {
                  await this.#recordResult(writer, registration, result, results);
                })
                .catch((error: unknown) => {
                  fatal = error;
                })
                .finally(() => running.delete(registration.work.id));
              running.set(registration.work.id, operation);
            } else {
              await writer.emit("work.finished", eventPayload);
              results.set(registration.work.id, {
                workId: registration.work.id,
                childRunId: registration.childRunId,
                status: "cancelled",
              });
            }
            progressed = true;
            continue;
          }
          if (running.size >= config.maxParallelWorks) break;
          const operation = this.#executeChild(parentRunId, config, registration, false)
            .then(async (result) => {
              await this.#recordResult(writer, registration, result, results);
            })
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

    const cleanupPending = [...results.values()].some(
      (result) => result.status === "cleanup-pending",
    );
    if ((fatal !== undefined || cleanupPending) && !cancelling) {
      await Promise.allSettled(
        registrations
          .filter((registration) => running.has(registration.work.id))
          .map((registration) =>
            this.controls.submit({
              requestId: EventIdSchema.parse(this.#randomId()),
              runId: registration.childRunId,
              action: "cancel",
              timestamp: this.#now().toISOString(),
            }),
          ),
      );
    }
    await Promise.allSettled(running.values());
    if (fatal !== undefined) throw fatal;
    const values = registrations.map(
      (registration) =>
        results.get(registration.work.id) ?? {
          workId: registration.work.id,
          childRunId: registration.childRunId,
          status: "cleanup-pending" as const,
        },
    );
    if (values.some((value) => value.status === "cleanup-pending")) {
      return this.#result(parentRunId, "cleanup-pending", values);
    }
    const summary = batchSummary(values);
    if (summary.failed > 0 || (!cancelling && summary.cancelled > 0)) {
      const failure = {
        errorCode: summary.failed > 0 ? "batch.work-failed" : "batch.work-cancelled-for-safety",
      };
      await writer.emit("workflow.failed", { failure, summary });
      return this.#result(parentRunId, "failed", values, failure);
    }
    if (cancelling || summary.cancelled > 0) {
      await writer.emit("workflow.cancelled", { summary });
      return this.#result(parentRunId, "cancelled", values);
    }
    await writer.emit("workflow.completed", { summary });
    return this.#result(parentRunId, "completed", values);
  }

  async #executeChild(
    parentRunId: RunId,
    config: UnityBatchConfig,
    registration: Registration,
    cancelling: boolean,
  ): Promise<UnityWorkRunResult> {
    await this.#ensureChildRun(registration.childRunId);
    if (cancelling) {
      await this.controls.submit({
        requestId: EventIdSchema.parse(this.#randomId()),
        runId: registration.childRunId,
        action: "cancel",
        timestamp: this.#now().toISOString(),
      });
    }
    const lease = await this.leases.acquire(registration.childRunId);
    const execution: UnityWorkV4Execution = {
      parentRunId,
      workId: registration.work.id,
      resourceId: registration.work.resourceRef,
      resourceScope: resourceScopeFor(config),
      resources: this.resources,
      patchBuilder: this.patchBuilder,
    };
    try {
      const journalExists = await this.#childJournalExists(registration.childRunId);
      return journalExists
        ? await this.transaction.resume(registration.childRunId, config.transaction, execution)
        : await this.transaction.run(
            registration.childRunId,
            registration.work.task,
            config.transaction,
            execution,
          );
    } finally {
      await lease.release();
    }
  }

  async #recordResult(
    writer: BatchEventWriter,
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
      if (result.patch === undefined) {
        throw new HoneyBeeCoreError("run.indeterminate", "Completed Work has no verified patch.");
      }
      await writer.emit("work.finished", {
        workId: registration.work.id,
        childRunId: registration.childRunId,
        status: "completed",
        patch: result.patch,
      });
    } else if (result.status === "failed") {
      await writer.emit("work.finished", {
        workId: registration.work.id,
        childRunId: registration.childRunId,
        status: "failed",
        failure: result.failure ?? { errorCode: "workflow.internal-error" },
      });
    } else {
      await writer.emit("work.finished", {
        workId: registration.work.id,
        childRunId: registration.childRunId,
        status: "cancelled",
        started: true,
      });
    }
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

  async #putConfig(runId: RunId, config: UnityBatchConfig): Promise<ArtifactRef> {
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
      summary: batchSummary(works),
      ...(failure === undefined ? {} : { failure }),
    };
  }
}
