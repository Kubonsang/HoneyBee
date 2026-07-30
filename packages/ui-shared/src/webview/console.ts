import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js";

import {
  CONSOLE_WEBVIEW_VERSION,
  isExtensionToConsoleMessage,
  type ConsoleToExtensionMessage,
  type ConsoleViewState,
  type PromptAcknowledgementMessage,
} from "../contracts.js";
import {
  PromptDeliveryTracker,
  promptAcceptedStatusMessage,
  reconcileDraftAfterSettlement,
} from "../prompt-delivery-state.js";
import { createPromptKeyBindings, shouldSubmitPrompt } from "../prompt-input-policy.js";
import "./console.css";

interface VsCodeApi {
  postMessage(message: ConsoleToExtensionMessage): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();

const requiredElement = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (element === null) {
    throw new Error(`Required element "${id}" was not found.`);
  }
  return element as T;
};

const terminalElement = requiredElement<HTMLDivElement>("terminal");
const editorElement = requiredElement<HTMLDivElement>("prompt-editor");
const sessionValue = requiredElement<HTMLElement>("session-value");
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

const terminal = new Terminal({
  allowProposedApi: false,
  convertEol: false,
  cursorBlink: true,
  cursorStyle: "bar",
  fontFamily:
    "var(--vscode-editor-font-family, 'Cascadia Code', 'SFMono-Regular', Consolas, monospace)",
  fontSize: 12,
  scrollback: 10_000,
  theme: {
    background: "#11100d",
    foreground: "#eee8d5",
    cursor: "#f4c95d",
    cursorAccent: "#11100d",
    selectionBackground: "#6d582f99",
    black: "#171510",
    brightBlack: "#686153",
    red: "#ff7a7a",
    brightRed: "#ff9b9b",
    green: "#9dd68c",
    brightGreen: "#b4e7a5",
    yellow: "#f4c95d",
    brightYellow: "#ffe090",
    blue: "#78a9ff",
    brightBlue: "#9ec1ff",
    magenta: "#c99bea",
    brightMagenta: "#ddb8f3",
    cyan: "#71c7c1",
    brightCyan: "#91ddd8",
    white: "#e2ddcf",
    brightWhite: "#fffdf5",
  },
});
const fitAddon = new FitAddon();
terminal.loadAddon(fitAddon);
terminal.open(terminalElement);

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
let suppressDraftMessage = false;
let isComposing = false;
const localDrafts = new Map<string, string>();
const promptDelivery = new PromptDeliveryTracker();

const selectedSessionId = (): string | undefined => activeState?.selectedSession?.id;

const postForSelectedSession = (
  type: "session.start" | "session.interrupt" | "session.stop",
): void => {
  const sessionId = selectedSessionId();
  if (sessionId !== undefined) {
    vscode.postMessage({ type, sessionId });
  }
};

const updatePromptControls = (): void => {
  const selected = activeState?.selectedSession ?? null;
  const pending = selected !== null && promptDelivery.isPending(selected.id);
  const canSend =
    selected !== null &&
    activeState?.connectionStatus === "connected" &&
    (selected.status === "running" || selected.status === "waiting_for_input");
  sendButton.disabled = !canSend || pending;
  sendButton.textContent = pending ? "Sending..." : "Send";
  editorElement.dataset.pending = String(pending);
  editor.updateOptions({ readOnly: selected === null || pending });
};

const submitPrompt = (): void => {
  const sessionId = selectedSessionId();
  const content = editor.getValue();
  if (
    sessionId === undefined ||
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
  if (!promptDelivery.begin(message)) {
    return;
  }

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
  if (suppressDraftMessage) {
    return;
  }
  const sessionId = selectedSessionId();
  if (sessionId === undefined) {
    return;
  }
  const content = editor.getValue();
  localDrafts.set(sessionId, content);
  vscode.postMessage({ type: "draft.changed", sessionId, content });
});

terminal.onData((data) => {
  const sessionId = selectedSessionId();
  if (sessionId !== undefined) {
    vscode.postMessage({ type: "terminal.input", sessionId, data });
  }
});

const reportTerminalSize = (): void => {
  const sessionId = selectedSessionId();
  if (sessionId === undefined || terminal.cols <= 0 || terminal.rows <= 0) {
    return;
  }
  vscode.postMessage({
    type: "terminal.resize",
    sessionId,
    columns: terminal.cols,
    rows: terminal.rows,
  });
};

const fitTerminal = (): void => {
  try {
    fitAddon.fit();
    reportTerminalSize();
  } catch {
    // A hidden VS Code view has no measurable geometry yet. The ResizeObserver retries.
  }
};

const resizeObserver = new ResizeObserver(fitTerminal);
resizeObserver.observe(terminalElement);

const renderState = (state: ConsoleViewState): void => {
  const previousSessionId = activeSessionId;
  const nextSessionId = state.selectedSession?.id;
  if (previousSessionId !== undefined) {
    localDrafts.set(previousSessionId, editor.getValue());
  }

  activeState = state;
  activeSessionId = nextSessionId;
  connectionBadge.textContent = state.connectionStatus;
  connectionBadge.dataset.state = state.connectionStatus;
  statusMessage.textContent =
    nextSessionId !== undefined && promptDelivery.isPending(nextSessionId)
      ? "Sending Prompt..."
      : state.statusMessage;

  const selected = state.selectedSession;
  sessionValue.textContent = selected?.title ?? "No session selected";
  agentValue.textContent = selected?.agentProfile ?? "—";
  workspaceValue.textContent = selected?.workspace ?? "—";
  toolValue.textContent = selected?.toolProfile ?? "—";
  sessionStatus.textContent = selected?.status.replaceAll("_", " ") ?? "idle";
  sessionStatus.dataset.state = selected?.status ?? "idle";

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
    fitTerminal();
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
  if (settlement.status === "ignored") {
    return;
  }

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
        : `Prompt not sent. ${settlement.message}`;
    updatePromptControls();
    editor.focus();
  }
};

window.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (!isExtensionToConsoleMessage(event.data)) {
    return;
  }
  const message = event.data;
  switch (message.type) {
    case "console.state":
      renderState(message.state);
      break;
    case "terminal.data":
      if (message.sessionId === selectedSessionId()) {
        terminal.write(message.data);
      }
      break;
    case "terminal.clear":
      if (message.sessionId === null || message.sessionId === selectedSessionId()) {
        terminal.clear();
      }
      break;
    case "prompt.focus":
      editor.focus();
      break;
    case "prompt.accepted":
    case "prompt.rejected":
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

window.addEventListener("beforeunload", () => {
  resizeObserver.disconnect();
  editor.dispose();
  terminal.dispose();
});

vscode.postMessage({ type: "webview.ready", version: CONSOLE_WEBVIEW_VERSION });
fitTerminal();
