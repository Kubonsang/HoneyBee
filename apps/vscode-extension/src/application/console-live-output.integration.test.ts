import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  AgentSessionSchema,
  RunIdSchema,
  SessionIdSchema,
  type AgentSession,
  type RunId,
  type SessionId,
} from "@honeybee/domain";
import {
  InMemoryDraftRepository,
  InMemoryPromptDeliveryAttemptRepository,
  InMemoryPromptDeliveryReceiptRepository,
  InMemorySessionRepository,
  InMemorySessionRunRepository,
} from "@honeybee/persistence";
import {
  isExtensionToConsoleMessage,
  type ExtensionToConsoleMessage,
  type TerminalRenderMetrics,
  type TerminalRunKey,
  type TerminalSurface,
  type TerminalSurfaceFactory,
  TerminalRunRegistry,
  terminalRunKey,
  type TerminalRunRegistryTrace,
} from "@honeybee/ui-shared";
import { describe, expect, it, vi } from "vitest";

import {
  JsonlRuntimeClient,
  NodeChildProcessRuntimeTransport,
} from "../adapters/jsonl-runtime-client.js";
import {
  postConsoleMessage,
  type ConsoleMessageTrace,
} from "../presentation/console-message-bridge.js";
import { ConsoleApplicationService, type ConsoleTerminalDataTrace } from "./console-service.js";
import type { AgentProfileResolverPort, RuntimeClientEvent } from "./ports.js";
import { SessionSelectionService } from "./session-selection.js";

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

const processEnvironment = (): Readonly<Record<string, string>> => {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) environment[key] = value;
  }
  return environment;
};

const session = (id: string): AgentSession =>
  AgentSessionSchema.parse({
    id,
    title: id,
    agentProfileId: "cmd",
    tags: [],
    relatedSessionIds: [],
    status: "idle",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  });

class MarkerSurface implements TerminalSurface {
  readonly writes: string[] = [];
  readonly visibility: boolean[] = [];
  resetCount = 0;

  public constructor(readonly input: (data: string) => void) {}

  public write(data: string, onParsed?: (metrics: TerminalRenderMetrics) => void): void {
    this.writes.push(data);
    onParsed?.({
      bufferLineCount: this.writes.length,
      baseY: 0,
      viewportY: 0,
      rows: 30,
    });
  }

  public reset(): void {
    this.resetCount += 1;
  }

  public setVisible(visible: boolean): void {
    this.visibility.push(visible);
  }

  public fit(): { readonly columns: number; readonly rows: number } {
    return { columns: 100, rows: 30 };
  }

  public focus(): void {}
  public dispose(): void {}
}

class MarkerSurfaceFactory implements TerminalSurfaceFactory {
  readonly surfaces = new Map<string, MarkerSurface>();

  public create(key: TerminalRunKey, onData: (data: string) => void): TerminalSurface {
    const surface = new MarkerSurface(onData);
    this.surfaces.set(terminalRunKey(key), surface);
    return surface;
  }

  public get(key: TerminalRunKey): MarkerSurface {
    const surface = this.surfaces.get(terminalRunKey(key));
    if (surface === undefined) throw new Error("Expected terminal surface was not created.");
    return surface;
  }
}

const containsInOrder = (value: string, markers: readonly string[]): boolean => {
  let offset = 0;
  for (const marker of markers) {
    const index = value.indexOf(marker, offset);
    if (index < 0) return false;
    offset = index + marker.length;
  }
  return true;
};

