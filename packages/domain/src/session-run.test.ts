import { describe, expect, it } from "vitest";

import {
  SessionRunRecordSchema,
  isValidSessionRunSuccessor,
  transitionSessionRun,
  type SessionRunRecord,
} from "./index.js";

const starting = (overrides: Partial<SessionRunRecord> = {}): SessionRunRecord =>
  SessionRunRecordSchema.parse({
    runId: "run-1",
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

describe("SessionRunRecord", () => {
  it("accepts strict content-free identity and rejects unknown lifecycle fields", () => {
    const value = starting();
    expect(SessionRunRecordSchema.safeParse(value).success).toBe(true);
    expect(SessionRunRecordSchema.safeParse({ ...value, prompt: "secret" }).success).toBe(false);
    expect(JSON.stringify(value)).not.toContain("secret");
  });

  it("requires terminal timestamp and a phase-compatible reason", () => {
    expect(SessionRunRecordSchema.safeParse({ ...starting(), phase: "interrupted" }).success).toBe(
      false,
    );
    expect(
      SessionRunRecordSchema.safeParse({
        ...starting(),
        phase: "completed",
        endedAt: "2026-07-30T10:01:00.000Z",
        terminationReason: "process-exit-zero",
        exitCode: 0,
      }).success,
    ).toBe(true);
    expect(
      SessionRunRecordSchema.safeParse({
        ...starting(),
        phase: "failed",
        endedAt: "2026-07-30T10:01:00.000Z",
        terminationReason: "process-exit-zero",
        exitCode: 0,
      }).success,
    ).toBe(false);
  });

  it("allows forward transitions and rejects terminal reversal", () => {
    const running = move(starting(), {
      phase: "running",
      updatedAt: "2026-07-30T10:01:00.000Z",
    });
    const completed = move(running, {
      phase: "completed",
      updatedAt: "2026-07-30T10:02:00.000Z",
      endedAt: "2026-07-30T10:02:00.000Z",
      terminationReason: "process-exit-zero",
      exitCode: 0,
    });
    expect(isValidSessionRunSuccessor(running, completed)).toBe(true);
    expect(
      transitionSessionRun(completed, {
        phase: "running",
        updatedAt: "2026-07-30T10:03:00.000Z",
      }).ok,
    ).toBe(false);
  });

  it("rejects run, Session, Runtime and start-time identity mutation", () => {
    const running = move(starting(), {
      phase: "running",
      updatedAt: "2026-07-30T10:01:00.000Z",
    });
    for (const candidate of [
      { ...running, runId: "run-2" as SessionRunRecord["runId"] },
      { ...running, sessionId: "session-2" as SessionRunRecord["sessionId"] },
      {
        ...running,
        runtimeInstanceId: "runtime-2" as SessionRunRecord["runtimeInstanceId"],
      },
      { ...running, startedAt: "2026-07-30T09:00:00.000Z" },
    ]) {
      expect(isValidSessionRunSuccessor(starting(), candidate)).toBe(false);
    }
  });
});
