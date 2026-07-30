import { describe, expect, it } from "vitest";

import { isConsoleToExtensionMessage, isExtensionToConsoleMessage } from "./index.js";

describe("Console message contracts", () => {
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
    expect(
      isConsoleToExtensionMessage({
        type: "prompt.recovery.retry",
        requestId: "request-1",
        sessionId: "session-1",
        content: "must not cross recovery protocol",
      }),
    ).toBe(false);
  });

  it("accepts valid input and resize messages", () => {
    expect(
      isConsoleToExtensionMessage({
        type: "terminal.input",
        sessionId: "session-1",
        data: "\u0003",
      }),
    ).toBe(true);
    expect(
      isConsoleToExtensionMessage({
        type: "terminal.resize",
        sessionId: "session-1",
        columns: 120,
        rows: 36,
      }),
    ).toBe(true);
  });

  it("rejects malformed and zero-sized messages", () => {
    expect(
      isConsoleToExtensionMessage({
        type: "terminal.resize",
        sessionId: "session-1",
        columns: 0,
        rows: 36,
      }),
    ).toBe(false);
  });

  it("distinguishes accepted durability outcomes from rejected delivery", () => {
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
        type: "prompt.accepted",
        requestId: "prompt-2",
        sessionId: "session-1",
        attemptPersistence: "stored",
        receiptPersistence: "stored",
        draftCleanup: "pending",
        warnings: ["draft-delete-failed"],
      }),
    ).toBe(true);
    expect(
      isExtensionToConsoleMessage({
        type: "prompt.rejected",
        requestId: "prompt-3",
        sessionId: "session-1",
        message: "Runtime write failed.",
      }),
    ).toBe(true);
    expect(
      isExtensionToConsoleMessage({
        type: "prompt.unknown",
        requestId: "prompt-unknown",
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
    expect(
      isExtensionToConsoleMessage({
        type: "prompt.accepted",
        requestId: "prompt-4",
        sessionId: "session-1",
        attemptPersistence: "stored",
        receiptPersistence: "warning",
        draftCleanup: "warning",
        warnings: ["not-a-warning-code"],
      }),
    ).toBe(false);
    expect(
      isExtensionToConsoleMessage({
        type: "prompt.accepted",
        requestId: "prompt-5",
        sessionId: "session-1",
        draftCleanup: "cleared",
      }),
    ).toBe(false);
    expect(
      isExtensionToConsoleMessage({
        type: "prompt.rejected",
        sessionId: "session-1",
        message: "Runtime write failed.",
      }),
    ).toBe(false);
  });
});
