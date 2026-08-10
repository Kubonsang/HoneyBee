import { createHash, randomUUID } from "node:crypto";

import { ContentDigestSchema, RunIdSchema, StepIdSchema } from "@honeybee/orchestration-contracts";
import { describe, expect, it } from "vitest";

import { ChildProcessAgentRunner } from "./child-process-runner.js";
import type { AgentExitObservation } from "./types.js";

const expectedDigest = (byte: string, length: number) =>
  ContentDigestSchema.parse(
    `sha256:${createHash("sha256").update(byte.repeat(length), "utf8").digest("hex")}`,
  );

const request = (args: readonly string[], prompt: string, maxOutputBytes: number) => ({
  runId: RunIdSchema.parse(randomUUID()),
  stepId: StepIdSchema.parse("worker"),
  prompt,
  command: { command: process.execPath, args: [...args] },
  timeoutMs: 5_000,
  maxOutputBytes,
});

describe("ChildProcessAgentRunner", () => {
  it("fails closed when the process closes stdin before Prompt delivery", async () => {
    const events: string[] = [];
    await expect(
      new ChildProcessAgentRunner().run(
        request(
          ["-e", "process.stdin.destroy(); setTimeout(() => process.exit(0), 500);"],
          "x".repeat(4 * 1024 * 1024),
          1024,
        ),
        {
          onStarted: async () => {
            events.push("started");
            await new Promise((resolve) => setTimeout(resolve, 150));
          },
          onExited: async () => {
            events.push("exited");
          },
        },
      ),
    ).rejects.toMatchObject({ code: "agent.input-write-failed" });
    expect(events).toEqual(["started", "exited"]);
  });

  it("hashes exactly every observed stdout byte when the output limit is exceeded", async () => {
    let exit: AgentExitObservation | undefined;
    const result = await new ChildProcessAgentRunner().run(
      request(["-e", 'process.stdout.write("x".repeat(65536));'], "input", 1024),
      {
        onStarted: async () => undefined,
        onExited: async (observation) => {
          exit = observation;
        },
      },
    );

    expect(result.termination).toBe("output-limit");
    expect(result.stdoutBytes).toBeGreaterThan(1024);
    expect(result.stdoutDigest).toBe(expectedDigest("x", result.stdoutBytes));
    expect(exit?.stdoutBytes).toBe(result.stdoutBytes);
    expect(exit?.stdoutDigest).toBe(result.stdoutDigest);
  });
});
