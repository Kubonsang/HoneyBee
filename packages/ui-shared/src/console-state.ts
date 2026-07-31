import type {
  ConsoleConnectionStatus,
  ConsoleLifecycleState,
  ConsoleRunListItem,
  ConsoleRunSummary,
  ConsoleSessionSummary,
  ConsoleViewState,
  PromptRecoveryIssue,
} from "./contracts.js";

export type ConsoleStateAction =
  | {
      readonly type: "session.selected";
      readonly session: ConsoleSessionSummary | null;
      readonly activeRun: ConsoleRunSummary | null;
      readonly viewedRun: ConsoleRunSummary | null;
      readonly availableRuns: readonly ConsoleRunListItem[];
      readonly followLive: boolean;
      readonly draft: string;
      readonly recoveryIssue: PromptRecoveryIssue | null;
    }
  | { readonly type: "lifecycle.changed"; readonly state: ConsoleLifecycleState }
  | { readonly type: "draft.updated"; readonly draft: string }
  | {
      readonly type: "recovery.changed";
      readonly recoveryIssue: PromptRecoveryIssue | null;
      readonly message: string;
    }
  | {
      readonly type: "connection.changed";
      readonly status: ConsoleConnectionStatus;
      readonly message: string;
    }
  | {
      readonly type: "session.runs.changed";
      readonly status: ConsoleSessionSummary["status"];
      readonly activeRun: ConsoleRunSummary | null;
      readonly viewedRun: ConsoleRunSummary | null;
      readonly availableRuns: readonly ConsoleRunListItem[];
      readonly followLive: boolean;
      readonly message: string;
    };

export const initialConsoleViewState = (): ConsoleViewState => ({
  selectedSession: null,
  activeRun: null,
  viewedRun: null,
  availableRuns: [],
  followLive: false,
  draft: "",
  recoveryIssue: null,
  connectionStatus: "disconnected",
  lifecycleState: "activating",
  statusMessage: "Select a session to open its console.",
  canStart: false,
  canInterrupt: false,
  canStop: false,
});

const controlsForState = (
  session: ConsoleSessionSummary | null,
  activeRun: ConsoleRunSummary | null,
  viewedRun: ConsoleRunSummary | null,
  connectionStatus: ConsoleConnectionStatus,
  lifecycleState: ConsoleLifecycleState,
): Pick<ConsoleViewState, "canStart" | "canInterrupt" | "canStop"> => {
  if (session === null || connectionStatus !== "connected" || lifecycleState !== "active") {
    return { canStart: false, canInterrupt: false, canStop: false };
  }
  const terminalSession =
    session.status === "idle" ||
    session.status === "stopped" ||
    session.status === "failed" ||
    session.status === "completed";
  const viewingActive =
    activeRun !== null &&
    viewedRun !== null &&
    activeRun.sessionId === viewedRun.sessionId &&
    activeRun.runId === viewedRun.runId;
  const activePhase =
    activeRun !== null &&
    (activeRun.phase === "starting" ||
      activeRun.phase === "running" ||
      activeRun.phase === "waiting-for-input" ||
      activeRun.phase === "stopping");
  return {
    canStart: terminalSession && activeRun === null,
    canInterrupt: viewingActive && activeRun.interactive,
    canStop: viewingActive && activePhase,
  };
};

const withControls = (
  state: Omit<ConsoleViewState, "canStart" | "canInterrupt" | "canStop">,
): ConsoleViewState => ({
  ...state,
  ...controlsForState(
    state.selectedSession,
    state.activeRun,
    state.viewedRun,
    state.connectionStatus,
    state.lifecycleState,
  ),
});

export const reduceConsoleViewState = (
  state: ConsoleViewState,
  action: ConsoleStateAction,
): ConsoleViewState => {
  switch (action.type) {
    case "lifecycle.changed":
      return withControls({
        ...state,
        lifecycleState: action.state,
        statusMessage:
          action.state === "shutting-down"
            ? "Honey Bee is shutting down. Runtime controls are disabled."
            : state.statusMessage,
      });
    case "session.selected":
      return withControls({
        ...state,
        selectedSession: action.session,
        activeRun: action.activeRun,
        viewedRun: action.viewedRun,
        availableRuns: action.availableRuns,
        followLive: action.followLive,
        draft: action.draft,
        recoveryIssue: action.recoveryIssue,
        statusMessage:
          action.session === null
            ? "Select a session to open its console."
            : action.session.title + " is " + action.session.status.replaceAll("_", " ") + ".",
      });
    case "draft.updated":
      return { ...state, draft: action.draft };
    case "recovery.changed":
      return { ...state, recoveryIssue: action.recoveryIssue, statusMessage: action.message };
    case "connection.changed":
      return withControls({
        ...state,
        connectionStatus: action.status,
        statusMessage: action.message,
      });
    case "session.runs.changed": {
      if (state.selectedSession === null) {
        return withControls({
          ...state,
          activeRun: action.activeRun,
          viewedRun: action.viewedRun,
          availableRuns: action.availableRuns,
          followLive: action.followLive,
          statusMessage: action.message,
        });
      }
      return withControls({
        ...state,
        selectedSession: { ...state.selectedSession, status: action.status },
        activeRun: action.activeRun,
        viewedRun: action.viewedRun,
        availableRuns: action.availableRuns,
        followLive: action.followLive,
        statusMessage: action.message,
      });
    }
  }
};
