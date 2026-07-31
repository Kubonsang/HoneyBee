import { describe, expect, it } from "vitest";

import { initialConsoleViewState, reduceConsoleViewState } from "./index.js";

const session = {
  id: "session-1",
  title: "Fix tests",
  agentProfile: "codex",
  workspace: "main",
  toolProfile: "default",
  status: "idle" as const,
  tags: ["tests"],
};

const runningRun = {
  runId: "run-1",
  sessionId: "session-1",
  phase: "running" as const,
  interactive: true,
  startedAt: "2026-07-31T10:00:00.000Z",
};

const archivedRun = {
  ...runningRun,
  runId: "run-0",
  phase: "ended" as const,
  interactive: false,
  endedAt: "2026-07-31T09:30:00.000Z",
};

const item = (run: typeof runningRun | typeof archivedRun, active: boolean, viewed: boolean) => ({
  ...run,
  active,
  viewed,
  replayState: active ? ("live" as const) : ("retained-complete" as const),
  truncatedBytes: 0,
  sequenceGap: false,
  logAvailable: false,
});

describe("reduceConsoleViewState", () => {
  it("enables mutation controls only while the viewed Run is active", () => {
    const selected = reduceConsoleViewState(initialConsoleViewState(), {
      type: "session.selected",
      session,
      activeRun: null,
      viewedRun: null,
      availableRuns: [],
      followLive: false,
      draft: "continue",
      recoveryIssue: null,
    });
    const active = reduceConsoleViewState(selected, {
      type: "lifecycle.changed",
      state: "active",
    });
    const connected = reduceConsoleViewState(active, {
      type: "connection.changed",
      status: "connected",
      message: "Runtime connected.",
    });
    expect(connected.canStart).toBe(true);

    const running = reduceConsoleViewState(connected, {
      type: "session.runs.changed",
      status: "running",
      activeRun: runningRun,
      viewedRun: runningRun,
      availableRuns: [item(runningRun, true, true)],
      followLive: true,
      message: "Agent is running.",
    });
    expect(running.canStart).toBe(false);
    expect(running.canInterrupt).toBe(true);
    expect(running.canStop).toBe(true);

    const archived = reduceConsoleViewState(running, {
      type: "session.runs.changed",
      status: "running",
      activeRun: runningRun,
      viewedRun: archivedRun,
      availableRuns: [item(runningRun, true, false), item(archivedRun, false, true)],
      followLive: false,
      message: "Viewing an archived Run.",
    });
    expect(archived.canStart).toBe(false);
    expect(archived.canInterrupt).toBe(false);
    expect(archived.canStop).toBe(false);

    const shuttingDown = reduceConsoleViewState(running, {
      type: "lifecycle.changed",
      state: "shutting-down",
    });
    expect(shuttingDown.canStart).toBe(false);
    expect(shuttingDown.canInterrupt).toBe(false);
    expect(shuttingDown.canStop).toBe(false);
    expect(shuttingDown.statusMessage).toContain("shutting down");
  });

  it("keeps Draft, active Run, viewed Run and follow-live state together", () => {
    const state = reduceConsoleViewState(initialConsoleViewState(), {
      type: "session.selected",
      session,
      activeRun: runningRun,
      viewedRun: archivedRun,
      availableRuns: [item(runningRun, true, false), item(archivedRun, false, true)],
      followLive: false,
      draft: "saved draft",
      recoveryIssue: null,
    });
    expect(state.draft).toBe("saved draft");
    expect(state.selectedSession?.id).toBe("session-1");
    expect(state.activeRun?.runId).toBe("run-1");
    expect(state.viewedRun?.runId).toBe("run-0");
    expect(state.followLive).toBe(false);
  });

  it("stores and clears a content-free recovery issue per selected Session", () => {
    const selected = reduceConsoleViewState(initialConsoleViewState(), {
      type: "session.selected",
      session,
      activeRun: null,
      viewedRun: null,
      availableRuns: [],
      followLive: false,
      draft: "saved draft",
      recoveryIssue: null,
    });
    const issue = {
      requestId: "request-1",
      sessionId: "session-1",
      outcome: "unknown" as const,
      draftMatch: "exact" as const,
      occurredAt: "2026-07-30T12:00:00.000Z",
    };
    const locked = reduceConsoleViewState(selected, {
      type: "recovery.changed",
      recoveryIssue: issue,
      message: "Automatic resend is disabled.",
    });
    expect(locked.recoveryIssue).toEqual(issue);
    expect(locked.statusMessage).toContain("disabled");
  });
});
