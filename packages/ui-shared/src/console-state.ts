import type {
  ConsoleConnectionStatus,
  ConsoleLifecycleState,
  ConsoleRunSummary,
  ConsoleSessionSummary,
  ConsoleViewState,
  PromptRecoveryIssue,
} from "./contracts.js";

export type ConsoleStateAction =
  | {
      readonly type: "session.selected";
      readonly session: ConsoleSessionSummary | null;
      readonly run: ConsoleRunSummary | null;
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
      readonly type: "session.status";
      readonly status: ConsoleSessionSummary["status"];
      readonly run: ConsoleRunSummary | null;
      readonly message: string;
    };

export const initialConsoleViewState = (): ConsoleViewState => ({
  selectedSession: null,
  selectedRun: null,
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
  run: ConsoleRunSummary | null,
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
  const activeRun =
    run !== null &&
    (run.phase === "starting" ||
      run.phase === "running" ||
      run.phase === "waiting-for-input" ||
      run.phase === "stopping");
  return {
    canStart: terminalSession && !activeRun,
    canInterrupt: run?.interactive === true,
    canStop: activeRun,
  };
};

const withControls = (
  state: Omit<ConsoleViewState, "canStart" | "canInterrupt" | "canStop">,
): ConsoleViewState => ({
  ...state,
  ...controlsForState(
    state.selectedSession,
    state.selectedRun,
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
        selectedRun: action.run,
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
    case "session.status": {
      if (state.selectedSession === null) {
        return withControls({ ...state, selectedRun: action.run, statusMessage: action.message });
      }
      return withControls({
        ...state,
        selectedSession: { ...state.selectedSession, status: action.status },
        selectedRun: action.run,
        statusMessage: action.message,
      });
    }
  }
};
