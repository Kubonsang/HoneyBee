import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, rm, unlink } from "node:fs/promises";
import path from "node:path";

import {
  ArtifactIdSchema,
  ArtifactKindSchema,
  ArtifactMediaTypeSchema,
  ArtifactRefSchema,
  ContentDigestSchema,
  OrchestrationEventV2Schema,
  OrchestrationEventV3Schema,
  OrchestrationEventV4Schema,
  OrchestrationEventV5Schema,
  OrchestrationEventV1Schema,
  RunIdSchema,
  TERMINAL_WORKFLOW_EVENT_TYPES,
  TERMINAL_WORKFLOW_EVENT_V2_TYPES,
  TERMINAL_WORKFLOW_EVENT_V3_TYPES,
  TERMINAL_WORKFLOW_EVENT_V4_TYPES,
  TERMINAL_WORKFLOW_EVENT_V5_TYPES,
  type AnyOrchestrationEvent,
  type ArtifactRef,
  type FailureMetadata,
  type OrchestrationEventV1,
  type OrchestrationEventV2,
  type OrchestrationEventV3,
  type OrchestrationEventV4,
  type OrchestrationEventV5,
  type RunId,
  type TerminalWorkflowEvent,
  type TerminalWorkflowEventV2,
  type TerminalWorkflowEventV3,
  type TerminalWorkflowEventV4,
  type TerminalWorkflowEventV5,
} from "@honeybee/orchestration-contracts";

import { HoneyBeeCoreError } from "./errors.js";
import type {
  ArtifactGetRequest,
  ArtifactPutRequest,
  ArtifactPutBytesRequest,
  ArtifactStore,
  JournalReplay,
  AnyVersionedJournalReplay,
  OrchestrationJournal,
  VersionedOrchestrationJournal,
  RunRecord,
  RunRepository,
} from "./types.js";

const INDETERMINATE_MESSAGE = "This run terminated abnormally; its result cannot be determined.";

const indeterminate = (): JournalReplay => ({
  status: "indeterminate",
  code: "run.indeterminate",
  message: INDETERMINATE_MESSAGE,
});

const digest = (bytes: Buffer): ReturnType<typeof ContentDigestSchema.parse> =>
  ContentDigestSchema.parse(`sha256:${createHash("sha256").update(bytes).digest("hex")}`);

const errorCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;

abstract class FileRunScopedStore {
  protected readonly rootDirectory: string;

  protected constructor(rootDirectory: string) {
    this.rootDirectory = path.resolve(rootDirectory);
  }

  protected runDirectory(runId: RunId): string {
    const validated = RunIdSchema.parse(runId);
    const target = path.resolve(this.rootDirectory, validated);
    if (path.dirname(target) !== this.rootDirectory) {
      throw new HoneyBeeCoreError("run.invalid-path", "Run path escaped the run repository.");
    }
    return target;
  }

  protected async requireRunDirectory(runId: RunId): Promise<string> {
    const directory = this.runDirectory(runId);
    try {
      const entry = await lstat(directory);
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("not a real directory");
      return directory;
    } catch (error) {
      if (error instanceof HoneyBeeCoreError) throw error;
      throw new HoneyBeeCoreError("run.not-found", `Run ${runId} does not exist.`);
    }
  }
}

export class FileRunRepository extends FileRunScopedStore implements RunRepository {
  public constructor(rootDirectory: string) {
    super(rootDirectory);
  }

  public async create(runId: RunId): Promise<void> {
    const directory = this.runDirectory(runId);
    await mkdir(this.rootDirectory, { recursive: true });
    try {
      await mkdir(directory);
    } catch (error) {
      if (errorCode(error) === "EEXIST") {
        throw new HoneyBeeCoreError("run.already-exists", `Run ${runId} already exists.`);
      }
      throw new HoneyBeeCoreError("run.invalid-path", `Could not create run ${runId}.`);
    }
    try {
      await mkdir(path.join(directory, "control", "inbox"), { recursive: true });
    } catch {
      await rm(directory, { recursive: true, force: true });
      throw new HoneyBeeCoreError("run.invalid-path", `Could not initialize run ${runId}.`);
    }
  }

  public async open(runId: RunId): Promise<RunRecord> {
    await this.requireRunDirectory(runId);
    return { runId: RunIdSchema.parse(runId) };
  }

  public async delete(runId: RunId): Promise<void> {
    const directory = await this.requireRunDirectory(runId);
    await rm(directory, { recursive: true, force: false });
  }
}

export class FileArtifactStore extends FileRunScopedStore implements ArtifactStore {
  public constructor(rootDirectory: string) {
    super(rootDirectory);
  }

  public async put(request: ArtifactPutRequest): Promise<ArtifactRef> {
    return this.putBytes({ ...request, content: Buffer.from(request.content, "utf8") });
  }

  public async putBytes(request: ArtifactPutBytesRequest): Promise<ArtifactRef> {
    const runId = RunIdSchema.parse(request.runId);
    const artifactId = ArtifactIdSchema.parse(request.artifactId);
    const kind = ArtifactKindSchema.parse(request.kind);
    const mediaType = ArtifactMediaTypeSchema.parse(request.mediaType);
    const bytes = Buffer.from(request.content);
    const contentDigest = digest(bytes);
    const artifact = ArtifactRefSchema.parse({
      artifactId,
      kind,
      mediaType,
      byteLength: bytes.byteLength,
      contentDigest,
    });
    const runDirectory = await this.requireRunDirectory(runId);
    const temporaryDirectory = path.join(runDirectory, "tmp");
    const destination = this.blobPath(runDirectory, contentDigest);
    await mkdir(temporaryDirectory, { recursive: true });
    await mkdir(path.dirname(destination), { recursive: true });
    const temporaryPath = path.join(temporaryDirectory, `${randomUUID()}.tmp`);
    let temporaryExists = false;

    try {
      const handle = await open(temporaryPath, "wx");
      temporaryExists = true;
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }

      await this.verifyFile(temporaryPath, artifact);
      try {
        await link(temporaryPath, destination);
      } catch (error) {
        if (errorCode(error) !== "EEXIST") {
          throw new HoneyBeeCoreError(
            "artifact.publish-failed",
            "The Artifact blob could not be published without overwrite.",
          );
        }
        await this.verifyFile(destination, artifact);
      }
      return artifact;
    } catch (error) {
      if (error instanceof HoneyBeeCoreError) throw error;
      throw new HoneyBeeCoreError("artifact.write-failed", "The Artifact could not be stored.");
    } finally {
      if (temporaryExists) await unlink(temporaryPath).catch(() => undefined);
    }
  }

  public async get(request: ArtifactGetRequest): Promise<string> {
    return Buffer.from(await this.getBytes(request)).toString("utf8");
  }

  public async getBytes(request: ArtifactGetRequest): Promise<Uint8Array> {
    const runId = RunIdSchema.parse(request.runId);
    const artifact = ArtifactRefSchema.parse(request.artifact);
    try {
      const runDirectory = await this.requireRunDirectory(runId);
      const blob = this.blobPath(runDirectory, artifact.contentDigest);
      const bytes = await this.verifyFile(blob, artifact);
      return bytes;
    } catch (error) {
      if (error instanceof HoneyBeeCoreError) throw error;
      throw new HoneyBeeCoreError("artifact.read-failed", "The Artifact could not be read.");
    }
  }

  private blobPath(runDirectory: string, contentDigest: ArtifactRef["contentDigest"]): string {
    const hex = ContentDigestSchema.parse(contentDigest).slice("sha256:".length);
    return path.join(runDirectory, "blobs", "sha256", hex.slice(0, 2), hex.slice(2));
  }

  private async verifyFile(filePath: string, artifact: ArtifactRef): Promise<Buffer> {
    try {
      const entry = await lstat(filePath);
      if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("not a real file");
      const bytes = await readFile(filePath);
      if (bytes.byteLength !== artifact.byteLength || digest(bytes) !== artifact.contentDigest) {
        throw new HoneyBeeCoreError(
          "artifact.integrity-failed",
          `Artifact ${artifact.artifactId} failed its integrity check.`,
        );
      }
      return bytes;
    } catch (error) {
      if (error instanceof HoneyBeeCoreError) throw error;
      throw new HoneyBeeCoreError(
        "artifact.integrity-failed",
        `Artifact ${artifact.artifactId} failed its integrity check.`,
      );
    }
  }
}