windowsDescribe("Console live cmd.exe incremental rendering", () => {
  it("delivers raw and composed markers through every live rendering stage without Run leakage", async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "honeybee-cmd-live-"));
    const cmd =
      process.env.ComSpec ??
      path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe");
    const environment = processEnvironment();
    const runtimeEvents: {
      readonly marker: string;
      readonly sessionId: SessionId;
      readonly runId: RunId;
      readonly sequence: number;
    }[] = [];
    const applicationTrace: ConsoleTerminalDataTrace[] = [];
    const bridgeTrace: ConsoleMessageTrace[] = [];
    const registryTrace: TerminalRunRegistryTrace[] = [];
    const contractTrace: {
      readonly sessionId: string;
      readonly runId: string;
      readonly sequence: number;
      readonly valid: boolean;
    }[] = [];
    const applyResults: {
      readonly sessionId: string;
      readonly runId: string;
      readonly sequence: number;
      readonly status: string;
    }[] = [];
    const markers = ["SESSION-A", "SESSION-B", "SESSION-C", "SESSION-HIDDEN-A", "SESSION-A2"];

    const transport = new NodeChildProcessRuntimeTransport({
      command: process.execPath,
      args: [runtimeCliPath],
      cwd: temporaryDirectory,
      environment: process.env,
    });
    let requestSequence = 0;
    const runtime = new JsonlRuntimeClient(transport, {
      requestId: () => "cmd-live-" + String(++requestSequence),
    });
    runtime.onEvent((event: RuntimeClientEvent) => {
      if (event.type !== "pty.data") return;
      for (const marker of markers) {
        if (event.data.includes(marker)) {
          runtimeEvents.push({
            marker,
            sessionId: event.sessionId,
            runId: event.runId,
            sequence: event.sequence,
          });
        }
      }
    });

    const sessions = new InMemorySessionRepository([session("session-a"), session("session-b")]);
    const profiles: AgentProfileResolverPort = {
      resolve: async () => ({
        command: cmd,
        args: ["/D", "/K"],
        cwd: temporaryDirectory,
        environment,
        shell: false,
      }),
    };
    let clockTick = 0;
    const clock = {
      now: () => new Date(Date.UTC(2026, 7, 1, 0, 0, clockTick++)).toISOString(),
    };
    const runIds = ["run-a1", "run-b1", "run-a2"].map((value) => RunIdSchema.parse(value));
    const service = new ConsoleApplicationService(
      sessions,
      new InMemoryDraftRepository(),
      new InMemoryPromptDeliveryAttemptRepository(),
      new InMemoryPromptDeliveryReceiptRepository(),
      new InMemorySessionRunRepository(),
      new SessionSelectionService(),
      runtime,
      profiles,
      clock,
      {
        requestId: () => "request-" + String(requestSequence + 1),
        runId: () => {
          const next = runIds.shift();
          if (next === undefined) throw new Error("Run ID fixture exhausted.");
          return next;
        },
      },
      [],
      () => undefined,
      (event) => applicationTrace.push(event),
    );
    const factory = new MarkerSurfaceFactory();
    const registry = new TerminalRunRegistry({
      factory,
      onInput: (key, data) => {
        void service.sendTerminalInput(
          SessionIdSchema.parse(key.sessionId),
          RunIdSchema.parse(key.runId),
          data,
        );
      },
      onResize: () => undefined,
      onSnapshotRequest: (key, afterSeq) => {
        void service.requestTerminalSnapshot(
          SessionIdSchema.parse(key.sessionId),
          RunIdSchema.parse(key.runId),
          afterSeq,
        );
      },
      onTrace: (event) => registryTrace.push(event),
    });

    const routeToWebview = (message: ExtensionToConsoleMessage): boolean => {
      const valid = isExtensionToConsoleMessage(message);
      if (message.type === "terminal.run.data") {
        contractTrace.push({
          sessionId: message.sessionId,
          runId: message.runId,
          sequence: message.seq,
          valid,
        });
      }
      if (!valid) return false;
      switch (message.type) {
        case "console.state": {
          const run = message.state.viewedRun;
          const interactive =
            run !== null && message.state.activeRun?.runId === run.runId && run.interactive;
          registry.select(
            run === null ? undefined : { sessionId: run.sessionId, runId: run.runId },
            interactive,
          );
          break;
        }
        case "terminal.run.open":
          registry.open(message);
          break;
        case "terminal.run.data": {
          const result = registry.applyData(message);
          applyResults.push({
            sessionId: message.sessionId,
            runId: message.runId,
            sequence: message.seq,
            status: result.status,
          });
          break;
        }
        case "terminal.run.snapshot":
          registry.restore(message);
          break;
        case "terminal.run.reset":
          registry.reset(message);
          break;
        case "terminal.run.close":
          registry.close(message);
          break;
      }
      return true;
    };
    service.onMessage((message) => {
      void postConsoleMessage(
        {
          postMessage: async (posted) => routeToWebview(posted),
        },
        message,
        (event) => bridgeTrace.push(event),
      );
    });

    const sessionA = SessionIdSchema.parse("session-a");
    const sessionB = SessionIdSchema.parse("session-b");
    let cleanShutdown = false;
    try {
      await service.initialize();
      await service.select(sessionA);
      await service.start(sessionA);
      const runA1 = service.state.activeRun?.runId;
      if (runA1 === undefined) throw new Error("Session A Run 1 did not start.");
      const keyA1 = { sessionId: sessionA, runId: RunIdSchema.parse(runA1) };
      await vi.waitFor(() => expect(service.state.viewedRun?.interactive).toBe(true), {
        timeout: 10_000,
      });

      await service.sendTerminalInput(sessionA, keyA1.runId, "echo SESSION-A\r");
      await vi.waitFor(() => expect(factory.get(keyA1).writes.join("")).toContain("SESSION-A"), {
        timeout: 10_000,
      });
      await expect(
        service.sendPrompt("prompt-session-b", sessionA, "echo SESSION-B"),
      ).resolves.toMatchObject({ status: "accepted" });
      await vi.waitFor(() => expect(factory.get(keyA1).writes.join("")).toContain("SESSION-B"), {
        timeout: 10_000,
      });

      await service.sendTerminalInput(
        sessionA,
        keyA1.runId,
        "@ping -n 3 127.0.0.1 >nul & echo SESSION-HIDDEN-A\r",
      );
      await service.select(sessionB);
      await service.start(sessionB);
      const runB1 = service.state.activeRun?.runId;
      if (runB1 === undefined) throw new Error("Session B Run 1 did not start.");
      const keyB1 = { sessionId: sessionB, runId: RunIdSchema.parse(runB1) };
      await vi.waitFor(() => expect(service.state.viewedRun?.interactive).toBe(true), {
        timeout: 10_000,
      });
      await service.sendTerminalInput(sessionB, keyB1.runId, "echo SESSION-C\r");
      await vi.waitFor(
        () => {
          expect(factory.get(keyB1).writes.join("")).toContain("SESSION-C");
          expect(factory.get(keyA1).writes.join("")).toContain("SESSION-HIDDEN-A");
        },
        { timeout: 10_000 },
      );
      expect(factory.get(keyB1).writes.join("")).not.toContain("SESSION-A");
      expect(factory.get(keyA1).writes.join("")).not.toContain("SESSION-C");

      const surfaceA1 = factory.get(keyA1);
      await service.select(sessionA);
      expect(factory.get(keyA1)).toBe(surfaceA1);
      expect(surfaceA1.resetCount).toBe(0);
      await service.sendTerminalInput(sessionA, keyA1.runId, "exit\r");
      await vi.waitFor(() => expect(service.state.activeRun).toBeNull(), { timeout: 10_000 });
      await service.start(sessionA);
      const runA2 = service.state.activeRun?.runId;
      if (runA2 === undefined) throw new Error("Session A Run 2 did not start.");
      const keyA2 = { sessionId: sessionA, runId: RunIdSchema.parse(runA2) };
      expect(keyA2.runId).not.toBe(keyA1.runId);
      await vi.waitFor(() => expect(service.state.viewedRun?.interactive).toBe(true), {
        timeout: 10_000,
      });
      await service.sendTerminalInput(sessionA, keyA2.runId, "echo SESSION-A2\r");
      await vi.waitFor(() => expect(factory.get(keyA2).writes.join("")).toContain("SESSION-A2"), {
        timeout: 10_000,
      });
      expect(factory.get(keyA2).writes.join("")).not.toContain("SESSION-B");

      const logPathA1 = await service.resolveRunLogPath(sessionA, keyA1.runId);
      const logA1 = await readFile(logPathA1, "utf8");
      const renderedA1 = surfaceA1.writes.join("");
      expect(containsInOrder(logA1, ["SESSION-A", "SESSION-B", "SESSION-HIDDEN-A"])).toBe(true);
      expect(containsInOrder(renderedA1, ["SESSION-A", "SESSION-B", "SESSION-HIDDEN-A"])).toBe(
        true,
      );

      for (const marker of markers) {
        const runtimeEvent = runtimeEvents.find((event) => event.marker === marker);
        expect(runtimeEvent, "Missing Runtime pty.data marker " + marker).toBeDefined();
        if (runtimeEvent === undefined) continue;
        const identity = {
          sessionId: runtimeEvent.sessionId,
          runId: runtimeEvent.runId,
          sequence: runtimeEvent.sequence,
        };
        expect(applicationTrace).toContainEqual({ stage: "application-received", ...identity });
        expect(applicationTrace).toContainEqual({
          stage: "terminal-message-emitted",
          ...identity,
        });
        expect(bridgeTrace).toContainEqual({ stage: "post-requested", ...identity });
        expect(bridgeTrace).toContainEqual({
          stage: "post-settled",
          ...identity,
          delivered: true,
        });
        expect(contractTrace).toContainEqual({ ...identity, valid: true });
        expect(applyResults).toContainEqual({ ...identity, status: "applied" });
        expect(registryTrace).toContainEqual(
          expect.objectContaining({
            stage: "registry-received",
            key: { sessionId: identity.sessionId, runId: identity.runId },
            seq: identity.sequence,
            status: "active",
          }),
        );
        expect(registryTrace).toContainEqual(
          expect.objectContaining({
            stage: "surface-rendered",
            key: { sessionId: identity.sessionId, runId: identity.runId },
            seq: identity.sequence,
          }),
        );
      }

      service.beginShutdown();
      await service.shutdownRuntime("extension-shutdown");
      cleanShutdown = true;
    } finally {
      if (!cleanShutdown) {
        service.beginShutdown();
        await service.shutdownRuntime("extension-shutdown").catch(() => undefined);
      }
      service.disposeListeners();
      await service.disposeRuntime().catch(() => undefined);
      registry.dispose();
      await rm(temporaryDirectory, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    }
  }, 45_000);
});
