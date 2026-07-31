import "@xterm/xterm/css/xterm.css";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js";

import {
  CONSOLE_WEBVIEW_VERSION,
  isExtensionToConsoleMessage,
  type ConsoleToExtensionMessage,
  type ConsoleViewState,
  type PromptAcknowledgementMessage,
  type TerminalRunKey,
} from "../contracts.js";
import {
  PromptDeliveryTracker,
  promptAcceptedStatusMessage,
  reconcileDraftAfterSettlement,
} from "../prompt-delivery-state.js";
import { createPromptKeyBindings, shouldSubmitPrompt } from "../prompt-input-policy.js";
import {
  formatRunOption,
  replayPresentation,
  runSelectionAnnouncement,
} from "../run-selector-model.js";
import { TerminalRunRegistry, type TerminalDimensions } from "./terminal-run-registry.js";
import { XtermTerminalSurfaceFactory } from "./xterm-terminal-surface.js";
import "./console.css";

interface VsCodeApi {
  postMessage(message: ConsoleToExtensionMessage): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();

const requiredElement = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (element === null) {
    throw new Error('Required element "' + id + '" was not found.');
  }
  return element as T;
};

const terminalElement = requiredElement<HTMLDivElement>("terminal");
const terminalMode = requiredElement<HTMLElement>("terminal-mode");
const terminalWarning = requiredElement<HTMLElement>("terminal-warning");
const terminalWarningTitle = requiredElement<HTMLElement>("terminal-warning-title");
const terminalWarningDetails = requiredElement<HTMLDetailsElement>("terminal-warning-details");
const terminalWarningSummary = requiredElement<HTMLElement>("terminal-warning-summary");
const terminalWarningDescription = requiredElement<HTMLElement>("terminal-warning-description");
const terminalPlaceholder = requiredElement<HTMLElement>("terminal-placeholder");
const runSelector = requiredElement<HTMLSelectElement>("run-selector");
const openLogButton = requiredElement<HTMLButtonElement>("open-log-button");
const liveRunNotice = requiredElement<HTMLElement>("live-run-notice");
const returnLiveButton = requiredElement<HTMLButtonElement>("return-live-button");
const runAccessibleStatus = requiredElement<HTMLElement>("run-accessible-status");
const editorElement = requiredElement<HTMLDivElement>("prompt-editor");
const sessionValue = requiredElement<HTMLElement>("session-value");
const runValue = requiredElement<HTMLElement>("run-value");
const agentValue = requiredElement<HTMLElement>("agent-value");
const workspaceValue = requiredElement<HTMLElement>("workspace-value");
const toolValue = requiredElement<HTMLElement>("tool-value");
const connectionBadge = requiredElement<HTMLElement>("connection-badge");
const sessionStatus = requiredElement<HTMLElement>("session-status");
const statusMessage = requiredElement<HTMLElement>("status-message");
const startButton = requiredElement<HTMLButtonElement>("start-button");
const interruptButton = requiredElement<HTMLButtonElement>("interrupt-button");
const stopButton = requiredElement<HTMLButtonElement>("stop-button");
const sendButton = requiredElement<HTMLButtonElement>("send-button");
const recoveryBanner = requiredElement<HTMLElement>("recovery-banner");
const recoveryMessage = requiredElement<HTMLElement>("recovery-message");
const assumeDeliveredButton = requiredElement<HTMLButtonElement>("assume-delivered-button");
const retryPromptButton = requiredElement<HTMLButtonElement>("retry-prompt-button");

let visibleTerminalKey: TerminalRunKey | undefined;

