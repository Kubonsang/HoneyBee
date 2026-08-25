import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  ContentDigestSchema,
  EditorContainmentReceiptV1Schema,
  EventIdSchema,
  FileArtifactStore,
  FileOrchestrationJournal,
  FileRunControl,
  FileRunRepository,
  HoneyBeeCoreError,
  RunIdSchema,
  StepIdSchema,
  UnityEditorObservationV1Schema,
  UnityPatchManifestV3Schema,
  UnityWorkConfigV2Schema,
  WarmBridgeBindingV1Schema,
  type AgentProcessResult,
  type AgentProcessRunner,
  type EditorContainmentReceiptV1,
  type EditorLaunchIntentV1,
  type UnityEditorObservationV1,
  type VersionedOrchestrationJournal,
  type WarmBridgeBindingV1,
} from "@honeybee/core";
import { afterEach, describe, expect, it } from "vitest";

import {
  UnityProjectBootstrap,
  UnityWorkspaceStorageCliAdapter,
  type UnityCapabilityRunResult,
  type WorkspaceAcquireReceipt,
  type WorkspaceAcquireRequest,
  type WorkspaceReleaseReceipt,
} from "./unity-adapters.js";
import type { WarmBridgeBindingResolver } from "./unity-bridge-binding.js";
import type {
  UnityEditorLaunchCandidate,
  UnityEditorLaunchHandle,
  UnityEditorLauncher,
} from "./unity-editor-launcher.js";
import { FileUnityEditorPoolCoordinator } from "./unity-editor-pool.js";
import type { UnityEditorRegistry } from "./unity-editor-registry.js";
import {
  UnityEditorWorkTransaction,
  type UnityCapabilityRunner,
} from "./unity-editor-transaction.js";
import type { UnityProcessControl } from "./process-control.js";
import { UnityPatchBuilder } from "./unity-patch.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const temporaryRoot = async (): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), "honeybee-editor-work-"));
  roots.push(root);
  return root;
};

const digest = (content: string) =>
  ContentDigestSchema.parse("sha256:" + createHash("sha256").update(content).digest("hex"));

class CompletedAgent implements AgentProcessRunner {
  public async run(
    request: Parameters<AgentProcessRunner["run"]>[0],
    lifecycle: Parameters<AgentProcessRunner["run"]>[1],
  ): Promise<AgentProcessResult> {
    const pid = 1101;
    await lifecycle.onStarted(pid, { containment: "deferred-v1" });
    await lifecycle.onRegistered?.(pid);
    await writeFile(
      path.join(request.command.cwd as string, "Assets", "agent-created.txt"),
      "workspace only\n",
      "utf8",
    );
    const match = /HONEYBEE_INPUT_BEGIN\r?\n([\s\S]*?)\r?\nHONEYBEE_INPUT_END/u.exec(
      request.prompt,
    );
    if (match?.[1] === undefined) throw new Error("missing Agent input envelope");
    const input = JSON.parse(match[1]) as { runId: string; step: { id: string } };
    const stdout =
      "HONEYBEE_RESPONSE_BEGIN\n" +
      JSON.stringify({
        schemaVersion: 2,
        runId: input.runId,
        stepId: input.step.id,
        status: "completed",
        outputs: {
          content: { mediaType: "text/plain; charset=utf-8", content: "agent complete" },
        },
      }) +
      "\nHONEYBEE_RESPONSE_END\n";
    const observation = {
      pid,
      exitCode: 0,
      signal: null,
      durationMs: 1,
      stdoutBytes: Buffer.byteLength(stdout),
      stderrBytes: 0,
    } as const;
    await lifecycle.onExited(observation);
    return {
      ...observation,
      stepId: request.stepId,
      command: request.command.command,
      termination: "exited",
      stdout,
      stderr: "",
    };
  }
}

class MemoryWorkspaceStorage extends UnityWorkspaceStorageCliAdapter {
  public released = 0;

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
        leaseId: "lease-" + request.workspaceId,
        runId: request.consumerId,
        parentKey: request.parentKey.digest,
        mountPath: workspacePath,
        state: "active",
        retained: false,
      },
    };
  }

  public override async release(
    leaseId: string,
    requestId: string,
    workspaceRoot: string,
  ): Promise<WorkspaceReleaseReceipt> {
    this.released += 1;
    await rm(path.join(workspaceRoot, leaseId.slice("lease-".length)), {
      recursive: true,
      force: true,
    });
    return {
      schemaVersion: 1,
      requestId,
      provider: "vhdx-differencing",
      metrics: { cleanupState: "released" },
    };
  }
}

