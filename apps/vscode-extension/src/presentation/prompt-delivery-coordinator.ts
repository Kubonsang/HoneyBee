import type { SessionId } from "@honeybee/domain";
import type { PromptAcknowledgementMessage, PromptSendMessage } from "@honeybee/ui-shared";

import type { PromptDeliveryResult } from "../application/prompt-delivery.js";

const DRAFT_DEBOUNCE_MS = 250;
const MAX_TRACKED_REQUEST_IDS = 1_000;

interface PendingDraft {
  readonly content: string;
  readonly revision: number;
  readonly timeout: ReturnType<typeof setTimeout>;
}

interface SessionDraftState {
  revision: number;
  pending: PendingDraft | undefined;
  writeTail: Promise<void>;
}

/** A validated Prompt request whose Session ID carries the Domain brand. */
export type ParsedPromptSendMessage = Omit<PromptSendMessage, "sessionId"> & {
  readonly sessionId: SessionId;
};

/** Narrow application boundary needed to coordinate Draft writes and Prompt delivery. */
export interface PromptDeliveryServicePort {
  saveDraft(sessionId: SessionId, content: string): Promise<void>;
  sendPrompt(sessionId: SessionId, content: string): Promise<PromptDeliveryResult>;
}

/** Serializes per-Session Draft writes and correlates each Prompt acknowledgement. */
export class PromptDeliveryCoordinator {
  readonly #draftStates = new Map<SessionId, SessionDraftState>();
  readonly #pendingRequests = new Map<SessionId, string>();
  readonly #seenRequestIds = new Set<string>();
  readonly #requestOrder: string[] = [];

  public constructor(
    private readonly service: PromptDeliveryServicePort,
    private readonly reportError: (error: unknown) => void,
    private readonly reportDiagnostic: (message: string) => void,
  ) {}

  public scheduleDraft(sessionId: SessionId, content: string): void {
    if (this.#pendingRequests.has(sessionId)) {
      return;
    }

    const state = this.getDraftState(sessionId);
    state.revision += 1;
    if (state.pending !== undefined) {
      clearTimeout(state.pending.timeout);
    }
    const revision = state.revision;
    const timeout = setTimeout(() => {
      const pending = state.pending;
      if (pending === undefined || pending.revision !== revision) {
        return;
      }
      state.pending = undefined;
      this.enqueueDraftSave(sessionId, state, pending);
    }, DRAFT_DEBOUNCE_MS);
    state.pending = { content, revision, timeout };
  }

  public async deliver(
    message: ParsedPromptSendMessage,
  ): Promise<PromptAcknowledgementMessage | undefined> {
    if (this.#seenRequestIds.has(message.requestId)) {
      return undefined;
    }
    this.rememberRequest(message.requestId);

    const activeRequestId = this.#pendingRequests.get(message.sessionId);
    if (activeRequestId !== undefined) {
      return {
        type: "prompt.rejected",
        requestId: message.requestId,
        sessionId: message.sessionId,
        message: "Another Prompt is already being delivered for this Session.",
      };
    }

    this.#pendingRequests.set(message.sessionId, message.requestId);
    try {
      await this.cancelPendingDraftAndDrain(message.sessionId);
      const result = await this.service.sendPrompt(message.sessionId, message.content);
      return this.toAcknowledgement(message, result);
    } catch (error) {
      this.reportError(
        new Error(
          `Prompt delivery failed for Session ${message.sessionId}, request ${message.requestId}.`,
          { cause: error },
        ),
      );
      return {
        type: "prompt.rejected",
        requestId: message.requestId,
        sessionId: message.sessionId,
        message: "Prompt delivery failed before the runtime could acknowledge it.",
      };
    } finally {
      if (this.#pendingRequests.get(message.sessionId) === message.requestId) {
        this.#pendingRequests.delete(message.sessionId);
      }
    }
  }

  public dispose(): void {
    for (const [sessionId, state] of this.#draftStates) {
      const pending = state.pending;
      if (pending === undefined) {
        continue;
      }
      clearTimeout(pending.timeout);
      state.pending = undefined;
      this.enqueueDraftSave(sessionId, state, pending);
    }
  }

  private async cancelPendingDraftAndDrain(sessionId: SessionId): Promise<void> {
    const state = this.getDraftState(sessionId);
    state.revision += 1;
    if (state.pending !== undefined) {
      clearTimeout(state.pending.timeout);
      state.pending = undefined;
    }
    await state.writeTail;
  }

  private enqueueDraftSave(
    sessionId: SessionId,
    state: SessionDraftState,
    pending: Pick<PendingDraft, "content" | "revision">,
  ): void {
    const write = state.writeTail.then(async () => {
      if (state.revision !== pending.revision || this.#pendingRequests.has(sessionId)) {
        return;
      }
      await this.service.saveDraft(sessionId, pending.content);
    });
    state.writeTail = write.catch(this.reportError);
  }

  private getDraftState(sessionId: SessionId): SessionDraftState {
    const existing = this.#draftStates.get(sessionId);
    if (existing !== undefined) {
      return existing;
    }
    const created: SessionDraftState = {
      revision: 0,
      pending: undefined,
      writeTail: Promise.resolve(),
    };
    this.#draftStates.set(sessionId, created);
    return created;
  }

  private rememberRequest(requestId: string): void {
    this.#seenRequestIds.add(requestId);
    this.#requestOrder.push(requestId);
    if (this.#requestOrder.length <= MAX_TRACKED_REQUEST_IDS) {
      return;
    }
    const expired = this.#requestOrder.shift();
    if (expired !== undefined) {
      this.#seenRequestIds.delete(expired);
    }
  }

  private toAcknowledgement(
    message: ParsedPromptSendMessage,
    result: PromptDeliveryResult,
  ): PromptAcknowledgementMessage {
    if (result.status === "rejected") {
      this.reportDiagnostic(
        `Prompt rejected for Session ${message.sessionId}, request ${message.requestId}.`,
      );
      return {
        type: "prompt.rejected",
        requestId: message.requestId,
        sessionId: message.sessionId,
        message: result.message,
      };
    }
    if (result.draftCleanup === "warning") {
      this.reportDiagnostic(
        `Prompt accepted with Draft cleanup warning for Session ${message.sessionId}, request ${message.requestId}.`,
      );
      return {
        type: "prompt.accepted",
        requestId: message.requestId,
        sessionId: message.sessionId,
        draftCleanup: "warning",
        warning: result.warning,
      };
    }
    return {
      type: "prompt.accepted",
      requestId: message.requestId,
      sessionId: message.sessionId,
      draftCleanup: "cleared",
    };
  }
}
