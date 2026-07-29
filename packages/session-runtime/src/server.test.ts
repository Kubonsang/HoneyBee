import { PassThrough } from "node:stream";

import type { SessionIdSchema } from "@honeybee/domain";
import { describe, expect, it, vi } from "vitest";

import type { SessionLog, SessionLogFactory } from "./log.js";
import type { Disposable, PtyExitEvent, PtyFactoryPort, PtyProcessPort } from "./pty-port.js";
import { RuntimeJsonlServer } from "./server.js";
import { PtySessionManager } from "./session-manager.js";

class ServerFakeProcess implements PtyProcessPort {
  public readonly pid = 9001;
  public readonly writes: string[] = [];
  public readonly resizes: Array<readonly [number, number]> = [];
  readonly #dataListeners = new Set<(data: string) => void>();
  readonly #exitListeners = new Set<(event: PtyExitEvent) => void>();

  public onData(listener: (data: string) => void): Disposable {
    this.#dataListeners.add(listener);
    return { dispose: () => this.#dataListeners.delete(listener) };
  }

  public onExit(listener: (event: PtyExitEvent) => void): Disposable {
    this.#exitListeners.add(listener);
    return { dispose: () => this.#exitListeners.delete(listener) };
  }

  public write(data: string): void {
    this.writes.push(data);
  }

  public resize(cols: number, rows: number): void {
    this.resizes.push([cols, rows]);
  }

  public kill(): void {
    for (const listener of [...this.#exitListeners]) {
      listener({ exitCode: 0 });
    }
  }

  public emitData(data: string): void {
    for (const listener of this.#dataListeners) {
      listener(data);
    }
  }
}

class ServerFakeFactory implements PtyFactoryPort {
  public readonly process = new ServerFakeProcess();
  public spawn(): PtyProcessPort {
    return this.process;
  }
}

class ServerMemoryLogs implements SessionLogFactory {
  public async create(sessionId: ReturnType<typeof SessionIdSchema.parse>): Promise<SessionLog> {
    return {
      filePath: `memory://${sessionId}.log`,
      write: () => undefined,
      close: async () => undefined,
    };
  }
}

interface CapturedMessage {
  readonly kind: string;
  readonly id?: string;
  readonly ok?: boolean;
  readonly event?: string;
  readonly error?: { readonly code?: string };
  readonly data?: string;
}

const startRequest = {
  schemaVersion: 1,
  kind: "request",
  id: "start-1",
  method: "agent.start",
  params: {
    sessionId: "session-1",
    launchSpec: {
      command: "agent.exe",
      args: [],
      cwd: "C:\\repo",
      env: {},
      shell: false,
    },
    size: { cols: 80, rows: 24 },
  },
} as const;

const capture = (stream: PassThrough): CapturedMessage[] => {
  const messages: CapturedMessage[] = [];
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.length > 0) {
        messages.push(JSON.parse(line) as CapturedMessage);
      }
      newline = buffer.indexOf("\n");
    }
  });
  return messages;
};

describe("RuntimeJsonlServer", () => {
  it("handles split/coalesced requests and wraps PTY output as JSONL only", async () => {
    const factory = new ServerFakeFactory();
    const manager = new PtySessionManager(factory, { logFactory: new ServerMemoryLogs() });
    const server = new RuntimeJsonlServer(manager);
    const input = new PassThrough();
    const output = new PassThrough();
    const messages = capture(output);
    server.start(input, output);

    const startLine = `${JSON.stringify(startRequest)}\r\n`;
    const unicodeIndex = Math.floor(startLine.length / 2);
    input.write(startLine.slice(0, unicodeIndex));
    input.write(startLine.slice(unicodeIndex));

    await vi.waitFor(() =>
      expect(messages.some((message) => message.id === "start-1" && message.ok === true)).toBe(
        true,
      ),
    );
    factory.process.emitData("\u001b[32m한글🐝\u001b[0m\r\n");

    const inputRequest = {
      schemaVersion: 1,
      kind: "request",
      id: "input-1",
      method: "agent.input",
      params: { sessionId: "session-1", data: "hello" },
    };
    const resizeRequest = {
      schemaVersion: 1,
      kind: "request",
      id: "resize-1",
      method: "agent.resize",
      params: { sessionId: "session-1", size: { cols: 100, rows: 30 } },
    };
    input.write(`${JSON.stringify(inputRequest)}\n${JSON.stringify(resizeRequest)}\n`);

    await vi.waitFor(() =>
      expect(messages.filter((message) => message.ok === true)).toHaveLength(3),
    );
    expect(messages.find((message) => message.event === "pty.data")?.data).toBe(
      "\u001b[32m한글🐝\u001b[0m\r\n",
    );
    expect(factory.process.writes).toEqual(["hello"]);
    expect(factory.process.resizes).toEqual([[100, 30]]);
    expect(output.readableEncoding).toBe("utf8");
    await server.stop();
  });

  it("returns typed errors for duplicate ids, unknown versions, and malformed JSON", async () => {
    const manager = new PtySessionManager(new ServerFakeFactory(), {
      logFactory: new ServerMemoryLogs(),
    });
    const server = new RuntimeJsonlServer(manager);
    const input = new PassThrough();
    const output = new PassThrough();
    const messages = capture(output);
    server.start(input, output);

    input.write(`${JSON.stringify(startRequest)}\n${JSON.stringify(startRequest)}\n`);
    input.write(`${JSON.stringify({ ...startRequest, id: "version-1", schemaVersion: 99 })}\n`);
    input.write("not-json\n");

    await vi.waitFor(() => expect(messages.length).toBeGreaterThanOrEqual(5));
    expect(messages.some((message) => message.error?.code === "protocol.duplicate-request")).toBe(
      true,
    );
    expect(messages.some((message) => message.error?.code === "protocol.unsupported-version")).toBe(
      true,
    );
    expect(messages.some((message) => message.error?.code === "protocol.invalid-json")).toBe(true);
    await server.stop();
  });
});
