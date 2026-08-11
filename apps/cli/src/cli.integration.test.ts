import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const demoAgentPath = fileURLToPath(new URL("../dist/demo-agent.js", import.meta.url));
const directories: string[] = [];

const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(tmpdir(), "honeybee-cli-"));
  directories.push(directory);
  return directory;
};

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

const runCli = (
  args: readonly string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (exitCode) => resolve({ stdout, stderr, exitCode }));
  });

interface CliOutput {
  readonly ok: boolean;
  readonly runId: string;
  readonly status: string;
  readonly steps: ReadonlyArray<{
    stepId: string;
    pid: number;
    input: { kind: string };
  }>;
  readonly result: string;
  readonly journalPath: string;
}

describe("HoneyBee CLI sequential orchestration", () => {
  it("starts two real processes, persists inputs, and returns the final result", async () => {
    const cwd = await temporaryDirectory();
    const execution = await runCli(["demo", "--task", "count bees", "--json"], cwd);
    expect(execution.exitCode).toBe(0);
    const output = JSON.parse(execution.stdout) as CliOutput;

    expect(output.ok).toBe(true);
    expect(output.status).toBe("completed");
    expect(output.steps).toHaveLength(2);
    expect(output.steps[0]?.pid).toBeGreaterThan(0);
    expect(output.steps[1]?.pid).not.toBe(output.steps[0]?.pid);
    expect(output.steps.every((step) => step.input.kind === "step-input")).toBe(true);
    expect(output.result).toContain("DEMO_RESULT");
    expect(output.result).toContain("DEMO_HANDOFF");
    expect(execution.stderr).toContain("agent exited");
    expect(execution.stderr).toContain("[handoff] producer -> reviewer");

    const journal = await readFile(output.journalPath, "utf8");
    expect(journal.trim().split("\n").at(-1)).toContain('"type":"workflow.completed"');
    expect(journal).not.toContain("count bees");
    expect(journal).not.toContain("DEMO_RESULT");
  }, 20_000);

  it("runs a configured deterministic three-process v2 chain", async () => {
    const cwd = await temporaryDirectory();
    const configPath = path.join(cwd, "workflow.json");
    await writeFile(
      configPath,
      JSON.stringify({
        schemaVersion: 2,
        steps: ["produce", "review", "finalize"].map((id) => ({
          id,
          agent: { command: process.execPath, args: [demoAgentPath, id] },
        })),
        timeoutMs: 10_000,
      }),
      "utf8",
    );
    const execution = await runCli(
      ["run", "--config", configPath, "--task", "three bees", "--json"],
      cwd,
    );
    expect(execution.exitCode).toBe(0);
    const output = JSON.parse(execution.stdout) as CliOutput;
    expect(output.steps).toHaveLength(3);
    expect(new Set(output.steps.map((step) => step.pid)).size).toBe(3);
    expect(output.result).toContain("step=finalize");

    const shown = await runCli(["run", "show", output.runId, "--json"], cwd);
    expect(shown.exitCode).toBe(0);
    expect(JSON.parse(shown.stdout)).toMatchObject({ status: "completed" });
  }, 20_000);

  it("requires explicit confirmation before deleting exactly one Run", async () => {
    const cwd = await temporaryDirectory();
    const execution = await runCli(["demo", "--task", "delete test", "--json"], cwd);
    const output = JSON.parse(execution.stdout) as CliOutput;

    const refused = await runCli(["run", "delete", output.runId, "--json"], cwd);
    expect(refused.exitCode).toBe(1);
    expect(await readFile(output.journalPath, "utf8")).toContain("workflow.completed");

    const deleted = await runCli(["run", "delete", output.runId, "--yes", "--json"], cwd);
    expect(deleted.exitCode).toBe(0);
    await expect(readFile(output.journalPath, "utf8")).rejects.toBeDefined();
  }, 20_000);

  it("returns runId and journalPath when an Agent fails", async () => {
    const cwd = await temporaryDirectory();
    const configPath = path.join(cwd, "failure.json");
    await writeFile(
      configPath,
      JSON.stringify({
        schemaVersion: 2,
        steps: [
          {
            id: "first",
            agent: { command: process.execPath, args: [demoAgentPath, "fail"] },
          },
          {
            id: "second",
            agent: { command: process.execPath, args: [demoAgentPath, "second"] },
          },
        ],
      }),
      "utf8",
    );
    const execution = await runCli(
      ["run", "--config", configPath, "--task", "fail safely", "--json"],
      cwd,
    );
    expect(execution.exitCode).toBe(1);
    const errorLine = execution.stderr.trim().split("\n").at(-1);
    expect(errorLine).toBeDefined();
    const failure = JSON.parse(errorLine ?? "{}") as {
      code: string;
      runId: string;
      journalPath: string;
    };
    expect(failure).toMatchObject({ code: "agent.non-zero-exit" });
    expect(failure.runId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(await readFile(failure.journalPath, "utf8")).toContain("workflow.failed");

    const shown = await runCli(["run", "show", failure.runId, "--json"], cwd);
    expect(shown.exitCode).toBe(0);
    expect(JSON.parse(shown.stdout)).toMatchObject({ status: "failed" });
  }, 20_000);
});
