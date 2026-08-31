import { randomUUID } from "node:crypto";

import type { AgentSessionTraceEvent, AgentSessionTraceObserver } from "honeybee-cli/runtime";

import {
  DesktopTerminalSnapshotV1Schema,
  type DesktopTerminalEntryV1,
  type DesktopTerminalModeV1,
  type DesktopTerminalSnapshotV1,
} from "../shared/ipc.js";

const MAX_ENTRIES_PER_RUN = 5_000;
const MAX_BYTES_PER_RUN = 2 * 1024 * 1024;
const MAX_ENTRY_BYTES = 16 * 1024;
const COALESCE_BYTES = 4 * 1024;
const COALESCE_MS = 100;
const TRUNCATED_SUFFIX = "\n… [entry truncated]";

interface StoredRun {
  entries: DesktopTerminalEntryV1[];
  bytes: number;
  truncated: boolean;
}

interface PendingTrace {
  event: AgentSessionTraceEvent;
  text: string;
  timer: ReturnType<typeof setTimeout>;
}

export interface TerminalSnapshotOptions {
  readonly scopeKey: string;
  readonly runIds: readonly string[];
  readonly afterCursor: number;
  readonly mode: DesktopTerminalModeV1;
  readonly state: DesktopTerminalSnapshotV1["state"];
  readonly rawEnabled: boolean;
}

const byteLength = (value: string): number => Buffer.byteLength(value, "utf8");

const boundedText = (value: string): string => {
  if (byteLength(value) <= MAX_ENTRY_BYTES) return value;
  const suffixBytes = byteLength(TRUNCATED_SUFFIX);
  const prefix = Buffer.from(value, "utf8")
    .subarray(0, MAX_ENTRY_BYTES - suffixBytes)
    .toString("utf8")
    .replace(/\uFFFD$/u, "");
  return prefix + TRUNCATED_SUFFIX;
};

const isCoalescedChannel = (event: AgentSessionTraceEvent): boolean =>
  event.mode === "readable" &&
  (event.channel === "assistant" || event.channel === "tool" || event.channel === "stderr");

const traceKey = (event: AgentSessionTraceEvent): string =>
  `${event.runId}\0${event.stepId}\0${event.mode}\0${event.channel}\0${event.direction ?? ""}`;

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

export class DesktopTerminalBroker implements AgentSessionTraceObserver {
  readonly #runs = new Map<string, StoredRun>();
  readonly #pending = new Map<string, PendingTrace>();
  readonly #replayedRuns = new Set<string>();
  readonly #scopes = new Map<string, { signature: string; instanceId: string }>();
  #cursor = 0;

