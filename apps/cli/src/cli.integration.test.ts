import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ArtifactIdSchema,
  EventIdSchema,
  FileArtifactStore,
  FileOrchestrationJournal,
  FileRunControl,
  FileRunRepository,
  OrchestrationEventV3Schema,
  RunIdSchema,
} from "@honeybee/core";
import { afterEach, describe, expect, it, vi } from "vitest";

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

const startCli = (args: readonly string[], cwd: string) => {
  const child = spawn(process.execPath, [cliPath, ...args], {
    cwd,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const state = { stdout: "", stderr: "" };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => (state.stdout += chunk));
  child.stderr.on("data", (chunk: string) => (state.stderr += chunk));
  const completed = new Promise<{ stdout: string; stderr: string; exitCode: number | null }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("close", (exitCode) => resolve({ ...state, exitCode }));
    },
  );
  return { state, completed };
};

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

    const journal = await readFile(output.journalPath, "utf8");
    expect(journal).toContain('"kind":"step-content"');

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

    const controls = new FileRunControl(path.join(cwd, ".honeybee", "runs"));
    const executorLease = await controls.acquire(RunIdSchema.parse(output.runId));
    try {
      const raced = await runCli(["run", "delete", output.runId, "--yes", "--json"], cwd);
      expect(raced.exitCode).toBe(1);
      expect(await readFile(output.journalPath, "utf8")).toContain("workflow.completed");
    } finally {
      await executorLease.release();
    }

    const deleted = await runCli(["run", "delete", output.runId, "--yes", "--json"], cwd);
    expect(deleted.exitCode).toBe(0);
    await expect(readFile(output.journalPath, "utf8")).rejects.toBeDefined();
  }, 20_000);

  it("refuses to delete an active Unity Run before durable workspace release", async () => {
    const cwd = await temporaryDirectory();
    const root = path.join(cwd, ".honeybee", "runs");
    const runId = RunIdSchema.parse(randomUUID());
    await new FileRunRepository(root).create(runId);
    const artifacts = new FileArtifactStore(root);
    const config = await artifacts.put({
      runId,
      artifactId: ArtifactIdSchema.parse(randomUUID()),
      kind: "workflow-config",
      mediaType: "application/json",
      content: "{}",
    });
    const task = await artifacts.put({
      runId,
      artifactId: ArtifactIdSchema.parse(randomUUID()),
      kind: "task",
      mediaType: "text/plain; charset=utf-8",
      content: "task",
    });
    const journal = new FileOrchestrationJournal(root);
    await journal.append(
      runId,
      OrchestrationEventV3Schema.parse({
        schemaVersion: 3,
        eventId: EventIdSchema.parse(randomUUID()),
        runId,
        sequence: 1,
        timestamp: new Date(0).toISOString(),
        type: "workflow.started",
        payload: { mode: "unity-work-v1", config, task },
      }),
    );

    const deletion = await runCli(["run", "delete", runId, "--yes", "--json"], cwd);

    expect(deletion.exitCode).toBe(1);
    expect(JSON.parse(deletion.stderr)).toMatchObject({
      ok: false,
      code: "run.cleanup-pending",
    });
    expect((await journal.replay(runId)).status).toBe("active");
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

  it("runs a real v3 parallel fan-out and fan-in workflow", async () => {
    const cwd = await temporaryDirectory();
    const configPath = path.join(cwd, "dag.json");
    await writeFile(
      configPath,
      JSON.stringify({
        schemaVersion: 3,
        agents: ["left", "right", "join"].map((id) => ({
          id,
          command: process.execPath,
          args: [demoAgentPath, id],
        })),
        harnesses: [{ id: "stdio", kind: "stdio-framed-v2", protocolVersion: 2 }],
        steps: [
          ...["left", "right"].map((id) => ({
            id,
            type: "agent",
            agentRef: id,
            harnessRef: "stdio",
            outputs: { content: { mediaType: "text/plain; charset=utf-8" } },
          })),
          {
            id: "join",
            type: "agent",
            agentRef: "join",
            harnessRef: "stdio",
            needs: ["left", "right"],
            inputs: {
              left: { from: { stepId: "left", output: "content" } },
              right: { from: { stepId: "right", output: "content" } },
            },
            outputs: { content: { mediaType: "text/plain; charset=utf-8" } },
          },
        ],
        outputs: { result: { from: { stepId: "join", output: "content" } } },
        maxParallelism: 2,
      }),
      "utf8",
    );
    const execution = await runCli(
      ["run", "--config", configPath, "--task", "fan in", "--json"],
      cwd,
    );
    expect(execution.exitCode).toBe(0);
    const result = JSON.parse(execution.stdout) as CliOutput;
    expect(result.status).toBe("completed");
    expect(result.steps).toHaveLength(3);
    expect(result.result).toContain("step=left");
    expect(result.result).toContain("step=right");

    const events = (await readFile(result.journalPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; stepId?: string });
    const firstExit = events.findIndex((event) => event.type === "agent.exited");
    const startsBeforeExit = events
      .slice(0, firstExit)
      .filter((event) => event.type === "agent.started")
      .map((event) => event.stepId)
      .sort();
    expect(startsBeforeExit).toEqual(["left", "right"]);
  }, 20_000);

  it("passes an approval decision between two CLI processes", async () => {
    const cwd = await temporaryDirectory();
    const configPath = path.join(cwd, "approval.json");
    await writeFile(
      configPath,
      JSON.stringify({
        schemaVersion: 3,
        agents: [{ id: "after", command: process.execPath, args: [demoAgentPath, "after"] }],
        harnesses: [{ id: "stdio", kind: "stdio-framed-v2", protocolVersion: 2 }],
        steps: [
          {
            id: "gate",
            type: "approval",
            outputs: { decision: { mediaType: "application/json" } },
          },
          {
            id: "after",
            type: "agent",
            agentRef: "after",
            harnessRef: "stdio",
            when: {
              artifact: {
                stepId: "gate",
                output: "decision",
                pointer: "/decision",
                op: "eq",
                value: "approved",
              },
            },
            outputs: { content: { mediaType: "text/plain; charset=utf-8" } },
          },
        ],
      }),
      "utf8",
    );
    const active = startCli(["run", "--config", configPath, "--task", "approve", "--json"], cwd);
    await vi.waitFor(() => expect(active.state.stderr).toContain("workflow.waiting-approval"));
    const runId = active.state.stderr.match(/run=([0-9a-f-]{36})/u)?.[1];
    expect(runId).toBeDefined();
    expect(
      JSON.parse((await runCli(["run", "show", runId ?? "", "--json"], cwd)).stdout),
    ).toMatchObject({ status: "waiting-approval", executorPresent: true });
    const approval = await runCli(["run", "approve", runId ?? "", "gate", "--json"], cwd);
    expect(approval.exitCode).toBe(0);
    const completed = await active.completed;
    expect(completed.exitCode).toBe(0);
    expect(JSON.parse(completed.stdout)).toMatchObject({ status: "completed" });
  }, 20_000);

  it("cancels a Run waiting at an approval gate", async () => {
    const cwd = await temporaryDirectory();
    const configPath = path.join(cwd, "cancel-approval.json");
    await writeFile(
      configPath,
      JSON.stringify({
        schemaVersion: 3,
        agents: [{ id: "unused", command: process.execPath, args: [demoAgentPath, "unused"] }],
        harnesses: [{ id: "stdio", kind: "stdio-framed-v2", protocolVersion: 2 }],
        steps: [
          {
            id: "gate",
            type: "approval",
            outputs: { decision: { mediaType: "application/json" } },
          },
        ],
      }),
      "utf8",
    );
    const active = startCli(["run", "--config", configPath, "--task", "cancel", "--json"], cwd);
    await vi.waitFor(() => expect(active.state.stderr).toContain("workflow.waiting-approval"));
    const runId = active.state.stderr.match(/run=([0-9a-f-]{36})/u)?.[1];
    expect(runId).toBeDefined();

    const cancellation = await runCli(["run", "cancel", runId ?? "", "--json"], cwd);
    expect(cancellation.exitCode).toBe(0);
    const completed = await active.completed;
    expect(completed.exitCode).toBe(130);
    const result = JSON.parse(completed.stdout) as CliOutput;
    expect(result.status).toBe("cancelled");
    expect((await readFile(result.journalPath, "utf8")).trimEnd()).toMatch(
      /"type":"workflow\.cancelled"[^\n]*$/u,
    );
  }, 20_000);

  it("pauses after an in-flight process and resumes without repeating it", async () => {
    const cwd = await temporaryDirectory();
    const configPath = path.join(cwd, "pause.json");
    await writeFile(
      configPath,
      JSON.stringify({
        schemaVersion: 3,
        agents: ["slow", "after"].map((id) => ({
          id,
          command: process.execPath,
          args: [demoAgentPath, id],
        })),
        harnesses: [{ id: "stdio", kind: "stdio-framed-v2", protocolVersion: 2 }],
        steps: [
          {
            id: "slow",
            type: "agent",
            agentRef: "slow",
            harnessRef: "stdio",
            outputs: { content: { mediaType: "text/plain; charset=utf-8" } },
          },
          {
            id: "after",
            type: "agent",
            agentRef: "after",
            harnessRef: "stdio",
            needs: ["slow"],
            inputs: { previous: { from: { stepId: "slow", output: "content" } } },
            outputs: { content: { mediaType: "text/plain; charset=utf-8" } },
          },
        ],
        maxParallelism: 1,
      }),
      "utf8",
    );
    const active = startCli(["run", "--config", configPath, "--task", "pause", "--json"], cwd);
    await vi.waitFor(() => expect(active.state.stderr).toContain("[slow] agent started"));
    const runId = active.state.stderr.match(/run=([0-9a-f-]{36})/u)?.[1];
    expect(runId).toBeDefined();
    expect((await runCli(["run", "pause", runId ?? "", "--json"], cwd)).exitCode).toBe(0);
    const paused = await active.completed;
    expect(paused.exitCode).toBe(4);
    const pausedResult = JSON.parse(paused.stdout) as CliOutput;
    expect(pausedResult.status).toBe("paused");
    expect(
      JSON.parse((await runCli(["run", "show", runId ?? "", "--json"], cwd)).stdout),
    ).toMatchObject({ status: "paused", executorPresent: false });

    const resumed = await runCli(["run", "resume", runId ?? "", "--json"], cwd);
    expect(resumed.exitCode).toBe(0);
    const result = JSON.parse(resumed.stdout) as CliOutput;
    expect(result.status).toBe("completed");
    expect(result.steps.find((step) => step.stepId === "slow")?.pid).toBe(
      pausedResult.steps.find((step) => step.stepId === "slow")?.pid,
    );
  }, 20_000);

  it("reports queued control that is waiting for an executor", async () => {
    const cwd = await temporaryDirectory();
    const configPath = path.join(cwd, "paused-control.json");
    await writeFile(
      configPath,
      JSON.stringify({
        schemaVersion: 3,
        agents: [
          { id: "slow", command: process.execPath, args: [demoAgentPath, "slow"] },
          { id: "after", command: process.execPath, args: [demoAgentPath, "after"] },
        ],
        harnesses: [{ id: "stdio", kind: "stdio-framed-v2", protocolVersion: 2 }],
        steps: [
          {
            id: "slow",
            type: "agent",
            agentRef: "slow",
            harnessRef: "stdio",
            outputs: { content: { mediaType: "text/plain; charset=utf-8" } },
          },
          {
            id: "after",
            type: "agent",
            agentRef: "after",
            harnessRef: "stdio",
            needs: ["slow"],
            outputs: { content: { mediaType: "text/plain; charset=utf-8" } },
          },
        ],
        maxParallelism: 1,
      }),
      "utf8",
    );
    const active = startCli(["run", "--config", configPath, "--task", "pause", "--json"], cwd);
    await vi.waitFor(() => expect(active.state.stderr).toContain("[slow] agent started"));
    const runId = active.state.stderr.match(/run=([0-9a-f-]{36})/u)?.[1];
    expect(runId).toBeDefined();
    expect((await runCli(["run", "pause", runId ?? "", "--json"], cwd)).exitCode).toBe(0);
    expect((await active.completed).exitCode).toBe(4);

    const queued = await runCli(["run", "cancel", runId ?? "", "--json"], cwd);
    expect(queued.exitCode).toBe(0);
    expect(JSON.parse(queued.stdout)).toMatchObject({
      pending: true,
      disposition: "queued-awaiting-executor",
      executorPresent: false,
      requiresResume: true,
    });

    const resumed = await runCli(["run", "resume", runId ?? "", "--json"], cwd);
    expect(resumed.exitCode).toBe(130);
    expect(JSON.parse(resumed.stdout)).toMatchObject({ status: "cancelled" });
  }, 20_000);

  it("retries an allowlisted real Agent failure and persists both attempts", async () => {
    const cwd = await temporaryDirectory();
    const configPath = path.join(cwd, "retry.json");
    await writeFile(
      configPath,
      JSON.stringify({
        schemaVersion: 3,
        agents: [{ id: "flaky", command: process.execPath, args: [demoAgentPath, "flaky"] }],
        harnesses: [{ id: "stdio", kind: "stdio-framed-v2", protocolVersion: 2 }],
        steps: [
          {
            id: "flaky",
            type: "agent",
            agentRef: "flaky",
            harnessRef: "stdio",
            outputs: { content: { mediaType: "text/plain; charset=utf-8" } },
            retry: {
              maxAttempts: 2,
              retryOn: { exitCodes: [7] },
              backoff: { initialDelayMs: 0, maxDelayMs: 0 },
            },
          },
        ],
      }),
      "utf8",
    );
    const execution = await runCli(
      ["run", "--config", configPath, "--task", "retry", "--json"],
      cwd,
    );
    expect(execution.exitCode).toBe(0);
    const result = JSON.parse(execution.stdout) as CliOutput;
    const journal = await readFile(result.journalPath, "utf8");
    expect(journal.match(/"type":"step.attempt.started"/gu)).toHaveLength(2);
    expect(journal).toContain('"type":"retry.scheduled"');
  }, 20_000);

  it("cancels a real in-flight Agent and records a final cancelled event", async () => {
    const cwd = await temporaryDirectory();
    const configPath = path.join(cwd, "cancel.json");
    await writeFile(
      configPath,
      JSON.stringify({
        schemaVersion: 3,
        agents: [{ id: "slow", command: process.execPath, args: [demoAgentPath, "slow"] }],
        harnesses: [{ id: "stdio", kind: "stdio-framed-v2", protocolVersion: 2 }],
        steps: [
          {
            id: "slow",
            type: "agent",
            agentRef: "slow",
            harnessRef: "stdio",
            outputs: { content: { mediaType: "text/plain; charset=utf-8" } },
          },
        ],
        cancelGraceMs: 100,
      }),
      "utf8",
    );
    const active = startCli(["run", "--config", configPath, "--task", "cancel", "--json"], cwd);
    await vi.waitFor(() => expect(active.state.stderr).toContain("[slow] agent started"));
    const runId = active.state.stderr.match(/run=([0-9a-f-]{36})/u)?.[1];
    expect((await runCli(["run", "cancel", runId ?? "", "--json"], cwd)).exitCode).toBe(0);
    const cancelled = await active.completed;
    expect(cancelled.exitCode).toBe(130);
    const result = JSON.parse(cancelled.stdout) as CliOutput;
    expect(result.status).toBe("cancelled");
    expect((await readFile(result.journalPath, "utf8")).trim().split("\n").at(-1)).toContain(
      '"type":"workflow.cancelled"',
    );
  }, 20_000);
});
