import path from "node:path";

import type { SessionId } from "@honeybee/domain";

import { RuntimeOperationError } from "./errors.js";
import { FileSessionLogFactory, type SessionLog, type SessionLogFactory } from "./log.js";
import type { Disposable, PtyExitEvent, PtyFactoryPort, PtyProcessPort } from "./pty-port.js";
import { TextRingBuffer } from "./ring-buffer.js";
import type {
  ExitReason,
  PtySessionEvent,
  SessionSnapshot,
  StartPtySessionRequest,
  TerminalSize,
} from "./types.js";

interface ManagedSession {
  readonly sessionId: SessionId;
  readonly process: PtyProcessPort;
  readonly buffer: TextRingBuffer;
  readonly log: SessionLog;
  dataSubscription: Disposable | undefined;
  exitSubscription: Disposable | undefined;
  seq: number;
  terminationIntent: "interrupt" | "stop" | "force" | undefined;
  finalizing: boolean;
}

export interface PtySessionManagerOptions {
  readonly ringBufferBytes?: number;
  readonly logDirectory?: string;
  readonly logFactory?: SessionLogFactory;
  readonly diagnostic?: (message: string, error?: unknown) => void;
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

  public constructor(ptyFactory: PtyFactoryPort, options: PtySessionManagerOptions = {}) {
    this.#ptyFactory = ptyFactory;
    this.#ringBufferBytes = options.ringBufferBytes ?? 1024 * 1024;
    this.#diagnostic = options.diagnostic ?? (() => undefined);
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
        seq: 0,
        exitCode: null,
        signal: null,
        reason: "spawn-failed",
      });
      if (error instanceof RuntimeOperationError) {
        throw error;
      }
      throw new RuntimeOperationError(
        "runtime.spawn-failed",
        `Failed to start session "${request.sessionId}".`,
        false,
        { cause: error instanceof Error ? error.message : String(error) },
      );
    }

    const buffer = new TextRingBuffer(this.#ringBufferBytes);
    const entry: ManagedSession = {
      sessionId: request.sessionId,
      process,
      buffer,
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
      seq: entry.seq,
      pid: process.pid,
      logFilePath: log.filePath,
    });
    return this.#snapshot(entry);
  }

  public input(sessionId: SessionId, data: string): void {
    const entry = this.#get(sessionId);
    try {
      entry.process.write(data);
    } catch (error: unknown) {
      throw new RuntimeOperationError("pty.write-failed", "Failed to write PTY input.", true, {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }

  public resize(sessionId: SessionId, size: TerminalSize): void {
    assertTerminalSize(size);
    const entry = this.#get(sessionId);
    try {
      entry.process.resize(size.cols, size.rows);
    } catch (error: unknown) {
      throw new RuntimeOperationError("pty.resize-failed", "Failed to resize the PTY.", true, {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }

  public interrupt(sessionId: SessionId): void {
    const entry = this.#get(sessionId);
    entry.terminationIntent = "interrupt";
    this.input(sessionId, "\u0003");
  }

  public stop(sessionId: SessionId, force = false): void {
    const entry = this.#get(sessionId);
    entry.terminationIntent = force ? "force" : "stop";
    try {
      entry.process.kill();
    } catch (error: unknown) {
      throw new RuntimeOperationError("pty.stop-failed", "Failed to stop the PTY.", true, {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }

  public getSnapshot(sessionId: SessionId): SessionSnapshot {
    return this.#snapshot(this.#get(sessionId));
  }

  public async shutdown(): Promise<void> {
    const entries = [...this.#sessions.values()];
    for (const entry of entries) {
      entry.terminationIntent = "force";
      try {
        entry.process.kill();
      } catch (error: unknown) {
        this.#diagnostic(`Failed to kill PTY session "${entry.sessionId}" during shutdown.`, error);
      }
      await this.#finalize(entry, { exitCode: 0 });
    }
  }

  #get(sessionId: SessionId): ManagedSession {
    const entry = this.#sessions.get(sessionId);
    if (entry === undefined) {
      throw new RuntimeOperationError(
        "runtime.session-not-found",
        `Session "${sessionId}" is not running.`,
        false,
      );
    }
    return entry;
  }

  #handleData(entry: ManagedSession, data: string): void {
    if (entry.finalizing) {
      return;
    }
    entry.buffer.append(data);
    entry.log.write(data);
    entry.seq += 1;
    this.#emit({
      type: "session.output",
      sessionId: entry.sessionId,
      seq: entry.seq,
      data,
    });
  }

  async #finalize(entry: ManagedSession, exit: PtyExitEvent): Promise<void> {
    if (entry.finalizing) {
      return;
    }
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
      case undefined:
        return "exited";
    }
  }

  #snapshot(entry: ManagedSession): SessionSnapshot {
    return {
      sessionId: entry.sessionId,
      data: entry.buffer.snapshot(),
      byteLength: entry.buffer.byteLength,
      truncatedBytes: entry.buffer.truncatedBytes,
      logFilePath: entry.log.filePath,
    };
  }

  #emit(event: PtySessionEvent): void {
    for (const listener of this.#listeners) {
      listener(event);
    }
  }
}
