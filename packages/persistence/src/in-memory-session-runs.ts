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

import { RepositoryError } from "./errors.js";
import type { SessionRunRepository } from "./ports.js";

const cloneRun = (run: SessionRunRecord): SessionRunRecord => SessionRunRecordSchema.parse(run);

const compareRuns = (left: SessionRunRecord, right: SessionRunRecord): number => {
  const startedAt = left.startedAt.localeCompare(right.startedAt);
  return startedAt === 0 ? left.runId.localeCompare(right.runId) : startedAt;
};

/** In-process Session Run repository used by deterministic tests and lightweight hosts. */
export class InMemorySessionRunRepository implements SessionRunRepository {
  readonly #runs = new Map<RunId, SessionRunRecord>();

  public constructor(initialRuns: readonly SessionRunRecord[] = []) {
    for (const run of initialRuns) {
      const parsed = SessionRunRecordSchema.parse(run);
      this.assertNoActiveConflict(parsed);
      this.#runs.set(parsed.runId, parsed);
    }
  }

  public async getByRunId(
    runId: RunId,
  ): Promise<Result<SessionRunRecord | undefined, RepositoryError>> {
    const run = this.#runs.get(runId);
    return ok(run === undefined ? undefined : cloneRun(run));
  }

  public async listBySessionId(
    sessionId: SessionId,
  ): Promise<Result<readonly SessionRunRecord[], RepositoryError>> {
    return ok(
      [...this.#runs.values()]
        .filter((run) => run.sessionId === sessionId)
        .sort(compareRuns)
        .map(cloneRun),
    );
  }

  public async getActiveBySessionId(
    sessionId: SessionId,
  ): Promise<Result<SessionRunRecord | undefined, RepositoryError>> {
    const run = [...this.#runs.values()].find(
      (candidate) => candidate.sessionId === sessionId && isActiveSessionRun(candidate),
    );
    return ok(run === undefined ? undefined : cloneRun(run));
  }

  public async list(): Promise<Result<readonly SessionRunRecord[], RepositoryError>> {
    return ok([...this.#runs.values()].sort(compareRuns).map(cloneRun));
  }

  public async listActive(): Promise<Result<readonly SessionRunRecord[], RepositoryError>> {
    return ok([...this.#runs.values()].filter(isActiveSessionRun).sort(compareRuns).map(cloneRun));
  }

  public async save(run: SessionRunRecord): Promise<Result<SessionRunRecord, RepositoryError>> {
    const parsed = SessionRunRecordSchema.safeParse(run);
    if (!parsed.success) {
      return err(
        new RepositoryError("validation", "The Session Run does not satisfy its schema.", {
          details: { issues: parsed.error.issues },
        }),
      );
    }
    const existing = this.#runs.get(parsed.data.runId);
    if (existing !== undefined && !isValidSessionRunSuccessor(existing, parsed.data)) {
      return err(
        new RepositoryError(
          "conflict",
          `Session Run "${parsed.data.runId}" has an invalid identity or phase transition.`,
        ),
      );
    }
    const conflicting = [...this.#runs.values()].find(
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
    const stored = cloneRun(parsed.data);
    this.#runs.set(stored.runId, stored);
    return ok(cloneRun(stored));
  }

  public flush(): Promise<void> {
    return Promise.resolve();
  }

  private assertNoActiveConflict(run: SessionRunRecord): void {
    if (
      isActiveSessionRun(run) &&
      [...this.#runs.values()].some(
        (candidate) => candidate.sessionId === run.sessionId && isActiveSessionRun(candidate),
      )
    ) {
      throw new RepositoryError(
        "conflict",
        `Session "${run.sessionId}" has more than one active Run.`,
      );
    }
  }
}

export const compareSessionRuns = compareRuns;
