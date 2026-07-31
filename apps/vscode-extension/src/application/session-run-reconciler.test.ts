import {
  AgentSessionSchema,
  SessionRunRecordSchema,
  type AgentSession,
  err,
  type SessionRunPhase,
} from "@honeybee/domain";
import {
  InMemorySessionRepository,
  InMemorySessionRunRepository,
  RepositoryError,
  type SessionRunRepository,
} from "@honeybee/persistence";
import { describe, expect, it } from "vitest";

import { SessionRunReconciler } from "./session-run-reconciler.js";

const session = (id: string, status: AgentSession["status"]): AgentSession =>
  AgentSessionSchema.parse({
    id,
    title: id,
    agentProfileId: "custom",
    tags: [],
    relatedSessionIds: [],
    status,
    createdAt: "2026-07-30T10:00:00.000Z",
    updatedAt: "2026-07-30T10:00:00.000Z",
  });

const run = (id: string, phase: SessionRunPhase) =>
  SessionRunRecordSchema.parse({
    runId: `run-${id}`,
    sessionId: id,
    runtimeInstanceId: "runtime-previous",
    phase,
    startedAt: "2026-07-30T10:00:00.000Z",
    updatedAt: "2026-07-30T10:00:00.000Z",
    schemaVersion: 1,
  });

describe("SessionRunReconciler", () => {
  it("recovers every stale active phase without starting Runtime work", async () => {
    const storedSessions = [
      session("starting", "starting"),
      session("running", "running"),
      session("waiting", "waiting_for_input"),
      session("stopping", "running"),
      session("terminal", "completed"),
    ];
    const runs = new InMemorySessionRunRepository([
      run("starting", "starting"),
      run("running", "running"),
      run("waiting", "waiting-for-input"),
      run("stopping", "stopping"),
    ]);
    const sessions = new InMemorySessionRepository(storedSessions);
    const report = await new SessionRunReconciler(sessions, runs, {
      now: () => "2026-07-30T11:00:00.000Z",
    }).reconcile();

    expect(report.recoveredRuns).toBe(4);
    const listed = await sessions.list();
    expect(listed.ok ? listed.value.map(({ id, status }) => [id, status]) : []).toEqual([
      ["running", "stopped"],
      ["starting", "stopped"],
      ["stopping", "stopped"],
      ["terminal", "completed"],
      ["waiting", "stopped"],
    ]);
    const active = await runs.listActive();
    expect(active.ok ? active.value : []).toEqual([]);
    const allRuns = await runs.list();
    expect(
      allRuns.ok
        ? allRuns.value.every((item) => item.terminationReason === "recovered-stale-run")
        : false,
    ).toBe(true);
  });

  it("recovers legacy active Session status without inventing a Run", async () => {
    const sessions = new InMemorySessionRepository([session("legacy", "running")]);
    const runs = new InMemorySessionRunRepository();
    const report = await new SessionRunReconciler(sessions, runs, {
      now: () => "2026-07-30T11:00:00.000Z",
    }).reconcile();
    expect(report.recoveredLegacySessions).toBe(1);
    const restored = await sessions.getById(AgentSessionSchema.parse(session("legacy", "idle")).id);
    expect(restored.ok ? restored.value.status : undefined).toBe("stopped");
    const listedRuns = await runs.list();
    expect(listedRuns.ok ? listedRuns.value : []).toEqual([]);
  });

  it("stops active Session metadata when the Run store is invalid without mutating Runs", async () => {
    const sessions = new InMemorySessionRepository([session("orphaned", "running")]);
    const failure = new RepositoryError("validation", "Stored Session Runs are invalid.");
    const runs: SessionRunRepository = {
      getByRunId: async () => err(failure),
      getActiveBySessionId: async () => err(failure),
      list: async () => err(failure),
      listBySessionId: async () => err(failure),
      listActive: async () => err(failure),
      save: async () => err(failure),
      flush: async () => undefined,
    };
    const report = await new SessionRunReconciler(sessions, runs, {
      now: () => "2026-07-30T11:00:00.000Z",
    }).reconcile();
    expect(report.events).toContainEqual({ type: "failed", code: "run-list-failed" });
    expect(report.recoveredLegacySessions).toBe(1);
    const restored = await sessions.getById(session("orphaned", "idle").id);
    expect(restored.ok ? restored.value.status : undefined).toBe("stopped");
  });
});
