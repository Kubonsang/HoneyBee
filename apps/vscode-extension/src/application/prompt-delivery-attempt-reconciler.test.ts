import {
  PromptDeliveryAttemptSchema,
  err,
  PromptDeliveryReceiptSchema,
  SessionDraftSchema,
  transitionPromptDeliveryAttempt,
  type PromptDeliveryAttempt,
  type PromptDeliveryReceipt,
  type SessionId,
} from "@honeybee/domain";
import {
  InMemoryDraftRepository,
  InMemoryPromptDeliveryAttemptRepository,
  InMemoryPromptDeliveryReceiptRepository,
  RepositoryError,
} from "@honeybee/persistence";
import { describe, expect, it } from "vitest";

import { fingerprintPromptContent } from "./prompt-content-fingerprint.js";
import { PromptDeliveryAttemptReconciler } from "./prompt-delivery-attempt-reconciler.js";
import { PromptDeliveryReconciler } from "./prompt-delivery-reconciler.js";

const sessionId = "session-1" as SessionId;
const content = "exact\r\nUnicode 벌";
const prepared = (
  requestId = "request-1",
  overrides: Partial<PromptDeliveryAttempt> = {},
): PromptDeliveryAttempt =>
  PromptDeliveryAttemptSchema.parse({
    requestId,
    sessionId,
    ...fingerprintPromptContent(content),
    phase: "prepared",
    preparedAt: "2026-07-30T10:00:00.000Z",
    updatedAt: "2026-07-30T10:00:00.000Z",
    schemaVersion: 1,
    ...overrides,
  });
const move = (
  attempt: PromptDeliveryAttempt,
  change: Parameters<typeof transitionPromptDeliveryAttempt>[1],
): PromptDeliveryAttempt => {
  const result = transitionPromptDeliveryAttempt(attempt, change);
  if (!result.ok) throw result.error;
  return result.value;
};
const draft = (value = content, updatedAt = "2026-07-30T10:00:00.000Z") =>
  SessionDraftSchema.parse({ sessionId, content: value, updatedAt });
const receipt = (
  attempt: PromptDeliveryAttempt,
  overrides: Partial<PromptDeliveryReceipt> = {},
): PromptDeliveryReceipt =>
  PromptDeliveryReceiptSchema.parse({
    requestId: attempt.requestId,
    sessionId: attempt.sessionId,
    contentDigest: attempt.contentDigest,
    contentLength: attempt.contentLength,
    deliveredAt: attempt.acceptedAt ?? "2026-07-30T10:01:00.000Z",
    draftCleanup: "pending",
    schemaVersion: 1,
    ...overrides,
  });

const phase = async (
  repository: InMemoryPromptDeliveryAttemptRepository,
  requestId = "request-1",
) => {
  const result = await repository.getByRequestId(requestId);
  if (!result.ok) throw result.error;
  return result.value?.phase;
};

