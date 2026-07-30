import { describe, expect, it } from "vitest";

import {
  err,
  type PromptDeliveryAttempt,
  type PromptDeliveryReceipt,
  type Result,
  type SessionDraft,
  type SessionId,
} from "@honeybee/domain";
import {
  InMemoryDraftRepository,
  InMemoryPromptDeliveryAttemptRepository,
  InMemoryPromptDeliveryReceiptRepository,
  RepositoryError,
} from "@honeybee/persistence";

import { deliverPrompt, type PromptDeliveryDependencies } from "./prompt-delivery.js";
import type {
  RuntimeClientEvent,
  RuntimeClientPort,
  RuntimeConnectionState,
  RuntimeInputOutcome,
  RuntimeStartRequest,
} from "./ports.js";

class RecordingDraftRepository extends InMemoryDraftRepository {
  public failSave = false;
  public failDelete = false;
  public constructor(private readonly trace: string[]) {
    super();
  }
  public override async save(draft: SessionDraft) {
    this.trace.push("draft.save");
    return this.failSave
      ? err(new RepositoryError("unknown", "Injected Draft save failure."))
      : super.save(draft);
  }
  public override async delete(sessionId: SessionId): Promise<Result<void, RepositoryError>> {
    this.trace.push("draft.delete");
    return this.failDelete
      ? err(new RepositoryError("unknown", "Injected Draft delete failure."))
      : super.delete(sessionId);
  }
}

class RecordingAttemptRepository extends InMemoryPromptDeliveryAttemptRepository {
  public readonly failSavePhases = new Set<PromptDeliveryAttempt["phase"]>();
  public readonly failFlushPhases = new Set<PromptDeliveryAttempt["phase"]>();
  public failDelete = false;
  #lastPhase: PromptDeliveryAttempt["phase"] | undefined;
  public constructor(private readonly trace: string[]) {
    super();
  }
  public override async save(attempt: PromptDeliveryAttempt) {
    this.trace.push(`attempt.save.${attempt.phase}`);
    this.#lastPhase = attempt.phase;
    return this.failSavePhases.has(attempt.phase)
      ? err(new RepositoryError("unknown", "Injected Attempt save failure."))
      : super.save(attempt);
  }
  public override async delete(requestId: string): Promise<Result<void, RepositoryError>> {
    this.trace.push("attempt.delete");
    return this.failDelete
      ? err(new RepositoryError("unknown", "Injected Attempt finalize failure."))
      : super.delete(requestId);
  }
  public override flush(): Promise<void> {
    this.trace.push(`attempt.flush.${this.#lastPhase ?? "none"}`);
    return this.#lastPhase !== undefined && this.failFlushPhases.has(this.#lastPhase)
      ? Promise.reject(new Error("Injected Attempt flush failure."))
      : Promise.resolve();
  }
}

class RecordingReceiptRepository extends InMemoryPromptDeliveryReceiptRepository {
  public failSave = false;
  public constructor(private readonly trace: string[]) {
    super();
  }
  public override async save(receipt: PromptDeliveryReceipt) {
    this.trace.push(`receipt.save.${receipt.draftCleanup}`);
    return this.failSave
      ? err(new RepositoryError("unknown", "Injected Receipt save failure."))
      : super.save(receipt);
  }
}

