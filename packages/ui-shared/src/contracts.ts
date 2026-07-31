export const CONSOLE_WEBVIEW_VERSION = 6 as const;

export type ConsoleConnectionStatus = "connecting" | "connected" | "disconnected" | "error";
export type ConsoleLifecycleState =
  "activating" | "active" | "shutting-down" | "stopped" | "failed";

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

export type ConsoleRunPhase =
  "starting" | "running" | "waiting-for-input" | "stopping" | "ended" | "interrupted";

/** Run identity selected for the Console terminal surface. */
export interface ConsoleRunSummary {
  readonly runId: string;
  readonly sessionId: string;
  readonly phase: ConsoleRunPhase;
  readonly interactive: boolean;
  readonly startedAt: string;
  readonly terminationReason?: string;
}

/** Content-free recovery state for one unresolved Session delivery outcome. */
export interface PromptRecoveryIssue {
  readonly requestId: string;
  readonly sessionId: string;
  readonly outcome: "unknown";
  readonly draftMatch: "exact" | "different" | "missing";
  readonly occurredAt: string;
}

export interface ConsoleViewState {
  readonly selectedSession: ConsoleSessionSummary | null;
  readonly selectedRun: ConsoleRunSummary | null;
  readonly draft: string;
  readonly recoveryIssue: PromptRecoveryIssue | null;
  readonly connectionStatus: ConsoleConnectionStatus;
  readonly lifecycleState: ConsoleLifecycleState;
  readonly statusMessage: string;
  readonly canStart: boolean;
  readonly canInterrupt: boolean;
  readonly canStop: boolean;
}

/** Requests delivery of one non-empty Prompt to a Session Runtime. */
export interface PromptSendMessage {
  readonly type: "prompt.send";
  readonly requestId: string;
  readonly sessionId: string;
  readonly content: string;
}

/** Local durability warning codes returned after Runtime dispatch started. */
export type PromptDeliveryWarningCode =
  | "attempt-runtime-accepted-save-failed"
  | "attempt-unknown-save-failed"
  | "attempt-finalize-failed"
  | "attempt-prune-failed"
  | "receipt-save-failed"
  | "draft-delete-failed"
  | "receipt-cleanup-update-failed"
  | "receipt-prune-failed";

/** Confirms Runtime input success while reporting local durability separately. */
export interface PromptAcceptedMessage {
  readonly type: "prompt.accepted";
  readonly requestId: string;
  readonly sessionId: string;
  readonly attemptPersistence: "stored" | "warning";
  readonly receiptPersistence: "stored" | "warning";
  readonly draftCleanup: "cleared" | "pending" | "warning";
  readonly warnings: readonly PromptDeliveryWarningCode[];
}

/** Reports that a Prompt was explicitly not delivered to the Runtime. */
export interface PromptRejectedMessage {
  readonly type: "prompt.rejected";
  readonly requestId: string;
  readonly sessionId: string;
  readonly message: string;
}

/** Reports that Runtime input may have been accepted and requires explicit recovery. */
export interface PromptUnknownMessage {
  readonly type: "prompt.unknown";
  readonly requestId: string;
  readonly sessionId: string;
  readonly message: string;
  readonly warnings: readonly PromptDeliveryWarningCode[];
}

/** Correlated result of a Prompt delivery request. */
export type PromptAcknowledgementMessage =
  PromptAcceptedMessage | PromptRejectedMessage | PromptUnknownMessage;

export interface TerminalRunKey {
  readonly sessionId: string;
  readonly runId: string;
}

export type TerminalRunInitial =
  | { readonly kind: "empty" }
  | {
      readonly kind: "replay";
      readonly data: string;
      readonly firstSeq: number;
      readonly lastSeq: number;
      readonly truncatedBytes: number;
    };

/** Opens or reselects one Run-scoped terminal surface. Replay is raw ANSI, not an emulator snapshot. */
export interface TerminalRunOpenMessage extends TerminalRunKey {
  readonly type: "terminal.run.open";
  readonly status: "active" | "ended" | "interrupted";
  readonly initial: TerminalRunInitial;
}

