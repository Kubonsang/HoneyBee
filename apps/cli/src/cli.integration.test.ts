import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

const runDemo = (): Promise<{ stdout: string; stderr: string; exitCode: number | null }> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, "demo", "--task", "count bees", "--json"], {
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

describe("HoneyBee CLI process handoff", () => {
  it("starts two real agent processes and returns the reviewer's result", async () => {
    const execution = await runDemo();
    expect(execution.exitCode).toBe(0);
    const output = JSON.parse(execution.stdout) as {
      producer: { pid: number };
      reviewer: { pid: number };
      handoff: string;
      result: string;
    };

    expect(output.producer.pid).toBeGreaterThan(0);
    expect(output.reviewer.pid).toBeGreaterThan(0);
    expect(output.reviewer.pid).not.toBe(output.producer.pid);
    expect(output.handoff).toContain("task=count bees");
    expect(output.result).toContain(`producer=${output.handoff}`);
    expect(execution.stderr).toContain("[handoff] producer -> reviewer");
  }, 20_000);
});
