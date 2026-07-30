import { PromptDeliveryReceiptSchema, type PromptDeliveryReceipt } from "@honeybee/domain";
import { describe, expect, it } from "vitest";

import {
  GlobalStatePromptDeliveryReceiptRepository,
  PROMPT_DELIVERY_RECEIPT_STORAGE_KEY,
} from "./global-state-prompt-receipt-repository.js";
import type { MementoPort } from "./global-state-repositories.js";

class MemoryMemento implements MementoPort {
  readonly #values = new Map<string, unknown>();

  public get<T>(key: string, defaultValue: T): T {
    return (this.#values.has(key) ? structuredClone(this.#values.get(key)) : defaultValue) as T;
  }

  public update(key: string, value: unknown): Thenable<void> {
    this.#values.set(key, structuredClone(value));
    return Promise.resolve();
  }
}

class SlowMemento extends MemoryMemento {
  public override async update(key: string, value: unknown): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    await super.update(key, value);
  }
}
class GatedMemento extends MemoryMemento {
  #release: (() => void) | undefined;

  public override update(key: string, value: unknown): Thenable<void> {
    return new Promise<void>((resolve) => {
      this.#release = () => {
        void Promise.resolve(super.update(key, value)).then(resolve);
      };
    });
  }

  public release(): void {
    if (this.#release === undefined) {
      throw new Error("No Receipt write is waiting.");
    }
    this.#release();
  }
}

const receipt = (
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

describe("GlobalStatePromptDeliveryReceiptRepository", () => {
  it("round-trips and updates a Receipt across repository instances", async () => {
    const state = new MemoryMemento();
    const first = new GlobalStatePromptDeliveryReceiptRepository(state);
    const pending = receipt("a");

    await first.save(pending);
    await first.save({ ...pending, draftCleanup: "cleared" });
    const identityConflict = await first.save({
      ...pending,
      contentLength: pending.contentLength + 1,
    });
    const afterRestart = new GlobalStatePromptDeliveryReceiptRepository(state);
    const restored = await afterRestart.getByRequestId("a");

    expect(restored.ok ? restored.value?.draftCleanup : undefined).toBe("cleared");
    expect(identityConflict.ok ? undefined : identityConflict.error.code).toBe("conflict");
  });

  it("rejects invalid stored data without overwriting it", async () => {
    const state = new MemoryMemento();
    await state.update(PROMPT_DELIVERY_RECEIPT_STORAGE_KEY, [
      { ...receipt("a"), contentDigest: "invalid" },
    ]);
    const repository = new GlobalStatePromptDeliveryReceiptRepository(state);

    const listed = await repository.list();
    const saved = await repository.save(receipt("b"));

    expect(listed.ok ? undefined : listed.error.code).toBe("validation");
    expect(saved.ok ? undefined : saved.error.code).toBe("validation");
  });

  it("serializes parallel saves so neither Receipt is lost", async () => {
    const state = new SlowMemento();
    const repository = new GlobalStatePromptDeliveryReceiptRepository(state);

    await Promise.all([repository.save(receipt("a")), repository.save(receipt("b"))]);
    const listed = await repository.list();

    expect(listed.ok ? listed.value.map(({ requestId }) => requestId) : []).toEqual(["a", "b"]);
  });

  it("prunes old cleared Receipts but never pending Receipts", async () => {
    const state = new MemoryMemento();
    const repository = new GlobalStatePromptDeliveryReceiptRepository(state);
    await repository.save(
      receipt("a", {
        deliveredAt: "2026-07-30T10:00:00.000Z",
        draftCleanup: "cleared",
      }),
    );
    await repository.save(
      receipt("b", {
        deliveredAt: "2026-07-30T11:00:00.000Z",
        draftCleanup: "cleared",
      }),
    );
    await repository.save(
      receipt("c", {
        deliveredAt: "2026-07-30T09:00:00.000Z",
        draftCleanup: "pending",
      }),
    );

    const pruned = await repository.prune({ maxClearedReceipts: 1 });
    const listed = await repository.list();

    expect(pruned.ok ? pruned.value : undefined).toBe(1);
    expect(listed.ok ? listed.value.map(({ requestId }) => requestId) : []).toEqual(["c", "b"]);
  });

  it("converts Memento write failures to typed repository errors", async () => {
    const state: MementoPort = {
      get: <T>(_key: string, defaultValue: T): T => defaultValue,
      update: (): Promise<void> => Promise.reject(new Error("storage unavailable")),
    };
    const repository = new GlobalStatePromptDeliveryReceiptRepository(state);

    const result = await repository.save(receipt("a"));

    expect(result.ok ? undefined : result.error.code).toBe("unknown");
  });

  it("waits for the serialized write tail when flushed", async () => {
    const state = new GatedMemento();
    const repository = new GlobalStatePromptDeliveryReceiptRepository(state);

    const saving = repository.save(receipt("a"));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    let flushed = false;
    const flushing = repository.flush().then(() => {
      flushed = true;
    });
    await Promise.resolve();
    expect(flushed).toBe(false);

    state.release();
    await Promise.all([saving, flushing]);
    expect(flushed).toBe(true);
  });
});
