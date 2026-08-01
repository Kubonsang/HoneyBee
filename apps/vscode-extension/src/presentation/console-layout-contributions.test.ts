import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const manifest = readFileSync(new URL("../../package.json", import.meta.url), "utf8");

describe("terminal-first Console contributions", () => {
  it("keeps the Activity Bar focused on Sessions and exposes editor Console actions", () => {
    expect(manifest).toContain('"command": "honeyBee.console.open"');
    expect(manifest).toContain('"command": "honeyBee.console.composePrompt"');
    expect(manifest).toContain('"key": "ctrl+alt+p"');
    expect(manifest).not.toContain('"id": "honeyBee.console"');
  });
});
