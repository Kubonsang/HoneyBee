import {
  SessionRunRecordSchema,
  transitionSessionRun,
  type SessionRunRecord,
} from "@honeybee/domain";
import { describe, expect, it } from "vitest";

import { InMemorySessionRunRepository } from "./in-memory-session-runs.js";

const starting = (runId: string, overrides: Partial<SessionRunRecord> = {}): SessionRunRecord =>
  SessionRunRecordSchema.parse({
    runId,
    sessionId: "session-1",
    runtimeInstanceId: "runtime-1",
    phase: "starting",
    startedAt: "2026-07-30T10:00:00.000Z",
    updatedAt: "2026-07-30T10:00:00.000Z",
    schemaVersion: 1,
    ...overrides,
  });

const move = (
  run: SessionRunRecord,
  change: Parameters<typeof transitionSessionRun>[1],
): SessionRunRecord => {
  const result = transitionSessionRun(run, change);
  if (!result.ok) throw result.error;
  return result.value;
};

describe("InMemorySessionRunRepository", () => {
  it("round-trips active and terminal Runs", async () => {
    const repository = new InMemorySessionRunRepository();
    const initial = starting("run-1");
    const running = move(initial, {
      phase: "running",
      updatedAt: "2026-07-30T10:01:00.000Z",
    });
    await repository.save(initial);
    await repository.save(running);
    const active = await repository.getActiveBySessionId(initial.sessionId);
    expect(active.ok ? active.value?.runId : undefined).toBe(initial.runId);

    const stopping = move(running, {
      phase: "stopping",
      updatedAt: "2026-07-30T10:01:30.000Z",
    });
    await repository.save(stopping);
    const stopped = move(stopping, {
      phase: "stopped",
      updatedAt: "2026-07-30T10:02:00.000Z",
      endedAt: "2026-07-30T10:02:00.000Z",
      terminationReason: "user-stop",
    });
    await repository.save(stopped);
    const after = await repository.listActive();
    expect(after.ok ? after.value : []).toEqual([]);
  });

  it("rejects two active Runs for one Session and identity reversal", async () => {
    const first = starting("run-1");
    const repository = new InMemorySessionRunRepository([first]);
    const conflict = await repository.save(starting("run-2"));
    const identity = await repository.save({
      ...first,
      runtimeInstanceId: "runtime-2" as SessionRunRecord["runtimeInstanceId"],
    });
    expect(conflict.ok ? undefined : conflict.error.code).toBe("conflict");
    expect(identity.ok ? undefined : identity.error.code).toBe("conflict");
  });

  it("allows a fresh Run after the prior Run is terminal", async () => {
    const first = starting("run-1");
    const failed = move(first, {
      phase: "failed",
      updatedAt: "2026-07-30T10:01:00.000Z",
      endedAt: "2026-07-30T10:01:00.000Z",
      terminationReason: "start-failed",
    });
    const repository = new InMemorySessionRunRepository([failed]);
    const next = await repository.save(
      starting("run-2", { startedAt: "2026-07-30T11:00:00.000Z" }),
    );
    expect(next.ok).toBe(true);
  });

  it("lists only Runs owned by the requested Session", async () => {
    const repository = new InMemorySessionRunRepository([
      starting("run-1"),
      starting("run-2", {
        sessionId: "session-2" as SessionRunRecord["sessionId"],
      }),
    ]);
    const listed = await repository.listBySessionId(starting("run-1").sessionId);
    expect(listed.ok ? listed.value.map(({ runId }) => runId) : []).toEqual(["run-1"]);
  });
});
