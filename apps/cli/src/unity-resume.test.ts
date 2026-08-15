import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  ArtifactIdSchema,
  EventIdSchema,
  FileArtifactStore,
  FileOrchestrationJournal,
  FileRunControl,
  FileRunRepository,
  HoneyBeeCoreError,
  OrchestrationEventV3Schema,
  OrchestrationEventV4Schema,
  ResourceIdSchema,
  RunIdSchema,
  StepIdSchema,
  UnityWorkConfigV1Schema,
  type AgentProcessResult,
  type AgentProcessRunner,
  type ArtifactStore,
} from "@honeybee/core";
import { afterEach, describe, expect, it } from "vitest";

import {
  TestPlayCliAdapter,
  UnityProjectBootstrap,
  UnityWorkspaceStorageCliAdapter,
  type SourceManifest,
  type WorkspaceAcquireRequest,
  type WorkspaceAcquireReceipt,
  type WorkspaceReleaseReceipt,
} from "./unity-adapters.js";
import type { UnityProcessControl } from "./process-control.js";
import { FileUnityResourceCoordinator } from "./unity-global-resource-control.js";
import { UnityPatchBuilder } from "./unity-patch.js";
import { UnityWorkTransaction, type UnityWorkV4Execution } from "./unity-transaction.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const storageExecutor =
  (
    executableScript: string,
  ): NonNullable<ConstructorParameters<typeof UnityWorkspaceStorageCliAdapter>[3]> =>
  async (_command, args, options) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [executableScript, ...args], {
        cwd: options.cwd,
        env: process.env,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      const startedAt = Date.now();
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.once("spawn", () => child.stdin.end(options.input ?? "", "utf8"));
      child.once("error", reject);
      child.once("close", (exitCode, signal) => {
        const stdoutBytes = Buffer.concat(stdout);
        const stderrBytes = Buffer.concat(stderr);
        resolve({
          pid: child.pid ?? -1,
          exitCode,
          signal,
          durationMs: Date.now() - startedAt,
          stdoutBytes: stdoutBytes.byteLength,
          stderrBytes: stderrBytes.byteLength,
          termination: "exited",
          stdout: stdoutBytes.toString("utf8"),
          stderr: stderrBytes.toString("utf8"),
        });
      });
    });

class CompletedRunner implements AgentProcessRunner {
  public calls = 0;

  public async run(
    request: Parameters<AgentProcessRunner["run"]>[0],
    lifecycle: Parameters<AgentProcessRunner["run"]>[1],
  ): Promise<AgentProcessResult> {
    this.calls += 1;
    await lifecycle.onStarted(process.pid);
    const match = request.prompt.match(
      /HONEYBEE_INPUT_BEGIN\r?\n([\s\S]*?)\r?\nHONEYBEE_INPUT_END/u,
    );
    if (match?.[1] === undefined) throw new Error("missing input");
    const input = JSON.parse(match[1]) as { runId: string; step: { id: string } };
    await writeFile(
      path.join(request.command.cwd as string, "Assets", "agent-created.txt"),
      "workspace only\n",
      "utf8",
    );
    const observation = {
      pid: process.pid,
      exitCode: 0,
      signal: null,
      durationMs: 1,
      stdoutBytes: 1,
      stderrBytes: 0,
    } as const;
    await lifecycle.onExited(observation);
    return {
      ...observation,
      stepId: request.stepId,
      command: request.command.command,
      termination: "exited",
      stdout:
        "HONEYBEE_RESPONSE_BEGIN\n" +
        JSON.stringify({
          schemaVersion: 2,
          runId: input.runId,
          stepId: input.step.id,
          status: "completed",
          outputs: {
            content: {
              mediaType: "text/plain; charset=utf-8",
              content: "done",
            },
          },
        }) +
        "\nHONEYBEE_RESPONSE_END\n",
      stderr: "",
    };
  }
}

const resumeManifest: SourceManifest = {
  schemaVersion: 1,
  digest: "1".repeat(64),
  assetsDigest: "2".repeat(64),
  packagesDigest: "3".repeat(64),
  projectSettingsDigest: "4".repeat(64),
  fileCount: 3,
  logicalBytes: 3,
};

class ResumeBootstrap extends UnityProjectBootstrap {
  public constructor(private readonly sourceFailure = false) {
    super();
  }

  public override async manifest(): Promise<SourceManifest> {
    if (this.sourceFailure) throw new Error("source unavailable");
    return resumeManifest;
  }

  public override async verifyReleased(): Promise<void> {}
}

class ResumeStorage extends UnityWorkspaceStorageCliAdapter {
  public released = false;
  public readonly order: string[] = [];

  public constructor() {
    super({ command: process.execPath }, "vhdx-differencing", "0".repeat(64));
  }

