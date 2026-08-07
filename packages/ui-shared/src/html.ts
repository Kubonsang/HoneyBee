export interface ConsoleHtmlOptions {
  readonly cspSource: string;
  readonly nonce: string;
  readonly scriptUri: string;
  readonly styleUri: string;
  readonly terminalDiagnosticsEnabled?: boolean;
}

const escapeAttribute = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

export const createConsoleWebviewHtml = (options: ConsoleHtmlOptions): string => {
  const cspSource = escapeAttribute(options.cspSource);
  const nonce = escapeAttribute(options.nonce);
  const scriptUri = escapeAttribute(options.scriptUri);
  const styleUri = escapeAttribute(options.styleUri);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; img-src ${cspSource} data:; font-src ${cspSource}; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';"
    />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="${styleUri}" />
    <title>Honey Bee Console</title>
  </head>
  <body>
    <main
      id="console-shell"
      class="console-shell"
      data-composer-open="false"
      data-terminal-diagnostics="${String(options.terminalDiagnosticsEnabled === true)}"
      aria-label="Honey Bee agent console"
    >
      <header class="run-bar" aria-label="Selected Session and Run">
        <span class="bee-mark" aria-hidden="true">⬢</span>
        <strong id="session-value" class="session-value">No session selected</strong>
        <span id="run-value" class="run-value">No Run</span>
        <span class="context-value" title="Agent Profile">
          <span class="context-label">Agent</span>
          <span id="agent-value">—</span>
        </span>
        <span class="context-value" title="Workspace">
          <span class="context-label">Workspace</span>
          <span id="workspace-value">—</span>
        </span>
        <span class="context-value" title="Tool Profile">
          <span class="context-label">Tool</span>
          <span id="tool-value">—</span>
        </span>
        <label for="run-selector" class="visually-hidden">Terminal run</label>
        <select id="run-selector" aria-describedby="run-accessible-status" disabled>
          <option value="">No retained Runs</option>
        </select>
        <button id="open-log-button" type="button" title="Open retained Run log" disabled>
          Log
        </button>
        <span id="connection-badge" class="connection-badge" data-state="disconnected">
          disconnected
        </span>
        <span id="session-status" class="status-pill">idle</span>
        <nav class="run-toolbar" aria-label="Agent and Console controls">
          <button id="start-button" type="button" title="Start Session">Start</button>
          <button id="interrupt-button" type="button" title="Send interrupt (Ctrl+C)">
            Interrupt
          </button>
          <button id="stop-button" type="button" class="danger-button" title="Stop Session">
            Stop
          </button>
          <button
            id="compose-prompt-button"
            type="button"
            title="Compose Prompt (Ctrl+Alt+P)"
          >
            Compose Prompt
          </button>
        </nav>
      </header>
      <span
        id="run-accessible-status"
        class="visually-hidden"
        role="status"
        aria-live="polite"
      ></span>
      <div id="live-run-notice" class="live-run-notice" role="status" hidden>
        <span>A live Run is active in this Session.</span>
        <button id="return-live-button" type="button">Return to live</button>
      </div>
      <section id="recovery-banner" class="recovery-banner" role="alert" hidden>
        <div>
          <strong>Prompt delivery outcome unknown</strong>
          <p id="recovery-message">
            Honey Bee will not resend this Prompt automatically.
          </p>
        </div>
        <div class="recovery-actions">
          <button id="assume-delivered-button" type="button">Assume delivered</button>
          <button id="retry-prompt-button" type="button" class="danger-button">
            Retry with new ID
          </button>
        </div>
      </section>
      <section class="terminal-panel" aria-label="Raw terminal">
        <div class="section-label"><span>RAW TERMINAL</span><span id="terminal-mode">No terminal Run</span></div>
        <div id="terminal-warning" class="terminal-warning" role="status" aria-live="polite" hidden>
          <strong id="terminal-warning-title"></strong>
          <details id="terminal-warning-details">
            <summary id="terminal-warning-summary">Why is this replay incomplete?</summary>
            <p id="terminal-warning-description"></p>
          </details>
        </div>
        <div id="terminal" tabindex="0" aria-label="Interactive agent terminal">
          <div id="terminal-placeholder" class="terminal-placeholder" role="status" hidden></div>
        </div>
      </section>

      <section id="prompt-panel" class="prompt-panel" aria-label="Prompt Composer" hidden>
        <div class="section-label">
          <span>PROMPT COMPOSER</span>
          <span class="prompt-key-hint">
            Enter / Ctrl+Enter to send · Alt+Enter / Shift+Enter for newline
          </span>
          <button id="close-composer-button" type="button" title="Close Prompt Composer">
            Close
          </button>
        </div>
        <div id="prompt-editor" aria-label="Prompt editor"></div>
        <div class="prompt-footer">
          <span id="status-message" role="status" aria-live="polite">
            Select a session to open its console.
          </span>
          <button id="send-button" type="button" class="primary-button">Send</button>
        </div>
      </section>
    </main>
    <script nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`;
};