/** Rebuilds one surface from bounded raw ANSI after a detected sequence gap. */
export interface TerminalRunSnapshotMessage extends TerminalRunKey {
  readonly type: "terminal.run.snapshot";
  readonly status: "active" | "ended" | "interrupted";
  readonly data: string;
  readonly firstSeq: number;
  readonly lastSeq: number;
  readonly truncatedBytes: number;
}
export interface TerminalRunDataMessage extends TerminalRunKey {
  readonly type: "terminal.run.data";
  readonly seq: number;
  readonly data: string;
}

export interface TerminalRunResetMessage extends TerminalRunKey {
  readonly type: "terminal.run.reset";
}

export interface TerminalRunCloseMessage extends TerminalRunKey {
  readonly type: "terminal.run.close";
  readonly reason: string;
  readonly finalSeq: number;
}

export type ExtensionToConsoleMessage =
  | { readonly type: "console.state"; readonly state: ConsoleViewState }
  | TerminalRunOpenMessage
  | TerminalRunSnapshotMessage
  | TerminalRunDataMessage
  | TerminalRunResetMessage
  | TerminalRunCloseMessage
  | { readonly type: "prompt.focus" }
  | PromptAcknowledgementMessage;

export type ConsoleToExtensionMessage =
  | { readonly type: "webview.ready"; readonly version: typeof CONSOLE_WEBVIEW_VERSION }
  | { readonly type: "draft.changed"; readonly sessionId: string; readonly content: string }
  | PromptSendMessage
  | {
      readonly type: "prompt.recovery.assume-delivered" | "prompt.recovery.retry";
      readonly requestId: string;
      readonly sessionId: string;
    }
  | {
      readonly type: "terminal.run.input";
      readonly sessionId: string;
      readonly runId: string;
      readonly data: string;
    }
  | {
      readonly type: "terminal.run.resize";
      readonly sessionId: string;
      readonly runId: string;
      readonly columns: number;
      readonly rows: number;
    }
  | {
      readonly type: "terminal.run.snapshot-request";
      readonly sessionId: string;
      readonly runId: string;
      readonly afterSeq?: number;
    }
  | { readonly type: "session.start"; readonly sessionId: string }
  | {
      readonly type: "session.interrupt" | "session.stop";
      readonly sessionId: string;
      readonly runId: string;
    };

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasOnlyKeys = (value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean =>
  Object.keys(value).every((key) => keys.includes(key));

const hasSessionId = (
  value: Readonly<Record<string, unknown>>,
): value is Readonly<Record<string, unknown>> & { readonly sessionId: string } =>
  typeof value.sessionId === "string" && value.sessionId.length > 0;

const hasRunIdentity = (
  value: Readonly<Record<string, unknown>>,
): value is Readonly<Record<string, unknown>> & TerminalRunKey =>
  hasSessionId(value) && typeof value.runId === "string" && value.runId.length > 0;

const hasRequestAndSessionId = (
  value: Readonly<Record<string, unknown>>,
): value is Readonly<Record<string, unknown>> & {
  readonly requestId: string;
  readonly sessionId: string;
} => typeof value.requestId === "string" && value.requestId.length > 0 && hasSessionId(value);

const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

const consoleLifecycleStates: readonly ConsoleLifecycleState[] = [
  "activating",
  "active",
  "shutting-down",
  "stopped",
  "failed",
];

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

const consoleRunPhases: readonly ConsoleRunPhase[] = [
  "starting",
  "running",
  "waiting-for-input",
  "stopping",
  "ended",
  "interrupted",
];

const promptDeliveryWarningCodes: readonly PromptDeliveryWarningCode[] = [
  "attempt-runtime-accepted-save-failed",
  "attempt-unknown-save-failed",
  "attempt-finalize-failed",
  "attempt-prune-failed",
  "receipt-save-failed",
  "draft-delete-failed",
  "receipt-cleanup-update-failed",
  "receipt-prune-failed",
];

const isConsoleSessionSummary = (value: unknown): value is ConsoleSessionSummary =>
  isRecord(value) &&
  hasOnlyKeys(value, [
    "id",
    "title",
    "agentProfile",
    "workspace",
    "toolProfile",
    "status",
    "tags",
  ]) &&
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

const isConsoleRunSummary = (value: unknown): value is ConsoleRunSummary =>
  isRecord(value) &&
  hasOnlyKeys(value, [
    "runId",
    "sessionId",
    "phase",
    "interactive",
    "startedAt",
    "terminationReason",
  ]) &&
  hasRunIdentity(value) &&
  typeof value.phase === "string" &&
  consoleRunPhases.includes(value.phase as ConsoleRunPhase) &&
  typeof value.interactive === "boolean" &&
  typeof value.startedAt === "string" &&
  !Number.isNaN(Date.parse(value.startedAt)) &&
  (value.terminationReason === undefined || typeof value.terminationReason === "string");

const isPromptRecoveryIssue = (value: unknown): value is PromptRecoveryIssue =>
  isRecord(value) &&
  hasOnlyKeys(value, ["requestId", "sessionId", "outcome", "draftMatch", "occurredAt"]) &&
  hasRequestAndSessionId(value) &&
  value.outcome === "unknown" &&
  (value.draftMatch === "exact" ||
    value.draftMatch === "different" ||
    value.draftMatch === "missing") &&
  typeof value.occurredAt === "string" &&
  !Number.isNaN(Date.parse(value.occurredAt));

const isConsoleViewState = (value: unknown): value is ConsoleViewState => {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "selectedSession",
      "selectedRun",
      "draft",
      "recoveryIssue",
      "connectionStatus",
      "lifecycleState",
      "statusMessage",
      "canStart",
      "canInterrupt",
      "canStop",
    ]) ||
    !(value.selectedSession === null || isConsoleSessionSummary(value.selectedSession)) ||
    !(value.selectedRun === null || isConsoleRunSummary(value.selectedRun)) ||
    typeof value.draft !== "string" ||
    !(value.recoveryIssue === null || isPromptRecoveryIssue(value.recoveryIssue)) ||
    typeof value.connectionStatus !== "string" ||
    !consoleConnectionStatuses.includes(value.connectionStatus as ConsoleConnectionStatus) ||
    typeof value.lifecycleState !== "string" ||
    !consoleLifecycleStates.includes(value.lifecycleState as ConsoleLifecycleState) ||
    typeof value.statusMessage !== "string" ||
    typeof value.canStart !== "boolean" ||
    typeof value.canInterrupt !== "boolean" ||
    typeof value.canStop !== "boolean"
  ) {
    return false;
  }
  return (
    value.selectedRun === null ||
    (value.selectedSession !== null && value.selectedRun.sessionId === value.selectedSession.id)
  );
};

