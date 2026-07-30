import {
  PromptDeliveryReceiptSchema,
  SessionIdSchema,
  type PromptDeliveryReceipt,
} from "@honeybee/domain";
import { describe, expect, it } from "vitest";

import { InMemoryPromptDeliveryReceiptRepository } from "./in-memory-prompt-receipts.js";

const makeReceipt = (
  requestId: string,
  overrides: Partial<PromptDeliveryReceipt> = {},
): PromptDeliveryReceipt =>
  PromptDeliveryReceiptSchema.parse({
    requestId,
    sessionId: "session-1",
    contentDigest: `sha256:${requestId.padEnd(64, "0")}`,
    contentLength: requestId.length,
    deliveredAt: "2026-07-30T12:00:00.000Z",
    draftCleanup: "pending",
    schemaVersion: 1,
    ...overrides,
  });

describe("InMemoryPromptDeliveryReceiptRepository", () => {
  it("saves, gets, lists by Session, updates, and deletes receipts", async () => {
    const repository = new InMemoryPromptDeliveryReceiptRepository();
    const pending = makeReceipt("a");

    await repository.save(pending);
    await repository.save({ ...pending, draftCleanup: "cleared" });

    const found = await repository.getByRequestId("a");
    const listed = await repository.listBySessionId(SessionIdSchema.parse("session-1"));
    await repository.delete("a");
    const deleted = await repository.getByRequestId("a");

    expect(found.ok ? found.value?.draftCleanup : undefined).toBe("cleared");
    expect(listed.ok ? listed.value : []).toHaveLength(1);
    expect(deleted.ok ? deleted.value : pending).toBeUndefined();
  });

  it("rejects invalid data passed through the typed boundary", async () => {
    const repository = new InMemoryPromptDeliveryReceiptRepository();
    const invalid = { ...makeReceipt("a"), contentDigest: "invalid" };

    const result = await repository.save(invalid as PromptDeliveryReceipt);

    expect(result.ok ? undefined : result.error.code).toBe("validation");
  });

  it("uses deterministic idempotent update and conflict rules", async () => {
    const repository = new InMemoryPromptDeliveryReceiptRepository();
    const pending = makeReceipt("a");

    await repository.save(pending);
    const duplicate = await repository.save(pending);
    const identityConflict = await repository.save({
      ...pending,
      contentLength: pending.contentLength + 1,
    });
    await repository.save({ ...pending, draftCleanup: "cleared" });
    const regression = await repository.save(pending);

    expect(duplicate.ok).toBe(true);
    expect(identityConflict.ok ? undefined : identityConflict.error.code).toBe("conflict");
    expect(regression.ok ? undefined : regression.error.code).toBe("conflict");
  });

  it("prunes oldest cleared receipts while retaining pending receipts", async () => {
    const repository = new InMemoryPromptDeliveryReceiptRepository([
      makeReceipt("a", {
        deliveredAt: "2026-07-30T10:00:00.000Z",
        draftCleanup: "cleared",
      }),
      makeReceipt("b", {
        deliveredAt: "2026-07-30T11:00:00.000Z",
        draftCleanup: "cleared",
      }),
      makeReceipt("c", {
        deliveredAt: "2026-07-30T09:00:00.000Z",
        draftCleanup: "pending",
      }),
    ]);

    const result = await repository.prune({ maxClearedReceipts: 1 });
    const listed = await repository.list();

    expect(result.ok ? result.value : undefined).toBe(1);
    expect(listed.ok ? listed.value.map(({ requestId }) => requestId) : []).toEqual(["c", "b"]);
  });

  it("rejects an invalid retention policy", async () => {
    const repository = new InMemoryPromptDeliveryReceiptRepository();

    const result = await repository.prune({ maxClearedReceipts: -1 });

    expect(result.ok ? undefined : result.error.code).toBe("validation");
  });
});
