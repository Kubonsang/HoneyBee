import { z } from "zod";

import { DomainError } from "./errors.js";
import {
  AgentProfileIdSchema,
  SessionIdSchema,
  ToolProfileIdSchema,
  WorkspaceIdSchema,
  type SessionId,
} from "./ids.js";
import { err, ok, type Result } from "./result.js";

export const IsoDateTimeSchema = z.string().datetime({ offset: true });

export const SessionStatusSchema = z.enum([
  "idle",
  "starting",
  "running",
  "waiting_for_input",
  "stopped",
  "failed",
  "completed",
]);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

export const SessionTagSchema = z.string().trim().min(1).max(64);
export type SessionTag = z.infer<typeof SessionTagSchema>;

export const AgentSessionSchema = z
  .object({
    id: SessionIdSchema,
    title: z.string().trim().min(1).max(256),
    agentProfileId: AgentProfileIdSchema,
    toolProfileId: ToolProfileIdSchema.optional(),
    workspaceId: WorkspaceIdSchema.optional(),
    tags: z.array(SessionTagSchema).max(64),
    parentSessionId: SessionIdSchema.optional(),
    relatedSessionIds: z.array(SessionIdSchema).max(256),
    status: SessionStatusSchema,
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict()
  .superRefine((session, context) => {
    if (session.parentSessionId === session.id) {
      context.addIssue({
        code: "custom",
        message: "A session cannot be its own parent.",
        path: ["parentSessionId"],
      });
    }

    const normalizedTags = new Set<string>();
    session.tags.forEach((tag, index) => {
      const normalized = tag.toLocaleLowerCase();
      if (normalizedTags.has(normalized)) {
        context.addIssue({
          code: "custom",
          message: "Session tags must be unique (case-insensitive).",
          path: ["tags", index],
        });
      }
      normalizedTags.add(normalized);
    });

    const relatedIds = new Set<SessionId>();
    session.relatedSessionIds.forEach((relatedSessionId, index) => {
      if (relatedSessionId === session.id) {
        context.addIssue({
          code: "custom",
          message: "A session cannot relate to itself.",
          path: ["relatedSessionIds", index],
        });
      }
      if (relatedIds.has(relatedSessionId)) {
        context.addIssue({
          code: "custom",
          message: "Related session IDs must be unique.",
          path: ["relatedSessionIds", index],
        });
      }
      relatedIds.add(relatedSessionId);
    });
  });

export type AgentSession = z.infer<typeof AgentSessionSchema>;

export const SessionDraftSchema = z
  .object({
    sessionId: SessionIdSchema,
    content: z.string(),
    updatedAt: IsoDateTimeSchema,
  })
  .strict();
export type SessionDraft = z.infer<typeof SessionDraftSchema>;

const normalizedTag = (tag: string): Result<SessionTag, DomainError> => {
  const parsed = SessionTagSchema.safeParse(tag);
  return parsed.success
    ? ok(parsed.data)
    : err(new DomainError("invalid-tag", "A tag must contain between 1 and 64 characters."));
};

export const createSessionTag = (
  session: AgentSession,
  tag: string,
): Result<AgentSession, DomainError> => {
  const parsedTag = normalizedTag(tag);
  if (!parsedTag.ok) {
    return parsedTag;
  }

  if (
    session.tags.some(
      (current) => current.toLocaleLowerCase() === parsedTag.value.toLocaleLowerCase(),
    )
  ) {
    return err(new DomainError("duplicate-tag", `The tag "${parsedTag.value}" already exists.`));
  }

  return ok({ ...session, tags: [...session.tags, parsedTag.value] });
};

export const readSessionTags = (session: AgentSession): readonly SessionTag[] => [...session.tags];

export const updateSessionTag = (
  session: AgentSession,
  currentTag: string,
  replacementTag: string,
): Result<AgentSession, DomainError> => {
  const parsedReplacement = normalizedTag(replacementTag);
  if (!parsedReplacement.ok) {
    return parsedReplacement;
  }

  const currentIndex = session.tags.findIndex(
    (tag) => tag.toLocaleLowerCase() === currentTag.trim().toLocaleLowerCase(),
  );
  if (currentIndex < 0) {
    return err(new DomainError("tag-not-found", `The tag "${currentTag}" does not exist.`));
  }

  const hasDuplicate = session.tags.some(
    (tag, index) =>
      index !== currentIndex &&
      tag.toLocaleLowerCase() === parsedReplacement.value.toLocaleLowerCase(),
  );
  if (hasDuplicate) {
    return err(
      new DomainError("duplicate-tag", `The tag "${parsedReplacement.value}" already exists.`),
    );
  }

  return ok({
    ...session,
    tags: session.tags.map((tag, index) =>
      index === currentIndex ? parsedReplacement.value : tag,
    ),
  });
};

export const deleteSessionTag = (
  session: AgentSession,
  tagToDelete: string,
): Result<AgentSession, DomainError> => {
  const normalizedTagToDelete = tagToDelete.trim().toLocaleLowerCase();
  const index = session.tags.findIndex((tag) => tag.toLocaleLowerCase() === normalizedTagToDelete);
  if (index < 0) {
    return err(new DomainError("tag-not-found", `The tag "${tagToDelete}" does not exist.`));
  }

  return ok({
    ...session,
    tags: session.tags.filter((_, tagIndex) => tagIndex !== index),
  });
};

export const addSessionTag = createSessionTag;
export const renameSessionTag = updateSessionTag;
export const removeSessionTag = deleteSessionTag;

export const validateSessionReferences = (
  candidate: AgentSession,
  sessions: readonly AgentSession[],
): Result<void, DomainError> => {
  if (
    candidate.parentSessionId === candidate.id ||
    candidate.relatedSessionIds.includes(candidate.id)
  ) {
    return err(new DomainError("self-reference", "A session cannot reference itself."));
  }

  if (new Set(candidate.relatedSessionIds).size !== candidate.relatedSessionIds.length) {
    return err(new DomainError("duplicate-relationship", "Related session IDs must be unique."));
  }

  const parsedCandidate = AgentSessionSchema.safeParse(candidate);
  if (!parsedCandidate.success) {
    return err(
      new DomainError("invalid-session", "The session does not satisfy its schema.", {
        issues: parsedCandidate.error.issues,
      }),
    );
  }

  const sessionsById = new Map<SessionId, AgentSession>(
    sessions.map((session) => [session.id, session]),
  );
  sessionsById.set(candidate.id, candidate);

  if (candidate.parentSessionId !== undefined) {
    const parent = sessionsById.get(candidate.parentSessionId);
    if (parent === undefined) {
      return err(
        new DomainError(
          "reference-not-found",
          `Parent session "${candidate.parentSessionId}" was not found.`,
        ),
      );
    }

    const visited = new Set<SessionId>([candidate.id]);
    let current: AgentSession | undefined = parent;
    while (current !== undefined) {
      if (visited.has(current.id)) {
        return err(new DomainError("parent-cycle", "The parent relationship creates a cycle."));
      }
      visited.add(current.id);
      current =
        current.parentSessionId === undefined
          ? undefined
          : sessionsById.get(current.parentSessionId);
    }
  }

  for (const relatedSessionId of candidate.relatedSessionIds) {
    if (!sessionsById.has(relatedSessionId)) {
      return err(
        new DomainError(
          "reference-not-found",
          `Related session "${relatedSessionId}" was not found.`,
        ),
      );
    }
  }

  return ok(undefined);
};
