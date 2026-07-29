import {
  AgentSessionSchema,
  SessionDraftSchema,
  SessionIdSchema,
  type AgentSession,
} from "@honeybee/domain";
import { describe, expect, it } from "vitest";

import { InMemoryDraftRepository, InMemorySessionRepository } from "./index.js";

const session = (overrides: Partial<AgentSession> = {}): AgentSession =>
  AgentSessionSchema.parse({
    id: "session-1",
    title: "Persist this session",
    agentProfileId: "codex",
    tags: [],
    relatedSessionIds: [],
    status: "idle",
    createdAt: "2026-07-29T12:00:00.000Z",
    updatedAt: "2026-07-29T12:00:00.000Z",
    ...overrides,
  });

describe("InMemorySessionRepository", () => {
  it("saves and returns defensive session copies", async () => {
    const repository = new InMemorySessionRepository();
    const original = session({ tags: ["unity"] });

    const saved = await repository.save(original);
    expect(saved.ok).toBe(true);
    if (!saved.ok) {
      return;
    }
    saved.value.tags.push("mutated");

    const loaded = await repository.getById(original.id);
    expect(loaded.ok).toBe(true);
    expect(loaded.ok ? loaded.value.tags : []).toEqual(["unity"]);
  });

  it("filters sessions by parent, status, and tag", async () => {
    const parent = session({ tags: ["Unity"], status: "running" });
    const child = session({
      id: SessionIdSchema.parse("session-2"),
      parentSessionId: parent.id,
      tags: ["Tests"],
      status: "waiting_for_input",
    });
    const repository = new InMemorySessionRepository([parent]);
    await repository.save(child);

    const roots = await repository.list({ parentSessionId: null });
    const tagged = await repository.list({ tag: "tests", status: "waiting_for_input" });

    expect(roots.ok ? roots.value.map(({ id }) => id) : []).toEqual(["session-1"]);
    expect(tagged.ok ? tagged.value.map(({ id }) => id) : []).toEqual(["session-2"]);
  });

  it("rejects missing parents and deletion of referenced sessions", async () => {
    const parent = session();
    const child = session({
      id: SessionIdSchema.parse("session-2"),
      parentSessionId: parent.id,
    });
    const missingParent = session({
      id: SessionIdSchema.parse("session-3"),
      parentSessionId: SessionIdSchema.parse("missing"),
    });
    const repository = new InMemorySessionRepository([parent]);

    await repository.save(child);
    const invalidSave = await repository.save(missingParent);
    const conflictedDelete = await repository.delete(parent.id);

    expect(invalidSave.ok ? undefined : invalidSave.error.code).toBe("validation");
    expect(conflictedDelete.ok ? undefined : conflictedDelete.error.code).toBe("conflict");
  });

  it("validates related session IDs before saving", async () => {
    const repository = new InMemorySessionRepository();
    const candidate = session({ relatedSessionIds: [SessionIdSchema.parse("missing")] });

    const result = await repository.save(candidate);

    expect(result.ok ? undefined : result.error.code).toBe("validation");
  });

  it("returns a typed not-found error", async () => {
    const repository = new InMemorySessionRepository();

    const result = await repository.getById(SessionIdSchema.parse("missing"));

    expect(result.ok ? undefined : result.error.code).toBe("not-found");
  });
});

describe("InMemoryDraftRepository", () => {
  it("upserts, restores, lists, and deletes session drafts", async () => {
    const repository = new InMemoryDraftRepository();
    const draft = SessionDraftSchema.parse({
      sessionId: "session-1",
      content: "Unsent input",
      updatedAt: "2026-07-29T12:00:00.000Z",
    });

    await repository.save(draft);
    const restored = await repository.getBySessionId(draft.sessionId);
    const listed = await repository.list();
    await repository.delete(draft.sessionId);
    const deleted = await repository.getBySessionId(draft.sessionId);

    expect(restored.ok ? restored.value : undefined).toEqual(draft);
    expect(listed.ok ? listed.value : []).toEqual([draft]);
    expect(deleted.ok ? deleted.value : draft).toBeUndefined();
  });
});
