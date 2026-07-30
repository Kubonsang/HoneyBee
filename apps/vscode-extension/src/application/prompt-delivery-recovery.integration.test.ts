import { SessionDraftSchema, SessionIdSchema, type SessionId } from "@honeybee/domain";
import { describe, expect, it } from "vitest";

import { GlobalStatePromptDeliveryAttemptRepository } from "../adapters/global-state-prompt-attempt-repository.js";
import { GlobalStatePromptDeliveryReceiptRepository } from "../adapters/global-state-prompt-receipt-repository.js";
import {
  GlobalStateDraftRepository,
  type MementoPort,
} from "../adapters/global-state-repositories.js";
import { deliverPrompt } from "./prompt-delivery.js";
import { PromptDeliveryReconciler } from "./prompt-delivery-reconciler.js";
import type {
  RuntimeClientEvent,
  PromptRuntimeInputPort,
  RuntimeConnectionState,
  RuntimeInputOutcome,
  RuntimeStartRequest,
} from "./ports.js";

const DRAFT_STORAGE_KEY = "honeyBee.drafts.v1";

class RecoveryMemento implements MementoPort {
  readonly #values = new Map<string, unknown>();
  public failNextDraftDelete = false;

  public get<T>(key: string, defaultValue: T): T {
    return (this.#values.has(key) ? structuredClone(this.#values.get(key)) : defaultValue) as T;
  }

  public update(key: string, value: unknown): Thenable<void> {
    if (
      key === DRAFT_STORAGE_KEY &&
      this.failNextDraftDelete &&
      Array.isArray(value) &&
      value.length === 0
    ) {
      this.failNextDraftDelete = false;
      return Promise.reject(new Error("Injected Draft storage outage."));
    }
    this.#values.set(key, structuredClone(value));
    return Promise.resolve();
  }
}

class RecoveryRuntime implements PromptRuntimeInputPort {
  public readonly connectionState: RuntimeConnectionState = "connected";
  public readonly inputs: string[] = [];

  public connect(): Promise<void> {
    return Promise.resolve();
  }
  public start(_request: RuntimeStartRequest): Promise<void> {
    return Promise.resolve();
  }
  public sendInput(_sessionId: SessionId, data: string): Promise<RuntimeInputOutcome> {
    this.inputs.push(data);
    return Promise.resolve({ status: "accepted" });
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

const sessionId = SessionIdSchema.parse("recovery-session");
const firstClock = { now: () => "2026-07-30T12:00:00.000Z" };

describe("Prompt delivery restart recovery integration", () => {
  it("removes a matching stale Draft after restart without Runtime redelivery", async () => {
    const state = new RecoveryMemento();
    const runtime = new RecoveryRuntime();
    const drafts = new GlobalStateDraftRepository(state);
    const attempts = new GlobalStatePromptDeliveryAttemptRepository(state);
    const receipts = new GlobalStatePromptDeliveryReceiptRepository(state);
    state.failNextDraftDelete = true;

    const delivery = await deliverPrompt(
      { drafts, attempts, receipts, runtime, clock: firstClock },
      "request-restart",
      sessionId,
      "?? Prompt\r\nexact bytes",
    );
    expect(delivery).toMatchObject({
      status: "accepted",
      receiptPersistence: "stored",
      draftCleanup: "pending",
    });
    expect(runtime.inputs).toEqual(["?? Prompt\r\nexact bytes\r"]);

    const restartedDrafts = new GlobalStateDraftRepository(state);
    const restartedReceipts = new GlobalStatePromptDeliveryReceiptRepository(state);
    const report = await new PromptDeliveryReconciler({
      drafts: restartedDrafts,
      receipts: restartedReceipts,
    }).reconcile();
    const restoredDraft = await restartedDrafts.getBySessionId(sessionId);
    const restoredReceipt = await restartedReceipts.getByRequestId("request-restart");

    expect(restoredDraft.ok ? restoredDraft.value : undefined).toBeUndefined();
    expect(restoredReceipt.ok ? restoredReceipt.value?.draftCleanup : undefined).toBe("cleared");
    expect(report.reconciledDrafts).toBe(1);
    expect(runtime.inputs).toHaveLength(1);
    expect(JSON.stringify(restoredReceipt)).not.toContain("?? Prompt");
  });

  it("preserves a different Draft written after successful delivery", async () => {
    const state = new RecoveryMemento();
    const runtime = new RecoveryRuntime();
    const drafts = new GlobalStateDraftRepository(state);
    const attempts = new GlobalStatePromptDeliveryAttemptRepository(state);
    const receipts = new GlobalStatePromptDeliveryReceiptRepository(state);
    state.failNextDraftDelete = true;

    await deliverPrompt(
      { drafts, attempts, receipts, runtime, clock: firstClock },
      "request-new-draft",
      sessionId,
      "old delivered Prompt",
    );
    await drafts.save(
      SessionDraftSchema.parse({
        sessionId,
        content: "new unsent Draft",
        updatedAt: "2026-07-30T12:01:00.000Z",
      }),
    );

    const restartedDrafts = new GlobalStateDraftRepository(state);
    const restartedReceipts = new GlobalStatePromptDeliveryReceiptRepository(state);
    await new PromptDeliveryReconciler({
      drafts: restartedDrafts,
      receipts: restartedReceipts,
    }).reconcile();
    const restoredDraft = await restartedDrafts.getBySessionId(sessionId);

    expect(restoredDraft.ok ? restoredDraft.value?.content : undefined).toBe("new unsent Draft");
    expect(runtime.inputs).toHaveLength(1);
  });
});
