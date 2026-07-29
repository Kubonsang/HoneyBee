import { describe, expect, it } from "vitest";

import {
  AgentSessionSchema,
  SessionIdSchema,
  createSessionTag,
  deleteSessionTag,
  readSessionTags,
  updateSessionTag,
  validateSessionReferences,
  type AgentSession,
} from "./index.js";

const session = (overrides: Partial<AgentSession> = {}): AgentSession =>
  AgentSessionSchema.parse({
    id: "session-1",
    title: "Investigate failing tests",
    agentProfileId: "codex",
    tags: [],
    relatedSessionIds: [],
    status: "idle",
    createdAt: "2026-07-29T12:00:00.000Z",
    updatedAt: "2026-07-29T12:00:00.000Z",
    ...overrides,
  });

describe("AgentSessionSchema", () => {
  it("parses the exact required session metadata", () => {
    expect(session()).toEqual({
      id: "session-1",
      title: "Investigate failing tests",
      agentProfileId: "codex",
      tags: [],
      relatedSessionIds: [],
      status: "idle",
      createdAt: "2026-07-29T12:00:00.000Z",
      updatedAt: "2026-07-29T12:00:00.000Z",
    });
  });

  it("requires agentProfileId, tags, relatedSessionIds, and status", () => {
    const parsed = AgentSessionSchema.safeParse({
      id: "session-1",
      title: "Missing required fields",
      createdAt: "2026-07-29T12:00:00.000Z",
      updatedAt: "2026-07-29T12:00:00.000Z",
    });

    expect(parsed.success).toBe(false);
  });

  it("rejects a self parent, self relation, and duplicate related IDs", () => {
    const parsed = AgentSessionSchema.safeParse({
      ...session(),
      parentSessionId: "session-1",
      relatedSessionIds: ["session-1", "session-2", "session-2"],
    });

    expect(parsed.success).toBe(false);
  });

  it("accepts every defined status and rejects old status values", () => {
    const statuses = [
      "idle",
      "starting",
      "running",
      "waiting_for_input",
      "stopped",
      "failed",
      "completed",
    ] as const;

    expect(
      statuses.every((status) => AgentSessionSchema.safeParse(session({ status })).success),
    ).toBe(true);
    expect(AgentSessionSchema.safeParse({ ...session(), status: "active" }).success).toBe(false);
  });
});

describe("session tag CRUD", () => {
  it("creates, reads, updates, and deletes tags without mutating the session", () => {
    const original = session();
    const created = createSessionTag(original, " unity ");
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }

    expect(original.tags).toEqual([]);
    expect(readSessionTags(created.value)).toEqual(["unity"]);

    const updated = updateSessionTag(created.value, "UNITY", "tests");
    expect(updated.ok).toBe(true);
    if (!updated.ok) {
      return;
    }
    expect(readSessionTags(updated.value)).toEqual(["tests"]);

    const deleted = deleteSessionTag(updated.value, "Tests");
    expect(deleted.ok).toBe(true);
    if (!deleted.ok) {
      return;
    }
    expect(readSessionTags(deleted.value)).toEqual([]);
  });

  it("returns typed errors for duplicate and missing tags", () => {
    const tagged = session({ tags: ["unity"] });

    const duplicate = createSessionTag(tagged, "UNITY");
    const missing = deleteSessionTag(tagged, "tests");

    expect(duplicate.ok ? undefined : duplicate.error.code).toBe("duplicate-tag");
    expect(missing.ok ? undefined : missing.error.code).toBe("tag-not-found");
  });
});

describe("validateSessionReferences", () => {
  it("accepts existing parent and related sessions", () => {
    const parent = session();
    const related = session({ id: SessionIdSchema.parse("session-3") });
    const child = session({
      id: SessionIdSchema.parse("session-2"),
      parentSessionId: parent.id,
      relatedSessionIds: [related.id],
    });

    expect(validateSessionReferences(child, [parent, child, related]).ok).toBe(true);
  });

  it("rejects missing parent and related references", () => {
    const missingParent = session({
      id: SessionIdSchema.parse("session-2"),
      parentSessionId: SessionIdSchema.parse("missing"),
    });
    const missingRelated = session({
      relatedSessionIds: [SessionIdSchema.parse("missing")],
    });

    const parentResult = validateSessionReferences(missingParent, [missingParent]);
    const relatedResult = validateSessionReferences(missingRelated, [missingRelated]);

    expect(parentResult.ok ? undefined : parentResult.error.code).toBe("reference-not-found");
    expect(relatedResult.ok ? undefined : relatedResult.error.code).toBe("reference-not-found");
  });

  it("rejects self references and parent cycles", () => {
    const selfRelated = {
      ...session(),
      relatedSessionIds: [SessionIdSchema.parse("session-1")],
    } as AgentSession;
    const first = session({
      parentSessionId: SessionIdSchema.parse("session-2"),
    });
    const second = session({
      id: SessionIdSchema.parse("session-2"),
      parentSessionId: first.id,
    });

    const selfResult = validateSessionReferences(selfRelated, [selfRelated]);
    const cycleResult = validateSessionReferences(first, [first, second]);

    expect(selfResult.ok ? undefined : selfResult.error.code).toBe("self-reference");
    expect(cycleResult.ok ? undefined : cycleResult.error.code).toBe("parent-cycle");
  });
});
