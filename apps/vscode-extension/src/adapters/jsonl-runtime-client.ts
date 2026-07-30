import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn } from "node:child_process";

import { SessionIdSchema, type SessionId, type SessionStatus } from "@honeybee/domain";
import type { RuntimeRequest } from "@honeybee/session-runtime";

import { ApplicationError } from "../application/errors.js";
import type {
  IdGeneratorPort,
  RuntimeClientEvent,
  RuntimeClientPort,
  RuntimeConnectionState,
  RuntimeInputOutcome,
  RuntimeStartRequest,
} from "../application/ports.js";

const PROTOCOL_VERSION = 1 as const;
const DEFAULT_MAX_FRAME_SIZE = 1024 * 1024;

export interface RuntimeTransportHandlers {
  readonly onData: (chunk: string) => void;
  readonly onClose: (reason: string) => void;
  readonly onError: (error: Error) => void;
}

export interface RuntimeTransportPort {
  start(handlers: RuntimeTransportHandlers): Promise<void>;
  write(line: string): Promise<void>;
  stop(): Promise<void>;
}

export type RuntimeTransportWriteDisposition = "not-written" | "unknown";

export class RuntimeTransportWriteError extends Error {
  public override readonly name = "RuntimeTransportWriteError";

  public constructor(
    public readonly disposition: RuntimeTransportWriteDisposition,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(message, options);
  }
}

class RuntimeRequestFailure extends ApplicationError {
  public override readonly name = "RuntimeRequestFailure";

  public constructor(
    public readonly outcome: Exclude<RuntimeInputOutcome["status"], "accepted">,
    code: string,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(code, message, details);
  }
}
export interface NodeRuntimeTransportOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly onDiagnostic?: (message: string) => void;
}

export class JsonLineDecoder {
  #buffer = "";

  public constructor(private readonly maxFrameSize = DEFAULT_MAX_FRAME_SIZE) {}

  public push(chunk: string): readonly string[] {
    this.#buffer += chunk;
    if (this.#buffer.length > this.maxFrameSize) {
      throw new ApplicationError(
        "protocol.frame-too-large",
        `Runtime protocol buffer exceeded ${this.maxFrameSize} characters.`,
      );
    }

    const frames: string[] = [];
    let newlineIndex = this.#buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = this.#buffer.slice(0, newlineIndex).replace(/\r$/, "");
      this.#buffer = this.#buffer.slice(newlineIndex + 1);
      if (line.length > 0) {
        frames.push(line);
      }
      newlineIndex = this.#buffer.indexOf("\n");
    }
    return frames;
  }
}

export class NodeChildProcessRuntimeTransport implements RuntimeTransportPort {
  #child: ChildProcessWithoutNullStreams | undefined;

  public constructor(private readonly options: NodeRuntimeTransportOptions) {}

  public async start(handlers: RuntimeTransportHandlers): Promise<void> {
    if (this.#child !== undefined) {
      return;
    }
    const child = spawn(this.options.command, [...this.options.args], {
      ...(this.options.cwd === undefined ? {} : { cwd: this.options.cwd }),
      ...(this.options.environment === undefined ? {} : { env: this.options.environment }),
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#child = child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      handlers.onData(chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      this.options.onDiagnostic?.(chunk);
    });
    child.on("error", handlers.onError);
    child.on("close", (code, signal) => {
      this.#child = undefined;
      handlers.onClose(
        signal === null
          ? `Runtime exited with code ${String(code)}.`
          : `Runtime exited (${signal}).`,
      );
    });
  }

  public async write(line: string): Promise<void> {
    const child = this.#child;
    if (child === undefined || child.stdin.destroyed) {
      throw new RuntimeTransportWriteError("not-written", "The runtime is not connected.");
    }
    await new Promise<void>((resolve, reject) => {
      child.stdin.write(line.endsWith("\n") ? line : `${line}\n`, "utf8", (error) => {
        if (error === null || error === undefined) {
          resolve();
        } else {
          reject(
            new RuntimeTransportWriteError("unknown", "Runtime transport write failed.", {
              cause: error,
            }),
          );
        }
      });
    });
  }
  public async stop(): Promise<void> {
    const child = this.#child;
    this.#child = undefined;
    if (child === undefined) {
      return;
    }
    const waitForClose = (timeoutMs: number): Promise<boolean> =>
      new Promise((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve(true);
          return;
        }
        const onClose = (): void => {
          clearTimeout(timeout);
          resolve(true);
        };
        const timeout = setTimeout(() => {
          child.off("close", onClose);
          resolve(false);
        }, timeoutMs);
        child.once("close", onClose);
      });

    child.stdin.end();
    child.kill();
    if (!(await waitForClose(2_000))) {
      child.kill("SIGKILL");
      if (!(await waitForClose(2_000))) {
        throw new ApplicationError(
          "runtime.stop-timeout",
          "The runtime process did not exit after termination.",
        );
      }
    }
  }
}