const parseEvent = (value: unknown): AnyOrchestrationEvent | undefined => {
  const version =
    typeof value === "object" && value !== null && "schemaVersion" in value
      ? value.schemaVersion
      : undefined;
  const parsed =
    version === 1
      ? OrchestrationEventV1Schema.safeParse(value)
      : version === 2
        ? OrchestrationEventV2Schema.safeParse(value)
        : version === 3
          ? OrchestrationEventV3Schema.safeParse(value)
          : version === 4
            ? OrchestrationEventV4Schema.safeParse(value)
            : version === 5
              ? OrchestrationEventV5Schema.safeParse(value)
              : undefined;
  return parsed?.success === true ? parsed.data : undefined;
};

const isTerminal = (event: AnyOrchestrationEvent): boolean =>
  event.schemaVersion === 1
    ? TERMINAL_WORKFLOW_EVENT_TYPES.has(event.type as TerminalWorkflowEvent["type"])
    : event.schemaVersion === 2
      ? TERMINAL_WORKFLOW_EVENT_V2_TYPES.has(event.type as TerminalWorkflowEventV2["type"])
      : event.schemaVersion === 3
        ? TERMINAL_WORKFLOW_EVENT_V3_TYPES.has(event.type as TerminalWorkflowEventV3["type"])
        : event.schemaVersion === 4
          ? TERMINAL_WORKFLOW_EVENT_V4_TYPES.has(event.type as TerminalWorkflowEventV4["type"])
          : TERMINAL_WORKFLOW_EVENT_V5_TYPES.has(event.type as TerminalWorkflowEventV5["type"]);

const sameArtifactRef = (left: ArtifactRef | undefined, right: ArtifactRef | undefined): boolean =>
  left === undefined || right === undefined
    ? left === right
    : left.artifactId === right.artifactId &&
      left.kind === right.kind &&
      left.mediaType === right.mediaType &&
      left.byteLength === right.byteLength &&
      left.contentDigest === right.contentDigest;

const sameFailureMetadata = (
  left: FailureMetadata | undefined,
  right: FailureMetadata | undefined,
): boolean =>
  left === undefined || right === undefined
    ? left === right
    : left.errorCode === right.errorCode &&
      left.exitCode === right.exitCode &&
      left.signal === right.signal &&
      left.durationMs === right.durationMs &&
      left.stdoutBytes === right.stdoutBytes &&
      left.stderrBytes === right.stderrBytes;

const validV3Transitions = (events: readonly OrchestrationEventV3[]): boolean => {
  let phase:
    | "started"
    | "baselined"
    | "prepared"
    | "acquiring"
    | "acquire-failed"
    | "acquired"
    | "agent"
    | "agent-exited"
    | "testplay"
    | "testplay-exited"
    | "evidence"
    | "verified"
    | "source-verified"
    | "decided"
    | "releasing"
    | "release-failed"
    | "released"
    | "terminal" = "started";
  let acquired = false;
  let decided = false;
  let testplayVerified = false;
  let sourceUnchanged: boolean | undefined;
  let decisionOutcome: "completed" | "failed" | "cancelled" | undefined;
  let decisionFailure: FailureMetadata | undefined;
  let acquireFailure: FailureMetadata | undefined;
  let storedEvidence: ArtifactRef | undefined;
  let verifiedEvidence: ArtifactRef | undefined;
  let sourceBaseline: ArtifactRef | undefined;
  let sourceAfter: ArtifactRef | undefined;
  let releaseReceipt: ArtifactRef | undefined;
  let agentStarted: Extract<OrchestrationEventV3, { type: "agent.started" }> | undefined;
  let testplayStarted: Extract<OrchestrationEventV3, { type: "testplay.started" }> | undefined;
  let agentContainmentRegistered = false;
  let testplayContainmentRegistered = false;
  let agentDrained = false;
  let testplayDrained = false;

  for (const event of events.slice(1)) {
    switch (event.type) {
      case "artifact.stored":
        break;
      case "control.accepted":
        if (
          !acquired ||
          decided ||
          ![
            "acquired",
            "agent",
            "agent-exited",
            "testplay",
            "testplay-exited",
            "evidence",
            "verified",
            "source-verified",
          ].includes(phase)
        ) {
          return false;
        }
        break;
      case "workspace.prepared":
        if (phase !== "baselined") return false;
        phase = "prepared";
        break;
      case "source.baselined":
        if (phase !== "started") return false;
        sourceBaseline = event.payload.manifest;
        phase = "baselined";
        break;
      case "workspace.acquire-started":
        if (phase !== "prepared") return false;
        phase = "acquiring";
        break;
      case "workspace.acquire-failed":
        if (phase !== "acquiring") return false;
        acquireFailure = event.payload.failure;
        phase = "acquire-failed";
        break;
      case "workspace.acquired":
        if (phase !== "acquiring") return false;
        acquired = true;
        phase = "acquired";
        break;
      case "agent.started":
        if (phase !== "acquired") return false;
        agentStarted = event;
        agentContainmentRegistered = false;
        agentDrained = false;
        phase = "agent";
        break;
      case "process.containment-registered":
        if (event.payload.process === "agent") {
          if (
            phase !== "agent" ||
            agentStarted === undefined ||
            agentStarted.payload.containment !== "deferred-v1" ||
            agentContainmentRegistered ||
            event.payload.startedEventId !== agentStarted.eventId ||
            event.stepId !== agentStarted.stepId
          ) {
            return false;
          }
          agentContainmentRegistered = true;
        } else {
          if (
            phase !== "testplay" ||
            testplayStarted === undefined ||
            testplayStarted.payload.containment !== "deferred-v1" ||
            testplayContainmentRegistered ||
            event.payload.startedEventId !== testplayStarted.eventId
          ) {
            return false;
          }
          testplayContainmentRegistered = true;
        }
        break;
      case "agent.exited":
        if (
          phase !== "agent" ||
          (agentStarted?.payload.containment === "deferred-v1" && !agentContainmentRegistered)
        ) {
          return false;
        }
        phase = "agent-exited";
        break;
      case "agent.input-write-failed":
        if (!["agent", "agent-exited"].includes(phase)) return false;
        break;
      case "testplay.started":
        if (phase !== "agent-exited") return false;
        testplayStarted = event;
        testplayContainmentRegistered = false;
        testplayDrained = false;
        phase = "testplay";
        break;
      case "testplay.exited":
        if (
          phase !== "testplay" ||
          (testplayStarted?.payload.containment === "deferred-v1" && !testplayContainmentRegistered)
        ) {
          return false;
        }
        phase = "testplay-exited";
        break;
      case "testplay.evidence-stored":
        if (phase !== "testplay-exited") return false;
        storedEvidence = event.payload.evidence;
        phase = "evidence";
        break;
      case "testplay.verified":
        if (phase !== "evidence" || !sameArtifactRef(event.payload.evidence, storedEvidence)) {
          return false;
        }
        testplayVerified = true;
        verifiedEvidence = event.payload.evidence;
        phase = "verified";
        break;
      case "process.drain-completed":
        if (event.payload.process === "agent") {
          if (
            !["agent", "agent-exited"].includes(phase) ||
            agentStarted === undefined ||
            agentDrained ||
            event.payload.startedEventId !== agentStarted.eventId ||
            event.stepId !== agentStarted.stepId
          ) {
            return false;
          }
          agentDrained = true;
          phase = "agent-exited";
        } else {
          if (
            !["testplay", "testplay-exited"].includes(phase) ||
            testplayStarted === undefined ||
            testplayDrained ||
            event.payload.startedEventId !== testplayStarted.eventId
          ) {
            return false;
          }
          testplayDrained = true;
          phase = "testplay-exited";
        }
        break;
      case "source.checked":
        if (
          !sameArtifactRef(event.payload.before, sourceBaseline) ||
          ![
            "acquired",
            "agent",
            "agent-exited",
            "testplay",
            "testplay-exited",
            "evidence",
            "verified",
          ].includes(phase)
        ) {
          return false;
        }
        sourceUnchanged = event.payload.unchanged;
        sourceAfter = event.payload.after;
        phase = "source-verified";
        break;
      case "transaction.outcome-decided":
        if (
          decided ||
          ![
            "acquired",
            "agent",
            "agent-exited",
            "testplay",
            "testplay-exited",
            "evidence",
            "verified",
            "source-verified",
          ].includes(phase)
        ) {
          return false;
        }
        if (
          event.payload.outcome === "completed" &&
          (phase !== "source-verified" || !testplayVerified || sourceUnchanged !== true)
        ) {
          return false;
        }
        decided = true;
        decisionOutcome = event.payload.outcome;
        decisionFailure = event.payload.outcome === "failed" ? event.payload.failure : undefined;
        phase = "decided";
        break;
      case "workspace.release-started":
        if (!acquired || !decided || !["decided", "release-failed"].includes(phase)) return false;
        phase = "releasing";
        break;
      case "workspace.release-failed":
        if (phase !== "releasing") return false;
        phase = "release-failed";
        break;
      case "workspace.released":
        if (phase !== "releasing") return false;
        releaseReceipt = event.payload.receipt;
        phase = "released";
        break;
      case "workflow.completed":
        if (
          !acquired ||
          phase !== "released" ||
          decisionOutcome !== "completed" ||
          !sameArtifactRef(event.payload.evidence, verifiedEvidence) ||
          !sameArtifactRef(event.payload.sourceAfter, sourceAfter) ||
          !sameArtifactRef(event.payload.release, releaseReceipt)
        ) {
          return false;
        }
        phase = "terminal";
        break;
      case "workflow.failed":
        if (
          acquired
            ? phase !== "released" ||
              decisionOutcome !== "failed" ||
              !sameFailureMetadata(event.payload.failure, decisionFailure) ||
              !sameArtifactRef(event.payload.release, releaseReceipt) ||
              !sameArtifactRef(event.payload.sourceAfter, sourceAfter)
            : !["started", "baselined", "prepared", "acquire-failed"].includes(phase) ||
              (acquireFailure !== undefined &&
                !sameFailureMetadata(event.payload.failure, acquireFailure)) ||
              event.payload.release !== undefined ||
              event.payload.sourceAfter !== undefined
        ) {
          return false;
        }
        phase = "terminal";
        break;
      case "workflow.cancelled":
        if (
          !acquired ||
          phase !== "released" ||
          decisionOutcome !== "cancelled" ||
          !sameArtifactRef(event.payload.release, releaseReceipt) ||
          !sameArtifactRef(event.payload.sourceAfter, sourceAfter)
        ) {
          return false;
        }
        phase = "terminal";
        break;
      case "workflow.started":
        return false;
    }
  }
  return true;
};

