import {
  SessionRunRecordSchema,
  transitionSessionRun,
  type AgentSession,
  type RunId,
  type RuntimeInstanceId,
  type SessionId,
  type SessionRunRecord,
  type SessionStatus,
  type SessionTerminationReason,
} from "@honeybee/domain";
import type { SessionRepository, SessionRunRepository } from "@honeybee/persistence";

import { ApplicationError } from "./errors.js";
import type {
  AgentLaunchProfile,
  ClockPort,
  IdGeneratorPort,
  PromptRuntimeInputPort,
  RuntimeClientPort,
  RuntimeHello,
  RuntimeInputOutcome,
  RuntimeShutdownReason,
  RuntimeShutdownResult,
} from "./ports.js";

interface TerminalSize {
  readonly columns: number;
  readonly rows: number;
}

export interface AppliedSessionRunStatus {
  readonly sessionId: SessionId;
  readonly runId: RunId;
  readonly sequence: number;
  readonly status: SessionStatus;
  readonly message: string;
  readonly run: SessionRunRecord;
}

export interface CorrelatedRuntimeStatus {
  readonly sessionId: SessionId;
  readonly runId: RunId;
  readonly sequence: number;
  readonly status: SessionStatus;
  readonly message: string;
  readonly logFilePath?: string;
  readonly reason?: SessionTerminationReason;
  readonly exitCode?: number;
}

const activeSessionStatuses = new Set<SessionStatus>(["starting", "running", "waiting_for_input"]);

const statusForPhase = (run: SessionRunRecord): SessionStatus => {
  switch (run.phase) {
    case "starting":
      return "starting";
    case "running":
      return "running";
    case "waiting-for-input":
      return "waiting_for_input";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "stopping":
    case "stopped":
    case "interrupted":
      return "stopped";
  }
};

const inferredReason = (
  status: SessionStatus,
  reason: SessionTerminationReason | undefined,
): SessionTerminationReason | undefined => {
  if (reason !== undefined) return reason;
  if (status === "completed") return "process-exit-zero";
  if (status === "failed") return "process-exit-nonzero";
  if (status === "stopped") return "user-stop";
  return undefined;
};

/** Owns durable Run identity, correlation and per-Session status serialization. */
export class SessionRunController implements PromptRuntimeInputPort {
  readonly #activeRunIds = new Map<SessionId, RunId>();
  readonly #logFilePaths = new Map<RunId, string>();
  readonly #statusQueues = new Map<SessionId, Promise<void>>();
  #runtimeInstanceId: RuntimeInstanceId | undefined;
  #acceptingMutations = true;

  public constructor(
    private readonly sessions: SessionRepository,
    private readonly runs: SessionRunRepository,
    private readonly runtime: RuntimeClientPort,
    private readonly clock: ClockPort,
    private readonly ids: Pick<IdGeneratorPort, "runId">,
    private readonly diagnostic: (code: string, sessionId?: SessionId, runId?: RunId) => void,
  ) {}

  public get runtimeHello(): RuntimeHello | undefined {
    return this.runtime.runtimeHello;
  }

  public async connect(): Promise<RuntimeHello> {
    this.assertMutationAllowed();
    await this.runtime.connect();
    const hello = this.runtime.runtimeHello;
    if (hello === undefined) {
      throw new ApplicationError(
        "runtime-handshake-missing",
        "Runtime handshake identity is missing.",
      );
    }
    this.#runtimeInstanceId = hello.runtimeInstanceId;
    return hello;
  }

  public beginShutdown(): void {
    this.#acceptingMutations = false;
  }

  public assertMutationAllowed(): void {
    if (!this.#acceptingMutations) {
      throw new ApplicationError(
        "lifecycle-shutting-down",
        "Honey Bee is shutting down and rejects new Runtime mutations.",
      );
    }
  }

