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
import {
  RepositoryError,
  type PromptAttemptRetentionPolicy,
  type PromptDeliveryAttemptRepository,
} from "@honeybee/persistence";

import type { MementoPort } from "./global-state-repositories.js";

export const PROMPT_DELIVERY_ATTEMPT_STORAGE_KEY = "honeyBee.promptDeliveryAttempts.v1";

const readAttempts = (
  memento: MementoPort,
): Result<readonly PromptDeliveryAttempt[], RepositoryError> => {
  const stored = memento.get<unknown>(PROMPT_DELIVERY_ATTEMPT_STORAGE_KEY, []);
  const parsed = PromptDeliveryAttemptSchema.array().safeParse(stored);
  return parsed.success
    ? ok(parsed.data)
    : err(
        new RepositoryError("validation", "Stored Prompt delivery Attempts are invalid.", {
          details: { issues: parsed.error.issues },
        }),
      );
};

const compareAttempts = (left: PromptDeliveryAttempt, right: PromptDeliveryAttempt): number => {
  const preparedAt = left.preparedAt.localeCompare(right.preparedAt);
  return preparedAt === 0 ? left.requestId.localeCompare(right.requestId) : preparedAt;
};

const storageError = (operation: string, cause: unknown): RepositoryError =>
  new RepositoryError("unknown", `Prompt Attempt ${operation} failed.`, { cause });

/** VS Code globalState Attempt storage with instance-serialized mutations. */
export class GlobalStatePromptDeliveryAttemptRepository implements PromptDeliveryAttemptRepository {
  #writeTail: Promise<void> = Promise.resolve();

  public constructor(private readonly memento: MementoPort) {}

  public async getByRequestId(
    requestId: string,
  ): Promise<Result<PromptDeliveryAttempt | undefined, RepositoryError>> {
    await this.#writeTail;
    const attempts = readAttempts(this.memento);
    if (!attempts.ok) {
      return attempts;
    }
    const attempt = attempts.value.find((candidate) => candidate.requestId === requestId);
    return ok(attempt === undefined ? undefined : PromptDeliveryAttemptSchema.parse(attempt));
  }

  public async listBySessionId(
    sessionId: SessionId,
  ): Promise<Result<readonly PromptDeliveryAttempt[], RepositoryError>> {
    const attempts = await this.list();
    return attempts.ok
      ? ok(attempts.value.filter((attempt) => attempt.sessionId === sessionId))
      : attempts;
  }

  public async list(): Promise<Result<readonly PromptDeliveryAttempt[], RepositoryError>> {
    await this.#writeTail;
    const attempts = readAttempts(this.memento);
    return attempts.ok
      ? ok(
          [...attempts.value]
            .sort(compareAttempts)
            .map((attempt) => PromptDeliveryAttemptSchema.parse(attempt)),
        )
      : attempts;
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

    return this.enqueue("save", async () => {
      const attempts = readAttempts(this.memento);
      if (!attempts.ok) {
        return attempts;
      }
      const existing = attempts.value.find(
        (candidate) => candidate.requestId === parsed.data.requestId,
      );
      if (existing !== undefined && !isValidPromptDeliveryAttemptSuccessor(existing, parsed.data)) {
        return err(
          new RepositoryError(
            "conflict",
            `Prompt Attempt "${parsed.data.requestId}" has an invalid identity or phase transition.`,
          ),
        );
      }
      const next = attempts.value.filter(
        (candidate) => candidate.requestId !== parsed.data.requestId,
      );
      next.push(parsed.data);
      next.sort(compareAttempts);
      await this.memento.update(PROMPT_DELIVERY_ATTEMPT_STORAGE_KEY, next);
      return ok(PromptDeliveryAttemptSchema.parse(parsed.data));
    });
  }

  public delete(requestId: string): Promise<Result<void, RepositoryError>> {
    return this.enqueue("delete", async () => {
      const attempts = readAttempts(this.memento);
      if (!attempts.ok) {
        return attempts;
      }
      await this.memento.update(
        PROMPT_DELIVERY_ATTEMPT_STORAGE_KEY,
        attempts.value.filter((attempt) => attempt.requestId !== requestId),
      );
      return ok(undefined);
    });
  }

  public prune(policy: PromptAttemptRetentionPolicy): Promise<Result<number, RepositoryError>> {
    if (!Number.isInteger(policy.maxTerminalAttempts) || policy.maxTerminalAttempts < 0) {
      return Promise.resolve(
        err(new RepositoryError("validation", "Attempt retention must be a non-negative integer.")),
      );
    }
    return this.enqueue("prune", async () => {
      const attempts = readAttempts(this.memento);
      if (!attempts.ok) {
        return attempts;
      }
      const terminal = attempts.value.filter(isTerminalPromptDeliveryAttempt).sort(compareAttempts);
      const removeCount = Math.max(0, terminal.length - policy.maxTerminalAttempts);
      const removedIds = new Set(
        terminal.slice(0, removeCount).map((attempt) => attempt.requestId),
      );
      if (removedIds.size > 0) {
        await this.memento.update(
          PROMPT_DELIVERY_ATTEMPT_STORAGE_KEY,
          attempts.value.filter((attempt) => !removedIds.has(attempt.requestId)),
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
