import { describe, expect, it } from "vitest";

import {
  AgentSessionSchema,
  RunIdSchema,
  SessionRunRecordSchema,
  type AgentSession,
  type SessionId,
} from "@honeybee/domain";
import {
  InMemoryDraftRepository,
  InMemoryPromptDeliveryAttemptRepository,
  InMemoryPromptDeliveryReceiptRepository,
  InMemorySessionRepository,
  InMemorySessionRunRepository,
} from "@honeybee/persistence";

import type {
  AgentProfileResolverPort,
  ClockPort,
  RuntimeClientEvent,
  RuntimeClientPort,
  RuntimeConnectionState,
  RuntimeInputOutcome,
  RuntimeStartRequest,
} from "../application/ports.js";
import { ConsoleApplicationService } from "../application/console-service.js";
import { SessionSelectionService } from "../application/session-selection.js";
import { PromptDeliveryCoordinator } from "./prompt-delivery-coordinator.js";

class DeliveryRuntime implements RuntimeClientPort {
  readonly inputs: { readonly sessionId: SessionId; readonly data: string }[] = [];
  connectionState: RuntimeConnectionState = "connected";
  readonly runtimeHello = undefined;

  public constructor(private readonly failInput: boolean) {}

  public async connect(): Promise<void> {}
  public async start(_request: RuntimeStartRequest): Promise<void> {}

  public async sendInput(sessionId: SessionId, data: string): Promise<RuntimeInputOutcome> {
    this.inputs.push({ sessionId, data });
    return this.failInput
      ? { status: "rejected", message: "Injected integration Runtime rejection." }
      : { status: "accepted" };
  }

  public async resize(_sessionId: SessionId, _columns: number, _rows: number): Promise<void> {}
  public async interrupt(_sessionId: SessionId): Promise<void> {}
  public async stop(_sessionId: SessionId): Promise<void> {}

  public async shutdown(): Promise<{
    readonly state: "stopped";
    readonly stoppedRuns: number;
    readonly unresolvedRuns: number;
  }> {
    return { state: "stopped", stoppedRuns: 0, unresolvedRuns: 0 };
  }

  public onEvent(_listener: (event: RuntimeClientEvent) => void): { dispose(): void } {
    return { dispose: () => undefined };
  }

  public async dispose(): Promise<void> {}
}

const clock: ClockPort = {
  now: () => "2026-07-30T13:00:00.000Z",
};

const profiles: AgentProfileResolverPort = {
  resolve: async () => ({
    command: "fake-agent",
    args: [],
    cwd: "C:\\workspace",
    environment: {},
    shell: false,
  }),
};

const session = (): AgentSession =>
  AgentSessionSchema.parse({
    id: "delivery-integration",
    title: "Delivery integration",
    agentProfileId: "custom",
    tags: [],
    relatedSessionIds: [],
    status: "running",
    createdAt: "2026-07-30T13:00:00.000Z",
    updatedAt: "2026-07-30T13:00:00.000Z",
  });

const setup = (failInput: boolean) => {
  const selected = session();
  const drafts = new InMemoryDraftRepository();
  const runtime = new DeliveryRuntime(failInput);
  const receipts = new InMemoryPromptDeliveryReceiptRepository();
  const run = SessionRunRecordSchema.parse({
    runId: "run-delivery",
    sessionId: selected.id,
    runtimeInstanceId: "runtime-test",
    phase: "running",
    startedAt: "2026-07-30T13:00:00.000Z",
    updatedAt: "2026-07-30T13:00:00.000Z",
    schemaVersion: 1,
  });
  const service = new ConsoleApplicationService(
    new InMemorySessionRepository([selected]),
    drafts,
    new InMemoryPromptDeliveryAttemptRepository(),
    receipts,
    new InMemorySessionRunRepository([run]),
    new SessionSelectionService(),
    runtime,
    profiles,
    clock,
    {
      requestId: () => "replacement",
      runId: () => RunIdSchema.parse("run-unused"),
    },
  );
  const coordinator = new PromptDeliveryCoordinator(
    service,
    () => undefined,
    () => undefined,
  );
  return { coordinator, drafts, receipts, runtime, selected, service };
};

const draftContent = async (
  drafts: InMemoryDraftRepository,
  sessionId: SessionId,
): Promise<string | undefined> => {
  const result = await drafts.getBySessionId(sessionId);
  if (!result.ok) {
    throw result.error;
  }
  return result.value?.content;
};

describe("Console Prompt delivery integration", () => {
  it("writes exactly once, accepts, and clears the Draft", async () => {
    const { coordinator, drafts, runtime, selected, service } = setup(false);
    await service.select(selected.id);
    coordinator.scheduleDraft(selected.id, "Echo this once");

    await expect(
      coordinator.deliver({
        type: "prompt.send",
        requestId: "integration-success",
        sessionId: selected.id,
        content: "Echo this once",
      }),
    ).resolves.toEqual({
      type: "prompt.accepted",
      requestId: "integration-success",
      sessionId: selected.id,
      attemptPersistence: "stored",
      receiptPersistence: "stored",
      draftCleanup: "cleared",
      warnings: [],
    });

    expect(runtime.inputs).toEqual([{ sessionId: selected.id, data: "Echo this once\r" }]);
    expect(await draftContent(drafts, selected.id)).toBeUndefined();
  });

  it("writes exactly once, rejects, and preserves both persisted and editor source content", async () => {
    const { coordinator, drafts, runtime, selected, service } = setup(true);
    await service.select(selected.id);

    await expect(
      coordinator.deliver({
        type: "prompt.send",
        requestId: "integration-failure",
        sessionId: selected.id,
        content: "Keep after failure",
      }),
    ).resolves.toEqual({
      type: "prompt.rejected",
      requestId: "integration-failure",
      sessionId: selected.id,
      message: "Injected integration Runtime rejection.",
    });

    expect(runtime.inputs).toEqual([{ sessionId: selected.id, data: "Keep after failure\r" }]);
    expect(await draftContent(drafts, selected.id)).toBe("Keep after failure");
  });
});
