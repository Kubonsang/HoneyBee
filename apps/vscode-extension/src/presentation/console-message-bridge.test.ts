import { describe, expect, it, vi } from "vitest";

import { initialConsoleViewState, isExtensionToConsoleMessage } from "@honeybee/ui-shared";

import { ConsoleMessageQueue, postConsoleMessage } from "./console-message-bridge.js";

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

describe("ConsoleMessageQueue", () => {
  it("settles state, Run open, and Run data in FIFO order", async () => {
    const posted: string[] = [];
    const releases: Array<(delivered: boolean) => void> = [];
    const queue = new ConsoleMessageQueue({
      postMessage: (message) => {
        posted.push(message.type);
        return new Promise<boolean>((resolve) => releases.push(resolve));
      },
    });

    const state = queue.post({ type: "console.state", state: initialConsoleViewState() });
    const open = queue.post({
      type: "terminal.run.open",
      sessionId: "session-a",
      runId: "run-a",
      status: "active",
      initial: { kind: "empty" },
    });
    const data = queue.post({
      type: "terminal.run.data",
      sessionId: "session-a",
      runId: "run-a",
      seq: 1,
      data: "MARKER",
    });

    await Promise.resolve();
    expect(posted).toEqual(["console.state"]);
    releases.shift()?.(true);
    await state;
    await Promise.resolve();
    expect(posted).toEqual(["console.state", "terminal.run.open"]);
    releases.shift()?.(true);
    await open;
    await Promise.resolve();
    expect(posted).toEqual(["console.state", "terminal.run.open", "terminal.run.data"]);
    releases.shift()?.(true);
    await expect(data).resolves.toBe(true);
    await queue.close();
    await expect(queue.post({ type: "prompt.focus" })).resolves.toBe(false);
  });

  it("continues after a rejected post without reordering later messages", async () => {
    const posted: string[] = [];
    const queue = new ConsoleMessageQueue({
      postMessage: async (message) => {
        posted.push(message.type);
        if (message.type === "terminal.run.open") throw new Error("bridge closed");
        return true;
      },
    });

    await expect(
      queue.post({
        type: "terminal.run.open",
        sessionId: "session-a",
        runId: "run-a",
        status: "active",
        initial: { kind: "empty" },
      }),
    ).rejects.toThrow("bridge closed");
    await expect(
      queue.post({
        type: "terminal.run.data",
        sessionId: "session-a",
        runId: "run-a",
        seq: 1,
        data: "MARKER",
      }),
    ).resolves.toBe(true);
    expect(posted).toEqual(["terminal.run.open", "terminal.run.data"]);
  });
});
