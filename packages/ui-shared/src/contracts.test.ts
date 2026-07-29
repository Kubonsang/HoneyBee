import { describe, expect, it } from "vitest";

import { isConsoleToExtensionMessage } from "./index.js";

describe("isConsoleToExtensionMessage", () => {
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
    expect(isConsoleToExtensionMessage({ type: "prompt.send", content: "hello" })).toBe(false);
  });
});
