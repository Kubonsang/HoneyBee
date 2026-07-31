import {
  AgentSessionSchema,
  RunIdSchema,
  RuntimeInstanceIdSchema,
  type AgentSession,
  type RunId,
  type SessionId,
} from "@honeybee/domain";
import { InMemorySessionRepository, InMemorySessionRunRepository } from "@honeybee/persistence";
import { describe, expect, it } from "vitest";

import type {
  RuntimeClientEvent,
  RuntimeClientPort,
  RuntimeConnectionState,
  RuntimeHello,
  RuntimeInputOutcome,
  RuntimeShutdownReason,
  RuntimeShutdownResult,
  RuntimeStartRequest,
} from "./ports.js";
import { SessionRunController } from "./session-run-controller.js";

class FakeRuntime implements RuntimeClientPort {
  connectionState: RuntimeConnectionState = "connected";
  readonly runtimeHello: RuntimeHello = {
    protocolVersion: 2,
    runtimeInstanceId: RuntimeInstanceIdSchema.parse("runtime-current"),
    pid: 42,
  };
  readonly starts: RuntimeStartRequest[] = [];
  readonly inputs: Array<{ sessionId: SessionId; runId: RunId; data: string }> = [];
  startHook: (() => Promise<void>) | undefined;

  public async connect(): Promise<void> {}
  public async start(request: RuntimeStartRequest): Promise<void> {
    this.starts.push(request);
    await this.startHook?.();
  }
  public async sendInput(
    sessionId: SessionId,
    data: string,
    runId: RunId,
  ): Promise<RuntimeInputOutcome> {
    this.inputs.push({ sessionId, runId, data });
    return { status: "accepted" };
  }
  public async resize(
    _sessionId: SessionId,
    _columns: number,
    _rows: number,
    _runId: RunId,
  ): Promise<void> {}
  public async interrupt(_sessionId: SessionId, _runId: RunId): Promise<void> {}
  public async stop(_sessionId: SessionId, _runId: RunId): Promise<void> {}
  public async shutdown(_reason: RuntimeShutdownReason): Promise<RuntimeShutdownResult> {
    return { state: "stopped", stoppedRuns: 0, unresolvedRuns: 0 };
  }
  public onEvent(_listener: (event: RuntimeClientEvent) => void): { dispose(): void } {
    return { dispose: () => undefined };
  }
  public async dispose(): Promise<void> {}
}

const session = (id = "session-1"): AgentSession =>
  AgentSessionSchema.parse({
    id,
    title: id,
    agentProfileId: "custom",
    tags: [],
    relatedSessionIds: [],
    status: "idle",
    createdAt: "2026-07-30T10:00:00.000Z",
    updatedAt: "2026-07-30T10:00:00.000Z",
  });

const profile = {
  command: "agent.exe",
  args: [],
  cwd: "C:\\workspace",
  environment: {},
  shell: false,
} as const;

const createController = (
  sessions: InMemorySessionRepository,
  runs: InMemorySessionRunRepository,
  runtime: FakeRuntime,
  diagnostics: string[] = [],
) => {
  let nextRun = 0;
  const controller = new SessionRunController(
    sessions,
    runs,
    runtime,
    { now: () => "2026-07-30T10:00:00.000Z" },
    { runId: () => RunIdSchema.parse(`run-${++nextRun}`) },
    (code) => diagnostics.push(code),
  );
  return controller;
};

