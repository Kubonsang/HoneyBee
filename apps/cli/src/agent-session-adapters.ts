import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { win32 as win32Path } from "node:path";

import {
  AgentApprovalDecisionV1Schema,
  AgentCapabilitiesV1Schema,
  ContentDigestSchema,
  EventIdSchema,
  HoneyBeeCoreError,
  trustedAgentInvocation,
  verifyAgentLaunchTrust,
  type AgentAdapterV1,
  type AgentApprovalDecisionV1,
  type AgentApprovalKindV1,
  type AgentCapabilitiesV1,
  type AgentProcessLifecycle,
  type AgentProcessRequest,
  type AgentProcessResult,
  type AgentProcessRunner,
  type AgentSessionLifecycleEventV1,
  type ContentDigest,
  type UnityWorkPriority,
} from "@honeybee/core";

import { DesktopWorkScheduler } from "./desktop-work-scheduler.js";
import { terminateProcessTree } from "./process-control.js";
import { UnityAgentProcessRunner } from "./unity-adapters.js";

type JsonRpcId = string | number;
type JsonRecord = Record<string, unknown>;

export type AgentSessionTraceChannel =
  "system" | "assistant" | "tool" | "approval" | "stderr" | "raw";

export interface AgentSessionTraceEvent {
  readonly runId: AgentProcessRequest["runId"];
  readonly stepId: AgentProcessRequest["stepId"];
  readonly timestamp: string;
  readonly channel: AgentSessionTraceChannel;
  readonly mode: "readable" | "raw";
  readonly text: string;
  readonly direction?: "provider" | "honeybee";
}

export interface AgentSessionTraceObserver {
  onTrace(event: AgentSessionTraceEvent): void | Promise<void>;
}

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const codexObservedSkillConfiguration = (
  value: unknown,
): Readonly<{ config: readonly Readonly<{ path: string; enabled: false }>[] }> | undefined => {
  if (!isRecord(value) || !Array.isArray(value.data)) return undefined;
  const paths = new Set<string>();
  for (const group of value.data) {
    if (!isRecord(group) || !Array.isArray(group.skills)) continue;
    for (const skill of group.skills) {
      if (isRecord(skill) && typeof skill.path === "string" && skill.path.length > 0) {
        paths.add(skill.path);
      }
    }
  }
  return paths.size === 0
    ? undefined
    : { config: [...paths].sort().map((path) => ({ path, enabled: false as const })) };
};

const digest = (value: string | Buffer): ContentDigest =>
  ContentDigestSchema.parse("sha256:" + createHash("sha256").update(value).digest("hex"));

const SESSION_LAUNCHER = String.raw`
const { spawn } = require("node:child_process");
let registered = false;
let activated = false;
let target;
let closeTimer;
let keepAlive;
const send = (value, done) => {
  if (!process.connected) { if (done) done(); return; }
  process.send(value, undefined, undefined, done);
};
const finish = (code) => {
  if (closeTimer) clearTimeout(closeTimer);
  if (keepAlive) clearInterval(keepAlive);
  process.exitCode = typeof code === "number" ? code : 1;
  if (process.connected) process.disconnect();
};
process.stdout.on("error", () => {});
process.stderr.on("error", () => {});
process.on("message", (message) => {
  if (message && message.type === "register" && !registered) {
    registered = true;
    send({ type: "registered" });
    return;
  }
  if (message && message.type === "activate" && registered && !activated) {
    activated = true;
    try {
      target = spawn(message.command, message.args, {
        cwd: message.cwd,
        env: message.environment,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      send({ type: "target-error" });
      return;
    }
    target.once("error", () => send({ type: "target-error" }));
    target.once("spawn", () => {
      process.stdin.pipe(target.stdin);
      send({ type: "activated" });
    });
    target.stdout.pipe(process.stdout);
    target.stderr.pipe(process.stderr);
    target.once("close", (exitCode, signal) => {
      send({ type: "target-exit", exitCode, signal });
      closeTimer = setTimeout(() => finish(exitCode), 30000);
    });
    return;
  }
  if (message && message.type === "ack-exit") finish(message.exitCode);
});
if (!process.connected) process.exit(0);
keepAlive = setInterval(() => {}, 1000);
`;