const terminalRegistry = new TerminalRunRegistry({
  factory: new XtermTerminalSurfaceFactory(terminalElement),
  onInput: (key, data) => {
    vscode.postMessage({ type: "terminal.run.input", ...key, data });
  },
  onResize: (key, size: TerminalDimensions) => {
    vscode.postMessage({
      type: "terminal.run.resize",
      ...key,
      columns: size.columns,
      rows: size.rows,
    });
  },
  onSnapshotRequest: (key, afterSeq) => {
    vscode.postMessage({
      type: "terminal.run.snapshot-request",
      ...key,
      ...(afterSeq === undefined ? {} : { afterSeq }),
    });
  },
  onDiagnostic: (code, key) => {
    if (visibleTerminalKey?.sessionId !== key.sessionId || visibleTerminalKey.runId !== key.runId) {
      return;
    }
    if (code === "terminal-run-replay-truncated") {
      terminalWarningTitle.textContent =
        "Truncated replay · reconstructed screen may be incomplete";
      terminalWarningDescription.textContent =
        "Earlier terminal output was evicted from memory; exact TUI reconstruction is unavailable.";
      terminalWarning.hidden = false;
    } else if (code === "terminal-run-sequence-gap") {
      terminalWarningTitle.textContent = "Sequence gap · reconstructed screen may be inconsistent";
      terminalWarningDescription.textContent =
        "One or more terminal output events were missed. Honey Bee requested a bounded replay.";
      terminalWarning.hidden = false;
    }
  },
});

const editor = monaco.editor.create(editorElement, {
  accessibilitySupport: "auto",
  automaticLayout: true,
  cursorBlinking: "smooth",
  fontFamily:
    "var(--vscode-editor-font-family, 'Cascadia Code', 'SFMono-Regular', Consolas, monospace)",
  fontSize: 12,
  language: "plaintext",
  lineNumbers: "off",
  minimap: { enabled: false },
  overviewRulerBorder: false,
  overviewRulerLanes: 0,
  padding: { top: 10, bottom: 10 },
  renderLineHighlight: "none",
  scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
  scrollBeyondLastLine: false,
  tabSize: 2,
  theme: "vs-dark",
  value: "",
  wordWrap: "on",
});

let activeState: ConsoleViewState | undefined;
let activeSessionId: string | undefined;
let viewedRunId: string | undefined;
let lastRunAnnouncement = "";
let suppressDraftMessage = false;
let isComposing = false;
const localDrafts = new Map<string, string>();
const promptDelivery = new PromptDeliveryTracker();

const selectedSessionId = (): string | undefined => activeState?.selectedSession?.id;

const viewedRunKey = (): TerminalRunKey | undefined => {
  const run = activeState?.viewedRun;
  return run === null || run === undefined
    ? undefined
    : { sessionId: run.sessionId, runId: run.runId };
};

const isViewingInteractiveActiveRun = (state: ConsoleViewState | undefined): boolean =>
  state?.activeRun !== null &&
  state?.activeRun !== undefined &&
  state.viewedRun !== null &&
  state.viewedRun.runId === state.activeRun.runId &&
  state.viewedRun.sessionId === state.activeRun.sessionId &&
  state.activeRun.interactive;

const postForSelectedSession = (
  type: "session.start" | "session.interrupt" | "session.stop",
): void => {
  const sessionId = selectedSessionId();
  if (sessionId === undefined || activeState?.lifecycleState !== "active") return;
  if (type === "session.start") {
    if (activeState.canStart) vscode.postMessage({ type, sessionId });
    return;
  }
  const run = activeState.viewedRun;
  const allowed = type === "session.interrupt" ? activeState.canInterrupt : activeState.canStop;
  if (
    allowed &&
    run !== null &&
    activeState.activeRun?.runId === run.runId &&
    run.sessionId === sessionId
  ) {
    vscode.postMessage({ type, sessionId, runId: run.runId });
  }
};

const updatePromptControls = (): void => {
  const state = activeState;
  const selected = state?.selectedSession ?? null;
  const pending = selected !== null && promptDelivery.isPending(selected.id);
  const recoveryLocked = selected !== null && state?.recoveryIssue?.sessionId === selected.id;
  const canSend =
    selected !== null &&
    state !== undefined &&
    isViewingInteractiveActiveRun(state) &&
    state.connectionStatus === "connected" &&
    state.lifecycleState === "active";
  sendButton.disabled = !canSend || pending || recoveryLocked;
  sendButton.textContent = pending ? "Sending..." : recoveryLocked ? "Recovery required" : "Send";
  sendButton.title = pending
    ? "Waiting for Runtime acknowledgement"
    : recoveryLocked
      ? "Resolve the unknown Prompt outcome before sending"
      : selected !== null && !isViewingInteractiveActiveRun(state)
        ? "Return to the live interactive Run before sending"
        : "Send Prompt";
  editorElement.dataset.pending = String(pending);
  editor.updateOptions({
    readOnly: selected === null || pending || activeState?.lifecycleState !== "active",
  });
};

