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
  it("maps schemaVersion 1 producer/reviewer config to a canonical v3 linear DAG", async () => {
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
          expect(config.schemaVersion).toBe(3);
          expect(config.harnesses).toEqual([
            { id: "stdio", kind: "stdio-framed-v1", protocolVersion: 1 },
          ]);
          expect(config.steps.map((step) => step.id)).toEqual(["producer", "reviewer"]);
          expect(config.agents[1]?.command).toBe("C:\\Agent Home\\npm\\opencode.exe");
          expect(config.agents[1]?.cwd).toBe(path.dirname(configPath));
          expect(config.steps[1]).toMatchObject({ needs: ["producer"] });
          expect(config.outputs).toEqual({
            result: { from: { stepId: "reviewer", output: "content" } },
          });
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

  it.each([
    [
      "root",
      {
        schemaVersion: 2,
        unexpected: true,
        steps: [
          { id: "first", agent: { command: "a" } },
          { id: "second", agent: { command: "b" } },
        ],
      },
    ],
    [
      "step",
      {
        schemaVersion: 2,
        steps: [
          { id: "first", agent: { command: "a" }, unexpected: true },
          { id: "second", agent: { command: "b" } },
        ],
      },
    ],
    [
      "agent",
      {
        schemaVersion: 2,
        steps: [
          { id: "first", agent: { command: "a", unexpected: true } },
          { id: "second", agent: { command: "b" } },
        ],
      },
    ],
  ] as const)("rejects unknown v2 %s fields before normalization", async (_scope, candidate) => {
    await withConfig(candidate, async (configPath) =>
      expect(loadWorkflowConfig(configPath)).rejects.toThrow("Invalid schemaVersion 2 config"),
    );
  });

  it("loads strict v3 Agent/Harness registries and rejects nested unknown fields", async () => {
    const candidate = {
      schemaVersion: 3,
      agents: [{ id: "worker", command: "agent", cwd: "." }],
      harnesses: [{ id: "stdio", kind: "stdio-framed-v2", protocolVersion: 2 }],
      steps: [
        {
          id: "worker",
          type: "agent",
          agentRef: "worker",
          harnessRef: "stdio",
          outputs: { content: { mediaType: "text/plain; charset=utf-8" } },
        },
      ],
      maxParallelism: 2,
    };
    await withConfig(candidate, async (configPath) => {
      const loaded = await loadWorkflowConfig(configPath);
      expect(loaded.schemaVersion).toBe(3);
      expect(loaded.agents[0]?.cwd).toBe(path.dirname(configPath));
      expect(loaded.maxParallelism).toBe(2);
    });
    await withConfig(
      { ...candidate, steps: [{ ...candidate.steps[0], typo: true }] },
      async (configPath) =>
        expect(loadWorkflowConfig(configPath)).rejects.toThrow("Invalid schemaVersion 3 config"),
    );
  });
});