  public async start(
    session: AgentSession,
    profile: AgentLaunchProfile,
    size: TerminalSize,
  ): Promise<RunId> {
    this.assertMutationAllowed();
    const runtimeInstanceId = this.#runtimeInstanceId;
    if (runtimeInstanceId === undefined) {
      throw new ApplicationError("runtime-not-connected", "The Runtime handshake is incomplete.");
    }
    const active = await this.readActiveRun(session.id);
    if (active !== undefined) {
      throw new ApplicationError(
        "session-run-conflict",
        "Session " + session.id + " already has active Run " + active.runId + ".",
      );
    }

    const now = this.clock.now();
    const run = SessionRunRecordSchema.parse({
      runId: this.ids.runId(),
      sessionId: session.id,
      runtimeInstanceId,
      phase: "starting",
      startedAt: now,
      updatedAt: now,
      schemaVersion: 1,
    });
    await this.saveRun(run);
    try {
      await this.saveSessionStatus(session, "starting");
    } catch (error) {
      await this.terminateIfActive(run, "failed", "start-failed");
      throw error;
    }
    this.#activeRunIds.set(session.id, run.runId);

    try {
      await this.runtime.start({
        sessionId: session.id,
        runId: run.runId,
        command: profile.command,
        args: profile.args,
        cwd: profile.cwd,
        environment: profile.environment,
        shell: profile.shell,
        columns: size.columns,
        rows: size.rows,
      });
      return run.runId;
    } catch (error) {
      await this.enqueue(session.id, async () => {
        const activeRun = await this.readActiveRun(session.id);
        if (activeRun?.runId !== run.runId) return;
        await this.terminateRun(activeRun, "failed", "start-failed");
      });
      throw error;
    }
  }

  public async sendInput(sessionId: SessionId, data: string): Promise<RuntimeInputOutcome> {
    this.assertMutationAllowed();
    const runId = await this.requireActiveRunId(sessionId);
    return this.runtime.sendInput(sessionId, data, runId);
  }

  public async sendTerminalInput(
    sessionId: SessionId,
    runId: RunId,
    data: string,
  ): Promise<RuntimeInputOutcome> {
    this.assertMutationAllowed();
    await this.requireExpectedActiveRun(sessionId, runId);
    return this.runtime.sendInput(sessionId, data, runId);
  }

  public async resize(
    sessionId: SessionId,
    runId: RunId,
    columns: number,
    rows: number,
  ): Promise<void> {
    this.assertMutationAllowed();
    await this.requireExpectedActiveRun(sessionId, runId);
    await this.runtime.resize(sessionId, columns, rows, runId);
  }

  public async interrupt(sessionId: SessionId, runId: RunId): Promise<void> {
    this.assertMutationAllowed();
    await this.requireExpectedActiveRun(sessionId, runId);
    await this.runtime.interrupt(sessionId, runId);
  }

  public async stop(sessionId: SessionId, runId: RunId): Promise<void> {
    this.assertMutationAllowed();
    const run = await this.requireExpectedActiveRun(sessionId, runId);
    await this.enqueue(sessionId, async () => {
      const current = await this.readActiveRun(sessionId);
      if (current?.runId !== run.runId) return;
      if (current.phase !== "stopping") {
        await this.saveTransition(current, {
          phase: "stopping",
          updatedAt: this.clock.now(),
        });
      }
    });
    await this.runtime.stop(sessionId, runId);
  }

  public isCurrentRun(sessionId: SessionId, runId: RunId): boolean {
    return this.#activeRunIds.get(sessionId) === runId;
  }

  public async listRunsForSession(sessionId: SessionId): Promise<readonly SessionRunRecord[]> {
    const result = await this.runs.listBySessionId(sessionId);
    if (!result.ok) {
      throw new ApplicationError(result.error.code, result.error.message, result.error.details);
    }
    return result.value;
  }

  public async activeRunForSession(sessionId: SessionId): Promise<SessionRunRecord | undefined> {
    return this.readActiveRun(sessionId);
  }

  public hasLogFilePath(runId: RunId): boolean {
    return this.#logFilePaths.has(runId);
  }

