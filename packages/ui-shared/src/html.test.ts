import { describe, expect, it } from "vitest";

import { createConsoleWebviewHtml } from "./html.js";

const html = createConsoleWebviewHtml({
  cspSource: "vscode-webview:",
  nonce: "nonce",
  scriptUri: "console.js",
  styleUri: "console.css",
});

describe("Console Webview accessibility structure", () => {
  it("keeps content-free terminal diagnostics opt-in", () => {
    expect(html).toContain('data-terminal-diagnostics="false"');
    expect(
      createConsoleWebviewHtml({
        cspSource: "vscode-webview:",
        nonce: "nonce",
        scriptUri: "console.js",
        styleUri: "console.css",
        terminalDiagnosticsEnabled: true,
      }),
    ).toContain('data-terminal-diagnostics="true"');
  });

  it("uses a labelled native Run selector and semantic action buttons", () => {
    expect(html).toContain(
      '<label for="run-selector" class="visually-hidden">Terminal run</label>',
    );
    expect(html).toContain('<select id="run-selector"');
    expect(html).toContain('id="return-live-button" type="button"');
    expect(html).toContain('id="open-log-button" type="button"');
  });

  it("uses a terminal-first Run Bar and keeps the Prompt Composer collapsed by default", () => {
    expect(html).toContain('id="console-shell"');
    expect(html).toContain('class="run-bar"');
    expect(html).toContain('id="compose-prompt-button"');
    expect(html).toContain(
      '<section id="prompt-panel" class="prompt-panel" aria-label="Prompt Composer" hidden>',
    );
    expect(html.indexOf('class="terminal-panel"')).toBeLessThan(html.indexOf('id="prompt-panel"'));
  });

  it("provides concise live regions for selection and degraded replay status", () => {
    expect(html).toContain('id="run-accessible-status"');
    expect(html).toContain('class="visually-hidden"');
    expect(html).toContain(
      'id="terminal-warning" class="terminal-warning" role="status" aria-live="polite"',
    );
    expect(html).toContain('id="terminal-placeholder" class="terminal-placeholder" role="status"');
    expect(html).toContain("Why is this replay incomplete?");
  });

  it("does not expose a log path or terminal body in Run navigation controls", () => {
    expect(html).not.toContain("logFilePath");
    expect(html).not.toContain('type="file"');
    expect(html).not.toContain("terminal.run.open-log");
  });
});