const validV4BatchTransitions = (events: readonly OrchestrationEventV4[]): boolean => {
  const start = events[0];
  if (start?.type !== "workflow.started" || start.payload.mode !== "unity-batch-v1") return false;
  const registered = new Map<string, { childRunId: RunId; resourceId: string }>();
  const finished = new Map<
    string,
    Extract<OrchestrationEventV4, { type: "work.finished" }>["payload"]
  >();
  let cancelRequestId: string | undefined;
  let cancelling = false;

  const summary = () => {
    const values = [...finished.values()];
    return {
      total: values.length,
      completed: values.filter((value) => value.status === "completed").length,
      failed: values.filter((value) => value.status === "failed").length,
      cancelled: values.filter((value) => value.status === "cancelled").length,
    };
  };
  const sameSummary = (value: {
    total: number;
    completed: number;
    failed: number;
    cancelled: number;
  }) => {
    const expected = summary();
    return (
      value.total === expected.total &&
      value.completed === expected.completed &&
      value.failed === expected.failed &&
      value.cancelled === expected.cancelled
    );
  };

  for (const event of events.slice(1)) {
    switch (event.type) {
      case "artifact.stored":
        break;
      case "work.registered":
        if (
          registered.size >= start.payload.workCount ||
          registered.has(event.payload.workId) ||
          [...registered.values()].some((value) => value.childRunId === event.payload.childRunId)
        ) {
          return false;
        }
        registered.set(event.payload.workId, {
          childRunId: event.payload.childRunId,
          resourceId: event.payload.resourceId,
        });
        break;
      case "work.finished": {
        const registration = registered.get(event.payload.workId);
        if (
          registration === undefined ||
          registration.childRunId !== event.payload.childRunId ||
          finished.has(event.payload.workId)
        ) {
          return false;
        }
        finished.set(event.payload.workId, event.payload);
        break;
      }
      case "control.accepted":
        if (cancelRequestId !== undefined) return false;
        cancelRequestId = event.payload.requestId;
        break;
      case "workflow.cancelling":
        if (
          cancelRequestId === undefined ||
          event.payload.requestId !== cancelRequestId ||
          cancelling
        ) {
          return false;
        }
        cancelling = true;
        break;
      case "workflow.completed":
        if (
          !("summary" in event.payload) ||
          registered.size !== start.payload.workCount ||
          finished.size !== registered.size ||
          !sameSummary(event.payload.summary) ||
          event.payload.summary.completed !== event.payload.summary.total
        ) {
          return false;
        }
        break;
      case "workflow.failed":
        if (
          !("summary" in event.payload) ||
          registered.size !== start.payload.workCount ||
          finished.size !== registered.size ||
          !sameSummary(event.payload.summary) ||
          (event.payload.summary.failed === 0 &&
            (cancelling || event.payload.summary.cancelled === 0))
        ) {
          return false;
        }
        break;
      case "workflow.cancelled":
        if (
          !("summary" in event.payload) ||
          !cancelling ||
          registered.size !== start.payload.workCount ||
          finished.size !== registered.size ||
          !sameSummary(event.payload.summary) ||
          event.payload.summary.failed !== 0
        ) {
          return false;
        }
        break;
      default:
        return false;
    }
  }
  return true;
};

