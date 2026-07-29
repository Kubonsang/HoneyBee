import type { Disposable } from "./pty-port.js";
import { RuntimeOperationError } from "./errors.js";
import { JsonlDecoder, type JsonlDecoderOptions } from "./jsonl.js";
import {
  RUNTIME_PROTOCOL_VERSION,
  RuntimeRequestSchema,
  encodeRuntimeMessage,
  type RuntimeErrorPayload,
  type RuntimeEventMessage,
  type RuntimeRequest,
  type RuntimeResponse,
} from "./protocol.js";
import type { PtySessionManager } from "./session-manager.js";
import type { PtySessionEvent } from "./types.js";

export interface RuntimeJsonlServerOptions extends JsonlDecoderOptions {
  readonly diagnostic?: (message: string, error?: unknown) => void;
  readonly onShutdown?: () => void | Promise<void>;
}

const errorPayload = (error: unknown): RuntimeErrorPayload => {
  if (error instanceof RuntimeOperationError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      ...(error.details === undefined ? {} : { details: error.details }),
    };
  }
  return {
    code: "runtime.internal",
    message: "The Runtime encountered an internal error.",
    retryable: false,
  };
};

const requestId = (value: unknown): string | undefined => {
  if (typeof value !== "object" || value === null || !("id" in value)) {
    return undefined;
  }
  return typeof value.id === "string" && value.id.length > 0 ? value.id : undefined;
};

export class RuntimeJsonlServer {
  readonly #manager: PtySessionManager;
  readonly #options: RuntimeJsonlServerOptions;
  readonly #decoder: JsonlDecoder;
  readonly #diagnostic: (message: string, error?: unknown) => void;
  readonly #seenRequestIds = new Set<string>();
  readonly #managerSubscription: Disposable;
  #pending: Promise<void> = Promise.resolve();
  #input: NodeJS.ReadableStream | undefined;
  #output: NodeJS.WritableStream | undefined;
  #ending = false;

  readonly #onData = (chunk: unknown): void => {
    if (this.#ending) {
      return;
    }
    try {
      const value =
        typeof chunk === "string" || Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      for (const line of this.#decoder.push(value)) {
        this.#pending = this.#pending
          .then(() => this.#processLine(line))
          .catch((error: unknown) => this.#diagnostic("Runtime request handling failed.", error));
      }
    } catch (error: unknown) {
      this.#sendProtocolError(error);
    }
  };

  readonly #onEnd = (): void => {
    if (this.#ending) {
      return;
    }
    this.#ending = true;
    try {
      this.#decoder.finish();
    } catch (error: unknown) {
      this.#sendProtocolError(error);
    }
    this.#pending = this.#pending
      .then(() => this.#manager.shutdown())
      .catch((error: unknown) => this.#diagnostic("Runtime EOF cleanup failed.", error));
  };

  public constructor(manager: PtySessionManager, options: RuntimeJsonlServerOptions = {}) {
    this.#manager = manager;
    this.#options = options;
    this.#decoder = new JsonlDecoder(options);
    this.#diagnostic = options.diagnostic ?? (() => undefined);
    this.#managerSubscription = manager.onEvent((event) => this.#sendManagerEvent(event));
  }

  public start(input: NodeJS.ReadableStream, output: NodeJS.WritableStream): void {
    if (this.#input !== undefined) {
      throw new RuntimeOperationError(
        "runtime.internal",
        "Runtime JSONL server has already started.",
        false,
      );
    }
    this.#input = input;
    this.#output = output;
    input.on("data", this.#onData);
    input.once("end", this.#onEnd);
  }

  public async stop(): Promise<void> {
    if (!this.#ending) {
      this.#ending = true;
      await this.#pending;
      await this.#manager.shutdown();
    }
    this.#input?.removeListener("data", this.#onData);
    this.#input?.removeListener("end", this.#onEnd);
    this.#managerSubscription.dispose();
  }

  async #processLine(line: string): Promise<void> {
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      this.#sendProtocolError(
        new RuntimeOperationError(
          "protocol.invalid-json",
          "Runtime received malformed JSON.",
          false,
        ),
      );
      return;
    }

    const parsed = RuntimeRequestSchema.safeParse(value);
    if (!parsed.success) {
      const id = requestId(value);
      const unsupportedVersion =
        typeof value === "object" &&
        value !== null &&
        "schemaVersion" in value &&
        value.schemaVersion !== RUNTIME_PROTOCOL_VERSION;
      const error = new RuntimeOperationError(
        unsupportedVersion ? "protocol.unsupported-version" : "protocol.invalid-message",
        unsupportedVersion
          ? "Runtime protocol schemaVersion is unsupported."
          : "Runtime request failed schema validation.",
        false,
        { issues: parsed.error.issues },
      );
      if (id === undefined) {
        this.#sendProtocolError(error);
      } else {
        this.#sendFailure(id, error);
      }
      return;
    }

    if (this.#seenRequestIds.has(parsed.data.id)) {
      this.#sendFailure(
        parsed.data.id,
        new RuntimeOperationError(
          "protocol.duplicate-request",
          `Request id "${parsed.data.id}" has already been used.`,
          false,
        ),
      );
      return;
    }
    this.#seenRequestIds.add(parsed.data.id);

    try {
      await this.#handleRequest(parsed.data);
    } catch (error: unknown) {
      this.#sendFailure(parsed.data.id, error);
    }
  }