const submitPrompt = (): void => {
  const sessionId = selectedSessionId();
  const content = editor.getValue();
  if (
    sessionId === undefined ||
    activeState?.lifecycleState !== "active" ||
    !isViewingInteractiveActiveRun(activeState) ||
    !shouldSubmitPrompt(content, isComposing, promptDelivery.isPending(sessionId))
  ) {
    return;
  }

  const message = {
    type: "prompt.send",
    requestId: crypto.randomUUID(),
    sessionId,
    content,
  } as const;
  if (!promptDelivery.begin(message)) return;

  localDrafts.set(sessionId, content);
  statusMessage.textContent = "Sending Prompt...";
  updatePromptControls();
  vscode.postMessage(message);
};

const promptKeyBindings = createPromptKeyBindings(
  monaco.KeyCode.Enter,
  monaco.KeyMod.CtrlCmd,
  monaco.KeyMod.Shift,
  monaco.KeyMod.Alt,
);
for (const keybinding of promptKeyBindings.submit) {
  editor.addCommand(keybinding, submitPrompt);
}
for (const keybinding of promptKeyBindings.newline) {
  editor.addCommand(keybinding, () => {
    editor.trigger("honeybee", "type", { text: "\n" });
  });
}
editor.onDidCompositionStart(() => {
  isComposing = true;
});
editor.onDidCompositionEnd(() => {
  isComposing = false;
});

editor.onDidChangeModelContent(() => {
  if (suppressDraftMessage) return;
  const sessionId = selectedSessionId();
  if (sessionId === undefined) return;
  const content = editor.getValue();
  localDrafts.set(sessionId, content);
  vscode.postMessage({ type: "draft.changed", sessionId, content });
});

const resizeObserver = new ResizeObserver(() => {
  terminalRegistry.fitSelected();
});
resizeObserver.observe(terminalElement);
terminalElement.addEventListener("focus", () => {
  terminalRegistry.focusSelected();
});

const selectedRunItem = (state: ConsoleViewState) => state.availableRuns.find((run) => run.viewed);

const renderReplayStatus = (state: ConsoleViewState): void => {
  const run = selectedRunItem(state);
  if (run === undefined) {
    terminalWarning.hidden = true;
    terminalPlaceholder.hidden = true;
    return;
  }
  const key = { sessionId: run.sessionId, runId: run.runId };
  const presentation = replayPresentation(run, terminalRegistry.has(key));
  terminalPlaceholder.textContent = presentation.placeholder ?? "";
  terminalPlaceholder.hidden = presentation.placeholder === undefined;
  terminalWarningTitle.textContent = presentation.statusText;
  terminalWarningDescription.textContent =
    presentation.details + " Honey Bee does not persist terminal bodies in VS Code globalState.";
  terminalWarning.dataset.state = presentation.state;
  terminalWarningSummary.textContent = presentation.degraded
    ? "Why is this replay incomplete?"
    : presentation.state === "surface-only"
      ? "About this retained screen"
      : "About this retained replay";
  terminalWarning.hidden = presentation.state === "live";
};

const renderRunSelector = (state: ConsoleViewState): void => {
  const options = state.availableRuns.map((run) => {
    const option = document.createElement("option");
    option.value = run.runId;
    option.textContent = formatRunOption(run);
    option.title = run.runId;
    option.selected = run.viewed;
    return option;
  });
  if (options.length === 0) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "No retained Runs";
    options.push(option);
  }
  runSelector.replaceChildren(...options);
  runSelector.disabled =
    state.selectedSession === null ||
    state.availableRuns.length === 0 ||
    state.lifecycleState !== "active";

  const viewed = selectedRunItem(state);
  openLogButton.disabled = viewed?.logAvailable !== true;
  openLogButton.title =
    viewed?.logAvailable === true ? "Open this Run's recorded log" : "No recorded log is available";

  const liveElsewhere =
    state.activeRun !== null &&
    (state.viewedRun === null || state.viewedRun.runId !== state.activeRun.runId);
  liveRunNotice.hidden = !liveElsewhere;
  returnLiveButton.disabled = !liveElsewhere || state.lifecycleState !== "active";
};

