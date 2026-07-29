export const CONSOLE_WEBVIEW_VERSION = 1 as const;

export type ConsoleConnectionStatus = "connecting" | "connected" | "disconnected" | "error";

export type ConsoleSessionStatus =
  "idle" | "starting" | "running" | "waiting_for_input" | "stopped" | "failed" | "completed";

export interface ConsoleSessionSummary {
  readonly id: string;
  readonly title: string;
  readonly agentProfile: string;
  readonly workspace: string;
  readonly toolProfile: string;
  readonly status: ConsoleSessionStatus;
  readonly tags: readonly string[];
}

export interface ConsoleViewState {
  readonly selectedSession: ConsoleSessionSummary | null;
  readonly draft: string;
  readonly connectionStatus: ConsoleConnectionStatus;
  readonly statusMessage: string;
  readonly canStart: boolean;
  readonly canInterrupt: boolean;
  readonly canStop: boolean;
}

export type ExtensionToConsoleMessage =
  | {
      readonly type: "console.state";
      readonly state: ConsoleViewState;
    }
  | {
      readonly type: "terminal.data";
      readonly sessionId: string;
      readonly data: string;
    }
  | {
      readonly type: "terminal.clear";
      readonly sessionId: string | null;
    }
  | {
      readonly type: "prompt.focus";
    };

export type ConsoleToExtensionMessage =
  | {
      readonly type: "webview.ready";
      readonly version: typeof CONSOLE_WEBVIEW_VERSION;
    }
  | {
      readonly type: "draft.changed";
      readonly sessionId: string;
      readonly content: string;
    }
  | {
      readonly type: "prompt.send";
      readonly sessionId: string;
      readonly content: string;
    }
  | {
      readonly type: "terminal.input";
      readonly sessionId: string;
      readonly data: string;
    }
  | {
      readonly type: "terminal.resize";
      readonly sessionId: string;
      readonly columns: number;
      readonly rows: number;
    }
  | {
      readonly type: "session.start" | "session.interrupt" | "session.stop";
      readonly sessionId: string;
    };

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasSessionId = (
  value: Readonly<Record<string, unknown>>,
): value is Readonly<Record<string, unknown>> & { readonly sessionId: string } =>
  typeof value.sessionId === "string" && value.sessionId.length > 0;

export const isConsoleToExtensionMessage = (value: unknown): value is ConsoleToExtensionMessage => {
  if (!isRecord(value) || typeof value.type !== "string") {
    return false;
  }

  switch (value.type) {
    case "webview.ready":
      return value.version === CONSOLE_WEBVIEW_VERSION;
    case "draft.changed":
    case "prompt.send":
    case "terminal.input":
      return hasSessionId(value) && typeof value.content === "string"
        ? value.type !== "terminal.input"
        : hasSessionId(value) && value.type === "terminal.input" && typeof value.data === "string";
    case "terminal.resize":
      return (
        hasSessionId(value) &&
        typeof value.columns === "number" &&
        Number.isInteger(value.columns) &&
        value.columns > 0 &&
        typeof value.rows === "number" &&
        Number.isInteger(value.rows) &&
        value.rows > 0
      );
    case "session.start":
    case "session.interrupt":
    case "session.stop":
      return hasSessionId(value);
    default:
      return false;
  }
};
