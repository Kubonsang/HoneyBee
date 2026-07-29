import {
  AgentSessionSchema,
  SessionDraftSchema,
  err,
  ok,
  validateSessionReferences,
  type AgentSession,
  type Result,
  type SessionDraft,
  type SessionId,
} from "@honeybee/domain";

import { RepositoryError } from "./errors.js";
import type { DraftRepository, SessionQuery, SessionRepository } from "./ports.js";

const cloneSession = (session: AgentSession): AgentSession => AgentSessionSchema.parse(session);
const cloneDraft = (draft: SessionDraft): SessionDraft => SessionDraftSchema.parse(draft);

const validationError = (
  message: string,
  details: Readonly<Record<string, unknown>>,
): RepositoryError => new RepositoryError("validation", message, { details });

export class InMemorySessionRepository implements SessionRepository {
  readonly #sessions = new Map<SessionId, AgentSession>();

  public constructor(initialSessions: readonly AgentSession[] = []) {
    for (const session of initialSessions) {
      const parsed = AgentSessionSchema.parse(session);
      this.#sessions.set(parsed.id, parsed);
    }
  }

  public async getById(id: SessionId): Promise<Result<AgentSession, RepositoryError>> {
    const session = this.#sessions.get(id);
    return session === undefined
      ? err(new RepositoryError("not-found", `Session "${id}" was not found.`))
      : ok(cloneSession(session));
  }

  public async list(
    query: SessionQuery = {},
  ): Promise<Result<readonly AgentSession[], RepositoryError>> {
    const normalizedTag = query.tag?.trim().toLocaleLowerCase();
    const sessions = [...this.#sessions.values()]
      .filter((session) => query.status === undefined || session.status === query.status)
      .filter((session) => {
        if (query.parentSessionId === undefined) {
          return true;
        }
        return query.parentSessionId === null
          ? session.parentSessionId === undefined
          : session.parentSessionId === query.parentSessionId;
      })
      .filter(
        (session) =>
          normalizedTag === undefined ||
          session.tags.some((tag) => tag.toLocaleLowerCase() === normalizedTag),
      )
      .sort((left, right) => {
        const createdAtComparison = left.createdAt.localeCompare(right.createdAt);
        return createdAtComparison === 0 ? left.id.localeCompare(right.id) : createdAtComparison;
      })
      .map(cloneSession);

    return ok(sessions);
  }

  public async save(session: AgentSession): Promise<Result<AgentSession, RepositoryError>> {
    const parsed = AgentSessionSchema.safeParse(session);
    if (!parsed.success) {
      return err(
        validationError("The session does not satisfy its schema.", {
          issues: parsed.error.issues,
        }),
      );
    }

    const references = validateSessionReferences(parsed.data, [...this.#sessions.values()]);
    if (!references.ok) {
      return err(
        validationError(references.error.message, {
          code: references.error.code,
          details: references.error.details,
        }),
      );
    }

    const stored = cloneSession(parsed.data);
    this.#sessions.set(stored.id, stored);
    return ok(cloneSession(stored));
  }

  public async delete(id: SessionId): Promise<Result<void, RepositoryError>> {
    if (!this.#sessions.has(id)) {
      return err(new RepositoryError("not-found", `Session "${id}" was not found.`));
    }

    const dependent = [...this.#sessions.values()].find(
      (session) =>
        session.id !== id &&
        (session.parentSessionId === id || session.relatedSessionIds.includes(id)),
    );
    if (dependent !== undefined) {
      return err(
        new RepositoryError(
          "conflict",
          `Session "${id}" is still referenced by session "${dependent.id}".`,
          { details: { dependentSessionId: dependent.id } },
        ),
      );
    }

    this.#sessions.delete(id);
    return ok(undefined);
  }
}

export class InMemoryDraftRepository implements DraftRepository {
  readonly #drafts = new Map<SessionId, SessionDraft>();

  public constructor(initialDrafts: readonly SessionDraft[] = []) {
    for (const draft of initialDrafts) {
      const parsed = SessionDraftSchema.parse(draft);
      this.#drafts.set(parsed.sessionId, parsed);
    }
  }

  public async getBySessionId(
    sessionId: SessionId,
  ): Promise<Result<SessionDraft | undefined, RepositoryError>> {
    const draft = this.#drafts.get(sessionId);
    return ok(draft === undefined ? undefined : cloneDraft(draft));
  }

  public async list(): Promise<Result<readonly SessionDraft[], RepositoryError>> {
    return ok(
      [...this.#drafts.values()]
        .sort((left, right) => left.sessionId.localeCompare(right.sessionId))
        .map(cloneDraft),
    );
  }

  public async save(draft: SessionDraft): Promise<Result<SessionDraft, RepositoryError>> {
    const parsed = SessionDraftSchema.safeParse(draft);
    if (!parsed.success) {
      return err(
        validationError("The draft does not satisfy its schema.", {
          issues: parsed.error.issues,
        }),
      );
    }

    const stored = cloneDraft(parsed.data);
    this.#drafts.set(stored.sessionId, stored);
    return ok(cloneDraft(stored));
  }

  public async delete(sessionId: SessionId): Promise<Result<void, RepositoryError>> {
    this.#drafts.delete(sessionId);
    return ok(undefined);
  }
}
