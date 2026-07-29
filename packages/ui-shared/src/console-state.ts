import type {
  ConsoleConnectionStatus,
  ConsoleSessionSummary,
  ConsoleViewState,
} from "./contracts.js";

export type ConsoleStateAction =
  | {
      readonly type: "session.selected";
      readonly session: ConsoleSessionSummary | null;
      readonly draft: string;
    }
  | {
      readonly type: "draft.updated";
      readonly draft: string;
    }
  | {
      readonly type: "connection.changed";
      readonly status: ConsoleConnectionStatus;
      readonly message: string;
    }
  | {
      readonly type: "session.status";
      readonly status: ConsoleSessionSummary["status"];
      readonly message: string;
    };

export const initialConsoleViewState = (): ConsoleViewState => ({
  selectedSession: null,
  draft: "",
  connectionStatus: "disconnected",
  statusMessage: "Select a session to open its console.",
  canStart: false,
  canInterrupt: false,
  canStop: false,
});

const controlsForStatus = (
  session: ConsoleSessionSummary | null,
  connectionStatus: ConsoleConnectionStatus,
): Pick<ConsoleViewState, "canStart" | "canInterrupt" | "canStop"> => {
  if (session === null || connectionStatus !== "connected") {
    return { canStart: false, canInterrupt: false, canStop: false };
  }

  const active =
    session.status === "starting" ||
    session.status === "running" ||
    session.status === "waiting_for_input";
  return {
    canStart:
      session.status === "idle" ||
      session.status === "stopped" ||
      session.status === "failed" ||
      session.status === "completed",
    canInterrupt: session.status === "running" || session.status === "waiting_for_input",
    canStop: active,
  };
};

const withControls = (state: Omit<ConsoleViewState, "canStart" | "canInterrupt" | "canStop">) => ({
  ...state,
  ...controlsForStatus(state.selectedSession, state.connectionStatus),
});

export const reduceConsoleViewState = (
  state: ConsoleViewState,
  action: ConsoleStateAction,
): ConsoleViewState => {
  switch (action.type) {
    case "session.selected":
      return withControls({
        ...state,
        selectedSession: action.session,
        draft: action.draft,
        statusMessage:
          action.session === null
            ? "Select a session to open its console."
            : `${action.session.title} is ${action.session.status.replaceAll("_", " ")}.`,
      });
    case "draft.updated":
      return { ...state, draft: action.draft };
    case "connection.changed":
      return withControls({
        ...state,
        connectionStatus: action.status,
        statusMessage: action.message,
      });
    case "session.status": {
      if (state.selectedSession === null) {
        return { ...state, statusMessage: action.message };
      }
      return withControls({
        ...state,
        selectedSession: { ...state.selectedSession, status: action.status },
        statusMessage: action.message,
      });
    }
  }
};
