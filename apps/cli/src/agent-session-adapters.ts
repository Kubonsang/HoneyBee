import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";

import {
  AgentApprovalDecisionV1Schema,
  AgentCapabilitiesV1Schema,
  ContentDigestSchema,
  EventIdSchema,
  HoneyBeeCoreError,
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

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

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

const internalEnvironment = (): NodeJS.ProcessEnv => {
  const result: NodeJS.ProcessEnv = {};
  const names =
    process.platform === "win32"
      ? ["SystemRoot", "WINDIR", "ComSpec", "TEMP", "TMP"]
      : ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"];
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined) result[name] = value;
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
}

class JsonRpcPeer {
  readonly #request: AgentProcessRequest;
  readonly #lifecycle: AgentProcessLifecycle;
  readonly #onMessage: JsonRpcPeerOptions["onMessage"];
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
  #closed?: Promise<void>;
  #closeResolve?: () => void;
  #closeReject?: (error: unknown) => void;

  public constructor(options: JsonRpcPeerOptions) {
    this.#request = options.request;
    this.#lifecycle = options.lifecycle;
    this.#onMessage = options.onMessage;
  }

  public get pid(): number {
    const pid = this.#child?.pid;
    if (pid === undefined) throw new Error("Agent containment process has no PID.");
    return pid;
  }

  public stderr(): string {
    return Buffer.concat(this.#stderr).toString("utf8");
  }

  public transcript(): string {
    return this.#transcript.join("\n") + "\n";
  }

  public async start(): Promise<void> {
    const command = this.#request.command;
    this.#startedAt = Date.now();
    const child = spawn(process.execPath, ["-e", SESSION_LAUNCHER], {
      cwd: command.cwd ?? process.cwd(),
      env: internalEnvironment(),
      stdio: ["pipe", "pipe", "pipe", "ipc"],
      windowsHide: true,
    });
    this.#child = child;
    this.#closed = new Promise<void>((resolve, reject) => {
      this.#closeResolve = resolve;
      this.#closeReject = reject;
    });
    child.stdout?.on("data", (chunk: Buffer | string) => this.#acceptStdout(chunk));
    child.stderr?.on("data", (chunk: Buffer | string) => this.#acceptStderr(chunk));
    child.once("error", (error) => this.#closeReject?.(error));
    child.once("close", () => this.#closeResolve?.());
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
        ...process.env,
        ...command.env,
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
    void this.#write({ jsonrpc: "2.0", method, params }).catch(() => this.stop("input-write"));
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
        void this.stop("protocol");
        return;
      }
      if (!isRecord(value)) continue;
      this.#transcript.push(line);
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
    if (this.#stderrBytes <= this.#request.maxOutputBytes) this.#stderr.push(chunk);
    if (this.#stdoutBytes + this.#stderrBytes > this.#request.maxOutputBytes) {
      void this.stop("output-limit");
    }
  }

  public async stop(_reason: string): Promise<void> {
    const child = this.#child;
    if (child === undefined) return;
    await terminateProcessTree(this.pid).catch(() => undefined);
    await this.#closed;
  }

  public async finish(
    termination: AgentProcessResult["termination"],
    stdout: string,
  ): Promise<AgentProcessResult> {
    const child = this.#child;
    if (child === undefined) throw new Error("Agent containment process was not started.");
    const targetExited = await new Promise<boolean>((resolve) => {
      const listener = (value: unknown): void => {
        if (!isRecord(value) || value.type !== "target-exit") return;
        this.#exit = {
          exitCode: typeof value.exitCode === "number" ? value.exitCode : null,
          signal: typeof value.signal === "string" ? (value.signal as NodeJS.Signals) : null,
        };
        child.off("message", listener);
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        child.off("message", listener);
        resolve(false);
      }, 1_000);
      child.on("message", listener);
      child.stdin?.end();
    });
    if (!targetExited) {
      await terminateProcessTree(this.pid);
      await this.#closed;
    }
    const output = Buffer.from(stdout, "utf8");
    const observation = {
      pid: this.pid,
      exitCode: this.#exit?.exitCode ?? null,
      signal: this.#exit?.signal ?? null,
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

  public abstract capabilities(): AgentCapabilitiesV1;
  protected abstract initialize(peer: JsonRpcPeer, request: AgentProcessRequest): Promise<void>;
  protected abstract interrupt(peer: JsonRpcPeer): void;
  protected abstract handleProviderMessage(
    value: JsonRecord,
    peer: JsonRpcPeer,
    request: AgentProcessRequest,
    approval: AgentApprovalPort,
  ): Promise<void>;

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
      onMessage: (value, activePeer) =>
        this.handleProviderMessage(value, activePeer, request, approval),
    });
    await peer.start();
    const sessionId = randomUUID();
    await observer?.({
      type: "session-opened",
      adapter: this.kind,
      sessionIdDigest: digest(sessionId),
      capabilities: this.capabilities(),
    });
    const completion = new Promise<"completed" | "failed" | "interrupted">((resolve) => {
      this.turnDone = resolve;
    });
    const abort = (): void => {
      this.interrupt(peer);
      this.turnDone?.("interrupted");
    };
    request.signal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(() => {
      this.interrupt(peer);
      this.turnDone?.("interrupted");
    }, request.timeoutMs);
    let runError: unknown;
    await observer?.({ type: "turn-started", turnIdDigest: digest(this.turnId) });
    try {
      await this.initialize(peer, request);
      status = await completion;
    } catch (error) {
      runError = error;
      status =
        error instanceof HoneyBeeCoreError && error.code === "transaction.interrupted"
          ? "interrupted"
          : "failed";
    } finally {
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", abort);
      await observer?.({
        type: "turn-completed",
        turnIdDigest: digest(this.turnId),
        status,
        outputBytes: Buffer.byteLength(this.output),
      });
      await observer?.({
        type: "session-closed",
        reason: status === "completed" ? "completed" : status,
        serializedTranscript: peer.transcript(),
      });
    }
    const result = await peer.finish(
      status === "interrupted"
        ? request.signal?.aborted === true
          ? "cancelled"
          : "timed-out"
        : "exited",
      this.output,
    );
    if (runError !== undefined) throw runError;
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
    } else if (method === "turn/completed") {
      const turn = isRecord(params.turn) ? params.turn : params;
      const rawStatus = typeof turn.status === "string" ? turn.status : "completed";
      this.turnDone?.(rawStatus === "completed" ? "completed" : "failed");
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
}

export class AgentSessionProcessRunner implements AgentProcessRunner {
  readonly #legacy: AgentProcessRunner;
  readonly #scheduler: DesktopWorkScheduler;
  readonly #approval: AgentApprovalPort;
  readonly #priority: (request: AgentProcessRequest) => UnityWorkPriority;