const hasValidWarnings = (value: unknown): value is readonly PromptDeliveryWarningCode[] =>
  Array.isArray(value) &&
  value.every(
    (warning) =>
      typeof warning === "string" &&
      promptDeliveryWarningCodes.includes(warning as PromptDeliveryWarningCode),
  );

const isTerminalRunInitial = (value: unknown): value is TerminalRunInitial => {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  if (value.kind === "empty") return hasOnlyKeys(value, ["kind"]);
  return (
    value.kind === "replay" &&
    hasOnlyKeys(value, ["kind", "data", "firstSeq", "lastSeq", "truncatedBytes"]) &&
    typeof value.data === "string" &&
    isNonNegativeInteger(value.firstSeq) &&
    isNonNegativeInteger(value.lastSeq) &&
    value.firstSeq <= value.lastSeq &&
    isNonNegativeInteger(value.truncatedBytes)
  );
};

/** Validates messages received by the Extension Host from the Console Webview. */
export const isConsoleToExtensionMessage = (value: unknown): value is ConsoleToExtensionMessage => {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  switch (value.type) {
    case "webview.ready":
      return hasOnlyKeys(value, ["type", "version"]) && value.version === CONSOLE_WEBVIEW_VERSION;
    case "draft.changed":
      return (
        hasOnlyKeys(value, ["type", "sessionId", "content"]) &&
        hasSessionId(value) &&
        typeof value.content === "string"
      );
    case "prompt.send":
      return (
        hasOnlyKeys(value, ["type", "requestId", "sessionId", "content"]) &&
        hasRequestAndSessionId(value) &&
        typeof value.content === "string" &&
        value.content.trim().length > 0
      );
    case "prompt.recovery.assume-delivered":
    case "prompt.recovery.retry":
      return (
        hasRequestAndSessionId(value) && hasOnlyKeys(value, ["type", "requestId", "sessionId"])
      );
    case "terminal.run.input":
      return (
        hasOnlyKeys(value, ["type", "sessionId", "runId", "data"]) &&
        hasRunIdentity(value) &&
        typeof value.data === "string"
      );
    case "terminal.run.resize":
      return (
        hasOnlyKeys(value, ["type", "sessionId", "runId", "columns", "rows"]) &&
        hasRunIdentity(value) &&
        typeof value.columns === "number" &&
        Number.isInteger(value.columns) &&
        value.columns > 0 &&
        typeof value.rows === "number" &&
        Number.isInteger(value.rows) &&
        value.rows > 0
      );
    case "terminal.run.snapshot-request":
      return (
        hasOnlyKeys(value, ["type", "sessionId", "runId", "afterSeq"]) &&
        hasRunIdentity(value) &&
        (value.afterSeq === undefined || isNonNegativeInteger(value.afterSeq))
      );
    case "session.start":
      return hasOnlyKeys(value, ["type", "sessionId"]) && hasSessionId(value);
    case "session.interrupt":
    case "session.stop":
      return hasOnlyKeys(value, ["type", "sessionId", "runId"]) && hasRunIdentity(value);
    default:
      return false;
  }
};