describe("PromptDeliveryAttemptReconciler", () => {
  it("cancels prepared as provably not dispatched and preserves Draft", async () => {
    const attempts = new InMemoryPromptDeliveryAttemptRepository([prepared()]);
    const drafts = new InMemoryDraftRepository([draft()]);
    const report = await new PromptDeliveryAttemptReconciler({
      attempts,
      drafts,
      receipts: new InMemoryPromptDeliveryReceiptRepository(),
    }).reconcile();

    expect(await phase(attempts)).toBe("cancelled-before-dispatch");
    expect((await drafts.getBySessionId(sessionId)).ok).toBe(true);
    expect(report.issues).toEqual([]);
  });

  it("turns dispatching without evidence into unknown and locks only its Session", async () => {
    const dispatching = move(prepared(), {
      phase: "dispatching",
      updatedAt: "2026-07-30T10:01:00.000Z",
    });
    const attempts = new InMemoryPromptDeliveryAttemptRepository([dispatching]);
    const report = await new PromptDeliveryAttemptReconciler({
      attempts,
      drafts: new InMemoryDraftRepository([draft()]),
      receipts: new InMemoryPromptDeliveryReceiptRepository(),
    }).reconcile();

    expect(await phase(attempts)).toBe("unknown");
    expect(report.issues).toEqual([
      {
        requestId: "request-1",
        sessionId,
        outcome: "unknown",
        draftMatch: "exact",
        occurredAt: "2026-07-30T10:01:00.000Z",
      },
    ]);
  });

  it("reconstructs a missing Receipt from runtime-accepted time and finalizes Attempt", async () => {
    const dispatching = move(prepared(), {
      phase: "dispatching",
      updatedAt: "2026-07-30T10:01:00.000Z",
    });
    const accepted = move(dispatching, {
      phase: "runtime-accepted",
      updatedAt: "2026-07-30T10:02:00.000Z",
      acceptedAt: "2026-07-30T10:02:00.000Z",
    });
    const attempts = new InMemoryPromptDeliveryAttemptRepository([accepted]);
    const receipts = new InMemoryPromptDeliveryReceiptRepository();

    await new PromptDeliveryAttemptReconciler({
      attempts,
      drafts: new InMemoryDraftRepository([draft()]),
      receipts,
    }).reconcile();
    const restored = await receipts.getByRequestId("request-1");

    expect(restored.ok ? restored.value?.deliveredAt : undefined).toBe("2026-07-30T10:02:00.000Z");
    expect(restored.ok ? restored.value?.draftCleanup : undefined).toBe("pending");
    expect(await phase(attempts)).toBeUndefined();
  });

  it("preserves runtime-accepted Attempt and Draft when Receipt reconstruction fails", async () => {
    const dispatching = move(prepared(), {
      phase: "dispatching",
      updatedAt: "2026-07-30T10:01:00.000Z",
    });
    const accepted = move(dispatching, {
      phase: "runtime-accepted",
      updatedAt: "2026-07-30T10:02:00.000Z",
      acceptedAt: "2026-07-30T10:02:00.000Z",
    });
    const attempts = new InMemoryPromptDeliveryAttemptRepository([accepted]);
    const receipts = new InMemoryPromptDeliveryReceiptRepository();
    receipts.save = async () =>
      err(new RepositoryError("unknown", "Injected Receipt reconstruction failure."));
    const drafts = new InMemoryDraftRepository([draft()]);

    const report = await new PromptDeliveryAttemptReconciler({
      attempts,
      receipts,
      drafts,
    }).reconcile();

    expect(await phase(attempts)).toBe("runtime-accepted");
    const preserved = await drafts.getBySessionId(sessionId);
    expect(preserved.ok ? preserved.value?.content : undefined).toBe(content);
    expect(report.events).toContainEqual(
      expect.objectContaining({ type: "failed", code: "receipt-reconstruct-failed" }),
    );
  });
  it("uses exact matching Receipt as authoritative evidence", async () => {
    const dispatching = move(prepared(), {
      phase: "dispatching",
      updatedAt: "2026-07-30T10:01:00.000Z",
    });
    const attempts = new InMemoryPromptDeliveryAttemptRepository([dispatching]);
    const report = await new PromptDeliveryAttemptReconciler({
      attempts,
      drafts: new InMemoryDraftRepository([draft()]),
      receipts: new InMemoryPromptDeliveryReceiptRepository([receipt(dispatching)]),
    }).reconcile();

    expect(await phase(attempts)).toBeUndefined();
    expect(report.issues).toEqual([]);
  });

  it("does not mutate conflicting Receipt, Attempt, or Draft", async () => {
    const dispatching = move(prepared(), {
      phase: "dispatching",
      updatedAt: "2026-07-30T10:01:00.000Z",
    });
    const attempts = new InMemoryPromptDeliveryAttemptRepository([dispatching]);
    const drafts = new InMemoryDraftRepository([draft()]);
    const report = await new PromptDeliveryAttemptReconciler({
      attempts,
      drafts,
      receipts: new InMemoryPromptDeliveryReceiptRepository([
        receipt(dispatching, { contentDigest: `sha256:${"f".repeat(64)}` }),
      ]),
    }).reconcile();

    expect(await phase(attempts)).toBe("dispatching");
    expect((await drafts.getBySessionId(sessionId)).ok).toBe(true);
    expect(report.events).toContainEqual(
      expect.objectContaining({ type: "conflict", code: "attempt-reconciliation-conflict" }),
    );
  });

  it("lets existing Receipt reconciliation remove only exact stale Draft", async () => {
    const dispatching = move(prepared(), {
      phase: "dispatching",
      updatedAt: "2026-07-30T10:01:00.000Z",
    });
    const accepted = move(dispatching, {
      phase: "runtime-accepted",
      updatedAt: "2026-07-30T10:02:00.000Z",
      acceptedAt: "2026-07-30T10:02:00.000Z",
    });
    const attempts = new InMemoryPromptDeliveryAttemptRepository([accepted]);
    const receipts = new InMemoryPromptDeliveryReceiptRepository();
    const drafts = new InMemoryDraftRepository([draft()]);

    await new PromptDeliveryAttemptReconciler({ attempts, receipts, drafts }).reconcile();
    await new PromptDeliveryReconciler({ receipts, drafts }).reconcile();

    expect((await drafts.getBySessionId(sessionId)).ok).toBe(true);
    const restored = await drafts.getBySessionId(sessionId);
    expect(restored.ok ? restored.value : undefined).toBeUndefined();
  });

  it("preserves a newer different Draft after Receipt reconstruction", async () => {
    const dispatching = move(prepared(), {
      phase: "dispatching",
      updatedAt: "2026-07-30T10:01:00.000Z",
    });
    const accepted = move(dispatching, {
      phase: "runtime-accepted",
      updatedAt: "2026-07-30T10:02:00.000Z",
      acceptedAt: "2026-07-30T10:02:00.000Z",
    });
    const attempts = new InMemoryPromptDeliveryAttemptRepository([accepted]);
    const receipts = new InMemoryPromptDeliveryReceiptRepository();
    const drafts = new InMemoryDraftRepository([
      draft("new unsent Draft", "2026-07-30T10:03:00.000Z"),
    ]);

    await new PromptDeliveryAttemptReconciler({ attempts, receipts, drafts }).reconcile();
    await new PromptDeliveryReconciler({ receipts, drafts }).reconcile();
    const restored = await drafts.getBySessionId(sessionId);

    expect(restored.ok ? restored.value?.content : undefined).toBe("new unsent Draft");
  });
  it("reports Attempt prune failure without aborting reconciliation", async () => {
    const attempts = new InMemoryPromptDeliveryAttemptRepository([prepared()]);
    attempts.prune = async () =>
      err(new RepositoryError("unknown", "Injected Attempt prune failure."));

    const report = await new PromptDeliveryAttemptReconciler({
      attempts,
      drafts: new InMemoryDraftRepository([draft()]),
      receipts: new InMemoryPromptDeliveryReceiptRepository(),
    }).reconcile();

    expect(await phase(attempts)).toBe("cancelled-before-dispatch");
    expect(report.events).toContainEqual({ type: "failed", code: "attempt-prune-failed" });
  });
});