const childV4AsV3 = (
  events: readonly OrchestrationEventV4[],
): readonly OrchestrationEventV3[] | undefined => {
  const values: unknown[] = [];
  for (const event of events) {
    if (
      event.type.startsWith("resource.") ||
      event.type === "patch.verified" ||
      event.type === "work.registered" ||
      event.type === "work.finished" ||
      event.type === "workflow.cancelling"
    ) {
      continue;
    }
    if (event.type === "workflow.started") {
      if (event.payload.mode !== "unity-work-v2") return undefined;
      values.push({
        ...event,
        schemaVersion: 3,
        payload: { mode: "unity-work-v1", config: event.payload.config, task: event.payload.task },
      });
      continue;
    }
    if (event.type === "workflow.completed") {
      if (!("patch" in event.payload)) return undefined;
      values.push({
        ...event,
        schemaVersion: 3,
        payload: {
          evidence: event.payload.evidence,
          release: event.payload.release,
          sourceAfter: event.payload.sourceAfter,
        },
      });
      continue;
    }
    if (event.type === "workflow.failed") {
      if ("summary" in event.payload) return undefined;
      values.push({ ...event, schemaVersion: 3 });
      continue;
    }
    if (event.type === "workflow.cancelled") {
      if ("summary" in event.payload) return undefined;
      values.push({ ...event, schemaVersion: 3 });
      continue;
    }
    values.push({ ...event, schemaVersion: 3 });
  }
  const parsed: OrchestrationEventV3[] = [];
  for (const value of values) {
    const result = OrchestrationEventV3Schema.safeParse(value);
    if (!result.success) return undefined;
    parsed.push(result.data);
  }
  return parsed;
};

const validV4ChildTransitions = (events: readonly OrchestrationEventV4[]): boolean => {
  const start = events[0];
  if (start?.type !== "workflow.started" || start.payload.mode !== "unity-work-v2") return false;
  const asV3 = childV4AsV3(events);
  if (asV3 === undefined || !validV3Transitions(asV3)) return false;

  type ResourcePhase =
    "none" | "starting" | "queued" | "acquired" | "releasing" | "failed" | "cancelled" | "released";
  let resourcePhase: ResourcePhase = "none";
  let requestId: string | undefined;
  let resourceId: string | undefined;
  let ticket: number | undefined;
  let leaseId: string | undefined;
  let agentExited = false;
  let testplayStarted = false;
  let testplayStopped = false;
  let sourceChecked = false;
  let decisionRecorded = false;
  const baseline = events.find((event) => event.type === "source.baselined");
  let patch: Extract<OrchestrationEventV4, { type: "patch.verified" }>["payload"] | undefined;

  const sameLease = (payload: {
    resourceId: string;
    requestId: string;
    ticket: number;
    leaseId: string;
  }) =>
    payload.resourceId === resourceId &&
    payload.requestId === requestId &&
    payload.ticket === ticket &&
    payload.leaseId === leaseId;

  for (const event of events.slice(1)) {
    switch (event.type) {
      case "agent.exited":
        agentExited = true;
        break;
      case "resource.acquire-started":
        if (!agentExited || resourcePhase !== "none") return false;
        if (event.payload.resourceId !== start.payload.linkage.resourceId) return false;
        resourceId = event.payload.resourceId;
        requestId = event.payload.requestId;
        resourcePhase = "starting";
        break;
      case "resource.queued":
        if (
          resourcePhase !== "starting" ||
          event.payload.resourceId !== resourceId ||
          event.payload.requestId !== requestId
        )
          return false;
        ticket = event.payload.ticket;
        resourcePhase = "queued";
        break;
      case "resource.acquire-failed":
        if (
          !["starting", "queued"].includes(resourcePhase) ||
          event.payload.resourceId !== resourceId ||
          event.payload.requestId !== requestId
        )
          return false;
        resourcePhase = "failed";
        break;
      case "resource.acquired":
        if (
          resourcePhase !== "queued" ||
          event.payload.resourceId !== resourceId ||
          event.payload.requestId !== requestId ||
          event.payload.ticket !== ticket
        )
          return false;
        leaseId = event.payload.leaseId;
        resourcePhase = "acquired";
        break;
      case "resource.acquire-cancelled":
        if (
          !["starting", "queued"].includes(resourcePhase) ||
          event.payload.resourceId !== resourceId ||
          event.payload.requestId !== requestId
        )
          return false;
        resourcePhase = "cancelled";
        break;
      case "testplay.started":
        if (resourcePhase !== "acquired" || testplayStarted) return false;
        testplayStarted = true;
        break;
      case "testplay.exited":
        testplayStopped = true;
        break;
      case "process.drain-completed":
        if (event.payload.process === "testplay") testplayStopped = true;
        break;
      case "resource.release-started":
        if (
          resourcePhase !== "acquired" ||
          (testplayStarted && !testplayStopped) ||
          !sameLease(event.payload)
        )
          return false;
        resourcePhase = "releasing";
        break;
      case "resource.release-failed":
        if (resourcePhase !== "releasing" || !sameLease(event.payload)) return false;
        resourcePhase = "acquired";
        break;
      case "resource.released":
        if (resourcePhase !== "releasing" || !sameLease(event.payload)) return false;
        resourcePhase = "released";
        break;
      case "source.checked":
        if (["starting", "queued", "acquired", "releasing"].includes(resourcePhase)) return false;
        sourceChecked = event.payload.unchanged;
        break;
      case "patch.verified":
        if (
          !sourceChecked ||
          resourcePhase !== "released" ||
          patch !== undefined ||
          decisionRecorded ||
          baseline?.type !== "source.baselined" ||
          !sameArtifactRef(event.payload.baseManifest, baseline.payload.manifest)
        )
          return false;
        patch = event.payload;
        break;
      case "transaction.outcome-decided":
        if (event.payload.outcome === "completed" && patch === undefined) return false;
        decisionRecorded = true;
        break;
      case "workflow.completed":
        if (
          !("patch" in event.payload) ||
          patch === undefined ||
          !sameArtifactRef(event.payload.patch, patch.patch) ||
          !sameArtifactRef(event.payload.resultManifest, patch.resultManifest)
        )
          return false;
        break;
      default:
        break;
    }
  }
  return true;
};

const validV4Transitions = (events: readonly OrchestrationEventV4[]): boolean => {
  const start = events[0];
  if (start?.type !== "workflow.started") return false;
  return start.payload.mode === "unity-batch-v1"
    ? validV4BatchTransitions(events)
    : validV4ChildTransitions(events);
};

