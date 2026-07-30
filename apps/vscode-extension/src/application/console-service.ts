import {
  SessionDraftSchema,
  type AgentSession,
  type RunId,
  type SessionId,
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
  type ConsoleSessionSummary,
  type ConsoleViewState,
  type ExtensionToConsoleMessage,
  type PromptRecoveryIssue,
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
import { SessionRunController, type CorrelatedRuntimeStatus } from "./session-run-controller.js";
import type { SessionSelectionService } from "./session-selection.js";

const MAX_SESSION_OUTPUT = 512_000;

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
  readonly #outputs = new Map<SessionId, string>();
  readonly #terminalSizes = new Map<SessionId, TerminalSize>();
  readonly #runtimeSubscription: { dispose(): void };
  readonly #selectionSubscription: { dispose(): void };
  readonly #recovery: PromptRecoveryService;
  readonly #runController: SessionRunController;
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
    const sessionId = this.#state.selectedSession?.id;
    if (sessionId === undefined) return;
    const output = this.#outputs.get(this.parseSessionId(sessionId));
    if (output !== undefined) this.emit({ type: "terminal.data", sessionId, data: output });
  }

  public async select(sessionId: SessionId | undefined): Promise<void> {
    if (sessionId === undefined) {
      this.emit({ type: "terminal.clear", sessionId: null });
      this.setState(
        reduceConsoleViewState(this.#state, {
          type: "session.selected",
          session: null,
          draft: "",
          recoveryIssue: null,
        }),
      );
      return;
    }
    const [sessionResult, draftResult] = await Promise.all([
      this.sessions.getById(sessionId),
      this.drafts.getBySessionId(sessionId),
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

    this.emit({ type: "terminal.clear", sessionId });
    this.setState(
      reduceConsoleViewState(this.#state, {
        type: "session.selected",
        session: summary(sessionResult.value),
        draft: draftResult.value?.content ?? "",
        recoveryIssue: recoveryView(this.#recovery.issueFor(sessionId)),
      }),
    );
    const output = this.#outputs.get(sessionId);
    if (output !== undefined) this.emit({ type: "terminal.data", sessionId, data: output });
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
    const size = this.#terminalSizes.get(sessionId) ?? { columns: 80, rows: 24 };
    if (this.#state.selectedSession?.id === sessionId) {
      this.setState(
        reduceConsoleViewState(this.#state, {
          type: "session.status",
          status: "starting",
          message: "Starting agent...",
        }),
      );
    }
    try {
      await this.#runController.start(session, profile, size);
    } catch (error) {
      if (this.#state.selectedSession?.id === sessionId) {
        this.setState(
          reduceConsoleViewState(this.#state, {
            type: "session.status",
            status: "failed",
            message: error instanceof Error ? error.message : String(error),
          }),
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

  public async sendTerminalInput(sessionId: SessionId, data: string): Promise<void> {
    const outcome = await this.#runController.sendInput(sessionId, data);
    if (outcome.status !== "accepted") {
      throw new ApplicationError(
        outcome.status === "rejected" ? "runtime.input-rejected" : "runtime.input-unknown",
        outcome.status === "rejected" ? outcome.message : outcome.reason,
      );
    }
  }

  public async resize(sessionId: SessionId, columns: number, rows: number): Promise<void> {
    this.#runController.assertMutationAllowed();
    this.#terminalSizes.set(sessionId, { columns, rows });
    const session = await this.getSession(sessionId);
    if (
      session.status === "starting" ||
      session.status === "running" ||
      session.status === "waiting_for_input"
    ) {
      await this.#runController.resize(sessionId, columns, rows);
    }
  }

  public interrupt(sessionId: SessionId): Promise<void> {
    return this.#runController.interrupt(sessionId);
  }

  public stop(sessionId: SessionId): Promise<void> {
    return this.#runController.stop(sessionId);
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
        if (!this.#runController.isCurrentRun(event.sessionId, event.runId)) return;
        const current = this.#outputs.get(event.sessionId) ?? "";
        this.#outputs.set(event.sessionId, `${current}${event.data}`.slice(-MAX_SESSION_OUTPUT));
        if (this.#state.selectedSession?.id === event.sessionId) {
          this.emit({ type: "terminal.data", sessionId: event.sessionId, data: event.data });
        }
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
      if (applied !== undefined && this.#state.selectedSession?.id === event.sessionId) {
        this.setState(
          reduceConsoleViewState(this.#state, {
            type: "session.status",
            status: applied.status,
            message: applied.message,
          }),
        );
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

  private setState(state: ConsoleViewState): void {
    this.#state = state;
    this.emit({ type: "console.state", state });
  }

  private emit(message: ExtensionToConsoleMessage): void {
    for (const listener of this.#listeners) listener(message);
  }
}