describe("SessionRunController", () => {
  it("persists starting identity before exactly one Runtime start", async () => {
    const selected = session();
    const sessions = new InMemorySessionRepository([selected]);
    const runs = new InMemorySessionRunRepository();
    const runtime = new FakeRuntime();
    let durableBeforeStart = false;
    runtime.startHook = async () => {
      const active = await runs.getActiveBySessionId(selected.id);
      durableBeforeStart = active.ok && active.value?.phase === "starting";
    };
    const controller = createController(sessions, runs, runtime);
    await controller.connect();

    const runId = await controller.start(selected, profile, { columns: 80, rows: 24 });

    expect(durableBeforeStart).toBe(true);
    expect(runtime.starts).toHaveLength(1);
    expect(runtime.starts[0]?.runId).toBe(runId);
  });

  it("records start failure, permits a fresh Run, and rejects duplicate active start", async () => {
    const selected = session();
    const sessions = new InMemorySessionRepository([selected]);
    const runs = new InMemorySessionRunRepository();
    const runtime = new FakeRuntime();
    runtime.startHook = async () => {
      throw new Error("spawn failed");
    };
    const controller = createController(sessions, runs, runtime);
    await controller.connect();

    await expect(controller.start(selected, profile, { columns: 80, rows: 24 })).rejects.toThrow(
      "spawn failed",
    );
    const failedRuns = await runs.list();
    expect(failedRuns.ok ? failedRuns.value[0] : undefined).toMatchObject({
      phase: "failed",
      terminationReason: "start-failed",
    });
    const failedSession = await sessions.getById(selected.id);
    expect(failedSession.ok ? failedSession.value.status : undefined).toBe("failed");

    runtime.startHook = undefined;
    if (!failedSession.ok) throw failedSession.error;
    const nextRun = await controller.start(failedSession.value, profile, {
      columns: 80,
      rows: 24,
    });
    expect(nextRun).not.toBe(failedRuns.ok ? failedRuns.value[0]?.runId : undefined);
    await expect(
      controller.start(failedSession.value, profile, { columns: 80, rows: 24 }),
    ).rejects.toMatchObject({ code: "session-run-conflict" });
    expect(runtime.starts).toHaveLength(2);
  });
  it("ignores Run A late terminal event after Run B starts", async () => {
    const selected = session();
    const sessions = new InMemorySessionRepository([selected]);
    const runs = new InMemorySessionRunRepository();
    const runtime = new FakeRuntime();
    const diagnostics: string[] = [];
    const controller = createController(sessions, runs, runtime, diagnostics);
    await controller.connect();
    const runA = await controller.start(selected, profile, { columns: 80, rows: 24 });
    await controller.handleStatus({
      sessionId: selected.id,
      runId: runA,
      sequence: 1,
      status: "running",
      message: "running A",
    });
    await controller.handleStatus({
      sessionId: selected.id,
      runId: runA,
      sequence: 1,
      status: "completed",
      reason: "process-exit-zero",
      exitCode: 0,
      message: "completed A",
    });
    const restored = await sessions.getById(selected.id);
    if (!restored.ok) throw restored.error;
    const runB = await controller.start(restored.value, profile, { columns: 80, rows: 24 });

    const late = await controller.handleStatus({
      sessionId: selected.id,
      runId: runA,
      sequence: 1,
      status: "stopped",
      reason: "user-stop",
      message: "late A",
    });
    const active = await runs.getActiveBySessionId(selected.id);

    expect(late).toBeUndefined();
    expect(active.ok ? active.value?.runId : undefined).toBe(runB);
    expect(diagnostics).toContain("stale-runtime-event");
  });

  it("gates new mutations during shutdown and interrupts only current active Runs", async () => {
    const selected = session();
    const sessions = new InMemorySessionRepository([selected]);
    const runs = new InMemorySessionRunRepository();
    const runtime = new FakeRuntime();
    const controller = createController(sessions, runs, runtime);
    await controller.connect();
    await controller.start(selected, profile, { columns: 80, rows: 24 });
    controller.beginShutdown();

    await expect(controller.sendInput(selected.id, "secret prompt")).rejects.toMatchObject({
      code: "lifecycle-shutting-down",
    });
    expect(runtime.inputs).toEqual([]);
    expect(await controller.interruptRemaining("runtime-disconnected")).toBe(1);
    const stored = await sessions.getById(selected.id);
    expect(stored.ok ? stored.value.status : undefined).toBe("stopped");
    expect(JSON.stringify(await runs.list())).not.toContain("secret prompt");
  });
});