const validV5BatchTransitions = (events: readonly OrchestrationEventV5[]): boolean => {
  const start = events[0];
  if (start?.type !== "workflow.started" || start.payload.mode !== "unity-batch-v2") return false;
  const registered = new Map<
    string,
    Readonly<{ childRunId: RunId; priority: string; capabilityCount: number }>
  >();
  const finished = new Map<
    string,
    Extract<OrchestrationEventV5, { type: "work.finished" }>["payload"]
  >();
  let cancelRequestId: string | undefined;
  let cancelling = false;

  const expectedSummary = () => {
    const values = [...finished.values()];
    return {
      total: values.length,
      completed: values.filter((value) => value.status === "completed").length,
      failed: values.filter((value) => value.status === "failed").length,
      cancelled: values.filter((value) => value.status === "cancelled").length,
    };
  };
  const sameSummary = (value: {
    total: number;
    completed: number;
    failed: number;
    cancelled: number;
  }) => {
    const expected = expectedSummary();
    return (
      value.total === expected.total &&
      value.completed === expected.completed &&
      value.failed === expected.failed &&
      value.cancelled === expected.cancelled
    );
  };

  for (const event of events.slice(1)) {
    switch (event.type) {
      case "artifact.stored":
        break;
      case "work.registered":
        if (
          registered.size >= start.payload.workCount ||
          registered.has(event.payload.workId) ||
          [...registered.values()].some((value) => value.childRunId === event.payload.childRunId)
        ) {
          return false;
        }
        registered.set(event.payload.workId, {
          childRunId: event.payload.childRunId,
          priority: event.payload.priority,
          capabilityCount: event.payload.capabilityCount,
        });
        break;
      case "work.finished": {
        const registration = registered.get(event.payload.workId);
        if (
          registration === undefined ||
          registration.childRunId !== event.payload.childRunId ||
          finished.has(event.payload.workId)
        ) {
          return false;
        }
        finished.set(event.payload.workId, event.payload);
        break;
      }
      case "control.accepted":
        if (cancelRequestId !== undefined) return false;
        cancelRequestId = event.payload.requestId;
        break;
      case "workflow.cancelling":
        if (cancelRequestId !== event.payload.requestId || cancelling) return false;
        cancelling = true;
        break;
      case "workflow.completed":
        if (
          !("summary" in event.payload) ||
          registered.size !== start.payload.workCount ||
          finished.size !== registered.size ||
          !sameSummary(event.payload.summary) ||
          event.payload.summary.completed !== event.payload.summary.total
        ) {
          return false;
        }
        break;
      case "workflow.failed":
        if (
          !("summary" in event.payload) ||
          registered.size !== start.payload.workCount ||
          finished.size !== registered.size ||
          !sameSummary(event.payload.summary) ||
          (event.payload.summary.failed === 0 && event.payload.summary.cancelled === 0)
        ) {
          return false;
        }
        break;
      case "workflow.cancelled":
        if (
          !("summary" in event.payload) ||
          !cancelling ||
          registered.size !== start.payload.workCount ||
          finished.size !== registered.size ||
          !sameSummary(event.payload.summary) ||
          event.payload.summary.failed !== 0
        ) {
          return false;
        }
        break;
      default:
        return false;
    }
  }
  return true;
};

