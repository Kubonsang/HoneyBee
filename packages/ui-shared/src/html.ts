export interface ConsoleHtmlOptions {
  readonly cspSource: string;
  readonly nonce: string;
  readonly scriptUri: string;
  readonly styleUri: string;
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
    <main class="console-shell" aria-label="Honey Bee agent console">
      <header class="identity-header" aria-label="Selected session details">
        <div class="brand-row">
          <span class="bee-mark" aria-hidden="true">⬢</span>
          <span class="brand-name">HONEY BEE CONSOLE</span>
          <span id="connection-badge" class="connection-badge" data-state="disconnected">
            disconnected
          </span>
        </div>
        <dl class="identity-grid">
          <div><dt>Session</dt><dd id="session-value">No session selected</dd></div>
          <div><dt>Agent</dt><dd id="agent-value">—</dd></div>
          <div><dt>Workspace</dt><dd id="workspace-value">—</dd></div>
          <div><dt>Tool Profile</dt><dd id="tool-value">—</dd></div>
        </dl>
        <div class="action-row" aria-label="Agent controls">
          <span id="session-status" class="status-pill">idle</span>
          <button id="start-button" type="button" title="Start session">Start</button>
          <button id="interrupt-button" type="button" title="Send interrupt (Ctrl+C)">
            Interrupt
          </button>
          <button id="stop-button" type="button" class="danger-button" title="Stop session">
            Stop
          </button>
        </div>
      </header>

      <section class="terminal-panel" aria-label="Raw terminal">
        <div class="section-label"><span>RAW TERMINAL</span><span>ANSI / PTY STRING STREAM</span></div>
        <div id="terminal" tabindex="0" aria-label="Interactive agent terminal"></div>
      </section>

      <section class="prompt-panel" aria-label="Prompt editor">
        <div class="section-label">
          <span>PROMPT</span>
          <span>Enter / Ctrl+Enter to send · Alt+Enter / Shift+Enter for newline</span>
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