  public async logFilePathForRun(sessionId: SessionId, runId: RunId): Promise<string | undefined> {
    const run = await this.getRun(runId);
    return run?.sessionId === sessionId ? this.#logFilePaths.get(runId) : undefined;
  }

  public async getRun(runId: RunId): Promise<SessionRunRecord | undefined> {
    const result = await this.runs.getByRunId(runId);
    if (!result.ok) {
      throw new ApplicationError(result.error.code, result.error.message, result.error.details);
    }
    return result.value;
  }

  public handleStatus(
    event: CorrelatedRuntimeStatus,
  ): Promise<AppliedSessionRunStatus | undefined> {
    return this.enqueue(event.sessionId, async () => this.applyStatus(event));
  }

  public async markActiveRunsStopping(): Promise<void> {
    const active = await this.listActiveRuns();
    await Promise.all(
      active.map((run) =>
        this.enqueue(run.sessionId, async () => {
          const current = await this.readActiveRun(run.sessionId);
          if (current?.runId !== run.runId || current.phase === "stopping") return;
          await this.saveTransition(current, {
            phase: "stopping",
            updatedAt: this.clock.now(),
          });
        }),
      ),
    );
  }

  public shutdownRuntime(reason: RuntimeShutdownReason): Promise<RuntimeShutdownResult> {
    return this.runtime.shutdown(reason);
  }

  public async interruptRemaining(
    reason: "runtime-disconnected" | "shutdown-timeout",
  ): Promise<number> {
    const active = await this.listActiveRuns();
    let interrupted = 0;
    await Promise.all(
      active.map((run) =>
        this.enqueue(run.sessionId, async () => {
          const current = await this.readActiveRun(run.sessionId);
          if (current?.runId !== run.runId) return;
          await this.terminateRun(current, "interrupted", reason);
          interrupted += 1;
        }),
      ),
    );
    return interrupted;
  }

  public async handleUnexpectedDisconnect(): Promise<void> {
    await this.interruptRemaining("runtime-disconnected");
  }

