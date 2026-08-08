import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { loadHandoffConfig } from "./config.js";

describe("loadHandoffConfig", () => {
  it("expands environment variables in native executable paths", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "honeybee-config-"));
    const configPath = path.join(directory, "agents.json");
    const previous = process.env.HONEYBEE_TEST_APPDATA;
    process.env.HONEYBEE_TEST_APPDATA = "C:\\Agent Home";
    await writeFile(
      configPath,
      JSON.stringify({
        schemaVersion: 1,
        producer: { command: "codex" },
        reviewer: {
          command: "${HONEYBEE_TEST_APPDATA}\\npm\\opencode.exe",
          cwd: ".",
        },
      }),
      "utf8",
    );

    try {
      const config = await loadHandoffConfig(configPath, "task");
      expect(config.reviewer.command).toBe("C:\\Agent Home\\npm\\opencode.exe");
      expect(config.reviewer.cwd).toBe(directory);
    } finally {
      if (previous === undefined) delete process.env.HONEYBEE_TEST_APPDATA;
      else process.env.HONEYBEE_TEST_APPDATA = previous;
      await rm(directory, { recursive: true, force: true });
    }
  });
});
