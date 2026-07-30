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

describe("reduceConsoleViewState", () => {
  it("enables only controls valid for the current connection and status", () => {
    const selected = reduceConsoleViewState(initialConsoleViewState(), {
      type: "session.selected",
      session,
      draft: "continue",
      recoveryIssue: null,
    });
    expect(selected.canStart).toBe(false);

    const connected = reduceConsoleViewState(selected, {
      type: "connection.changed",
      status: "connected",
      message: "Runtime connected.",
    });
    expect(connected.canStart).toBe(true);
    expect(connected.canInterrupt).toBe(false);

    const running = reduceConsoleViewState(connected, {
      type: "session.status",
      status: "running",
      message: "Agent is running.",
    });
    expect(running.canStart).toBe(false);
    expect(running.canInterrupt).toBe(true);
    expect(running.canStop).toBe(true);
  });

  it("keeps session-specific draft content with a selection", () => {
    const state = reduceConsoleViewState(initialConsoleViewState(), {
      type: "session.selected",
      session,
      draft: "saved draft",
      recoveryIssue: null,
    });
    expect(state.draft).toBe("saved draft");
    expect(state.selectedSession?.id).toBe("session-1");
  });
  it("stores and clears a content-free recovery issue per selected Session", () => {
    const selected = reduceConsoleViewState(initialConsoleViewState(), {
      type: "session.selected",
      session,
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
