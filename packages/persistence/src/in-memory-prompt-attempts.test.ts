import {
  PromptDeliveryAttemptSchema,
  SessionIdSchema,
  transitionPromptDeliveryAttempt,
  type PromptDeliveryAttempt,
} from "@honeybee/domain";
import { describe, expect, it } from "vitest";

import { InMemoryPromptDeliveryAttemptRepository } from "./in-memory-prompt-attempts.js";

const prepared = (
  requestId: string,
  overrides: Partial<PromptDeliveryAttempt> = {},
): PromptDeliveryAttempt =>
  PromptDeliveryAttemptSchema.parse({
    requestId,
    sessionId: "session-1",
    contentDigest: `sha256:${requestId.padEnd(64, "a")}`,
    contentLength: requestId.length,
    phase: "prepared",
    preparedAt: "2026-07-30T10:00:00.000Z",
    updatedAt: "2026-07-30T10:00:00.000Z",
    schemaVersion: 1,
    ...overrides,
  });

const moved = (
  attempt: PromptDeliveryAttempt,
  transition: Parameters<typeof transitionPromptDeliveryAttempt>[1],
): PromptDeliveryAttempt => {
  const result = transitionPromptDeliveryAttempt(attempt, transition);
  if (!result.ok) throw result.error;
  return result.value;
};

describe("InMemoryPromptDeliveryAttemptRepository", () => {
  it("saves, gets, lists by Session, transitions, and deletes", async () => {
    const repository = new InMemoryPromptDeliveryAttemptRepository();
    const first = prepared("a");
    const dispatching = moved(first, {
      phase: "dispatching",
      updatedAt: "2026-07-30T10:01:00.000Z",
    });

    await repository.save(first);
    await repository.save(dispatching);
    const found = await repository.getByRequestId("a");
    const listed = await repository.listBySessionId(SessionIdSchema.parse("session-1"));
    await repository.delete("a");
    const deleted = await repository.getByRequestId("a");

    expect(found.ok ? found.value?.phase : undefined).toBe("dispatching");
    expect(listed.ok ? listed.value : []).toHaveLength(1);
    expect(deleted.ok ? deleted.value : first).toBeUndefined();
  });

  it("rejects identity mutation and reverse transitions", async () => {
    const first = prepared("a");
    const dispatching = moved(first, {
      phase: "dispatching",
      updatedAt: "2026-07-30T10:01:00.000Z",
    });
    const repository = new InMemoryPromptDeliveryAttemptRepository([dispatching]);

    const identity = await repository.save({ ...dispatching, contentLength: 99 });
    const reverse = await repository.save(first);

    expect(identity.ok ? undefined : identity.error.code).toBe("conflict");
    expect(reverse.ok ? undefined : reverse.error.code).toBe("conflict");
  });

  it("prunes only oldest terminal Attempts", async () => {
    const terminalA = moved(prepared("a"), {
      phase: "cancelled-before-dispatch",
      updatedAt: "2026-07-30T10:01:00.000Z",
      resolvedAt: "2026-07-30T10:01:00.000Z",
    });
    const terminalB = moved(
      prepared("b", {
        preparedAt: "2026-07-30T11:00:00.000Z",
        updatedAt: "2026-07-30T11:00:00.000Z",
      }),
      {
        phase: "cancelled-before-dispatch",
        updatedAt: "2026-07-30T11:01:00.000Z",
        resolvedAt: "2026-07-30T11:01:00.000Z",
      },
    );
    const active = moved(
      prepared("c", {
        preparedAt: "2026-07-30T12:00:00.000Z",
        updatedAt: "2026-07-30T12:00:00.000Z",
      }),
      {
        phase: "dispatching",
        updatedAt: "2026-07-30T12:01:00.000Z",
      },
    );
    const repository = new InMemoryPromptDeliveryAttemptRepository([terminalA, terminalB, active]);

    const pruned = await repository.prune({ maxTerminalAttempts: 1 });
    const listed = await repository.list();

    expect(pruned.ok ? pruned.value : undefined).toBe(1);
    expect(listed.ok ? listed.value.map(({ requestId }) => requestId) : []).toEqual(["b", "c"]);
  });
});
