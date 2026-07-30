import {
  SessionIdSchema,
  err,
  type PromptDeliveryReceipt,
  type SessionDraft,
  type SessionId,
} from "@honeybee/domain";
import {
  InMemoryDraftRepository,
  InMemoryPromptDeliveryReceiptRepository,
  RepositoryError,
} from "@honeybee/persistence";
import { describe, expect, it } from "vitest";

import { deliverPrompt } from "./prompt-delivery.js";
import type {
  RuntimeClientEvent,
  RuntimeClientPort,
  RuntimeConnectionState,
  RuntimeStartRequest,
} from "./ports.js";

class RecordingDraftRepository extends InMemoryDraftRepository {
  public failDelete = false;
  public constructor(
    private readonly trace: string[],
    initialDrafts: readonly SessionDraft[] = [],
  ) {
    super(initialDrafts);
  }

  public override async save(draft: SessionDraft) {
    this.trace.push("draft.save");
    return super.save(draft);
  }

  public override async delete(sessionId: SessionId) {
    this.trace.push("draft.delete");
    return this.failDelete
      ? err(new RepositoryError("unknown", "Draft delete failed."))
      : super.delete(sessionId);
  }
}

class RecordingReceiptRepository extends InMemoryPromptDeliveryReceiptRepository {
  public failSaveCall: number | undefined;
  public failPrune = false;
  public saveCalls = 0;

  public constructor(private readonly trace: string[]) {
    super();
  }

  public override async save(receipt: PromptDeliveryReceipt) {
    this.saveCalls += 1;
    this.trace.push(`receipt.save.${receipt.draftCleanup}`);
    return this.failSaveCall === this.saveCalls
      ? err(new RepositoryError("unknown", "Receipt save failed."))
      : super.save(receipt);
  }

  public override async prune(policy: { readonly maxClearedReceipts: number }) {
    this.trace.push("receipt.prune");
    return this.failPrune
      ? err(new RepositoryError("unknown", "Receipt prune failed."))
      : super.prune(policy);
  }
}

class RecordingRuntime implements RuntimeClientPort {
  public readonly connectionState: RuntimeConnectionState = "connected";
  public readonly inputs: string[] = [];
  public failInput = false;

  public constructor(private readonly trace: string[]) {}

  public connect(): Promise<void> {
    return Promise.resolve();
  }

  public start(_request: RuntimeStartRequest): Promise<void> {
    return Promise.resolve();
  }

  public sendInput(_sessionId: SessionId, data: string): Promise<void> {
    this.trace.push("runtime.sendInput");
    this.inputs.push(data);
    return this.failInput
      ? Promise.reject(new Error("secret echoed by runtime"))
      : Promise.resolve();
  }

  public resize(_sessionId: SessionId, _columns: number, _rows: number): Promise<void> {
    return Promise.resolve();
  }

  public interrupt(_sessionId: SessionId): Promise<void> {
    return Promise.resolve();
  }

  public stop(_sessionId: SessionId): Promise<void> {
    return Promise.resolve();
  }

  public onEvent(_listener: (event: RuntimeClientEvent) => void): { dispose(): void } {
    return { dispose: () => undefined };
  }

  public dispose(): Promise<void> {
    return Promise.resolve();
  }
}

const sessionId = SessionIdSchema.parse("session-1");

const setup = () => {
  const trace: string[] = [];
  return {
    trace,
    drafts: new RecordingDraftRepository(trace),
    receipts: new RecordingReceiptRepository(trace),
    runtime: new RecordingRuntime(trace),
    clock: { now: () => "2026-07-30T12:00:00.000Z" },
  };
};

describe("deliverPrompt receipts", () => {
  it("stores the pending Receipt before Draft cleanup, then marks it cleared", async () => {
    const dependencies = setup();

    const result = await deliverPrompt(dependencies, "request-1", sessionId, "exact Prompt");

    expect(result).toEqual({
      status: "accepted",
      receiptPersistence: "stored",
      draftCleanup: "cleared",
      warnings: [],
    });
    expect(dependencies.trace).toEqual([
      "draft.save",
      "runtime.sendInput",
      "receipt.save.pending",
      "draft.delete",
      "receipt.save.cleared",
      "receipt.prune",
    ]);
    const stored = await dependencies.receipts.getByRequestId("request-1");
    expect(stored.ok ? stored.value?.draftCleanup : undefined).toBe("cleared");
  });

  it("creates no Receipt and preserves the Draft when Runtime input fails", async () => {
    const dependencies = setup();
    dependencies.runtime.failInput = true;

    const result = await deliverPrompt(dependencies, "request-1", sessionId, "secret Prompt");
    const receipt = await dependencies.receipts.getByRequestId("request-1");
    const draft = await dependencies.drafts.getBySessionId(sessionId);

    expect(result).toEqual({
      status: "rejected",
      message: "The Runtime rejected the Prompt input.",
    });
    expect(receipt.ok ? receipt.value : undefined).toBeUndefined();
    expect(draft.ok ? draft.value?.content : undefined).toBe("secret Prompt");
    expect(JSON.stringify(result)).not.toContain("secret Prompt");
  });

  it("accepts with pending cleanup when Receipt persisted but Draft delete failed", async () => {
    const dependencies = setup();
    dependencies.drafts.failDelete = true;

    const result = await deliverPrompt(dependencies, "request-1", sessionId, "retry cleanup");

    expect(result).toEqual({
      status: "accepted",
      receiptPersistence: "stored",
      draftCleanup: "pending",
      warnings: ["draft-delete-failed"],
    });
  });

  it("does not misclassify a Receipt save failure after Runtime success", async () => {
    const dependencies = setup();
    dependencies.receipts.failSaveCall = 1;

    const result = await deliverPrompt(dependencies, "request-1", sessionId, "delivered once");

    expect(result).toEqual({
      status: "accepted",
      receiptPersistence: "warning",
      draftCleanup: "cleared",
      warnings: ["receipt-save-failed"],
    });
    expect(dependencies.runtime.inputs).toEqual(["delivered once\r"]);
  });

  it("keeps the Draft and never resends when Receipt save and cleanup both fail", async () => {
    const dependencies = setup();
    dependencies.receipts.failSaveCall = 1;
    dependencies.drafts.failDelete = true;

    const result = await deliverPrompt(dependencies, "request-1", sessionId, "do not repeat");
    const draft = await dependencies.drafts.getBySessionId(sessionId);

    expect(result).toEqual({
      status: "accepted",
      receiptPersistence: "warning",
      draftCleanup: "warning",
      warnings: ["receipt-save-failed", "draft-delete-failed"],
    });
    expect(dependencies.runtime.inputs).toHaveLength(1);
    expect(draft.ok ? draft.value?.content : undefined).toBe("do not repeat");
  });

  it("reports cleanup-state update and prune failures without changing delivery success", async () => {
    const dependencies = setup();
    dependencies.receipts.failSaveCall = 2;
    dependencies.receipts.failPrune = true;

    const result = await deliverPrompt(dependencies, "request-1", sessionId, "already delivered");

    expect(result).toEqual({
      status: "accepted",
      receiptPersistence: "stored",
      draftCleanup: "cleared",
      warnings: ["receipt-cleanup-update-failed", "receipt-prune-failed"],
    });
    expect(dependencies.runtime.inputs).toHaveLength(1);
  });
});