class MemoryEditorLauncher implements UnityEditorLauncher {
  public stopped = 0;
  public command: Parameters<UnityEditorLauncher["launch"]>[1] | undefined;

  public async launch(
    intent: EditorLaunchIntentV1,
    command: Parameters<UnityEditorLauncher["launch"]>[1],
    lifecycle: Parameters<UnityEditorLauncher["launch"]>[2],
  ): Promise<UnityEditorLaunchHandle> {
    this.command = command;
    const containment = EditorContainmentReceiptV1Schema.parse({
      schemaVersion: 1,
      launchId: intent.launchId,
      nonce: intent.nonce,
      containmentPid: 2101,
      processIdentity: "test:containment:2101",
      containmentProtocol: "editor-deferred-v1",
      poolId: intent.poolId,
      slotId: intent.slotId,
      poolLeaseId: intent.poolLeaseId,
      workspaceId: intent.workspaceId,
      publishedAt: new Date(0).toISOString(),
    });
    const editor: UnityEditorLaunchCandidate = {
      pid: 2102,
      processIdentity: "test:editor:2102",
    };
    await lifecycle.onContainmentReady(containment);
    await lifecycle.onActivated();
    await lifecycle.onEditorStarted(editor);
    return {
      containment,
      editor,
      stop: async () => {
        this.stopped += 1;
      },
    };
  }

  public async recoverPublishedReceipt(
    _intent: EditorLaunchIntentV1,
  ): Promise<EditorContainmentReceiptV1 | undefined> {
    return undefined;
  }

  public async drainContainment(_receipt: EditorContainmentReceiptV1): Promise<void> {
    this.stopped += 1;
  }
}

class MemoryEditorRegistry implements UnityEditorRegistry {
  public owned: UnityEditorObservationV1 | undefined;
  public exited: string | undefined;

  public async recordOwned(observation: UnityEditorObservationV1): Promise<void> {
    this.owned = UnityEditorObservationV1Schema.parse(observation);
  }

  public async recordExited(editorId: UnityEditorObservationV1["editorId"]): Promise<void> {
    this.exited = editorId;
  }

  public async list(): Promise<readonly UnityEditorObservationV1[]> {
    return this.owned === undefined ? [] : [this.owned];
  }
}

class MemoryBridge implements WarmBridgeBindingResolver {
  public verifies = 0;

  public async bind(
    request: Parameters<WarmBridgeBindingResolver["bind"]>[0],
  ): Promise<WarmBridgeBindingV1> {
    return WarmBridgeBindingV1Schema.parse({
      schemaVersion: 1,
      editorId: request.editor.editorId,
      editorPid: request.editor.pid,
      editorProcessIdentity: request.editor.processIdentity,
      workspaceId: request.workspaceId,
      projectPath: request.workspacePath,
      bridgeSessionId: "bridge-session",
      bridgeProtocolVersion: 3,
      editorState: "idle",
      heartbeatAt: new Date().toISOString(),
      boundAt: new Date().toISOString(),
    });
  }

  public async verify(_binding: WarmBridgeBindingV1): Promise<void> {
    this.verifies += 1;
  }
}

class CompletedCapabilities implements UnityCapabilityRunner {
  public readonly order: string[] = [];

