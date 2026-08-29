import { createHash, randomUUID } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import {
  DesktopDogfoodStatusV1Schema,
  DesktopDogfoodSummaryV1Schema,
  type DesktopDogfoodStatusV1,
} from "../shared/ipc.js";

const RunIdSchema = z.string().uuid();
const TerminalEvents = new Set([
  "workflow.completed",
  "workflow.blocked",
  "workflow.escalated",
  "workflow.failed",
  "workflow.cancelled",
]);
const DigestPattern = /^sha256:([0-9a-f]{64})$/u;
const MaximumJournalBytes = 64 * 1024 * 1024;
const MaximumLogBytes = 8 * 1024 * 1024;

const SessionDescriptorSchema = z
  .object({
    schemaVersion: z.literal(1),
    sessionId: z.string().uuid(),
    profileId: z.string().uuid(),
    projectLabel: z.string().min(1).max(120),
    projectPath: z.string().min(1),
    configPath: z.string().min(1),
    stateRoot: z.string().min(1),
    evidencePath: z.string().min(1),
    startedAt: z.string().datetime(),
    stoppedAt: z.string().datetime().optional(),
    state: z.enum(["recording", "incomplete", "passed", "failed"]),
    doctorPassed: z.boolean(),
    parents: z.array(
      z
        .object({
          runId: z.string().uuid(),
          workCount: z.number().int().positive(),
        })
        .strict(),
    ),
    summary: DesktopDogfoodSummaryV1Schema.optional(),
  })
  .strict();
type SessionDescriptor = z.infer<typeof SessionDescriptorSchema>;

type JsonRecord = Record<string, unknown>;
type JournalEvent = JsonRecord & {
  runId: string;
  sequence: number;
  timestamp: string;
  type: string;
  payload?: unknown;
};

export interface DogfoodRuntimeObservation {
  readonly runs: readonly {
    readonly runId: string;
    readonly status: string;
    readonly terminal: boolean;
    readonly parentRunId?: string | undefined;
  }[];
  readonly editors: readonly {
    readonly ownerRunId?: string | undefined;
    readonly ownership: string;
    readonly state: string;
  }[];
  readonly pool: {
    readonly active: readonly { readonly ownerRunId: string }[];
    readonly queued: readonly { readonly ownerRunId: string }[];
  };
}

export interface DogfoodStartInput {
  readonly profileId: string;
  readonly projectLabel: string;
  readonly projectPath: string;
  readonly configPath: string;
  readonly doctorPassed: boolean;
}

export interface DogfoodFinalizeInput {
  readonly sessionId: string;
  readonly observation: DogfoodRuntimeObservation;
}

export interface DogfoodFinalizationTarget {
  readonly projectPath: string;
  readonly configPath: string;
}

interface AnalysisIssue {
  readonly code: string;
  readonly message: string;
  readonly runId?: string;
  readonly sequence?: number;
  readonly artifactId?: string;
}

const dogfoodError = (code: string, message: string, cause?: unknown): Error =>
  Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { code });

const record = (value: unknown): JsonRecord | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;

const milliseconds = (start: unknown, end: unknown): number | null => {
  if (typeof start !== "string" || typeof end !== "string") return null;
  const left = Date.parse(start);
  const right = Date.parse(end);
  return Number.isFinite(left) && Number.isFinite(right) && right >= left ? right - left : null;
};

