import { describe, expect, it } from "vitest";

import { AgentSessionSchema, SessionIdSchema, type SessionId } from "@honeybee/domain";
import { InMemoryDraftRepository, InMemorySessionRepository } from "@honeybee/persistence";

import type { ClockPort, IdGeneratorPort } from "./ports.js";
import { SessionApplicationService } from "./session-service.js";

class FixedClock implements ClockPort {
  public now(): string {
    return "2026-07-29T12:00:00.000Z";
  }
}

class SequenceIds implements IdGeneratorPort {
  #next = 1;

  public sessionId(): SessionId {
    return SessionIdSchema.parse(`session-${this.#next++}`);
  }

  public runId(): string {
    return "run-1";
  }

  public requestId(): string {
    return "request-1";
  }
}

describe("SessionApplicationService", () => {
  it("creates, renames, tags, parents, relates, and deletes sessions", async () => {
    const repository = new InMemorySessionRepository();
    const service = new SessionApplicationService(
      repository,
      new InMemoryDraftRepository(),
      new FixedClock(),
      new SequenceIds(),
    );

    const parent = await service.create({
      title: "Parent",
      agentProfileId: "codex",
      toolProfileId: "default",
    });
    const child = await service.create({
      title: "Child",
      agentProfileId: "codex",
    });
    await service.rename(child.id, "Child renamed");
    await service.addTag(child.id, "unity");
    await service.renameTag(child.id, "UNITY", "tests");
    await service.setParent(child.id, parent.id);
    await service.toggleRelated(parent.id, child.id);

    const updatedChild = await service.get(child.id);
    expect(updatedChild).toMatchObject({
      title: "Child renamed",
      tags: ["tests"],
      parentSessionId: parent.id,
      relatedSessionIds: [parent.id],
    });

    await service.delete(parent.id);
    const detachedChild = await service.get(child.id);
    expect(detachedChild.parentSessionId).toBeUndefined();
    expect(detachedChild.relatedSessionIds).toEqual([]);
  });

  it("rejects a parent cycle through the repository contract", async () => {
    const first = AgentSessionSchema.parse({
      id: "session-1",
      title: "First",
      agentProfileId: "codex",
      tags: [],
      relatedSessionIds: [],
      status: "idle",
      createdAt: "2026-07-29T12:00:00.000Z",
      updatedAt: "2026-07-29T12:00:00.000Z",
    });
    const second = AgentSessionSchema.parse({
      ...first,
      id: "session-2",
      title: "Second",
      parentSessionId: first.id,
    });
    const repository = new InMemorySessionRepository([first, second]);
    const service = new SessionApplicationService(
      repository,
      new InMemoryDraftRepository(),
      new FixedClock(),
      new SequenceIds(),
    );
    await expect(service.setParent(first.id, second.id)).rejects.toMatchObject({
      code: "validation",
    });
  });
});
