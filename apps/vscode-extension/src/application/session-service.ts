import {
  AgentProfileIdSchema,
  AgentSessionSchema,
  SessionIdSchema,
  ToolProfileIdSchema,
  WorkspaceIdSchema,
  createSessionTag,
  deleteSessionTag,
  updateSessionTag,
  type AgentSession,
  type SessionId,
} from "@honeybee/domain";
import type { DraftRepository, SessionRepository } from "@honeybee/persistence";

import { ApplicationError } from "./errors.js";
import type { ClockPort, IdGeneratorPort } from "./ports.js";

export interface CreateSessionInput {
  readonly title: string;
  readonly agentProfileId: string;
  readonly toolProfileId?: string;
  readonly workspaceId?: string;
  readonly parentSessionId?: SessionId;
  readonly tags?: readonly string[];
}

const applicationError = (
  code: string,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): ApplicationError => new ApplicationError(code, message, details);

export class SessionApplicationService {
  public constructor(
    private readonly sessions: SessionRepository,
    private readonly drafts: DraftRepository,
    private readonly clock: ClockPort,
    private readonly ids: IdGeneratorPort,
  ) {}

  public async list(): Promise<readonly AgentSession[]> {
    const result = await this.sessions.list();
    if (!result.ok) {
      throw applicationError(result.error.code, result.error.message, result.error.details);
    }
    return result.value;
  }

  public async get(sessionId: SessionId): Promise<AgentSession> {
    const result = await this.sessions.getById(sessionId);
    if (!result.ok) {
      throw applicationError(result.error.code, result.error.message, result.error.details);
    }
    return result.value;
  }

  public async create(input: CreateSessionInput): Promise<AgentSession> {
    const now = this.clock.now();
    const parsed = AgentSessionSchema.safeParse({
      id: this.ids.sessionId(),
      title: input.title,
      agentProfileId: AgentProfileIdSchema.parse(input.agentProfileId),
      ...(input.toolProfileId === undefined
        ? {}
        : { toolProfileId: ToolProfileIdSchema.parse(input.toolProfileId) }),
      ...(input.workspaceId === undefined
        ? {}
        : { workspaceId: WorkspaceIdSchema.parse(input.workspaceId) }),
      tags: input.tags ?? [],
      ...(input.parentSessionId === undefined ? {} : { parentSessionId: input.parentSessionId }),
      relatedSessionIds: [],
      status: "idle",
      createdAt: now,
      updatedAt: now,
    });
    if (!parsed.success) {
      throw applicationError("validation", "The new session is invalid.", {
        issues: parsed.error.issues,
      });
    }
    return this.save(parsed.data);
  }

  public async rename(sessionId: SessionId, title: string): Promise<AgentSession> {
    return this.update(sessionId, (session) => ({ ...session, title }));
  }

  public async delete(sessionId: SessionId): Promise<void> {
    const all = await this.list();
    for (const session of all) {
      if (
        session.id === sessionId ||
        (session.parentSessionId !== sessionId && !session.relatedSessionIds.includes(sessionId))
      ) {
        continue;
      }
      const { parentSessionId: _parentSessionId, ...withoutParent } = session;
      const detached = {
        ...withoutParent,
        ...(session.parentSessionId === sessionId
          ? {}
          : { parentSessionId: session.parentSessionId }),
        relatedSessionIds: session.relatedSessionIds.filter((id) => id !== sessionId),
        updatedAt: this.clock.now(),
      };
      await this.save(AgentSessionSchema.parse(detached));
    }

    const result = await this.sessions.delete(sessionId);
    if (!result.ok) {
      throw applicationError(result.error.code, result.error.message, result.error.details);
    }
    const draftResult = await this.drafts.delete(sessionId);
    if (!draftResult.ok) {
      throw applicationError(
        draftResult.error.code,
        draftResult.error.message,
        draftResult.error.details,
      );
    }
  }

  public async setParent(
    sessionId: SessionId,
    parentSessionId: SessionId | undefined,
  ): Promise<AgentSession> {
    return this.update(sessionId, (session) => {
      const { parentSessionId: _currentParentSessionId, ...withoutParent } = session;
      return {
        ...withoutParent,
        ...(parentSessionId === undefined ? {} : { parentSessionId }),
      };
    });
  }

  public async toggleRelated(sessionId: SessionId, relatedSessionId: SessionId): Promise<void> {
    if (sessionId === relatedSessionId) {
      throw applicationError("self-reference", "A session cannot be related to itself.");
    }
    const session = await this.get(sessionId);
    const related = await this.get(relatedSessionId);
    const shouldRemove = session.relatedSessionIds.includes(relatedSessionId);
    const nextSessionIds = shouldRemove
      ? session.relatedSessionIds.filter((id) => id !== relatedSessionId)
      : [...session.relatedSessionIds, relatedSessionId];
    const nextRelatedIds = shouldRemove
      ? related.relatedSessionIds.filter((id) => id !== sessionId)
      : [...related.relatedSessionIds, sessionId];

    await this.save(
      AgentSessionSchema.parse({
        ...session,
        relatedSessionIds: nextSessionIds,
        updatedAt: this.clock.now(),
      }),
    );
    await this.save(
      AgentSessionSchema.parse({
        ...related,
        relatedSessionIds: nextRelatedIds,
        updatedAt: this.clock.now(),
      }),
    );
  }

  public async addTag(sessionId: SessionId, tag: string): Promise<AgentSession> {
    const session = await this.get(sessionId);
    const result = createSessionTag(session, tag);
    if (!result.ok) {
      throw applicationError(result.error.code, result.error.message, result.error.details);
    }
    return this.save({ ...result.value, updatedAt: this.clock.now() });
  }

  public async renameTag(
    sessionId: SessionId,
    currentTag: string,
    replacementTag: string,
  ): Promise<AgentSession> {
    const session = await this.get(sessionId);
    const result = updateSessionTag(session, currentTag, replacementTag);
    if (!result.ok) {
      throw applicationError(result.error.code, result.error.message, result.error.details);
    }
    return this.save({ ...result.value, updatedAt: this.clock.now() });
  }

  public async deleteTag(sessionId: SessionId, tag: string): Promise<AgentSession> {
    const session = await this.get(sessionId);
    const result = deleteSessionTag(session, tag);
    if (!result.ok) {
      throw applicationError(result.error.code, result.error.message, result.error.details);
    }
    return this.save({ ...result.value, updatedAt: this.clock.now() });
  }

  public parseSessionId(value: string): SessionId {
    const parsed = SessionIdSchema.safeParse(value);
    if (!parsed.success) {
      throw applicationError("validation", "The session ID is invalid.");
    }
    return parsed.data;
  }

  private async update(
    sessionId: SessionId,
    transform: (session: AgentSession) => AgentSession,
  ): Promise<AgentSession> {
    const current = await this.get(sessionId);
    const parsed = AgentSessionSchema.safeParse({
      ...transform(current),
      updatedAt: this.clock.now(),
    });
    if (!parsed.success) {
      throw applicationError("validation", "The session update is invalid.", {
        issues: parsed.error.issues,
      });
    }
    return this.save(parsed.data);
  }

  private async save(session: AgentSession): Promise<AgentSession> {
    const result = await this.sessions.save(session);
    if (!result.ok) {
      throw applicationError(result.error.code, result.error.message, result.error.details);
    }
    return result.value;
  }
}