  public onTrace(event: AgentSessionTraceEvent): void {
    if (!isCoalescedChannel(event)) {
      this.#flushRun(event.runId);
      this.#append(event);
      return;
    }
    const key = traceKey(event);
    const pending = this.#pending.get(key);
    if (pending !== undefined) {
      pending.text += event.text;
      if (byteLength(pending.text) >= COALESCE_BYTES) this.#flush(key);
      return;
    }
    const timer = setTimeout(() => this.#flush(key), COALESCE_MS);
    timer.unref?.();
    this.#pending.set(key, { event, text: event.text, timer });
  }

  public hasEntries(runId: string): boolean {
    return (this.#runs.get(runId)?.entries.length ?? 0) > 0 || this.#hasPending(runId);
  }

  public hasReplayed(runId: string): boolean {
    return this.#replayedRuns.has(runId);
  }

  public markReplayAttempted(runId: string): void {
    this.#replayedRuns.add(runId);
  }

  public replayTranscript(
    runId: AgentSessionTraceEvent["runId"],
    stepId: AgentSessionTraceEvent["stepId"],
    serializedTranscript: string,
    timestamp: string,
  ): void {
    if (this.#replayedRuns.has(runId) || this.hasEntries(runId)) return;
    this.#replayedRuns.add(runId);
    this.onTrace({
      runId,
      stepId,
      timestamp,
      channel: "system",
      mode: "readable",
      text: "Replaying the durable Agent session transcript.",
    });
    for (const line of serializedTranscript.split(/\r?\n/u)) {
      if (line.trim().length === 0) continue;
      this.onTrace({
        runId,
        stepId,
        timestamp,
        channel: "raw",
        mode: "raw",
        text: line,
      });
      this.#replayReadable(runId, stepId, timestamp, line);
    }
    this.#flushRun(runId);
  }

  public snapshot(options: TerminalSnapshotOptions): DesktopTerminalSnapshotV1 {
    const runIds = new Set(options.runIds);
    const signature = [...runIds].sort().join("\0");
    const previousScope = this.#scopes.get(options.scopeKey);
    const scope =
      previousScope?.signature === signature
        ? previousScope
        : { signature, instanceId: randomUUID() };
    this.#scopes.set(options.scopeKey, scope);
    for (const runId of runIds) this.#flushRun(runId);
    const stored = [...runIds].flatMap((runId) => this.#runs.get(runId)?.entries ?? []);
    const latestCursor = stored.reduce((latest, entry) => Math.max(latest, entry.cursor), 0);
    const rawAvailable = options.rawEnabled && stored.some((entry) => entry.mode === "raw");
    const entries =
      options.mode === "raw" && !options.rawEnabled
        ? []
        : stored
            .filter((entry) => entry.mode === options.mode && entry.cursor > options.afterCursor)
            .sort((left, right) => left.cursor - right.cursor);
    return DesktopTerminalSnapshotV1Schema.parse({
      schemaVersion: 1,
      instanceId: scope.instanceId,
      cursor: latestCursor,
      state: options.state,
      entries,
      truncated: [...runIds].some((runId) => this.#runs.get(runId)?.truncated === true),
      rawAvailable,
    });
  }

  #hasPending(runId: string): boolean {
    return [...this.#pending.values()].some((pending) => pending.event.runId === runId);
  }

  #flushRun(runId: string): void {
    for (const [key, pending] of this.#pending) {
      if (pending.event.runId === runId) this.#flush(key);
    }
  }

  #flush(key: string): void {
    const pending = this.#pending.get(key);
    if (pending === undefined) return;
    clearTimeout(pending.timer);
    this.#pending.delete(key);
    this.#append({ ...pending.event, text: pending.text });
  }

  #append(event: AgentSessionTraceEvent): void {
    const text = boundedText(event.text);
    const entry: DesktopTerminalEntryV1 = {
      cursor: ++this.#cursor,
      runId: event.runId,
      stepId: event.stepId,
      timestamp: event.timestamp,
      channel: event.channel,
      mode: event.mode,
      text,
      ...(event.direction === undefined ? {} : { direction: event.direction }),
    };
    const run = this.#runs.get(event.runId) ?? {
      entries: [],
      bytes: 0,
      truncated: false,
    };
    run.entries.push(entry);
    run.bytes += byteLength(text);
    while (run.entries.length > MAX_ENTRIES_PER_RUN || run.bytes > MAX_BYTES_PER_RUN) {
      const removed = run.entries.shift();
      if (removed === undefined) break;
      run.bytes -= byteLength(removed.text);
      run.truncated = true;
    }
    this.#runs.set(event.runId, run);
  }

  #replayReadable(
    runId: AgentSessionTraceEvent["runId"],
    stepId: AgentSessionTraceEvent["stepId"],
    timestamp: string,
    line: string,
  ): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      return;
    }
    const message = record(parsed);
    const method = typeof message?.method === "string" ? message.method : "";
    const params = record(message?.params) ?? {};
    if (method === "item/agentMessage/delta" && typeof params.delta === "string") {
      this.onTrace({
        runId,
        stepId,
        timestamp,
        channel: "assistant",
        mode: "readable",
        text: params.delta,
      });
      return;
    }
    if (method === "session/update") {
      const update = record(params.update) ?? {};
      const content = record(update.content) ?? {};
      if (update.sessionUpdate === "agent_message_chunk" && typeof content.text === "string") {
        this.onTrace({
          runId,
          stepId,
          timestamp,
          channel: "assistant",
          mode: "readable",
          text: content.text,
        });
      }
      return;
    }
    if (method.includes("commandExecution") || method.includes("fileChange")) {
      this.onTrace({
        runId,
        stepId,
        timestamp,
        channel: "tool",
        mode: "readable",
        text: method.replaceAll("/", " · "),
      });
    }
  }
}
