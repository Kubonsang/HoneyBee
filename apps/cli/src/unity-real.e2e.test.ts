import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { loadUnityWorkConfig } from "./config.js";
import { UnityWorkspaceStorageCliAdapter } from "./unity-adapters.js";

const configPath = process.env.HONEYBEE_UNITY_E2E_CONFIG;
const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

const runCli = (
  args: readonly string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd,
      env: { ...process.env, HONEYBEE_ENABLE_LEGACY_RUNS: "1" },
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

describe.skipIf(configPath === undefined)("Unity real environment E2E", () => {
  it(
    "runs OpenCode/Unity/TestPlay and leaves provider residual 0",
    async () => {
      const cwd = await mkdtemp(path.join(tmpdir(), "honeybee-unity-real-"));
      try {
        const execution = await runCli(
          [
            "unity",
            "run",
            "--config",
            configPath as string,
            "--task",
            process.env.HONEYBEE_UNITY_E2E_TASK ??
              "Apply the fixture change and make its Unity test pass.",
            "--json",
          ],
          cwd,
        );
        expect(execution.exitCode, execution.stderr).toBe(0);
        const result = JSON.parse(execution.stdout) as {
          status: string;
          journalPath: string;
          evidence?: { kind: string };
          release?: { kind: string };
        };
        expect(result.status).toBe("completed");
        expect(result.evidence?.kind).toBe("testplay-evidence");
        expect(result.release?.kind).toBe("workspace-release-receipt");
        const events = (await readFile(result.journalPath, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { type: string });
        expect(events.at(-2)?.type).toBe("workspace.released");
        expect(events.at(-1)?.type).toBe("workflow.completed");

        const config = await loadUnityWorkConfig(configPath as string);
        if ("schemaVersion" in config.workspaceStorage) throw new Error("expected legacy storage");
        const status = await new UnityWorkspaceStorageCliAdapter(
          config.workspaceStorage.command,
          config.workspaceStorage.parentKey.provider,
          config.workspaceStorage.binarySha256,
        ).status("honeybee-e2e-residual-" + randomUUID(), config.workspaceStorage.workspaceRoot);
        expect(status.status).toMatchObject({
          activeChildCount: 0,
          retainedChildCount: 0,
          pendingCount: 0,
          quarantineCount: 0,
        });
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    },
    30 * 60 * 1000,
  );
});
