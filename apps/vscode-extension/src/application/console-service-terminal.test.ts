import { describe, expect, it, vi } from "vitest";

import {
  AgentSessionSchema,
  RunIdSchema,
  RuntimeInstanceIdSchema,
  type AgentSession,
  type RunId,
  type SessionId,
} from "@honeybee/domain";
import {
  InMemoryDraftRepository,
  InMemoryPromptDeliveryAttemptRepository,
  InMemoryPromptDeliveryReceiptRepository,
  InMemorySessionRepository,
  InMemorySessionRunRepository,
} from "@honeybee/persistence";
import type { ExtensionToConsoleMessage } from "@honeybee/ui-shared";

import { ConsoleApplicationService } from "./console-service.js";
import type {
  AgentProfileResolverPort,
  ClockPort,
  RuntimeClientEvent,
  RuntimeClientPort,
  RuntimeConnectionState,
  RuntimeInputOutcome,
  RuntimeStartRequest,
} from "./ports.js";
import { SessionSelectionService } from "./session-selection.js";

class TerminalRuntime implements RuntimeClientPort {
  readonly starts: RuntimeStartRequest[] = [];
  readonly inputs: { sessionId: SessionId; runId: RunId; data: string }[] = [];
  connectionState: RuntimeConnectionState = "disconnected";
  readonly runtimeHello = {
    protocolVersion: 2,
    runtimeInstanceId: RuntimeInstanceIdSchema.parse("runtime-terminal-test"),
    pid: 77,
  };
  #listener: ((event: RuntimeClientEvent) => void) | undefined;

  public async connect(): Promise<void> {
    this.connectionState = "connected";
    this.emit({
      type: "connection",
      state: "connected",
      cause: "connect",
      message: "Runtime connected.",
    });
  }

  public async start(request: RuntimeStartRequest): Promise<void> {
    this.starts.push(request);
  }

  public async sendInput(
    sessionId: SessionId,
    data: string,
    runId: RunId,
  ): Promise<RuntimeInputOutcome> {
    this.inputs.push({ sessionId, runId, data });
    return { status: "accepted" };
  }

  public async resize(): Promise<void> {}
  public async interrupt(): Promise<void> {}
  public async stop(): Promise<void> {}

  public async shutdown(): Promise<{
    readonly state: "stopped";
    readonly stoppedRuns: number;
    readonly unresolvedRuns: number;
  }> {
    return { state: "stopped", stoppedRuns: 0, unresolvedRuns: 0 };
  }

