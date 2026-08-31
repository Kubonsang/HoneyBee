import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  EventIdSchema,
  FileArtifactStore,
  FileOrchestrationJournal,
  FileRunControl,
  FileRunRepository,
  HoneyBeeCoreError,
  RunIdSchema,
  UnityWorkConfigV1Schema,
  type AgentProcessRunner,
} from "@honeybee/core";
import { describe, expect, it } from "vitest";

import {
  TestPlayCliAdapter,
  UnityProjectBootstrap,
  UnityWorkspaceStorageCliAdapter,
  type SourceManifest,
  type WorkspaceAcquireRequest,
  type WorkspaceAcquireReceipt,
  type WorkspaceReleaseReceipt,
} from "./unity-adapters.js";
import { UnityWorkTransaction } from "./unity-transaction.js";

const manifest: SourceManifest = {
  schemaVersion: 1,
  digest: "a".repeat(64),
  assetsDigest: "b".repeat(64),
  packagesDigest: "c".repeat(64),
  projectSettingsDigest: "d".repeat(64),
  fileCount: 3,
  logicalBytes: 30,
};

class RecordingBootstrap extends UnityProjectBootstrap {
  public released = false;

  public override async manifest(): Promise<SourceManifest> {
    return manifest;
  }

  public override async prepare(
    _sourceProjectPath: string,
    workspaceRoot: string,
    workspaceId: string,
  ): Promise<string> {
    return path.join(workspaceRoot, workspaceId);
  }

  public override async verifyReleased(): Promise<void> {
    this.released = true;
  }
}

class RecordingStorage extends UnityWorkspaceStorageCliAdapter {
  public releases = 0;

  public constructor() {
    super({ command: process.execPath }, "vhdx-differencing", "0".repeat(64));
  }

  public override async preflight(): Promise<void> {}

  public override async acquire(
    request: WorkspaceAcquireRequest,
    workspacePath: string,
  ): Promise<WorkspaceAcquireReceipt> {
    return {
      schemaVersion: 1,
      requestId: request.requestId,
      provider: "vhdx-differencing",
      lease: {
        leaseId: "lease-1",
        runId: request.consumerId,
        parentKey: request.parentKey.digest,
        mountPath: path.join(workspacePath, "Library"),
        state: "ready",
        retained: false,
      },
    };
  }

  public override async release(
    leaseId: string,
    requestId: string,
  ): Promise<WorkspaceReleaseReceipt> {
    this.releases += 1;
    return {
      schemaVersion: 1,
      requestId,
      provider: "vhdx-differencing",
      lease: {
        leaseId,
        runId: "released",
        parentKey: "released",
        mountPath: "released",
        state: "released",
        retained: false,
      },
      metrics: { cleanupState: "released" },
    };
  }
}

class CancellableRunner implements AgentProcessRunner {
  public started!: () => void;
  public readonly startedPromise = new Promise<void>((resolve) => {
    this.started = resolve;
  });

  public async run(
    request: Parameters<AgentProcessRunner["run"]>[0],
    lifecycle: Parameters<AgentProcessRunner["run"]>[1],
  ): ReturnType<AgentProcessRunner["run"]> {
    await lifecycle.onStarted(process.pid);
    this.started();
    await new Promise<void>((resolve) => {
      if (request.signal?.aborted === true) resolve();
      else request.signal?.addEventListener("abort", () => resolve(), { once: true });
    });
    const observation = {
      pid: process.pid,
      exitCode: null,
      signal: "SIGTERM",
      durationMs: 1,
      stdoutBytes: 0,
      stderrBytes: 0,
    } as const;
    await lifecycle.onExited(observation);
    return {
      ...observation,
      stepId: request.stepId,
      command: request.command.command,
      termination: "cancelled",
      stdout: "",
      stderr: "",
    };
  }
}

class ThrowingDeferredCancellableRunner implements AgentProcessRunner {
  public started!: () => void;
  public readonly startedPromise = new Promise<void>((resolve) => {
    this.started = resolve;
  });

  public async run(
    request: Parameters<AgentProcessRunner["run"]>[0],
    lifecycle: Parameters<AgentProcessRunner["run"]>[1],
  ): ReturnType<AgentProcessRunner["run"]> {
    await lifecycle.onStarted(process.pid, { containment: "deferred-v1" });
    await lifecycle.onRegistered?.(process.pid);
    this.started();
    await new Promise<void>((resolve) => {
      if (request.signal?.aborted === true) resolve();
      else request.signal?.addEventListener("abort", () => resolve(), { once: true });
    });
    await lifecycle.onExited({
      pid: process.pid,
      exitCode: null,
      signal: "SIGTERM",
      durationMs: 1,
      stdoutBytes: 0,
      stderrBytes: 0,
    });
    throw new HoneyBeeCoreError("agent.cancelled", "Structured Agent session was cancelled.");
  }
}

class PollingErrorControl extends FileRunControl {
  #pendingCalls = 0;

