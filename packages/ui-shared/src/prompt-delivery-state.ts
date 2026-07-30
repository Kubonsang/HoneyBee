import type {
  PromptAcknowledgementMessage,
  PromptAcceptedMessage,
  PromptSendMessage,
} from "./contracts.js";

/** Prompt content correlated with the acknowledgement that may settle it. */
export interface PendingPromptDelivery {
  readonly requestId: string;
  readonly sessionId: string;
  readonly content: string;
}

/** Acknowledgement outcome after correlation with a currently pending Prompt. */
export type PromptSettlement =
  | { readonly status: "ignored" }
  | {
      readonly status: "accepted";
      readonly prompt: PendingPromptDelivery;
      readonly acknowledgement: PromptAcceptedMessage;
    }
  | {
      readonly status: "rejected" | "unknown";
      readonly prompt: PendingPromptDelivery;
      readonly message: string;
    };

/** Tracks pending Prompt requests without coupling Webview state to Monaco. */
export class PromptDeliveryTracker {
  readonly #pendingBySession = new Map<string, PendingPromptDelivery>();

  public begin(message: PromptSendMessage): boolean {
    if (this.#pendingBySession.has(message.sessionId)) return false;
    this.#pendingBySession.set(message.sessionId, {
      requestId: message.requestId,
      sessionId: message.sessionId,
      content: message.content,
    });
    return true;
  }

  public isPending(sessionId: string): boolean {
    return this.#pendingBySession.has(sessionId);
  }

  public settle(message: PromptAcknowledgementMessage): PromptSettlement {
    const pending = this.#pendingBySession.get(message.sessionId);
    if (pending === undefined || pending.requestId !== message.requestId) {
      return { status: "ignored" };
    }
    this.#pendingBySession.delete(message.sessionId);
    if (message.type === "prompt.accepted") {
      return { status: "accepted", prompt: pending, acknowledgement: message };
    }
    return {
      status: message.type === "prompt.unknown" ? "unknown" : "rejected",
      prompt: pending,
      message: message.message,
    };
  }
}

/** Clears only the exact submitted Draft after a correlated accepted acknowledgement. */
export const reconcileDraftAfterSettlement = (
  currentDraft: string,
  settlement: PromptSettlement,
): string =>
  settlement.status === "accepted" && currentDraft === settlement.prompt.content
    ? ""
    : currentDraft;

/** Describes accepted Runtime input without implying Agent processing or exposing content. */
export const promptAcceptedStatusMessage = (message: PromptAcceptedMessage): string => {
  if (message.attemptPersistence === "warning") {
    return "Prompt delivered to the Runtime. Local Attempt recovery warning.";
  }
  if (message.receiptPersistence === "warning") {
    return "Prompt delivered to the Runtime. Local recovery receipt warning.";
  }
  if (message.draftCleanup === "pending") {
    return "Prompt delivered to the Runtime. Draft cleanup will retry after restart.";
  }
  if (message.draftCleanup === "warning") {
    return "Prompt delivered to the Runtime. Local Draft cleanup warning.";
  }
  if (message.warnings.length > 0) {
    return "Prompt delivered to the Runtime. Local recovery maintenance warning.";
  }
  return "Prompt delivered to the Runtime.";
};
