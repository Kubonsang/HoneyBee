import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

import { ContentDigestSchema } from "@honeybee/orchestration-contracts";

import { HoneyBeeCoreError } from "./errors.js";
import type {
  AgentExitObservation,
  AgentProcessRequest,
  AgentProcessResult,
  AgentProcessRunner,
} from "./types.js";

const mergedEnvironment = (
  overrides: Readonly<Record<string, string>> | undefined,
): NodeJS.ProcessEnv => ({ ...process.env, ...overrides });

const digest = (chunks: readonly Buffer[]) =>
  ContentDigestSchema.parse(
    `sha256:${createHash("sha256").update(Buffer.concat(chunks)).digest("hex")}`,
  );

export class ChildProcessAgentRunner implements AgentProcessRunner {
  public run(
    request: AgentProcessRequest,
    lifecycle: Parameters<AgentProcessRunner["run"]>[1],
  ): Promise<AgentProcessResult> {
    if (request.command.command.trim().length === 0) {
      return Promise.reject(
        new HoneyBeeCoreError(
          "validation.invalid-command",
          `The ${request.stepId} command cannot be empty.`,
          request.stepId,
        ),
      );
    }

    return new Promise<AgentProcessResult>((resolve, reject) => {
      const startedAt = Date.now();
      const child = spawn(request.command.command, [...(request.command.args ?? [])], {
        cwd: request.command.cwd ?? process.cwd(),
        env: mergedEnvironment({
          ...request.command.env,
          HONEYBEE_RUN_ID: request.runId,
          HONEYBEE_STEP_ID: request.stepId,
        }),
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let termination: AgentProcessResult["termination"] = "exited";
      let settled = false;
      let startedPersisted = false;
      let startBarrier: Promise<void> = Promise.resolve();

      const terminate = (reason: "timed-out" | "output-limit"): void => {
        if (termination === "exited") termination = reason;
        if (child.exitCode === null && child.signalCode === null) child.kill();
      };

      const collect = (target: Buffer[], stream: "stdout" | "stderr", chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (stream === "stdout") stdoutBytes += buffer.byteLength;
        else stderrBytes += buffer.byteLength;
        if (stdoutBytes + stderrBytes > request.maxOutputBytes) {
          terminate("output-limit");
          return;
        }
        target.push(buffer);
      };

      child.stdout.on("data", (chunk: Buffer | string) => collect(stdoutChunks, "stdout", chunk));
      child.stderr.on("data", (chunk: Buffer | string) => collect(stderrChunks, "stderr", chunk));
      child.stdin.on("error", () => undefined);

      child.once("spawn", () => {
        if (child.pid === undefined) return;
        startBarrier = lifecycle.onStarted(child.pid).then(() => {
          startedPersisted = true;
          if (child.exitCode === null && child.signalCode === null) {
            child.stdin.end(request.prompt, "utf8");
          }
        });
        void startBarrier.catch(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill();
        });
      });

      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(
          new HoneyBeeCoreError(
            "agent.spawn-failed",
            `Failed to start the ${request.stepId} agent process.`,
            request.stepId,
            { cause: error.message },
          ),
        );
      });

      child.once("close", (exitCode, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        void (async () => {
          try {
            await startBarrier;
            const observation: AgentExitObservation = {
              pid: child.pid ?? -1,
              exitCode,
              signal,
              durationMs: Date.now() - startedAt,
              stdoutBytes,
              stderrBytes,
              stdoutDigest: digest(stdoutChunks),
              stderrDigest: digest(stderrChunks),
            };
            if (startedPersisted) await lifecycle.onExited(observation);
            resolve({
              ...observation,
              stepId: request.stepId,
              command: request.command.command,
              termination,
              stdout: Buffer.concat(stdoutChunks).toString("utf8"),
              stderr: Buffer.concat(stderrChunks).toString("utf8"),
            });
          } catch (error) {
            reject(error);
          }
        })();
      });

      const timeout = setTimeout(() => terminate("timed-out"), request.timeoutMs);
    });
  }
}
