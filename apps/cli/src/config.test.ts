import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { loadWorkflowConfig } from "./config.js";

const withConfig = async (value: unknown, run: (path: string) => Promise<void>): Promise<void> => {
  const directory = await mkdtemp(path.join(tmpdir(), "honeybee-config-"));
  const configPath = path.join(directory, "agents.json");
  await writeFile(configPath, JSON.stringify(value), "utf8");
  try {
    await run(configPath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

describe("loadWorkflowConfig", () => {
  it("maps schemaVersion 1 producer/reviewer config to canonical v2 steps", async () => {
    const previous = process.env.HONEYBEE_TEST_APPDATA;
    process.env.HONEYBEE_TEST_APPDATA = "C:\\Agent Home";
    try {
      await withConfig(
        {
          schemaVersion: 1,
          producer: { command: "codex" },
          reviewer: {
            command: "${HONEYBEE_TEST_APPDATA}\\npm\\opencode.exe",
            cwd: ".",
          },
        },
        async (configPath) => {
          const config = await loadWorkflowConfig(configPath);
          expect(config.schemaVersion).toBe(2);
          expect(config.steps.map((step) => step.id)).toEqual(["producer", "reviewer"]);
          expect(config.steps[1]?.agent.command).toBe("C:\\Agent Home\\npm\\opencode.exe");
          expect(config.steps[1]?.agent.cwd).toBe(path.dirname(configPath));
        },
      );
    } finally {
      if (previous === undefined) delete process.env.HONEYBEE_TEST_APPDATA;
      else process.env.HONEYBEE_TEST_APPDATA = previous;
    }
  });

  it("strictly validates v2 step IDs and duplicates", async () => {
    await withConfig(
      {
        schemaVersion: 2,
        steps: [
          { id: "same", agent: { command: "a" } },
          { id: "same", agent: { command: "b" } },
        ],
      },
      async (configPath) => expect(loadWorkflowConfig(configPath)).rejects.toThrow("Duplicate"),
    );
    await withConfig(
      {
        schemaVersion: 2,
        steps: [
          { id: "Bad", agent: { command: "a" } },
          { id: "good", agent: { command: "b" } },
        ],
      },
      async (configPath) => expect(loadWorkflowConfig(configPath)).rejects.toThrow("Invalid"),
    );
  });
});
