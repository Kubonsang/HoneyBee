import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, rm, unlink } from "node:fs/promises";
import path from "node:path";

import {
  ArtifactIdSchema,
  ArtifactKindSchema,
  ArtifactMediaTypeSchema,
  ArtifactRefSchema,
  ContentDigestSchema,
  OrchestrationEventV1Schema,
  RunIdSchema,
  TERMINAL_WORKFLOW_EVENT_TYPES,
  type ArtifactRef,
  type OrchestrationEventV1,
  type RunId,
  type TerminalWorkflowEvent,
} from "@honeybee/orchestration-contracts";

import { HoneyBeeCoreError } from "./errors.js";
import type {
  ArtifactGetRequest,
  ArtifactPutRequest,
  ArtifactStore,
  JournalReplay,
  OrchestrationJournal,
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

export class FileOrchestrationJournal extends FileRunScopedStore implements OrchestrationJournal {
  readonly #terminalRuns = new Set<RunId>();

  public constructor(rootDirectory: string) {
    super(rootDirectory);
  }

  public async append(runId: RunId, event: OrchestrationEventV1): Promise<void> {
    const validatedRunId = RunIdSchema.parse(runId);
    let validatedEvent: OrchestrationEventV1;
    try {
      validatedEvent = OrchestrationEventV1Schema.parse(event);
    } catch {
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
        (existing.length > 0 && validatedEvent.type === "workflow.started")
      ) {
        throw new HoneyBeeCoreError("journal.write-failed", "Journal sequence invariants failed.");
      }
      const handle = await open(journalPath, "a");
      try {
        await handle.writeFile(`${JSON.stringify(validatedEvent)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      if (TERMINAL_WORKFLOW_EVENT_TYPES.has(validatedEvent.type as TerminalWorkflowEvent["type"])) {
        this.#terminalRuns.add(validatedRunId);
      }
    } catch (error) {
      if (error instanceof HoneyBeeCoreError) throw error;
      throw new HoneyBeeCoreError("journal.write-failed", "Journal append or flush failed.");
    }
  }

  public async replay(runId: RunId): Promise<JournalReplay> {
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

    const events: OrchestrationEventV1[] = [];
    for (const [index, line] of lines.entries()) {
      let value: unknown;
      try {
        value = JSON.parse(line) as unknown;
      } catch {
        return indeterminate();
      }
      const parsed = OrchestrationEventV1Schema.safeParse(value);
      if (
        !parsed.success ||
        parsed.data.runId !== validatedRunId ||
        parsed.data.sequence !== index + 1
      ) {
        return indeterminate();
      }
      events.push(parsed.data);
    }
    if (events[0]?.type !== "workflow.started") return indeterminate();
    const terminals = events.filter((event): event is TerminalWorkflowEvent =>
      TERMINAL_WORKFLOW_EVENT_TYPES.has(event.type as TerminalWorkflowEvent["type"]),
    );
    const terminal = terminals[0];
    if (terminal === undefined || terminals.length !== 1 || events.at(-1) !== terminal) {
      return indeterminate();
    }
    return { status: "terminal", events, terminal };
  }

  async #readAppendableEvents(
    runId: RunId,
    journalPath: string,
  ): Promise<readonly OrchestrationEventV1[]> {
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
    const events: OrchestrationEventV1[] = [];
    for (const [index, line] of lines.entries()) {
      let value: unknown;
      try {
        value = JSON.parse(line) as unknown;
      } catch {
        throw new HoneyBeeCoreError("journal.write-failed", "Existing Journal is malformed.");
      }
      const parsed = OrchestrationEventV1Schema.safeParse(value);
      if (!parsed.success || parsed.data.runId !== runId || parsed.data.sequence !== index + 1) {
        throw new HoneyBeeCoreError("journal.write-failed", "Existing Journal is invalid.");
      }
      if (TERMINAL_WORKFLOW_EVENT_TYPES.has(parsed.data.type as TerminalWorkflowEvent["type"])) {
        this.#terminalRuns.add(runId);
        throw new HoneyBeeCoreError("journal.write-failed", "Journal is already terminal.");
      }
      events.push(parsed.data);
    }
    if (events[0]?.type !== "workflow.started") {
      throw new HoneyBeeCoreError("journal.write-failed", "Existing Journal has no start event.");
    }
    return events;
  }
}

export { INDETERMINATE_MESSAGE };
