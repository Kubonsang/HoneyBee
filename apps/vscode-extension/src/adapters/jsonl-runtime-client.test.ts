import { describe, expect, it, vi } from "vitest";

import { SessionIdSchema } from "@honeybee/domain";

import type { RuntimeClientEvent } from "../application/ports.js";
import {
  JsonLineDecoder,
  JsonlRuntimeClient,
  type RuntimeTransportHandlers,
  type RuntimeTransportPort,
} from "./jsonl-runtime-client.js";

class FakeTransport implements RuntimeTransportPort {
  readonly writes: string[] = [];
  handlers: RuntimeTransportHandlers | undefined;

  public async start(handlers: RuntimeTransportHandlers): Promise<void> {
    this.handlers = handlers;
  }

  public async write(line: string): Promise<void> {
    this.writes.push(line);
  }

  public async stop(): Promise<void> {}

  public data(message: unknown): void {
    this.handlers?.onData(`${JSON.stringify(message)}\n`);
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
});