class RecordingRuntime implements RuntimeClientPort {
  public readonly inputs: string[] = [];
  public connectionState: RuntimeConnectionState = "connected";
  public outcome: RuntimeInputOutcome = { status: "accepted" };
  public constructor(private readonly trace: string[]) {}
  public async connect(): Promise<void> {}
  public async start(_request: RuntimeStartRequest): Promise<void> {}
  public async sendInput(_sessionId: SessionId, data: string): Promise<RuntimeInputOutcome> {
    this.trace.push("runtime.sendInput");
    this.inputs.push(data);
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

const setup = () => {
  const trace: string[] = [];
  const drafts = new RecordingDraftRepository(trace);
  const attempts = new RecordingAttemptRepository(trace);
  const receipts = new RecordingReceiptRepository(trace);
  const runtime = new RecordingRuntime(trace);
  const dependencies: PromptDeliveryDependencies = {
    drafts,
    attempts,
    receipts,
    runtime,
    clock: { now: () => "2026-07-30T12:00:00.000Z" },
  };
  return { trace, drafts, attempts, receipts, runtime, dependencies };
};

const draftContent = async (repository: RecordingDraftRepository): Promise<string | undefined> => {
  const result = await repository.getBySessionId("session-1" as SessionId);
  if (!result.ok) throw result.error;
  return result.value?.content;
};
const attemptPhase = async (
  repository: RecordingAttemptRepository,
  requestId = "request-1",
): Promise<PromptDeliveryAttempt["phase"] | undefined> => {
  const result = await repository.getByRequestId(requestId);
  if (!result.ok) throw result.error;
  return result.value?.phase;
};
const receiptCount = async (repository: RecordingReceiptRepository): Promise<number> => {
  const result = await repository.list();
  if (!result.ok) throw result.error;
  return result.value.length;
};

describe("deliverPrompt Attempt journal ordering", () => {
  it("does not call Runtime when exact Draft save fails", async () => {
    const state = setup();
    state.drafts.failSave = true;

    const result = await deliverPrompt(
      state.dependencies,
      "request-1",
      "session-1" as SessionId,
      "secret",
    );

    expect(result).toMatchObject({ status: "rejected", code: "draft-save-failed" });
    expect(state.runtime.inputs).toEqual([]);
  });

  it.each([
    ["prepared save", "prepared", "save"],
    ["prepared flush", "prepared", "flush"],
    ["dispatching save", "dispatching", "save"],
    ["dispatching flush", "dispatching", "flush"],
  ] as const)("does not call Runtime when %s fails", async (_name, phase, operation) => {
    const state = setup();
    if (operation === "save") state.attempts.failSavePhases.add(phase);
    else state.attempts.failFlushPhases.add(phase);

    const result = await deliverPrompt(
      state.dependencies,
      "request-1",
      "session-1" as SessionId,
      "keep me",
    );

    expect(result.status).toBe("rejected");
    expect(state.runtime.inputs).toEqual([]);
    expect(await draftContent(state.drafts)).toBe("keep me");
  });

  it("records explicit rejection without a Receipt and allows normal retry", async () => {
    const state = setup();
    state.runtime.outcome = { status: "rejected", message: "PTY stopped." };

    const result = await deliverPrompt(
      state.dependencies,
      "request-1",
      "session-1" as SessionId,
      "retry",
    );

    expect(result).toEqual({
      status: "rejected",
      code: "runtime-input-rejected",
      message: "PTY stopped.",
    });
    expect(state.runtime.inputs).toHaveLength(1);
    expect(await receiptCount(state.receipts)).toBe(0);
    expect(await draftContent(state.drafts)).toBe("retry");
    expect(await attemptPhase(state.attempts)).toBeUndefined();

    state.runtime.outcome = { status: "accepted" };
    const retry = await deliverPrompt(
      state.dependencies,
      "request-2",
      "session-1" as SessionId,
      "retry",
    );
    expect(retry.status).toBe("accepted");
    expect(state.runtime.inputs).toHaveLength(2);
  });

  it("records unknown, preserves Draft, and creates no Receipt", async () => {
    const state = setup();
    state.runtime.outcome = { status: "unknown", reason: "Response timed out." };

    const result = await deliverPrompt(
      state.dependencies,
      "request-1",
      "session-1" as SessionId,
      "do not resend",
    );

    expect(result).toEqual({
      status: "unknown",
      code: "runtime-input-outcome-unknown",
      message: "Response timed out.",
      warnings: [],
    });
    expect(state.runtime.inputs).toHaveLength(1);
    expect(await receiptCount(state.receipts)).toBe(0);
    expect(await draftContent(state.drafts)).toBe("do not resend");
    expect(await attemptPhase(state.attempts)).toBe("unknown");
  });

  it("keeps durable dispatching evidence when the unknown transition cannot be saved", async () => {
    const state = setup();
    state.runtime.outcome = { status: "unknown", reason: "Response timed out." };
    state.attempts.failSavePhases.add("unknown");

    const result = await deliverPrompt(
      state.dependencies,
      "request-1",
      "session-1" as SessionId,
      "preserve and lock",
    );

    expect(result).toMatchObject({
      status: "unknown",
      warnings: ["attempt-unknown-save-failed"],
    });
    expect(await attemptPhase(state.attempts)).toBe("dispatching");
    expect(await draftContent(state.drafts)).toBe("preserve and lock");
    expect(state.runtime.inputs).toHaveLength(1);
  });
  it("orders accepted Attempt, Receipt, cleanup, and finalization", async () => {
    const state = setup();

    const result = await deliverPrompt(
      state.dependencies,
      "request-1",
      "session-1" as SessionId,
      "once",
    );

    expect(result).toEqual({
      status: "accepted",
      attemptPersistence: "stored",
      receiptPersistence: "stored",
      draftCleanup: "cleared",
      warnings: [],
    });
    expect(state.trace).toEqual([
      "draft.save",
      "attempt.save.prepared",
      "attempt.flush.prepared",
      "attempt.save.dispatching",
      "attempt.flush.dispatching",
      "runtime.sendInput",
      "attempt.save.runtime-accepted",
      "receipt.save.pending",
      "draft.delete",
      "receipt.save.cleared",
      "attempt.delete",
    ]);
    expect(await attemptPhase(state.attempts)).toBeUndefined();
  });

  it("uses a durable Receipt as authoritative when runtime-accepted save fails", async () => {
    const state = setup();
    state.attempts.failSavePhases.add("runtime-accepted");

    const result = await deliverPrompt(
      state.dependencies,
      "request-1",
      "session-1" as SessionId,
      "once",
    );

    expect(result).toMatchObject({ status: "accepted", receiptPersistence: "stored" });
    expect(result.status === "accepted" ? result.warnings : []).toContain(
      "attempt-runtime-accepted-save-failed",
    );
    expect(await receiptCount(state.receipts)).toBe(1);
    expect(await attemptPhase(state.attempts)).toBeUndefined();
  });

  it("keeps runtime-accepted Attempt when Receipt persistence fails", async () => {
    const state = setup();
    state.receipts.failSave = true;

    const result = await deliverPrompt(
      state.dependencies,
      "request-1",
      "session-1" as SessionId,
      "once",
    );

    expect(result).toMatchObject({ status: "accepted", receiptPersistence: "warning" });
    expect(await attemptPhase(state.attempts)).toBe("runtime-accepted");
    expect(state.runtime.inputs).toHaveLength(1);
  });

  it("leaves durable dispatching evidence when accepted Attempt and Receipt both fail", async () => {
    const state = setup();
    state.attempts.failSavePhases.add("runtime-accepted");
    state.receipts.failSave = true;

    const result = await deliverPrompt(
      state.dependencies,
      "request-1",
      "session-1" as SessionId,
      "once",
    );

    expect(result).toMatchObject({
      status: "accepted",
      attemptPersistence: "warning",
      receiptPersistence: "warning",
    });
    expect(await attemptPhase(state.attempts)).toBe("dispatching");
    expect(state.runtime.inputs).toHaveLength(1);
  });
});
