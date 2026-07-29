import {
  AgentSessionSchema,
  SessionDraftSchema,
  SessionIdSchema,
  err,
  ok,
  validateSessionReferences,
  type AgentSession,
  type Result,
  type SessionDraft,
  type SessionId,
} from "@honeybee/domain";
import {
  RepositoryError,
  type DraftRepository,
  type SessionQuery,
  type SessionRepository,
} from "@honeybee/persistence";

export interface MementoPort {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): Thenable<void>;
}

const SESSION_STORAGE_KEY = "honeyBee.sessions.v1";
const DRAFT_STORAGE_KEY = "honeyBee.drafts.v1";
const SELECTED_SESSION_STORAGE_KEY = "honeyBee.selectedSessionId.v1";

const validationError = (
  message: string,
  details: Readonly<Record<string, unknown>>,
): RepositoryError => new RepositoryError("validation", message, { details });

const readSessions = (memento: MementoPort): Result<readonly AgentSession[], RepositoryError> => {
  const stored = memento.get<unknown>(SESSION_STORAGE_KEY, []);
  const parsed = AgentSessionSchema.array().safeParse(stored);
  return parsed.success
    ? ok(parsed.data)
    : err(
        validationError("Stored sessions are invalid.", {
          issues: parsed.error.issues,
        }),
      );
};

const readDrafts = (memento: MementoPort): Result<readonly SessionDraft[], RepositoryError> => {
  const stored = memento.get<unknown>(DRAFT_STORAGE_KEY, []);
  const parsed = SessionDraftSchema.array().safeParse(stored);
  return parsed.success
    ? ok(parsed.data)
    : err(
        validationError("Stored session drafts are invalid.", {
          issues: parsed.error.issues,
        }),
      );
};

export class GlobalStateSessionRepository implements SessionRepository {
  public constructor(private readonly memento: MementoPort) {}

  public async getById(id: SessionId): Promise<Result<AgentSession, RepositoryError>> {
    const sessions = readSessions(this.memento);
    if (!sessions.ok) {
      return sessions;
    }
    const session = sessions.value.find((candidate) => candidate.id === id);
    return session === undefined
      ? err(new RepositoryError("not-found", `Session "${id}" was not found.`))
      : ok(AgentSessionSchema.parse(session));
  }

  public async list(
    query: SessionQuery = {},
  ): Promise<Result<readonly AgentSession[], RepositoryError>> {
    const sessions = readSessions(this.memento);
    if (!sessions.ok) {
      return sessions;
    }
    const normalizedTag = query.tag?.trim().toLocaleLowerCase();
    return ok(
      sessions.value
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
          const dateOrder = left.createdAt.localeCompare(right.createdAt);
          return dateOrder === 0 ? left.id.localeCompare(right.id) : dateOrder;
        })
        .map((session) => AgentSessionSchema.parse(session)),
    );
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
    const sessions = readSessions(this.memento);
    if (!sessions.ok) {
      return sessions;
    }
    const references = validateSessionReferences(parsed.data, sessions.value);
    if (!references.ok) {
      return err(
        validationError(references.error.message, {
          code: references.error.code,
          details: references.error.details,
        }),
      );
    }

    const next = sessions.value.filter((candidate) => candidate.id !== parsed.data.id);
    next.push(parsed.data);
    next.sort((left, right) => {
      const dateOrder = left.createdAt.localeCompare(right.createdAt);
      return dateOrder === 0 ? left.id.localeCompare(right.id) : dateOrder;
    });
    await this.memento.update(SESSION_STORAGE_KEY, next);
    return ok(AgentSessionSchema.parse(parsed.data));
  }

  public async delete(id: SessionId): Promise<Result<void, RepositoryError>> {
    const sessions = readSessions(this.memento);
    if (!sessions.ok) {
      return sessions;
    }
    if (!sessions.value.some((session) => session.id === id)) {
      return err(new RepositoryError("not-found", `Session "${id}" was not found.`));
    }
    const dependent = sessions.value.find(
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
    await this.memento.update(
      SESSION_STORAGE_KEY,
      sessions.value.filter((session) => session.id !== id),
    );
    return ok(undefined);
  }
}

export class GlobalStateDraftRepository implements DraftRepository {
  public constructor(private readonly memento: MementoPort) {}

  public async getBySessionId(
    sessionId: SessionId,
  ): Promise<Result<SessionDraft | undefined, RepositoryError>> {
    const drafts = readDrafts(this.memento);
    if (!drafts.ok) {
      return drafts;
    }
    const draft = drafts.value.find((candidate) => candidate.sessionId === sessionId);
    return ok(draft === undefined ? undefined : SessionDraftSchema.parse(draft));
  }

  public async list(): Promise<Result<readonly SessionDraft[], RepositoryError>> {
    const drafts = readDrafts(this.memento);
    return drafts.ok
      ? ok(
          [...drafts.value]
            .sort((left, right) => left.sessionId.localeCompare(right.sessionId))
            .map((draft) => SessionDraftSchema.parse(draft)),
        )
      : drafts;
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
    const drafts = readDrafts(this.memento);
    if (!drafts.ok) {
      return drafts;
    }
    const next = drafts.value.filter((candidate) => candidate.sessionId !== parsed.data.sessionId);
    next.push(parsed.data);
    next.sort((left, right) => left.sessionId.localeCompare(right.sessionId));
    await this.memento.update(DRAFT_STORAGE_KEY, next);
    return ok(SessionDraftSchema.parse(parsed.data));
  }

  public async delete(sessionId: SessionId): Promise<Result<void, RepositoryError>> {
    const drafts = readDrafts(this.memento);
    if (!drafts.ok) {
      return drafts;
    }
    await this.memento.update(
      DRAFT_STORAGE_KEY,
      drafts.value.filter((draft) => draft.sessionId !== sessionId),
    );
    return ok(undefined);
  }
}
export class GlobalStateSelectionRepository {
  public constructor(private readonly memento: MementoPort) {}

  public async restore(sessions: readonly AgentSession[]): Promise<SessionId | undefined> {
    const stored = this.memento.get<unknown>(SELECTED_SESSION_STORAGE_KEY, undefined);
    const parsed = SessionIdSchema.safeParse(stored);
    if (!parsed.success || !sessions.some((session) => session.id === parsed.data)) {
      if (stored !== undefined) {
        await this.memento.update(SELECTED_SESSION_STORAGE_KEY, undefined);
      }
      return undefined;
    }
    return parsed.data;
  }

  public async save(sessionId: SessionId | undefined): Promise<void> {
    await this.memento.update(SELECTED_SESSION_STORAGE_KEY, sessionId);
  }
}
