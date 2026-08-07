import { describe, expect, it } from "vitest";

import {
  CONSOLE_WEBVIEW_VERSION,
  isConsoleToExtensionMessage,
  isExtensionToConsoleMessage,
} from "./index.js";

const state = {
  selectedSession: {
    id: "session-1",
    title: "Console",
    agentProfile: "codex",
    workspace: "main",
    toolProfile: "default",
    status: "running" as const,
    tags: [],
  },
  activeRun: {
    runId: "run-1",
    sessionId: "session-1",
    phase: "running" as const,
    interactive: true,
    startedAt: "2026-07-31T10:00:00.000Z",
  },
  viewedRun: {
    runId: "run-1",
    sessionId: "session-1",
    phase: "running" as const,
    interactive: true,
    startedAt: "2026-07-31T10:00:00.000Z",
  },
  availableRuns: [
    {
      runId: "run-1",
      sessionId: "session-1",
      phase: "running" as const,
      interactive: true,
      startedAt: "2026-07-31T10:00:00.000Z",
      active: true,
      viewed: true,
      replayState: "live" as const,
      truncatedBytes: 0,
      sequenceGap: false,
      logAvailable: true,
    },
  ],
  followLive: true,
  draft: "",
  recoveryIssue: null,
  connectionStatus: "connected" as const,
  lifecycleState: "active" as const,
  statusMessage: "Connected.",
  canStart: false,
  canInterrupt: true,
  canStop: true,
};