const atomicWrite = async (target: string, content: string | Buffer): Promise<void> => {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}-${randomUUID()}.tmp`,
  );
  const handle = await open(temporary, "wx");
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, target);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
};

const firstEvent = (events: readonly JournalEvent[], type: string): JournalEvent | undefined =>
  events.find((event) => event.type === type);

const lastEvent = (events: readonly JournalEvent[], type: string): JournalEvent | undefined =>
  [...events].reverse().find((event) => event.type === type);

const nextEvent = (
  events: readonly JournalEvent[],
  start: JournalEvent | undefined,
  types: ReadonlySet<string>,
): JournalEvent | undefined =>
  start === undefined
    ? undefined
    : events.find((event) => event.sequence > start.sequence && types.has(event.type));

const interval = (
  events: readonly JournalEvent[],
  startType: string,
  endTypes: readonly string[],
) => {
  const start = firstEvent(events, startType);
  const end = nextEvent(events, start, new Set(endTypes));
  return {
    start: start?.timestamp ?? null,
    end: end?.timestamp ?? null,
    durationMs: milliseconds(start?.timestamp, end?.timestamp),
    terminalEvent: end?.type ?? null,
  };
};

const loadJournal = async (
  stateRoot: string,
  runId: string,
  issues: AnalysisIssue[],
): Promise<JournalEvent[]> => {
  const directory = path.join(stateRoot, runId);
  const journalPath = path.join(directory, "events.jsonl");
  try {
    const directoryEntry = await lstat(directory);
    const journalEntry = await lstat(journalPath);
    if (
      !directoryEntry.isDirectory() ||
      directoryEntry.isSymbolicLink() ||
      !journalEntry.isFile() ||
      journalEntry.isSymbolicLink() ||
      journalEntry.size === 0 ||
      journalEntry.size > MaximumJournalBytes
    )
      throw new Error("unsafe Journal path");
    const content = await readFile(journalPath, "utf8");
    if (!content.endsWith("\n")) {
      issues.push({
        code: "journal.incomplete-line",
        message: "Journal has no final newline.",
        runId,
      });
      return [];
    }
    const events: JournalEvent[] = [];
    let schemaVersion: unknown;
    for (const [index, line] of content.slice(0, -1).split("\n").entries()) {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        issues.push({
          code: "journal.invalid-json",
          message: "Journal line is invalid JSON.",
          runId,
          sequence: index + 1,
        });
        return [];
      }
      const event = record(value);
      if (
        event === undefined ||
        event.runId !== runId ||
        event.sequence !== index + 1 ||
        typeof event.timestamp !== "string" ||
        typeof event.type !== "string"
      ) {
        issues.push({
          code: "journal.identity-invalid",
          message: "Journal identity or sequence is invalid.",
          runId,
          sequence: index + 1,
        });
        return [];
      }
      schemaVersion ??= event.schemaVersion;
      if (event.schemaVersion !== schemaVersion) {
        issues.push({
          code: "journal.schema-mixed",
          message: "Journal schema versions are mixed.",
          runId,
          sequence: index + 1,
        });
        return [];
      }
      events.push(event as JournalEvent);
    }
    if (events[0]?.type !== "workflow.started") {
      issues.push({
        code: "journal.start-invalid",
        message: "Journal does not start with workflow.started.",
        runId,
      });
    }
    const terminals = events.filter((event) => TerminalEvents.has(event.type));
    if (terminals.length > 1 || (terminals.length === 1 && terminals[0] !== events.at(-1))) {
      issues.push({
        code: "journal.terminal-invalid",
        message: "Terminal event is not the single final event.",
        runId,
      });
    }
    return events;
  } catch {
    issues.push({
      code: "journal.read-failed",
      message: "Journal could not be read safely.",
      runId,
    });
    return [];
  }
};

const artifactRef = (value: unknown): JsonRecord | undefined => {
  const candidate = record(value);
  return candidate !== undefined &&
    typeof candidate.artifactId === "string" &&
    typeof candidate.byteLength === "number" &&
    typeof candidate.contentDigest === "string" &&
    DigestPattern.test(candidate.contentDigest)
    ? candidate
    : undefined;
};

function* artifactRefs(value: unknown): Generator<JsonRecord> {
  const direct = artifactRef(value);
  if (direct !== undefined) {
    yield direct;
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) yield* artifactRefs(item);
    return;
  }
  const parent = record(value);
  if (parent !== undefined) for (const item of Object.values(parent)) yield* artifactRefs(item);
}

const readArtifact = async (
  stateRoot: string,
  runId: string,
  reference: JsonRecord,
  issues: AnalysisIssue[],
): Promise<Buffer | undefined> => {
  const digest =
    typeof reference.contentDigest === "string"
      ? DigestPattern.exec(reference.contentDigest)?.[1]
      : undefined;
  if (digest === undefined) return undefined;
  const runRoot = path.join(stateRoot, runId);
  const target = path.join(runRoot, "blobs", "sha256", digest.slice(0, 2), digest.slice(2));
  try {
    const relative = path.relative(runRoot, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("path escape");
    for (const candidate of [
      runRoot,
      path.join(runRoot, "blobs"),
      path.join(runRoot, "blobs", "sha256"),
      path.dirname(target),
      target,
    ]) {
      const entry = await lstat(candidate);
      if (entry.isSymbolicLink()) throw new Error("linked Artifact path");
    }
    const bytes = await readFile(target);
    const actualDigest = "sha256:" + createHash("sha256").update(bytes).digest("hex");
    if (bytes.byteLength !== reference.byteLength || actualDigest !== reference.contentDigest) {
      issues.push({
        code: "artifact.integrity-failed",
        message: "Artifact length or digest mismatched.",
        runId,
        artifactId: String(reference.artifactId),
      });
      return undefined;
    }
    return bytes;
  } catch {
    issues.push({
      code: "artifact.read-failed",
      message: "Artifact could not be read safely.",
      runId,
      artifactId: String(reference.artifactId),
    });
    return undefined;
  }
};

const readArtifactJson = async (
  stateRoot: string,
  runId: string,
  reference: JsonRecord | undefined,
  issues: AnalysisIssue[],
): Promise<JsonRecord | undefined> => {
  if (reference === undefined) return undefined;
  const bytes = await readArtifact(stateRoot, runId, reference, issues);
  if (bytes === undefined) return undefined;
  try {
    return record(JSON.parse(bytes.toString("utf8")));
  } catch {
    issues.push({
      code: "artifact.json-invalid",
      message: "Artifact JSON is invalid.",
      runId,
      artifactId: String(reference.artifactId),
    });
    return undefined;
  }
};

const overlap = (works: readonly JsonRecord[]) => {
  const points: { at: number; delta: number }[] = [];
  for (const work of works) {
    const agent = record(work.agent);
    const start = typeof agent?.startedAt === "string" ? Date.parse(agent.startedAt) : Number.NaN;
    const end = typeof agent?.exitedAt === "string" ? Date.parse(agent.exitedAt) : Number.NaN;
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
      points.push({ at: start, delta: 1 }, { at: end, delta: -1 });
    }
  }
  points.sort((left, right) => left.at - right.at || left.delta - right.delta);
  let active = 0;
  let maximum = 0;
  let overlapMs = 0;
  let unionMs = 0;
  let previous = points[0]?.at ?? 0;
  for (const point of points) {
    const elapsed = point.at - previous;
    if (active > 0) unionMs += elapsed;
    if (active > 1) overlapMs += elapsed;
    active += point.delta;
    maximum = Math.max(maximum, active);
    previous = point.at;
  }
  return {
    agentIntervals: points.length / 2,
    maxConcurrentAgents: maximum,
    overlapMs,
    unionMs,
    overlapRatio: unionMs === 0 ? 0 : overlapMs / unionMs,
  };
};

const analyzeWork = async (
  stateRoot: string,
  runId: string,
  events: readonly JournalEvent[],
  issues: AnalysisIssue[],
): Promise<JsonRecord> => {
  const start = events[0];
  const startPayload = record(start?.payload);
  const linkage = record(startPayload?.linkage);
  const terminal = events.at(-1);
  const terminalType =
    terminal !== undefined && TerminalEvents.has(terminal.type) ? terminal.type : undefined;
  const agentStart = firstEvent(events, "agent.started");
  const agentExit = nextEvent(events, agentStart, new Set(["agent.exited"]));
  const sourceChecked = lastEvent(events, "source.checked");
  const sourcePayload = record(sourceChecked?.payload);
  const sourceBaselined = lastEvent(events, "source.baselined");
  const sourceBaseline = await readArtifactJson(
    stateRoot,
    runId,
    artifactRef(record(sourceBaselined?.payload)?.manifest),
    issues,
  );
  const config = await readArtifactJson(
    stateRoot,
    runId,
    artifactRef(startPayload?.config),
    issues,
  );
  const requested = Array.isArray(config?.capabilities)
    ? config.capabilities.map(record).filter((value): value is JsonRecord => value !== undefined)
    : [];
  const capabilities: JsonRecord[] = [];
  for (const started of events.filter((event) => event.type === "capability.started")) {
    const payload = record(started.payload);
    const terminalCapability = events.find((event) => {
      const candidate = record(event.payload);
      return (
        event.sequence > started.sequence &&
        (event.type === "capability.completed" || event.type === "capability.failed") &&
        candidate?.capabilityId === payload?.capabilityId &&
        candidate?.index === payload?.index
      );
    });
    const result: JsonRecord = {
      capabilityId: payload?.capabilityId,
      kind: payload?.kind,
      startedAt: started.timestamp,
      endedAt: terminalCapability?.timestamp ?? null,
      durationMs: milliseconds(started.timestamp, terminalCapability?.timestamp),
      status:
        terminalCapability === undefined
          ? "running"
          : terminalCapability.type === "capability.completed"
            ? "completed"
            : "failed",
    };
    if (terminalCapability?.type === "capability.completed") {
      const evidence = artifactRef(record(terminalCapability.payload)?.evidence);
      const manifest = await readArtifactJson(stateRoot, runId, evidence, issues);
      const files = Array.isArray(manifest?.files) ? manifest.files.map(record) : [];
      const summaryEntry = files.find((item) => item?.name === "summary.json");
      const summary = await readArtifactJson(
        stateRoot,
        runId,
        artifactRef(summaryEntry?.artifact),
        issues,
      );
      if (summary !== undefined) result.result = summary;
    }
    capabilities.push(result);
  }
  const verified = lastEvent(events, "patch.verified");
  const patchReference = artifactRef(record(verified?.payload)?.patch);
  const patchManifest = await readArtifactJson(stateRoot, runId, patchReference, issues);
  const entries = Array.isArray(patchManifest?.entries)
    ? patchManifest.entries.map(record).filter((value): value is JsonRecord => value !== undefined)
    : [];
  let disposition: JsonRecord | undefined;
  try {
    const value = record(
      JSON.parse(await readFile(path.join(stateRoot, runId, "patch-disposition.json"), "utf8")),
    );
    if (value?.runId === runId) disposition = value;
    else
      issues.push({
        code: "patch.disposition-invalid",
        message: "Patch disposition identity is invalid.",
        runId,
      });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code !== "ENOENT") {
      issues.push({
        code: "patch.disposition-invalid",
        message: "Patch disposition could not be read.",
        runId,
      });
    }
  }
  const acquired =
    lastEvent(events, "workspace.acquired") ?? firstEvent(events, "workspace.prepared");
  const workspaceId = record(acquired?.payload)?.workspaceId;
  const storage = record(config?.workspaceStorage);
  const workspaceRoot =
    typeof storage?.workspaceRoot === "string" ? storage.workspaceRoot : undefined;
  const workspacePath =
    typeof workspaceId === "string" && workspaceRoot !== undefined
      ? path.join(workspaceRoot, workspaceId)
      : undefined;
  let workspacePresent: boolean | null = null;
  if (workspacePath !== undefined) {
    try {
      workspacePresent = (await stat(workspacePath)).isDirectory();
    } catch {
      workspacePresent = false;
    }
  }
  return {
    runId,
    workId: linkage?.workId ?? null,
    parentRunId: linkage?.parentRunId ?? null,
    priority: linkage?.priority ?? null,
    status: terminalType?.replace("workflow.", "") ?? "cleanup-pending",
    startedAt: start?.timestamp ?? null,
    endedAt: terminalType === undefined ? null : terminal?.timestamp,
    wallClockMs: milliseconds(
      start?.timestamp,
      terminalType === undefined ? undefined : terminal?.timestamp,
    ),
    timings: {
      workspacePrepare: interval(events, "workflow.started", ["workspace.prepared"]),
      workspaceAcquire: interval(events, "workspace.acquire-started", [
        "workspace.acquired",
        "workspace.acquire-failed",
      ]),
      editorPoolQueueWait: interval(events, "editor.pool-queued", [
        "editor.pool-acquired",
        "editor.pool-cancelled",
      ]),
      editorSlotOccupied: interval(events, "editor.pool-acquired", ["editor.pool-released"]),
      editorLaunch: interval(events, "editor.launch-intended", [
        "editor.ownership-established",
        "editor.launch-abandoned",
      ]),
      bridgeReady: interval(events, "editor.ownership-established", ["editor.bridge-bound"]),
      workspaceRelease: interval(events, "workspace.release-started", [
        "workspace.released",
        "workspace.release-failed",
      ]),
      patchVerify: interval(events, "source.checked", ["patch.verified"]),
    },
    agent: {
      startedAt: agentStart?.timestamp ?? null,
      exitedAt: agentExit?.timestamp ?? null,
      durationMs: milliseconds(agentStart?.timestamp, agentExit?.timestamp),
      exitCode: record(agentExit?.payload)?.exitCode ?? null,
    },
    requestedCapabilities: requested.map((item) => ({ id: item.id, kind: item.kind })),
    capabilities,
    sourceBaseline:
      sourceBaseline === undefined
        ? null
        : {
            digest: sourceBaseline.digest ?? null,
            fileCount: sourceBaseline.fileCount ?? null,
            logicalBytes: sourceBaseline.logicalBytes ?? null,
          },
    sourceUnchanged: sourcePayload?.unchanged ?? null,
    patch:
      patchReference === undefined
        ? null
        : {
            artifactId: patchReference.artifactId,
            verifiedAt: verified?.timestamp ?? null,
            changedFiles: entries.map((entry) => ({
              path: entry.path,
              operation: entry.operation,
            })),
            changedFileCount: entries.length,
          },
    disposition:
      disposition === undefined
        ? null
        : {
            action: disposition.action,
            phase: disposition.phase,
            startedAt: disposition.startedAt,
            updatedAt: disposition.updatedAt,
            durationMs: milliseconds(disposition.startedAt, disposition.updatedAt),
            conflictPaths: disposition.conflictPaths ?? [],
          },
    workspace: {
      workspaceId: workspaceId ?? null,
      path: workspacePath ?? null,
      presentAfter: workspacePresent,
    },
  };
};

export class DesktopDogfoodController {
  readonly #root: string;
  readonly #statePath: string;
  readonly #stateRoot: string;
  #tail: Promise<void> = Promise.resolve();

  public constructor(userDataRoot: string, stateRoot: string) {
    this.#root = path.resolve(userDataRoot, "dogfood");
    this.#statePath = path.join(this.#root, "state", "current.json");
    this.#stateRoot = path.resolve(stateRoot);
  }

  public async status(enabled: boolean): Promise<DesktopDogfoodStatusV1> {
    if (!enabled) return this.#status(false, undefined);
    return this.#serialized(async () => this.#status(true, await this.#read()));
  }

  public async start(input: DogfoodStartInput): Promise<DesktopDogfoodStatusV1> {
    return this.#serialized(async () => {
      const existing = await this.#read();
      if (existing?.state === "recording")
        throw dogfoodError("dogfood.recording-active", "A dogfood recording is already active.");
      if (!input.doctorPassed)
        throw dogfoodError(
          "dogfood.doctor-failed",
          "Doctor must pass before dogfood recording starts.",
        );
      const sessionId = randomUUID();
      const descriptor = SessionDescriptorSchema.parse({
        schemaVersion: 1,
        sessionId,
        profileId: input.profileId,
        projectLabel: input.projectLabel,
        projectPath: path.resolve(input.projectPath),
        configPath: path.resolve(input.configPath),
        stateRoot: this.#stateRoot,
        evidencePath: path.join(this.#root, "evidence", sessionId),
        startedAt: new Date().toISOString(),
        state: "recording",
        doctorPassed: true,
        parents: [],
      });
      await this.#write(descriptor);
      return this.#status(true, descriptor);
    });
  }

  public async recordParentRun(profileId: string, runId: string, workCount: number): Promise<void> {
    await this.#serialized(async () => {
      const descriptor = await this.#read();
      if (descriptor?.state !== "recording" || descriptor.profileId !== profileId) return;
      RunIdSchema.parse(runId);
      const parents = descriptor.parents.some((value) => value.runId === runId)
        ? descriptor.parents
        : [...descriptor.parents, { runId, workCount }];
      await this.#write({ ...descriptor, parents });
    });
  }

  public finalizationTarget(sessionId: string): Promise<DogfoodFinalizationTarget> {
    return this.#serialized(async () => {
      const descriptor = await this.#read();
      if (descriptor === undefined || descriptor.sessionId !== sessionId)
        throw dogfoodError("dogfood.session-not-found", "Dogfood session was not found.");
      return {
        projectPath: descriptor.projectPath,
        configPath: descriptor.configPath,
      };
    });
  }

  public async finalize(input: DogfoodFinalizeInput): Promise<DesktopDogfoodStatusV1> {
    return this.#serialized(async () => {
      const descriptor = await this.#read();
      if (descriptor === undefined || descriptor.sessionId !== input.sessionId)
        throw dogfoodError("dogfood.session-not-found", "Dogfood session was not found.");
      const observedAt = new Date().toISOString();
      const stoppedAt =
        descriptor.state === "recording" || descriptor.state === "incomplete"
          ? observedAt
          : (descriptor.stoppedAt ?? observedAt);
      const analysis = await this.#analyze({ ...descriptor, stoppedAt }, input.observation);
      const state = analysis.summary.verdict;
      const updated = SessionDescriptorSchema.parse({
        ...descriptor,
        stoppedAt,
        state,
        summary: analysis.summary,
      });
      await mkdir(updated.evidencePath, { recursive: true });
      await Promise.all([
        atomicWrite(
          path.join(updated.evidencePath, "metrics.json"),
          JSON.stringify(analysis.metrics, null, 2) + "\n",
        ),
        atomicWrite(
          path.join(updated.evidencePath, "events.ndjson"),
          analysis.events.map((event) => JSON.stringify(event)).join("\n") +
            (analysis.events.length === 0 ? "" : "\n"),
        ),
        atomicWrite(path.join(updated.evidencePath, "summary.md"), analysis.markdown),
        atomicWrite(
          path.join(updated.evidencePath, "session.json"),
          JSON.stringify(updated, null, 2) + "\n",
        ),
      ]);
      await this.#exportJournals(updated.evidencePath, analysis.runIds);
      await this.#write(updated);
      return this.#status(true, updated);
    });
  }

  public evidencePath(sessionId: string): Promise<string> {
    return this.#serialized(async () => {
      const descriptor = await this.#read();
      if (descriptor === undefined || descriptor.sessionId !== sessionId)
        throw dogfoodError("dogfood.session-not-found", "Dogfood session was not found.");
      const evidenceRoot = path.resolve(this.#root, "evidence");
      const target = path.resolve(descriptor.evidencePath);
      const relative = path.relative(evidenceRoot, target);
      if (relative.startsWith("..") || path.isAbsolute(relative))
        throw dogfoodError("dogfood.evidence-path-unsafe", "Dogfood evidence path is unsafe.");
      await lstat(target);
      return target;
    });
  }

  async #analyze(descriptor: SessionDescriptor, observation: DogfoodRuntimeObservation) {
    const issues: AnalysisIssue[] = [];
    const journals = new Map<string, JournalEvent[]>();
    for (const parent of descriptor.parents) {
      journals.set(parent.runId, await loadJournal(this.#stateRoot, parent.runId, issues));
    }
    const entries = await readdir(this.#stateRoot, { withFileTypes: true }).catch(() => []);
    for (const run of observation.runs) {
      if (
        run.parentRunId !== undefined &&
        descriptor.parents.some((parent) => parent.runId === run.parentRunId) &&
        !journals.has(run.runId)
      ) {
        journals.set(run.runId, await loadJournal(this.#stateRoot, run.runId, issues));
      }
    }
    for (const entry of entries) {
      if (
        !entry.isDirectory() ||
        !RunIdSchema.safeParse(entry.name).success ||
        journals.has(entry.name)
      )
        continue;
      const events = await loadJournal(this.#stateRoot, entry.name, []);
      const startPayload = record(events[0]?.payload);
      const linkage = record(startPayload?.linkage);
      if (
        startPayload?.mode === "unity-work-v3" &&
        typeof linkage?.parentRunId === "string" &&
        descriptor.parents.some((parent) => parent.runId === linkage.parentRunId)
      ) {
        journals.set(entry.name, events);
      }
    }
    const childEntries = [...journals.entries()].filter(
      ([, events]) => record(events[0]?.payload)?.mode === "unity-work-v3",
    );
    for (const [runId, events] of childEntries) {
      for (const event of events) {
        for (const reference of artifactRefs(event))
          await readArtifact(this.#stateRoot, runId, reference, issues);
      }
    }
    const works = await Promise.all(
      childEntries.map(([runId, events]) => analyzeWork(this.#stateRoot, runId, events, issues)),
    );
    const runIds = new Set([...journals.keys()]);
    const activeRuns = observation.runs.filter(
      (run) =>
        runIds.has(run.runId) &&
        (!run.terminal || run.status === "cleanup-pending" || run.status === "indeterminate"),
    );
    const poolResiduals = [...observation.pool.active, ...observation.pool.queued].filter(
      (ticket) => runIds.has(ticket.ownerRunId),
    );
    const editorResiduals = observation.editors.filter(
      (editor) =>
        editor.ownership === "honeybee" &&
        editor.ownerRunId !== undefined &&
        runIds.has(editor.ownerRunId) &&
        editor.state !== "exited",
    );
    const workspaceResiduals = works
      .filter((work) => record(work.workspace)?.presentAfter === true)
      .map((work) => ({ runId: work.runId, path: record(work.workspace)?.path }));
    const residualTotal =
      activeRuns.length + poolResiduals.length + editorResiduals.length + workspaceResiduals.length;

    const expectedWorks = descriptor.parents.reduce((total, parent) => total + parent.workCount, 0);
    const completedWorks = works.filter((work) => work.status === "completed").length;
    const failedWorks = works.filter(
      (work) => work.status !== "completed" && work.status !== "cleanup-pending",
    ).length;
    const changedFiles = works.reduce(
      (total, work) => total + Number(record(work.patch)?.changedFileCount ?? 0),
      0,
    );
    const testCount = works.reduce(
      (total, work) =>
        total +
        (Array.isArray(work.capabilities)
          ? work.capabilities.reduce(
              (sum, capability) => sum + Number(record(record(capability)?.result)?.total ?? 0),
              0,
            )
          : 0),
      0,
    );
    const concurrency = overlap(works);
    const sourceBaselines = works
      .map((work) => record(work.sourceBaseline))
      .filter((value): value is JsonRecord => value !== undefined);
    const sourceInput =
      sourceBaselines.length === 0
        ? { status: "unavailable" as const }
        : {
            status: "observed" as const,
            fileCount: Math.max(...sourceBaselines.map((value) => Number(value.fileCount ?? 0))),
            logicalBytes: Math.max(
              ...sourceBaselines.map((value) => Number(value.logicalBytes ?? 0)),
            ),
          };
    const capabilitiesOk = works.every((work) => {
      const requested = Array.isArray(work.requestedCapabilities) ? work.requestedCapabilities : [];
      const completed = Array.isArray(work.capabilities)
        ? work.capabilities.filter((item) => record(item)?.status === "completed")
        : [];
      return requested.every((item) =>
        completed.some(
          (candidate) =>
            record(candidate)?.capabilityId === record(item)?.id &&
            record(candidate)?.kind === record(item)?.kind,
        ),
      );
    });
    const sourceOk = works.length > 0 && works.every((work) => work.sourceUnchanged === true);
    const dispositionsOk =
      works.length > 0 &&
      works.every((work) =>
        ["applied", "rejected"].includes(String(record(work.disposition)?.phase)),
      );
    const incomplete =
      works.length < expectedWorks ||
      activeRuns.length > 0 ||
      works.some((work) => work.status === "cleanup-pending");
    const passed =
      descriptor.doctorPassed &&
      expectedWorks > 0 &&
      completedWorks === expectedWorks &&
      capabilitiesOk &&
      sourceOk &&
      dispositionsOk &&
      issues.length === 0 &&
      residualTotal === 0;
    const verdict = incomplete ? "incomplete" : passed ? "passed" : "failed";
    const summary = DesktopDogfoodSummaryV1Schema.parse({
      schemaVersion: 1,
      verdict,
      sessionWallClockMs: milliseconds(descriptor.startedAt, descriptor.stoppedAt),
      workCount: works.length,
      completedWorks,
      failedWorks,
      changedFiles,
      testCount,
      agentOverlapMs: concurrency.overlapMs,
      maxConcurrentAgents: concurrency.maxConcurrentAgents,
      residualTotal,
      issueCount: issues.length,
    });
    const normalizedEvents = [...journals.entries()]
      .flatMap(([runId, events]) =>
        events.map((event) => ({
          schemaVersion: 1,
          sessionId: descriptor.sessionId,
          source: "journal",
          runId,
          event,
        })),
      )
      .sort(
        (left, right) =>
          left.event.timestamp.localeCompare(right.event.timestamp) ||
          left.runId.localeCompare(right.runId) ||
          left.event.sequence - right.event.sequence,
      );
    const metrics = {
      schemaVersion: 1,
      sessionId: descriptor.sessionId,
      project: {
        profileId: descriptor.profileId,
        label: descriptor.projectLabel,
        projectPath: descriptor.projectPath,
        configPath: descriptor.configPath,
        sourceInput,
      },
      timing: {
        sessionStartedAt: descriptor.startedAt,
        sessionEndedAt: descriptor.stoppedAt,
        sessionWallClockMs: summary.sessionWallClockMs,
      },
      concurrency,
      works,
      aggregate: {
        expectedWorks,
        completedWorks,
        failedWorks,
        changedFiles,
        testCount,
        verifiedChangesPerHour:
          summary.sessionWallClockMs === null || summary.sessionWallClockMs === 0
            ? null
            : Number(((completedWorks * 3_600_000) / summary.sessionWallClockMs).toFixed(6)),
      },
      residuals: {
        activeRuns,
        editorPoolRequests: poolResiduals,
        ownedEditors: editorResiduals,
        workspaceShells: workspaceResiduals,
        total: residualTotal,
      },
      issues,
      verdict,
    };
    const markdown = [
      `# HoneyBee dogfood session ${descriptor.sessionId}`,
      "",
      `- Verdict: **${verdict.toUpperCase()}**`,
      `- Session wall-clock: ${summary.sessionWallClockMs ?? "unavailable"} ms`,
      `- Works: ${completedWorks}/${expectedWorks} completed`,
      `- Agent overlap: ${summary.agentOverlapMs} ms (max ${summary.maxConcurrentAgents})`,
      `- Changed files: ${changedFiles}`,
      `- Tests: ${testCount}`,
      `- Residuals: ${residualTotal}`,
      `- Issues: ${issues.length}`,
      "",
      "## Works",
      "",
      "| Work | Status | Agent ms | Queue ms | Slot ms | Files | Disposition |",
      "|---|---|---:|---:|---:|---:|---|",
      ...works.map((work) => {
        const timings = record(work.timings);
        return `| ${String(work.workId ?? work.runId)} | ${String(work.status)} | ${String(record(work.agent)?.durationMs ?? "-")} | ${String(record(timings?.editorPoolQueueWait)?.durationMs ?? "-")} | ${String(record(timings?.editorSlotOccupied)?.durationMs ?? "-")} | ${String(record(work.patch)?.changedFileCount ?? 0)} | ${String(record(work.disposition)?.phase ?? "pending")} |`;
      }),
      "",
    ].join("\n");
    return {
      summary,
      metrics,
      events: normalizedEvents,
      markdown,
      runIds: [...runIds],
    };
  }

  async #exportJournals(evidencePath: string, runIds: readonly string[]): Promise<void> {
    const logRoot = path.join(evidencePath, "logs");
    await mkdir(logRoot, { recursive: true });
    for (const runId of runIds) {
      const source = path.join(this.#stateRoot, runId, "events.jsonl");
      try {
        if ((await stat(source)).size <= MaximumLogBytes)
          await copyFile(source, path.join(logRoot, `${runId}.events.jsonl`));
      } catch {
        // Journal integrity is reported by analysis; log export remains best effort.
      }
    }
  }

  async #read(): Promise<SessionDescriptor | undefined> {
    try {
      const entry = await lstat(this.#statePath);
      if (!entry.isFile() || entry.isSymbolicLink() || entry.size > 1024 * 1024)
        throw new Error("unsafe dogfood state");
      return SessionDescriptorSchema.parse(JSON.parse(await readFile(this.#statePath, "utf8")));
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
        return undefined;
      throw dogfoodError(
        "dogfood.state-invalid",
        "Dogfood session state is invalid or unreadable.",
        error,
      );
    }
  }

  async #write(value: unknown): Promise<void> {
    const descriptor = SessionDescriptorSchema.parse(value);
    await atomicWrite(this.#statePath, JSON.stringify(descriptor, null, 2) + "\n");
  }

  #status(enabled: boolean, descriptor: SessionDescriptor | undefined): DesktopDogfoodStatusV1 {
    if (descriptor === undefined)
      return DesktopDogfoodStatusV1Schema.parse({
        schemaVersion: 1,
        enabled,
        state: "idle",
        observedAt: new Date().toISOString(),
      });
    const workCount = descriptor.parents.reduce((total, parent) => total + parent.workCount, 0);
    return DesktopDogfoodStatusV1Schema.parse({
      schemaVersion: 1,
      enabled,
      state: descriptor.state,
      observedAt: new Date().toISOString(),
      session: {
        schemaVersion: 1,
        sessionId: descriptor.sessionId,
        profileId: descriptor.profileId,
        projectLabel: descriptor.projectLabel,
        startedAt: descriptor.startedAt,
        ...(descriptor.stoppedAt === undefined ? {} : { stoppedAt: descriptor.stoppedAt }),
        evidencePath: descriptor.evidencePath,
        workCount,
        ...(descriptor.summary === undefined ? {} : { summary: descriptor.summary }),
      },
    });
  }

  #serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation, operation);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