export const internalAgentSessionEnvironment = (
  platform: typeof process.platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv => {
  const result: NodeJS.ProcessEnv = {};
  const names =
    platform === "win32"
      ? ["SystemRoot", "WINDIR", "ComSpec", "TEMP", "TMP"]
      : ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"];
  for (const name of names) {
    const value = environment[name];
    if (value !== undefined) result[name] = value;
  }
  if (platform === "win32") result.ELECTRON_RUN_AS_NODE = "1";
  return result;
};

type AgentSessionTrustFiles = Readonly<{
  files: readonly Readonly<{ role: string; path: string }>[];
}>;

const codexTrustEntrypoint = (trust: AgentSessionTrustFiles | undefined): string | undefined =>
  trust?.files.find(
    (file) =>
      file.role === "entrypoint" && win32Path.basename(file.path).toLowerCase() === "codex.exe",
  )?.path;

export const codexAgentSessionExecutable = (
  platform: typeof process.platform,
  trust: AgentSessionTrustFiles | undefined,
  fallback: string,
): string => (platform === "win32" ? (codexTrustEntrypoint(trust) ?? fallback) : fallback);

export const codexAgentSessionEnvironment = (
  platform: typeof process.platform,
  trust: AgentSessionTrustFiles | undefined,
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv => {
  const result = { ...environment };
  if (platform !== "win32" || trust === undefined) return result;
  const entrypoint = codexTrustEntrypoint(trust);
  if (entrypoint === undefined) return result;
  const releaseRoot = win32Path.dirname(win32Path.dirname(entrypoint));
  const resourcesDirectory = win32Path.join(releaseRoot, "codex-resources");
  const pathKey = Object.keys(result).find((name) => name.toLowerCase() === "path") ?? "Path";
  result[pathKey] = [resourcesDirectory, result[pathKey]].filter(Boolean).join(win32Path.delimiter);

  const standaloneMarker = `${win32Path.sep}packages${win32Path.sep}standalone${win32Path.sep}releases${win32Path.sep}`;
  const markerIndex = entrypoint.toLowerCase().indexOf(standaloneMarker);
  if (markerIndex >= 0) {
    const codexHomeKey =
      Object.keys(result).find((name) => name.toLowerCase() === "codex_home") ?? "CODEX_HOME";
    result[codexHomeKey] = entrypoint.slice(0, markerIndex);
  }
  return result;
};

export interface AgentApprovalPort {
  decide(
    request: Readonly<{
      approvalId: ReturnType<typeof EventIdSchema.parse>;
      runId: AgentProcessRequest["runId"];
      stepId: AgentProcessRequest["stepId"];
      kind: AgentApprovalKindV1;
      summary: string;
      serializedRequest: string;
      workspacePath: string;
      signal?: AbortSignal;
    }>,
  ): Promise<AgentApprovalDecisionV1>;
}

export class DenyAgentApprovalPort implements AgentApprovalPort {
  public async decide(
    request: Parameters<AgentApprovalPort["decide"]>[0],
  ): Promise<AgentApprovalDecisionV1> {
    return AgentApprovalDecisionV1Schema.parse({
      schemaVersion: 1,
      approvalId: request.approvalId,
      decision: "deny",
      source: "policy",
      decidedAt: new Date().toISOString(),
    });
  }
}

interface JsonRpcPeerOptions {
  readonly request: AgentProcessRequest;
  readonly lifecycle: AgentProcessLifecycle;
  readonly onMessage: (value: JsonRecord, peer: JsonRpcPeer) => Promise<void>;
  readonly targetEnvironment: NodeJS.ProcessEnv;
  readonly trace?: AgentSessionTraceObserver;
}

class JsonRpcPeer {
  readonly #request: AgentProcessRequest;
  readonly #lifecycle: AgentProcessLifecycle;
  readonly #onMessage: JsonRpcPeerOptions["onMessage"];
  readonly #targetEnvironment: NodeJS.ProcessEnv;
  readonly #traceObserver: AgentSessionTraceObserver | undefined;
  readonly #pending = new Map<
    JsonRpcId,
    { resolve(value: unknown): void; reject(error: unknown): void }
  >();
  readonly #stdoutHash = createHash("sha256");
  readonly #stderrHash = createHash("sha256");
  readonly #stderr: Buffer[] = [];
  readonly #transcript: string[] = [];
  #stdoutBytes = 0;
  #stderrBytes = 0;
  #nextId = 0;
  #buffer = "";
  #child?: ChildProcess;
  #startedAt = 0;
  #exit?: { exitCode: number | null; signal: NodeJS.Signals | null };
  readonly #targetExited: Promise<void>;
  #targetExitResolve?: () => void;
  #closed?: Promise<void>;
  #closeResolve?: () => void;
  readonly #failure: Promise<never>;
  #failureReject?: (error: unknown) => void;
  #failed = false;
  #finishing = false;
  #stopping?: Promise<void>;

  public constructor(options: JsonRpcPeerOptions) {
    this.#request = options.request;
    this.#lifecycle = options.lifecycle;
    this.#onMessage = options.onMessage;
    this.#targetEnvironment = options.targetEnvironment;
    this.#traceObserver = options.trace;
    this.#failure = new Promise<never>((_resolve, reject) => {
      this.#failureReject = reject;
    });
    this.#targetExited = new Promise<void>((resolve) => {
      this.#targetExitResolve = resolve;
    });
  }

  public wait<T>(operation: Promise<T>): Promise<T> {
    return Promise.race([operation, this.#failure]);
  }

  public fail(error: unknown): void {
    if (this.#failed) return;
    this.#failed = true;
    const failure =
      error instanceof Error ? error : new Error("Agent session failed without an Error value.");
    for (const pending of this.#pending.values()) pending.reject(failure);
    this.#pending.clear();
    this.#failureReject?.(failure);
  }

  public get pid(): number {
    const pid = this.#child?.pid;
    if (pid === undefined) throw new Error("Agent containment process has no PID.");
    return pid;
  }

  public get hasProcess(): boolean {
    return this.#child?.pid !== undefined;
  }

  public stderr(): string {
    return Buffer.concat(this.#stderr).toString("utf8");
  }

  public transcript(): string {
    return this.#transcript.join("\n") + "\n";
  }

  public trace(channel: Exclude<AgentSessionTraceChannel, "raw" | "stderr">, text: string): void {
    this.#emitTrace({ channel, mode: "readable", text });
  }

  #emitTrace(event: Pick<AgentSessionTraceEvent, "channel" | "mode" | "text" | "direction">): void {
    if (event.text.length === 0) return;
    const value: AgentSessionTraceEvent = {
      runId: this.#request.runId,
      stepId: this.#request.stepId,
      timestamp: new Date().toISOString(),
      ...event,
    };
    try {
      void Promise.resolve(this.#traceObserver?.onTrace(value)).catch(() => undefined);
    } catch {
      // Live trace is best effort and must never affect Agent execution.
    }
  }

  public async start(): Promise<void> {
    const command = this.#request.command;
    this.#startedAt = Date.now();
    const child = spawn(process.execPath, ["-e", SESSION_LAUNCHER], {
      cwd: command.cwd ?? process.cwd(),
      env: internalAgentSessionEnvironment(),
      stdio: ["pipe", "pipe", "pipe", "ipc"],
      windowsHide: true,
    });
    this.#child = child;
    this.#closed = new Promise<void>((resolve) => {
      this.#closeResolve = resolve;
    });
    child.stdout?.on("data", (chunk: Buffer | string) => this.#acceptStdout(chunk));
    child.stderr?.on("data", (chunk: Buffer | string) => this.#acceptStderr(chunk));
    child.on("message", (value: unknown) => {
      if (!isRecord(value) || value.type !== "target-exit") return;
      this.#exit = {
        exitCode: typeof value.exitCode === "number" ? value.exitCode : null,
        signal: typeof value.signal === "string" ? (value.signal as NodeJS.Signals) : null,
      };
      this.#targetExitResolve?.();
      if (!this.#finishing) {
        this.fail(
          new HoneyBeeCoreError(
            "protocol.invalid-agent-response",
            "The Agent provider exited before completing the session protocol.",
          ),
        );
      }
    });
    child.once("error", (error) => this.fail(error));
    child.once("close", () => {
      this.#closeResolve?.();
      if (!this.#finishing) {
        this.fail(
          new HoneyBeeCoreError(
            "protocol.invalid-agent-response",
            "The Agent provider exited before completing the session protocol.",
          ),
        );
      }
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", () => resolve());
      child.once("error", reject);
    });
    await this.#lifecycle.onStarted(this.pid, { containment: "deferred-v1" });
    await this.#exchange("register", "registered");
    await this.#lifecycle.onRegistered?.(this.pid);
    await this.#exchange("activate", "activated", {
      command: command.command,
      args: command.args ?? [],
      cwd: command.cwd ?? process.cwd(),
      environment: {
        ...this.#targetEnvironment,
        HONEYBEE_RUN_ID: this.#request.runId,
        HONEYBEE_STEP_ID: this.#request.stepId,
      },
    });
  }

  async #exchange(sentType: string, expectedType: string, payload: JsonRecord = {}): Promise<void> {
    const child = this.#child;
    if (child === undefined) throw new Error("Agent containment process is not started.");
    await new Promise<void>((resolve, reject) => {
      const listener = (value: unknown): void => {
        if (!isRecord(value)) return;
        if (value.type === "target-error") {
          cleanup();
          reject(new Error("Agent provider process could not be started."));
        } else if (value.type === expectedType) {
          cleanup();
          resolve();
        }
      };
      const cleanup = (): void => {
        child.off("message", listener);
      };
      child.on("message", listener);
      child.send({ type: sentType, ...payload }, (error) => {
        if (error !== null) {
          cleanup();
          reject(error);
        }
      });
    });
  }

  public notify(method: string, params: unknown): void {
    void this.#write({ jsonrpc: "2.0", method, params }).catch((error: unknown) => {
      this.fail(error);
      void this.stop("input-write");
    });
  }

  public request(method: string, params: unknown): Promise<unknown> {
    const id = ++this.#nextId;
    const result = new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
    void this.#write({ jsonrpc: "2.0", id, method, params }).catch((error: unknown) => {
      const pending = this.#pending.get(id);
      this.#pending.delete(id);
      pending?.reject(error);
    });
    return result;
  }

  public async respond(id: JsonRpcId, result: unknown): Promise<void> {
    await this.#write({ jsonrpc: "2.0", id, result });
  }

  async #write(value: unknown): Promise<void> {
    const stdin = this.#child?.stdin;
    if (stdin === null || stdin === undefined || !stdin.writable) {
      throw new HoneyBeeCoreError(
        "agent.input-write-failed",
        "The Agent session input channel is unavailable.",
      );
    }
    const serialized = JSON.stringify(value);
    this.#transcript.push(serialized);
    this.#emitTrace({
      channel: "raw",
      mode: "raw",
      direction: "honeybee",
      text: serialized,
    });
    await new Promise<void>((resolve, reject) => {
      stdin.write(serialized + "\n", "utf8", (error) => {
        if (error === null || error === undefined) resolve();
        else reject(error);
      });
    });
  }

  #acceptStdout(chunkValue: Buffer | string): void {
    const chunk = Buffer.isBuffer(chunkValue) ? chunkValue : Buffer.from(chunkValue);
    this.#stdoutBytes += chunk.byteLength;
    this.#stdoutHash.update(chunk);
    if (this.#stdoutBytes + this.#stderrBytes > this.#request.maxOutputBytes) {
      this.fail(
        new HoneyBeeCoreError("agent.output-limit", "Agent session output limit exceeded."),
      );
      void this.stop("output-limit");
      return;
    }
    this.#buffer += chunk.toString("utf8");
    for (;;) {
      const newline = this.#buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line.length === 0) continue;
      let value: unknown;
      try {
        value = JSON.parse(line) as unknown;
      } catch {
        this.fail(
          new HoneyBeeCoreError(
            "protocol.invalid-agent-response",
            "The Agent provider emitted invalid JSON-RPC output.",
          ),
        );
        void this.stop("protocol");
        return;
      }
      if (!isRecord(value)) continue;
      this.#transcript.push(line);
      this.#emitTrace({
        channel: "raw",
        mode: "raw",
        direction: "provider",
        text: line,
      });
      if (value.id !== undefined && (value.result !== undefined || value.error !== undefined)) {
        const pending = this.#pending.get(value.id as JsonRpcId);
        if (pending === undefined) continue;
        this.#pending.delete(value.id as JsonRpcId);
        if (value.error === undefined) pending.resolve(value.result);
        else pending.reject(new Error("Agent provider JSON-RPC request failed."));
      } else {
        void this.#onMessage(value, this).catch(() => this.stop("protocol"));
      }
    }
  }

  #acceptStderr(chunkValue: Buffer | string): void {
    const chunk = Buffer.isBuffer(chunkValue) ? chunkValue : Buffer.from(chunkValue);
    this.#stderrBytes += chunk.byteLength;
    this.#stderrHash.update(chunk);
    this.#emitTrace({ channel: "stderr", mode: "readable", text: chunk.toString("utf8") });
    if (this.#stderrBytes <= this.#request.maxOutputBytes) this.#stderr.push(chunk);
    if (this.#stdoutBytes + this.#stderrBytes > this.#request.maxOutputBytes) {
      this.fail(
        new HoneyBeeCoreError("agent.output-limit", "Agent session output limit exceeded."),
      );
      void this.stop("output-limit");
    }
  }

  public stop(_reason: string): Promise<void> {
    this.#stopping ??= this.#stop();
    return this.#stopping;
  }

  async #stop(): Promise<void> {
    const child = this.#child;
    if (child === undefined) return;
    await terminateProcessTree(this.pid).catch(() => undefined);
    await this.#closed;
  }

  public async finish(
    termination: AgentProcessResult["termination"],
    stdout: string,
    protocolCompleted = false,
  ): Promise<AgentProcessResult> {
    this.#finishing = true;
    const child = this.#child;
    if (child === undefined) throw new Error("Agent containment process was not started.");
    const stopped = this.#stopping !== undefined;
    if (this.#stopping !== undefined) await this.#stopping;
    child.stdin?.end();
    const targetExited =
      !stopped &&
      (this.#exit !== undefined ||
        (await Promise.race([
          this.#targetExited.then(() => true),
          new Promise<false>((resolve) => setTimeout(() => resolve(false), 1_000)),
        ])));
    if (!stopped && !targetExited) {
      await terminateProcessTree(this.pid);
      await this.#closed;
    }
    const output = Buffer.from(stdout, "utf8");
    const providerExit =
      this.#exit ??
      (protocolCompleted
        ? {
            exitCode: 0,
            signal: null,
          }
        : undefined);
    const observation = {
      pid: this.pid,
      exitCode: providerExit?.exitCode ?? null,
      signal: providerExit?.signal ?? null,
      durationMs: Date.now() - this.#startedAt,
      stdoutBytes: output.byteLength,
      stderrBytes: this.#stderrBytes,
      stdoutDigest: digest(output),
      stderrDigest: ContentDigestSchema.parse("sha256:" + this.#stderrHash.digest("hex")),
    };
    await this.#lifecycle.onExited(observation);
    if (targetExited) {
      await new Promise<void>((resolve, reject) => {
        child.send?.({ type: "ack-exit", exitCode: observation.exitCode }, (error) => {
          if (error === null) resolve();
          else reject(error);
        });
      });
      await this.#closed;
    }
    return {
      ...observation,
      stepId: this.#request.stepId,
      command: this.#request.command.command,
      termination,
      stdout,
      stderr: this.stderr(),
    };
  }
}

export interface AgentSessionAdapter {
  readonly kind: Exclude<AgentAdapterV1, "stdio-framed-v2">;
  capabilities(): AgentCapabilitiesV1;
  run(
    request: AgentProcessRequest,
    lifecycle: AgentProcessLifecycle,
    approval: AgentApprovalPort,
  ): Promise<AgentProcessResult>;
}

abstract class JsonRpcAgentSessionAdapter implements AgentSessionAdapter {
  public abstract readonly kind: Exclude<AgentAdapterV1, "stdio-framed-v2">;
  protected output = "";
  protected turnId: string = randomUUID();
  protected turnDone?: (status: "completed" | "failed" | "interrupted") => void;
  protected observer: ((event: AgentSessionLifecycleEventV1) => Promise<void>) | undefined;
  readonly #traceObserver: AgentSessionTraceObserver | undefined;

  public constructor(traceObserver?: AgentSessionTraceObserver) {
    this.#traceObserver = traceObserver;
  }

  public abstract capabilities(): AgentCapabilitiesV1;
  protected abstract initialize(peer: JsonRpcPeer, request: AgentProcessRequest): Promise<void>;
  protected abstract interrupt(peer: JsonRpcPeer): void;
  protected abstract handleProviderMessage(
    value: JsonRecord,
    peer: JsonRpcPeer,
    request: AgentProcessRequest,
    approval: AgentApprovalPort,
  ): Promise<void>;

  protected targetEnvironment(request: AgentProcessRequest): NodeJS.ProcessEnv {
    return { ...process.env, ...request.command.env };
  }

  public async run(
    request: AgentProcessRequest,
    lifecycle: AgentProcessLifecycle,
    approval: AgentApprovalPort,
  ): Promise<AgentProcessResult> {
    const observer = lifecycle.onSessionEvent;
    this.observer = observer;
    this.output = "";
    this.turnId = randomUUID();
    let status: "completed" | "failed" | "interrupted" = "failed";
    const peer = new JsonRpcPeer({
      request,
      lifecycle,
      targetEnvironment: this.targetEnvironment(request),
      ...(this.#traceObserver === undefined ? {} : { trace: this.#traceObserver }),
      onMessage: (value, activePeer) =>
        this.handleProviderMessage(value, activePeer, request, approval),
    });
    const sessionId = randomUUID();
    const completion = new Promise<"completed" | "failed" | "interrupted">((resolve) => {
      this.turnDone = resolve;
    });
    let timedOut = false;
    let sessionOpened = false;
    let turnStarted = false;
    const abort = (): void => {
      const error = new HoneyBeeCoreError("agent.cancelled", "Agent session was cancelled.");
      peer.fail(error);
      this.interrupt(peer);
      this.turnDone?.("interrupted");
      void peer.stop("cancelled");
    };
    request.signal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      const error = new HoneyBeeCoreError("agent.timed-out", "Agent session timed out.");
      peer.fail(error);
      this.interrupt(peer);
      this.turnDone?.("interrupted");
      void peer.stop("timeout");
    }, request.timeoutMs);
    let runError: unknown;
    let lifecycleError: unknown;
    try {
      peer.trace("system", `Opening ${this.kind} Agent session.`);
      await peer.wait(peer.start());
      await peer.wait(
        observer?.({
          type: "session-opened",
          adapter: this.kind,
          sessionIdDigest: digest(sessionId),
          capabilities: this.capabilities(),
        }) ?? Promise.resolve(),
      );
      sessionOpened = true;
      peer.trace("system", "Agent session opened.");
      await peer.wait(
        observer?.({ type: "turn-started", turnIdDigest: digest(this.turnId) }) ??
          Promise.resolve(),
      );
      turnStarted = true;
      peer.trace("system", "Agent turn started.");
      await peer.wait(this.initialize(peer, request));
      status = await peer.wait(completion);
    } catch (error) {
      runError = error;
      status =
        error instanceof HoneyBeeCoreError &&
        ["transaction.interrupted", "agent.cancelled", "agent.timed-out"].includes(error.code)
          ? "interrupted"
          : "failed";
      peer.trace(
        "system",
        error instanceof Error
          ? `Agent session ${status}: ${error.message}`
          : `Agent session ${status}.`,
      );
    } finally {
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", abort);
      try {
        if (turnStarted) {
          peer.trace("system", `Agent turn ${status}.`);
          await observer?.({
            type: "turn-completed",
            turnIdDigest: digest(this.turnId),
            status,
            outputBytes: Buffer.byteLength(this.output),
          });
        }
        if (sessionOpened) {
          await observer?.({
            type: "session-closed",
            reason: status === "completed" ? "completed" : status,
            serializedTranscript: peer.transcript(),
          });
        }
      } catch (error) {
        lifecycleError = error;
      }
    }
    const result = peer.hasProcess
      ? await peer.finish(
          status === "interrupted"
            ? request.signal?.aborted === true
              ? "cancelled"
              : timedOut
                ? "timed-out"
                : "cancelled"
            : "exited",
          this.output,
          status === "completed",
        )
      : undefined;
    if (runError !== undefined) throw runError;
    if (lifecycleError !== undefined) throw lifecycleError;
    if (result === undefined) {
      throw new HoneyBeeCoreError("agent.spawn-failed", "Agent session process did not start.");
    }
    return result;
  }

  protected async approvalRoundTrip(
    peer: JsonRpcPeer,
    request: AgentProcessRequest,
    approval: AgentApprovalPort,
    providerRequestId: JsonRpcId,
    kind: AgentApprovalKindV1,
    params: unknown,
    result: (decision: AgentApprovalDecisionV1) => unknown,
  ): Promise<void> {
    const approvalId = EventIdSchema.parse(randomUUID());
    const serializedRequest = JSON.stringify(params);
    const summary =
      kind === "command"
        ? "Agent requests permission to run a command."
        : kind === "file-change"
          ? "Agent requests permission to change files."
          : "Agent requests additional permission.";
    await this.observer?.({
      type: "approval-requested",
      approvalId,
      providerRequestId,
      kind,
      summary,
      serializedRequest,
    });
    peer.trace("approval", summary);
    const decision = await approval.decide({
      approvalId,
      runId: request.runId,
      stepId: request.stepId,
      kind,
      summary,
      serializedRequest,
      workspacePath: request.command.cwd ?? process.cwd(),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    await this.observer?.({ type: "approval-resolved", decision });
    peer.trace(
      "approval",
      decision.decision === "allow-once" ? "Agent action allowed once." : "Agent action denied.",
    );
    try {
      await peer.respond(providerRequestId, result(decision));
    } catch (error) {
      throw new HoneyBeeCoreError(
        "transaction.interrupted",
        "The durable Agent approval could not be delivered conclusively.",
        request.stepId,
        { cause: error },
      );
    }
    await this.observer?.({ type: "approval-delivered", approvalId });
  }
}

export class CodexAppServerAdapter extends JsonRpcAgentSessionAdapter {
  public readonly kind = "codex-app-server-v1" as const;
  #threadId?: string;
  #providerTurnId?: string;

  public capabilities(): AgentCapabilitiesV1 {
    return AgentCapabilitiesV1Schema.parse({
      schemaVersion: 1,
      adapter: this.kind,
      toolApproval: "root-only",
      skills: "observe-only",
      plan: "unsupported",
      resume: "unsupported",
      steer: "unsupported",
      userInput: "unsupported",
      subagentApproval: "unsupported",
      plugins: "disabled",
    });
  }

  protected override targetEnvironment(request: AgentProcessRequest): NodeJS.ProcessEnv {
    return codexAgentSessionEnvironment(
      process.platform,
      request.trust,
      super.targetEnvironment(request),
    );
  }

  protected async initialize(peer: JsonRpcPeer, request: AgentProcessRequest): Promise<void> {
    await peer.request("initialize", {
      clientInfo: { name: "HoneyBee", title: "HoneyBee Desktop", version: "0.7.0" },
      capabilities: { experimentalApi: true },
    });
    peer.notify("initialized", {});
    const observedSkills = await peer.request("skills/list", {
      cwds: [request.command.cwd ?? process.cwd()],
      forceReload: true,
    });
    const skills = codexObservedSkillConfiguration(observedSkills);
    await this.observer?.({
      type: "skills-observed",
      isolation: "observe-only",
      serializedManifest: JSON.stringify(observedSkills),
    });
    const started = await peer.request("thread/start", {
      cwd: request.command.cwd ?? process.cwd(),
      ephemeral: true,
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      config: {
        features: { plugins: false },
        model_reasoning_effort: "low",
        ...(skills === undefined ? {} : { skills }),
      },
    });
    const thread = isRecord(started) && isRecord(started.thread) ? started.thread : undefined;
    if (thread === undefined || typeof thread.id !== "string") {
      throw new HoneyBeeCoreError(
        "protocol.invalid-agent-response",
        "Codex did not return a valid thread identity.",
      );
    }
    this.#threadId = thread.id;
    const turn = await peer.request("turn/start", {
      threadId: thread.id,
      cwd: request.command.cwd ?? process.cwd(),
      input: [{ type: "text", text: request.prompt }],
      approvalPolicy: "on-request",
      effort: "low",
    });
    if (isRecord(turn) && isRecord(turn.turn) && typeof turn.turn.id === "string") {
      this.#providerTurnId = turn.turn.id;
    }
  }

  protected interrupt(peer: JsonRpcPeer): void {
    if (this.#threadId !== undefined) {
      peer.notify("turn/interrupt", {
        threadId: this.#threadId,
        turnId: this.#providerTurnId ?? this.turnId,
      });
    }
  }

  protected async handleProviderMessage(
    value: JsonRecord,
    peer: JsonRpcPeer,
    request: AgentProcessRequest,
    approval: AgentApprovalPort,
  ): Promise<void> {
    const method = typeof value.method === "string" ? value.method : "";
    const params = isRecord(value.params) ? value.params : {};
    if (method === "item/agentMessage/delta" && typeof params.delta === "string") {
      this.output += params.delta;
      peer.trace("assistant", params.delta);
    } else if (method === "turn/completed") {
      const turn = isRecord(params.turn) ? params.turn : params;
      const rawStatus = typeof turn.status === "string" ? turn.status : "completed";
      this.turnDone?.(rawStatus === "completed" ? "completed" : "failed");
    } else if (
      !method.endsWith("/requestApproval") &&
      (method.includes("commandExecution") || method.includes("fileChange"))
    ) {
      const item = isRecord(params.item) ? params.item : params;
      const delta = typeof params.delta === "string" ? params.delta : undefined;
      const command = typeof item.command === "string" ? item.command : undefined;
      const pathValue = typeof item.path === "string" ? item.path : undefined;
      peer.trace("tool", delta ?? command ?? pathValue ?? method.replaceAll("/", " · "));
    } else if (
      value.id !== undefined &&
      [
        "item/commandExecution/requestApproval",
        "item/fileChange/requestApproval",
        "item/permissions/requestApproval",
      ].includes(method)
    ) {
      const kind: AgentApprovalKindV1 = method.includes("commandExecution")
        ? "command"
        : method.includes("fileChange")
          ? "file-change"
          : "permissions";
      await this.approvalRoundTrip(
        peer,
        request,
        approval,
        value.id as JsonRpcId,
        kind,
        params,
        (decision) => ({ decision: decision.decision === "allow-once" ? "accept" : "decline" }),
      );
    } else if (value.id !== undefined) {
      await peer.respond(value.id as JsonRpcId, { decision: "decline" });
    }
  }
}

export class OpenCodeAcpAdapter extends JsonRpcAgentSessionAdapter {
  public readonly kind = "opencode-acp-v1" as const;
  #sessionId?: string;

  public capabilities(): AgentCapabilitiesV1 {
    return AgentCapabilitiesV1Schema.parse({
      schemaVersion: 1,
      adapter: this.kind,
      toolApproval: "root-only",
      skills: "observe-only",
      plan: "unsupported",
      resume: "unsupported",
      steer: "unsupported",
      userInput: "unsupported",
      subagentApproval: "unsupported",
      plugins: "disabled",
    });
  }

  protected async initialize(peer: JsonRpcPeer, request: AgentProcessRequest): Promise<void> {
    await peer.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "HoneyBee", title: "HoneyBee Desktop", version: "0.7.0" },
    });
    const created = await peer.request("session/new", {
      cwd: request.command.cwd ?? process.cwd(),
      mcpServers: [],
    });
    if (!isRecord(created) || typeof created.sessionId !== "string") {
      throw new HoneyBeeCoreError(
        "protocol.invalid-agent-response",
        "OpenCode ACP did not return a valid session identity.",
      );
    }
    this.#sessionId = created.sessionId;
    void peer
      .request("session/prompt", {
        sessionId: created.sessionId,
        prompt: [{ type: "text", text: request.prompt }],
      })
      .then(
        () => this.turnDone?.("completed"),
        () => this.turnDone?.("failed"),
      );
  }

  protected interrupt(peer: JsonRpcPeer): void {
    if (this.#sessionId !== undefined) {
      peer.notify("session/cancel", { sessionId: this.#sessionId });
    }
  }

  protected async handleProviderMessage(
    value: JsonRecord,
    peer: JsonRpcPeer,
    request: AgentProcessRequest,
    approval: AgentApprovalPort,
  ): Promise<void> {
    const method = typeof value.method === "string" ? value.method : "";
    const params = isRecord(value.params) ? value.params : {};
    if (method === "session/update") {
      const update = isRecord(params.update) ? params.update : {};
      const content = isRecord(update.content) ? update.content : {};
      if (update.sessionUpdate === "agent_message_chunk" && typeof content.text === "string") {
        this.output += content.text;
        peer.trace("assistant", content.text);
      } else if (
        typeof update.sessionUpdate === "string" &&
        update.sessionUpdate.includes("tool")
      ) {
        const title = typeof update.title === "string" ? update.title : update.sessionUpdate;
        const text = typeof content.text === "string" ? content.text : title;
        peer.trace("tool", text);
      }
      return;
    }
    if (method === "session/request_permission" && value.id !== undefined) {
      await this.approvalRoundTrip(
        peer,
        request,
        approval,
        value.id as JsonRpcId,
        "command",
        params,
        (decision) => {
          const options = Array.isArray(params.options) ? params.options.filter(isRecord) : [];
          const desired =
            decision.decision === "allow-once"
              ? options.find((option) => option.kind === "allow_once")
              : options.find((option) => String(option.kind).startsWith("reject"));
          const optionId = desired?.optionId;
          return typeof optionId === "string"
            ? { outcome: { outcome: "selected", optionId } }
            : { outcome: { outcome: "cancelled" } };
        },
      );
    } else if (value.id !== undefined) {
      await peer.respond(value.id as JsonRpcId, null);
    }
  }
}

export interface AgentSessionProcessRunnerOptions {
  readonly scheduler?: DesktopWorkScheduler;
  readonly approval?: AgentApprovalPort;
  readonly priority?: (request: AgentProcessRequest) => UnityWorkPriority;
  readonly trace?: AgentSessionTraceObserver;
}

export class AgentSessionProcessRunner implements AgentProcessRunner {
  readonly #legacy: AgentProcessRunner;
  readonly #scheduler: DesktopWorkScheduler;
  readonly #approval: AgentApprovalPort;
  readonly #priority: (request: AgentProcessRequest) => UnityWorkPriority;
  readonly #trace: AgentSessionTraceObserver | undefined;

  public constructor(
    legacy: AgentProcessRunner = new UnityAgentProcessRunner(),
    options: AgentSessionProcessRunnerOptions = {},
  ) {
    this.#legacy = legacy;
    this.#scheduler = options.scheduler ?? new DesktopWorkScheduler(4);
    this.#approval = options.approval ?? new DenyAgentApprovalPort();
    this.#priority = options.priority ?? (() => "validation");
    this.#trace = options.trace;
  }

  public async run(
    request: AgentProcessRequest,
    lifecycle: AgentProcessLifecycle,
  ): Promise<AgentProcessResult> {
    if (request.adapter === undefined || request.adapter === "stdio-framed-v2") {
      this.#emitTrace(
        request,
        "system",
        "This Agent uses framed stdio. HoneyBee can show lifecycle status now; token-level output becomes available only with a structured Codex or OpenCode adapter.",
      );
      try {
        const result = await this.#legacy.run(request, lifecycle);
        if (result.stderr.length > 0) this.#emitTrace(request, "stderr", result.stderr);
        this.#emitTrace(request, "system", "Framed stdio Agent process completed.");
        return result;
      } catch (error) {
        this.#emitTrace(
          request,
          "system",
          error instanceof Error
            ? `Framed stdio Agent process failed: ${error.message}`
            : "Framed stdio Agent process failed.",
        );
        throw error;
      }
    }
    if (request.trust === undefined) {
      throw new HoneyBeeCoreError(
        "agent.trust-required",
        "Agent session execution requires an approved launch trust receipt.",
      );
    }
    await verifyAgentLaunchTrust(request.command, request.trust);
    const trustedCommand = await trustedAgentInvocation(request.command, request.trust);
    const invocationRequest: AgentProcessRequest = {
      ...request,
      command:
        request.adapter === "codex-app-server-v1"
          ? {
              ...trustedCommand,
              command: codexAgentSessionExecutable(
                process.platform,
                request.trust,
                trustedCommand.command,
              ),
            }
          : trustedCommand,
    };
    const adapter: AgentSessionAdapter =
      request.adapter === "codex-app-server-v1"
        ? new CodexAppServerAdapter(this.#trace)
        : new OpenCodeAcpAdapter(this.#trace);
    const result = await this.#scheduler.withSlot(
      {
        priority: this.#priority(request),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        onQueued: () =>
          lifecycle.onSessionEvent?.({ type: "admission-queued" }) ?? Promise.resolve(),
        onEntered: (waitMs) =>
          lifecycle.onSessionEvent?.({ type: "admission-entered", waitMs }) ?? Promise.resolve(),
      },
      () => adapter.run(invocationRequest, lifecycle, this.#approval),
    );
    return { ...result, command: request.command.command };
  }

  #emitTrace(request: AgentProcessRequest, channel: "system" | "stderr", text: string): void {
    try {
      void Promise.resolve(
        this.#trace?.onTrace({
          runId: request.runId,
          stepId: request.stepId,
          timestamp: new Date().toISOString(),
          channel,
          mode: "readable",
          text,
        }),
      ).catch(() => undefined);
    } catch {
      // Optional Desktop observability must not affect legacy execution.
    }
  }
}
