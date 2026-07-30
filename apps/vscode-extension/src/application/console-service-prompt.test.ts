import { describe, expect, it, vi } from "vitest";

import {
  AgentSessionSchema,
  RunIdSchema,
  SessionRunRecordSchema,
  err,
  type AgentSession,
  type Result,
  type SessionId,
} from "@honeybee/domain";
import {
  InMemoryDraftRepository,
  InMemoryPromptDeliveryAttemptRepository,
  InMemoryPromptDeliveryReceiptRepository,
  InMemorySessionRepository,
  InMemorySessionRunRepository,
  RepositoryError,
  type DraftRepository,
} from "@honeybee/persistence";

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

class PromptRuntimeClient implements RuntimeClientPort {
  readonly inputs: { readonly sessionId: SessionId; readonly data: string }[] = [];
  connectionState: RuntimeConnectionState = "connected";
  readonly runtimeHello = undefined;
  sendInputImplementation: (() => Promise<RuntimeInputOutcome>) | undefined;

  public async connect(): Promise<void> {}
  public async start(_request: RuntimeStartRequest): Promise<void> {}
  public async sendInput(sessionId: SessionId, data: string): Promise<RuntimeInputOutcome> {
    this.inputs.push({ sessionId, data });
    return (await this.sendInputImplementation?.()) ?? { status: "accepted" };
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

class DeleteFailingDraftRepository extends InMemoryDraftRepository {
  public override async delete(_sessionId: SessionId): Promise<Result<void, RepositoryError>> {
    return err(new RepositoryError("unknown", "Injected Draft cleanup failure."));
  }
}

const clock: ClockPort = { now: () => "2026-07-30T12:00:00.000Z" };
const profiles: AgentProfileResolverPort = {
  resolve: async () => ({
    command: "fake-agent",
    args: [],
    cwd: "C:\\workspace",
    environment: {},
    shell: false,
  }),
};
const session = (id = "prompt-session"): AgentSession =>
  AgentSessionSchema.parse({
    id,
    title: "Prompt delivery",
    agentProfileId: "custom",
    tags: [],
    relatedSessionIds: [],
    status: "running",
    createdAt: "2026-07-30T12:00:00.000Z",
    updatedAt: "2026-07-30T12:00:00.000Z",
  });

const run = (sessionId: SessionId, runId: string) =>
  SessionRunRecordSchema.parse({
    runId,
    sessionId,
    runtimeInstanceId: "runtime-test",
    phase: "running",
    startedAt: "2026-07-30T12:00:00.000Z",
    updatedAt: "2026-07-30T12:00:00.000Z",
    schemaVersion: 1,
  });

const createService = (drafts: DraftRepository, runtime: PromptRuntimeClient) => {
  const selected = session();
  const other = session("other-session");
  return {
    selected,
    other,
    service: new ConsoleApplicationService(
      new InMemorySessionRepository([selected, other]),
      drafts,
      new InMemoryPromptDeliveryAttemptRepository(),
      new InMemoryPromptDeliveryReceiptRepository(),
      new InMemorySessionRunRepository([
        run(selected.id, "run-selected"),
        run(other.id, "run-other"),
      ]),
      new SessionSelectionService(),
      runtime,
      profiles,
      clock,
      {
        requestId: () => "replacement-request",
        runId: () => RunIdSchema.parse("run-unused"),
      },
    ),
  };
};

const readDraft = async (
  drafts: DraftRepository,
  sessionId: SessionId,
): Promise<string | undefined> => {
  const result = await drafts.getBySessionId(sessionId);
  if (!result.ok) throw result.error;
  return result.value?.content;
};

describe("ConsoleApplicationService Prompt delivery", () => {
  it("preserves exact Draft until accepted, then clears it", async () => {
    const drafts = new InMemoryDraftRepository();
    const runtime = new PromptRuntimeClient();
    let releaseRuntime: ((outcome: RuntimeInputOutcome) => void) | undefined;
    runtime.sendInputImplementation = () =>
      new Promise<RuntimeInputOutcome>((resolve) => {
        releaseRuntime = resolve;
      });
    const { selected, service } = createService(drafts, runtime);

    const delivery = service.sendPrompt("request-success", selected.id, "exact content");
    await vi.waitFor(() => expect(runtime.inputs).toHaveLength(1));
    expect(await readDraft(drafts, selected.id)).toBe("exact content");
    releaseRuntime?.({ status: "accepted" });

    await expect(delivery).resolves.toEqual({
      status: "accepted",
      attemptPersistence: "stored",
      receiptPersistence: "stored",
      draftCleanup: "cleared",
      warnings: [],
    });
    expect(await readDraft(drafts, selected.id)).toBeUndefined();
  });

  it("keeps Draft and permits retry after explicit Runtime rejection", async () => {
    const drafts = new InMemoryDraftRepository();
    const runtime = new PromptRuntimeClient();
    runtime.sendInputImplementation = async () => ({
      status: "rejected",
      message: "Session stopped.",
    });
    const { selected, service } = createService(drafts, runtime);

    await expect(
      service.sendPrompt("request-rejected", selected.id, "retry this"),
    ).resolves.toEqual({
      status: "rejected",
      code: "runtime-input-rejected",
      message: "Session stopped.",
    });
    expect(await readDraft(drafts, selected.id)).toBe("retry this");
    expect(runtime.inputs).toHaveLength(1);
  });

  it("keeps Draft and locks only the Session after an unknown Runtime outcome", async () => {
    const drafts = new InMemoryDraftRepository();
    const runtime = new PromptRuntimeClient();
    runtime.sendInputImplementation = async () => ({
      status: "unknown",
      reason: "Response timed out.",
    });
    const { selected, other, service } = createService(drafts, runtime);
    await service.select(selected.id);

    await expect(
      service.sendPrompt("request-unknown", selected.id, "do not duplicate"),
    ).resolves.toEqual({
      status: "unknown",
      code: "runtime-input-outcome-unknown",
      message: "Response timed out.",
      warnings: [],
    });
    expect(service.state.recoveryIssue).toMatchObject({
      requestId: "request-unknown",
      draftMatch: "exact",
    });
    await expect(service.sendPrompt("blocked", selected.id, "second")).resolves.toMatchObject({
      status: "rejected",
    });
    expect(runtime.inputs).toHaveLength(1);
    runtime.sendInputImplementation = async () => ({ status: "accepted" });
    await expect(
      service.sendPrompt("other-request", other.id, "other Session works"),
    ).resolves.toMatchObject({
      status: "accepted",
    });
    expect(runtime.inputs).toHaveLength(2);
    expect(await readDraft(drafts, selected.id)).toBe("do not duplicate");
  });

  it("does not misclassify Draft cleanup failure after accepted Runtime input", async () => {
    const drafts = new DeleteFailingDraftRepository();
    const runtime = new PromptRuntimeClient();
    const { selected, service } = createService(drafts, runtime);

    await expect(
      service.sendPrompt("request-cleanup", selected.id, "delivered once"),
    ).resolves.toEqual({
      status: "accepted",
      attemptPersistence: "stored",
      receiptPersistence: "stored",
      draftCleanup: "pending",
      warnings: ["draft-delete-failed"],
    });
    expect(await readDraft(drafts, selected.id)).toBe("delivered once");
  });

  it("rejects an empty Prompt without Runtime or persistence", async () => {
    const drafts = new InMemoryDraftRepository();
    const runtime = new PromptRuntimeClient();
    const { selected, service } = createService(drafts, runtime);

    await expect(service.sendPrompt("request-empty", selected.id, "  \n ")).resolves.toEqual({
      status: "rejected",
      code: "draft-save-failed",
      message: "Prompt content must not be empty.",
    });
    expect(runtime.inputs).toEqual([]);
    expect(await readDraft(drafts, selected.id)).toBeUndefined();
  });
});