describe("Console message contracts", () => {
  it("requires protocol v8 and rejects older ready messages", () => {
    expect(
      isConsoleToExtensionMessage({
        type: "webview.ready",
        version: CONSOLE_WEBVIEW_VERSION,
      }),
    ).toBe(true);
    expect(isConsoleToExtensionMessage({ type: "webview.ready", version: 7 })).toBe(false);
  });

  it("strictly validates content-free terminal render acknowledgements", () => {
    const acknowledgement = {
      type: "terminal.run.render-ack",
      sessionId: "session-1",
      runId: "run-1",
      seq: 4,
      stage: "xterm-write-callback",
      result: "parsed",
      bufferLineCount: 8,
      baseY: 0,
      viewportY: 0,
      rows: 24,
      columns: 80,
      containerWidth: 960,
      containerHeight: 480,
    } as const;
    expect(isConsoleToExtensionMessage(acknowledgement)).toBe(true);
    expect(isConsoleToExtensionMessage({ ...acknowledgement, terminalData: "forbidden" })).toBe(
      false,
    );
    expect(isConsoleToExtensionMessage({ ...acknowledgement, containerWidth: -1 })).toBe(false);
    expect(isConsoleToExtensionMessage({ ...acknowledgement, stage: "renderer-payload" })).toBe(
      false,
    );
    expect(JSON.stringify(acknowledgement)).not.toContain("Prompt");
  });

  it("requires a request ID and non-empty content for prompt.send", () => {
    expect(
      isConsoleToExtensionMessage({
        type: "prompt.send",
        requestId: "prompt-1",
        sessionId: "session-1",
        content: "hello",
      }),
    ).toBe(true);
    expect(
      isConsoleToExtensionMessage({
        type: "prompt.send",
        sessionId: "session-1",
        content: "hello",
      }),
    ).toBe(false);
    expect(
      isConsoleToExtensionMessage({
        type: "prompt.send",
        requestId: "prompt-2",
        sessionId: "session-1",
        content: "   ",
      }),
    ).toBe(false);
  });

  it("accepts typed recovery actions and rejects missing correlation", () => {
    expect(
      isConsoleToExtensionMessage({
        type: "prompt.recovery.assume-delivered",
        requestId: "request-1",
        sessionId: "session-1",
      }),
    ).toBe(true);
    expect(
      isConsoleToExtensionMessage({
        type: "prompt.recovery.retry",
        sessionId: "session-1",
      }),
    ).toBe(false);
  });

  it("requires exact Run identity for terminal input, resize, and controls", () => {
    expect(
      isConsoleToExtensionMessage({
        type: "terminal.run.input",
        sessionId: "session-1",
        runId: "run-1",
        data: "\u0003",
      }),
    ).toBe(true);
    expect(
      isConsoleToExtensionMessage({
        type: "terminal.run.resize",
        sessionId: "session-1",
        runId: "run-1",
        columns: 120,
        rows: 36,
      }),
    ).toBe(true);
    expect(
      isConsoleToExtensionMessage({
        type: "terminal.input",
        sessionId: "session-1",
        data: "\u0003",
      }),
    ).toBe(false);
    expect(
      isConsoleToExtensionMessage({
        type: "terminal.run.resize",
        sessionId: "session-1",
        columns: 120,
        rows: 36,
      }),
    ).toBe(false);
    expect(
      isConsoleToExtensionMessage({
        type: "session.stop",
        sessionId: "session-1",
        runId: "run-1",
      }),
    ).toBe(true);
    expect(
      isConsoleToExtensionMessage({
        type: "session.stop",
        sessionId: "session-1",
      }),
    ).toBe(false);
  });

  it("validates strict Run-scoped open, data, snapshot, reset, and close messages", () => {
    expect(
      isExtensionToConsoleMessage({
        type: "terminal.run.open",
        sessionId: "session-1",
        runId: "run-1",
        status: "active",
        initial: {
          kind: "replay",
          data: "\u001b[?1049h",
          firstSeq: 1,
          lastSeq: 2,
          truncatedBytes: 0,
        },
      }),
    ).toBe(true);
    expect(
      isExtensionToConsoleMessage({
        type: "terminal.run.data",
        sessionId: "session-1",
        runId: "run-1",
        seq: 3,
        data: "screen",
      }),
    ).toBe(true);
    expect(
      isExtensionToConsoleMessage({
        type: "terminal.run.snapshot",
        sessionId: "session-1",
        runId: "run-1",
        status: "active",
        data: "bounded replay",
        firstSeq: 1,
        lastSeq: 3,
        truncatedBytes: 12,
      }),
    ).toBe(true);
    expect(
      isExtensionToConsoleMessage({
        type: "terminal.run.reset",
        sessionId: "session-1",
        runId: "run-1",
      }),
    ).toBe(true);
    expect(
      isExtensionToConsoleMessage({
        type: "terminal.run.close",
        sessionId: "session-1",
        runId: "run-1",
        reason: "process-exit-zero",
        finalSeq: 4,
      }),
    ).toBe(true);
    expect(
      isExtensionToConsoleMessage({
        type: "terminal.data",
        sessionId: "session-1",
        data: "legacy",
      }),
    ).toBe(false);
    expect(
      isExtensionToConsoleMessage({
        type: "terminal.run.data",
        sessionId: "session-1",
        runId: "run-1",
        seq: -1,
        data: "invalid",
      }),
    ).toBe(false);
  });

  it("validates strict Run navigation actions", () => {
    expect(
      isConsoleToExtensionMessage({
        type: "terminal.run.select",
        sessionId: "session-1",
        runId: "run-1",
      }),
    ).toBe(true);
    expect(
      isConsoleToExtensionMessage({
        type: "terminal.run.follow-active",
        sessionId: "session-1",
      }),
    ).toBe(true);
    expect(
      isConsoleToExtensionMessage({
        type: "terminal.run.open-log",
        sessionId: "session-1",
        runId: "run-1",
      }),
    ).toBe(true);
    expect(
      isConsoleToExtensionMessage({
        type: "terminal.run.select",
        sessionId: "session-1",
        runId: "run-1",
        path: "C:\\untrusted.log",
      }),
    ).toBe(false);
    expect(
      isConsoleToExtensionMessage({
        type: "terminal.run.follow-active",
        sessionId: "",
      }),
    ).toBe(false);
  });

  it("requires consistent active and viewed Run identity in Console state", () => {
    expect(isExtensionToConsoleMessage({ type: "console.state", state })).toBe(true);
    const { viewedRun: _viewedRun, ...missingRun } = state;
    expect(isExtensionToConsoleMessage({ type: "console.state", state: missingRun })).toBe(false);
    expect(
      isExtensionToConsoleMessage({
        type: "console.state",
        state: {
          ...state,
          viewedRun: { ...state.viewedRun, sessionId: "session-2" },
        },
      }),
    ).toBe(false);
    expect(
      isExtensionToConsoleMessage({
        type: "console.state",
        state: {
          ...state,
          activeRun: { ...state.activeRun, phase: "starting", interactive: false },
        },
      }),
    ).toBe(false);
    expect(
      isExtensionToConsoleMessage({
        type: "console.state",
        state: {
          ...state,
          availableRuns: [
            { ...state.availableRuns[0], replayState: "retained-truncated", truncatedBytes: 0 },
          ],
        },
      }),
    ).toBe(false);
    expect(
      isExtensionToConsoleMessage({
        type: "console.state",
        state: {
          ...state,
          availableRuns: [{ ...state.availableRuns[0], startedAt: "not-a-date" }],
        },
      }),
    ).toBe(false);
  });

  it("distinguishes accepted durability outcomes from rejected and unknown delivery", () => {
    expect(
      isExtensionToConsoleMessage({
        type: "prompt.accepted",
        requestId: "prompt-1",
        sessionId: "session-1",
        attemptPersistence: "stored",
        receiptPersistence: "stored",
        draftCleanup: "cleared",
        warnings: [],
      }),
    ).toBe(true);
    expect(
      isExtensionToConsoleMessage({
        type: "prompt.rejected",
        requestId: "prompt-2",
        sessionId: "session-1",
        message: "Runtime write failed.",
      }),
    ).toBe(true);
    expect(
      isExtensionToConsoleMessage({
        type: "prompt.unknown",
        requestId: "prompt-3",
        sessionId: "session-1",
        message: "Runtime response was not observed.",
        warnings: [],
      }),
    ).toBe(true);
    expect(
      isExtensionToConsoleMessage({
        type: "prompt.unknown",
        requestId: "prompt-content",
        sessionId: "session-1",
        message: "Runtime response was not observed.",
        warnings: [],
        content: "must not cross acknowledgement protocol",
      }),
    ).toBe(false);
  });
});
