import {
  PromptDeliveryAttemptSchema,
  err,
  isTerminalPromptDeliveryAttempt,
  isValidPromptDeliveryAttemptSuccessor,
  ok,
  type PromptDeliveryAttempt,
  type Result,
  type SessionId,
} from "@honeybee/domain";

import { RepositoryError } from "./errors.js";
import type { PromptAttemptRetentionPolicy, PromptDeliveryAttemptRepository } from "./ports.js";

const cloneAttempt = (attempt: PromptDeliveryAttempt): PromptDeliveryAttempt =>
  PromptDeliveryAttemptSchema.parse(attempt);

const compareAttempts = (left: PromptDeliveryAttempt, right: PromptDeliveryAttempt): number => {
  const preparedAt = left.preparedAt.localeCompare(right.preparedAt);
  return preparedAt === 0 ? left.requestId.localeCompare(right.requestId) : preparedAt;
};

/** In-process Attempt repository used by deterministic tests and lightweight hosts. */
export class InMemoryPromptDeliveryAttemptRepository implements PromptDeliveryAttemptRepository {
  readonly #attempts = new Map<string, PromptDeliveryAttempt>();

  public constructor(initialAttempts: readonly PromptDeliveryAttempt[] = []) {
    for (const attempt of initialAttempts) {
      const parsed = PromptDeliveryAttemptSchema.parse(attempt);
      this.#attempts.set(parsed.requestId, parsed);
    }
  }

  public async getByRequestId(
    requestId: string,
  ): Promise<Result<PromptDeliveryAttempt | undefined, RepositoryError>> {
    const attempt = this.#attempts.get(requestId);
    return ok(attempt === undefined ? undefined : cloneAttempt(attempt));
  }

  public async listBySessionId(
    sessionId: SessionId,
  ): Promise<Result<readonly PromptDeliveryAttempt[], RepositoryError>> {
    return ok(
      [...this.#attempts.values()]
        .filter((attempt) => attempt.sessionId === sessionId)
        .sort(compareAttempts)
        .map(cloneAttempt),
    );
  }

  public async list(): Promise<Result<readonly PromptDeliveryAttempt[], RepositoryError>> {
    return ok([...this.#attempts.values()].sort(compareAttempts).map(cloneAttempt));
  }

  public async save(
    attempt: PromptDeliveryAttempt,
  ): Promise<Result<PromptDeliveryAttempt, RepositoryError>> {
    const parsed = PromptDeliveryAttemptSchema.safeParse(attempt);
    if (!parsed.success) {
      return err(
        new RepositoryError("validation", "The Prompt Attempt does not satisfy its schema.", {
          details: { issues: parsed.error.issues },
        }),
      );
    }

    const existing = this.#attempts.get(parsed.data.requestId);
    if (existing !== undefined && !isValidPromptDeliveryAttemptSuccessor(existing, parsed.data)) {
      return err(
        new RepositoryError(
          "conflict",
          `Prompt Attempt "${parsed.data.requestId}" has an invalid identity or phase transition.`,
        ),
      );
    }

    const stored = cloneAttempt(parsed.data);
    this.#attempts.set(stored.requestId, stored);
    return ok(cloneAttempt(stored));
  }

  public async delete(requestId: string): Promise<Result<void, RepositoryError>> {
    this.#attempts.delete(requestId);
    return ok(undefined);
  }

  public async prune(
    policy: PromptAttemptRetentionPolicy,
  ): Promise<Result<number, RepositoryError>> {
    if (!Number.isInteger(policy.maxTerminalAttempts) || policy.maxTerminalAttempts < 0) {
      return err(
        new RepositoryError("validation", "Attempt retention must be a non-negative integer."),
      );
    }

    const terminal = [...this.#attempts.values()]
      .filter(isTerminalPromptDeliveryAttempt)
      .sort(compareAttempts);
    const removeCount = Math.max(0, terminal.length - policy.maxTerminalAttempts);
    for (const attempt of terminal.slice(0, removeCount)) {
      this.#attempts.delete(attempt.requestId);
    }
    return ok(removeCount);
  }

  public flush(): Promise<void> {
    return Promise.resolve();
  }
}

export const comparePromptAttempts = compareAttempts;
