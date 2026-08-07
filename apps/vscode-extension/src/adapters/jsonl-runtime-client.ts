import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn } from "node:child_process";

import { RunIdSchema, SessionIdSchema, type RunId, type SessionId } from "@honeybee/domain";
import {
  RUNTIME_PROTOCOL_VERSION,
  RuntimeEventMessageSchema,
  RuntimeHelloSchema,
  RuntimeShutdownResultSchema,
  type RuntimeRequest,
} from "@honeybee/session-runtime";

import { ApplicationError } from "../application/errors.js";
import type {
  IdGeneratorPort,
  RuntimeClientEvent,
  RuntimeClientPort,
  RuntimeConnectionCause,
  RuntimeConnectionState,
  RuntimeHello,
  RuntimeInputOutcome,
  RuntimeShutdownReason,
  RuntimeShutdownResult,
  RuntimeStartRequest,
} from "../application/ports.js";

const PROTOCOL_VERSION = RUNTIME_PROTOCOL_VERSION;
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

/** Content-free trace emitted after a validated Runtime PTY data event is received. */
export interface RuntimePtyDataTrace {
  readonly stage: "runtime-pty-data";
  readonly sessionId: string;
  readonly runId: string;
  readonly sequence: number;
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
      const line = this.#buffer.slice(0, newlineIndex).replace(/\r$/u, "");
      this.#buffer = this.#buffer.slice(newlineIndex + 1);
      if (line.length > 0) frames.push(line);
      newlineIndex = this.#buffer.indexOf("\n");
    }
    return frames;
  }
}

export class NodeChildProcessRuntimeTransport implements RuntimeTransportPort {
  #child: ChildProcessWithoutNullStreams | undefined;

  public constructor(private readonly options: NodeRuntimeTransportOptions) {}