const validV5ChildTransitions = (events: readonly OrchestrationEventV5[]): boolean => {
  const start = events[0];
  if (start?.type !== "workflow.started" || start.payload.mode !== "unity-work-v3") return false;
  const linkage = start.payload.linkage;
  const stored = new Set<string>();
  let sourceBaseline: ArtifactRef | undefined;
  let sourceAfter: ArtifactRef | undefined;
  let workspacePhase:
    "none" | "prepared" | "acquiring" | "acquire-failed" | "acquired" | "releasing" | "released" =
    "none";
  let workspaceLeaseId: string | undefined;
  let workspaceRelease: ArtifactRef | undefined;
  let agentPhase: "none" | "started" | "exited" = "none";
  let agentStartedEventId: string | undefined;
  let agentRegistered = false;
  let agentDrained = false;
  let poolPhase:
    | "none"
    | "requested"
    | "queued"
    | "acquired"
    | "cancelled"
    | "failed"
    | "releasing"
    | "released" = "none";
  let poolRequestId: string | undefined;
  let poolTicket: number | undefined;
  let poolLeaseId: string | undefined;
  let poolSlotId: string | undefined;
  let launchPhase:
    | "none"
    | "intended"
    | "contained"
    | "activated"
    | "owned"
    | "bound"
    | "stopping"
    | "exited"
    | "drained" = "none";
  let launchId: string | undefined;
  let editorId: string | undefined;
  let containmentReceipt: ArtifactRef | undefined;
  let nextCapability = 0;
  let activeCapability:
    | Readonly<{
        id: string;
        index: number;
        kind: "compile" | "warm-test";
        processEventId?: string;
        processRegistered?: boolean;
        processDone?: boolean;
      }>
    | undefined;
  let capabilityFailed = false;
  const evidence: ArtifactRef[] = [];
  let sourceUnchanged = false;
  let patch: Extract<OrchestrationEventV5, { type: "patch.verified" }>["payload"] | undefined;
  let decision:
    Extract<OrchestrationEventV5, { type: "transaction.outcome-decided" }>["payload"] | undefined;

  const artifactStored = (artifact: ArtifactRef): boolean => stored.has(artifact.artifactId);
  const samePoolRequest = (payload: { poolId: string; requestId: string; priority: string }) =>
    payload.poolId === linkage.poolId &&
    payload.requestId === poolRequestId &&
    payload.priority === linkage.priority;
  const samePoolLease = (payload: {
    poolId: string;
    requestId: string;
    priority: string;
    ticket: number;
    leaseId: string;
    slotId: string;
  }) =>
    samePoolRequest(payload) &&
    payload.ticket === poolTicket &&
    payload.leaseId === poolLeaseId &&
    payload.slotId === poolSlotId;
  const sameCapability = (payload: { capabilityId: string; index: number; kind: string }) =>
    activeCapability !== undefined &&
    payload.capabilityId === activeCapability.id &&
    payload.index === activeCapability.index &&
    payload.kind === activeCapability.kind;

  for (const event of events.slice(1)) {
    switch (event.type) {
      case "artifact.stored":
        stored.add(event.payload.artifact.artifactId);
        break;
      case "source.baselined":
        if (sourceBaseline !== undefined || !artifactStored(event.payload.manifest)) return false;
        sourceBaseline = event.payload.manifest;
        break;
      case "workspace.prepared":
        if (
          workspacePhase !== "none" ||
          sourceBaseline === undefined ||
          !sameArtifactRef(event.payload.sourceManifest, sourceBaseline)
        )
          return false;
        workspacePhase = "prepared";
        break;
      case "workspace.acquire-started":
        if (workspacePhase !== "prepared" || !artifactStored(event.payload.request)) return false;
        workspacePhase = "acquiring";
        break;
      case "workspace.acquire-failed":
        if (workspacePhase !== "acquiring") return false;
        workspacePhase = "acquire-failed";
        break;
      case "workspace.acquired":
        if (workspacePhase !== "acquiring" || !artifactStored(event.payload.receipt)) return false;
        workspacePhase = "acquired";
        workspaceLeaseId = event.payload.leaseId;
        break;
      case "agent.started":
        if (workspacePhase !== "acquired" || agentPhase !== "none") return false;
        agentPhase = "started";
        agentStartedEventId = event.eventId;
        break;
      case "process.containment-registered":
        if (
          agentPhase !== "started" ||
          agentRegistered ||
          event.payload.startedEventId !== agentStartedEventId
        )
          return false;
        agentRegistered = true;
        break;
      case "agent.exited":
        if (agentPhase !== "started" || !agentRegistered) return false;
        agentPhase = "exited";
        break;
      case "agent.input-write-failed":
        if (agentPhase !== "started" && agentPhase !== "exited") return false;
        break;
      case "process.drain-completed":
        if (
          agentStartedEventId === undefined ||
          event.payload.startedEventId !== agentStartedEventId ||
          agentDrained
        )
          return false;
        agentDrained = true;
        agentPhase = "exited";
        break;
      case "editor.pool-requested":
        if (agentPhase !== "exited" || poolPhase !== "none") return false;
        if (event.payload.poolId !== linkage.poolId || event.payload.priority !== linkage.priority)
          return false;
        poolRequestId = event.payload.requestId;
        poolPhase = "requested";
        break;
      case "editor.pool-queued":
        if (poolPhase !== "requested" || !samePoolRequest(event.payload)) return false;
        poolTicket = event.payload.ticket;
        poolPhase = "queued";
        break;
      case "editor.pool-acquire-failed":
        if (!["requested", "queued"].includes(poolPhase) || !samePoolRequest(event.payload))
          return false;
        poolPhase = "failed";
        break;
      case "editor.pool-cancelled":
        if (!["requested", "queued"].includes(poolPhase) || !samePoolRequest(event.payload))
          return false;
        poolPhase = "cancelled";
        break;
      case "editor.pool-acquired":
        if (
          poolPhase !== "queued" ||
          !samePoolRequest(event.payload) ||
          event.payload.ticket !== poolTicket
        )
          return false;
        poolLeaseId = event.payload.leaseId;
        poolSlotId = event.payload.slotId;
        poolPhase = "acquired";
        break;
      case "editor.launch-intended":
        if (
          poolPhase !== "acquired" ||
          launchPhase !== "none" ||
          event.payload.leaseId !== poolLeaseId ||
          event.payload.slotId !== poolSlotId ||
          !artifactStored(event.payload.intent)
        )
          return false;
        launchId = event.payload.launchId;
        launchPhase = "intended";
        break;
      case "editor.containment-registered":
        if (
          launchPhase !== "intended" ||
          event.payload.launchId !== launchId ||
          !artifactStored(event.payload.receipt)
        )
          return false;
        containmentReceipt = event.payload.receipt;
        launchPhase = "contained";
        break;
      case "editor.launch-abandoned":
        if (launchPhase !== "intended" || event.payload.launchId !== launchId) return false;
        launchPhase = "drained";
        break;
      case "editor.activated":
        if (launchPhase !== "contained" || event.payload.launchId !== launchId) return false;
        launchPhase = "activated";
        break;
      case "editor.ownership-established":
        if (
          launchPhase !== "activated" ||
          event.payload.launchId !== launchId ||
          event.payload.slotId !== poolSlotId ||
          !artifactStored(event.payload.receipt)
        )
          return false;
        editorId = event.payload.editorId;
        launchPhase = "owned";
        break;
      case "editor.bridge-bound":
        if (
          launchPhase !== "owned" ||
          event.payload.editorId !== editorId ||
          !artifactStored(event.payload.binding)
        )
          return false;
        launchPhase = "bound";
        break;
      case "capability.started":
        if (
          launchPhase !== "bound" ||
          activeCapability !== undefined ||
          capabilityFailed ||
          event.payload.index !== nextCapability ||
          event.payload.index >= linkage.capabilityCount
        )
          return false;
        activeCapability = {
          id: event.payload.capabilityId,
          index: event.payload.index,
          kind: event.payload.kind,
        };
        break;
      case "capability.process-started":
        if (!sameCapability(event.payload) || activeCapability?.processEventId !== undefined)
          return false;
        if (activeCapability === undefined) return false;
        activeCapability = {
          ...activeCapability,
          processEventId: event.eventId,
          processRegistered: false,
          processDone: false,
        };
        break;
      case "capability.process-registered":
        if (
          !sameCapability(event.payload) ||
          activeCapability?.processEventId === undefined ||
          activeCapability.processRegistered === true ||
          event.payload.startedEventId !== activeCapability.processEventId
        )
          return false;
        activeCapability = { ...activeCapability, processRegistered: true };
        break;
      case "capability.process-exited":
        if (
          !sameCapability(event.payload) ||
          activeCapability?.processEventId === undefined ||
          activeCapability.processRegistered !== true
        )
          return false;
        activeCapability = { ...activeCapability, processDone: true };
        break;
      case "capability.process-drained":
        if (
          !sameCapability(event.payload) ||
          activeCapability?.processEventId === undefined ||
          event.payload.startedEventId !== activeCapability.processEventId
        )
          return false;
        activeCapability = { ...activeCapability, processDone: true };
        break;
      case "capability.completed":
        if (
          !sameCapability(event.payload) ||
          (activeCapability?.processEventId !== undefined &&
            activeCapability.processDone !== true) ||
          !artifactStored(event.payload.evidence)
        )
          return false;
        evidence.push(event.payload.evidence);
        nextCapability += 1;
        activeCapability = undefined;
        break;
      case "capability.failed":
        if (
          !sameCapability(event.payload) ||
          (activeCapability?.processEventId !== undefined && activeCapability.processDone !== true)
        )
          return false;
        capabilityFailed = true;
        activeCapability = undefined;
        break;
      case "editor.stop-started":
        if (
          !["owned", "bound"].includes(launchPhase) ||
          activeCapability !== undefined ||
          event.payload.editorId !== editorId ||
          event.payload.launchId !== launchId
        )
          return false;
        launchPhase = "stopping";
        break;
      case "editor.exited":
        if (
          launchPhase !== "stopping" ||
          event.payload.editorId !== editorId ||
          event.payload.launchId !== launchId
        )
          return false;
        launchPhase = "exited";
        break;
      case "editor.containment-drained":
        if (
          !["contained", "activated", "exited"].includes(launchPhase) ||
          event.payload.launchId !== launchId ||
          containmentReceipt === undefined ||
          !sameArtifactRef(event.payload.receipt, containmentReceipt)
        )
          return false;
        launchPhase = "drained";
        break;
      case "editor.pool-release-started":
        if (
          poolPhase !== "acquired" ||
          (launchPhase !== "none" && launchPhase !== "drained") ||
          !samePoolLease(event.payload)
        )
          return false;
        poolPhase = "releasing";
        break;
      case "editor.pool-release-failed":
        if (poolPhase !== "releasing" || !samePoolLease(event.payload)) return false;
        poolPhase = "acquired";
        break;
      case "editor.pool-released":
        if (poolPhase !== "releasing" || !samePoolLease(event.payload)) return false;
        poolPhase = "released";
        break;
      case "source.checked":
        if (
          sourceBaseline === undefined ||
          !sameArtifactRef(event.payload.before, sourceBaseline) ||
          !artifactStored(event.payload.after) ||
          ["requested", "queued", "acquired", "releasing"].includes(poolPhase)
        )
          return false;
        sourceAfter = event.payload.after;
        sourceUnchanged = event.payload.unchanged;
        break;
      case "patch.verified":
        if (
          !sourceUnchanged ||
          sourceAfter === undefined ||
          poolPhase !== "released" ||
          nextCapability !== linkage.capabilityCount ||
          capabilityFailed ||
          patch !== undefined ||
          !artifactStored(event.payload.patch) ||
          !artifactStored(event.payload.resultManifest) ||
          !sameArtifactRef(event.payload.baseManifest, sourceBaseline)
        )
          return false;
        patch = event.payload;
        break;
      case "transaction.outcome-decided":
        if (
          decision !== undefined ||
          workspacePhase !== "acquired" ||
          sourceAfter === undefined ||
          (event.payload.outcome === "completed" && patch === undefined)
        )
          return false;
        decision = event.payload;
        break;
      case "control.accepted":
        if (workspacePhase !== "acquired" || decision !== undefined) return false;
        break;
      case "workspace.release-started":
        if (
          workspacePhase !== "acquired" ||
          decision === undefined ||
          event.payload.leaseId !== workspaceLeaseId
        )
          return false;
        workspacePhase = "releasing";
        break;
      case "workspace.release-failed":
        if (workspacePhase !== "releasing" || event.payload.leaseId !== workspaceLeaseId)
          return false;
        workspacePhase = "acquired";
        break;
      case "workspace.released":
        if (
          workspacePhase !== "releasing" ||
          event.payload.leaseId !== workspaceLeaseId ||
          !artifactStored(event.payload.receipt)
        )
          return false;
        workspaceRelease = event.payload.receipt;
        workspacePhase = "released";
        break;
      case "workflow.completed":
        if (
          !("patch" in event.payload) ||
          decision?.outcome !== "completed" ||
          workspacePhase !== "released" ||
          evidence.length === 0 ||
          patch === undefined ||
          !sameArtifactRef(event.payload.evidence, evidence.at(-1)) ||
          !sameArtifactRef(event.payload.patch, patch.patch) ||
          !sameArtifactRef(event.payload.resultManifest, patch.resultManifest) ||
          !sameArtifactRef(event.payload.release, workspaceRelease) ||
          !sameArtifactRef(event.payload.sourceAfter, sourceAfter)
        )
          return false;
        break;
      case "workflow.failed":
        if ("summary" in event.payload) return false;
        if (
          ["none", "prepared", "acquire-failed"].includes(workspacePhase) &&
          decision === undefined
        ) {
          if (event.payload.release !== undefined || event.payload.sourceAfter !== undefined)
            return false;
        } else if (
          decision?.outcome !== "failed" ||
          workspacePhase !== "released" ||
          !sameFailureMetadata(event.payload.failure, decision.failure) ||
          !sameArtifactRef(event.payload.release, workspaceRelease) ||
          !sameArtifactRef(event.payload.sourceAfter, sourceAfter)
        )
          return false;
        break;
      case "workflow.cancelled":
        if (
          "summary" in event.payload ||
          decision?.outcome !== "cancelled" ||
          workspacePhase !== "released" ||
          !sameArtifactRef(event.payload.release, workspaceRelease) ||
          !sameArtifactRef(event.payload.sourceAfter, sourceAfter)
        )
          return false;
        break;
      default:
        return false;
    }
  }
  return true;
};

