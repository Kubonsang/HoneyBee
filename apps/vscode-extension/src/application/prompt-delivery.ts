import { PromptDeliveryReceiptSchema, SessionDraftSchema, type SessionId } from "@honeybee/domain";
import type {
  DraftRepository,
  PromptDeliveryReceiptRepository,
  PromptReceiptRetentionPolicy,
} from "@honeybee/persistence";

import { fingerprintPromptContent } from "./prompt-content-fingerprint.js";
import type { ClockPort, RuntimeClientPort } from "./ports.js";

export const DEFAULT_PROMPT_RECEIPT_RETENTION_POLICY: PromptReceiptRetentionPolicy = {
  maxClearedReceipts: 1_000,
};

/** Typed local durability warnings that never include Prompt content. */
export type PromptDeliveryWarningCode =
  | "receipt-save-failed"
  | "draft-delete-failed"
  | "receipt-cleanup-update-failed"
  | "receipt-prune-failed";

/** Separates Runtime success from Receipt persistence and Draft cleanup outcomes. */
export type PromptDeliveryResult =
  | {
      readonly status: "accepted";
      readonly receiptPersistence: "stored" | "warning";
      readonly draftCleanup: "cleared" | "pending" | "warning";
      readonly warnings: readonly PromptDeliveryWarningCode[];
    }
  | {
      readonly status: "rejected";
      readonly message: string;
    };

/** Application ports required for one Prompt delivery attempt. */
export interface PromptDeliveryDependencies {
  readonly drafts: DraftRepository;
  readonly receipts: PromptDeliveryReceiptRepository;
  readonly runtime: RuntimeClientPort;
  readonly clock: ClockPort;
  readonly retentionPolicy?: PromptReceiptRetentionPolicy;
}

/** Persists exact content, attempts Runtime input once, then records and cleans delivery state. */
export const deliverPrompt = async (
  dependencies: PromptDeliveryDependencies,
  requestId: string,
  sessionId: SessionId,
  content: string,
): Promise<PromptDeliveryResult> => {
  if (content.trim().length === 0) {
    return { status: "rejected", message: "Prompt content must not be empty." };
  }

  const draft = SessionDraftSchema.parse({
    sessionId,
    content,
    updatedAt: dependencies.clock.now(),
  });
  const saveResult = await dependencies.drafts.save(draft);
  if (!saveResult.ok) {
    return {
      status: "rejected",
      message: "The Prompt could not be preserved before delivery.",
    };
  }

  try {
    await dependencies.runtime.sendInput(sessionId, `${content}\r`);
  } catch {
    return {
      status: "rejected",
      message: "The Runtime rejected the Prompt input.",
    };
  }

  const warnings: PromptDeliveryWarningCode[] = [];
  const fingerprint = fingerprintPromptContent(content);
  const pendingReceipt = PromptDeliveryReceiptSchema.safeParse({
    requestId,
    sessionId,
    ...fingerprint,
    deliveredAt: dependencies.clock.now(),
    draftCleanup: "pending",
    schemaVersion: 1,
  });

  let receiptStored = false;
  if (pendingReceipt.success) {
    try {
      const receiptSave = await dependencies.receipts.save(pendingReceipt.data);
      receiptStored = receiptSave.ok;
    } catch {
      receiptStored = false;
    }
  }
  if (!receiptStored) {
    warnings.push("receipt-save-failed");
  }

  const draftCleared = await (async (): Promise<boolean> => {
    try {
      const cleanupResult = await dependencies.drafts.delete(sessionId);
      return cleanupResult.ok;
    } catch {
      return false;
    }
  })();
  if (!draftCleared) {
    warnings.push("draft-delete-failed");
  }

  if (receiptStored && draftCleared && pendingReceipt.success) {
    try {
      const cleanupUpdate = await dependencies.receipts.save({
        ...pendingReceipt.data,
        draftCleanup: "cleared",
      });
      if (!cleanupUpdate.ok) {
        warnings.push("receipt-cleanup-update-failed");
      }
    } catch {
      warnings.push("receipt-cleanup-update-failed");
    }
  }

  try {
    const pruneResult = await dependencies.receipts.prune(
      dependencies.retentionPolicy ?? DEFAULT_PROMPT_RECEIPT_RETENTION_POLICY,
    );
    if (!pruneResult.ok) {
      warnings.push("receipt-prune-failed");
    }
  } catch {
    warnings.push("receipt-prune-failed");
  }

  return {
    status: "accepted",
    receiptPersistence: receiptStored ? "stored" : "warning",
    draftCleanup: draftCleared ? "cleared" : receiptStored ? "pending" : "warning",
    warnings,
  };
};
