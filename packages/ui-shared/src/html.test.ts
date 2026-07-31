import { describe, expect, it } from "vitest";

import { createConsoleWebviewHtml } from "./html.js";

const html = createConsoleWebviewHtml({
  cspSource: "vscode-webview:",
  nonce: "nonce",
  scriptUri: "console.js",
  styleUri: "console.css",
});

describe("Console Webview accessibility structure", () => {
  it("uses a labelled native Run selector and semantic action buttons", () => {
    expect(html).toContain('<label for="run-selector">Terminal run</label>');
    expect(html).toContain('<select id="run-selector"');
    expect(html).toContain('id="return-live-button" type="button"');
    expect(html).toContain('id="open-log-button" type="button" disabled');
  });

  it("provides concise live regions for selection and degraded replay status", () => {
    expect(html).toContain(
      'id="run-accessible-status" class="visually-hidden" role="status" aria-live="polite"',
    );
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
