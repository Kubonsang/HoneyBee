import {
  PromptDeliveryAttemptSchema,
  err,
  SessionDraftSchema,
  transitionPromptDeliveryAttempt,
  type PromptDeliveryAttempt,
  type SessionId,
} from "@honeybee/domain";
import {
  InMemoryDraftRepository,
  InMemoryPromptDeliveryAttemptRepository,
  InMemoryPromptDeliveryReceiptRepository,
  RepositoryError,
} from "@honeybee/persistence";
import { describe, expect, it, vi } from "vitest";

import { fingerprintPromptContent } from "./prompt-content-fingerprint.js";
import type {
  RuntimeClientEvent,
  RuntimeClientPort,
  RuntimeConnectionState,
  RuntimeInputOutcome,
  RuntimeStartRequest,
} from "./ports.js";
import { PromptRecoveryService } from "./prompt-recovery-service.js";

const sessionId = "session-1" as SessionId;
const content = "unknown Prompt";
const unknownAttempt = (): PromptDeliveryAttempt => {
  const prepared = PromptDeliveryAttemptSchema.parse({
    requestId: "original-request",
    sessionId,
    ...fingerprintPromptContent(content),
    phase: "prepared",
    preparedAt: "2026-07-30T10:00:00.000Z",
    updatedAt: "2026-07-30T10:00:00.000Z",
    schemaVersion: 1,
  });
  const dispatching = transitionPromptDeliveryAttempt(prepared, {
    phase: "dispatching",
    updatedAt: "2026-07-30T10:01:00.000Z",
  });
  if (!dispatching.ok) throw dispatching.error;
  const unknown = transitionPromptDeliveryAttempt(dispatching.value, {
    phase: "unknown",
    updatedAt: "2026-07-30T10:02:00.000Z",
  });
  if (!unknown.ok) throw unknown.error;
  return unknown.value;
};

class RecoveryRuntime implements RuntimeClientPort {
  public readonly inputs: string[] = [];
  public connectionState: RuntimeConnectionState = "connected";
  public outcome: RuntimeInputOutcome = { status: "accepted" };
  public inputGate: Promise<void> | undefined;
  public async connect(): Promise<void> {}
  public async start(_request: RuntimeStartRequest): Promise<void> {}
  public async sendInput(_sessionId: SessionId, data: string): Promise<RuntimeInputOutcome> {
    this.inputs.push(data);
    await this.inputGate;
    return this.outcome;
  }
  public async resize(_sessionId: SessionId, _columns: number, _rows: number): Promise<void> {}
  public async interrupt(_sessionId: SessionId): Promise<void> {}
  public async stop(_sessionId: SessionId): Promise<void> {}
  public onEvent(_listener: (event: RuntimeClientEvent) => void): { dispose(): void } {
    return { dispose: () => undefined };
  }
  public async dispose(): Promise<void> {}
}

const setup = (
  draftContent = content,
  draftUpdatedAt = "2026-07-30T10:00:00.000Z",
  replacementRequestId = "replacement-request",
) => {
  const attempt = unknownAttempt();
  const attempts = new InMemoryPromptDeliveryAttemptRepository([attempt]);
  const drafts = new InMemoryDraftRepository([
    SessionDraftSchema.parse({ sessionId, content: draftContent, updatedAt: draftUpdatedAt }),
  ]);
  const receipts = new InMemoryPromptDeliveryReceiptRepository();
  const runtime = new RecoveryRuntime();
  const service = new PromptRecoveryService({
    attempts,
    drafts,
    receipts,
    runtime,
    clock: { now: () => "2026-07-30T11:00:00.000Z" },
    ids: { requestId: () => replacementRequestId },
    initialIssues: [
      {
        requestId: attempt.requestId,
        sessionId,
        outcome: "unknown",
        draftMatch: draftContent === content ? "exact" : "different",
        occurredAt: attempt.updatedAt,
      },
    ],
  });
  return { attempt, attempts, drafts, receipts, runtime, service };
};

const currentAttempt = async (repository: InMemoryPromptDeliveryAttemptRepository) => {
  const result = await repository.getByRequestId("original-request");
  if (!result.ok) throw result.error;
  return result.value;
};

