import { describe, expect, it, vi } from "vitest";

import { AgentSessionSchema, type AgentSession, type SessionId } from "@honeybee/domain";
import { InMemoryDraftRepository, InMemorySessionRepository } from "@honeybee/persistence";
import type { ExtensionToConsoleMessage } from "@honeybee/ui-shared";

import type {
  AgentProfileResolverPort,
  ClockPort,
  RuntimeClientEvent,
  RuntimeClientPort,
  RuntimeConnectionState,
  RuntimeStartRequest,
} from "./ports.js";
import { ConsoleApplicationService } from "./console-service.js";
import { SessionSelectionService } from "./session-selection.js";

class FakeRuntimeClient implements RuntimeClientPort {
  readonly inputs: { readonly sessionId: SessionId; readonly data: string }[] = [];
  readonly resizes: {
    readonly sessionId: SessionId;
    readonly columns: number;
    readonly rows: number;
  }[] = [];
  starts: RuntimeStartRequest[] = [];
  connectionState: RuntimeConnectionState = "disconnected";
  #listener: ((event: RuntimeClientEvent) => void) | undefined;

  public async connect(): Promise<void> {
    this.connectionState = "connected";
    this.emit({ type: "connection", state: "connected", message: "Runtime connected." });
  }

  public async start(request: RuntimeStartRequest): Promise<void> {
    this.starts.push(request);
  }

  public async sendInput(sessionId: SessionId, data: string): Promise<void> {
    this.inputs.push({ sessionId, data });
  }

  public async resize(sessionId: SessionId, columns: number, rows: number): Promise<void> {
    this.resizes.push({ sessionId, columns, rows });
  }

  public async interrupt(_sessionId: SessionId): Promise<void> {}

  public async stop(_sessionId: SessionId): Promise<void> {}

  public onEvent(listener: (event: RuntimeClientEvent) => void): { dispose(): void } {
    this.#listener = listener;
    return {
      dispose: () => {
        this.#listener = undefined;
      },
    };
  }

  public async dispose(): Promise<void> {}

  public emit(event: RuntimeClientEvent): void {
    this.#listener?.(event);
  }
}

const clock: ClockPort = {
  now: () => "2026-07-29T12:00:00.000Z",
};

const profiles: AgentProfileResolverPort = {
  resolve: async () => ({
    command: "fake-agent",
    args: ["--test"],
    cwd: "C:\\workspace",
    environment: { PATH: "C:\\bin" },
    shell: false,
  }),
};

const session = (): AgentSession =>
  AgentSessionSchema.parse({
    id: "session-1",
    title: "Console session",
    agentProfileId: "codex",
    toolProfileId: "default",
    tags: [],
    relatedSessionIds: [],
    status: "idle",
    createdAt: "2026-07-29T12:00:00.000Z",
    updatedAt: "2026-07-29T12:00:00.000Z",
  });

describe("ConsoleApplicationService", () => {
  it("projects selection, drafts, runtime lifecycle, input, resize, and PTY output", async () => {
    const selected = session();
    const sessions = new InMemorySessionRepository([selected]);
    const drafts = new InMemoryDraftRepository();
    const selection = new SessionSelectionService();
    const runtime = new FakeRuntimeClient();
    const service = new ConsoleApplicationService(
      sessions,
      drafts,
      selection,
      runtime,
      profiles,
      clock,
    );
    const messages: ExtensionToConsoleMessage[] = [];
    service.onMessage((message) => {
      messages.push(message);
    });

    await service.initialize();
    selection.select(selected.id);
    await vi.waitFor(() => expect(service.state.selectedSession?.id).toBe(selected.id));
    await service.saveDraft(selected.id, "continue fixing");
    await service.resize(selected.id, 100, 30);
    expect(runtime.resizes).toEqual([]);

    await service.start(selected.id);
    expect(runtime.starts[0]).toMatchObject({
      sessionId: selected.id,
      command: "fake-agent",
      columns: 100,
      rows: 30,
    });
    runtime.emit({
      type: "session.status",
      sessionId: selected.id,
      status: "running",
      message: "Agent is running.",
    });
    await vi.waitFor(() => expect(service.state.selectedSession?.status).toBe("running"));
    await service.resize(selected.id, 120, 36);
    expect(runtime.resizes).toContainEqual({
      sessionId: selected.id,
      columns: 120,
      rows: 36,
    });

    await service.sendPrompt(selected.id, "hello");
    expect(runtime.inputs).toContainEqual({ sessionId: selected.id, data: "hello\r" });
    expect((await drafts.getBySessionId(selected.id)).ok).toBe(true);
    runtime.emit({
      type: "pty.data",
      sessionId: selected.id,
      sequence: 1,
      data: "\u001b[32mready\u001b[0m\r\n",
    });
    expect(messages).toContainEqual({
      type: "terminal.data",
      sessionId: selected.id,
      data: "\u001b[32mready\u001b[0m\r\n",
    });

    await service.dispose();
  });
});