  async #handleRequest(request: RuntimeRequest): Promise<void> {
    switch (request.method) {
      case "agent.start": {
        const snapshot = await this.#manager.start({
          sessionId: request.params.sessionId,
          launchSpec: request.params.launchSpec,
          size: request.params.size,
          ...(request.params.logFilePath === undefined
            ? {}
            : { logFilePath: request.params.logFilePath }),
        });
        this.#sendSuccess(request.id, {
          state: "running",
          logFilePath: snapshot.logFilePath,
        });
        return;
      }
      case "agent.input":
        this.#manager.input(request.params.sessionId, request.params.data);
        this.#sendSuccess(request.id, { accepted: true });
        return;
      case "agent.resize":
        this.#manager.resize(request.params.sessionId, request.params.size);
        this.#sendSuccess(request.id, { accepted: true });
        return;
      case "agent.interrupt":
        this.#manager.interrupt(request.params.sessionId);
        this.#sendSuccess(request.id, { accepted: true });
        return;
      case "agent.stop":
        this.#manager.stop(request.params.sessionId, request.params.force ?? false);
        this.#sendSuccess(request.id, {
          state: request.params.force === true ? "force-stopping" : "stopping",
        });
        return;
      case "agent.snapshot":
        this.#sendSuccess(request.id, this.#manager.getSnapshot(request.params.sessionId));
        return;
      case "runtime.shutdown":
        this.#sendSuccess(request.id, { state: "stopped" });
        await this.#manager.shutdown();
        await this.#options.onShutdown?.();
        return;
    }
  }

  #sendManagerEvent(event: PtySessionEvent): void {
    switch (event.type) {
      case "session.started":
        this.#send({
          schemaVersion: RUNTIME_PROTOCOL_VERSION,
          kind: "event",
          event: "pty.started",
          sessionId: event.sessionId,
          seq: event.seq,
          pid: event.pid,
          logFilePath: event.logFilePath,
        });
        return;
      case "session.output":
        this.#send({
          schemaVersion: RUNTIME_PROTOCOL_VERSION,
          kind: "event",
          event: "pty.data",
          sessionId: event.sessionId,
          seq: event.seq,
          data: event.data,
        });
        return;
      case "session.exited":
        this.#send({
          schemaVersion: RUNTIME_PROTOCOL_VERSION,
          kind: "event",
          event: "pty.exit",
          sessionId: event.sessionId,
          seq: event.seq,
          exitCode: event.exitCode,
          signal: event.signal,
          reason: event.reason,
        });
        return;
    }
  }

  #sendSuccess(id: string, result: unknown): void {
    const response: RuntimeResponse = {
      schemaVersion: RUNTIME_PROTOCOL_VERSION,
      kind: "response",
      id,
      ok: true,
      result,
    };
    this.#send(response);
  }

  #sendFailure(id: string, error: unknown): void {
    const response: RuntimeResponse = {
      schemaVersion: RUNTIME_PROTOCOL_VERSION,
      kind: "response",
      id,
      ok: false,
      error: errorPayload(error),
    };
    this.#send(response);
  }

  #sendProtocolError(error: unknown): void {
    const event: RuntimeEventMessage = {
      schemaVersion: RUNTIME_PROTOCOL_VERSION,
      kind: "event",
      event: "runtime.protocol-error",
      error: errorPayload(error),
    };
    this.#send(event);
  }

  #send(message: RuntimeResponse | RuntimeEventMessage): void {
    if (this.#output === undefined) {
      this.#diagnostic("Runtime attempted to send before the JSONL server started.");
      return;
    }
    this.#output.write(encodeRuntimeMessage(message));
  }
}