const renderRun = (state: ConsoleViewState): void => {
  const run = state.viewedRun;
  visibleTerminalKey = viewedRunKey();
  terminalRegistry.setLifecycleActive(state.lifecycleState === "active");
  terminalRegistry.select(visibleTerminalKey, isViewingInteractiveActiveRun(state));
  renderRunSelector(state);
  renderReplayStatus(state);
  if (run === null) {
    runValue.textContent = "No Run";
    terminalMode.textContent = "No terminal Run";
    return;
  }
  runValue.textContent = "Run " + run.runId.slice(0, 8) + " \u00b7 " + run.phase;
  terminalMode.textContent = isViewingInteractiveActiveRun(state)
    ? "Live interactive Run"
    : run.phase === "starting"
      ? "Starting Run"
      : "Read-only retained Run";
};

const renderState = (state: ConsoleViewState): void => {
  const previousSessionId = activeSessionId;
  const previousRecovery = activeState?.recoveryIssue ?? null;
  const previousRunId = viewedRunId;
  const nextSessionId = state.selectedSession?.id;
  const nextRunId = state.viewedRun?.runId;
  if (previousSessionId !== undefined) {
    localDrafts.set(previousSessionId, editor.getValue());
  }

  activeState = state;
  activeSessionId = nextSessionId;
  viewedRunId = nextRunId;
  connectionBadge.textContent = state.connectionStatus;
  connectionBadge.dataset.state = state.connectionStatus;
  statusMessage.textContent =
    nextSessionId !== undefined && promptDelivery.isPending(nextSessionId)
      ? "Sending Prompt..."
      : state.recoveryIssue !== null
        ? "Prompt delivery outcome is unknown. Automatic resend is disabled."
        : state.statusMessage;

  const recovery = state.recoveryIssue;
  recoveryBanner.hidden = recovery === null;
  if (recovery !== null) {
    recoveryMessage.textContent =
      recovery.draftMatch === "exact"
        ? "Request " +
          recovery.requestId +
          " may have reached the Runtime. It will not be resent automatically."
        : "Request " +
          recovery.requestId +
          " is unresolved. The current Draft is " +
          recovery.draftMatch +
          ".";
    assumeDeliveredButton.disabled = state.lifecycleState !== "active";
    retryPromptButton.disabled =
      recovery.draftMatch !== "exact" || state.lifecycleState !== "active";
  }

  const selected = state.selectedSession;
  sessionValue.textContent = selected?.title ?? "No session selected";
  agentValue.textContent = selected?.agentProfile ?? "—";
  workspaceValue.textContent = selected?.workspace ?? "—";
  toolValue.textContent = selected?.toolProfile ?? "—";
  sessionStatus.textContent = selected?.status.replaceAll("_", " ") ?? "idle";
  sessionStatus.dataset.state = selected?.status ?? "idle";
  renderRun(state);

  const run = selectedRunItem(state);
  const announcement =
    run === undefined
      ? "No retained terminal Run is selected."
      : runSelectionAnnouncement(run, replayPresentation(run, terminalRegistry.has(run)));
  if (announcement !== lastRunAnnouncement) {
    lastRunAnnouncement = announcement;
    runAccessibleStatus.textContent = announcement;
  }
  if (previousRunId !== nextRunId) terminalWarningDetails.open = false;

  startButton.disabled = !state.canStart;
  interruptButton.disabled = !state.canInterrupt;
  stopButton.disabled = !state.canStop;
  updatePromptControls();

  if (previousSessionId !== nextSessionId) {
    const draft =
      nextSessionId === undefined ? "" : (localDrafts.get(nextSessionId) ?? state.draft);
    suppressDraftMessage = true;
    editor.setValue(draft);
    suppressDraftMessage = false;
  } else if (
    previousRecovery !== null &&
    state.recoveryIssue === null &&
    editor.getValue() !== state.draft
  ) {
    suppressDraftMessage = true;
    editor.setValue(state.draft);
    suppressDraftMessage = false;
    localDrafts.set(previousRecovery.sessionId, state.draft);
  } else if (
    nextSessionId !== undefined &&
    !promptDelivery.isPending(nextSessionId) &&
    editor.getValue() !== state.draft
  ) {
    localDrafts.set(nextSessionId, state.draft);
  }
};