  public async runCapability(
    _runId: Parameters<UnityCapabilityRunner["runCapability"]>[0],
    capability: Parameters<UnityCapabilityRunner["runCapability"]>[1],
    _binding: Parameters<UnityCapabilityRunner["runCapability"]>[2],
    _workspacePath: string,
    _timeoutMs: number,
    _signal: AbortSignal,
    lifecycle: Parameters<UnityCapabilityRunner["runCapability"]>[6],
  ): Promise<UnityCapabilityRunResult> {
    this.order.push(capability.kind);
    const pid = 3100 + this.order.length;
    await lifecycle.onStarted(pid, { containment: "deferred-v1" });
    await lifecycle.onRegistered?.(pid);
    const command = {
      pid,
      exitCode: 0,
      signal: null,
      durationMs: 1,
      stdoutBytes: 2,
      stderrBytes: 0,
      termination: "exited",
      stdout: "{}",
      stderr: "",
    } as const;
    await lifecycle.onExited(command);
    const content = JSON.stringify({ capability: capability.kind, ok: true });
    return {
      capability,
      command,
      response: {
        schema_version: "1",
        capability: capability.kind,
        run_id: "memory-capability-run",
        artifact_root: path.join(_workspacePath, ".testplay", "runs", "memory-capability-run"),
        exit_code: 0,
        backend: "bridge",
        bridge: {
          protocol_version: 3,
          workspace_id: _binding.workspaceId,
          editor_pid: _binding.editorPid,
          bridge_session_id: _binding.bridgeSessionId,
        },
        compile_errors: 0,
        total: capability.kind === "warm-test" ? 1 : 0,
        passed: capability.kind === "warm-test" ? 1 : 0,
        failed: 0,
        skipped: 0,
        fallback_used: false,
        cleanup_state: "released",
      },
      evidence: [
        {
          name: capability.id + ".json",
          mediaType: "application/json",
          content,
          digest: digest(content),
        },
      ],
    };
  }
}

class FailedCapabilities implements UnityCapabilityRunner {
  public async runCapability(
    _runId: Parameters<UnityCapabilityRunner["runCapability"]>[0],
    capability: Parameters<UnityCapabilityRunner["runCapability"]>[1],
    _binding: Parameters<UnityCapabilityRunner["runCapability"]>[2],
    _workspacePath: string,
    _timeoutMs: number,
    _signal: AbortSignal,
    lifecycle: Parameters<UnityCapabilityRunner["runCapability"]>[6],
  ): Promise<UnityCapabilityRunResult> {
    const command = {
      pid: 3201,
      exitCode: 23,
      signal: null,
      durationMs: 17,
      stdoutBytes: 4,
      stderrBytes: 7,
      termination: "exited",
      stdout: "nope",
      stderr: "failure",
    } as const;
    await lifecycle.onStarted(command.pid, { containment: "deferred-v1" });
    await lifecycle.onRegistered?.(command.pid);
    await lifecycle.onExited(command);
    return {
      capability,
      command,
      evidence: [],
    };
  }
}

class PostRunFailingBridge extends MemoryBridge {
  public override async verify(_binding: WarmBridgeBindingV1): Promise<void> {
    this.verifies += 1;
    if (this.verifies === 2) {
      throw new HoneyBeeCoreError("bridge.binding-changed", "Bridge changed after capability.");
    }
  }
}

class CrashAfterEventJournal implements VersionedOrchestrationJournal {
  #crashed = false;

  public constructor(
    private readonly delegate: VersionedOrchestrationJournal,
    private readonly eventType: string,
  ) {}

  public async append(...args: Parameters<VersionedOrchestrationJournal["append"]>): Promise<void> {
    await this.delegate.append(...args);
    if (!this.#crashed && args[1].type === this.eventType) {
      this.#crashed = true;
      throw new Error("simulated parent crash");
    }
  }

  public replay(
    ...args: Parameters<VersionedOrchestrationJournal["replay"]>
  ): ReturnType<VersionedOrchestrationJournal["replay"]> {
    return this.delegate.replay(...args);
  }
}

const processControl: UnityProcessControl = {
  captureIdentity: async (pid) => "test:process:" + pid,
  drain: async () => "drained",
};