  public async flush(): Promise<void> {
    await Promise.all([...this.#statusQueues.values()]);
    await this.runs.flush();
  }

  public dispose(): Promise<void> {
    return this.runtime.dispose();
  }

  private async applyStatus(
    event: CorrelatedRuntimeStatus,
  ): Promise<AppliedSessionRunStatus | undefined> {
    const run = await this.readActiveRun(event.sessionId);
    if (run?.runId !== event.runId) {
      this.diagnostic("stale-runtime-event", event.sessionId, event.runId);
      return undefined;
    }

    if (event.status === "running" || event.status === "waiting_for_input") {
      if (run.phase === "stopping") {
        this.diagnostic("stale-runtime-event", event.sessionId, event.runId);
        return undefined;
      }
      const phase = event.status === "running" ? "running" : "waiting-for-input";
      if (event.logFilePath !== undefined) this.#logFilePaths.set(event.runId, event.logFilePath);
      const updated =
        run.phase === phase
          ? run
          : await this.saveTransition(run, { phase, updatedAt: this.clock.now() });
      await this.saveSessionStatus(await this.readSession(event.sessionId), event.status);
      return { ...event, run: updated };
    }

    const reason = inferredReason(event.status, event.reason);
    if (reason === undefined) {
      this.diagnostic("invalid-runtime-terminal-event", event.sessionId, event.runId);
      return undefined;
    }
    const phase =
      event.status === "completed" ? "completed" : event.status === "failed" ? "failed" : "stopped";
    const terminal = await this.terminateRun(run, phase, reason, event.exitCode);
    return { ...event, run: terminal };
  }

  private async terminateIfActive(
    run: SessionRunRecord,
    phase: "failed" | "interrupted",
    reason: SessionTerminationReason,
  ): Promise<void> {
    const active = await this.readActiveRun(run.sessionId);
    if (active?.runId === run.runId) await this.terminateRun(active, phase, reason);
  }

  private async terminateRun(
    run: SessionRunRecord,
    phase: "stopped" | "completed" | "failed" | "interrupted",
    reason: SessionTerminationReason,
    exitCode?: number,
  ): Promise<SessionRunRecord> {
    const now = this.clock.now();
    const terminal = await this.saveTransition(run, {
      phase,
      updatedAt: now,
      endedAt: now,
      terminationReason: reason,
      ...(exitCode === undefined ? {} : { exitCode }),
    });
    this.#activeRunIds.delete(run.sessionId);
    await this.saveSessionStatus(await this.readSession(run.sessionId), statusForPhase(terminal));
    return terminal;
  }

  private async saveTransition(
    run: SessionRunRecord,
    transition: Parameters<typeof transitionSessionRun>[1],
  ): Promise<SessionRunRecord> {
    const changed = transitionSessionRun(run, transition);
    if (!changed.ok) {
      throw new ApplicationError(changed.error.code, changed.error.message, changed.error.details);
    }
    return this.saveRun(changed.value);
  }

  private async saveRun(run: SessionRunRecord): Promise<SessionRunRecord> {
    const result = await this.runs.save(run);
    if (!result.ok) {
      throw new ApplicationError(result.error.code, result.error.message, result.error.details);
    }
    return result.value;
  }

  private async saveSessionStatus(
    session: AgentSession,
    status: SessionStatus,
  ): Promise<AgentSession> {
    const result = await this.sessions.save({
      ...session,
      status,
      updatedAt: this.clock.now(),
    });
    if (!result.ok) {
      throw new ApplicationError(result.error.code, result.error.message, result.error.details);
    }
    return result.value;
  }

  private async readSession(sessionId: SessionId): Promise<AgentSession> {
    const result = await this.sessions.getById(sessionId);
    if (!result.ok) {
      throw new ApplicationError(result.error.code, result.error.message, result.error.details);
    }
    return result.value;
  }

  private async readActiveRun(sessionId: SessionId): Promise<SessionRunRecord | undefined> {
    const result = await this.runs.getActiveBySessionId(sessionId);
    if (!result.ok) {
      throw new ApplicationError(result.error.code, result.error.message, result.error.details);
    }
    return result.value;
  }

  private async requireActiveRun(sessionId: SessionId): Promise<SessionRunRecord> {
    const run = await this.readActiveRun(sessionId);
    if (run === undefined) {
      throw new ApplicationError(
        "session-run-not-active",
        "Session " + sessionId + " has no active Runtime Run.",
      );
    }
    return run;
  }

  private async requireExpectedActiveRun(
    sessionId: SessionId,
    runId: RunId,
  ): Promise<SessionRunRecord> {
    const run = await this.requireActiveRun(sessionId);
    if (run.runId !== runId) {
      this.diagnostic("stale-runtime-event", sessionId, runId);
      throw new ApplicationError(
        "stale-runtime-event",
        "The terminal action belongs to a stale Session Run.",
      );
    }
    this.#activeRunIds.set(sessionId, runId);
    return run;
  }

  private async requireActiveRunId(sessionId: SessionId): Promise<RunId> {
    const run = await this.requireActiveRun(sessionId);
    this.#activeRunIds.set(sessionId, run.runId);
    return run.runId;
  }

  private async listActiveRuns(): Promise<readonly SessionRunRecord[]> {
    const result = await this.runs.listActive();
    if (!result.ok) {
      throw new ApplicationError(result.error.code, result.error.message, result.error.details);
    }
    return result.value.filter(
      (run) =>
        this.#runtimeInstanceId === undefined || run.runtimeInstanceId === this.#runtimeInstanceId,
    );
  }

  private enqueue<T>(sessionId: SessionId, operation: () => Promise<T>): Promise<T> {
    const previous = this.#statusQueues.get(sessionId) ?? Promise.resolve();
    const current = previous.then(operation);
    this.#statusQueues.set(
      sessionId,
      current.then(
        () => undefined,
        () => undefined,
      ),
    );
    return current;
  }
}

export const isPersistedActiveSessionStatus = (status: SessionStatus): boolean =>
  activeSessionStatuses.has(status);
