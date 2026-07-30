import type { PromptDeliveryReceipt, SessionDraft, SessionId } from "@honeybee/domain";
import type {
  DraftRepository,
  PromptDeliveryReceiptRepository,
  PromptReceiptRetentionPolicy,
  RepositoryError,
} from "@honeybee/persistence";

import { DEFAULT_PROMPT_RECEIPT_RETENTION_POLICY } from "./prompt-delivery.js";
import { receiptMatchesPromptContent } from "./prompt-content-fingerprint.js";

export type PromptDeliveryReconciliationEvent =
  | {
      readonly type: "reconciled";
      readonly sessionId: SessionId;
      readonly requestId: string;
    }
  | {
      readonly type: "preserved";
      readonly sessionId: SessionId;
      readonly requestId: string;
    }
  | {
      readonly type: "failed";
      readonly code:
        | "receipt-list-failed"
        | "draft-list-failed"
        | "draft-delete-failed"
        | "receipt-update-failed"
        | "receipt-prune-failed";
      readonly sessionId?: SessionId;
      readonly requestId?: string;
    };

/** Aggregate startup recovery result without Prompt content or storage error details. */
export interface PromptDeliveryReconciliationReport {
  readonly scannedReceipts: number;
  readonly reconciledDrafts: number;
  readonly clearedReceipts: number;
  readonly preservedDrafts: number;
  readonly prunedReceipts: number;
  readonly events: readonly PromptDeliveryReconciliationEvent[];
}

export interface PromptDeliveryReconcilerDependencies {
  readonly drafts: DraftRepository;
  readonly receipts: PromptDeliveryReceiptRepository;
  readonly retentionPolicy?: PromptReceiptRetentionPolicy;
}

const failedEvent = (
  code: Extract<PromptDeliveryReconciliationEvent, { type: "failed" }>["code"],
  receipt?: PromptDeliveryReceipt,
): PromptDeliveryReconciliationEvent => ({
  type: "failed",
  code,
  ...(receipt === undefined ? {} : { sessionId: receipt.sessionId, requestId: receipt.requestId }),
});

const safeListReceipts = async (
  repository: PromptDeliveryReceiptRepository,
): Promise<
  | { readonly ok: true; readonly value: readonly PromptDeliveryReceipt[] }
  | { readonly ok: false; readonly error?: RepositoryError }
> => {
  try {
    return await repository.list();
  } catch {
    return { ok: false };
  }
};

const safeListDrafts = async (
  repository: DraftRepository,
): Promise<
  | { readonly ok: true; readonly value: readonly SessionDraft[] }
  | { readonly ok: false; readonly error?: RepositoryError }
> => {
  try {
    return await repository.list();
  } catch {
    return { ok: false };
  }
};

/** Reconciles delivered receipts with Drafts without ever invoking the Runtime. */
export class PromptDeliveryReconciler {
  public constructor(private readonly dependencies: PromptDeliveryReconcilerDependencies) {}

  public async reconcile(): Promise<PromptDeliveryReconciliationReport> {
    const events: PromptDeliveryReconciliationEvent[] = [];
    const receiptsResult = await safeListReceipts(this.dependencies.receipts);
    if (!receiptsResult.ok) {
      return this.report(0, 0, 0, 0, 0, [failedEvent("receipt-list-failed")]);
    }
    const draftsResult = await safeListDrafts(this.dependencies.drafts);
    if (!draftsResult.ok) {
      return this.report(receiptsResult.value.length, 0, 0, 0, 0, [
        failedEvent("draft-list-failed"),
      ]);
    }

    const draftsBySession = new Map<SessionId, SessionDraft>(
      draftsResult.value.map((draft) => [draft.sessionId, draft]),
    );
    let reconciledDrafts = 0;
    let clearedReceipts = 0;
    let preservedDrafts = 0;

    for (const receipt of receiptsResult.value) {
      const draft = draftsBySession.get(receipt.sessionId);
      if (draft === undefined) {
        if (receipt.draftCleanup === "pending") {
          const cleared = await this.markCleared(receipt);
          if (cleared) {
            clearedReceipts += 1;
          } else {
            events.push(failedEvent("receipt-update-failed", receipt));
          }
        }
        continue;
      }

      const wasSavedBeforeDelivery = Date.parse(draft.updatedAt) <= Date.parse(receipt.deliveredAt);
      const matchesDeliveredContent =
        wasSavedBeforeDelivery && receiptMatchesPromptContent(receipt, draft.content);
      if (!matchesDeliveredContent) {
        preservedDrafts += 1;
        events.push({
          type: "preserved",
          sessionId: receipt.sessionId,
          requestId: receipt.requestId,
        });
        if (receipt.draftCleanup === "pending") {
          const cleared = await this.markCleared(receipt);
          if (cleared) {
            clearedReceipts += 1;
          } else {
            events.push(failedEvent("receipt-update-failed", receipt));
          }
        }
        continue;
      }

      const deleted = await (async (): Promise<boolean> => {
        try {
          const deleteResult = await this.dependencies.drafts.delete(receipt.sessionId);
          return deleteResult.ok;
        } catch {
          return false;
        }
      })();
      if (!deleted) {
        events.push(failedEvent("draft-delete-failed", receipt));
        continue;
      }

      draftsBySession.delete(receipt.sessionId);
      reconciledDrafts += 1;
      events.push({
        type: "reconciled",
        sessionId: receipt.sessionId,
        requestId: receipt.requestId,
      });
      if (receipt.draftCleanup === "pending") {
        const cleared = await this.markCleared(receipt);
        if (cleared) {
          clearedReceipts += 1;
        } else {
          events.push(failedEvent("receipt-update-failed", receipt));
        }
      }
    }

    let prunedReceipts = 0;
    try {
      const pruneResult = await this.dependencies.receipts.prune(
        this.dependencies.retentionPolicy ?? DEFAULT_PROMPT_RECEIPT_RETENTION_POLICY,
      );
      if (pruneResult.ok) {
        prunedReceipts = pruneResult.value;
      } else {
        events.push(failedEvent("receipt-prune-failed"));
      }
    } catch {
      events.push(failedEvent("receipt-prune-failed"));
    }

    return this.report(
      receiptsResult.value.length,
      reconciledDrafts,
      clearedReceipts,
      preservedDrafts,
      prunedReceipts,
      events,
    );
  }

  private async markCleared(receipt: PromptDeliveryReceipt): Promise<boolean> {
    try {
      const result = await this.dependencies.receipts.save({
        ...receipt,
        draftCleanup: "cleared",
      });
      return result.ok;
    } catch {
      return false;
    }
  }

  private report(
    scannedReceipts: number,
    reconciledDrafts: number,
    clearedReceipts: number,
    preservedDrafts: number,
    prunedReceipts: number,
    events: readonly PromptDeliveryReconciliationEvent[],
  ): PromptDeliveryReconciliationReport {
    return {
      scannedReceipts,
      reconciledDrafts,
      clearedReceipts,
      preservedDrafts,
      prunedReceipts,
      events,
    };
  }
}
