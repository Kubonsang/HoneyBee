import * as vscode from "vscode";

import {
  AgentSessionSchema,
  PromptDeliveryAttemptSchema,
  PromptDeliveryReceiptSchema,
  SessionDraftSchema,
  SessionIdSchema,
} from "@honeybee/domain";

import { PROMPT_DELIVERY_ATTEMPT_STORAGE_KEY } from "./global-state-prompt-attempt-repository.js";
import { PROMPT_DELIVERY_RECEIPT_STORAGE_KEY } from "./global-state-prompt-receipt-repository.js";
import {
  DRAFT_STORAGE_KEY,
  SELECTED_SESSION_STORAGE_KEY,
  SESSION_STORAGE_KEY,
} from "./global-state-repositories.js";

export const PROMPT_RECOVERY_TEST_FIXTURE_ENV = "HONEY_BEE_TEST_PROMPT_RECOVERY_FIXTURE";

/** Sanitized activation state exposed only to Extension Host tests. */
export interface PromptRecoveryExtensionTestState {
  readonly draftSessionIds: readonly string[];
  readonly receiptCleanup: readonly {
    readonly requestId: string;
    readonly draftCleanup: "pending" | "cleared";
  }[];
  readonly selectedDraftPresent: boolean;
  readonly attemptPhases: readonly { readonly requestId: string; readonly phase: string }[];
  readonly recoveryIssueRequestIds: readonly string[];
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Seeds Extension Host recovery state only when VS Code runs the extension in Test mode. */
export const applyPromptRecoveryTestFixture = async (
  context: vscode.ExtensionContext,
): Promise<void> => {
  if (context.extensionMode !== vscode.ExtensionMode.Test) {
    return;
  }
  const serialized = process.env[PROMPT_RECOVERY_TEST_FIXTURE_ENV];
  Reflect.deleteProperty(process.env, PROMPT_RECOVERY_TEST_FIXTURE_ENV);
  if (serialized === undefined) {
    return;
  }

  const value: unknown = JSON.parse(serialized);
  if (!isRecord(value)) {
    throw new Error("Prompt recovery test fixture must be an object.");
  }
  const sessions = AgentSessionSchema.array().parse(value.sessions);
  const drafts = SessionDraftSchema.array().parse(value.drafts);
  const attempts = PromptDeliveryAttemptSchema.array().parse(value.attempts ?? []);
  const receipts = PromptDeliveryReceiptSchema.array().parse(value.receipts);
  const selectedSessionId = SessionIdSchema.parse(value.selectedSessionId);

  await Promise.all([
    context.globalState.update(SESSION_STORAGE_KEY, sessions),
    context.globalState.update(DRAFT_STORAGE_KEY, drafts),
    context.globalState.update(PROMPT_DELIVERY_ATTEMPT_STORAGE_KEY, attempts),
    context.globalState.update(PROMPT_DELIVERY_RECEIPT_STORAGE_KEY, receipts),
    context.globalState.update(SELECTED_SESSION_STORAGE_KEY, selectedSessionId),
  ]);
};
