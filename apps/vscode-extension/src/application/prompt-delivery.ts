import { SessionDraftSchema, type SessionId } from "@honeybee/domain";
import type { DraftRepository } from "@honeybee/persistence";

import type { ClockPort, RuntimeClientPort } from "./ports.js";

/** Separates runtime delivery from the best-effort cleanup of the persisted Draft. */
export type PromptDeliveryResult =
  | {
      readonly status: "accepted";
      readonly draftCleanup: "cleared";
    }
  | {
      readonly status: "accepted";
      readonly draftCleanup: "warning";
      readonly warning: string;
    }
  | {
      readonly status: "rejected";
      readonly message: string;
    };

/** Application ports required for one Prompt delivery attempt. */
export interface PromptDeliveryDependencies {
  readonly drafts: DraftRepository;
  readonly runtime: RuntimeClientPort;
  readonly clock: ClockPort;
}

/** Persists exact content, attempts Runtime input once, then cleans the delivered Draft. */
export const deliverPrompt = async (
  dependencies: PromptDeliveryDependencies,
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
  } catch (error) {
    return {
      status: "rejected",
      message: error instanceof Error ? error.message : "The runtime rejected the Prompt.",
    };
  }

  const cleanupResult = await dependencies.drafts.delete(sessionId);
  if (!cleanupResult.ok) {
    return {
      status: "accepted",
      draftCleanup: "warning",
      warning: "The Prompt was delivered, but its persisted Draft could not be cleared.",
    };
  }
  return { status: "accepted", draftCleanup: "cleared" };
};
