import { spawn } from "node:child_process";

import { HoneyBeeCoreError } from "./errors.js";
import type { AgentProcessRequest, AgentProcessResult, AgentProcessRunner } from "./types.js";

const mergedEnvironment = (
  overrides: Readonly<Record<string, string>> | undefined,
): NodeJS.ProcessEnv => ({ ...process.env, ...overrides });

export class ChildProcessAgentRunner implements AgentProcessRunner {
  public run(
    request: AgentProcessRequest,
    onStarted?: (pid: number) => void,
  ): Promise<AgentProcessResult> {
    if (request.command.command.trim().length === 0) {
      return Promise.reject(
        new HoneyBeeCoreError(
          "validation.invalid-command",
          `The ${request.role} command cannot be empty.`,
          request.role,
        ),
      );
    }

    return new Promise<AgentProcessResult>((resolve, reject) => {
      const startedAt = Date.now();
      const child = spawn(request.command.command, [...(request.command.args ?? [])], {
        cwd: request.command.cwd ?? process.cwd(),
        env: mergedEnvironment({
          ...request.command.env,
          HONEYBEE_AGENT_ROLE: request.role,
        }),
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let outputBytes = 0;
      let terminalError: HoneyBeeCoreError | undefined;
      let settled = false;

      const terminateWith = (error: HoneyBeeCoreError): void => {
        terminalError ??= error;
        if (child.exitCode === null) child.kill();
      };

      const collect = (target: Buffer[], chunk: Buffer | string): void => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        outputBytes += buffer.byteLength;
        if (outputBytes > request.maxOutputBytes) {
          terminateWith(
            new HoneyBeeCoreError(
              "agent.output-limit",
              `The ${request.role} agent exceeded the output limit.`,
              request.role,
              { maxOutputBytes: request.maxOutputBytes },
            ),
          );
          return;
        }
        target.push(buffer);
      };

      child.stdout.on("data", (chunk: Buffer | string) => collect(stdoutChunks, chunk));
      child.stderr.on("data", (chunk: Buffer | string) => collect(stderrChunks, chunk));

      child.once("spawn", () => {
        if (child.pid === undefined) return;
        onStarted?.(child.pid);
        child.stdin.end(request.prompt, "utf8");
      });

      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(
          new HoneyBeeCoreError(
            "agent.spawn-failed",
            `Failed to start the ${request.role} agent process.`,
            request.role,
            { cause: error.message },
          ),
        );
      });

      child.once("close", (exitCode) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (terminalError !== undefined) {
          reject(terminalError);
          return;
        }
        const stdout = Buffer.concat(stdoutChunks).toString("utf8");
        const stderr = Buffer.concat(stderrChunks).toString("utf8");
        if (exitCode !== 0) {
          reject(
            new HoneyBeeCoreError(
              "agent.non-zero-exit",
              `The ${request.role} agent exited with code ${String(exitCode)}.`,
              request.role,
              { exitCode, stderr },
            ),
          );
          return;
        }
        resolve({
          role: request.role,
          pid: child.pid ?? -1,
          command: request.command.command,
          exitCode,
          stdout,
          stderr,
          durationMs: Date.now() - startedAt,
        });
      });

      const timeout = setTimeout(() => {
        terminateWith(
          new HoneyBeeCoreError(
            "agent.timed-out",
            `The ${request.role} agent timed out.`,
            request.role,
            { timeoutMs: request.timeoutMs },
          ),
        );
      }, request.timeoutMs);
    });
  }
}