  public override async release(
    leaseId: string,
    requestId: string,
  ): Promise<WorkspaceReleaseReceipt> {
    this.order.push("release");
    this.released = true;
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

class FailFirstResumeStorage extends ResumeStorage {
  public attempts = 0;

  public override async release(
    leaseId: string,
    requestId: string,
  ): Promise<WorkspaceReleaseReceipt> {
    this.attempts += 1;
    if (this.attempts === 1) {
      throw new HoneyBeeCoreError("workspace.command-failed", "Injected release failure.");
    }
    return super.release(leaseId, requestId);
  }
}

class AcquireRecoveryStorage extends ResumeStorage {
  public acquireCalls = 0;

  public override async preflight(): Promise<void> {}

  public override async acquire(
    request: WorkspaceAcquireRequest,
    workspacePath: string,
  ): Promise<WorkspaceAcquireReceipt> {
    this.acquireCalls += 1;
    return {
      schemaVersion: 1,
      requestId: request.requestId,
      provider: "vhdx-differencing",
      lease: {
        leaseId: "lease-recovered",
        runId: request.consumerId,
        parentKey: request.parentKey.digest,
        mountPath: path.join(workspacePath, "Library"),
        state: "ready",
        retained: false,
      },
    };
  }
}

class AcquireRecoveryBootstrap extends ResumeBootstrap {
  public cleanupCalls = 0;

  public override async prepare(
    _sourceProjectPath: string,
    workspaceRoot: string,
    workspaceId: string,
  ): Promise<string> {
    return path.join(workspaceRoot, workspaceId);
  }

  public override async cleanupUnacquired(): Promise<void> {
    this.cleanupCalls += 1;
  }
}

class FailOnceAcquireReceiptStore implements ArtifactStore {
  #failed = false;

  public constructor(private readonly delegate: ArtifactStore) {}

  public put(request: Parameters<ArtifactStore["put"]>[0]): ReturnType<ArtifactStore["put"]> {
    if (!this.#failed && request.kind === "workspace-acquire-receipt") {
      this.#failed = true;
      return Promise.reject(
        new HoneyBeeCoreError("artifact.write-failed", "Injected receipt persistence failure."),
      );
    }
    return this.delegate.put(request);
  }

  public get(request: Parameters<ArtifactStore["get"]>[0]): ReturnType<ArtifactStore["get"]> {
    return this.delegate.get(request);
  }

  public putBytes(
    request: Parameters<ArtifactStore["putBytes"]>[0],
  ): ReturnType<ArtifactStore["putBytes"]> {
    return this.delegate.putBytes(request);
  }

  public getBytes(
    request: Parameters<ArtifactStore["getBytes"]>[0],
  ): ReturnType<ArtifactStore["getBytes"]> {
    return this.delegate.getBytes(request);
  }
}

const resumeConfig = (root: string) => {
  const hex = (value: string) => value.repeat(64);
  return UnityWorkConfigV1Schema.parse({
    schemaVersion: 1,
    sourceProjectPath: path.join(root, "source"),
    workspaceStorage: {
      command: { command: process.execPath },
      contractCommit: "575c3b37896cd3dfa37a4705477837cc52ec6132",
      binarySha256: hex("0"),
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
    agent: { command: { command: "must-not-run" }, harness: "stdio-framed-v2" },
    testplay: {
      command: { command: "must-not-run" },
      unityPath: path.join(root, "Unity.exe"),
      platform: "edit_mode",
      timeoutMs: 1,
    },
  });
};

const seedAcquiredRun = async (
  root: string,
  started: "agent" | "testplay" | undefined,
  options: Readonly<{
    deferred?: boolean;
    registered?: boolean;
    exited?: boolean;
    linkage?: Readonly<{
      parentRunId: ReturnType<typeof RunIdSchema.parse>;
      workId: ReturnType<typeof StepIdSchema.parse>;
      resourceId: ReturnType<typeof ResourceIdSchema.parse>;
      resourceScope: "global-file-v1";
    }>;
  }> = {},
) => {
  const runRoot = path.join(root, "runs");
  const runId = RunIdSchema.parse(randomUUID());
  const config = resumeConfig(root);
  await Promise.all([
    new FileRunRepository(runRoot).create(runId),
    mkdir(config.workspaceStorage.workspaceRoot, { recursive: true }),
  ]);
  const artifacts = new FileArtifactStore(runRoot);
  const put = (kind: Parameters<FileArtifactStore["put"]>[0]["kind"], content: string) =>
    artifacts.put({
      runId,
      artifactId: ArtifactIdSchema.parse(randomUUID()),
      kind,
      mediaType: "application/json",
      content,
    });
  const [configArtifact, taskArtifact, sourceArtifact, requestArtifact, receiptArtifact] =
    await Promise.all([
      put("workflow-config", JSON.stringify(config)),
      put("task", "task"),
      put("unity-source-manifest", JSON.stringify(resumeManifest)),
      put("workspace-acquire-request", "{}"),
      put("workspace-acquire-receipt", "{}"),
    ]);
  const journal = new FileOrchestrationJournal(runRoot);
  let sequence = 0;
  const append = async (type: string, payload: unknown, stepId?: string) => {
    const value = {
      schemaVersion: options.linkage === undefined ? 3 : 4,
      eventId: EventIdSchema.parse(randomUUID()),
      runId,
      sequence: ++sequence,
      timestamp: new Date(0).toISOString(),
      type,
      ...(stepId === undefined ? {} : { stepId }),
      payload,
    };
    const event =
      options.linkage === undefined
        ? OrchestrationEventV3Schema.parse(value)
        : OrchestrationEventV4Schema.parse(value);
    await journal.append(runId, event);
    return event;
  };
  await append(
    "workflow.started",
    options.linkage === undefined
      ? {
          mode: "unity-work-v1",
          config: configArtifact,
          task: taskArtifact,
        }
      : {
          mode: "unity-work-v2",
          config: configArtifact,
          task: taskArtifact,
          linkage: options.linkage,
        },
  );
  await append("source.baselined", { manifest: sourceArtifact });
  await append("workspace.prepared", {
    workspaceId: "hb-" + runId,
    sourceManifest: sourceArtifact,
  });
  await append("workspace.acquire-started", { request: requestArtifact, requestId: "acquire" });
  await append("workspace.acquired", {
    workspaceId: "hb-" + runId,
    leaseId: "lease-1",
    receipt: receiptArtifact,
  });
  if (started !== undefined) {
    const agentStarted = await append(
      "agent.started",
      {
        pid: 4242,
        processIdentity: "test:agent",
        ...(options.deferred === true ? { containment: "deferred-v1" } : {}),
      },
      "unity-agent",
    );
    if (
      options.deferred === true &&
      (started === "testplay" || options.registered === true || options.exited === true)
    ) {
      await append(
        "process.containment-registered",
        { process: "agent", startedEventId: agentStarted.eventId },
        "unity-agent",
      );
    }
  }
  if (started === "testplay") {
    await append(
      "agent.exited",
      {
        pid: 4242,
        exitCode: 0,
        signal: null,
        durationMs: 1,
        stdoutBytes: 0,
        stderrBytes: 0,
      },
      "unity-agent",
    );
    const testplayStarted = await append("testplay.started", {
      pid: 4343,
      processIdentity: "test:testplay",
      ...(options.deferred === true ? { containment: "deferred-v1" } : {}),
    });
    if (options.deferred === true && (options.registered === true || options.exited === true)) {
      await append("process.containment-registered", {
        process: "testplay",
        startedEventId: testplayStarted.eventId,
      });
    }
  }
  if (options.exited === true && started !== undefined) {
    const processType = started === "agent" ? "agent" : "testplay";
    await append(
      processType + ".exited",
      {
        pid: processType === "agent" ? 4242 : 4343,
        exitCode: 0,
        signal: null,
        durationMs: 1,
        stdoutBytes: 0,
        stderrBytes: 0,
      },
      processType === "agent" ? "unity-agent" : undefined,
    );
  }
  return {
    runRoot,
    runId,
    config,
    artifacts,
    journal,
    sourceArtifact,
    append,
  };
};

describe("UnityWorkTransaction cleanup resume", () => {
  it.each([
    ["queued", false, false, "cancelled", "resource.acquire-cancelled"],
    ["active-before-child-marker", true, false, "released", "resource.acquire-cancelled"],
    ["active-after-child-marker", true, true, "released", "resource.released"],
  ] as const)(
    "recovers a durable global resource request after %s crash window",
    async (_stage, acquireGlobally, recordChildAcquire, expectedGlobal, expectedChildEvent) => {
      const root = await mkdtemp(path.join(tmpdir(), "honeybee-unity-global-recovery-"));
      directories.push(root);
      const parentRunId = RunIdSchema.parse(randomUUID());
      const workId = StepIdSchema.parse("work-a");
      const resourceId = ResourceIdSchema.parse("unity-editor");
      const seeded = await seedAcquiredRun(root, "agent", {
        exited: true,
        linkage: {
          parentRunId,
          workId,
          resourceId,
          resourceScope: "global-file-v1",
        },
      });
      const coordinator = new FileUnityResourceCoordinator(seeded.runRoot);
      const requestId = EventIdSchema.parse(randomUUID());
      await seeded.append("resource.acquire-started", { resourceId, requestId });
      const ticket = await coordinator.enqueue({
        resourceId,
        requestId,
        ownerRunId: seeded.runId,
      });
      await seeded.append("resource.queued", {
        resourceId,
        requestId,
        ticket: ticket.ticket,
      });
      const locator = { resourceId, requestId };
      const lease = acquireGlobally ? await coordinator.acquire(locator) : undefined;
      if (recordChildAcquire && lease !== undefined) {
        await seeded.append("resource.acquired", {
          resourceId,
          requestId,
          ticket: lease.ticket,
          leaseId: lease.leaseId,
        });
      }
      const storage = new ResumeStorage();
      const bootstrap = new ResumeBootstrap();
      const execution: UnityWorkV4Execution = {
        parentRunId,
        workId,
        resourceId,
        resourceScope: "global-file-v1",
        resources: coordinator,
        patchBuilder: new UnityPatchBuilder(
          seeded.artifacts,
          bootstrap,
          path.join(root, "scratch"),
        ),
      };
      const transaction = new UnityWorkTransaction(
        new CompletedRunner(),
        seeded.artifacts,
        seeded.journal,
        new FileRunControl(seeded.runRoot),
        bootstrap,
        storage,
        new TestPlayCliAdapter(seeded.config.testplay),
      );

      const result = await transaction.resume(seeded.runId, seeded.config, execution);

      expect(result.status).toBe("failed");
      expect(result.failure?.errorCode).toBe("transaction.interrupted");
      expect(storage.released).toBe(true);
      expect((await coordinator.status(locator)).state).toBe(expectedGlobal);
      const replay = await seeded.journal.replay(seeded.runId);
      expect(replay.status).toBe("terminal");
      if (replay.status === "terminal") {
        const types = replay.events.map((event) => event.type);
        expect(types).toContain(expectedChildEvent);
        expect(types.indexOf(expectedChildEvent)).toBeLessThan(
          types.indexOf("workspace.release-started"),
        );
      }
    },
  );

  it("keeps cleanup pending when a child queue marker has no global resource history", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "honeybee-unity-global-missing-"));
    directories.push(root);
    const parentRunId = RunIdSchema.parse(randomUUID());
    const workId = StepIdSchema.parse("work-a");
    const resourceId = ResourceIdSchema.parse("unity-editor");
    const seeded = await seedAcquiredRun(root, "agent", {
      exited: true,
      linkage: {
        parentRunId,
        workId,
        resourceId,
        resourceScope: "global-file-v1",
      },
    });
    const requestId = EventIdSchema.parse(randomUUID());
    await seeded.append("resource.acquire-started", { resourceId, requestId });
    await seeded.append("resource.queued", { resourceId, requestId, ticket: 1 });
    const resources = new FileUnityResourceCoordinator(seeded.runRoot);
    const storage = new ResumeStorage();
    const bootstrap = new ResumeBootstrap();
    const execution: UnityWorkV4Execution = {
      parentRunId,
      workId,
      resourceId,
      resourceScope: "global-file-v1",
      resources,
      patchBuilder: new UnityPatchBuilder(seeded.artifacts, bootstrap, path.join(root, "scratch")),
    };
    const transaction = new UnityWorkTransaction(
      new CompletedRunner(),
      seeded.artifacts,
      seeded.journal,
      new FileRunControl(seeded.runRoot),
      bootstrap,
      storage,
      new TestPlayCliAdapter(seeded.config.testplay),
    );

    const result = await transaction.resume(seeded.runId, seeded.config, execution);

    expect(result.status).toBe("cleanup-pending");
    expect(result.failure?.errorCode).toBe("resource.release-failed");
    expect(storage.released).toBe(false);
    expect((await seeded.journal.replay(seeded.runId)).status).toBe("active");
  });

  it("recovers a returned lease when receipt persistence fails after acquire", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "honeybee-unity-acquire-persistence-"));
    directories.push(root);
    const runRoot = path.join(root, "runs");
    const config = resumeConfig(root);
    const runId = RunIdSchema.parse(randomUUID());
    await Promise.all([
      new FileRunRepository(runRoot).create(runId),
      mkdir(config.workspaceStorage.workspaceRoot, { recursive: true }),
    ]);
    const journal = new FileOrchestrationJournal(runRoot);
    const artifacts = new FailOnceAcquireReceiptStore(new FileArtifactStore(runRoot));
    const storage = new AcquireRecoveryStorage();
    const bootstrap = new AcquireRecoveryBootstrap();
    const runner = new CompletedRunner();
    const transaction = new UnityWorkTransaction(
      runner,
      artifacts,
      journal,
      new FileRunControl(runRoot),
      bootstrap,
      storage,
      new TestPlayCliAdapter(config.testplay),
    );

