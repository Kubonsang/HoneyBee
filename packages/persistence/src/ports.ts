import type {
  AgentSession,
  PromptDeliveryReceipt,
  Result,
  SessionDraft,
  SessionId,
  SessionStatus,
} from "@honeybee/domain";

import type { RepositoryError } from "./errors.js";

export interface SessionQuery {
  readonly parentSessionId?: SessionId | null;
  readonly status?: SessionStatus;
  readonly tag?: string;
}

export interface SessionRepository {
  getById(id: SessionId): Promise<Result<AgentSession, RepositoryError>>;
  list(query?: SessionQuery): Promise<Result<readonly AgentSession[], RepositoryError>>;
  save(session: AgentSession): Promise<Result<AgentSession, RepositoryError>>;
  delete(id: SessionId): Promise<Result<void, RepositoryError>>;
}

export interface DraftRepository {
  getBySessionId(sessionId: SessionId): Promise<Result<SessionDraft | undefined, RepositoryError>>;
  list(): Promise<Result<readonly SessionDraft[], RepositoryError>>;
  save(draft: SessionDraft): Promise<Result<SessionDraft, RepositoryError>>;
  delete(sessionId: SessionId): Promise<Result<void, RepositoryError>>;
}
/** Bounded retention applied only to receipts whose Draft cleanup is complete. */
export interface PromptReceiptRetentionPolicy {
  readonly maxClearedReceipts: number;
}

/** Durable storage boundary for content-minimized Prompt delivery receipts. */
export interface PromptDeliveryReceiptRepository {
  getByRequestId(
    requestId: string,
  ): Promise<Result<PromptDeliveryReceipt | undefined, RepositoryError>>;
  listBySessionId(
    sessionId: SessionId,
  ): Promise<Result<readonly PromptDeliveryReceipt[], RepositoryError>>;
  list(): Promise<Result<readonly PromptDeliveryReceipt[], RepositoryError>>;
  save(receipt: PromptDeliveryReceipt): Promise<Result<PromptDeliveryReceipt, RepositoryError>>;
  delete(requestId: string): Promise<Result<void, RepositoryError>>;
  prune(policy: PromptReceiptRetentionPolicy): Promise<Result<number, RepositoryError>>;
  flush(): Promise<void>;
}