  public async start(handlers: RuntimeTransportHandlers): Promise<void> {
    if (this.#child !== undefined) return;
    const child = spawn(this.options.command, [...this.options.args], {
      ...(this.options.cwd === undefined ? {} : { cwd: this.options.cwd }),
      ...(this.options.environment === undefined ? {} : { env: this.options.environment }),
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#child = child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => handlers.onData(chunk));
    child.stderr.on("data", (chunk: string) => this.options.onDiagnostic?.(chunk));
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
        if (error === null || error === undefined) resolve();
        else {
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
    if (child === undefined) return;
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
  #runtimeHello: RuntimeHello | undefined;
  #intentionalClose = false;
  #shutdownPromise: Promise<RuntimeShutdownResult> | undefined;
  #disposePromise: Promise<void> | undefined;

  public constructor(
    private readonly transport: RuntimeTransportPort,
    private readonly ids: Pick<IdGeneratorPort, "requestId">,
    private readonly requestTimeoutMs = 10_000,
    maxFrameSize = DEFAULT_MAX_FRAME_SIZE,
    private readonly terminalTrace: (event: RuntimePtyDataTrace) => void = () => undefined,
  ) {
    this.#decoder = new JsonLineDecoder(maxFrameSize);
  }

  public get connectionState(): RuntimeConnectionState {
    return this.#connectionState;
  }

  public get runtimeHello(): RuntimeHello | undefined {
    return this.#runtimeHello;
  }

  public async connect(): Promise<void> {
    if (this.#runtimeHello !== undefined && this.#connectionState === "connected") {
      return;
    }
    if (this.#connectionState !== "disconnected") {
      throw new ApplicationError(
        "runtime.connect-conflict",
        "Runtime connection is already active.",
      );
    }
    this.#intentionalClose = false;
    this.setConnection("connecting", "connect", "Connecting to the separate runtime…");
    try {
      await this.transport.start({
        onData: (chunk) => this.acceptChunk(chunk),
        onClose: (reason) => this.handleDisconnect(reason),
        onError: (error) => {
          this.setConnection("error", "runtime-error", error.message);
          this.emit({
            type: "runtime.error",
            code: "runtime.process",
            message: error.message,
            recoverable: true,
          });
        },
      });
      const hello = RuntimeHelloSchema.parse(await this.request("runtime.hello", {}, true));
      this.#runtimeHello = hello;
      this.setConnection("connected", "connect", "Runtime connected.");
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setConnection("error", "runtime-error", message);
      this.#intentionalClose = true;
      await this.transport.stop().catch(() => undefined);
      throw new ApplicationError("runtime.start-failed", message);
    }
  }

  public async start(request: RuntimeStartRequest): Promise<void> {
    await this.request("agent.start", {
      sessionId: request.sessionId,
      runId: request.runId,
      launchSpec: {
        command: request.command,
        args: [...request.args],
        cwd: request.cwd,
        env: request.environment,
        shell: request.shell,
      },
      size: { cols: request.columns, rows: request.rows },
    });
  }

  public async sendInput(
    sessionId: SessionId,
    data: string,
    runId: RunId,
  ): Promise<RuntimeInputOutcome> {
    try {
      await this.request("agent.input", { sessionId, runId, data });
      return { status: "accepted" };
    } catch (error) {
      if (error instanceof RuntimeRequestFailure) {
        return error.outcome === "rejected"
          ? { status: "rejected", message: error.message }
          : { status: "unknown", reason: error.message };
      }
      return { status: "unknown", reason: "The Runtime input outcome could not be determined." };
    }
  }

  public async resize(
    sessionId: SessionId,
    columns: number,
    rows: number,
    runId: RunId,
  ): Promise<void> {
    await this.request("agent.resize", {
      sessionId,
      runId,
      size: { cols: columns, rows },
    });
  }

  public async interrupt(sessionId: SessionId, runId: RunId): Promise<void> {
    await this.request("agent.interrupt", { sessionId, runId });
  }

  public async stop(sessionId: SessionId, runId: RunId): Promise<void> {
    await this.request("agent.stop", { sessionId, runId });
  }

  public shutdown(reason: RuntimeShutdownReason): Promise<RuntimeShutdownResult> {
    this.#shutdownPromise ??= this.#shutdown(reason);
    return this.#shutdownPromise;
  }

  async #shutdown(reason: RuntimeShutdownReason): Promise<RuntimeShutdownResult> {
    this.#intentionalClose = true;
    if (this.#connectionState !== "connected") {
      return { state: "stopped", stoppedRuns: 0, unresolvedRuns: 0 };
    }
    return RuntimeShutdownResultSchema.parse(await this.request("runtime.shutdown", { reason }));
  }

  public onEvent(listener: (event: RuntimeClientEvent) => void): { dispose(): void } {
    this.#listeners.add(listener);
    return { dispose: () => this.#listeners.delete(listener) };
  }

  public dispose(): Promise<void> {
    this.#disposePromise ??= this.#dispose();
    return this.#disposePromise;
  }

  async #dispose(): Promise<void> {
    this.#intentionalClose = true;
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
    this.#runtimeHello = undefined;
    if (this.#connectionState !== "disconnected") {
      this.setConnection("disconnected", "intentional-shutdown", "Runtime disconnected.");
    }
  }

  private acceptChunk(chunk: string): void {
    try {
      for (const frame of this.#decoder.push(chunk)) this.acceptFrame(frame);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setConnection("error", "runtime-error", message);
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
    const parsed = RuntimeEventMessageSchema.safeParse(message);
    if (!parsed.success) {
      throw new ApplicationError("protocol.invalid-event", "Runtime event failed validation.");
    }
    const event = parsed.data;
    if (event.event === "runtime.protocol-error") {
      this.emit({
        type: "runtime.error",
        code: event.error.code,
        message: event.error.message,
        recoverable: event.error.retryable,
      });
      return;
    }
    const sessionId = SessionIdSchema.parse(event.sessionId);
    const runId = RunIdSchema.parse(event.runId);
    if (event.event === "pty.data") {
      this.terminalTrace({
        stage: "runtime-pty-data",
        sessionId,
        runId,
        sequence: event.seq,
      });
      this.emit({
        type: "pty.data",
        sessionId,
        runId,
        sequence: event.seq,
        data: event.data,
      });
      return;
    }
    if (event.event === "pty.started") {
      this.emit({
        type: "session.status",
        sessionId,
        runId,
        sequence: event.seq,
        status: "running",
        message: "Agent is running.",
        logFilePath: event.logFilePath,
      });
      return;
    }

    const exitCode = event.exitCode ?? undefined;
    if (event.reason === "extension-shutdown" || event.reason === "runtime-shutdown") {
      this.emit({
        type: "session.status",
        sessionId,
        runId,
        sequence: event.seq,
        status: "stopped",
        reason: event.reason,
        ...(exitCode === undefined ? {} : { exitCode }),
        message: "Agent stopped during Runtime shutdown.",
      });
      return;
    }
    if (
      event.reason === "stopped" ||
      event.reason === "interrupted" ||
      event.reason === "force-killed"
    ) {
      this.emit({
        type: "session.status",
        sessionId,
        runId,
        sequence: event.seq,
        status: "stopped",
        reason: "user-stop",
        ...(exitCode === undefined ? {} : { exitCode }),
        message: `Agent stopped (${event.reason}).`,
      });
      return;
    }
    if (event.reason === "spawn-failed") {
      this.emit({
        type: "session.status",
        sessionId,
        runId,
        sequence: event.seq,
        status: "failed",
        reason: "start-failed",
        message: "Agent process failed to start.",
      });
      return;
    }
    const completed = exitCode === 0;
    this.emit({
      type: "session.status",
      sessionId,
      runId,
      sequence: event.seq,
      status: completed ? "completed" : "failed",
      reason: completed ? "process-exit-zero" : "process-exit-nonzero",
      ...(exitCode === undefined ? {} : { exitCode }),
      message: completed
        ? "Agent completed successfully."
        : `Agent exited with code ${String(event.exitCode)}.`,
    });
  }

  private async request<Method extends RuntimeRequestMethod>(
    method: Method,
    params: RuntimeRequestFor<Method>["params"],
    allowConnecting = false,
  ): Promise<unknown> {
    if (
      this.#connectionState !== "connected" &&
      !(allowConnecting && this.#connectionState === "connecting")
    ) {
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
    this.#runtimeHello = undefined;
    this.setConnection(
      "disconnected",
      this.#intentionalClose ? "intentional-shutdown" : "unexpected-disconnect",
      reason,
    );
  }

  private setConnection(
    state: RuntimeConnectionState,
    cause: RuntimeConnectionCause,
    message: string,
  ): void {
    this.#connectionState = state;
    this.emit({ type: "connection", state, cause, message });
  }

  private emit(event: RuntimeClientEvent): void {
    for (const listener of this.#listeners) listener(event);
  }
}