interface PendingRequest {
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

type RuntimeRequestMethod = RuntimeRequest["method"];
type RuntimeRequestFor<Method extends RuntimeRequestMethod> = Extract<
  RuntimeRequest,
  { readonly method: Method }
>;

export class JsonlRuntimeClient implements RuntimeClientPort {
  readonly #decoder: JsonLineDecoder;
  readonly #listeners = new Set<(event: RuntimeClientEvent) => void>();
  readonly #pending = new Map<string, PendingRequest>();
  #connectionState: RuntimeConnectionState = "disconnected";

  public constructor(
    private readonly transport: RuntimeTransportPort,
    private readonly ids: Pick<IdGeneratorPort, "requestId">,
    private readonly requestTimeoutMs = 10_000,
    maxFrameSize = DEFAULT_MAX_FRAME_SIZE,
  ) {
    this.#decoder = new JsonLineDecoder(maxFrameSize);
  }

  public get connectionState(): RuntimeConnectionState {
    return this.#connectionState;
  }

  public async connect(): Promise<void> {
    if (this.#connectionState !== "disconnected") {
      return;
    }
    this.setConnection("connecting", "Connecting to the separate runtime…");
    try {
      await this.transport.start({
        onData: (chunk) => {
          this.acceptChunk(chunk);
        },
        onClose: (reason) => {
          this.handleDisconnect(reason);
        },
        onError: (error) => {
          this.setConnection("error", error.message);
          this.emit({
            type: "runtime.error",
            code: "runtime.process",
            message: error.message,
            recoverable: true,
          });
        },
      });
      this.setConnection("connected", "Runtime connected.");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setConnection("error", message);
      throw new ApplicationError("runtime.start-failed", message);
    }
  }

  public async start(request: RuntimeStartRequest): Promise<void> {
    await this.request("agent.start", {
      sessionId: request.sessionId,
      launchSpec: {
        command: request.command,
        args: [...request.args],
        cwd: request.cwd,
        env: request.environment,
        shell: request.shell,
      },
      size: {
        cols: request.columns,
        rows: request.rows,
      },
    });
  }

  public async sendInput(sessionId: SessionId, data: string): Promise<RuntimeInputOutcome> {
    try {
      await this.request("agent.input", { sessionId, data });
      return { status: "accepted" };
    } catch (error) {
      if (error instanceof RuntimeRequestFailure) {
        return error.outcome === "rejected"
          ? { status: "rejected", message: error.message }
          : { status: "unknown", reason: error.message };
      }
      return {
        status: "unknown",
        reason: "The Runtime input outcome could not be determined.",
      };
    }
  }

  public async resize(sessionId: SessionId, columns: number, rows: number): Promise<void> {
    await this.request("agent.resize", {
      sessionId,
      size: {
        cols: columns,
        rows,
      },
    });
  }

  public async interrupt(sessionId: SessionId): Promise<void> {
    await this.request("agent.interrupt", { sessionId });
  }

  public async stop(sessionId: SessionId): Promise<void> {
    await this.request("agent.stop", { sessionId });
  }

  public onEvent(listener: (event: RuntimeClientEvent) => void): { dispose(): void } {
    this.#listeners.add(listener);
    return {
      dispose: () => {
        this.#listeners.delete(listener);
      },
    };
  }

  public async dispose(): Promise<void> {
    if (this.#connectionState === "connected") {
      try {
        await this.request("runtime.shutdown", {});
      } catch {
        // Closing stdin remains the final cleanup signal if graceful shutdown fails.
      }
    }
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(
        new RuntimeRequestFailure(
          "unknown",
          "runtime.disposed",
          "The runtime client was disposed before its response was observed.",
        ),
      );
    }
    this.#pending.clear();
    await this.transport.stop();
    this.setConnection("disconnected", "Runtime disconnected.");
  }