const validV5Transitions = (events: readonly OrchestrationEventV5[]): boolean => {
  const start = events[0];
  if (start?.type !== "workflow.started") return false;
  return start.payload.mode === "unity-batch-v2"
    ? validV5BatchTransitions(events)
    : validV5ChildTransitions(events);
};

const validV2Transitions = (events: readonly OrchestrationEventV2[]): boolean => {
  const phases = new Map<string, string>();
  const attempts = new Map<string, number>();
  let workflowPhase = "running";
  for (const event of events.slice(1)) {
    const stepId = event.stepId;
    const phase = stepId === undefined ? undefined : phases.get(stepId);
    switch (event.type) {
      case "step.attempt.started":
        if (
          stepId === undefined ||
          ![undefined, "retry"].includes(phase) ||
          (phase === undefined && event.payload.attempt !== 1) ||
          (phase === "retry" && attempts.get(stepId) !== event.payload.attempt)
        )
          return false;
        phases.set(stepId, "attempt");
        attempts.set(stepId, event.payload.attempt);
        break;
      case "step.assigned":
        if (
          stepId === undefined ||
          phase !== "attempt" ||
          attempts.get(stepId) !== event.payload.attempt
        )
          return false;
        break;
      case "agent.started":
        if (
          stepId === undefined ||
          phase !== "attempt" ||
          attempts.get(stepId) !== event.payload.attempt
        )
          return false;
        phases.set(stepId, "agent");
        break;
      case "agent.exited":
        if (
          stepId === undefined ||
          phase !== "agent" ||
          attempts.get(stepId) !== event.payload.attempt
        )
          return false;
        phases.set(stepId, "exited");
        break;
      case "agent.input-write-failed":
        if (
          stepId === undefined ||
          !["agent", "exited"].includes(phase ?? "") ||
          attempts.get(stepId) !== event.payload.attempt
        )
          return false;
        break;
      case "step.attempt.failed":
        if (
          stepId === undefined ||
          !["attempt", "agent", "exited"].includes(phase ?? "") ||
          attempts.get(stepId) !== event.payload.attempt
        )
          return false;
        phases.set(stepId, "attempt-failed");
        break;
      case "retry.scheduled":
        if (
          stepId === undefined ||
          !["attempt-failed", "interrupted"].includes(phase ?? "") ||
          event.payload.attempt !== (attempts.get(stepId) ?? 0) + 1
        )
          return false;
        phases.set(stepId, "retry");
        attempts.set(stepId, event.payload.attempt);
        break;
      case "step.attempt.interrupted":
        if (
          stepId === undefined ||
          !["attempt", "agent", "exited", "attempt-failed"].includes(phase ?? "") ||
          attempts.get(stepId) !== event.payload.attempt
        )
          return false;
        phases.set(stepId, "interrupted");
        break;
      case "step.approval-requested":
        if (stepId === undefined || phase !== undefined) return false;
        phases.set(stepId, "approval");
        break;
      case "step.completed":
        if (
          stepId === undefined ||
          !["exited", "approval"].includes(phase ?? "") ||
          (phase === "exited" && attempts.get(stepId) !== event.payload.attempt) ||
          (phase === "approval" && event.payload.attempt !== 0)
        )
          return false;
        phases.set(stepId, "completed");
        break;
      case "step.blocked":
      case "step.escalated":
        if (
          stepId === undefined ||
          phase !== "exited" ||
          attempts.get(stepId) !== event.payload.attempt
        )
          return false;
        phases.set(stepId, event.type.slice("step.".length));
        break;
      case "step.failed":
        if (
          stepId === undefined ||
          ![undefined, "attempt-failed", "interrupted"].includes(phase) ||
          (event.payload.attempt !== undefined &&
            attempts.has(stepId) &&
            attempts.get(stepId) !== event.payload.attempt)
        )
          return false;
        phases.set(stepId, "failed");
        break;
      case "step.skipped":
        if (
          stepId === undefined ||
          (phase !== undefined &&
            !(
              event.payload.reason === "workflow-cancelled" && ["approval", "retry"].includes(phase)
            ))
        )
          return false;
        phases.set(stepId, "skipped");
        break;
      case "step.cancelled":
        if (
          stepId === undefined ||
          !["attempt", "agent", "exited", "interrupted"].includes(phase ?? "") ||
          attempts.get(stepId) !== event.payload.attempt
        )
          return false;
        phases.set(stepId, "cancelled");
        break;
      case "workflow.pausing":
        if (!["running", "waiting"].includes(workflowPhase)) return false;
        workflowPhase = "pausing";
        break;
      case "workflow.paused":
        if (workflowPhase !== "pausing") return false;
        workflowPhase = "paused";
        break;
      case "workflow.resumed":
        if (!["paused", "waiting"].includes(workflowPhase)) return false;
        workflowPhase = "running";
        break;
      case "workflow.waiting-approval":
        workflowPhase = "waiting";
        break;
      case "workflow.cancelling":
        workflowPhase = "cancelling";
        break;
      case "workflow.completed":
      case "workflow.blocked":
      case "workflow.escalated":
      case "workflow.failed":
      case "workflow.cancelled":
        workflowPhase = "terminal";
        break;
      case "workflow.started":
        return false;
      case "artifact.stored":
      case "control.accepted":
        break;
    }
  }
  return true;
};

