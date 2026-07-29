import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { echoFixtureCliPath } from "@honeybee/test-fixtures";
import { describe, expect, it, vi } from "vitest";

interface ProcessMessage {
  readonly kind: string;
  readonly id?: string;
  readonly ok?: boolean;
  readonly event?: string;
  readonly data?: string;
  readonly exitCode?: number | null;
}

const runtimeCliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const windowsDescribe = process.platform === "win32" ? describe : describe.skip;

windowsDescribe("separate Runtime process JSONL integration", () => {
  it("keeps stdout protocol-only and diagnostics on stderr", async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "honeybee-runtime-"));
    const child = spawn(process.execPath, [runtimeCliPath], {
      cwd: temporaryDirectory,
      env: { ...process.env, HONEYBEE_LOG_DIR: temporaryDirectory },
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const childExit = new Promise<number | null>((resolve) => {
      child.once("exit", (code) => resolve(code));
    });
    const messages: ProcessMessage[] = [];
    let stdoutBuffer = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutBuffer += chunk;
      let newline = stdoutBuffer.indexOf("\n");
      while (newline >= 0) {
        const line = stdoutBuffer.slice(0, newline);
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (line.length > 0) {
          messages.push(JSON.parse(line) as ProcessMessage);
        }
        newline = stdoutBuffer.indexOf("\n");
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    const send = (message: unknown): void => {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };

    try {
      send({
        schemaVersion: 1,
        kind: "request",
        id: "start-process",
        method: "agent.start",
        params: {
          sessionId: "process-session",
          launchSpec: {
            command: process.execPath,
            args: [echoFixtureCliPath],
            cwd: path.dirname(echoFixtureCliPath),
            env: Object.fromEntries(
              Object.entries(process.env).filter(
                (entry): entry is [string, string] => entry[1] !== undefined,
              ),
            ),
            shell: false,
          },
          size: { cols: 80, rows: 24 },
        },
      });

      await vi.waitFor(
        () => {
          expect(messages.some((message) => message.id === "start-process" && message.ok)).toBe(
            true,
          );
          expect(
            messages.some(
              (message) =>
                message.event === "pty.data" && message.data?.includes("Honey Bee Echo 벌 🐝"),
            ),
          ).toBe(true);
        },
        { timeout: 10_000 },
      );

      send({
        schemaVersion: 1,
        kind: "request",
        id: "input-process",
        method: "agent.input",
        params: { sessionId: "process-session", data: "exit 0\r" },
      });
      await vi.waitFor(
        () => expect(messages.some((message) => message.event === "pty.exit")).toBe(true),
        { timeout: 10_000 },
      );

      send({
        schemaVersion: 1,
        kind: "request",
        id: "shutdown-process",
        method: "runtime.shutdown",
        params: {},
      });
      await vi.waitFor(() =>
        expect(messages.some((message) => message.id === "shutdown-process" && message.ok)).toBe(
          true,
        ),
      );
      child.stdin.end();

      const exitCode =
        child.exitCode ??
        (await Promise.race([
          childExit,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("Runtime process did not exit.")), 10_000),
          ),
        ]));
      expect(exitCode).toBe(0);

      expect(stderr).toBe("");
      expect(stdoutBuffer).toBe("");
      expect(
        messages.every((message) => message.kind === "response" || message.kind === "event"),
      ).toBe(true);
    } finally {
      if (child.exitCode === null) {
        child.kill();
        await Promise.race([childExit, new Promise<void>((resolve) => setTimeout(resolve, 2_000))]);
      }
      await rm(temporaryDirectory, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    }
  }, 30_000);
});
