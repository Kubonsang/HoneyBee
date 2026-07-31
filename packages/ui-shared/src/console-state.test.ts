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

describe("reduceConsoleViewState", () => {
  it("enables controls only for the selected current Run", () => {
    const selected = reduceConsoleViewState(initialConsoleViewState(), {
      type: "session.selected",
      session,
      run: null,
      draft: "continue",
      recoveryIssue: null,
    });
    expect(selected.canStart).toBe(false);

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
    expect(connected.canInterrupt).toBe(false);

    const running = reduceConsoleViewState(connected, {
      type: "session.status",
      status: "running",
      run: runningRun,
      message: "Agent is running.",
    });
    expect(running.canStart).toBe(false);
    expect(running.canInterrupt).toBe(true);
    expect(running.canStop).toBe(true);

    const archived = reduceConsoleViewState(running, {
      type: "session.status",
      status: "completed",
      run: { ...runningRun, phase: "ended", interactive: false },
      message: "Agent completed.",
    });
    expect(archived.canStart).toBe(true);
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

  it("keeps Session Draft and selected Run identity together", () => {
    const state = reduceConsoleViewState(initialConsoleViewState(), {
      type: "session.selected",
      session,
      run: runningRun,
      draft: "saved draft",
      recoveryIssue: null,
    });
    expect(state.draft).toBe("saved draft");
    expect(state.selectedSession?.id).toBe("session-1");
    expect(state.selectedRun?.runId).toBe("run-1");
  });

  it("stores and clears a content-free recovery issue per selected Session", () => {
    const selected = reduceConsoleViewState(initialConsoleViewState(), {
      type: "session.selected",
      session,
      run: null,
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