const handlePromptAcknowledgement = (message: PromptAcknowledgementMessage): void => {
  const settlement = promptDelivery.settle(message);
  if (settlement.status === "ignored") return;

  const sessionId = settlement.prompt.sessionId;
  const storedDraft = localDrafts.get(sessionId) ?? settlement.prompt.content;
  const nextDraft = reconcileDraftAfterSettlement(storedDraft, settlement);
  localDrafts.set(sessionId, nextDraft);

  if (sessionId === selectedSessionId()) {
    if (settlement.status === "accepted" && editor.getValue() === settlement.prompt.content) {
      suppressDraftMessage = true;
      editor.setValue(nextDraft);
      suppressDraftMessage = false;
    }
    statusMessage.textContent =
      settlement.status === "accepted"
        ? promptAcceptedStatusMessage(settlement.acknowledgement)
        : settlement.status === "unknown"
          ? "Prompt delivery outcome is unknown. It will not be resent automatically."
          : "Prompt not sent. " + settlement.message;
    updatePromptControls();
    editor.focus();
  }
};

window.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (!isExtensionToConsoleMessage(event.data)) return;
  const message = event.data;
  switch (message.type) {
    case "console.state":
      renderState(message.state);
      break;
    case "terminal.run.open":
      terminalRegistry.open(message);
      if (activeState !== undefined) renderRun(activeState);
      break;
    case "terminal.run.data":
      terminalRegistry.applyData(message);
      break;
    case "terminal.run.snapshot":
      terminalRegistry.restore(message);
      if (activeState !== undefined) renderRun(activeState);
      break;
    case "terminal.run.reset":
      terminalRegistry.reset(message);
      break;
    case "terminal.run.close":
      terminalRegistry.close(message);
      break;
    case "prompt.focus":
      editor.focus();
      break;
    case "prompt.accepted":
    case "prompt.rejected":
    case "prompt.unknown":
      handlePromptAcknowledgement(message);
      break;
  }
});

startButton.addEventListener("click", () => {
  postForSelectedSession("session.start");
});
interruptButton.addEventListener("click", () => {
  postForSelectedSession("session.interrupt");
});
stopButton.addEventListener("click", () => {
  postForSelectedSession("session.stop");
});
sendButton.addEventListener("click", submitPrompt);
runSelector.addEventListener("change", () => {
  const sessionId = selectedSessionId();
  const runId = runSelector.value;
  if (sessionId !== undefined && runId.length > 0 && activeState?.lifecycleState === "active") {
    vscode.postMessage({ type: "terminal.run.select", sessionId, runId });
  }
});
returnLiveButton.addEventListener("click", () => {
  const sessionId = selectedSessionId();
  if (sessionId !== undefined && activeState?.lifecycleState === "active") {
    vscode.postMessage({ type: "terminal.run.follow-active", sessionId });
  }
});
openLogButton.addEventListener("click", () => {
  const sessionId = selectedSessionId();
  const runId = activeState?.viewedRun?.runId;
  if (sessionId !== undefined && runId !== undefined && !openLogButton.disabled) {
    vscode.postMessage({ type: "terminal.run.open-log", sessionId, runId });
  }
});

const postRecoveryAction = (
  type: "prompt.recovery.assume-delivered" | "prompt.recovery.retry",
): void => {
  const issue = activeState?.recoveryIssue;
  if (
    activeState?.lifecycleState !== "active" ||
    issue === null ||
    issue === undefined ||
    issue.sessionId !== selectedSessionId()
  ) {
    return;
  }
  vscode.postMessage({ type, requestId: issue.requestId, sessionId: issue.sessionId });
};

assumeDeliveredButton.addEventListener("click", () => {
  postRecoveryAction("prompt.recovery.assume-delivered");
});
retryPromptButton.addEventListener("click", () => {
  postRecoveryAction("prompt.recovery.retry");
});

window.addEventListener("beforeunload", () => {
  resizeObserver.disconnect();
  editor.dispose();
  terminalRegistry.dispose();
});

vscode.postMessage({ type: "webview.ready", version: CONSOLE_WEBVIEW_VERSION });
