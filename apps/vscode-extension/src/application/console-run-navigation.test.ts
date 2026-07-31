import { SessionRunRecordSchema, type SessionRunRecord } from "@honeybee/domain";
import { describe, expect, it } from "vitest";

import { MAX_CONSOLE_RUN_METADATA, projectConsoleRuns } from "./console-run-navigation.js";
import type { RunOutputSnapshot } from "./run-output-buffer-store.js";

const run = (
  runId: string,
  minute: number,
  phase: "running" | "completed" | "interrupted" = "completed",
): SessionRunRecord =>
  SessionRunRecordSchema.parse({
    runId,
    sessionId: "session-1",
    runtimeInstanceId: "runtime-1",
    phase,
    startedAt: `2026-07-31T10:${String(minute).padStart(2, "0")}:00.000Z`,
    updatedAt: `2026-07-31T10:${String(minute).padStart(2, "0")}:30.000Z`,
    ...(phase === "completed"
      ? {
          endedAt: `2026-07-31T10:${String(minute).padStart(2, "0")}:30.000Z`,
          terminationReason: "process-exit-zero",
          exitCode: 0,
        }
      : phase === "interrupted"
        ? {
            endedAt: `2026-07-31T10:${String(minute).padStart(2, "0")}:30.000Z`,
            terminationReason: "runtime-disconnected",
          }
        : {}),
    schemaVersion: 1,
  });

const snapshot = (
  value: SessionRunRecord,
  overrides: Partial<RunOutputSnapshot> = {},
): RunOutputSnapshot => ({
  sessionId: value.sessionId,
  runId: value.runId,
  data: "output",
  firstSeq: 1,
  lastSeq: 1,
  truncatedBytes: 0,
  sequenceGap: false,
  terminal: value.phase !== "running",
  ...overrides,
});

describe("projectConsoleRuns", () => {
  it("separates active and viewed Runs with deterministic ordering and replay state", () => {
    const older = run("run-a", 1);
    const viewed = run("run-b", 2, "interrupted");
    const active = run("run-live", 3, "running");
    const projection = projectConsoleRuns(
      [older, viewed, active],
      active.runId,
      viewed.runId,
      (value) => ({
        transcript:
          value.runId === older.runId
            ? snapshot(value, { truncatedBytes: 12 })
            : value.runId === viewed.runId
              ? snapshot(value, { sequenceGap: true })
              : snapshot(value),
        logAvailable: value.runId === viewed.runId,
      }),
    );

    expect(projection.activeRun?.runId).toBe(active.runId);
    expect(projection.viewedRun?.runId).toBe(viewed.runId);
    expect(projection.availableRuns.map(({ runId }) => runId)).toEqual([
      active.runId,
      viewed.runId,
      older.runId,
    ]);
    expect(projection.availableRuns.find(({ runId }) => runId === active.runId)).toMatchObject({
      active: true,
      viewed: false,
      replayState: "live",
    });
    expect(projection.availableRuns.find(({ runId }) => runId === viewed.runId)).toMatchObject({
      active: false,
      viewed: true,
      replayState: "sequence-gap",
      logAvailable: true,
    });
    expect(projection.availableRuns.find(({ runId }) => runId === older.runId)).toMatchObject({
      replayState: "retained-truncated",
      truncatedBytes: 12,
    });
  });

  it("keeps active and viewed Runs inside a bounded metadata projection", () => {
    const runs = Array.from({ length: 8 }, (_, index) => run(`run-${index}`, index));
    const active = runs[0];
    const viewed = runs[1];
    if (active === undefined || viewed === undefined) throw new Error("Fixture missing.");
    const projection = projectConsoleRuns(
      runs,
      active.runId,
      viewed.runId,
      () => ({ transcript: undefined, logAvailable: false }),
      3,
    );
    expect(projection.availableRuns).toHaveLength(3);
    expect(projection.availableRuns.map(({ runId }) => runId)).toContain(active.runId);
    expect(projection.availableRuns.map(({ runId }) => runId)).toContain(viewed.runId);
  });

  it("fixes the default metadata cap at 50 without dropping required identities", () => {
    expect(MAX_CONSOLE_RUN_METADATA).toBe(50);
    const runs = Array.from({ length: 55 }, (_, index) =>
      run(`run-${String(index).padStart(2, "0")}`, index),
    );
    const projection = projectConsoleRuns(runs, undefined, runs[0]?.runId, () => ({
      transcript: undefined,
      logAvailable: false,
    }));
    expect(projection.availableRuns).toHaveLength(50);
    expect(projection.availableRuns.some(({ viewed }) => viewed)).toBe(true);
  });
  it("uses run ID as a stable timestamp tie-break and rejects duplicates", () => {
    const left = run("run-a", 4);
    const right = run("run-b", 4);
    const availability = () => ({ transcript: undefined, logAvailable: false });
    expect(
      projectConsoleRuns([right, left], undefined, undefined, availability).availableRuns.map(
        ({ runId }) => runId,
      ),
    ).toEqual([left.runId, right.runId]);
    expect(() => projectConsoleRuns([left, left], undefined, undefined, availability)).toThrow(
      "duplicate Run ID",
    );
  });
});