describe("PromptRecoveryService", () => {
  it("Assume delivered clears only exact stale Draft and synthesizes no Receipt", async () => {
    const state = setup();

    const result = await state.service.assumeDelivered("original-request", sessionId);

    expect(result).toEqual({ status: "resolved", draftCleared: true });
    expect((await currentAttempt(state.attempts))?.phase).toBe("resolved-assumed-delivered");
    expect((await state.drafts.getBySessionId(sessionId)).ok).toBe(true);
    const clearedDraft = await state.drafts.getBySessionId(sessionId);
    expect(clearedDraft.ok ? clearedDraft.value : undefined).toBeUndefined();
    const receiptList = await state.receipts.list();
    expect(receiptList.ok ? receiptList.value : []).toEqual([]);
    expect(state.runtime.inputs).toEqual([]);
    expect(state.service.issueFor(sessionId)).toBeUndefined();
  });

  it("keeps the unknown issue and Draft when Assume delivered cleanup fails", async () => {
    const state = setup();
    state.drafts.delete = async () =>
      err(new RepositoryError("unknown", "Injected Draft delete failure."));

    expect(await state.service.assumeDelivered("original-request", sessionId)).toEqual({
      status: "failed",
      code: "attempt-recovery-action-failed",
    });
    expect(state.service.issueFor(sessionId)?.requestId).toBe("original-request");
    expect((await currentAttempt(state.attempts))?.phase).toBe("unknown");
    const preserved = await state.drafts.getBySessionId(sessionId);
    expect(preserved.ok ? preserved.value?.content : undefined).toBe(content);
  });
  it("Assume delivered preserves a newer or different Draft", async () => {
    const state = setup("new Draft", "2026-07-30T10:03:00.000Z");

    const result = await state.service.assumeDelivered("original-request", sessionId);

    expect(result).toEqual({ status: "resolved", draftCleared: false });
    const preservedDraft = await state.drafts.getBySessionId(sessionId);
    expect(preservedDraft.ok ? preservedDraft.value?.content : undefined).toBe("new Draft");
  });

  it("ignores duplicate, stale, and cross-Session actions idempotently", async () => {
    const state = setup();
    expect(await state.service.assumeDelivered("stale", sessionId)).toEqual({ status: "ignored" });
    expect(
      await state.service.assumeDelivered("original-request", "other-session" as SessionId),
    ).toEqual({ status: "ignored" });
    await state.service.assumeDelivered("original-request", sessionId);
    expect(await state.service.assumeDelivered("original-request", sessionId)).toEqual({
      status: "ignored",
    });
  });

  it("Retry requires exact Draft, uses a fresh ID and the normal delivery pipeline", async () => {
    const state = setup();

    const result = await state.service.retry("original-request", sessionId);

    expect(result).toMatchObject({
      status: "retry-finished",
      replacementRequestId: "replacement-request",
      delivery: { status: "accepted" },
    });
    expect(state.runtime.inputs).toEqual([`${content}\r`]);
    const original = await currentAttempt(state.attempts);
    expect(original).toMatchObject({
      phase: "resolved-retried",
      replacementRequestId: "replacement-request",
    });
    const replacementReceipt = await state.receipts.getByRequestId("replacement-request");
    expect(replacementReceipt.ok ? replacementReceipt.value : undefined).toBeDefined();
  });

  it("does not retry a different Draft", async () => {
    const state = setup("new Draft", "2026-07-30T10:03:00.000Z");

    expect(await state.service.retry("original-request", sessionId)).toEqual({
      status: "failed",
      code: "attempt-recovery-action-failed",
    });
    expect(state.runtime.inputs).toEqual([]);
    expect((await currentAttempt(state.attempts))?.phase).toBe("unknown");
  });

  it("keeps an in-memory Session lock when unknown persistence cannot be read", async () => {
    const drafts = new InMemoryDraftRepository([
      SessionDraftSchema.parse({
        sessionId,
        content,
        updatedAt: "2026-07-30T10:00:00.000Z",
      }),
    ]);
    const service = new PromptRecoveryService({
      attempts: new InMemoryPromptDeliveryAttemptRepository(),
      drafts,
      receipts: new InMemoryPromptDeliveryReceiptRepository(),
      runtime: new RecoveryRuntime(),
      clock: { now: () => "2026-07-30T11:00:00.000Z" },
      ids: { requestId: () => "replacement-request" },
    });

    await service.registerUnknown("missing-attempt", sessionId);

    expect(service.issueFor(sessionId)).toEqual({
      requestId: "missing-attempt",
      sessionId,
      outcome: "unknown",
      draftMatch: "different",
      occurredAt: "2026-07-30T11:00:00.000Z",
    });
  });
  it("serializes duplicate Retry actions so Runtime is invoked once", async () => {
    const state = setup();
    let releaseInput: (() => void) | undefined;
    state.runtime.inputGate = new Promise<void>((resolve) => {
      releaseInput = resolve;
    });

    const first = state.service.retry("original-request", sessionId);
    const duplicate = state.service.retry("original-request", sessionId);
    await vi.waitFor(() => expect(state.runtime.inputs).toHaveLength(1));
    releaseInput?.();

    const [firstResult, duplicateResult] = await Promise.all([first, duplicate]);
    expect(duplicateResult).toEqual(firstResult);
    expect(state.runtime.inputs).toHaveLength(1);
  });

  it("rejects a replacement request ID that reuses the original identity", async () => {
    const state = setup(content, "2026-07-30T10:00:00.000Z", "original-request");

    expect(await state.service.retry("original-request", sessionId)).toEqual({
      status: "failed",
      code: "attempt-recovery-action-failed",
    });
    expect(state.runtime.inputs).toEqual([]);
  });

  it("keeps a replacement unknown queued after the original issue is resolved", async () => {
    const state = setup();
    state.runtime.outcome = { status: "unknown", reason: "Response lost." };

    await state.service.retry("original-request", sessionId);
    expect(state.service.issueFor(sessionId)?.requestId).toBe("original-request");
    await state.service.assumeDelivered("original-request", sessionId);

    expect(state.service.issueFor(sessionId)?.requestId).toBe("replacement-request");
    const replacement = await state.attempts.getByRequestId("replacement-request");
    expect(replacement.ok ? replacement.value?.phase : undefined).toBe("unknown");
  });
  it("keeps original unknown when replacement is rejected or unknown", async () => {
    for (const outcome of [
      { status: "rejected", message: "PTY stopped." },
      { status: "unknown", reason: "Response lost." },
    ] satisfies RuntimeInputOutcome[]) {
      const state = setup();
      state.runtime.outcome = outcome;

      const result = await state.service.retry("original-request", sessionId);

      expect(result).toMatchObject({
        status: "retry-finished",
        delivery: { status: outcome.status },
      });
      expect((await currentAttempt(state.attempts))?.phase).toBe("unknown");
      expect(state.service.issueFor(sessionId)).toBeDefined();
    }
  });
});
