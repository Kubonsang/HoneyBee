import { describe, expect, it, vi } from "vitest";

import {
  AgentSessionSchema,
  err,
  type AgentSession,
  type Result,
  type SessionId,
} from "@honeybee/domain";
import {
  InMemoryDraftRepository,
  InMemoryPromptDeliveryReceiptRepository,
  InMemorySessionRepository,
  RepositoryError,
  type DraftRepository,
} from "@honeybee/persistence";

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

class PromptRuntimeClient implements RuntimeClientPort {
  readonly attempts: { readonly sessionId: SessionId; readonly data: string }[] = [];
  connectionState: RuntimeConnectionState = "connected";
  sendInputImplementation: (() => Promise<void>) | undefined;

  public async connect(): Promise<void> {}
  public async start(_request: RuntimeStartRequest): Promise<void> {}

  public async sendInput(sessionId: SessionId, data: string): Promise<void> {
    this.attempts.push({ sessionId, data });
    await this.sendInputImplementation?.();
  }

  public async resize(_sessionId: SessionId, _columns: number, _rows: number): Promise<void> {}
  public async interrupt(_sessionId: SessionId): Promise<void> {}
  public async stop(_sessionId: SessionId): Promise<void> {}

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

const clock: ClockPort = {
  now: () => "2026-07-30T12:00:00.000Z",
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
    id: "prompt-session",
    title: "Prompt delivery",
    agentProfileId: "custom",
    tags: [],
    relatedSessionIds: [],
    status: "running",
    createdAt: "2026-07-30T12:00:00.000Z",
    updatedAt: "2026-07-30T12:00:00.000Z",
  });

const createService = (drafts: DraftRepository, runtime: PromptRuntimeClient) => {
  const selected = session();
  return {
    selected,
    service: new ConsoleApplicationService(
      new InMemorySessionRepository([selected]),
      drafts,
      new InMemoryPromptDeliveryReceiptRepository(),
      new SessionSelectionService(),
      runtime,
      profiles,
      clock,
    ),
  };
};

const readDraft = async (
  drafts: DraftRepository,
  sessionId: SessionId,
): Promise<string | undefined> => {
  const result = await drafts.getBySessionId(sessionId);
  if (!result.ok) {
    throw result.error;
  }
  return result.value?.content;
};

describe("ConsoleApplicationService Prompt delivery", () => {
  it("preserves the exact Draft until Runtime input succeeds, then accepts and clears it", async () => {
    const drafts = new InMemoryDraftRepository();
    const runtime = new PromptRuntimeClient();
    let releaseRuntime: (() => void) | undefined;
    runtime.sendInputImplementation = () =>
      new Promise<void>((resolve) => {
        releaseRuntime = resolve;
      });
    const { selected, service } = createService(drafts, runtime);

    const delivery = service.sendPrompt("request-success", selected.id, "exact content");
    await vi.waitFor(() => expect(runtime.attempts).toHaveLength(1));
    expect(await readDraft(drafts, selected.id)).toBe("exact content");

    releaseRuntime?.();
    await expect(delivery).resolves.toEqual({
      status: "accepted",
      receiptPersistence: "stored",
      draftCleanup: "cleared",
      warnings: [],
    });
    expect(await readDraft(drafts, selected.id)).toBeUndefined();
    expect(runtime.attempts).toEqual([{ sessionId: selected.id, data: "exact content\r" }]);
  });

  it("rejects a Runtime write failure and preserves the submitted Draft", async () => {
    const drafts = new InMemoryDraftRepository();
    const runtime = new PromptRuntimeClient();
    runtime.sendInputImplementation = async () => {
      throw new Error("Injected Runtime write failure.");
    };
    const { selected, service } = createService(drafts, runtime);

    await expect(
      service.sendPrompt("request-runtime-failure", selected.id, "retry this"),
    ).resolves.toEqual({
      status: "rejected",
      message: "The Runtime rejected the Prompt input.",
    });
    expect(await readDraft(drafts, selected.id)).toBe("retry this");
    expect(runtime.attempts).toHaveLength(1);
  });

  it("does not misclassify cleanup failure after a successful Runtime write", async () => {
    const drafts = new DeleteFailingDraftRepository();
    const runtime = new PromptRuntimeClient();
    const { selected, service } = createService(drafts, runtime);

    await expect(
      service.sendPrompt("request-cleanup-failure", selected.id, "delivered once"),
    ).resolves.toEqual({
      status: "accepted",
      receiptPersistence: "stored",
      draftCleanup: "pending",
      warnings: ["draft-delete-failed"],
    });
    expect(runtime.attempts).toHaveLength(1);
    expect(await readDraft(drafts, selected.id)).toBe("delivered once");
  });

  it("rejects an empty Prompt without touching Runtime or Draft persistence", async () => {
    const drafts = new InMemoryDraftRepository();
    const runtime = new PromptRuntimeClient();
    const { selected, service } = createService(drafts, runtime);

    await expect(service.sendPrompt("request-empty", selected.id, "  \n ")).resolves.toEqual({
      status: "rejected",
      message: "Prompt content must not be empty.",
    });
    expect(runtime.attempts).toEqual([]);
    expect(await readDraft(drafts, selected.id)).toBeUndefined();
  });
});
