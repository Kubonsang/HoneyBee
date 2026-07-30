import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { RunIdSchema, SessionIdSchema } from "@honeybee/domain";
import { describe, expect, it, vi } from "vitest";

import type { RuntimeClientEvent } from "../application/ports.js";
import { JsonlRuntimeClient, NodeChildProcessRuntimeTransport } from "./jsonl-runtime-client.js";

const windowsDescribe = process.platform === "win32" ? describe : describe.skip;
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const runtimeCliPath = path.join(
  repositoryRoot,
  "apps",
  "vscode-extension",
  "dist",
  "runtime",
  "cli.cjs",
);
const echoFixturePath = path.join(
  repositoryRoot,
  "packages",
  "test-fixtures",
  "dist",
  "echo-cli.js",
);

const processEnvironment = (): Readonly<Record<string, string>> => {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      environment[key] = value;
    }
  }
  return environment;
};

windowsDescribe("VS Code JSONL client to runtime integration", () => {
  it("starts the packaged sidecar and round-trips PTY input, resize, output, and exit", async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "honeybee-extension-"));
    const diagnostics: string[] = [];
    const transport = new NodeChildProcessRuntimeTransport({
      command: process.execPath,
      args: [runtimeCliPath],
      cwd: temporaryDirectory,
      environment: process.env,
      onDiagnostic: (message) => {
        diagnostics.push(message);
      },
    });
    let requestSequence = 0;
    const client = new JsonlRuntimeClient(transport, {
      requestId: () => `extension-integration-${++requestSequence}`,
    });
    const events: RuntimeClientEvent[] = [];
    let output = "";
    client.onEvent((event) => {
      events.push(event);
      if (event.type === "pty.data") {
        output += event.data;
      }
    });
    const sessionId = SessionIdSchema.parse("extension-integration");
    const runId = RunIdSchema.parse("run-extension-integration");

    try {
      await client.connect();
      await client.start({
        sessionId,
        runId,
        command: process.execPath,
        args: [echoFixturePath],
        cwd: temporaryDirectory,
        environment: processEnvironment(),
        shell: false,
        columns: 80,
        rows: 24,
      });
      await vi.waitFor(() => expect(output).toContain("Honey Bee Echo"), {
        timeout: 10_000,
      });

      await client.resize(sessionId, 110, 32, runId);
      await client.sendInput(sessionId, "ansi\r", runId);
      await vi.waitFor(() => {
        expect(output).toContain("ANSI-RED");
        expect(output).toContain("\u001b[");
      });

      await client.sendInput(sessionId, "exit 0\r", runId);
      await vi.waitFor(
        () =>
          expect(events).toContainEqual({
            type: "session.status",
            sessionId,
            runId,
            status: "completed",
            reason: "process-exit-zero",
            exitCode: 0,
            message: "Agent completed successfully.",
          }),
        { timeout: 10_000 },
      );
      expect(diagnostics.join("")).not.toContain("protocol");
    } finally {
      await client.shutdown("extension-shutdown");
      await client.dispose();
      await rm(temporaryDirectory, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    }
  }, 20_000);
});
