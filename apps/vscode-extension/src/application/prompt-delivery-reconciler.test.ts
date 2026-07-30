import {
  PromptDeliveryReceiptSchema,
  SessionDraftSchema,
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

import { fingerprintPromptContent } from "./prompt-content-fingerprint.js";
import { PromptDeliveryReconciler } from "./prompt-delivery-reconciler.js";

const sessionId = SessionIdSchema.parse("session-1");

const draft = (content: string, overrides: Partial<SessionDraft> = {}): SessionDraft =>
  SessionDraftSchema.parse({
    sessionId,
    content,
    updatedAt: "2026-07-30T11:59:00.000Z",
    ...overrides,
  });

const receipt = (
  content: string,
  overrides: Partial<PromptDeliveryReceipt> = {},
): PromptDeliveryReceipt =>
  PromptDeliveryReceiptSchema.parse({
    requestId: "request-1",
    sessionId,
    ...fingerprintPromptContent(content),
    deliveredAt: "2026-07-30T12:00:00.000Z",
    draftCleanup: "pending",
    schemaVersion: 1,
    ...overrides,
  });

class FailingDraftRepository extends InMemoryDraftRepository {
  public deleteCalls = 0;
  public failDelete = false;

  public override async delete(targetSessionId: SessionId) {
    this.deleteCalls += 1;
    return this.failDelete
      ? err(new RepositoryError("unknown", "Draft delete failed."))
      : super.delete(targetSessionId);
  }
}

class FailingReceiptRepository extends InMemoryPromptDeliveryReceiptRepository {
  public failList = false;
  public failSave = false;
  public failPrune = false;

  public override async list() {
    return this.failList
      ? err(new RepositoryError("validation", "Invalid receipt store."))
      : super.list();
  }

  public override async save(value: PromptDeliveryReceipt) {
    return this.failSave
      ? err(new RepositoryError("unknown", "Receipt update failed."))
      : super.save(value);
  }

  public override async prune(policy: { readonly maxClearedReceipts: number }) {
    return this.failPrune
      ? err(new RepositoryError("unknown", "Receipt prune failed."))
      : super.prune(policy);
  }
}

describe("PromptDeliveryReconciler", () => {
  it("deletes an exact stale Draft and marks a pending Receipt cleared", async () => {
    const drafts = new InMemoryDraftRepository([draft("delivered")]);
    const receipts = new InMemoryPromptDeliveryReceiptRepository([receipt("delivered")]);

    const report = await new PromptDeliveryReconciler({ drafts, receipts }).reconcile();
    const restoredDraft = await drafts.getBySessionId(sessionId);
    const restoredReceipt = await receipts.getByRequestId("request-1");

    expect(restoredDraft.ok ? restoredDraft.value : undefined).toBeUndefined();
    expect(restoredReceipt.ok ? restoredReceipt.value?.draftCleanup : undefined).toBe("cleared");
    expect(report.reconciledDrafts).toBe(1);
  });

  it("also removes a matching stale Draft for an already-cleared Receipt", async () => {
    const drafts = new InMemoryDraftRepository([draft("delivered")]);
    const receipts = new InMemoryPromptDeliveryReceiptRepository([
      receipt("delivered", { draftCleanup: "cleared" }),
    ]);

    const report = await new PromptDeliveryReconciler({ drafts, receipts }).reconcile();

    expect(report.reconciledDrafts).toBe(1);
    expect(report.clearedReceipts).toBe(0);
  });

  it("marks a pending Receipt cleared when no Draft remains", async () => {
    const receipts = new InMemoryPromptDeliveryReceiptRepository([receipt("delivered")]);

    const report = await new PromptDeliveryReconciler({
      drafts: new InMemoryDraftRepository(),
      receipts,
    }).reconcile();
    const restored = await receipts.getByRequestId("request-1");

    expect(restored.ok ? restored.value?.draftCleanup : undefined).toBe("cleared");
    expect(report.clearedReceipts).toBe(1);
  });

  it("preserves a different or newer Draft and resolves the old Receipt", async () => {
    const cases = [
      draft("new content"),
      draft("delivered", { updatedAt: "2026-07-30T12:01:00.000Z" }),
    ];

    for (const candidate of cases) {
      const drafts = new InMemoryDraftRepository([candidate]);
      const receipts = new InMemoryPromptDeliveryReceiptRepository([receipt("delivered")]);
      const report = await new PromptDeliveryReconciler({ drafts, receipts }).reconcile();
      const restoredDraft = await drafts.getBySessionId(sessionId);
      const restoredReceipt = await receipts.getByRequestId("request-1");

      expect(restoredDraft.ok ? restoredDraft.value : undefined).toEqual(candidate);
      expect(restoredReceipt.ok ? restoredReceipt.value?.draftCleanup : undefined).toBe("cleared");
      expect(report.preservedDrafts).toBe(1);
      expect(JSON.stringify(report)).not.toContain(candidate.content);
    }
  });

  it("never deletes identical content stored for another Session", async () => {
    const otherSessionId = SessionIdSchema.parse("session-2");
    const otherDraft = draft("delivered", { sessionId: otherSessionId });
    const drafts = new FailingDraftRepository([otherDraft]);
    const receipts = new InMemoryPromptDeliveryReceiptRepository([receipt("delivered")]);

    await new PromptDeliveryReconciler({ drafts, receipts }).reconcile();
    const restored = await drafts.getBySessionId(otherSessionId);

    expect(restored.ok ? restored.value : undefined).toEqual(otherDraft);
    expect(drafts.deleteCalls).toBe(0);
  });

  it("keeps the matching Draft and pending Receipt when Draft deletion fails", async () => {
    const drafts = new FailingDraftRepository([draft("delivered")]);
    drafts.failDelete = true;
    const receipts = new InMemoryPromptDeliveryReceiptRepository([receipt("delivered")]);

    const report = await new PromptDeliveryReconciler({ drafts, receipts }).reconcile();
    const restoredDraft = await drafts.getBySessionId(sessionId);
    const restoredReceipt = await receipts.getByRequestId("request-1");

    expect(restoredDraft.ok ? restoredDraft.value?.content : undefined).toBe("delivered");
    expect(restoredReceipt.ok ? restoredReceipt.value?.draftCleanup : undefined).toBe("pending");
    expect(report.events).toContainEqual({
      type: "failed",
      code: "draft-delete-failed",
      sessionId,
      requestId: "request-1",
    });
  });

  it("preserves a different Draft if clearing the Receipt fails", async () => {
    const candidate = draft("new content");
    const drafts = new FailingDraftRepository([candidate]);
    const receipts = new FailingReceiptRepository([receipt("delivered")]);
    receipts.failSave = true;

    const report = await new PromptDeliveryReconciler({ drafts, receipts }).reconcile();
    const restored = await drafts.getBySessionId(sessionId);

    expect(restored.ok ? restored.value : undefined).toEqual(candidate);
    expect(drafts.deleteCalls).toBe(0);
    expect(report.events.some((event) => event.type === "failed")).toBe(true);
  });

  it("does not inspect or delete Drafts when the Receipt store is invalid", async () => {
    const drafts = new FailingDraftRepository([draft("delivered")]);
    const receipts = new FailingReceiptRepository();
    receipts.failList = true;

    const report = await new PromptDeliveryReconciler({ drafts, receipts }).reconcile();

    expect(drafts.deleteCalls).toBe(0);
    expect(report.events).toEqual([{ type: "failed", code: "receipt-list-failed" }]);
  });

  it("reports prune failure without failing reconciliation", async () => {
    const receipts = new FailingReceiptRepository([receipt("delivered")]);
    receipts.failPrune = true;

    const report = await new PromptDeliveryReconciler({
      drafts: new InMemoryDraftRepository(),
      receipts,
    }).reconcile();

    expect(report.clearedReceipts).toBe(1);
    expect(report.events).toContainEqual({ type: "failed", code: "receipt-prune-failed" });
  });
});