/** Validates messages received by the Console Webview from the Extension Host. */
export const isExtensionToConsoleMessage = (value: unknown): value is ExtensionToConsoleMessage => {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  switch (value.type) {
    case "console.state":
      return hasOnlyKeys(value, ["type", "state"]) && isConsoleViewState(value.state);
    case "terminal.run.open":
      return (
        hasOnlyKeys(value, ["type", "sessionId", "runId", "status", "initial"]) &&
        hasRunIdentity(value) &&
        (value.status === "active" || value.status === "ended" || value.status === "interrupted") &&
        isTerminalRunInitial(value.initial)
      );
    case "terminal.run.data":
      return (
        hasOnlyKeys(value, ["type", "sessionId", "runId", "seq", "data"]) &&
        hasRunIdentity(value) &&
        isNonNegativeInteger(value.seq) &&
        typeof value.data === "string"
      );
    case "terminal.run.snapshot":
      return (
        hasOnlyKeys(value, [
          "type",
          "sessionId",
          "runId",
          "status",
          "data",
          "firstSeq",
          "lastSeq",
          "truncatedBytes",
        ]) &&
        hasRunIdentity(value) &&
        (value.status === "active" || value.status === "ended" || value.status === "interrupted") &&
        typeof value.data === "string" &&
        isNonNegativeInteger(value.firstSeq) &&
        isNonNegativeInteger(value.lastSeq) &&
        value.firstSeq <= value.lastSeq &&
        isNonNegativeInteger(value.truncatedBytes)
      );
    case "terminal.run.reset":
      return hasOnlyKeys(value, ["type", "sessionId", "runId"]) && hasRunIdentity(value);
    case "terminal.run.close":
      return (
        hasOnlyKeys(value, ["type", "sessionId", "runId", "reason", "finalSeq"]) &&
        hasRunIdentity(value) &&
        typeof value.reason === "string" &&
        value.reason.length > 0 &&
        isNonNegativeInteger(value.finalSeq)
      );
    case "prompt.focus":
      return hasOnlyKeys(value, ["type"]);
    case "prompt.accepted":
      return (
        hasRequestAndSessionId(value) &&
        hasOnlyKeys(value, [
          "type",
          "requestId",
          "sessionId",
          "attemptPersistence",
          "receiptPersistence",
          "draftCleanup",
          "warnings",
        ]) &&
        (value.attemptPersistence === "stored" || value.attemptPersistence === "warning") &&
        (value.receiptPersistence === "stored" || value.receiptPersistence === "warning") &&
        (value.draftCleanup === "cleared" ||
          value.draftCleanup === "pending" ||
          value.draftCleanup === "warning") &&
        hasValidWarnings(value.warnings)
      );
    case "prompt.unknown":
      return (
        hasRequestAndSessionId(value) &&
        hasOnlyKeys(value, ["type", "requestId", "sessionId", "message", "warnings"]) &&
        typeof value.message === "string" &&
        value.message.length > 0 &&
        hasValidWarnings(value.warnings)
      );
    case "prompt.rejected":
      return (
        hasRequestAndSessionId(value) &&
        hasOnlyKeys(value, ["type", "requestId", "sessionId", "message"]) &&
        typeof value.message === "string" &&
        value.message.length > 0
      );
    default:
      return false;
  }
};
