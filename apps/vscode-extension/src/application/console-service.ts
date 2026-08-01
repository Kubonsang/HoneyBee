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

import {
  consoleRunSummary,
  projectConsoleRuns,
  type ConsoleRunProjection,
} from "./console-run-navigation.js";
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

interface RunViewPreference {
  readonly viewedRunId: RunId | undefined;
  readonly followLive: boolean;
}

export interface ConsoleTerminalDataTrace {
  readonly stage: "application-received" | "terminal-message-emitted";
  readonly sessionId: SessionId;
  readonly runId: RunId;
  readonly sequence: number;
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
  readonly #runViews = new Map<SessionId, RunViewPreference>();
  readonly #runtimeSubscription: { dispose(): void };
  readonly #selectionSubscription: { dispose(): void };
  readonly #recovery: PromptRecoveryService;
  readonly #runController: SessionRunController;
  readonly #diagnostic: (code: string, sessionId?: SessionId, runId?: RunId) => void;
  readonly #terminalTrace: (event: ConsoleTerminalDataTrace) => void;
  #state: ConsoleViewState = initialConsoleViewState();

  public constructor(
    private readonly sessions: SessionRepository,
    private readonly drafts: DraftRepository,
    private readonly attempts: PromptDeliveryAttemptRepository,
    private readonly receipts: PromptDeliveryReceiptRepository,
    private readonly runs: SessionRunRepository,
    selection: SessionSelectionService,
    runtime: RuntimeClientPort,
    private readonly profiles: AgentProfileResolverPort,
    private readonly clock: ClockPort,
    ids: Pick<IdGeneratorPort, "requestId" | "runId">,
    initialRecoveryIssues: readonly PromptRecoveryIssueRecord[] = [],
    diagnostic: (code: string, sessionId?: SessionId, runId?: RunId) => void = () => undefined,
    terminalTrace: (event: ConsoleTerminalDataTrace) => void = () => undefined,
  ) {
    this.#diagnostic = diagnostic;
    this.#terminalTrace = terminalTrace;
    this.#runController = new SessionRunController(
      sessions,
      this.runs,
      runtime,
      clock,
      ids,
      diagnostic,
    );
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
    this.openViewedRun();
  }

  public async select(sessionId: SessionId | undefined): Promise<void> {
    if (sessionId === undefined) {
      this.handleRetention(this.#outputs.setSelected(undefined));
      this.setState(
        reduceConsoleViewState(this.#state, {
          type: "session.selected",
          session: null,
          activeRun: null,
          viewedRun: null,
          availableRuns: [],
          followLive: false,
          draft: "",
          recoveryIssue: null,
        }),
      );
      return;
    }
    const [sessionResult, draftResult, runs, activeRun] = await Promise.all([
      this.sessions.getById(sessionId),
      this.drafts.getBySessionId(sessionId),
      this.#runController.listRunsForSession(sessionId),
      this.#runController.activeRunForSession(sessionId),
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

    const preference = this.resolveRunView(sessionId, runs, activeRun);
    const projection = this.projectRuns(runs, activeRun, preference.viewedRunId);
    this.#runViews.set(sessionId, preference);
    this.setState(
      reduceConsoleViewState(this.#state, {
        type: "session.selected",
        session: summary(sessionResult.value),
        ...projection,
        followLive: preference.followLive,
        draft: draftResult.value?.content ?? "",
        recoveryIssue: recoveryView(this.#recovery.issueFor(sessionId)),
      }),
    );
    this.openViewedRun();
  }
  public async selectViewedRun(sessionId: SessionId, runId: RunId): Promise<void> {
    this.#runController.assertMutationAllowed();
    this.assertSelectedSession(sessionId);
    const [run, activeRun, runs] = await Promise.all([
      this.#runController.getRun(runId),
      this.#runController.activeRunForSession(sessionId),
      this.#runController.listRunsForSession(sessionId),
    ]);
    if (run === undefined || run.sessionId !== sessionId) {
      this.#diagnostic("terminal-run-wrong-session", sessionId, runId);
      throw new ApplicationError(
        "terminal-run-wrong-session",
        "The selected Run does not belong to the current Session.",
      );
    }
    const followLive = activeRun?.runId === runId;
    if (
      this.#state.viewedRun?.runId === runId &&
      this.#state.viewedRun.sessionId === sessionId &&
      this.#state.followLive === followLive
    ) {
      return;
    }
    this.#runViews.set(sessionId, { viewedRunId: runId, followLive });
    const projection = this.projectRuns(runs, activeRun, runId);
    this.setState(
      reduceConsoleViewState(this.#state, {
        type: "session.runs.changed",
        status: this.#state.selectedSession?.status ?? statusForRun(run),
        ...projection,
        followLive,
        message: followLive ? "Viewing the live Run." : "Viewing an archived Run. Read only.",
      }),
    );
    this.openViewedRun();
  }

  public async followActiveRun(sessionId: SessionId): Promise<void> {
    this.#runController.assertMutationAllowed();
    this.assertSelectedSession(sessionId);
    const [activeRun, runs] = await Promise.all([
      this.#runController.activeRunForSession(sessionId),
      this.#runController.listRunsForSession(sessionId),
    ]);
    if (activeRun === undefined) {
      throw new ApplicationError(
        "terminal-run-live-unavailable",
        "This Session has no active Run to follow.",
      );
    }
    this.#runViews.set(sessionId, { viewedRunId: activeRun.runId, followLive: true });
    this.setState(
      reduceConsoleViewState(this.#state, {
        type: "session.runs.changed",
        status: this.#state.selectedSession?.status ?? statusForRun(activeRun),
        ...this.projectRuns(runs, activeRun, activeRun.runId),
        followLive: true,
        message: "Returned to the live Run.",
      }),
    );
    this.openViewedRun();
  }

  public async resolveRunLogPath(sessionId: SessionId, runId: RunId): Promise<string> {
    this.assertSelectedSession(sessionId);
    const path = await this.#runController.logFilePathForRun(sessionId, runId);
    if (path === undefined) {
      throw new ApplicationError(
        "terminal-run-log-unavailable",
        "The recorded log for this Run is not available in the current Runtime generation.",
      );
    }
    return path;
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
    this.assertSelectedSession(sessionId);
    const session = await this.getSession(sessionId);
    const profile = await this.profiles.resolve(
      session.agentProfileId,
      session.toolProfileId,
      session.workspaceId,
    );
    const previousRunId = this.viewedRunId(sessionId);
    const size =
      previousRunId === undefined
        ? { columns: 80, rows: 24 }
        : (this.#terminalSizes.get(previousRunId) ?? { columns: 80, rows: 24 });
    try {
      const runId = await this.#runController.start(session, profile, size);
      const run = await this.#runController.getRun(runId);
      if (run !== undefined && this.#state.selectedSession?.id === sessionId) {
        this.#outputs.open(sessionId, runId);
        this.#runViews.set(sessionId, { viewedRunId: runId, followLive: true });
        await this.refreshRunProjection(sessionId, statusForRun(run), "Agent Run started.");
      }
    } catch (error) {
      if (this.#state.selectedSession?.id === sessionId) {
        const currentSession = await this.getSession(sessionId);
        await this.refreshRunProjection(
          sessionId,
          currentSession.status,
          error instanceof Error ? error.message : String(error),
        );
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
    const dependencies = {
      drafts: this.drafts,
      attempts: this.attempts,
      receipts: this.receipts,
      runtime: this.#runController,
      clock: this.clock,
    };
    if (content.trim().length === 0) {
      return deliverPrompt(dependencies, requestId, sessionId, content);
    }
    if (!this.isViewingActiveRun(sessionId)) {
      return {
        status: "rejected",
        code: "runtime-input-rejected",
        message: "Return to the live Run before sending a Prompt.",
      };
    }
    if (this.#recovery.issueFor(sessionId) !== undefined) {
      return {
        status: "rejected",
        code: "runtime-input-rejected",
        message: "Resolve the unknown Prompt delivery outcome before submitting again.",
      };
    }
    const result = await deliverPrompt(dependencies, requestId, sessionId, content);
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
    this.assertViewingActiveRun(sessionId, runId, true, "terminal-run-stale-input");
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
    this.assertViewingActiveRun(sessionId, runId, false, "terminal-run-stale-resize");
    const selected = this.#state.viewedRun;
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
      status: terminalStatus(consoleRunSummary(run, this.#state.activeRun?.runId === runId)),
      data: snapshot.data,
      firstSeq: snapshot.firstSeq,
      lastSeq: snapshot.lastSeq,
      truncatedBytes: snapshot.truncatedBytes,
    });
  }

  public async interrupt(sessionId: SessionId, runId: RunId): Promise<void> {
    this.assertViewingActiveRun(sessionId, runId, true, "terminal-run-stale-input");
    await this.#runController.interrupt(sessionId, runId);
  }

  public async stop(sessionId: SessionId, runId: RunId): Promise<void> {
    this.assertViewingActiveRun(sessionId, runId, false, "terminal-run-stale-input");
    await this.#runController.stop(sessionId, runId);
    const run = await this.#runController.getRun(runId);
    if (run !== undefined && this.isViewingActiveRun(sessionId, runId)) {
      await this.refreshRunProjection(sessionId, statusForRun(run), "Stopping agent...");
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
        this.#terminalTrace({
          stage: "application-received",
          sessionId: event.sessionId,
          runId: event.runId,
          sequence: event.sequence,
        });
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
          if (this.#state.selectedSession?.id === event.sessionId) {
            void this.refreshRunProjection(
              event.sessionId,
              this.#state.selectedSession.status,
              "A terminal output sequence gap was detected.",
            ).catch(() => undefined);
          }
        }
        this.handleRetention(this.#outputs.enforceRetention());
        this.emit({
          type: "terminal.run.data",
          sessionId: event.sessionId,
          runId: event.runId,
          seq: event.sequence,
          data: event.data,
        });
        this.#terminalTrace({
          stage: "terminal-message-emitted",
          sessionId: event.sessionId,
          runId: event.runId,
          sequence: event.sequence,
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
        const preference = this.#runViews.get(event.sessionId);
        if (preference?.followLive !== false) {
          this.#runViews.set(event.sessionId, {
            viewedRunId: event.runId,
            followLive: true,
          });
        }
        await this.refreshRunProjection(event.sessionId, applied.status, applied.message);
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

  private openViewedRun(): void {
    const run = this.#state.viewedRun;
    if (run === null) {
      this.handleRetention(this.#outputs.setSelected(undefined));
      return;
    }
    const sessionId = this.parseSessionId(run.sessionId);
    const runId = this.parseRunId(run.runId);
    let snapshot = this.#outputs.snapshot(sessionId, runId);
    if (snapshot === undefined && this.#state.activeRun?.runId === run.runId) {
      snapshot = this.#outputs.open(sessionId, runId);
    }
    this.handleRetention(this.#outputs.setSelected(runId));
    if (snapshot === undefined) return;
    this.emit({
      type: "terminal.run.open",
      sessionId,
      runId,
      status: terminalStatus(run),
      initial: initialReplay(snapshot),
    });
  }

  private async refreshRunProjection(
    sessionId: SessionId,
    status: SessionStatus,
    message: string,
  ): Promise<void> {
    if (this.#state.selectedSession?.id !== sessionId) return;
    const [runs, activeRun] = await Promise.all([
      this.#runController.listRunsForSession(sessionId),
      this.#runController.activeRunForSession(sessionId),
    ]);
    const preference = this.resolveRunView(sessionId, runs, activeRun);
    this.#runViews.set(sessionId, preference);
    this.setState(
      reduceConsoleViewState(this.#state, {
        type: "session.runs.changed",
        status,
        ...this.projectRuns(runs, activeRun, preference.viewedRunId),
        followLive: preference.followLive,
        message,
      }),
    );
    this.openViewedRun();
  }

  private projectRuns(
    runs: readonly SessionRunRecord[],
    activeRun: SessionRunRecord | undefined,
    viewedRunId: RunId | undefined,
  ): ConsoleRunProjection {
    return projectConsoleRuns(runs, activeRun?.runId, viewedRunId, (run) => ({
      transcript: this.#outputs.inspect(run.sessionId, run.runId),
      logAvailable: this.#runController.hasLogFilePath(run.runId),
    }));
  }

  private resolveRunView(
    sessionId: SessionId,
    runs: readonly SessionRunRecord[],
    activeRun: SessionRunRecord | undefined,
  ): RunViewPreference {
    const existing = this.#runViews.get(sessionId);
    if (existing?.followLive === true && activeRun !== undefined) {
      return { viewedRunId: activeRun.runId, followLive: true };
    }
    if (
      existing?.viewedRunId !== undefined &&
      runs.some((run) => run.runId === existing.viewedRunId)
    ) {
      return existing;
    }
    if (activeRun !== undefined) {
      return { viewedRunId: activeRun.runId, followLive: true };
    }
    const latest = [...runs].sort(
      (left, right) =>
        right.startedAt.localeCompare(left.startedAt) || left.runId.localeCompare(right.runId),
    )[0];
    return { viewedRunId: latest?.runId, followLive: existing?.followLive ?? true };
  }
  private handleRetention(result: RunOutputRetentionResult): void {
    for (const runId of result.evictedRunIds) {
      this.#diagnostic("terminal-run-surface-evicted", undefined, runId);
    }
    if (result.limitExceeded) {
      this.#diagnostic("terminal-run-registry-limit");
    }
  }

  private assertSelectedSession(sessionId: SessionId): void {
    if (this.#state.selectedSession?.id !== sessionId) {
      throw new ApplicationError(
        "terminal-run-wrong-session",
        "The terminal action belongs to a different selected Session.",
      );
    }
  }

  private assertViewingActiveRun(
    sessionId: SessionId,
    runId: RunId,
    requireInteractive: boolean,
    code: string,
  ): void {
    this.#runController.assertMutationAllowed();
    const active = this.#state.activeRun;
    if (
      !this.isViewingActiveRun(sessionId, runId) ||
      (requireInteractive && active?.interactive !== true)
    ) {
      this.#diagnostic(code, sessionId, runId);
      throw new ApplicationError(code, "Return to the live Run before using Runtime controls.");
    }
  }

  private isViewingActiveRun(sessionId: SessionId, runId?: RunId): boolean {
    const active = this.#state.activeRun;
    const viewed = this.#state.viewedRun;
    return (
      this.#state.selectedSession?.id === sessionId &&
      active?.sessionId === sessionId &&
      viewed?.sessionId === sessionId &&
      active.runId === viewed.runId &&
      (runId === undefined || active.runId === runId)
    );
  }

  private viewedRunId(sessionId: SessionId): RunId | undefined {
    const run = this.#state.viewedRun;
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
