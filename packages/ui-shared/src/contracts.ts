export const CONSOLE_WEBVIEW_VERSION = 2 as const;

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

/** Requests delivery of one non-empty prompt to a Session runtime. */
export interface PromptSendMessage {
  readonly type: "prompt.send";
  readonly requestId: string;
  readonly sessionId: string;
  readonly content: string;
}

/** Confirms that the runtime accepted a prompt, independently of local Draft cleanup. */
export type PromptAcceptedMessage = {
  readonly type: "prompt.accepted";
  readonly requestId: string;
  readonly sessionId: string;
} & (
  | {
      readonly draftCleanup: "cleared";
      readonly warning?: never;
    }
  | {
      readonly draftCleanup: "warning";
      readonly warning: string;
    }
);

/** Reports that a prompt was not delivered to the runtime. */
export interface PromptRejectedMessage {
  readonly type: "prompt.rejected";
  readonly requestId: string;
  readonly sessionId: string;
  readonly message: string;
}

/** Correlated result of a prompt delivery request. */
export type PromptAcknowledgementMessage = PromptAcceptedMessage | PromptRejectedMessage;

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
    }
  | PromptAcknowledgementMessage;

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
  | PromptSendMessage
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

const hasRequestAndSessionId = (
  value: Readonly<Record<string, unknown>>,
): value is Readonly<Record<string, unknown>> & {
  readonly requestId: string;
  readonly sessionId: string;
} => typeof value.requestId === "string" && value.requestId.length > 0 && hasSessionId(value);

const consoleConnectionStatuses: readonly ConsoleConnectionStatus[] = [
  "connecting",
  "connected",
  "disconnected",
  "error",
];

const consoleSessionStatuses: readonly ConsoleSessionStatus[] = [
  "idle",
  "starting",
  "running",
  "waiting_for_input",
  "stopped",
  "failed",
  "completed",
];

const isConsoleSessionSummary = (value: unknown): value is ConsoleSessionSummary =>
  isRecord(value) &&
  typeof value.id === "string" &&
  value.id.length > 0 &&
  typeof value.title === "string" &&
  typeof value.agentProfile === "string" &&
  typeof value.workspace === "string" &&
  typeof value.toolProfile === "string" &&
  typeof value.status === "string" &&
  consoleSessionStatuses.includes(value.status as ConsoleSessionStatus) &&
  Array.isArray(value.tags) &&
  value.tags.every((tag) => typeof tag === "string");

const isConsoleViewState = (value: unknown): value is ConsoleViewState =>
  isRecord(value) &&
  (value.selectedSession === null || isConsoleSessionSummary(value.selectedSession)) &&
  typeof value.draft === "string" &&
  typeof value.connectionStatus === "string" &&
  consoleConnectionStatuses.includes(value.connectionStatus as ConsoleConnectionStatus) &&
  typeof value.statusMessage === "string" &&
  typeof value.canStart === "boolean" &&
  typeof value.canInterrupt === "boolean" &&
  typeof value.canStop === "boolean";

/** Validates messages received by the Extension Host from the Console Webview. */
export const isConsoleToExtensionMessage = (value: unknown): value is ConsoleToExtensionMessage => {
  if (!isRecord(value) || typeof value.type !== "string") {
    return false;
  }

  switch (value.type) {
    case "webview.ready":
      return value.version === CONSOLE_WEBVIEW_VERSION;
    case "draft.changed":
      return hasSessionId(value) && typeof value.content === "string";
    case "prompt.send":
      return (
        hasRequestAndSessionId(value) &&
        typeof value.content === "string" &&
        value.content.trim().length > 0
      );
    case "terminal.input":
      return hasSessionId(value) && typeof value.data === "string";
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

/** Validates messages received by the Console Webview from the Extension Host. */
export const isExtensionToConsoleMessage = (value: unknown): value is ExtensionToConsoleMessage => {
  if (!isRecord(value) || typeof value.type !== "string") {
    return false;
  }

  switch (value.type) {
    case "console.state":
      return isConsoleViewState(value.state);
    case "terminal.data":
      return hasSessionId(value) && typeof value.data === "string";
    case "terminal.clear":
      return value.sessionId === null || hasSessionId(value);
    case "prompt.focus":
      return true;
    case "prompt.accepted":
      if (!hasRequestAndSessionId(value)) {
        return false;
      }
      return value.draftCleanup === "cleared"
        ? value.warning === undefined
        : value.draftCleanup === "warning" &&
            typeof value.warning === "string" &&
            value.warning.length > 0;
    case "prompt.rejected":
      return (
        hasRequestAndSessionId(value) &&
        typeof value.message === "string" &&
        value.message.length > 0
      );
    default:
      return false;
  }
};
