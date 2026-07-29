import { describe, expect, it } from "vitest";

import { AgentSessionSchema, SessionIdSchema, type AgentSession } from "@honeybee/domain";

import { buildSessionTree } from "./session-tree-model.js";

const session = (overrides: Partial<AgentSession> = {}): AgentSession =>
  AgentSessionSchema.parse({
    id: "session-1",
    title: "Root",
    agentProfileId: "codex",
    tags: [],
    relatedSessionIds: [],
    status: "idle",
    createdAt: "2026-07-29T12:00:00.000Z",
    updatedAt: "2026-07-29T12:00:00.000Z",
    ...overrides,
  });

describe("buildSessionTree", () => {
  it("builds parent-child hierarchy and preserves orphans as roots", () => {
    const root = session();
    const child = session({
      id: SessionIdSchema.parse("session-2"),
      title: "Child",
      parentSessionId: root.id,
    });
    const orphan = session({
      id: SessionIdSchema.parse("session-3"),
      title: "Orphan",
      parentSessionId: SessionIdSchema.parse("missing"),
    });

    const tree = buildSessionTree([child, orphan, root]);
    expect(tree.map((node) => node.session.title).sort()).toEqual(["Orphan", "Root"]);
    expect(
      tree.find((node) => node.session.id === root.id)?.children.map((node) => node.session.id),
    ).toEqual([child.id]);
  });
});
