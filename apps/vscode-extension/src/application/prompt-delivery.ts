import {
  PromptDeliveryAttemptSchema,
  PromptDeliveryReceiptSchema,
  SessionDraftSchema,
  transitionPromptDeliveryAttempt,
  type PromptDeliveryAttempt,
  type SessionId,
} from "@honeybee/domain";
import type {
  DraftRepository,
  PromptAttemptRetentionPolicy,
  PromptDeliveryAttemptRepository,
  PromptDeliveryReceiptRepository,
  PromptReceiptRetentionPolicy,
} from "@honeybee/persistence";

import { fingerprintPromptContent } from "./prompt-content-fingerprint.js";
import type { ClockPort, PromptRuntimeInputPort, RuntimeInputOutcome } from "./ports.js";

export const DEFAULT_PROMPT_RECEIPT_RETENTION_POLICY: PromptReceiptRetentionPolicy = {
  maxClearedReceipts: 1_000,
};
export const DEFAULT_PROMPT_ATTEMPT_RETENTION_POLICY: PromptAttemptRetentionPolicy = {
  maxTerminalAttempts: 1_000,
};

/** Typed local durability warnings that never include Prompt content. */
export type PromptDeliveryWarningCode =
  | "attempt-runtime-accepted-save-failed"
  | "attempt-unknown-save-failed"
  | "attempt-finalize-failed"
  | "attempt-prune-failed"
  | "receipt-save-failed"
  | "draft-delete-failed"
  | "receipt-cleanup-update-failed"
  | "receipt-prune-failed";

export type PromptDeliveryRejectionCode =
  | "draft-save-failed"
  | "attempt-prepare-save-failed"
  | "attempt-prepare-flush-failed"
  | "attempt-dispatching-save-failed"
  | "attempt-dispatching-flush-failed"
  | "runtime-input-rejected";

/** Separates Runtime outcome from Attempt, Receipt, and Draft persistence outcomes. */
export type PromptDeliveryResult =
  | {
      readonly status: "accepted";
      readonly attemptPersistence: "stored" | "warning";
      readonly receiptPersistence: "stored" | "warning";
      readonly draftCleanup: "cleared" | "pending" | "warning";
      readonly warnings: readonly PromptDeliveryWarningCode[];
    }
  | {
      readonly status: "rejected";
      readonly code: PromptDeliveryRejectionCode;
      readonly message: string;
      readonly warnings?: readonly PromptDeliveryWarningCode[];
    }
  | {
      readonly status: "unknown";
      readonly code: "runtime-input-outcome-unknown";
      readonly message: string;
      readonly warnings: readonly PromptDeliveryWarningCode[];
    };

/** Application ports required for one Prompt delivery attempt. */
export interface PromptDeliveryDependencies {
  readonly drafts: DraftRepository;
  readonly attempts: PromptDeliveryAttemptRepository;
  readonly receipts: PromptDeliveryReceiptRepository;
  readonly runtime: PromptRuntimeInputPort;
  readonly clock: ClockPort;
  readonly attemptRetentionPolicy?: PromptAttemptRetentionPolicy;
  readonly receiptRetentionPolicy?: PromptReceiptRetentionPolicy;
}

const saveAttempt = async (
  repository: PromptDeliveryAttemptRepository,
  attempt: PromptDeliveryAttempt,
): Promise<boolean> => {
  try {
    const result = await repository.save(attempt);
    return result.ok;
  } catch {
    return false;
  }
};

const flushAttempts = async (repository: PromptDeliveryAttemptRepository): Promise<boolean> => {
  try {
    await repository.flush();
    return true;
  } catch {
    return false;
  }
};

const transitionAttempt = (
  attempt: PromptDeliveryAttempt,
  transition: Parameters<typeof transitionPromptDeliveryAttempt>[1],
): PromptDeliveryAttempt | undefined => {
  const result = transitionPromptDeliveryAttempt(attempt, transition);
  return result.ok ? result.value : undefined;
};

const beforeDispatchFailure = (
  code: Exclude<PromptDeliveryRejectionCode, "runtime-input-rejected">,
): PromptDeliveryResult => ({
  status: "rejected",
  code,
  message:
    "The Prompt was preserved, but delivery did not start because local recovery state could not be stored.",
});

const classifyRuntimeOutcome = async (
  runtime: PromptRuntimeInputPort,
  sessionId: SessionId,
  content: string,
): Promise<RuntimeInputOutcome> => {
  try {
    return await runtime.sendInput(sessionId, `${content}\r`);
  } catch {
    return {
      status: "unknown",
      reason: "The Runtime input outcome could not be determined.",
    };
  }
};

const pruneAttempts = async (dependencies: PromptDeliveryDependencies): Promise<boolean> => {
  try {
    const result = await dependencies.attempts.prune(
      dependencies.attemptRetentionPolicy ?? DEFAULT_PROMPT_ATTEMPT_RETENTION_POLICY,
    );
    return result.ok;
  } catch {
    return false;
  }
};

