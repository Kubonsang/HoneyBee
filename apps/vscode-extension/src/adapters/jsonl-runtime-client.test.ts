import { describe, expect, it, vi } from "vitest";

import { SessionIdSchema } from "@honeybee/domain";

import type { RuntimeClientEvent } from "../application/ports.js";
import {
  JsonLineDecoder,
  JsonlRuntimeClient,
  RuntimeTransportWriteError,
  type RuntimeTransportHandlers,
  type RuntimeTransportPort,
} from "./jsonl-runtime-client.js";

class FakeTransport implements RuntimeTransportPort {
  readonly writes: string[] = [];
  handlers: RuntimeTransportHandlers | undefined;
  writeError: Error | undefined;

  public async start(handlers: RuntimeTransportHandlers): Promise<void> {
    this.handlers = handlers;
  }

  public async write(line: string): Promise<void> {
    this.writes.push(line);
    if (this.writeError !== undefined) throw this.writeError;
  }

  public async stop(): Promise<void> {}

  public data(message: unknown): void {
    this.handlers?.onData(`${JSON.stringify(message)}\n`);
  }

  public close(reason = "Runtime disconnected."): void {
    this.handlers?.onClose(reason);
  }
}

describe("JsonLineDecoder", () => {
  it("decodes split, coalesced, CRLF, and empty frames", () => {
    const decoder = new JsonLineDecoder();
    expect(decoder.push('{"one":')).toEqual([]);
    expect(decoder.push('1}\r\n\n{"two":2}\n')).toEqual(['{"one":1}', '{"two":2}']);
  });

  it("rejects an unbounded partial frame", () => {
    const decoder = new JsonLineDecoder(4);
    expect(() => decoder.push("12345")).toThrow(/exceeded/);
  });
});

describe("JsonlRuntimeClient", () => {
  it("correlates requests and projects PTY/status events with session identity", async () => {
    const transport = new FakeTransport();
    const client = new JsonlRuntimeClient(transport, { requestId: () => "request-1" }, 1000);
    const events: RuntimeClientEvent[] = [];
    client.onEvent((event) => {
      events.push(event);
    });

    await client.connect();
    expect(client.connectionState).toBe("connected");

    const sessionId = SessionIdSchema.parse("session-1");
    const start = client.start({
      sessionId,
      command: "fake-agent",
      args: [],
      cwd: "C:\\workspace",
      environment: { PATH: "C:\\bin" },
      shell: false,
      columns: 100,
      rows: 30,
    });
    await vi.waitFor(() => {
      expect(transport.writes).toHaveLength(1);
    });
    expect(JSON.parse(transport.writes[0] ?? "{}")).toMatchObject({
      method: "agent.start",
      params: {
        sessionId: "session-1",
        launchSpec: {
          command: "fake-agent",
          cwd: "C:\\workspace",
          env: { PATH: "C:\\bin" },
          shell: false,
        },
        size: { cols: 100, rows: 30 },
      },
    });
    transport.data({
      schemaVersion: 1,
      kind: "response",
      id: "request-1",
      ok: true,
      result: { state: "starting" },
    });
    await start;

    transport.data({
      schemaVersion: 1,
      kind: "event",
      event: "pty.data",
      sessionId: "session-1",
      seq: 7,
      data: "\u001b[32mready\u001b[0m\r\n",
    });
    transport.data({
      schemaVersion: 1,
      kind: "event",
      event: "pty.started",
      sessionId: "session-1",
      seq: 8,
      pid: 42,
      logFilePath: "C:\\logs\\session-1.log",
    });

    expect(events).toContainEqual({
      type: "pty.data",
      sessionId,
      sequence: 7,
      data: "\u001b[32mready\u001b[0m\r\n",
    });
    expect(events).toContainEqual({
      type: "session.status",
      sessionId,
      status: "running",
      message: "Agent is running.",
    });
  });
  it("returns accepted only after a correlated success response", async () => {
    const transport = new FakeTransport();
    const client = new JsonlRuntimeClient(transport, { requestId: () => "input-accepted" }, 1000);
    await client.connect();
    const pending = client.sendInput(SessionIdSchema.parse("session-1"), "hello\r");
    await vi.waitFor(() => expect(transport.writes).toHaveLength(1));
    transport.data({
      schemaVersion: 1,
      kind: "response",
      id: "input-accepted",
      ok: true,
      result: { accepted: true },
    });
    await expect(pending).resolves.toEqual({ status: "accepted" });
  });

  it("returns rejected for explicit Runtime rejection and pre-write failure", async () => {
    const explicitTransport = new FakeTransport();
    const explicit = new JsonlRuntimeClient(
      explicitTransport,
      { requestId: () => "input-rejected" },
      1000,
    );
    await explicit.connect();
    const pending = explicit.sendInput(SessionIdSchema.parse("session-1"), "hello\r");
    await vi.waitFor(() => expect(explicitTransport.writes).toHaveLength(1));
    explicitTransport.data({
      schemaVersion: 1,
      kind: "response",
      id: "input-rejected",
      ok: false,
      error: { code: "runtime.session-not-running", message: "PTY stopped.", retryable: true },
    });
    await expect(pending).resolves.toEqual({ status: "rejected", message: "PTY stopped." });

    const preWriteTransport = new FakeTransport();
    preWriteTransport.writeError = new RuntimeTransportWriteError(
      "not-written",
      "Runtime is not connected.",
    );
    const preWrite = new JsonlRuntimeClient(
      preWriteTransport,
      { requestId: () => "input-not-written" },
      1000,
    );
    await preWrite.connect();
    await expect(
      preWrite.sendInput(SessionIdSchema.parse("session-1"), "hello\r"),
    ).resolves.toEqual({ status: "rejected", message: "Runtime is not connected." });
  });

  it("returns unknown after transport write timeout, callback error, or disconnect", async () => {
    vi.useFakeTimers();
    const timeoutTransport = new FakeTransport();
    const timeoutClient = new JsonlRuntimeClient(
      timeoutTransport,
      { requestId: () => "input-timeout" },
      10,
    );
    await timeoutClient.connect();
    const timeout = timeoutClient.sendInput(SessionIdSchema.parse("session-1"), "hello\r");
    await vi.advanceTimersByTimeAsync(11);
    await expect(timeout).resolves.toMatchObject({ status: "unknown" });
    vi.useRealTimers();

    const callbackTransport = new FakeTransport();
    callbackTransport.writeError = new RuntimeTransportWriteError(
      "unknown",
      "Write callback failed.",
    );
    const callbackClient = new JsonlRuntimeClient(
      callbackTransport,
      { requestId: () => "input-write-unknown" },
      1000,
    );
    await callbackClient.connect();
    await expect(
      callbackClient.sendInput(SessionIdSchema.parse("session-1"), "hello\r"),
    ).resolves.toEqual({ status: "unknown", reason: "Write callback failed." });

    const disconnectTransport = new FakeTransport();
    const disconnectClient = new JsonlRuntimeClient(
      disconnectTransport,
      { requestId: () => "input-disconnect" },
      1000,
    );
    await disconnectClient.connect();
    const disconnected = disconnectClient.sendInput(SessionIdSchema.parse("session-1"), "hello\r");
    await vi.waitFor(() => expect(disconnectTransport.writes).toHaveLength(1));
    disconnectTransport.close("Runtime process exited.");
    await expect(disconnected).resolves.toEqual({
      status: "unknown",
      reason: "Runtime process exited.",
    });
  });
});
