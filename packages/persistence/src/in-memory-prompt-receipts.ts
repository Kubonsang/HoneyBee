import {
  PromptDeliveryReceiptSchema,
  err,
  ok,
  type PromptDeliveryReceipt,
  type Result,
  type SessionId,
} from "@honeybee/domain";

import { RepositoryError } from "./errors.js";
import type { PromptDeliveryReceiptRepository, PromptReceiptRetentionPolicy } from "./ports.js";

const cloneReceipt = (receipt: PromptDeliveryReceipt): PromptDeliveryReceipt =>
  PromptDeliveryReceiptSchema.parse(receipt);

const compareReceipts = (left: PromptDeliveryReceipt, right: PromptDeliveryReceipt): number => {
  const deliveredAt = left.deliveredAt.localeCompare(right.deliveredAt);
  return deliveredAt === 0 ? left.requestId.localeCompare(right.requestId) : deliveredAt;
};

const hasSameDeliveryIdentity = (
  left: PromptDeliveryReceipt,
  right: PromptDeliveryReceipt,
): boolean =>
  left.requestId === right.requestId &&
  left.sessionId === right.sessionId &&
  left.contentDigest === right.contentDigest &&
  left.contentLength === right.contentLength &&
  left.deliveredAt === right.deliveredAt &&
  left.schemaVersion === right.schemaVersion;

/** In-process receipt repository used by unit tests and lightweight hosts. */
export class InMemoryPromptDeliveryReceiptRepository implements PromptDeliveryReceiptRepository {
  readonly #receipts = new Map<string, PromptDeliveryReceipt>();

  public constructor(initialReceipts: readonly PromptDeliveryReceipt[] = []) {
    for (const receipt of initialReceipts) {
      const parsed = PromptDeliveryReceiptSchema.parse(receipt);
      this.#receipts.set(parsed.requestId, parsed);
    }
  }

  public async getByRequestId(
    requestId: string,
  ): Promise<Result<PromptDeliveryReceipt | undefined, RepositoryError>> {
    const receipt = this.#receipts.get(requestId);
    return ok(receipt === undefined ? undefined : cloneReceipt(receipt));
  }

  public async listBySessionId(
    sessionId: SessionId,
  ): Promise<Result<readonly PromptDeliveryReceipt[], RepositoryError>> {
    return ok(
      [...this.#receipts.values()]
        .filter((receipt) => receipt.sessionId === sessionId)
        .sort(compareReceipts)
        .map(cloneReceipt),
    );
  }

  public async list(): Promise<Result<readonly PromptDeliveryReceipt[], RepositoryError>> {
    return ok([...this.#receipts.values()].sort(compareReceipts).map(cloneReceipt));
  }

  public async save(
    receipt: PromptDeliveryReceipt,
  ): Promise<Result<PromptDeliveryReceipt, RepositoryError>> {
    const parsed = PromptDeliveryReceiptSchema.safeParse(receipt);
    if (!parsed.success) {
      return err(
        new RepositoryError("validation", "The Prompt receipt does not satisfy its schema.", {
          details: { issues: parsed.error.issues },
        }),
      );
    }

    const existing = this.#receipts.get(parsed.data.requestId);
    if (existing !== undefined && !hasSameDeliveryIdentity(existing, parsed.data)) {
      return err(
        new RepositoryError(
          "conflict",
          `Prompt receipt "${parsed.data.requestId}" has different delivery identity.`,
        ),
      );
    }
    if (existing?.draftCleanup === "cleared" && parsed.data.draftCleanup === "pending") {
      return err(
        new RepositoryError(
          "conflict",
          `Prompt receipt "${parsed.data.requestId}" cannot return to pending cleanup.`,
        ),
      );
    }

    const stored = cloneReceipt(parsed.data);
    this.#receipts.set(stored.requestId, stored);
    return ok(cloneReceipt(stored));
  }

  public async delete(requestId: string): Promise<Result<void, RepositoryError>> {
    this.#receipts.delete(requestId);
    return ok(undefined);
  }

  public async prune(
    policy: PromptReceiptRetentionPolicy,
  ): Promise<Result<number, RepositoryError>> {
    if (!Number.isInteger(policy.maxClearedReceipts) || policy.maxClearedReceipts < 0) {
      return err(
        new RepositoryError("validation", "Receipt retention must be a non-negative integer."),
      );
    }

    const cleared = [...this.#receipts.values()]
      .filter((receipt) => receipt.draftCleanup === "cleared")
      .sort(compareReceipts);
    const removeCount = Math.max(0, cleared.length - policy.maxClearedReceipts);
    for (const receipt of cleared.slice(0, removeCount)) {
      this.#receipts.delete(receipt.requestId);
    }
    return ok(removeCount);
  }

  public flush(): Promise<void> {
    return Promise.resolve();
  }
}
