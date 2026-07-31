import {
  SessionDraftSchema,
  type AgentSession,
  type RunId,
  type SessionId,
  type SessionRunRecord,
  type SessionStatus,
} from "@honeybee/domain";
import type {
  DraftRepository,
  PromptDeliveryAttemptRepository,
  PromptDeliveryReceiptRepository,
  SessionRepository,
  SessionRunRepository,
} from "@honeybee/persistence";
import {
  initialConsoleViewState,
  reduceConsoleViewState,
  type ConsoleRunSummary,
  type ConsoleSessionSummary,
  type ConsoleViewState,
  type ExtensionToConsoleMessage,
  type PromptRecoveryIssue,
  type TerminalRunInitial,
} from "@honeybee/ui-shared";

import { ApplicationError } from "./errors.js";
import { deliverPrompt, type PromptDeliveryResult } from "./prompt-delivery.js";
import type { PromptRecoveryIssueRecord } from "./prompt-delivery-attempt-reconciler.js";
import {
  PromptRecoveryService,
  type PromptRecoveryActionResult,
} from "./prompt-recovery-service.js";
import type {
  AgentProfileResolverPort,
  ClockPort,
  IdGeneratorPort,
  RuntimeClientEvent,
  RuntimeClientPort,
  RuntimeShutdownReason,
  RuntimeShutdownResult,
} from "./ports.js";
import {
  RunOutputBufferStore,
  type RunOutputRetentionResult,
  type RunOutputSnapshot,
} from "./run-output-buffer-store.js";
import { SessionRunController, type CorrelatedRuntimeStatus } from "./session-run-controller.js";
import type { SessionSelectionService } from "./session-selection.js";

interface TerminalSize {
  readonly columns: number;
  readonly rows: number;
}

const summary = (session: AgentSession): ConsoleSessionSummary => ({
  id: session.id,
  title: session.title,
  agentProfile: session.agentProfileId,
  workspace: session.workspaceId ?? "Current workspace",
  toolProfile: session.toolProfileId ?? "Default",
  status: session.status,
  tags: session.tags,
});

const runPhase = (run: SessionRunRecord): ConsoleRunSummary["phase"] => {
  switch (run.phase) {
    case "starting":
    case "running":
    case "waiting-for-input":
    case "stopping":
      return run.phase;
    case "interrupted":
      return "interrupted";
    case "stopped":
    case "completed":
    case "failed":
      return "ended";
  }
};

const runSummary = (run: SessionRunRecord): ConsoleRunSummary => ({
  runId: run.runId,
  sessionId: run.sessionId,
  phase: runPhase(run),
  interactive: run.phase === "running" || run.phase === "waiting-for-input",
  startedAt: run.startedAt,
  ...(run.terminationReason === undefined ? {} : { terminationReason: run.terminationReason }),
});