  public constructor(
    legacy: AgentProcessRunner = new UnityAgentProcessRunner(),
    options: AgentSessionProcessRunnerOptions = {},
  ) {
    this.#legacy = legacy;
    this.#scheduler = options.scheduler ?? new DesktopWorkScheduler(4);
    this.#approval = options.approval ?? new DenyAgentApprovalPort();
    this.#priority = options.priority ?? (() => "validation");
  }

  public async run(
    request: AgentProcessRequest,
    lifecycle: AgentProcessLifecycle,
  ): Promise<AgentProcessResult> {
    if (request.adapter === undefined || request.adapter === "stdio-framed-v2") {
      return this.#legacy.run(request, lifecycle);
    }
    if (request.trust === undefined) {
      throw new HoneyBeeCoreError(
        "agent.trust-required",
        "Agent session execution requires an approved launch trust receipt.",
      );
    }
    await verifyAgentLaunchTrust(request.command, request.trust);
    const adapter: AgentSessionAdapter =
      request.adapter === "codex-app-server-v1"
        ? new CodexAppServerAdapter()
        : new OpenCodeAcpAdapter();
    return this.#scheduler.withSlot(
      {
        priority: this.#priority(request),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        onQueued: () =>
          lifecycle.onSessionEvent?.({ type: "admission-queued" }) ?? Promise.resolve(),
        onEntered: (waitMs) =>
          lifecycle.onSessionEvent?.({ type: "admission-entered", waitMs }) ?? Promise.resolve(),
      },
      () => adapter.run(request, lifecycle, this.#approval),
    );
  }
}
