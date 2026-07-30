import {
  PromptDeliveryReceiptSchema,
  err,
  ok,
  type PromptDeliveryReceipt,
  type Result,
  type SessionId,
} from "@honeybee/domain";
import {
  RepositoryError,
  type PromptDeliveryReceiptRepository,
  type PromptReceiptRetentionPolicy,
} from "@honeybee/persistence";

import type { MementoPort } from "./global-state-repositories.js";

export const PROMPT_DELIVERY_RECEIPT_STORAGE_KEY = "honeyBee.promptDeliveryReceipts.v1";

const readReceipts = (
  memento: MementoPort,
): Result<readonly PromptDeliveryReceipt[], RepositoryError> => {
  const stored = memento.get<unknown>(PROMPT_DELIVERY_RECEIPT_STORAGE_KEY, []);
  const parsed = PromptDeliveryReceiptSchema.array().safeParse(stored);
  return parsed.success
    ? ok(parsed.data)
    : err(
        new RepositoryError("validation", "Stored Prompt delivery receipts are invalid.", {
          details: { issues: parsed.error.issues },
        }),
      );
};

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

const storageError = (operation: string, cause: unknown): RepositoryError =>
  new RepositoryError("unknown", `Prompt receipt ${operation} failed.`, { cause });

/** VS Code globalState receipt storage with instance-serialized mutations. */
export class GlobalStatePromptDeliveryReceiptRepository implements PromptDeliveryReceiptRepository {
  #writeTail: Promise<void> = Promise.resolve();

  public constructor(private readonly memento: MementoPort) {}

  public async getByRequestId(
    requestId: string,
  ): Promise<Result<PromptDeliveryReceipt | undefined, RepositoryError>> {
    await this.#writeTail;
    const receipts = readReceipts(this.memento);
    if (!receipts.ok) {
      return receipts;
    }
    const receipt = receipts.value.find((candidate) => candidate.requestId === requestId);
    return ok(receipt === undefined ? undefined : PromptDeliveryReceiptSchema.parse(receipt));
  }

  public async listBySessionId(
    sessionId: SessionId,
  ): Promise<Result<readonly PromptDeliveryReceipt[], RepositoryError>> {
    const receipts = await this.list();
    return receipts.ok
      ? ok(receipts.value.filter((receipt) => receipt.sessionId === sessionId))
      : receipts;
  }

  public async list(): Promise<Result<readonly PromptDeliveryReceipt[], RepositoryError>> {
    await this.#writeTail;
    const receipts = readReceipts(this.memento);
    return receipts.ok
      ? ok(
          [...receipts.value]
            .sort(compareReceipts)
            .map((receipt) => PromptDeliveryReceiptSchema.parse(receipt)),
        )
      : receipts;
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

    return this.enqueue("save", async () => {
      const receipts = readReceipts(this.memento);
      if (!receipts.ok) {
        return receipts;
      }
      const existing = receipts.value.find(
        (candidate) => candidate.requestId === parsed.data.requestId,
      );
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

      const next = receipts.value.filter(
        (candidate) => candidate.requestId !== parsed.data.requestId,
      );
      next.push(parsed.data);
      next.sort(compareReceipts);
      await this.memento.update(PROMPT_DELIVERY_RECEIPT_STORAGE_KEY, next);
      return ok(PromptDeliveryReceiptSchema.parse(parsed.data));
    });
  }

  public delete(requestId: string): Promise<Result<void, RepositoryError>> {
    return this.enqueue("delete", async () => {
      const receipts = readReceipts(this.memento);
      if (!receipts.ok) {
        return receipts;
      }
      await this.memento.update(
        PROMPT_DELIVERY_RECEIPT_STORAGE_KEY,
        receipts.value.filter((receipt) => receipt.requestId !== requestId),
      );
      return ok(undefined);
    });
  }

  public prune(policy: PromptReceiptRetentionPolicy): Promise<Result<number, RepositoryError>> {
    if (!Number.isInteger(policy.maxClearedReceipts) || policy.maxClearedReceipts < 0) {
      return Promise.resolve(
        err(new RepositoryError("validation", "Receipt retention must be a non-negative integer.")),
      );
    }

    return this.enqueue("prune", async () => {
      const receipts = readReceipts(this.memento);
      if (!receipts.ok) {
        return receipts;
      }
      const cleared = receipts.value
        .filter((receipt) => receipt.draftCleanup === "cleared")
        .sort(compareReceipts);
      const removeCount = Math.max(0, cleared.length - policy.maxClearedReceipts);
      const removedIds = new Set(cleared.slice(0, removeCount).map((receipt) => receipt.requestId));
      if (removedIds.size > 0) {
        await this.memento.update(
          PROMPT_DELIVERY_RECEIPT_STORAGE_KEY,
          receipts.value.filter((receipt) => !removedIds.has(receipt.requestId)),
        );
      }
      return ok(removeCount);
    });
  }

  public async flush(): Promise<void> {
    await this.#writeTail;
  }

  private enqueue<T>(
    operation: string,
    write: () => Promise<Result<T, RepositoryError>>,
  ): Promise<Result<T, RepositoryError>> {
    const result = this.#writeTail
      .then(write)
      .catch((cause: unknown): Result<T, RepositoryError> => err(storageError(operation, cause)));
    this.#writeTail = result.then(() => undefined);
    return result;
  }
}