const testConfig = async (source: string, workspaceRoot: string) => {
  const executableDigest = createHash("sha256")
    .update(await readFile(process.execPath))
    .digest("hex");
  return UnityWorkConfigV2Schema.parse({
    schemaVersion: 2,
    sourceProjectPath: source,
    workspaceStorage: {
      command: { command: process.execPath },
      contractCommit: "575c3b37896cd3dfa37a4705477837cc52ec6132",
      binarySha256: executableDigest,
      workspaceRoot,
      parentKey: {
        schemaVersion: 2,
        digest: "c".repeat(64),
        libraryKey: {
          schemaVersion: "1",
          digest: "d".repeat(64),
          unityVersion: "6000",
          unityExecutableSha256: "e".repeat(64),
          manifestSha256: "f".repeat(64),
          packagesLockSha256: "missing",
          projectSettingsSha256: "0".repeat(64),
          buildTarget: "windows/amd64",
          scriptingBackend: "Mono",
          projectIdentitySha256: "1".repeat(64),
        },
        provider: "vhdx-differencing",
        filesystem: "NTFS",
        virtualBytes: 1024,
        blockBytes: 512,
        sectorBytes: 512,
      },
    },
    agent: { command: { command: process.execPath }, harness: "stdio-framed-v2" },
    testplay: {
      command: { command: process.execPath },
      unityPath: process.execPath,
      platform: "edit_mode",
      timeoutMs: 1000,
      bridgeProtocolVersion: 3,
    },
    editorPool: {
      id: "unity-editors",
      capacity: 1,
      registrationTimeoutMs: 1000,
      activationTimeoutMs: 1000,
      bridgeReadyTimeoutMs: 1000,
      capabilityTimeoutMs: 1000,
      shutdownTimeoutMs: 1000,
    },
    priority: "validation",
    capabilities: [
      { id: "compile", kind: "compile" },
      { id: "warm-test", kind: "warm-test", filter: "Smoke" },
    ],
  });
};

const transactionFixture = async (
  options: Readonly<{
    capabilities?: UnityCapabilityRunner;
    bridge?: WarmBridgeBindingResolver;
    registry?: MemoryEditorRegistry;
    wrapJournal?: (journal: VersionedOrchestrationJournal) => VersionedOrchestrationJournal;
  }> = {},
) => {
  const root = await temporaryRoot();
  const source = path.join(root, "source");
  const workspaceRoot = path.join(root, "workspaces");
  await Promise.all([
    mkdir(path.join(source, "Assets"), { recursive: true }),
    mkdir(path.join(source, "Packages"), { recursive: true }),
    mkdir(path.join(source, "ProjectSettings"), { recursive: true }),
    mkdir(workspaceRoot),
  ]);
  await Promise.all([
    writeFile(path.join(source, "Assets", "source.txt"), "source\n"),
    writeFile(path.join(source, "Packages", "manifest.json"), "{}\n"),
    writeFile(
      path.join(source, "ProjectSettings", "ProjectVersion.txt"),
      "m_EditorVersion: test\n",
    ),
  ]);
  const config = await testConfig(source, workspaceRoot);
  const runId = RunIdSchema.parse(randomUUID());
  await new FileRunRepository(root).create(runId);
  const artifacts = new FileArtifactStore(root);
  const baseJournal = new FileOrchestrationJournal(root);
  const controls = new FileRunControl(root);
  const bootstrap = new UnityProjectBootstrap();
  const storage = new MemoryWorkspaceStorage();
  const capabilities = options.capabilities ?? new CompletedCapabilities();
  const launcher = new MemoryEditorLauncher();
  const registry = options.registry ?? new MemoryEditorRegistry();
  const bridge = options.bridge ?? new MemoryBridge();
  const pool = new FileUnityEditorPoolCoordinator(root);
  const patchBuilder = new UnityPatchBuilder(
    artifacts,
    bootstrap,
    path.join(root, ".patch-verification"),
  );
  const execution = {
    workId: StepIdSchema.parse("work-a"),
    poolId: config.editorPool.id,
    priority: config.priority,
    capabilities: config.capabilities,
    pool,
    patchBuilder,
  } as const;
  const createTransaction = (journal: VersionedOrchestrationJournal) =>
    new UnityEditorWorkTransaction(
      root,
      new CompletedAgent(),
      artifacts,
      journal,
      controls,
      bootstrap,
      storage,
      capabilities,
      launcher,
      registry,
      bridge,
      { processControl },
    );
  return {
    runId,
    config,
    execution,
    storage,
    controls,
    registry,
    baseJournal,
    transaction: createTransaction(options.wrapJournal?.(baseJournal) ?? baseJournal),
    resumer: createTransaction(baseJournal),
  };
};