  public onEvent(listener: (event: RuntimeClientEvent) => void): { dispose(): void } {
    this.#listener = listener;
    return { dispose: () => (this.#listener = undefined) };
  }

  public async dispose(): Promise<void> {}

  public emit(event: RuntimeClientEvent): void {
    this.#listener?.(event);
  }
}

const clock: ClockPort = {
  now: () => "2026-07-31T12:00:00.000Z",
};

const profiles: AgentProfileResolverPort = {
  resolve: async () => ({
    command: "echo-agent",
    args: [],
    cwd: "C:\\Honey Bee 한글",
    environment: {},
    shell: false,
  }),
};

const createSession = (id: string): AgentSession =>
  AgentSessionSchema.parse({
    id,
    title: id,
    agentProfileId: "custom",
    tags: [],
    relatedSessionIds: [],
    status: "idle",
    createdAt: "2026-07-31T12:00:00.000Z",
    updatedAt: "2026-07-31T12:00:00.000Z",
  });

describe("ConsoleApplicationService Run-scoped terminal routing", () => {
  it("keeps hidden Session output, opens exact replay, and rejects old Run data/actions", async () => {
    const sessionA = createSession("session-a");
    const sessionB = createSession("session-b");
    const sessions = new InMemorySessionRepository([sessionA, sessionB]);
    const selection = new SessionSelectionService();
    const runtime = new TerminalRuntime();
    const runIds = ["run-a1", "run-b1", "run-a2"].map((id) => RunIdSchema.parse(id));
    const diagnostics: { code: string; runId?: RunId }[] = [];
    const service = new ConsoleApplicationService(
      sessions,
      new InMemoryDraftRepository(),
      new InMemoryPromptDeliveryAttemptRepository(),
      new InMemoryPromptDeliveryReceiptRepository(),
      new InMemorySessionRunRepository(),
      selection,
      runtime,
      profiles,
      clock,
      {
        requestId: () => "request",
        runId: () => {
          const next = runIds.shift();
          if (next === undefined) throw new Error("Run ID fixture exhausted.");
          return next;
        },
      },
      [],
      (code, _sessionId, runId) => diagnostics.push({ code, ...(runId ? { runId } : {}) }),
    );
    const messages: ExtensionToConsoleMessage[] = [];
    service.onMessage((message) => messages.push(message));

    await service.initialize();
    await service.select(sessionA.id);
    await service.start(sessionA.id);
    const runA1 = runtime.starts[0]?.runId;
    if (runA1 === undefined) throw new Error("Run A1 did not start.");
    runtime.emit({
      type: "session.status",
      sessionId: sessionA.id,
      runId: runA1,
      sequence: 0,
      status: "running",
      message: "A1 running",
    });
    await vi.waitFor(() => expect(service.state.selectedRun?.runId).toBe(runA1));
    runtime.emit({
      type: "pty.data",
      sessionId: sessionA.id,
      runId: runA1,
      sequence: 1,
      data: "\u001b[?1049hVim A",
    });

    await service.select(sessionB.id);
    await service.start(sessionB.id);
    const runB1 = runtime.starts[1]?.runId;
    if (runB1 === undefined) throw new Error("Run B1 did not start.");
    runtime.emit({
      type: "session.status",
      sessionId: sessionB.id,
      runId: runB1,
      sequence: 0,
      status: "running",
      message: "B1 running",
    });
    await vi.waitFor(() => expect(service.state.selectedRun?.runId).toBe(runB1));
    runtime.emit({
      type: "pty.data",
      sessionId: sessionB.id,
      runId: runB1,
      sequence: 1,
      data: "Echo B",
    });
    runtime.emit({
      type: "pty.data",
      sessionId: sessionA.id,
      runId: runA1,
      sequence: 2,
      data: "\u001b[?25l hidden update",
    });
    await service.requestTerminalSnapshot(sessionA.id, runA1, 1);
    expect(messages.at(-1)).toMatchObject({
      type: "terminal.run.snapshot",
      sessionId: sessionA.id,
      runId: runA1,
      data: "\u001b[?1049hVim A\u001b[?25l hidden update",
      lastSeq: 2,
    });

    await service.select(sessionA.id);
    const replay = messages.filter((message) => message.type === "terminal.run.open").at(-1);
    expect(replay).toMatchObject({
      type: "terminal.run.open",
      sessionId: sessionA.id,
      runId: runA1,
      initial: {
        kind: "replay",
        data: "\u001b[?1049hVim A\u001b[?25l hidden update",
        firstSeq: 1,
        lastSeq: 2,
      },
    });

    runtime.emit({
      type: "session.status",
      sessionId: sessionA.id,
      runId: runA1,
      sequence: 3,
      status: "completed",
      reason: "process-exit-zero",
      exitCode: 0,
      message: "A1 completed",
    });
    await vi.waitFor(() => expect(service.state.selectedSession?.status).toBe("completed"));
    await service.start(sessionA.id);
    const runA2 = runtime.starts[2]?.runId;
    if (runA2 === undefined) throw new Error("Run A2 did not start.");
    expect(runA2).not.toBe(runA1);
    expect(service.state.selectedRun?.runId).toBe(runA2);

    const beforeLate = messages.length;
    runtime.emit({
      type: "pty.data",
      sessionId: sessionA.id,
      runId: runA1,
      sequence: 4,
      data: "late old Run",
    });
    expect(messages.slice(beforeLate)).not.toContainEqual(
      expect.objectContaining({ type: "terminal.run.data", runId: runA1, seq: 4 }),
    );
    expect(diagnostics).toContainEqual({ code: "terminal-run-stale-data", runId: runA1 });

    runtime.emit({
      type: "session.status",
      sessionId: sessionA.id,
      runId: runA2,
      sequence: 0,
      status: "running",
      message: "A2 running",
    });
    await vi.waitFor(() => expect(service.state.selectedRun?.interactive).toBe(true));
    await expect(service.sendTerminalInput(sessionA.id, runA1, "stale")).rejects.toMatchObject({
      code: "terminal-run-stale-input",
    });
    await service.sendTerminalInput(sessionA.id, runA2, "fresh");
    expect(runtime.inputs).toEqual([{ sessionId: sessionA.id, runId: runA2, data: "fresh" }]);

    await service.dispose();
  });
});
