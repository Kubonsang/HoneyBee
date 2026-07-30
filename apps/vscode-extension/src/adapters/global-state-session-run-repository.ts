import {
  SessionRunRecordSchema,
  err,
  isActiveSessionRun,
  isValidSessionRunSuccessor,
  ok,
  type Result,
  type RunId,
  type SessionId,
  type SessionRunRecord,
} from "@honeybee/domain";
import { RepositoryError, type SessionRunRepository } from "@honeybee/persistence";

import type { MementoPort } from "./global-state-repositories.js";

export const SESSION_RUN_STORAGE_KEY = "honeyBee.sessionRuns.v1";

const readRuns = (memento: MementoPort): Result<readonly SessionRunRecord[], RepositoryError> => {
  const stored = memento.get<unknown>(SESSION_RUN_STORAGE_KEY, []);
  const parsed = SessionRunRecordSchema.array().safeParse(stored);
  if (!parsed.success) {
    return err(
      new RepositoryError("validation", "Stored Session Runs are invalid.", {
        details: { issues: parsed.error.issues },
      }),
    );
  }
  const activeSessionIds = new Set<SessionId>();
  for (const run of parsed.data) {
    if (!isActiveSessionRun(run)) continue;
    if (activeSessionIds.has(run.sessionId)) {
      return err(
        new RepositoryError("validation", "Stored Session Runs contain multiple active Runs.", {
          details: { sessionId: run.sessionId },
        }),
      );
    }
    activeSessionIds.add(run.sessionId);
  }
  return ok(parsed.data);
};

const compareRuns = (left: SessionRunRecord, right: SessionRunRecord): number => {
  const startedAt = left.startedAt.localeCompare(right.startedAt);
  return startedAt === 0 ? left.runId.localeCompare(right.runId) : startedAt;
};

const storageError = (operation: string, cause: unknown): RepositoryError =>
  new RepositoryError("unknown", `Session Run ${operation} failed.`, { cause });

/** VS Code globalState Session Run storage with instance-serialized mutations. */
export class GlobalStateSessionRunRepository implements SessionRunRepository {
  #writeTail: Promise<void> = Promise.resolve();

  public constructor(private readonly memento: MementoPort) {}

  public async getByRunId(
    runId: RunId,
  ): Promise<Result<SessionRunRecord | undefined, RepositoryError>> {
    await this.#writeTail;
    const runs = readRuns(this.memento);
    if (!runs.ok) return runs;
    const run = runs.value.find((candidate) => candidate.runId === runId);
    return ok(run === undefined ? undefined : SessionRunRecordSchema.parse(run));
  }

  public async getActiveBySessionId(
    sessionId: SessionId,
  ): Promise<Result<SessionRunRecord | undefined, RepositoryError>> {
    const runs = await this.listActive();
    if (!runs.ok) return runs;
    return ok(runs.value.find((run) => run.sessionId === sessionId));
  }

  public async list(): Promise<Result<readonly SessionRunRecord[], RepositoryError>> {
    await this.#writeTail;
    const runs = readRuns(this.memento);
    return runs.ok
      ? ok([...runs.value].sort(compareRuns).map((run) => SessionRunRecordSchema.parse(run)))
      : runs;
  }

  public async listActive(): Promise<Result<readonly SessionRunRecord[], RepositoryError>> {
    const runs = await this.list();
    return runs.ok ? ok(runs.value.filter(isActiveSessionRun)) : runs;
  }

  public save(run: SessionRunRecord): Promise<Result<SessionRunRecord, RepositoryError>> {
    const parsed = SessionRunRecordSchema.safeParse(run);
    if (!parsed.success) {
      return Promise.resolve(
        err(
          new RepositoryError("validation", "The Session Run does not satisfy its schema.", {
            details: { issues: parsed.error.issues },
          }),
        ),
      );
    }
    return this.enqueue("save", async () => {
      const runs = readRuns(this.memento);
      if (!runs.ok) return runs;
      const existing = runs.value.find((candidate) => candidate.runId === parsed.data.runId);
      if (existing !== undefined && !isValidSessionRunSuccessor(existing, parsed.data)) {
        return err(
          new RepositoryError(
            "conflict",
            `Session Run "${parsed.data.runId}" has an invalid identity or phase transition.`,
          ),
        );
      }
      const conflicting = runs.value.find(
        (candidate) =>
          candidate.runId !== parsed.data.runId &&
          candidate.sessionId === parsed.data.sessionId &&
          isActiveSessionRun(candidate) &&
          isActiveSessionRun(parsed.data),
      );
      if (conflicting !== undefined) {
        return err(
          new RepositoryError(
            "conflict",
            `Session "${parsed.data.sessionId}" already has active Run "${conflicting.runId}".`,
          ),
        );
      }
      const next = runs.value.filter((candidate) => candidate.runId !== parsed.data.runId);
      next.push(parsed.data);
      next.sort(compareRuns);
      await this.memento.update(SESSION_RUN_STORAGE_KEY, next);
      return ok(SessionRunRecordSchema.parse(parsed.data));
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