describe("UnityEditorWorkTransaction", () => {
  it("runs Agent-only Work without TestPlay, Editor, Bridge, or pool lifecycle", async () => {
    const fixture = await transactionFixture();
    const config = UnityWorkConfigV2Schema.parse({
      ...fixture.config,
      testplay: undefined,
      capabilities: [],
    });
    const result = await fixture.transaction.run(
      fixture.runId,
      "change the isolated project without validation",
      config,
      { ...fixture.execution, capabilities: [] },
    );

    const replay = await fixture.baseJournal.replay(fixture.runId);
    if (replay.status === "indeterminate") throw new Error(replay.message);
    expect(replay.events.at(-1)?.type).toBe("workflow.completed");
    expect(result.failure).toBeUndefined();
    expect(result).toMatchObject({ status: "completed" });
    expect(fixture.storage.released).toBe(1);
    expect(replay.status).toBe("terminal");
    const types = replay.events.map((event) => event.type);
    expect(types).not.toContain("editor.pool-requested");
    expect(types).not.toContain("editor.launch-intended");
    expect(types).not.toContain("editor.bridge-bound");
    expect(types).not.toContain("capability.started");
    expect(types).toContain("patch.verified");
    expect(types.at(-1)).toBe("workflow.completed");
  });

  it("runs config-owned capabilities sequentially and leaves workspace/editor/pool residual zero", async () => {
    const root = await temporaryRoot();
    const source = path.join(root, "source");
    const workspaceRoot = path.join(root, "workspaces");
    await Promise.all([
      mkdir(path.join(source, "Assets"), { recursive: true }),
      mkdir(path.join(source, "Packages"), { recursive: true }),
      mkdir(path.join(source, "ProjectSettings"), { recursive: true }),
      mkdir(workspaceRoot),
    ]);
    await Promise.all([
      writeFile(path.join(source, "Assets", "source.txt"), "source\n"),
      writeFile(path.join(source, "Packages", "manifest.json"), "{}\n"),
      writeFile(
        path.join(source, "ProjectSettings", "ProjectVersion.txt"),
        "m_EditorVersion: test\n",
      ),
    ]);

    const executableDigest = createHash("sha256")
      .update(await readFile(process.execPath))
      .digest("hex");
    const config = UnityWorkConfigV2Schema.parse({
      schemaVersion: 2,
      sourceProjectPath: source,
      workspaceStorage: {
        command: { command: process.execPath },
        contractCommit: "575c3b37896cd3dfa37a4705477837cc52ec6132",
        binarySha256: executableDigest,
        workspaceRoot,
        parentKey: {
          schemaVersion: 2,
          digest: "c".repeat(64),
          libraryKey: {
            schemaVersion: "1",
            digest: "d".repeat(64),
            unityVersion: "6000",
            unityExecutableSha256: "e".repeat(64),
            manifestSha256: "f".repeat(64),
            packagesLockSha256: "missing",
            projectSettingsSha256: "0".repeat(64),
            buildTarget: "windows/amd64",
            scriptingBackend: "Mono",
            projectIdentitySha256: "1".repeat(64),
          },
          provider: "vhdx-differencing",
          filesystem: "NTFS",
          virtualBytes: 1024,
          blockBytes: 512,
          sectorBytes: 512,
        },
      },
      agent: { command: { command: process.execPath }, harness: "stdio-framed-v2" },
      testplay: {
        command: { command: process.execPath },
        unityPath: process.execPath,
        platform: "edit_mode",
        timeoutMs: 1000,
        bridgeProtocolVersion: 3,
      },
      editorPool: {
        id: "unity-editors",
        capacity: 1,
        registrationTimeoutMs: 1000,
        activationTimeoutMs: 1000,
        bridgeReadyTimeoutMs: 1000,
        capabilityTimeoutMs: 1000,
        shutdownTimeoutMs: 1000,
      },
      priority: "validation",
      capabilities: [
        { id: "compile", kind: "compile" },
        { id: "warm-test", kind: "warm-test", filter: "Smoke" },
      ],
    });
    const runId = RunIdSchema.parse(randomUUID());
    const repository = new FileRunRepository(root);
    await repository.create(runId);
    const artifacts = new FileArtifactStore(root);
    const journal = new FileOrchestrationJournal(root);
    const controls = new FileRunControl(root);
    const bootstrap = new UnityProjectBootstrap();
    const storage = new MemoryWorkspaceStorage();
    const capabilityRunner = new CompletedCapabilities();
    const launcher = new MemoryEditorLauncher();
    const registry = new MemoryEditorRegistry();
    const bridge = new MemoryBridge();
    const pool = new FileUnityEditorPoolCoordinator(root);
    const patchBuilder = new UnityPatchBuilder(
      artifacts,
      bootstrap,
      path.join(root, ".patch-verification"),
    );
    const transaction = new UnityEditorWorkTransaction(
      root,
      new CompletedAgent(),
      artifacts,
      journal,
      controls,
      bootstrap,
      storage,
      capabilityRunner,
      launcher,
      registry,
      bridge,
      { processControl },
    );

    const result = await transaction.run(runId, "change the isolated project", config, {
      workId: StepIdSchema.parse("work-a"),
      poolId: config.editorPool.id,
      priority: config.priority,
      capabilities: config.capabilities,
      pool,
      patchBuilder,
    });

    expect(result.status).toBe("completed");
    expect(capabilityRunner.order).toEqual(["compile", "warm-test"]);
    expect(bridge.verifies).toBe(4);
    expect(storage.released).toBe(1);
    expect(launcher.stopped).toBe(1);
    expect(launcher.command?.args).toEqual([
      "-batchmode",
      "-nographics",
      "-projectPath",
      path.join(workspaceRoot, "hb-" + runId),
      "-logFile",
      path.join(root, runId, "unity-editor.log"),
    ]);
    expect(registry.owned?.ownership).toBe("honeybee");
    expect(registry.exited).toBe(registry.owned?.editorId);
    await expect(access(path.join(workspaceRoot, "hb-" + runId))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(access(path.join(source, "Assets", "agent-created.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    const replay = await journal.replay(runId);
    expect(replay.status).toBe("terminal");
    if (replay.status === "indeterminate") throw new Error(replay.message);
    const events = replay.events;
    expect(
      events
        .filter((event) => event.schemaVersion === 5 && event.type === "capability.started")
        .map((event) => event.payload.kind),
    ).toEqual(["compile", "warm-test"]);
    const acquired = events.find(
      (event) => event.schemaVersion === 5 && event.type === "editor.pool-acquired",
    );
    expect(acquired?.type).toBe("editor.pool-acquired");
    if (acquired?.schemaVersion !== 5 || acquired.type !== "editor.pool-acquired") {
      throw new Error("missing pool lease");
    }
    expect(
      await pool.status({ poolId: acquired.payload.poolId, requestId: acquired.payload.requestId }),
    ).toMatchObject({ state: "released" });

    if (result.status !== "completed" || result.patch === undefined) {
      throw new Error("unexpected result");
    }
    const patch = UnityPatchManifestV3Schema.parse(
      JSON.parse(await artifacts.get({ runId, artifact: result.patch })) as unknown,
    );
    expect(patch.verification).toEqual({
      workspaceIntegrity: "verified",
      compile: "passed",
      warmTest: "passed",
    });
    expect(patch.entries).toHaveLength(1);
    expect(patch.entries[0]).toMatchObject({
      path: "Assets/agent-created.txt",
      operation: "add",
    });
    expect(JSON.stringify(patch)).not.toContain("contentBase64");
    expect(patch.entries[0]?.operation === "add" && patch.entries[0].after.kind).toBe(
      "unity-patch-content",
    );
  }, 30_000);

  it("persists the actual failure metadata after a started capability exits", async () => {
    const fixture = await transactionFixture({ capabilities: new FailedCapabilities() });
    const result = await fixture.transaction.run(
      fixture.runId,
      "fail the capability",
      fixture.config,
      fixture.execution,
    );
    expect(result).toMatchObject({
      status: "failed",
      failure: {
        errorCode: "capability.failed",
        exitCode: 23,
        signal: null,
        durationMs: 17,
        stdoutBytes: 4,
        stderrBytes: 7,
      },
    });
    const replay = await fixture.baseJournal.replay(fixture.runId);
    if (replay.status === "indeterminate") throw new Error(replay.message);
    const failed = replay.events.find(
      (event) => event.schemaVersion === 5 && event.type === "capability.failed",
    );
    expect(failed?.type).toBe("capability.failed");
    if (failed?.schemaVersion !== 5 || failed.type !== "capability.failed") {
      throw new Error("missing capability failure");
    }
    expect(failed.payload.failure).toEqual({
      errorCode: "capability.failed",
      exitCode: 23,
      signal: null,
      durationMs: 17,
      stdoutBytes: 4,
      stderrBytes: 7,
    });
  });

  it("persists a post-run Bridge verification failure without rewriting it as interruption", async () => {
    const fixture = await transactionFixture({ bridge: new PostRunFailingBridge() });
    const result = await fixture.transaction.run(
      fixture.runId,
      "invalidate the Bridge",
      fixture.config,
      fixture.execution,
    );
    expect(result).toMatchObject({
      status: "failed",
      failure: { errorCode: "bridge.binding-changed" },
    });
    const replay = await fixture.baseJournal.replay(fixture.runId);
    if (replay.status === "indeterminate") throw new Error(replay.message);
    const failed = replay.events.find(
      (event) => event.schemaVersion === 5 && event.type === "capability.failed",
    );
    expect(failed?.type).toBe("capability.failed");
    if (failed?.schemaVersion !== 5 || failed.type !== "capability.failed") {
      throw new Error("missing capability failure");
    }
    expect(failed.payload.failure).toEqual({ errorCode: "bridge.binding-changed" });
  });

  it("reuses a durable workspace release when resuming before the terminal event", async () => {
    const fixture = await transactionFixture({
      wrapJournal: (journal) => new CrashAfterEventJournal(journal, "workspace.released"),
    });
    const interrupted = await fixture.transaction.run(
      fixture.runId,
      "crash after release",
      fixture.config,
      fixture.execution,
    );
    expect(interrupted.status).toBe("cleanup-pending");
    expect(fixture.storage.released).toBe(1);

    const resumed = await fixture.resumer.resume(fixture.runId, fixture.config, fixture.execution);
    expect(resumed.status).toBe("completed");
    expect(fixture.storage.released).toBe(1);
    const replay = await fixture.baseJournal.replay(fixture.runId);
    expect(replay.status).toBe("terminal");
    if (replay.status === "indeterminate") throw new Error(replay.message);
    expect(replay.events.filter((event) => event.type === "workspace.released")).toHaveLength(1);
  });

  it("reuses a durable workspace release for a failed decision", async () => {
    const fixture = await transactionFixture({
      capabilities: new FailedCapabilities(),
      wrapJournal: (journal) => new CrashAfterEventJournal(journal, "workspace.released"),
    });
    expect(
      (
        await fixture.transaction.run(
          fixture.runId,
          "fail before release",
          fixture.config,
          fixture.execution,
        )
      ).status,
    ).toBe("cleanup-pending");
    const resumed = await fixture.resumer.resume(fixture.runId, fixture.config, fixture.execution);
    expect(resumed.status).toBe("failed");
    expect(fixture.storage.released).toBe(1);
  });

  it("reuses a durable workspace release for a cancelled decision", async () => {
    const fixture = await transactionFixture({
      wrapJournal: (journal) => new CrashAfterEventJournal(journal, "workspace.released"),
    });
    await fixture.controls.submit({
      requestId: EventIdSchema.parse(randomUUID()),
      runId: fixture.runId,
      action: "cancel",
      timestamp: new Date().toISOString(),
    });
    expect(
      (
        await fixture.transaction.run(
          fixture.runId,
          "cancel before release",
          fixture.config,
          fixture.execution,
        )
      ).status,
    ).toBe("cleanup-pending");
    const resumed = await fixture.resumer.resume(fixture.runId, fixture.config, fixture.execution);
    expect(resumed.status).toBe("cancelled");
    expect(fixture.storage.released).toBe(1);
  });

  it("reconciles the Registry tombstone when resuming after editor.exited", async () => {
    const registry = new MemoryEditorRegistry();
    const fixture = await transactionFixture({
      registry,
      wrapJournal: (journal) => new CrashAfterEventJournal(journal, "editor.exited"),
    });
    const interrupted = await fixture.transaction.run(
      fixture.runId,
      "crash before the tombstone",
      fixture.config,
      fixture.execution,
    );
    expect(interrupted.status).toBe("cleanup-pending");
    expect(registry.exited).toBeUndefined();

    const resumed = await fixture.resumer.resume(fixture.runId, fixture.config, fixture.execution);
    expect(resumed.status).toBe("failed");
    expect(registry.exited).toBe(registry.owned?.editorId);
    expect(fixture.storage.released).toBe(1);
    expect((await fixture.baseJournal.replay(fixture.runId)).status).toBe("terminal");
  });
});
