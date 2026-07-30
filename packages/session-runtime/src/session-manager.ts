import path from "node:path";

import type { RunId, SessionId } from "@honeybee/domain";

import { RuntimeOperationError } from "./errors.js";
import { FileSessionLogFactory, type SessionLog, type SessionLogFactory } from "./log.js";
import type { Disposable, PtyExitEvent, PtyFactoryPort, PtyProcessPort } from "./pty-port.js";
import { TextRingBuffer } from "./ring-buffer.js";
import type {
  ExitReason,
  PtySessionEvent,
  PtyShutdownReport,
  SessionSnapshot,
  StartPtySessionRequest,
  TerminalSize,
} from "./types.js";

interface ManagedSession {
  readonly sessionId: SessionId;
  readonly runId: RunId;
  readonly process: PtyProcessPort;
  readonly buffer: TextRingBuffer;
  readonly log: SessionLog;
  dataSubscription: Disposable | undefined;
  exitSubscription: Disposable | undefined;
  seq: number;
  terminationIntent:
    "interrupt" | "stop" | "force" | "extension-shutdown" | "runtime-shutdown" | undefined;
  finalizing: boolean;
}

export interface PtySessionManagerOptions {
  readonly ringBufferBytes?: number;
  readonly logDirectory?: string;
  readonly logFactory?: SessionLogFactory;
  readonly diagnostic?: (message: string, error?: unknown) => void;
  readonly shutdownTimeoutMs?: number;
}

const assertTerminalSize = (size: TerminalSize): void => {
  if (
    !Number.isSafeInteger(size.cols) ||
    !Number.isSafeInteger(size.rows) ||
    size.cols <= 0 ||
    size.rows <= 0 ||
    size.cols > 1000 ||
    size.rows > 1000
  ) {
    throw new RuntimeOperationError(
      "validation.invalid-request",
      "Terminal size must be between 1 and 1000 columns/rows.",
      false,
    );
  }
};

export class PtySessionManager {
  readonly #ptyFactory: PtyFactoryPort;
  readonly #sessions = new Map<SessionId, ManagedSession>();
  readonly #listeners = new Set<(event: PtySessionEvent) => void>();
  readonly #ringBufferBytes: number;
  readonly #logFactory: SessionLogFactory;
  readonly #diagnostic: (message: string, error?: unknown) => void;
  readonly #shutdownTimeoutMs: number;
  #acceptingRequests = true;
  #shutdownPromise: Promise<PtyShutdownReport> | undefined;

  public constructor(ptyFactory: PtyFactoryPort, options: PtySessionManagerOptions = {}) {
    this.#ptyFactory = ptyFactory;
    this.#ringBufferBytes = options.ringBufferBytes ?? 1024 * 1024;
    this.#diagnostic = options.diagnostic ?? (() => undefined);
    this.#shutdownTimeoutMs = options.shutdownTimeoutMs ?? 2_000;
    this.#logFactory =
      options.logFactory ??
      new FileSessionLogFactory(
        options.logDirectory ?? path.resolve(".honeybee", "logs"),
        (error) => this.#diagnostic("PTY log write failed.", error),
      );
  }

  public get activeSessionCount(): number {
    return this.#sessions.size;
  }

  public onEvent(listener: (event: PtySessionEvent) => void): Disposable {
    this.#listeners.add(listener);
    return { dispose: () => this.#listeners.delete(listener) };
  }

  public async start(request: StartPtySessionRequest): Promise<SessionSnapshot> {
    this.#assertAccepting();
    assertTerminalSize(request.size);
    if (this.#sessions.has(request.sessionId)) {
      throw new RuntimeOperationError(
        "runtime.duplicate-session",
        `Session "${request.sessionId}" is already running.`,
        false,
      );
    }

    const log = await this.#logFactory.create(request.sessionId, request.logFilePath);
    let process: PtyProcessPort;
    try {
      process = this.#ptyFactory.spawn(request.launchSpec, request.size);
    } catch (error: unknown) {
      await log.close();
      this.#emit({
        type: "session.exited",
        sessionId: request.sessionId,
        runId: request.runId,
        seq: 0,
        exitCode: null,
        signal: null,
        reason: "spawn-failed",
      });
      if (error instanceof RuntimeOperationError) throw error;
      throw new RuntimeOperationError(
        "runtime.spawn-failed",
        `Failed to start session "${request.sessionId}".`,
        false,
        { cause: error instanceof Error ? error.message : String(error) },
      );
    }