const statusForRun = (run: SessionRunRecord): SessionStatus => {
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

const terminalStatus = (run: ConsoleRunSummary): "active" | "ended" | "interrupted" => {
  if (run.phase === "interrupted") return "interrupted";
  return run.phase === "ended" ? "ended" : "active";
};

const initialReplay = (snapshot: RunOutputSnapshot): TerminalRunInitial =>
  snapshot.data.length === 0
    ? { kind: "empty" }
    : {
        kind: "replay",
        data: snapshot.data,
        firstSeq: snapshot.firstSeq,
        lastSeq: snapshot.lastSeq,
        truncatedBytes: snapshot.truncatedBytes,
      };

const recoveryView = (issue: PromptRecoveryIssueRecord | undefined): PromptRecoveryIssue | null =>
  issue === undefined
    ? null
    : {
        requestId: issue.requestId,
        sessionId: issue.sessionId,
        outcome: issue.outcome,
        draftMatch: issue.draftMatch,
        occurredAt: issue.occurredAt,
      };

export class ConsoleApplicationService {
  readonly #listeners = new Set<(message: ExtensionToConsoleMessage) => void>();
  readonly #outputs = new RunOutputBufferStore();
  readonly #terminalSizes = new Map<RunId, TerminalSize>();
  readonly #runtimeSubscription: { dispose(): void };
  readonly #selectionSubscription: { dispose(): void };
  readonly #recovery: PromptRecoveryService;
  readonly #runController: SessionRunController;
  readonly #diagnostic: (code: string, sessionId?: SessionId, runId?: RunId) => void;
  #state: ConsoleViewState = initialConsoleViewState();

  public constructor(
    private readonly sessions: SessionRepository,
    private readonly drafts: DraftRepository,
    private readonly attempts: PromptDeliveryAttemptRepository,
    private readonly receipts: PromptDeliveryReceiptRepository,
    runs: SessionRunRepository,
    selection: SessionSelectionService,
    runtime: RuntimeClientPort,
    private readonly profiles: AgentProfileResolverPort,
    private readonly clock: ClockPort,
    ids: Pick<IdGeneratorPort, "requestId" | "runId">,
    initialRecoveryIssues: readonly PromptRecoveryIssueRecord[] = [],
    diagnostic: (code: string, sessionId?: SessionId, runId?: RunId) => void = () => undefined,
  ) {
    this.#diagnostic = diagnostic;
    this.#runController = new SessionRunController(sessions, runs, runtime, clock, ids, diagnostic);
    this.#recovery = new PromptRecoveryService({
      attempts,
      drafts,
      receipts,
      runtime: this.#runController,
      clock,
      ids,
      initialIssues: initialRecoveryIssues,
    });
    this.#runtimeSubscription = runtime.onEvent((event) => this.handleRuntimeEvent(event));
    this.#selectionSubscription = selection.onDidSelect((sessionId) => {
      void this.select(sessionId).catch(() => undefined);
    });
  }

  public get state(): ConsoleViewState {
    return this.#state;
  }

  public async initialize(): Promise<void> {
    this.setState(
      reduceConsoleViewState(this.#state, {
        type: "connection.changed",
        status: "connecting",
        message: "Connecting to the separate runtime...",
      }),
    );
    await this.#runController.connect();
    this.setState(
      reduceConsoleViewState(this.#state, { type: "lifecycle.changed", state: "active" }),
    );
  }

  public onMessage(listener: (message: ExtensionToConsoleMessage) => void): { dispose(): void } {
    this.#listeners.add(listener);
    return { dispose: () => this.#listeners.delete(listener) };
  }

  public replayState(): void {
    this.emit({ type: "console.state", state: this.#state });
    this.emitSelectedRunOpen();
  }

  public async select(sessionId: SessionId | undefined): Promise<void> {
    if (sessionId === undefined) {
      this.handleRetention(this.#outputs.setSelected(undefined));
      this.setState(
        reduceConsoleViewState(this.#state, {
          type: "session.selected",
          session: null,
          run: null,
          draft: "",
          recoveryIssue: null,
        }),
      );
      return;
    }
    const [sessionResult, draftResult, run] = await Promise.all([
      this.sessions.getById(sessionId),
      this.drafts.getBySessionId(sessionId),
      this.#runController.selectedRunForSession(sessionId),
    ]);
    if (!sessionResult.ok) {
      throw new ApplicationError(
        sessionResult.error.code,
        sessionResult.error.message,
        sessionResult.error.details,
      );
    }
    if (!draftResult.ok) {
      throw new ApplicationError(
        draftResult.error.code,
        draftResult.error.message,
        draftResult.error.details,
      );
    }

    const selectedRun = run === undefined ? null : runSummary(run);
    this.setState(
      reduceConsoleViewState(this.#state, {
        type: "session.selected",
        session: summary(sessionResult.value),
        run: selectedRun,
        draft: draftResult.value?.content ?? "",
        recoveryIssue: recoveryView(this.#recovery.issueFor(sessionId)),
      }),
    );
    if (run === undefined) {
      this.handleRetention(this.#outputs.setSelected(undefined));
    } else {
      this.openRun(run);
    }
  }

  public async saveDraft(sessionId: SessionId, content: string): Promise<void> {
    const draft = SessionDraftSchema.parse({
      sessionId,
      content,
      updatedAt: this.clock.now(),
    });
    const result = await this.drafts.save(draft);
    if (!result.ok) {
      throw new ApplicationError(result.error.code, result.error.message, result.error.details);
    }
    await this.#recovery.refreshDraftMatch(sessionId);
    if (this.#state.selectedSession?.id === sessionId) {
      this.setState(
        reduceConsoleViewState(
          reduceConsoleViewState(this.#state, { type: "draft.updated", draft: content }),
          {
            type: "recovery.changed",
            recoveryIssue: recoveryView(this.#recovery.issueFor(sessionId)),
            message:
              this.#recovery.issueFor(sessionId) === undefined
                ? this.#state.statusMessage
                : "Prompt delivery outcome is unknown. Automatic resend is disabled.",
          },
        ),
      );
    }
  }

  public async start(sessionId: SessionId): Promise<void> {
    this.#runController.assertMutationAllowed();
    const session = await this.getSession(sessionId);
    const profile = await this.profiles.resolve(
      session.agentProfileId,
      session.toolProfileId,
      session.workspaceId,
    );
    const previousRunId = this.selectedRunId(sessionId);
    const size =
      previousRunId === undefined
        ? { columns: 80, rows: 24 }
        : (this.#terminalSizes.get(previousRunId) ?? { columns: 80, rows: 24 });
    if (this.#state.selectedSession?.id === sessionId) {
      this.setState(
        reduceConsoleViewState(this.#state, {
          type: "session.status",
          status: "starting",
          run: this.#state.selectedRun,
          message: "Starting agent...",
        }),
      );
    }
    try {
      const runId = await this.#runController.start(session, profile, size);
      const run = await this.#runController.getRun(runId);
      if (run !== undefined && this.#state.selectedSession?.id === sessionId) {
        this.setState(
          reduceConsoleViewState(this.#state, {
            type: "session.status",
            status: statusForRun(run),
            run: runSummary(run),
            message: "Agent Run started.",
          }),
        );
        this.openRun(run);
      }
    } catch (error) {
      if (this.#state.selectedSession?.id === sessionId) {
        const failedRun = await this.#runController.selectedRunForSession(sessionId);
        this.setState(
          reduceConsoleViewState(this.#state, {
            type: "session.status",
            status: "failed",
            run: failedRun === undefined ? null : runSummary(failedRun),
            message: error instanceof Error ? error.message : String(error),
          }),
        );
        if (failedRun !== undefined) this.openRun(failedRun);
      }
      throw error;
    }
  }

  public async sendPrompt(
    requestId: string,
    sessionId: SessionId,
    content: string,
  ): Promise<PromptDeliveryResult> {
    this.#runController.assertMutationAllowed();
    if (this.#recovery.issueFor(sessionId) !== undefined) {
      return {
        status: "rejected",
        code: "runtime-input-rejected",
        message: "Resolve the unknown Prompt delivery outcome before submitting again.",
      };
    }
    const result = await deliverPrompt(
      {
        drafts: this.drafts,
        attempts: this.attempts,
        receipts: this.receipts,
        runtime: this.#runController,
        clock: this.clock,
      },
      requestId,
      sessionId,
      content,
    );
    if (result.status === "unknown") await this.#recovery.registerUnknown(requestId, sessionId);
    if (this.#state.selectedSession?.id === sessionId) {
      const draft = result.status === "accepted" ? "" : this.#state.draft;
      this.setState(
        reduceConsoleViewState(
          reduceConsoleViewState(this.#state, { type: "draft.updated", draft }),
          {
            type: "recovery.changed",
            recoveryIssue: recoveryView(this.#recovery.issueFor(sessionId)),
            message:
              result.status === "unknown"
                ? "Prompt delivery outcome is unknown. Automatic resend is disabled."
                : this.#state.statusMessage,
          },
        ),
      );
    }
    return result;
  }

  public async assumePromptDelivered(
    requestId: string,
    sessionId: SessionId,
  ): Promise<PromptRecoveryActionResult> {
    this.#runController.assertMutationAllowed();
    const result = await this.#recovery.assumeDelivered(requestId, sessionId);
    await this.refreshRecoveryView(sessionId, "Unknown Prompt marked as assumed delivered.");
    return result;
  }

  public async retryUnknownPrompt(
    requestId: string,
    sessionId: SessionId,
  ): Promise<PromptRecoveryActionResult> {
    this.#runController.assertMutationAllowed();
    const result = await this.#recovery.retry(requestId, sessionId);
    await this.refreshRecoveryView(
      sessionId,
      result.status === "retry-finished" && result.delivery.status === "accepted"
        ? "Prompt retried with a new request ID."
        : "Unknown Prompt remains unresolved.",
    );
    return result;
  }

  public async sendTerminalInput(sessionId: SessionId, runId: RunId, data: string): Promise<void> {
    this.assertSelectedRun(sessionId, runId, true, "terminal-run-stale-input");
    const outcome = await this.#runController.sendTerminalInput(sessionId, runId, data);
    if (outcome.status !== "accepted") {
      throw new ApplicationError(
        outcome.status === "rejected" ? "runtime.input-rejected" : "runtime.input-unknown",
        outcome.status === "rejected" ? outcome.message : outcome.reason,
      );
    }
  }

  public async resize(
    sessionId: SessionId,
    runId: RunId,
    columns: number,
    rows: number,
  ): Promise<void> {
    this.assertSelectedRun(sessionId, runId, false, "terminal-run-stale-resize");
    const selected = this.#state.selectedRun;
    if (
      selected === null ||
      (selected.phase !== "starting" &&
        selected.phase !== "running" &&
        selected.phase !== "waiting-for-input")
    ) {
      this.#diagnostic("terminal-run-stale-resize", sessionId, runId);
      return;
    }
    this.#terminalSizes.set(runId, { columns, rows });
    await this.#runController.resize(sessionId, runId, columns, rows);
  }

  public async requestTerminalSnapshot(
    sessionId: SessionId,
    runId: RunId,
    _afterSeq?: number,
  ): Promise<void> {
    const [snapshot, run] = await Promise.all([
      Promise.resolve(this.#outputs.snapshot(sessionId, runId)),
      this.#runController.getRun(runId),
    ]);
    if (snapshot === undefined || run === undefined || run.sessionId !== sessionId) {
      this.#diagnostic("terminal-run-snapshot-unavailable", sessionId, runId);
      return;
    }
    this.emit({
      type: "terminal.run.snapshot",
      sessionId,
      runId,
      status: terminalStatus(runSummary(run)),
      data: snapshot.data,
      firstSeq: snapshot.firstSeq,
      lastSeq: snapshot.lastSeq,
      truncatedBytes: snapshot.truncatedBytes,
    });
  }

  public async interrupt(sessionId: SessionId, runId: RunId): Promise<void> {
    this.assertSelectedRun(sessionId, runId, true, "terminal-run-stale-input");
    await this.#runController.interrupt(sessionId, runId);
  }

  public async stop(sessionId: SessionId, runId: RunId): Promise<void> {
    this.assertSelectedRun(sessionId, runId, false, "terminal-run-stale-input");
    await this.#runController.stop(sessionId, runId);
    const run = await this.#runController.getRun(runId);
    if (run !== undefined && this.isSelectedRun(sessionId, runId)) {
      this.setState(
        reduceConsoleViewState(this.#state, {
          type: "session.status",
          status: statusForRun(run),
          run: runSummary(run),
          message: "Stopping agent...",
        }),
      );
    }
  }

  public beginShutdown(): void {
    this.#runController.beginShutdown();
    this.setState(
      reduceConsoleViewState(this.#state, {
        type: "lifecycle.changed",
        state: "shutting-down",
      }),
    );
  }

  public markActiveRunsStopping(): Promise<void> {
    return this.#runController.markActiveRunsStopping();
  }

  public shutdownRuntime(reason: RuntimeShutdownReason): Promise<RuntimeShutdownResult> {
    return this.#runController.shutdownRuntime(reason);
  }

  public interruptRemaining(reason: "runtime-disconnected" | "shutdown-timeout"): Promise<number> {
    return this.#runController.interruptRemaining(reason);
  }

  public flushRunState(): Promise<void> {
    return this.#runController.flush();
  }

  public disposeRuntime(): Promise<void> {
    return this.#runController.dispose();
  }

  public disposeListeners(): void {
    this.#runtimeSubscription.dispose();
    this.#selectionSubscription.dispose();
    this.#listeners.clear();
  }

  /** Backward-compatible complete disposal used by focused unit tests. */
  public async dispose(): Promise<void> {
    this.beginShutdown();
    this.disposeListeners();
    await this.disposeRuntime();
  }

  private handleRuntimeEvent(event: RuntimeClientEvent): void {
    switch (event.type) {
      case "connection":
        this.setState(
          reduceConsoleViewState(this.#state, {
            type: "connection.changed",
            status: event.state,
            message: event.message,
          }),
        );
        if (event.cause === "unexpected-disconnect") {
          void this.#runController
            .handleUnexpectedDisconnect()
            .then(async () => {
              const selected = this.#state.selectedSession?.id;
              if (selected !== undefined) await this.select(this.parseSessionId(selected));
            })
            .catch(() => undefined);
        }
        return;
      case "pty.data": {
        if (!this.#runController.isCurrentRun(event.sessionId, event.runId)) {
          this.#diagnostic("terminal-run-stale-data", event.sessionId, event.runId);
          return;
        }
        const appended = this.#outputs.append(
          event.sessionId,
          event.runId,
          event.sequence,
          event.data,
        );
        if (appended.status === "duplicate") {
          this.#diagnostic("terminal-run-stale-data", event.sessionId, event.runId);
          return;
        }
        if (appended.status === "terminal") {
          this.#diagnostic("terminal-run-stale-data", event.sessionId, event.runId);
          return;
        }
        if (appended.gap) {
          this.#diagnostic("terminal-run-sequence-gap", event.sessionId, event.runId);
        }
        this.handleRetention(this.#outputs.enforceRetention());
        this.emit({
          type: "terminal.run.data",
          sessionId: event.sessionId,
          runId: event.runId,
          seq: event.sequence,
          data: event.data,
        });
        return;
      }
      case "session.status":
        void this.applyRuntimeStatus(event);
        return;
      case "runtime.error":
        this.setState(
          reduceConsoleViewState(this.#state, {
            type: "connection.changed",
            status: "error",
            message: event.message,
          }),
        );
        return;
    }
  }

  private async applyRuntimeStatus(event: CorrelatedRuntimeStatus): Promise<void> {
    try {
      const applied = await this.#runController.handleStatus(event);
      if (applied === undefined) return;
      if (
        applied.run.phase === "stopped" ||
        applied.run.phase === "completed" ||
        applied.run.phase === "failed" ||
        applied.run.phase === "interrupted"
      ) {
        this.handleRetention(
          this.#outputs.markTerminal(event.sessionId, event.runId, event.sequence),
        );
        this.emit({
          type: "terminal.run.close",
          sessionId: event.sessionId,
          runId: event.runId,
          reason: applied.run.terminationReason ?? applied.run.phase,
          finalSeq: event.sequence,
        });
      }
      if (this.#state.selectedSession?.id === event.sessionId) {
        this.setState(
          reduceConsoleViewState(this.#state, {
            type: "session.status",
            status: applied.status,
            run: runSummary(applied.run),
            message: applied.message,
          }),
        );
        this.openRun(applied.run);
      }
    } catch (error) {
      this.setState(
        reduceConsoleViewState(this.#state, {
          type: "connection.changed",
          status: "error",
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  private openRun(run: SessionRunRecord): void {
    const snapshot = this.#outputs.open(run.sessionId, run.runId);
    this.handleRetention(this.#outputs.setSelected(run.runId));
    this.emit({
      type: "terminal.run.open",
      sessionId: run.sessionId,
      runId: run.runId,
      status: terminalStatus(runSummary(run)),
      initial: initialReplay(snapshot),
    });
  }

  private emitSelectedRunOpen(): void {
    const run = this.#state.selectedRun;
    if (run === null) return;
    const sessionId = this.parseSessionId(run.sessionId);
    const runId = this.parseRunId(run.runId);
    const snapshot = this.#outputs.open(sessionId, runId);
    this.handleRetention(this.#outputs.setSelected(runId));
    this.emit({
      type: "terminal.run.open",
      sessionId,
      runId,
      status: terminalStatus(run),
      initial: initialReplay(snapshot),
    });
  }

  private handleRetention(result: RunOutputRetentionResult): void {
    for (const runId of result.evictedRunIds) {
      this.#diagnostic("terminal-run-surface-evicted", undefined, runId);
    }
    if (result.limitExceeded) {
      this.#diagnostic("terminal-run-registry-limit");
    }
  }

  private assertSelectedRun(
    sessionId: SessionId,
    runId: RunId,
    requireInteractive: boolean,
    code: string,
  ): void {
    this.#runController.assertMutationAllowed();
    const selected = this.#state.selectedRun;
    if (
      !this.isSelectedRun(sessionId, runId) ||
      (requireInteractive && selected?.interactive !== true)
    ) {
      this.#diagnostic(code, sessionId, runId);
      throw new ApplicationError(code, "The terminal action belongs to a stale or read-only Run.");
    }
  }

  private isSelectedRun(sessionId: SessionId, runId: RunId): boolean {
    return (
      this.#state.selectedSession?.id === sessionId &&
      this.#state.selectedRun?.sessionId === sessionId &&
      this.#state.selectedRun.runId === runId
    );
  }

  private selectedRunId(sessionId: SessionId): RunId | undefined {
    const run = this.#state.selectedRun;
    return run?.sessionId === sessionId ? this.parseRunId(run.runId) : undefined;
  }

  private async refreshRecoveryView(sessionId: SessionId, message: string): Promise<void> {
    if (this.#state.selectedSession?.id !== sessionId) return;
    const draftResult = await this.drafts.getBySessionId(sessionId);
    const draft = draftResult.ok ? (draftResult.value?.content ?? "") : this.#state.draft;
    this.setState(
      reduceConsoleViewState(
        reduceConsoleViewState(this.#state, { type: "draft.updated", draft }),
        {
          type: "recovery.changed",
          recoveryIssue: recoveryView(this.#recovery.issueFor(sessionId)),
          message,
        },
      ),
    );
  }

  private async getSession(sessionId: SessionId): Promise<AgentSession> {
    const result = await this.sessions.getById(sessionId);
    if (!result.ok) {
      throw new ApplicationError(result.error.code, result.error.message, result.error.details);
    }
    return result.value;
  }

  private parseSessionId(sessionId: string): SessionId {
    return sessionId as SessionId;
  }

  private parseRunId(runId: string): RunId {
    return runId as RunId;
  }

  private setState(state: ConsoleViewState): void {
    this.#state = state;
    this.emit({ type: "console.state", state });
  }

  private emit(message: ExtensionToConsoleMessage): void {
    for (const listener of this.#listeners) listener(message);
  }
}