/** Persists exact content and Attempt identity before invoking Runtime input exactly once. */
export const deliverPrompt = async (
  dependencies: PromptDeliveryDependencies,
  requestId: string,
  sessionId: SessionId,
  content: string,
): Promise<PromptDeliveryResult> => {
  if (content.trim().length === 0) {
    return {
      status: "rejected",
      code: "draft-save-failed",
      message: "Prompt content must not be empty.",
    };
  }

  const preparedAt = dependencies.clock.now();
  const draft = SessionDraftSchema.parse({ sessionId, content, updatedAt: preparedAt });
  const draftSave = await dependencies.drafts.save(draft);
  if (!draftSave.ok) {
    return {
      status: "rejected",
      code: "draft-save-failed",
      message: "The Prompt could not be preserved before delivery.",
    };
  }

  const prepared = PromptDeliveryAttemptSchema.parse({
    requestId,
    sessionId,
    ...fingerprintPromptContent(content),
    phase: "prepared",
    preparedAt,
    updatedAt: preparedAt,
    schemaVersion: 1,
  });
  if (!(await saveAttempt(dependencies.attempts, prepared))) {
    return beforeDispatchFailure("attempt-prepare-save-failed");
  }
  if (!(await flushAttempts(dependencies.attempts))) {
    return beforeDispatchFailure("attempt-prepare-flush-failed");
  }

  const dispatching = transitionAttempt(prepared, {
    phase: "dispatching",
    updatedAt: dependencies.clock.now(),
  });
  if (dispatching === undefined || !(await saveAttempt(dependencies.attempts, dispatching))) {
    return beforeDispatchFailure("attempt-dispatching-save-failed");
  }
  if (!(await flushAttempts(dependencies.attempts))) {
    return beforeDispatchFailure("attempt-dispatching-flush-failed");
  }

  const runtimeOutcome = await classifyRuntimeOutcome(dependencies.runtime, sessionId, content);
  if (runtimeOutcome.status === "rejected") {
    const warnings: PromptDeliveryWarningCode[] = [];
    try {
      const finalized = await dependencies.attempts.delete(requestId);
      if (!finalized.ok) warnings.push("attempt-finalize-failed");
    } catch {
      warnings.push("attempt-finalize-failed");
    }
    if (!(await pruneAttempts(dependencies))) warnings.push("attempt-prune-failed");
    return {
      status: "rejected",
      code: "runtime-input-rejected",
      message: runtimeOutcome.message,
      ...(warnings.length === 0 ? {} : { warnings }),
    };
  }

  if (runtimeOutcome.status === "unknown") {
    const unknown = transitionAttempt(dispatching, {
      phase: "unknown",
      updatedAt: dependencies.clock.now(),
    });
    const warnings: PromptDeliveryWarningCode[] = [];
    if (unknown === undefined || !(await saveAttempt(dependencies.attempts, unknown))) {
      warnings.push("attempt-unknown-save-failed");
    }
    return {
      status: "unknown",
      code: "runtime-input-outcome-unknown",
      message: runtimeOutcome.reason,
      warnings,
    };
  }

  const warnings: PromptDeliveryWarningCode[] = [];
  const acceptedAt = dependencies.clock.now();
  const acceptedAttempt = transitionAttempt(dispatching, {
    phase: "runtime-accepted",
    updatedAt: acceptedAt,
    acceptedAt,
  });
  let acceptedAttemptStored = false;
  if (acceptedAttempt !== undefined) {
    acceptedAttemptStored = await saveAttempt(dependencies.attempts, acceptedAttempt);
  }
  if (!acceptedAttemptStored) {
    warnings.push("attempt-runtime-accepted-save-failed");
  }

  const pendingReceipt = PromptDeliveryReceiptSchema.parse({
    requestId,
    sessionId,
    contentDigest: prepared.contentDigest,
    contentLength: prepared.contentLength,
    deliveredAt: acceptedAt,
    draftCleanup: "pending",
    schemaVersion: 1,
  });
  const receiptStored = await (async (): Promise<boolean> => {
    try {
      const receiptSave = await dependencies.receipts.save(pendingReceipt);
      return receiptSave.ok;
    } catch {
      return false;
    }
  })();
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

  if (receiptStored && draftCleared) {
    try {
      const cleanupUpdate = await dependencies.receipts.save({
        ...pendingReceipt,
        draftCleanup: "cleared",
      });
      if (!cleanupUpdate.ok) warnings.push("receipt-cleanup-update-failed");
    } catch {
      warnings.push("receipt-cleanup-update-failed");
    }
  }

  if (receiptStored) {
    try {
      const finalized = await dependencies.attempts.delete(requestId);
      if (!finalized.ok) warnings.push("attempt-finalize-failed");
    } catch {
      warnings.push("attempt-finalize-failed");
    }
  }

  if (!(await pruneAttempts(dependencies))) {
    warnings.push("attempt-prune-failed");
  }
  try {
    const receiptPrune = await dependencies.receipts.prune(
      dependencies.receiptRetentionPolicy ?? DEFAULT_PROMPT_RECEIPT_RETENTION_POLICY,
    );
    if (!receiptPrune.ok) warnings.push("receipt-prune-failed");
  } catch {
    warnings.push("receipt-prune-failed");
  }

  return {
    status: "accepted",
    attemptPersistence: acceptedAttemptStored || receiptStored ? "stored" : "warning",
    receiptPersistence: receiptStored ? "stored" : "warning",
    draftCleanup: draftCleared ? "cleared" : receiptStored ? "pending" : "warning",
    warnings,
  };
};
