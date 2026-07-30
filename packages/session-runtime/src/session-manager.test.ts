import { RunIdSchema, SessionIdSchema } from "@honeybee/domain";
import { describe, expect, it, vi } from "vitest";

import type { SessionLog, SessionLogFactory } from "./log.js";
import type { Disposable, PtyExitEvent, PtyFactoryPort, PtyProcessPort } from "./pty-port.js";
import { PtySessionManager } from "./session-manager.js";
import type { PtySessionEvent } from "./types.js";

class FakePtyProcess implements PtyProcessPort {
  public readonly pid = 4242;
  public readonly writes: string[] = [];
  public readonly resizes: Array<readonly [number, number]> = [];
  public killCount = 0;
  readonly #dataListeners = new Set<(data: string) => void>();
  readonly #exitListeners = new Set<(event: PtyExitEvent) => void>();

  public onData(listener: (data: string) => void): Disposable {
    this.#dataListeners.add(listener);
    return { dispose: () => this.#dataListeners.delete(listener) };
  }

  public onExit(listener: (event: PtyExitEvent) => void): Disposable {
    this.#exitListeners.add(listener);
    return { dispose: () => this.#exitListeners.delete(listener) };
  }

  public write(data: string): void {
    this.writes.push(data);
  }

  public resize(cols: number, rows: number): void {
    this.resizes.push([cols, rows]);
  }

  public kill(): void {
    this.killCount += 1;
  }

  public emitData(data: string): void {
    for (const listener of this.#dataListeners) {
      listener(data);
    }
  }

  public emitExit(event: PtyExitEvent): void {
    for (const listener of [...this.#exitListeners]) {
      listener(event);
    }
  }
}

class FakePtyFactory implements PtyFactoryPort {
  readonly #spawnError: Error | undefined;
  public constructor(
    public readonly process = new FakePtyProcess(),
    spawnError?: Error,
  ) {
    this.#spawnError = spawnError;
  }

  public spawn(): PtyProcessPort {
    if (this.#spawnError !== undefined) {
      throw this.#spawnError;
    }
    return this.process;
  }
}

class MemoryLogFactory implements SessionLogFactory {
  public readonly content = new Map<string, string>();
  public closed = 0;

  public async create(sessionId: ReturnType<typeof SessionIdSchema.parse>): Promise<SessionLog> {
    const filePath = `memory://${sessionId}.pty.log`;
    this.content.set(filePath, "");
    return {
      filePath,
      write: (data) => this.content.set(filePath, `${this.content.get(filePath) ?? ""}${data}`),
      close: async () => {
        this.closed += 1;
      },
    };
  }
}

const sessionId = SessionIdSchema.parse("session-1");
const runId = RunIdSchema.parse("run-1");
const launchSpec = {
  command: "agent.exe",
  args: ["--safe"],
  cwd: "C:\\repo",
  env: { PATH: "C:\\Tools" },
  shell: false,
} as const;

class MultiPtyFactory implements PtyFactoryPort {
  public readonly processes = [new FakePtyProcess(), new FakePtyProcess()];
  #index = 0;

  public spawn(): PtyProcessPort {
    const process = this.processes[this.#index];
    this.#index += 1;
    if (process === undefined) throw new Error("No fake PTY remains.");
    return process;
  }
}

class SelectiveHangingLogFactory implements SessionLogFactory {
  public async create(sessionId: ReturnType<typeof SessionIdSchema.parse>): Promise<SessionLog> {
    return {
      filePath: `memory://${sessionId}.pty.log`,
      write: () => undefined,
      close:
        sessionId === "session-1"
          ? () => new Promise<void>(() => undefined)
          : async () => undefined,
    };
  }
}
const startRequest = {
  sessionId,
  runId,
  launchSpec,
  size: { cols: 80, rows: 24 },
} as const;

describe("PtySessionManager", () => {
  it("owns input, resize, ANSI/UTF-8 output, bounded buffer, and a full separate log", async () => {
    const factory = new FakePtyFactory();
    const logs = new MemoryLogFactory();
    const manager = new PtySessionManager(factory, { ringBufferBytes: 12, logFactory: logs });
    const events: PtySessionEvent[] = [];
    manager.onEvent((event) => events.push(event));

    const started = await manager.start(startRequest);
    factory.process.emitData("old");
    factory.process.emitData("\u001b[31m벌\u001b[0m");
    manager.input(sessionId, runId, "hello");
    manager.resize(sessionId, runId, { cols: 120, rows: 40 });

    const snapshot = manager.getSnapshot(sessionId, runId);
    expect(started.logFilePath).toBe("memory://session-1.pty.log");
    expect(snapshot.byteLength).toBeLessThanOrEqual(12);
    expect(snapshot.data).not.toContain("�");
    expect(snapshot.truncatedBytes).toBeGreaterThan(0);
    expect(logs.content.get(snapshot.logFilePath)).toBe("old\u001b[31m벌\u001b[0m");
    expect(factory.process.writes).toEqual(["hello"]);
    expect(factory.process.resizes).toEqual([[120, 40]]);
    expect(events.map(({ type }) => type)).toEqual([
      "session.started",
      "session.output",
      "session.output",
    ]);
  });

  it("distinguishes interrupt, normal stop, force stop, and natural exit reasons", async () => {
    const cases = [
      { action: "interrupt", expected: "interrupted" },
      { action: "stop", expected: "stopped" },
      { action: "force", expected: "force-killed" },
      { action: "natural", expected: "exited" },
    ] as const;

    for (const testCase of cases) {
      const factory = new FakePtyFactory();
      const manager = new PtySessionManager(factory, { logFactory: new MemoryLogFactory() });
      const events: PtySessionEvent[] = [];
      manager.onEvent((event) => events.push(event));
      await manager.start(startRequest);

      if (testCase.action === "interrupt") {
        manager.interrupt(sessionId, runId);
        expect(factory.process.writes).toEqual(["\u0003"]);
      } else if (testCase.action === "stop") {
        manager.stop(sessionId, runId);
      } else if (testCase.action === "force") {
        manager.stop(sessionId, runId, true);
      }
      factory.process.emitExit({ exitCode: testCase.action === "natural" ? 7 : 0, signal: 1 });

      await vi.waitFor(() => expect(manager.activeSessionCount).toBe(0));
      const exit = events.find((event) => event.type === "session.exited");
      expect(exit).toMatchObject({
        type: "session.exited",
        exitCode: testCase.action === "natural" ? 7 : 0,
        signal: 1,
        reason: testCase.expected,
      });
    }
  });

  it("rejects stale Run actions and shuts down idempotently with a lifecycle reason", async () => {
    const factory = new FakePtyFactory();
    const manager = new PtySessionManager(factory, { logFactory: new MemoryLogFactory() });
    const events: PtySessionEvent[] = [];
    manager.onEvent((event) => events.push(event));
    await manager.start(startRequest);

    expect(() => manager.input(sessionId, RunIdSchema.parse("run-stale"), "secret")).toThrowError(
      expect.objectContaining({ code: "runtime.stale-run" }),
    );
    expect(factory.process.writes).toEqual([]);

    const first = manager.shutdown("extension-shutdown");
    const second = manager.shutdown("runtime-shutdown");
    expect(first).toBe(second);
    await expect(first).resolves.toEqual({ stoppedRuns: 1, unresolvedRuns: 0 });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "session.exited",
        sessionId,
        runId,
        reason: "extension-shutdown",
      }),
    );
  });
  it("bounds one stuck Session cleanup while other Sessions still stop", async () => {
    const factory = new MultiPtyFactory();
    const manager = new PtySessionManager(factory, {
      logFactory: new SelectiveHangingLogFactory(),
      shutdownTimeoutMs: 20,
    });
    await manager.start(startRequest);
    await manager.start({
      ...startRequest,
      sessionId: SessionIdSchema.parse("session-2"),
      runId: RunIdSchema.parse("run-2"),
    });

    await expect(manager.shutdown("extension-shutdown")).resolves.toEqual({
      stoppedRuns: 1,
      unresolvedRuns: 1,
    });
    expect(factory.processes.map((process) => process.killCount)).toEqual([1, 1]);
  });
  it("rejects duplicate sessions and maps spawn errors", async () => {
    const manager = new PtySessionManager(new FakePtyFactory(), {
      logFactory: new MemoryLogFactory(),
    });
    await manager.start(startRequest);

    await expect(manager.start(startRequest)).rejects.toMatchObject({
      code: "runtime.duplicate-session",
    });
    await manager.shutdown();

    const failed = new PtySessionManager(new FakePtyFactory(undefined, new Error("ABI load")), {
      logFactory: new MemoryLogFactory(),
    });
    const failedEvents: PtySessionEvent[] = [];
    failed.onEvent((event) => failedEvents.push(event));
    await expect(failed.start(startRequest)).rejects.toMatchObject({
      code: "runtime.spawn-failed",
    });
    expect(failedEvents).toContainEqual({
      type: "session.exited",
      sessionId,
      runId,
      seq: 0,
      exitCode: null,
      signal: null,
      reason: "spawn-failed",
    });
  });
});
