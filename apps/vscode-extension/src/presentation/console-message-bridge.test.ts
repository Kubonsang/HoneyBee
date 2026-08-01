import { describe, expect, it, vi } from "vitest";

import { isExtensionToConsoleMessage } from "@honeybee/ui-shared";

import { postConsoleMessage } from "./console-message-bridge.js";

describe("postConsoleMessage", () => {
  it("posts a contract-valid terminal marker and traces only identity and sequence", async () => {
    const message = {
      type: "terminal.run.data",
      sessionId: "session-a",
      runId: "run-a",
      seq: 7,
      data: "SESSION-A",
    } as const;
    expect(isExtensionToConsoleMessage(message)).toBe(true);
    const posted: unknown[] = [];
    const trace = vi.fn();

    await expect(
      postConsoleMessage(
        {
          postMessage: async (value) => {
            posted.push(value);
            return true;
          },
        },
        message,
        trace,
      ),
    ).resolves.toBe(true);

    expect(posted).toEqual([message]);
    expect(trace.mock.calls.map(([event]) => event)).toEqual([
      {
        stage: "post-requested",
        sessionId: "session-a",
        runId: "run-a",
        sequence: 7,
      },
      {
        stage: "post-settled",
        sessionId: "session-a",
        runId: "run-a",
        sequence: 7,
        delivered: true,
      },
    ]);
    expect(JSON.stringify(trace.mock.calls)).not.toContain(message.data);
  });
});
