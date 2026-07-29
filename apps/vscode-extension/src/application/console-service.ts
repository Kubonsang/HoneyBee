import {
  SessionDraftSchema,
  type AgentSession,
  type SessionId,
  type SessionStatus,
} from "@honeybee/domain";
import type { DraftRepository, SessionRepository } from "@honeybee/persistence";
import {
  initialConsoleViewState,
  reduceConsoleViewState,
  type ConsoleSessionSummary,
  type ConsoleViewState,
  type ExtensionToConsoleMessage,
} from "@honeybee/ui-shared";

import { ApplicationError } from "./errors.js";
import { deliverPrompt, type PromptDeliveryResult } from "./prompt-delivery.js";
import type {
  AgentProfileResolverPort,
  ClockPort,
  RuntimeClientEvent,
  RuntimeClientPort,
} from "./ports.js";
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

export class ConsoleApplicationService {
  readonly #listeners = new Set<(message: ExtensionToConsoleMessage) => void>();
  readonly #outputs = new Map<SessionId, string>();
  readonly #terminalSizes = new Map<SessionId, TerminalSize>();
  readonly #runtimeSubscription: { dispose(): void };
  readonly #selectionSubscription: { dispose(): void };
  #state: ConsoleViewState = initialConsoleViewState();

  public constructor(
    private readonly sessions: SessionRepository,
    private readonly drafts: DraftRepository,
    selection: SessionSelectionService,
    private readonly runtime: RuntimeClientPort,
    private readonly profiles: AgentProfileResolverPort,
    private readonly clock: ClockPort,
  ) {
    this.#runtimeSubscription = runtime.onEvent((event) => {
      this.handleRuntimeEvent(event);
    });
    this.#selectionSubscription = selection.onDidSelect((sessionId) => {
      this.select(sessionId);
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
        message: "Connecting to the separate runtime…",
      }),
    );
    await this.runtime.connect();
  }

  public onMessage(listener: (message: ExtensionToConsoleMessage) => void): { dispose(): void } {
    this.#listeners.add(listener);
    return {
      dispose: () => {
        this.#listeners.delete(listener);
      },
    };
  }

  public replayState(): void {
    this.emit({ type: "console.state", state: this.#state });
    const sessionId = this.#state.selectedSession?.id;
    if (sessionId === undefined) {
      return;
    }
    const output = this.#outputs.get(this.parseSessionId(sessionId));
    if (output !== undefined) {
      this.emit({ type: "terminal.data", sessionId, data: output });
    }
  }

  public async select(sessionId: SessionId | undefined): Promise<void> {
    if (sessionId === undefined) {
      this.emit({ type: "terminal.clear", sessionId: null });
      this.setState(
        reduceConsoleViewState(this.#state, {
          type: "session.selected",
          session: null,
          draft: "",
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
      }),
    );
    const output = this.#outputs.get(sessionId);
    if (output !== undefined) {
      this.emit({ type: "terminal.data", sessionId, data: output });
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
    if (this.#state.selectedSession?.id === sessionId) {
      this.setState(
        reduceConsoleViewState(this.#state, {
          type: "draft.updated",
          draft: content,
        }),
      );
    }
  }

  public async start(sessionId: SessionId): Promise<void> {
    const session = await this.getSession(sessionId);
    const profile = await this.profiles.resolve(
      session.agentProfileId,
      session.toolProfileId,
      session.workspaceId,
    );
    const size = this.#terminalSizes.get(sessionId) ?? { columns: 80, rows: 24 };
    await this.updateStatus(session, "starting", "Starting agent…");
    try {
      await this.runtime.start({
        sessionId,
        command: profile.command,
        args: profile.args,
        cwd: profile.cwd,
        environment: profile.environment,
        shell: profile.shell,
        columns: size.columns,
        rows: size.rows,
      });
    } catch (error) {
      await this.updateStatus(
        await this.getSession(sessionId),
        "failed",
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  }

  public async sendPrompt(sessionId: SessionId, content: string): Promise<PromptDeliveryResult> {
    const result = await deliverPrompt(
      { drafts: this.drafts, runtime: this.runtime, clock: this.clock },
      sessionId,
      content,
    );
    if (result.status === "accepted" && this.#state.selectedSession?.id === sessionId) {
      this.setState(
        reduceConsoleViewState(this.#state, {
          type: "draft.updated",
          draft: "",
        }),
      );
    }
    return result;
  }

  public async sendTerminalInput(sessionId: SessionId, data: string): Promise<void> {
    await this.runtime.sendInput(sessionId, data);
  }

  public async resize(sessionId: SessionId, columns: number, rows: number): Promise<void> {
    this.#terminalSizes.set(sessionId, { columns, rows });
    const session = await this.getSession(sessionId);
    if (
      session.status === "starting" ||
      session.status === "running" ||
      session.status === "waiting_for_input"
    ) {
      await this.runtime.resize(sessionId, columns, rows);
    }
  }

  public async interrupt(sessionId: SessionId): Promise<void> {
    await this.runtime.interrupt(sessionId);
  }

  public async stop(sessionId: SessionId): Promise<void> {
    await this.runtime.stop(sessionId);
  }

  public async dispose(): Promise<void> {
    this.#runtimeSubscription.dispose();
    this.#selectionSubscription.dispose();
    await this.runtime.dispose();
    this.#listeners.clear();
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
        break;
      case "pty.data": {
        const current = this.#outputs.get(event.sessionId) ?? "";
        this.#outputs.set(event.sessionId, `${current}${event.data}`.slice(-MAX_SESSION_OUTPUT));
        if (this.#state.selectedSession?.id === event.sessionId) {
          this.emit({
            type: "terminal.data",
            sessionId: event.sessionId,
            data: event.data,
          });
        }
        break;
      }
      case "session.status":
        this.applyRuntimeStatus(event.sessionId, event.status, event.message);
        break;
      case "runtime.error":
        if (event.sessionId !== undefined) {
          this.applyRuntimeStatus(event.sessionId, "failed", event.message);
        } else {
          this.setState(
            reduceConsoleViewState(this.#state, {
              type: "connection.changed",
              status: "error",
              message: event.message,
            }),
          );
        }
        break;
    }
  }

  private async applyRuntimeStatus(
    sessionId: SessionId,
    status: SessionStatus,
    message: string,
  ): Promise<void> {
    try {
      await this.updateStatus(await this.getSession(sessionId), status, message);
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

  private async updateStatus(
    session: AgentSession,
    status: SessionStatus,
    message: string,
  ): Promise<void> {
    const result = await this.sessions.save({
      ...session,
      status,
      updatedAt: this.clock.now(),
    });
    if (!result.ok) {
      throw new ApplicationError(result.error.code, result.error.message, result.error.details);
    }
    if (this.#state.selectedSession?.id === session.id) {
      this.setState(
        reduceConsoleViewState(this.#state, {
          type: "session.status",
          status,
          message,
        }),
      );
    }
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
    for (const listener of this.#listeners) {
      listener(message);
    }
  }
}