  public override async pending(
    runId: Parameters<FileRunControl["pending"]>[0],
  ): ReturnType<FileRunControl["pending"]> {
    this.#pendingCalls += 1;
    if (this.#pendingCalls === 1) return super.pending(runId);
    throw new HoneyBeeCoreError("control.read-failed", "Injected control inbox failure.");
  }
}

const cancellationConfig = (root: string) => {
  const hex = (value: string) => value.repeat(64);
  return UnityWorkConfigV1Schema.parse({
    schemaVersion: 1,
    sourceProjectPath: path.join(root, "source"),
    workspaceStorage: {
      command: { command: process.execPath },
      contractCommit: "575c3b37896cd3dfa37a4705477837cc52ec6132",
      binarySha256: "0".repeat(64),
      workspaceRoot: path.join(root, "workspaces"),
      parentKey: {
        schemaVersion: 2,
        digest: hex("a"),
        libraryKey: {
          schemaVersion: "1",
          digest: hex("b"),
          unityVersion: "6000",
          unityExecutableSha256: hex("c"),
          manifestSha256: hex("d"),
          packagesLockSha256: "missing",
          projectSettingsSha256: hex("e"),
          buildTarget: "windows/amd64",
          scriptingBackend: "Mono",
          projectIdentitySha256: hex("f"),
        },
        provider: "vhdx-differencing",
        filesystem: "NTFS",
        virtualBytes: 1,
        blockBytes: 1,
        sectorBytes: 1,
      },
    },
    agent: {
      command: { command: "unused" },
      harness: "stdio-framed-v2",
    },
    testplay: {
      command: { command: "unused" },
      unityPath: path.join(root, "Unity.exe"),
      platform: "edit_mode",
      timeoutMs: 1000,
    },
  });
};

describe("UnityWorkTransaction cancellation", () => {
  it("records a deferred process drain when a structured runner throws after exit", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "honeybee-unity-deferred-cancel-"));
    try {
      const config = cancellationConfig(root);
      const runId = RunIdSchema.parse(randomUUID());
      await new FileRunRepository(root).create(runId);
      const controls = new FileRunControl(root);
      const journal = new FileOrchestrationJournal(root);
      const runner = new ThrowingDeferredCancellableRunner();
      const storage = new RecordingStorage();
      const bootstrap = new RecordingBootstrap();
      const transaction = new UnityWorkTransaction(
        runner,
        new FileArtifactStore(root),
        journal,
        controls,
        bootstrap,
        storage,
        new TestPlayCliAdapter(config.testplay),
      );

      const execution = transaction.run(runId, "cancel structured session safely", config);
      await runner.startedPromise;
      await controls.submit({
        requestId: EventIdSchema.parse(randomUUID()),
        runId,
        action: "cancel",
        timestamp: new Date().toISOString(),
      });
      const result = await execution;

      expect(result.status).toBe("cancelled");
      expect(storage.releases).toBe(1);
      expect(bootstrap.released).toBe(true);
      const replay = await journal.replay(runId);
      expect(replay.status).toBe("terminal");
      if (replay.status === "terminal") {
        expect(replay.events.some((event) => event.type === "process.drain-completed")).toBe(true);
        expect(replay.events.at(-2)?.type).toBe("workspace.released");
        expect(replay.events.at(-1)?.type).toBe("workflow.cancelled");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 10_000);

  it("drains the Agent and releases with an independent cleanup path", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "honeybee-unity-cancel-"));
    try {
      const config = cancellationConfig(root);
      const runId = RunIdSchema.parse(randomUUID());
      await new FileRunRepository(root).create(runId);
      const controls = new FileRunControl(root);
      const journal = new FileOrchestrationJournal(root);
      const runner = new CancellableRunner();
      const storage = new RecordingStorage();
      const bootstrap = new RecordingBootstrap();
      const transaction = new UnityWorkTransaction(
        runner,
        new FileArtifactStore(root),
        journal,
        controls,
        bootstrap,
        storage,
        new TestPlayCliAdapter(config.testplay),
      );
      const execution = transaction.run(runId, "cancel safely", config);
      await runner.startedPromise;
      await controls.submit({
        requestId: EventIdSchema.parse(randomUUID()),
        runId,
        action: "cancel",
        timestamp: new Date().toISOString(),
      });
      const result = await execution;
      expect(result.status).toBe("cancelled");
      expect(storage.releases).toBe(1);
      expect(bootstrap.released).toBe(true);
      const replay = await journal.replay(runId);
      expect(replay.status).toBe("terminal");
      if (replay.status === "terminal") {
        expect(replay.events.some((event) => event.type === "control.accepted")).toBe(true);
        expect(replay.events.at(-2)?.type).toBe("workspace.released");
        expect(replay.events.at(-1)?.type).toBe("workflow.cancelled");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 10_000);

  it("records a control polling failure as failed rather than cancelled", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "honeybee-unity-control-error-"));
    try {
      const config = cancellationConfig(root);
      const runId = RunIdSchema.parse(randomUUID());
      await new FileRunRepository(root).create(runId);
      const controls = new PollingErrorControl(root);
      const journal = new FileOrchestrationJournal(root);
      const storage = new RecordingStorage();
      const bootstrap = new RecordingBootstrap();
      const transaction = new UnityWorkTransaction(
        new CancellableRunner(),
        new FileArtifactStore(root),
        journal,
        controls,
        bootstrap,
        storage,
        new TestPlayCliAdapter(config.testplay),
      );

      const result = await transaction.run(runId, "fail polling safely", config);

      expect(result.status).toBe("failed");
      expect(result.failure?.errorCode).toBe("control.read-failed");
      expect(storage.releases).toBe(1);
      expect(bootstrap.released).toBe(true);
      const replay = await journal.replay(runId);
      expect(replay.status).toBe("terminal");
      if (replay.status === "terminal") {
        expect(replay.terminal).toMatchObject({
          type: "workflow.failed",
          payload: { failure: { errorCode: "control.read-failed" } },
        });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 10_000);
});