  private acceptChunk(chunk: string): void {
    try {
      for (const frame of this.#decoder.push(chunk)) {
        this.acceptFrame(frame);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setConnection("error", message);
      this.emit({
        type: "runtime.error",
        code: "protocol.invalid-frame",
        message,
        recoverable: false,
      });
    }
  }

  private acceptFrame(frame: string): void {
    let decoded: unknown;
    try {
      decoded = JSON.parse(frame) as unknown;
    } catch {
      throw new ApplicationError("protocol.invalid-json", "Runtime emitted malformed JSON.");
    }
    if (
      !isRecord(decoded) ||
      decoded.schemaVersion !== PROTOCOL_VERSION ||
      typeof decoded.kind !== "string"
    ) {
      throw new ApplicationError(
        "protocol.invalid-envelope",
        "Runtime emitted an invalid protocol envelope.",
      );
    }
    if (decoded.kind === "response") {
      this.acceptResponse(decoded);
      return;
    }
    if (decoded.kind === "event") {
      this.acceptEvent(decoded);
      return;
    }
    throw new ApplicationError(
      "protocol.unexpected-kind",
      `Runtime emitted unexpected message kind "${decoded.kind}".`,
    );
  }

  private acceptResponse(message: Readonly<Record<string, unknown>>): void {
    if (typeof message.id !== "string") {
      throw new ApplicationError("protocol.invalid-response", "Runtime response has no ID.");
    }
    const pending = this.#pending.get(message.id);
    if (pending === undefined) {
      throw new ApplicationError(
        "protocol.unknown-response",
        `Runtime responded to unknown request "${message.id}".`,
      );
    }
    clearTimeout(pending.timeout);
    this.#pending.delete(message.id);
    if (message.ok === true) {
      pending.resolve(message.result);
      return;
    }
    const error = isRecord(message.error) ? message.error : {};
    pending.reject(
      new RuntimeRequestFailure(
        "rejected",
        typeof error.code === "string" ? error.code : "runtime.request-failed",
        typeof error.message === "string" ? error.message : "Runtime request failed.",
        isRecord(error.details) ? error.details : {},
      ),
    );
  }

  private acceptEvent(message: Readonly<Record<string, unknown>>): void {
    if (typeof message.event !== "string") {
      throw new ApplicationError("protocol.invalid-event", "Runtime event has no event name.");
    }
    if (message.event === "runtime.protocol-error") {
      const protocolError = isRecord(message.error) ? message.error : {};
      this.emit({
        type: "runtime.error",
        code:
          typeof protocolError.code === "string" ? protocolError.code : "runtime.protocol-error",
        message:
          typeof protocolError.message === "string"
            ? protocolError.message
            : "Runtime protocol error.",
        recoverable: protocolError.retryable === true,
      });
      return;
    }
    if (typeof message.sessionId !== "string") {
      throw new ApplicationError("protocol.missing-session", "Runtime event has no session ID.");
    }
    const sessionId = SessionIdSchema.parse(message.sessionId);
    if (message.event === "pty.data") {
      if (typeof message.data !== "string" || typeof message.seq !== "number") {
        throw new ApplicationError("protocol.invalid-pty-data", "PTY data event is invalid.");
      }
      this.emit({
        type: "pty.data",
        sessionId,
        sequence: message.seq,
        data: message.data,
      });
      return;
    }
    if (message.event === "pty.started") {
      this.emit({
        type: "session.status",
        sessionId,
        status: "running",
        message: "Agent is running.",
      });
      return;
    }
    if (message.event === "pty.exit") {
      const reason = typeof message.reason === "string" ? message.reason : "exited";
      const status: SessionStatus =
        reason === "stopped" || reason === "interrupted" || reason === "force-killed"
          ? "stopped"
          : message.exitCode === 0
            ? "completed"
            : "failed";
      this.emit({
        type: "session.status",
        sessionId,
        status,
        message:
          status === "completed"
            ? "Agent completed successfully."
            : status === "stopped"
              ? `Agent stopped (${reason}).`
              : `Agent exited with code ${String(message.exitCode)} (${reason}).`,
      });
      return;
    }
    throw new ApplicationError(
      "protocol.unknown-event",
      `Runtime emitted unknown event "${message.event}".`,
    );
  }

  private async request<Method extends RuntimeRequestMethod>(
    method: Method,
    params: RuntimeRequestFor<Method>["params"],
  ): Promise<unknown> {
    if (this.#connectionState !== "connected") {
      throw new RuntimeRequestFailure("rejected", "runtime.not-ready", "The runtime is not ready.");
    }
    const id = this.ids.requestId();
    const result = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(
          new RuntimeRequestFailure(
            "unknown",
            "runtime.timeout",
            `Runtime request "${method}" timed out after ${this.requestTimeoutMs} ms.`,
          ),
        );
      }, this.requestTimeoutMs);
      this.#pending.set(id, { resolve, reject, timeout });
    });
    try {
      await this.transport.write(
        JSON.stringify({
          schemaVersion: PROTOCOL_VERSION,
          kind: "request",
          id,
          method,
          params,
        }),
      );
    } catch (error) {
      const pending = this.#pending.get(id);
      if (pending !== undefined) {
        clearTimeout(pending.timeout);
        this.#pending.delete(id);
        if (error instanceof RuntimeTransportWriteError) {
          pending.reject(
            new RuntimeRequestFailure(
              error.disposition === "not-written" ? "rejected" : "unknown",
              error.disposition === "not-written"
                ? "runtime.transport-not-written"
                : "runtime.transport-write-unknown",
              error.message,
            ),
          );
        } else {
          pending.reject(
            new RuntimeRequestFailure(
              "unknown",
              "runtime.transport-write-unknown",
              "Runtime transport write outcome could not be determined.",
            ),
          );
        }
      }
    }
    return result;
  }
  private handleDisconnect(reason: string): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new RuntimeRequestFailure("unknown", "runtime.disconnected", reason));
    }
    this.#pending.clear();
    this.setConnection("disconnected", reason);
  }

  private setConnection(state: RuntimeConnectionState, message: string): void {
    this.#connectionState = state;
    this.emit({ type: "connection", state, message });
  }

  private emit(event: RuntimeClientEvent): void {
    for (const listener of this.#listeners) {
      listener(event);
    }
  }
}
