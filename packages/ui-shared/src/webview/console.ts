import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js";

import {
  CONSOLE_WEBVIEW_VERSION,
  type ConsoleToExtensionMessage,
  type ConsoleViewState,
  type ExtensionToConsoleMessage,
} from "../contracts.js";
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
const localDrafts = new Map<string, string>();

const selectedSessionId = (): string | undefined => activeState?.selectedSession?.id;

const postForSelectedSession = (
  type: "session.start" | "session.interrupt" | "session.stop",
): void => {
  const sessionId = selectedSessionId();
  if (sessionId !== undefined) {
    vscode.postMessage({ type, sessionId });
  }
};

const submitPrompt = (): void => {
  const sessionId = selectedSessionId();
  const content = editor.getValue();
  if (sessionId === undefined || content.trim().length === 0) {
    return;
  }

  vscode.postMessage({ type: "prompt.send", sessionId, content });
  localDrafts.set(sessionId, "");
  suppressDraftMessage = true;
  editor.setValue("");
  suppressDraftMessage = false;
  vscode.postMessage({ type: "draft.changed", sessionId, content: "" });
};

editor.addCommand(monaco.KeyCode.Enter, submitPrompt);
editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, submitPrompt);
editor.addCommand(monaco.KeyMod.Shift | monaco.KeyCode.Enter, () => {
  editor.trigger("honeybee", "type", { text: "\n" });
});
editor.addCommand(monaco.KeyMod.Alt | monaco.KeyCode.Enter, () => {
  editor.trigger("honeybee", "type", { text: "\n" });
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
  statusMessage.textContent = state.statusMessage;

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
  sendButton.disabled =
    selected === null ||
    state.connectionStatus !== "connected" ||
    (selected.status !== "running" && selected.status !== "waiting_for_input");
  editor.updateOptions({ readOnly: selected === null });

  if (previousSessionId !== nextSessionId) {
    const draft =
      nextSessionId === undefined ? "" : (localDrafts.get(nextSessionId) ?? state.draft);
    suppressDraftMessage = true;
    editor.setValue(draft);
    suppressDraftMessage = false;
    fitTerminal();
  } else if (nextSessionId !== undefined && editor.getValue() !== state.draft) {
    localDrafts.set(nextSessionId, state.draft);
  }
};

window.addEventListener("message", (event: MessageEvent<ExtensionToConsoleMessage>) => {
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