    const first = await transaction.run(runId, "persist acquire safely", config);

    expect(first.status).toBe("cleanup-pending");
    expect(first.failure?.errorCode).toBe("artifact.write-failed");
    expect(storage.acquireCalls).toBe(1);
    expect(storage.released).toBe(false);
    expect(bootstrap.cleanupCalls).toBe(0);
    const active = await journal.replay(runId);
    expect(active.status).toBe("active");
    if (active.status === "active") {
      expect(active.events.some((event) => event.type === "workspace.acquire-failed")).toBe(false);
      expect(active.events.some((event) => event.type === "workspace.acquired")).toBe(false);
    }

    const resumed = await transaction.resume(runId, config);

    expect(resumed.status).toBe("failed");
    expect(resumed.failure?.errorCode).toBe("transaction.interrupted");
    expect(storage.acquireCalls).toBe(2);
    expect(storage.released).toBe(true);
    expect(bootstrap.cleanupCalls).toBe(0);
    expect(runner.calls).toBe(0);
    expect((await journal.replay(runId)).status).toBe("terminal");
  });

  it.each(["agent", "testplay"] as const)(
    "drains an unmatched %s process before workspace release",
    async (started) => {
      const root = await mkdtemp(path.join(tmpdir(), "honeybee-unity-child-drain-"));
      directories.push(root);
      const seeded = await seedAcquiredRun(root, started);
      const storage = new ResumeStorage();
      const drained: Array<{ pid: number; identity?: string }> = [];
      const processControl: UnityProcessControl = {
        captureIdentity: async () => "unused",
        drain: async (pid, identity) => {
          storage.order.push("drain");
          drained.push({ pid, ...(identity === undefined ? {} : { identity }) });
          return "drained";
        },
      };
      const transaction = new UnityWorkTransaction(
        new CompletedRunner(),
        seeded.artifacts,
        seeded.journal,
        new FileRunControl(seeded.runRoot),
        new ResumeBootstrap(),
        storage,
        new TestPlayCliAdapter(seeded.config.testplay),
        { processControl },
      );

      const result = await transaction.resume(seeded.runId, seeded.config);

      expect(result.status).toBe("failed");
      expect(storage.order).toEqual(["drain", "release"]);
      expect(drained).toEqual([
        started === "agent"
          ? { pid: 4242, identity: "test:agent" }
          : { pid: 4343, identity: "test:testplay" },
      ]);
    },
  );

  it("treats a missing unregistered deferred launcher as safely unactivated", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "honeybee-unity-unregistered-launcher-"));
    directories.push(root);
    const seeded = await seedAcquiredRun(root, "agent", { deferred: true });
    const storage = new ResumeStorage();
    const calls: Array<{ pid: number; identity?: string; missingPolicy?: string }> = [];
    const processControl: UnityProcessControl = {
      captureIdentity: async () => "unused",
      drain: async (pid, identity, missingPolicy) => {
        storage.order.push("drain");
        calls.push({
          pid,
          ...(identity === undefined ? {} : { identity }),
          ...(missingPolicy === undefined ? {} : { missingPolicy }),
        });
        return "missing";
      },
    };
    const result = await new UnityWorkTransaction(
      new CompletedRunner(),
      seeded.artifacts,
      seeded.journal,
      new FileRunControl(seeded.runRoot),
      new ResumeBootstrap(),
      storage,
      new TestPlayCliAdapter(seeded.config.testplay),
      { processControl },
    ).resume(seeded.runId, seeded.config);

    expect(result.status).toBe("failed");
    expect(storage.order).toEqual(["drain", "release"]);
    expect(calls).toEqual([{ pid: 4242, identity: "test:agent", missingPolicy: "safe" }]);
    const replay = await seeded.journal.replay(seeded.runId);
    expect(replay.status).toBe("terminal");
    if (replay.status === "terminal") {
      expect(
        replay.events.filter((event) => event.type === "process.drain-completed"),
      ).toHaveLength(1);
    }
  });

  it("persists a post-exit deferred drain across release retries", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "honeybee-unity-exited-launcher-"));
    directories.push(root);
    const seeded = await seedAcquiredRun(root, "agent", {
      deferred: true,
      exited: true,
    });
    const storage = new FailFirstResumeStorage();
    let drainCalls = 0;
    const processControl: UnityProcessControl = {
      captureIdentity: async () => "unused",
      drain: async (_pid, _identity, missingPolicy) => {
        drainCalls += 1;
        expect(missingPolicy).toBe("safe");
        storage.order.push("drain");
        return "drained";
      },
    };
    const transaction = new UnityWorkTransaction(
      new CompletedRunner(),
      seeded.artifacts,
      seeded.journal,
      new FileRunControl(seeded.runRoot),
      new ResumeBootstrap(),
      storage,
      new TestPlayCliAdapter(seeded.config.testplay),
      { processControl },
    );
    const first = await transaction.resume(seeded.runId, seeded.config);

    expect(first.status).toBe("cleanup-pending");
    expect(drainCalls).toBe(1);
    expect(storage.order).toEqual(["drain"]);
    const active = await seeded.journal.replay(seeded.runId);
    expect(active.status).toBe("active");
    if (active.status === "active") {
      expect(
        active.events.filter((event) => event.type === "process.drain-completed"),
      ).toHaveLength(1);
    }

    const second = await transaction.resume(seeded.runId, seeded.config);

    expect(second.status).toBe("failed");
    expect(drainCalls).toBe(1);
    expect(storage.order).toEqual(["drain", "release"]);
    expect((await seeded.journal.replay(seeded.runId)).status).toBe("terminal");
  });

  it("fails closed if a registered deferred launcher disappears before cleanup", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "honeybee-unity-registered-missing-"));
    directories.push(root);
    const seeded = await seedAcquiredRun(root, "agent", {
      deferred: true,
      registered: true,
    });
    const storage = new ResumeStorage();
    const processControl: UnityProcessControl = {
      captureIdentity: async () => "unused",
      drain: async (_pid, _identity, missingPolicy) => {
        expect(missingPolicy).toBe("unsafe");
        throw new HoneyBeeCoreError(
          "process.drain-failed",
          "A registered containment process cannot be proven drained.",
        );
      },
    };
    const result = await new UnityWorkTransaction(
      new CompletedRunner(),
      seeded.artifacts,
      seeded.journal,
      new FileRunControl(seeded.runRoot),
      new ResumeBootstrap(),
      storage,
      new TestPlayCliAdapter(seeded.config.testplay),
      { processControl },
    ).resume(seeded.runId, seeded.config);

    expect(result.status).toBe("cleanup-pending");
    expect(result.failure?.errorCode).toBe("process.drain-failed");
    expect(storage.released).toBe(false);
  });

  it("keeps cleanup pending when an interrupted process tree cannot be proven drained", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "honeybee-unity-child-unknown-"));
    directories.push(root);
    const seeded = await seedAcquiredRun(root, "testplay");
    const storage = new ResumeStorage();
    const processControl: UnityProcessControl = {
      captureIdentity: async () => "unused",
      drain: async () => {
        throw new HoneyBeeCoreError(
          "process.drain-failed",
          "Recorded parent is gone; descendants are unknown.",
        );
      },
    };
    const transaction = new UnityWorkTransaction(
      new CompletedRunner(),
      seeded.artifacts,
      seeded.journal,
      new FileRunControl(seeded.runRoot),
      new ResumeBootstrap(),
      storage,
      new TestPlayCliAdapter(seeded.config.testplay),
      { processControl },
    );

    const result = await transaction.resume(seeded.runId, seeded.config);

    expect(result.status).toBe("cleanup-pending");
    expect(result.failure?.errorCode).toBe("process.drain-failed");
    expect(storage.released).toBe(false);
    expect((await seeded.journal.replay(seeded.runId)).status).toBe("active");
  });

  it("persists a successful interrupted-process drain across release retries", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "honeybee-unity-drain-retry-"));
    directories.push(root);
    const seeded = await seedAcquiredRun(root, "agent");
    const storage = new FailFirstResumeStorage();
    let drainCalls = 0;
    const processControl: UnityProcessControl = {
      captureIdentity: async () => "unused",
      drain: async () => {
        drainCalls += 1;
        return "drained";
      },
    };
    const transaction = new UnityWorkTransaction(
      new CompletedRunner(),
      seeded.artifacts,
      seeded.journal,
      new FileRunControl(seeded.runRoot),
      new ResumeBootstrap(),
      storage,
      new TestPlayCliAdapter(seeded.config.testplay),
      { processControl },
    );

    const first = await transaction.resume(seeded.runId, seeded.config);
    expect(first.status).toBe("cleanup-pending");
    expect(drainCalls).toBe(1);
    const active = await seeded.journal.replay(seeded.runId);
    expect(active.status).toBe("active");
    if (active.status === "active") {
      expect(
        active.events.filter((event) => event.type === "process.drain-completed"),
      ).toHaveLength(1);
    }

    const second = await transaction.resume(seeded.runId, seeded.config);

    expect(second.status).toBe("failed");
    expect(second.failure?.errorCode).toBe("transaction.interrupted");
    expect(drainCalls).toBe(1);
    expect(storage.attempts).toBe(2);
    expect(storage.released).toBe(true);
    expect((await seeded.journal.replay(seeded.runId)).status).toBe("terminal");
  });

  it("continues release when the original source cannot be checked during resume", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "honeybee-unity-source-missing-"));
    directories.push(root);
    const seeded = await seedAcquiredRun(root, undefined);
    const storage = new ResumeStorage();
    const transaction = new UnityWorkTransaction(
      new CompletedRunner(),
      seeded.artifacts,
      seeded.journal,
      new FileRunControl(seeded.runRoot),
      new ResumeBootstrap(true),
      storage,
      new TestPlayCliAdapter(seeded.config.testplay),
    );

    const result = await transaction.resume(seeded.runId, seeded.config);

    expect(result.status).toBe("failed");
    expect(result.failure?.errorCode).toBe("source.check-failed");
    expect(storage.released).toBe(true);
    const replay = await seeded.journal.replay(seeded.runId);
    expect(replay.status).toBe("terminal");
    if (replay.status === "terminal") {
      expect(replay.events.some((event) => event.type === "workspace.released")).toBe(true);
      expect(replay.terminal.type).toBe("workflow.failed");
    }
  });

  it("reuses a durable source.checked result instead of appending it twice", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "honeybee-unity-source-checked-"));
    directories.push(root);
    const seeded = await seedAcquiredRun(root, undefined);
    await seeded.append("source.checked", {
      before: seeded.sourceArtifact,
      after: seeded.sourceArtifact,
      unchanged: true,
    });
    const storage = new ResumeStorage();
    const transaction = new UnityWorkTransaction(
      new CompletedRunner(),
      seeded.artifacts,
      seeded.journal,
      new FileRunControl(seeded.runRoot),
      new ResumeBootstrap(true),
      storage,
      new TestPlayCliAdapter(seeded.config.testplay),
    );

    const result = await transaction.resume(seeded.runId, seeded.config);

    expect(result.status).toBe("failed");
    expect(result.failure?.errorCode).toBe("transaction.interrupted");
    expect(storage.released).toBe(true);
    const replay = await seeded.journal.replay(seeded.runId);
    expect(replay.status).toBe("terminal");
    if (replay.status === "terminal") {
      expect(replay.events.filter((event) => event.type === "source.checked")).toHaveLength(1);
      expect(replay.terminal.type).toBe("workflow.failed");
    }
  });

  it("records oversized recovered Evidence as failed and still releases", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "honeybee-unity-evidence-limit-"));
    directories.push(root);
    const seeded = await seedAcquiredRun(root, "testplay");
    await seeded.append("testplay.exited", {
      pid: 4343,
      exitCode: 0,
      signal: null,
      durationMs: 1,
      stdoutBytes: 0,
      stderrBytes: 0,
    });
    const evidenceRoot = path.join(
      seeded.config.workspaceStorage.workspaceRoot,
      "hb-" + seeded.runId,
      ".testplay",
      "runs",
      "run",
    );
    await mkdir(evidenceRoot, { recursive: true });
    const evidencePath = path.join(evidenceRoot, "stdout.log");
    await writeFile(evidencePath, "");
    await truncate(evidencePath, 16 * 1024 * 1024 + 1);
    const storage = new ResumeStorage();
    const transaction = new UnityWorkTransaction(
      new CompletedRunner(),
      seeded.artifacts,
      seeded.journal,
      new FileRunControl(seeded.runRoot),
      new ResumeBootstrap(),
      storage,
      new TestPlayCliAdapter(seeded.config.testplay),
    );

    const result = await transaction.resume(seeded.runId, seeded.config);

    expect(result.status).toBe("failed");
    expect(result.failure?.errorCode).toBe("testplay.failed");
    expect(storage.released).toBe(true);
    const replay = await seeded.journal.replay(seeded.runId);
    expect(replay.status).toBe("terminal");
    if (replay.status === "terminal") {
      expect(replay.terminal.type).toBe("workflow.failed");
      expect(replay.events.some((event) => event.type === "workspace.released")).toBe(true);
    }
  });

  it("removes a partial shell left by a crash before workspace.prepared", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "honeybee-unity-prepare-crash-"));
    directories.push(root);
    const workspaceRoot = path.join(root, "workspaces");
    const runRoot = path.join(root, "runs");
    await mkdir(workspaceRoot, { recursive: true });
    const storageBinarySha256 = createHash("sha256")
      .update(await readFile(process.execPath))
      .digest("hex");
    const hex = (value: string) => value.repeat(64);
    const config = UnityWorkConfigV1Schema.parse({
      schemaVersion: 1,
      sourceProjectPath: path.join(root, "source"),
      workspaceStorage: {
        command: { command: process.execPath },
        contractCommit: "575c3b37896cd3dfa37a4705477837cc52ec6132",
        binarySha256: storageBinarySha256,
        workspaceRoot,
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
        command: { command: "must-not-run" },
        harness: "stdio-framed-v2",
      },
      testplay: {
        command: { command: "must-not-run" },
        unityPath: path.join(root, "Unity.exe"),
        platform: "edit_mode",
        timeoutMs: 1,
      },
    });
    const runId = RunIdSchema.parse(randomUUID());
    await new FileRunRepository(runRoot).create(runId);
    const artifacts = new FileArtifactStore(runRoot);
    const configArtifact = await artifacts.put({
      runId,
      artifactId: ArtifactIdSchema.parse(randomUUID()),
      kind: "workflow-config",
      mediaType: "application/json",
      content: JSON.stringify(config),
    });
    const taskArtifact = await artifacts.put({
      runId,
      artifactId: ArtifactIdSchema.parse(randomUUID()),
      kind: "task",
      mediaType: "text/plain; charset=utf-8",
      content: "task",
    });
    const sourceArtifact = await artifacts.put({
      runId,
      artifactId: ArtifactIdSchema.parse(randomUUID()),
      kind: "unity-source-manifest",
      mediaType: "application/json",
      content: "{}",
    });
    const journal = new FileOrchestrationJournal(runRoot);
    const append = async (
      sequence: number,
      type: "workflow.started" | "artifact.stored" | "source.baselined",
      payload: unknown,
    ): Promise<void> => {
      await journal.append(
        runId,
        OrchestrationEventV3Schema.parse({
          schemaVersion: 3,
          eventId: EventIdSchema.parse(randomUUID()),
          runId,
          sequence,
          timestamp: new Date(0).toISOString(),
          type,
          payload,
        }),
      );
    };
    await append(1, "workflow.started", {
      mode: "unity-work-v1",
      config: configArtifact,
      task: taskArtifact,
    });
    await append(2, "artifact.stored", { artifact: configArtifact });
    await append(3, "artifact.stored", { artifact: taskArtifact });
    await append(4, "artifact.stored", { artifact: sourceArtifact });
    await append(5, "source.baselined", { manifest: sourceArtifact });

    const workspacePath = path.join(workspaceRoot, "hb-" + runId);
    await mkdir(path.join(workspacePath, "Assets"), { recursive: true });
    await writeFile(path.join(workspacePath, "Assets", "partial.txt"), "partial", "utf8");
    const runner = new CompletedRunner();
    const transaction = new UnityWorkTransaction(
      runner,
      artifacts,
      journal,
      new FileRunControl(runRoot),
      new UnityProjectBootstrap(),
      new UnityWorkspaceStorageCliAdapter(
        config.workspaceStorage.command,
        config.workspaceStorage.parentKey.provider,
        config.workspaceStorage.binarySha256,
      ),
      new TestPlayCliAdapter(config.testplay),
    );

    const result = await transaction.resume(runId, config);

    expect(result.status).toBe("failed");
    expect(result.failure?.errorCode).toBe("transaction.interrupted");
    expect(runner.calls).toBe(0);
    await expect(access(workspacePath)).rejects.toBeDefined();
    const replay = await journal.replay(runId);
    expect(replay.status).toBe("terminal");
    if (replay.status === "terminal") {
      expect(replay.terminal.type).toBe("workflow.failed");
    }
  });

  it("retries only release after a durable release failure", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "honeybee-unity-resume-"));
    directories.push(root);
    const source = path.join(root, "source");
    const workspaceRoot = path.join(root, "workspaces");
    const runRoot = path.join(root, "runs");
    await Promise.all([
      mkdir(path.join(source, "Assets"), { recursive: true }),
      mkdir(path.join(source, "Packages"), { recursive: true }),
      mkdir(path.join(source, "ProjectSettings"), { recursive: true }),
      mkdir(workspaceRoot, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(path.join(source, "Assets", "Game.cs"), "class Game {}\n", "utf8"),
      writeFile(path.join(source, "Packages", "manifest.json"), "{}\n", "utf8"),
      writeFile(
        path.join(source, "ProjectSettings", "ProjectVersion.txt"),
        "m_EditorVersion: 6000.0.0f1\n",
        "utf8",
      ),
      writeFile(path.join(workspaceRoot, "fail-release-once"), "1", "utf8"),
    ]);
    const storageScript = path.join(root, "storage.mjs");
    await writeFile(
      storageScript,
      [
        "import fs from 'node:fs';",
        "import path from 'node:path';",
        "const args = process.argv.slice(2);",
        "const op = args[1];",
        "const root = process.cwd();",
        "if (op === 'acquire') {",
        " let input = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', c => input += c);",
        " process.stdin.on('end', () => { const r = JSON.parse(input); const id = 'lease-' + r.workspaceId; fs.mkdirSync(path.join(root, 'Library')); fs.writeFileSync(path.join(path.dirname(root), id + '.json'), JSON.stringify({ workspace: root })); process.stdout.write(JSON.stringify({ schemaVersion: 1, requestId: r.requestId, provider: r.parentKey.provider, lease: { leaseId: id, runId: r.consumerId, parentKey: r.parentKey.digest, mountPath: path.join(root, 'Library'), state: 'ready', createdAt: new Date().toISOString(), retained: false } }) + '\\n'); });",
        "} else if (op === 'release') {",
        " const id = args[args.indexOf('--lease-id') + 1]; const requestId = args[args.indexOf('--request-id') + 1]; const fail = path.join(root, 'fail-release-once');",
        " if (fs.existsSync(fail)) { fs.rmSync(fail); process.stdout.write(JSON.stringify({ schemaVersion: 1, ok: false, operation: 'release', error: { code: 'workspace-command-failed', message: 'injected' } }) + '\\n'); process.exitCode = 1; }",
        " else { const map = path.join(root, id + '.json'); const data = JSON.parse(fs.readFileSync(map, 'utf8')); fs.rmSync(data.workspace, { recursive: true, force: true }); fs.rmSync(map); process.stdout.write(JSON.stringify({ schemaVersion: 1, requestId, provider: 'vhdx-differencing', metrics: { cleanupState: 'released' } }) + '\\n'); }",
        "}",
      ].join("\n"),
      "utf8",
    );
    const executeStorage = storageExecutor(storageScript);
    const testplayScript = path.join(root, "testplay.mjs");
    await writeFile(
      testplayScript,
      [
        "import fs from 'node:fs'; import path from 'node:path';",
        "const a = process.argv.slice(2); const c = JSON.parse(fs.readFileSync(a[a.indexOf('--config') + 1], 'utf8'));",
        "const count = path.join(path.dirname(c.project_path), 'testplay-count'); const n = fs.existsSync(count) ? Number(fs.readFileSync(count, 'utf8')) : 0; fs.writeFileSync(count, String(n + 1));",
        "const id = 'run'; const r = path.join(c.project_path, '.testplay', 'runs', id); fs.mkdirSync(r, { recursive: true });",
        "const f = { 'results.xml': '<ok />', 'summary.json': '{}', 'manifest.json': '{}', 'stdout.log': '', 'stderr.log': '', 'events.ndjson': '{}\\n' }; for (const [n, v] of Object.entries(f)) fs.writeFileSync(path.join(r, n), v);",
        "process.stdout.write(JSON.stringify({ schema_version: '1', run_id: id, total: 1 }) + '\\n');",
      ].join("\n"),
      "utf8",
    );
    const hex = (value: string) => value.repeat(64);
    const storageBinarySha256 = createHash("sha256")
      .update(await readFile(process.execPath))
      .digest("hex");
    const config = UnityWorkConfigV1Schema.parse({
      schemaVersion: 1,
      sourceProjectPath: source,
      workspaceStorage: {
        command: { command: process.execPath },
        contractCommit: "575c3b37896cd3dfa37a4705477837cc52ec6132",
        binarySha256: storageBinarySha256,
        workspaceRoot,
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
        command: { command: "in-memory" },
        harness: "stdio-framed-v2",
      },
      testplay: {
        command: { command: process.execPath, args: [testplayScript] },
        unityPath: path.join(root, "Unity.exe"),
        platform: "edit_mode",
        timeoutMs: 10_000,
      },
    });
    const runId = RunIdSchema.parse(randomUUID());
    await new FileRunRepository(runRoot).create(runId);
    const controls = new FileRunControl(runRoot);
    const journal = new FileOrchestrationJournal(runRoot);
    const runner = new CompletedRunner();
    const transaction = new UnityWorkTransaction(
      runner,
      new FileArtifactStore(runRoot),
      journal,
      controls,
      new UnityProjectBootstrap(),
      new UnityWorkspaceStorageCliAdapter(
        config.workspaceStorage.command,
        config.workspaceStorage.parentKey.provider,
        config.workspaceStorage.binarySha256,
        executeStorage,
      ),
      new TestPlayCliAdapter(config.testplay),
    );
    const first = await transaction.run(runId, "change Unity", config);
    expect(first.status).toBe("cleanup-pending");
    expect(runner.calls).toBe(1);
    expect((await journal.replay(runId)).status).toBe("active");

    const resumed = await transaction.resume(runId, config);
    expect(resumed.failure).toBeUndefined();
    expect(resumed).toMatchObject({ status: "completed" });
    expect(resumed.evidence?.kind).toBe("testplay-evidence");
    expect(runner.calls).toBe(1);
    expect(await readFile(path.join(workspaceRoot, "testplay-count"), "utf8")).toBe("1");
    await expect(access(path.join(workspaceRoot, "hb-" + runId))).rejects.toBeDefined();
    const replay = await journal.replay(runId);
    expect(replay.status).toBe("terminal");
    if (replay.status === "terminal") {
      expect(replay.events.filter((event) => event.type === "agent.started")).toHaveLength(1);
      expect(replay.events.at(-1)?.type).toBe("workflow.completed");
    }
  }, 30_000);
});
