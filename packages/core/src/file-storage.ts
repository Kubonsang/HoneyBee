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
  OrchestrationEventV1Schema,
  RunIdSchema,
  TERMINAL_WORKFLOW_EVENT_TYPES,
  TERMINAL_WORKFLOW_EVENT_V2_TYPES,
  type AnyOrchestrationEvent,
  type ArtifactRef,
  type OrchestrationEventV1,
  type OrchestrationEventV2,
  type RunId,
  type TerminalWorkflowEvent,
  type TerminalWorkflowEventV2,
} from "@honeybee/orchestration-contracts";

import { HoneyBeeCoreError } from "./errors.js";
import type {
  ArtifactGetRequest,
  ArtifactPutRequest,
  ArtifactStore,
  JournalReplay,
  AnyJournalReplay,
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
    const runId = RunIdSchema.parse(request.runId);
    const artifactId = ArtifactIdSchema.parse(request.artifactId);
    const kind = ArtifactKindSchema.parse(request.kind);
    const mediaType = ArtifactMediaTypeSchema.parse(request.mediaType);
    const bytes = Buffer.from(request.content, "utf8");
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
    const runId = RunIdSchema.parse(request.runId);
    const artifact = ArtifactRefSchema.parse(request.artifact);
    try {
      const runDirectory = await this.requireRunDirectory(runId);
      const blob = this.blobPath(runDirectory, artifact.contentDigest);
      const bytes = await this.verifyFile(blob, artifact);
      return bytes.toString("utf8");
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
        : undefined;
  return parsed?.success === true ? parsed.data : undefined;
};

const isTerminal = (event: AnyOrchestrationEvent): boolean =>
  event.schemaVersion === 1
    ? TERMINAL_WORKFLOW_EVENT_TYPES.has(event.type as TerminalWorkflowEvent["type"])
    : TERMINAL_WORKFLOW_EVENT_V2_TYPES.has(event.type as TerminalWorkflowEventV2["type"]);

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

  public async replay(runId: RunId): Promise<AnyJournalReplay> {
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
