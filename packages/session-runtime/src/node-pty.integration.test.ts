import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { RunIdSchema, SessionIdSchema } from "@honeybee/domain";
import { echoFixtureCliPath } from "@honeybee/test-fixtures";
import { describe, expect, it, vi } from "vitest";

import { NodePtyFactory } from "./node-pty-adapter.js";
import { PtySessionManager } from "./session-manager.js";
import type { PtySessionEvent } from "./types.js";

const processEnvironment = (): Readonly<Record<string, string>> => {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      environment[key] = value;
    }
  }
  return environment;
};

const windowsDescribe = process.platform === "win32" ? describe : describe.skip;

const findGitBundledVim = (): string | undefined => {
  if (process.platform !== "win32") {
    return undefined;
  }

  const located = spawnSync("where.exe", ["git.exe"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (located.status !== 0) {
    return undefined;
  }

  for (const gitExecutable of located.stdout.split(/\r?\n/u).map((line) => line.trim())) {
    if (gitExecutable.length === 0 || !existsSync(gitExecutable)) {
      continue;
    }
    let candidateRoot = path.dirname(gitExecutable);
    for (let depth = 0; depth < 4; depth += 1) {
      const vimExecutable = path.join(candidateRoot, "usr", "bin", "vim.exe");
      if (existsSync(vimExecutable)) {
        return vimExecutable;
      }
      const parent = path.dirname(candidateRoot);
      if (parent === candidateRoot) {
        break;
      }
      candidateRoot = parent;
    }
  }
  return undefined;
};

const gitBundledVim = findGitBundledVim();

windowsDescribe("NodePtyFactory Windows ConPTY integration", () => {
  it("round-trips Echo Fixture from a spaced Korean path with literal input and bounded output", async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "Honey Bee 한글 PTY "));
    const fixtureDirectory = path.join(temporaryDirectory, "도구 경로 (공백)");
    const copiedFixturePath = path.join(fixtureDirectory, "Echo 벌 Fixture.js");
    await mkdir(fixtureDirectory, { recursive: true });
    await copyFile(echoFixtureCliPath, copiedFixturePath);

    const logFilePath = path.join(temporaryDirectory, "echo.pty.log");
    const manager = new PtySessionManager(new NodePtyFactory(), {
      ringBufferBytes: 4096,
      logDirectory: temporaryDirectory,
    });
    const sessionId = SessionIdSchema.parse("echo-integration");
    const runId = RunIdSchema.parse("run-echo-integration");
    const events: PtySessionEvent[] = [];
    let output = "";
    manager.onEvent((event) => {
      events.push(event);
      if (event.type === "session.output") {
        output += event.data;
      }
    });

    try {
      await manager.start({
        sessionId,
        runId,
        launchSpec: {
          command: process.execPath,
          args: [copiedFixturePath],
          cwd: fixtureDirectory,
          env: processEnvironment(),
          shell: false,
        },
        size: { cols: 80, rows: 24 },
        logFilePath,
      });

      await vi.waitFor(() => expect(output).toContain("Honey Bee Echo 벌 🐝"), {
        timeout: 10_000,
      });
      manager.resize(sessionId, runId, { cols: 100, rows: 30 });
      manager.input(sessionId, runId, "unicode\r");
      manager.input(sessionId, runId, "ansi\r");
      const literalInput = 'literal "quote" \\path & | ^ %PATH% $HOME';
      manager.input(sessionId, runId, literalInput + "\r");
      await vi.waitFor(() => {
        expect(output).toContain("UTF8:한글:🐝");
        expect(output).toContain("ANSI-RED");
        expect(output).toContain("\u001b[");
        expect(output).toContain("ECHO:" + literalInput);
      });

      manager.input(sessionId, runId, "burst 10000\r");
      await vi.waitFor(() => {
        const snapshot = manager.getSnapshot(sessionId, runId);
        expect(snapshot.byteLength).toBeLessThanOrEqual(4096);
        expect(snapshot.truncatedBytes).toBeGreaterThan(0);
      });

      manager.input(sessionId, runId, "exit 7\r");
      await vi.waitFor(
        () =>
          expect(events.find((event) => event.type === "session.exited")).toMatchObject({
            type: "session.exited",
            exitCode: 7,
            reason: "exited",
          }),
        { timeout: 10_000 },
      );

      const log = await readFile(logFilePath, "utf8");
      expect(log).toContain("Honey Bee Echo 벌 🐝");
      expect(log).toContain("UTF8:한글:🐝");
      expect(log).toContain("ANSI-RED");
      expect(log).toContain("\u001b[");
      expect(log).toContain("ECHO:" + literalInput);
      const burstCharacterCount = [...log].filter((character) => character === "x").length;
      expect(burstCharacterCount).toBeGreaterThanOrEqual(10_000);
    } finally {
      await manager.shutdown();
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }, 20_000);

  it.skipIf(gitBundledVim === undefined)(
    "runs the Git for Windows bundled Vim TUI through the real PTY",
    async () => {
      if (gitBundledVim === undefined) {
        throw new Error("Git for Windows bundled Vim became unavailable after test discovery.");
      }

      const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "honeybee-vim-"));
      const manager = new PtySessionManager(new NodePtyFactory(), {
        logDirectory: temporaryDirectory,
      });
      const sessionId = SessionIdSchema.parse("vim-integration");
      const runId = RunIdSchema.parse("run-vim-integration");
      const events: PtySessionEvent[] = [];
      let output = "";
      manager.onEvent((event) => {
        events.push(event);
        if (event.type === "session.output") {
          output += event.data;
        }
      });

      try {
        await manager.start({
          sessionId,
          runId,
          launchSpec: {
            command: gitBundledVim,
            args: ["-Nu", "NONE", "-n", "-i", "NONE"],
            cwd: temporaryDirectory,
            env: processEnvironment(),
            shell: false,
          },
          size: { cols: 100, rows: 30 },
        });

        await vi.waitFor(
          () => {
            expect(output).toContain("\u001b[");
            expect(
              ["\u001b[?47h", "\u001b[?1047h", "\u001b[?1049h"].some((marker) =>
                output.includes(marker),
              ),
            ).toBe(true);
          },
          { timeout: 10_000 },
        );

        manager.input(sessionId, runId, "\u001b:q!\r");
        await vi.waitFor(
          () =>
            expect(events.find((event) => event.type === "session.exited")).toMatchObject({
              type: "session.exited",
              exitCode: 0,
              reason: "exited",
            }),
          { timeout: 10_000 },
        );
        expect(Buffer.byteLength(output, "utf8")).toBeGreaterThan(0);
        expect(manager.activeSessionCount).toBe(0);
      } finally {
        await manager.shutdown();
        await rm(temporaryDirectory, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 100,
        });
      }
    },
    20_000,
  );

  it("interrupts a live Echo Fixture through the real Windows PTY", async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "honeybee-interrupt-"));
    const manager = new PtySessionManager(new NodePtyFactory(), {
      logDirectory: temporaryDirectory,
    });
    const sessionId = SessionIdSchema.parse("interrupt-integration");
    const runId = RunIdSchema.parse("run-interrupt-integration");
    const events: PtySessionEvent[] = [];
    let output = "";
    manager.onEvent((event) => {
      events.push(event);
      if (event.type === "session.output") {
        output += event.data;
      }
    });

    try {
      await manager.start({
        sessionId,
        runId,
        launchSpec: {
          command: process.execPath,
          args: [echoFixtureCliPath],
          cwd: path.dirname(echoFixtureCliPath),
          env: processEnvironment(),
          shell: false,
        },
        size: { cols: 80, rows: 24 },
      });
      await vi.waitFor(() => expect(output).toContain("Honey Bee Echo"), { timeout: 10_000 });

      manager.interrupt(sessionId, runId);
      await vi.waitFor(
        () => {
          expect(output).toContain("INTERRUPTED");
          expect(events.find((event) => event.type === "session.exited")).toMatchObject({
            type: "session.exited",
            exitCode: 130,
            reason: "interrupted",
          });
        },
        { timeout: 10_000 },
      );
      expect(manager.activeSessionCount).toBe(0);
    } finally {
      await manager.shutdown();
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }, 20_000);

  it("captures a process that exits immediately after spawn", async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "honeybee-fast-exit-"));
    const manager = new PtySessionManager(new NodePtyFactory(), {
      logDirectory: temporaryDirectory,
    });
    const sessionId = SessionIdSchema.parse("fast-exit");
    const runId = RunIdSchema.parse("run-fast-exit");
    const events: PtySessionEvent[] = [];
    manager.onEvent((event) => events.push(event));

    try {
      await manager.start({
        sessionId,
        runId,
        launchSpec: {
          command: process.execPath,
          args: ["-e", "process.exit(9)"],
          cwd: temporaryDirectory,
          env: processEnvironment(),
          shell: false,
        },
        size: { cols: 80, rows: 24 },
      });

      await vi.waitFor(
        () =>
          expect(events.find((event) => event.type === "session.exited")).toMatchObject({
            type: "session.exited",
            exitCode: 9,
            reason: "exited",
          }),
        { timeout: 10_000 },
      );
      expect(manager.activeSessionCount).toBe(0);
    } finally {
      await manager.shutdown();
      await rm(temporaryDirectory, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    }
  }, 20_000);
});
