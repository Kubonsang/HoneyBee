import { describe, expect, it } from "vitest";

import {
  AgentSessionSchema,
  SessionDraftSchema,
  SessionIdSchema,
  type AgentSession,
} from "@honeybee/domain";

import {
  GlobalStateDraftRepository,
  GlobalStateSelectionRepository,
  GlobalStateSessionRepository,
  type MementoPort,
} from "./global-state-repositories.js";

class MemoryMemento implements MementoPort {
  readonly #values = new Map<string, unknown>();

  public get<T>(key: string, defaultValue: T): T {
    return (this.#values.has(key) ? this.#values.get(key) : defaultValue) as T;
  }

  public update(key: string, value: unknown): Thenable<void> {
    this.#values.set(key, structuredClone(value));
    return Promise.resolve();
  }
}

const session = (overrides: Partial<AgentSession> = {}): AgentSession =>
  AgentSessionSchema.parse({
    id: "session-1",
    title: "Session",
    agentProfileId: "codex",
    tags: [],
    relatedSessionIds: [],
    status: "idle",
    createdAt: "2026-07-29T12:00:00.000Z",
    updatedAt: "2026-07-29T12:00:00.000Z",
    ...overrides,
  });

describe("VS Code globalState repositories", () => {
  it("persists and queries sessions across repository instances", async () => {
    const state = new MemoryMemento();
    const first = new GlobalStateSessionRepository(state);
    const second = new GlobalStateSessionRepository(state);
    const saved = await first.save(session({ tags: ["unity"] }));
    expect(saved.ok).toBe(true);

    const listed = await second.list({ tag: "UNITY" });
    expect(listed.ok && listed.value.map((item) => item.id)).toEqual(["session-1"]);
  });

  it("enforces reference integrity on save and delete", async () => {
    const state = new MemoryMemento();
    const repository = new GlobalStateSessionRepository(state);
    const parent = session();
    const child = session({
      id: SessionIdSchema.parse("session-2"),
      parentSessionId: parent.id,
    });
    await repository.save(parent);
    await repository.save(child);

    const blocked = await repository.delete(parent.id);
    expect(blocked.ok ? undefined : blocked.error.code).toBe("conflict");
    const deleted = await repository.delete(child.id);
    expect(deleted.ok).toBe(true);
  });

  it("restores only a valid selected session across extension restarts", async () => {
    const state = new MemoryMemento();
    const first = new GlobalStateSelectionRepository(state);
    const storedSession = session();
    await first.save(storedSession.id);

    const afterRestart = new GlobalStateSelectionRepository(state);
    expect(await afterRestart.restore([storedSession])).toBe(storedSession.id);

    await first.save(SessionIdSchema.parse("missing-session"));
    expect(await afterRestart.restore([storedSession])).toBeUndefined();

    await state.update("honeyBee.selectedSessionId.v1", { invalid: true });
    expect(await afterRestart.restore([storedSession])).toBeUndefined();
  });

  it("stores one independent draft per session", async () => {
    const state = new MemoryMemento();
    const drafts = new GlobalStateDraftRepository(state);
    await drafts.save(
      SessionDraftSchema.parse({
        sessionId: "session-1",
        content: "first",
        updatedAt: "2026-07-29T12:00:00.000Z",
      }),
    );
    await drafts.save(
      SessionDraftSchema.parse({
        sessionId: "session-2",
        content: "second",
        updatedAt: "2026-07-29T12:00:00.000Z",
      }),
    );

    const listed = await drafts.list();
    expect(listed.ok && listed.value.map((draft) => draft.content)).toEqual(["first", "second"]);

    const afterRestart = new GlobalStateDraftRepository(state);
    const restored = await afterRestart.getBySessionId(SessionIdSchema.parse("session-2"));
    expect(restored.ok && restored.value?.content).toBe("second");
  });
});