    const entry: ManagedSession = {
      sessionId: request.sessionId,
      runId: request.runId,
      process,
      buffer: new TextRingBuffer(this.#ringBufferBytes),
      log,
      seq: 0,
      terminationIntent: undefined,
      finalizing: false,
      dataSubscription: undefined,
      exitSubscription: undefined,
    };
    this.#sessions.set(request.sessionId, entry);
    entry.dataSubscription = process.onData((data) => this.#handleData(entry, data));
    entry.exitSubscription = process.onExit((event) => {
      void this.#finalize(entry, event);
    });
    this.#emit({
      type: "session.started",
      sessionId: request.sessionId,
      runId: request.runId,
      seq: entry.seq,
      pid: process.pid,
      logFilePath: log.filePath,
    });
    return this.#snapshot(entry);
  }

  public input(sessionId: SessionId, runId: RunId, data: string): void {
    const entry = this.#get(sessionId, runId);
    try {
      entry.process.write(data);
    } catch (error: unknown) {
      throw new RuntimeOperationError("pty.write-failed", "Failed to write PTY input.", true, {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }

  public resize(sessionId: SessionId, runId: RunId, size: TerminalSize): void {
    assertTerminalSize(size);
    const entry = this.#get(sessionId, runId);
    try {
      entry.process.resize(size.cols, size.rows);
    } catch (error: unknown) {
      throw new RuntimeOperationError("pty.resize-failed", "Failed to resize the PTY.", true, {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }

  public interrupt(sessionId: SessionId, runId: RunId): void {
    const entry = this.#get(sessionId, runId);
    entry.terminationIntent = "interrupt";
    this.input(sessionId, runId, "\u0003");
  }

  public stop(sessionId: SessionId, runId: RunId, force = false): void {
    const entry = this.#get(sessionId, runId);
    entry.terminationIntent = force ? "force" : "stop";
    try {
      entry.process.kill();
    } catch (error: unknown) {
      throw new RuntimeOperationError("pty.stop-failed", "Failed to stop the PTY.", true, {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }

  public getSnapshot(sessionId: SessionId, runId: RunId): SessionSnapshot {
    return this.#snapshot(this.#get(sessionId, runId));
  }

  public shutdown(
    reason: "extension-shutdown" | "runtime-shutdown" = "runtime-shutdown",
  ): Promise<PtyShutdownReport> {
    this.#shutdownPromise ??= this.#shutdown(reason);
    return this.#shutdownPromise;
  }

  async #shutdown(reason: "extension-shutdown" | "runtime-shutdown"): Promise<PtyShutdownReport> {
    this.#acceptingRequests = false;
    const entries = [...this.#sessions.values()];
    const outcomes = await Promise.all(
      entries.map(async (entry) => {
        const cleanup = this.#stopForShutdown(entry, reason);
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const timed = new Promise<"timed-out">((resolve) => {
          timeout = setTimeout(() => resolve("timed-out"), this.#shutdownTimeoutMs);
        });
        try {
          const outcome = await Promise.race([cleanup, timed]);
          if (outcome === "timed-out") {
            this.#diagnostic(
              `Timed out stopping PTY Session ${entry.sessionId}, Run ${entry.runId}.`,
            );
            return false;
          }
          return outcome;
        } finally {
          if (timeout !== undefined) clearTimeout(timeout);
        }
      }),
    );
    const stoppedRuns = outcomes.filter(Boolean).length;
    return { stoppedRuns, unresolvedRuns: outcomes.length - stoppedRuns };
  }

  async #stopForShutdown(
    entry: ManagedSession,
    reason: "extension-shutdown" | "runtime-shutdown",
  ): Promise<boolean> {
    entry.terminationIntent = reason;
    try {
      entry.process.kill();
      await this.#finalize(entry, { exitCode: 0 });
      return true;
    } catch (error: unknown) {
      this.#diagnostic(
        `Failed to kill PTY Session ${entry.sessionId}, Run ${entry.runId} during shutdown.`,
        error,
      );
      return false;
    }
  }

  #assertAccepting(): void {
    if (!this.#acceptingRequests) {
      throw new RuntimeOperationError(
        "runtime.shutting-down",
        "The Runtime is shutting down and rejects new Session starts.",
        false,
      );
    }
  }

  #get(sessionId: SessionId, runId: RunId): ManagedSession {
    const entry = this.#sessions.get(sessionId);
    if (entry === undefined) {
      throw new RuntimeOperationError(
        "runtime.session-not-found",
        `Session "${sessionId}" is not running.`,
        false,
      );
    }
    if (entry.runId !== runId) {
      throw new RuntimeOperationError(
        "runtime.stale-run",
        `Run "${runId}" no longer owns Session "${sessionId}".`,
        false,
      );
    }
    return entry;
  }

  #handleData(entry: ManagedSession, data: string): void {
    if (entry.finalizing) return;
    entry.buffer.append(data);
    entry.log.write(data);
    entry.seq += 1;
    this.#emit({
      type: "session.output",
      sessionId: entry.sessionId,
      runId: entry.runId,
      seq: entry.seq,
      data,
    });
  }

  async #finalize(entry: ManagedSession, exit: PtyExitEvent): Promise<void> {
    if (entry.finalizing) return;
    entry.finalizing = true;
    entry.dataSubscription?.dispose();
    entry.exitSubscription?.dispose();
    try {
      await entry.log.close();
    } catch (error: unknown) {
      this.#diagnostic(`Failed to close PTY log "${entry.log.filePath}".`, error);
    }
    if (this.#sessions.get(entry.sessionId) === entry) {
      this.#sessions.delete(entry.sessionId);
    }
    entry.seq += 1;
    this.#emit({
      type: "session.exited",
      sessionId: entry.sessionId,
      runId: entry.runId,
      seq: entry.seq,
      exitCode: Number.isInteger(exit.exitCode) ? exit.exitCode : null,
      signal: exit.signal ?? null,
      reason: this.#exitReason(entry.terminationIntent),
    });
  }

  #exitReason(intent: ManagedSession["terminationIntent"]): ExitReason {
    switch (intent) {
      case "interrupt":
        return "interrupted";
      case "stop":
        return "stopped";
      case "force":
        return "force-killed";
      case "extension-shutdown":
      case "runtime-shutdown":
        return intent;
      case undefined:
        return "exited";
    }
  }

  #snapshot(entry: ManagedSession): SessionSnapshot {
    return {
      sessionId: entry.sessionId,
      runId: entry.runId,
      data: entry.buffer.snapshot(),
      byteLength: entry.buffer.byteLength,
      truncatedBytes: entry.buffer.truncatedBytes,
      logFilePath: entry.log.filePath,
    };
  }

  #emit(event: PtySessionEvent): void {
    for (const listener of this.#listeners) listener(event);
  }
}
