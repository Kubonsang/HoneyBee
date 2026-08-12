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

const digest = (hash: ReturnType<typeof createHash>) =>
  ContentDigestSchema.parse(`sha256:${hash.digest("hex")}`);

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
      const stdoutHash = createHash("sha256");
      const stderrHash = createHash("sha256");
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let termination: AgentProcessResult["termination"] = "exited";
      let settled = false;
      let startedPersisted = false;
      let startBarrier: Promise<void> = Promise.resolve();
      let inputFailure: HoneyBeeCoreError | undefined;
      let timeout: ReturnType<typeof setTimeout> | undefined;

      const rememberInputFailure = (error?: Error): HoneyBeeCoreError => {
        inputFailure ??= new HoneyBeeCoreError(
          "agent.input-write-failed",
          `Failed to deliver input to the ${request.stepId} agent process.`,
          request.stepId,
          error === undefined ? undefined : { cause: error.message },
        );
        return inputFailure;
      };

      let forcedTermination: ReturnType<typeof setTimeout> | undefined;
      const terminate = (reason: "timed-out" | "output-limit" | "cancelled"): void => {
        if (termination === "exited") termination = reason;
        if (child.exitCode === null && child.signalCode === null) {
          child.kill();
          const graceMs = request.cancelGraceMs ?? 5_000;
          forcedTermination ??= setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
          }, graceMs);
        }
      };

      const onAbort = (): void => terminate("cancelled");
      if (request.signal?.aborted === true) onAbort();
      else request.signal?.addEventListener("abort", onAbort, { once: true });

      const collect = (target: Buffer[], stream: "stdout" | "stderr", chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (stream === "stdout") {
          stdoutBytes += buffer.byteLength;
          stdoutHash.update(buffer);
        } else {
          stderrBytes += buffer.byteLength;
          stderrHash.update(buffer);
        }
        if (stdoutBytes + stderrBytes > request.maxOutputBytes) {
          terminate("output-limit");
          return;
        }
        target.push(buffer);
      };

      child.stdout.on("data", (chunk: Buffer | string) => collect(stdoutChunks, "stdout", chunk));
      child.stderr.on("data", (chunk: Buffer | string) => collect(stderrChunks, "stderr", chunk));
      child.stdin.on("error", (error: Error) => rememberInputFailure(error));

      const writeInput = (): Promise<void> =>
        new Promise((writeResolve, writeReject) => {
          let writeSettled = false;
          const cleanup = (): void => {
            child.stdin.off("error", onError);
            child.stdin.off("close", onClose);
          };
          const fail = (error?: Error): void => {
            if (writeSettled) return;
            writeSettled = true;
            cleanup();
            writeReject(rememberInputFailure(error));
          };
          const onError = (error: Error): void => fail(error);
          const onClose = (): void => {
            if (!child.stdin.writableFinished) fail();
          };
          child.stdin.once("error", onError);
          child.stdin.once("close", onClose);
          child.stdin.end(request.prompt, "utf8", () => {
            if (writeSettled) return;
            writeSettled = true;
            cleanup();
            writeResolve();
          });
        });

      child.once("spawn", () => {
        if (child.pid === undefined) return;
        startBarrier = lifecycle.onStarted(child.pid).then(async () => {
          startedPersisted = true;
          timeout = setTimeout(() => terminate("timed-out"), request.timeoutMs);
          if (child.exitCode === null && child.signalCode === null) {
            try {
              await writeInput();
            } catch (error) {
              inputFailure = error instanceof HoneyBeeCoreError ? error : rememberInputFailure();
              if (child.exitCode === null && child.signalCode === null) child.kill();
            }
          } else {
            inputFailure = rememberInputFailure();
          }
        });
        void startBarrier.catch(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill();
        });
      });

      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        if (timeout !== undefined) clearTimeout(timeout);
        if (forcedTermination !== undefined) clearTimeout(forcedTermination);
        request.signal?.removeEventListener("abort", onAbort);
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
        if (timeout !== undefined) clearTimeout(timeout);
        if (forcedTermination !== undefined) clearTimeout(forcedTermination);
        request.signal?.removeEventListener("abort", onAbort);
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
              stdoutDigest: digest(stdoutHash),
              stderrDigest: digest(stderrHash),
            };
            if (startedPersisted) await lifecycle.onExited(observation);
            if (inputFailure !== undefined) throw inputFailure;
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
    });
  }
}