export class FileOrchestrationJournal
  extends FileRunScopedStore
  implements OrchestrationJournal, VersionedOrchestrationJournal
{
  readonly #terminalRuns = new Set<RunId>();

  public constructor(rootDirectory: string) {
    super(rootDirectory);
  }

  public async append(runId: RunId, event: AnyOrchestrationEvent): Promise<void> {
    const validatedRunId = RunIdSchema.parse(runId);
    const validatedEvent = parseEvent(event);
    if (validatedEvent === undefined) {
      throw new HoneyBeeCoreError("journal.write-failed", "Journal event validation failed.");
    }
    if (validatedEvent.runId !== validatedRunId || this.#terminalRuns.has(validatedRunId)) {
      throw new HoneyBeeCoreError("journal.write-failed", "Journal terminal invariants failed.");
    }

    try {
      const directory = await this.requireRunDirectory(validatedRunId);
      const journalPath = path.join(directory, "events.jsonl");
      const existing = await this.#readAppendableEvents(validatedRunId, journalPath);
      if (
        validatedEvent.sequence !== existing.length + 1 ||
        (existing.length === 0 && validatedEvent.type !== "workflow.started") ||
        (existing.length > 0 && validatedEvent.type === "workflow.started") ||
        (existing[0] !== undefined && existing[0].schemaVersion !== validatedEvent.schemaVersion)
      ) {
        throw new HoneyBeeCoreError("journal.write-failed", "Journal sequence invariants failed.");
      }
      if (
        validatedEvent.schemaVersion === 2 &&
        !validV2Transitions([...(existing as OrchestrationEventV2[]), validatedEvent])
      ) {
        throw new HoneyBeeCoreError(
          "journal.write-failed",
          "Journal transition invariants failed.",
        );
      }
      if (
        validatedEvent.schemaVersion === 3 &&
        !validV3Transitions([...(existing as OrchestrationEventV3[]), validatedEvent])
      ) {
        throw new HoneyBeeCoreError(
          "journal.write-failed",
          "Unity transaction Journal transition invariants failed.",
        );
      }
      if (
        validatedEvent.schemaVersion === 4 &&
        !validV4Transitions([...(existing as OrchestrationEventV4[]), validatedEvent])
      ) {
        throw new HoneyBeeCoreError(
          "journal.write-failed",
          "Unity v0.5 Journal transition invariants failed.",
        );
      }
      if (
        validatedEvent.schemaVersion === 5 &&
        !validV5Transitions([...(existing as OrchestrationEventV5[]), validatedEvent])
      ) {
        throw new HoneyBeeCoreError(
          "journal.write-failed",
          "Unity v0.6 Journal transition invariants failed.",
        );
      }
      const handle = await open(journalPath, "a");
      try {
        await handle.writeFile(`${JSON.stringify(validatedEvent)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      if (isTerminal(validatedEvent)) {
        this.#terminalRuns.add(validatedRunId);
      }
    } catch (error) {
      if (error instanceof HoneyBeeCoreError) throw error;
      throw new HoneyBeeCoreError("journal.write-failed", "Journal append or flush failed.");
    }
  }

  public async replay(runId: RunId): Promise<AnyVersionedJournalReplay> {
    const validatedRunId = RunIdSchema.parse(runId);
    let serialized: string;
    try {
      const directory = await this.requireRunDirectory(validatedRunId);
      serialized = await readFile(path.join(directory, "events.jsonl"), "utf8");
    } catch {
      return indeterminate();
    }
    if (serialized.length === 0 || !serialized.endsWith("\n")) return indeterminate();
    const lines = serialized.slice(0, -1).split("\n");
    if (lines.some((line) => line.length === 0)) return indeterminate();

    const events: AnyOrchestrationEvent[] = [];
    for (const [index, line] of lines.entries()) {
      let value: unknown;
      try {
        value = JSON.parse(line) as unknown;
      } catch {
        return indeterminate();
      }
      const parsed = parseEvent(value);
      if (
        parsed === undefined ||
        parsed.runId !== validatedRunId ||
        parsed.sequence !== index + 1 ||
        (events[0] !== undefined && events[0].schemaVersion !== parsed.schemaVersion)
      ) {
        return indeterminate();
      }
      events.push(parsed);
    }
    if (events[0]?.type !== "workflow.started") return indeterminate();
    const terminals = events.filter(isTerminal);
    const terminal = terminals[0];
    if (terminals.length > 1 || (terminal !== undefined && events.at(-1) !== terminal)) {
      return indeterminate();
    }
    if (events[0].schemaVersion === 1) {
      if (terminal === undefined || terminal.schemaVersion !== 1) return indeterminate();
      return {
        status: "terminal",
        events: events as OrchestrationEventV1[],
        terminal: terminal as TerminalWorkflowEvent,
      };
    }
    if (events[0].schemaVersion === 2) {
      if (!validV2Transitions(events as OrchestrationEventV2[])) return indeterminate();
      if (terminal === undefined) {
        return { status: "active", events: events as OrchestrationEventV2[] };
      }
      return {
        status: "terminal",
        events: events as OrchestrationEventV2[],
        terminal: terminal as TerminalWorkflowEventV2,
      };
    }
    if (events[0].schemaVersion === 3) {
      if (!validV3Transitions(events as OrchestrationEventV3[])) return indeterminate();
      if (terminal === undefined) {
        return { status: "active", events: events as OrchestrationEventV3[] };
      }
      return {
        status: "terminal",
        events: events as OrchestrationEventV3[],
        terminal: terminal as TerminalWorkflowEventV3,
      };
    }
    if (events[0].schemaVersion === 4) {
      if (!validV4Transitions(events as OrchestrationEventV4[])) return indeterminate();
      if (terminal === undefined) {
        return { status: "active", events: events as OrchestrationEventV4[] };
      }
      return {
        status: "terminal",
        events: events as OrchestrationEventV4[],
        terminal: terminal as TerminalWorkflowEventV4,
      };
    }
    if (!validV5Transitions(events as OrchestrationEventV5[])) return indeterminate();
    if (terminal === undefined) {
      return { status: "active", events: events as OrchestrationEventV5[] };
    }
    return {
      status: "terminal",
      events: events as OrchestrationEventV5[],
      terminal: terminal as TerminalWorkflowEventV5,
    };
  }

  async #readAppendableEvents(
    runId: RunId,
    journalPath: string,
  ): Promise<readonly AnyOrchestrationEvent[]> {
    let serialized: string;
    try {
      serialized = await readFile(journalPath, "utf8");
    } catch (error) {
      if (errorCode(error) === "ENOENT") return [];
      throw new HoneyBeeCoreError("journal.write-failed", "Existing Journal could not be read.");
    }
    if (serialized.length === 0) return [];
    if (!serialized.endsWith("\n")) {
      throw new HoneyBeeCoreError("journal.write-failed", "Existing Journal is incomplete.");
    }
    const lines = serialized.slice(0, -1).split("\n");
    if (lines.some((line) => line.length === 0)) {
      throw new HoneyBeeCoreError("journal.write-failed", "Existing Journal is malformed.");
    }
    const events: AnyOrchestrationEvent[] = [];
    for (const [index, line] of lines.entries()) {
      let value: unknown;
      try {
        value = JSON.parse(line) as unknown;
      } catch {
        throw new HoneyBeeCoreError("journal.write-failed", "Existing Journal is malformed.");
      }
      const parsed = parseEvent(value);
      if (
        parsed === undefined ||
        parsed.runId !== runId ||
        parsed.sequence !== index + 1 ||
        (events[0] !== undefined && events[0].schemaVersion !== parsed.schemaVersion)
      ) {
        throw new HoneyBeeCoreError("journal.write-failed", "Existing Journal is invalid.");
      }
      if (isTerminal(parsed)) {
        this.#terminalRuns.add(runId);
        throw new HoneyBeeCoreError("journal.write-failed", "Journal is already terminal.");
      }
      events.push(parsed);
    }
    if (events[0]?.type !== "workflow.started") {
      throw new HoneyBeeCoreError("journal.write-failed", "Existing Journal has no start event.");
    }
    return events;
  }
}

export { INDETERMINATE_MESSAGE };
