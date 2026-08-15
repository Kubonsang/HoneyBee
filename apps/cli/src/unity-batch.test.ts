import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  ArtifactIdSchema,
  ArtifactRefSchema,
  EventIdSchema,
  FileArtifactStore,
  FileOrchestrationJournal,
  FileRunControl,
  FileRunRepository,
  HoneyBeeCoreError,
  OrchestrationEventV4Schema,
  RunIdSchema,
  UnityBatchConfigV1Schema,
  type ArtifactRef,
  type RunId,
  type UnityBatchConfigV1,
  type VersionedOrchestrationJournal,
} from "@honeybee/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { UnityProjectBootstrap } from "./unity-adapters.js";
import { UnityBatchWorkflow, type UnityWorkExecutor } from "./unity-batch.js";
import { UnityPatchBuilder } from "./unity-patch.js";
import { BatchLocalUnityResourceCoordinator } from "./unity-resource-control.js";
import type { UnityWorkRunResult, UnityWorkV4Execution } from "./unity-transaction.js";

const directories: string[] = [];
const temporaryRoot = async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "honeybee-batch-"));
  directories.push(directory);
  return directory;
};

afterEach(async () => {
  await Promise.all(directories.splice(0).map((entry) => rm(entry, { recursive: true })));
});

const config = (root: string, works: readonly Readonly<{ id: string; task: string }>[]) =>
  UnityBatchConfigV1Schema.parse({
    schemaVersion: 1,
    mode: "unity-batch",
    maxParallelWorks: Math.min(2, works.length),
    transaction: {
      schemaVersion: 1,
      sourceProjectPath: path.join(root, "source"),
      workspaceStorage: {
        command: { command: process.execPath },
        contractCommit: "575c3b37896cd3dfa37a4705477837cc52ec6132",
        binarySha256: "0".repeat(64),
        workspaceRoot: path.join(root, "workspaces"),
        parentKey: {
          schemaVersion: 2,
          digest: "a".repeat(64),
          libraryKey: {
            schemaVersion: "1",
            digest: "b".repeat(64),
            unityVersion: "test",
            unityExecutableSha256: "c".repeat(64),
            manifestSha256: "d".repeat(64),
            packagesLockSha256: "missing",
            projectSettingsSha256: "e".repeat(64),
            buildTarget: "windows/amd64",
            scriptingBackend: "Mono",
            projectIdentitySha256: "f".repeat(64),
          },
          provider: "vhdx-differencing",
          filesystem: "NTFS",
          virtualBytes: 1024,
          blockBytes: 512,
          sectorBytes: 512,
        },
      },
      agent: { command: { command: "agent" }, harness: "stdio-framed-v2" },
      testplay: {
        command: { command: "testplay" },
        unityPath: path.join(root, "Unity.exe"),
        platform: "edit_mode",
        timeoutMs: 1000,
      },
    },
    resources: [{ id: "unity-editor", capacity: 1 }],
    works: works.map((work) => ({ ...work, resourceRef: "unity-editor" })),
  });

const patchRef = (): ArtifactRef =>
  ArtifactRefSchema.parse({
    artifactId: randomUUID(),
    kind: "unity-verified-patch",
    mediaType: "application/vnd.honeybee.unity-patch+json",
    byteLength: 2,
    contentDigest: `sha256:${"a".repeat(64)}`,
  });

class FakeExecutor implements UnityWorkExecutor {
  public active = 0;
  public maximumActive = 0;
  public readonly runCalls: string[] = [];
  public readonly resumeCalls: string[] = [];

  public constructor(
    private readonly artifacts: FileArtifactStore,
    private readonly journal: FileOrchestrationJournal,
    private readonly cleanupTask?: string,
    private readonly delayMs = 20,
  ) {}

  public async run(
    runId: RunId,
    task: string,
    transaction: UnityBatchConfigV1["transaction"],
    execution: UnityWorkV4Execution,
  ): Promise<UnityWorkRunResult> {
    this.runCalls.push(task);
    this.active += 1;
    this.maximumActive = Math.max(this.maximumActive, this.active);
    try {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
      if (task === this.cleanupTask) {
        const configArtifact = await this.artifacts.put({
          runId,
          artifactId: ArtifactIdSchema.parse(randomUUID()),
          kind: "workflow-config",
          mediaType: "application/json",
          content: JSON.stringify(transaction),
        });
        const taskArtifact = await this.artifacts.put({
          runId,
          artifactId: ArtifactIdSchema.parse(randomUUID()),
          kind: "task",
          mediaType: "text/plain; charset=utf-8",
          content: task,
        });
        await this.journal.append(
          runId,
          OrchestrationEventV4Schema.parse({
            schemaVersion: 4,
            eventId: EventIdSchema.parse(randomUUID()),
            runId,
            sequence: 1,
            timestamp: new Date(0).toISOString(),
            type: "workflow.started",
            payload: {
              mode: "unity-work-v2",
              config: configArtifact,
              task: taskArtifact,
              linkage: {
                parentRunId: execution.parentRunId,
                workId: execution.workId,
                resourceId: execution.resourceId,
                resourceScope: execution.resourceScope,
              },
            },
          }),
        );
        return { runId, status: "cleanup-pending", failure: { errorCode: "cleanup.pending" } };
      }
      if (task === "fail") {
        return { runId, status: "failed", failure: { errorCode: "test.failure" } };
      }
      return { runId, status: "completed", patch: patchRef() };
    } finally {
      this.active -= 1;
    }
  }

  public async resume(runId: RunId): Promise<UnityWorkRunResult> {
    this.resumeCalls.push(runId);
    return { runId, status: "cleanup-pending", failure: { errorCode: "cleanup.pending" } };
  }
}

const fixture = async (root: string, cleanupTask?: string, delayMs?: number) => {
  const artifacts = new FileArtifactStore(root);
  const journal = new FileOrchestrationJournal(root);
  const repository = new FileRunRepository(root);
  const controls = new FileRunControl(root);
  const executor = new FakeExecutor(artifacts, journal, cleanupTask, delayMs);
  const workflow = new UnityBatchWorkflow(
    root,
    artifacts,
    journal,
    repository,
    controls,
    controls,
    executor,
    new BatchLocalUnityResourceCoordinator(),
    new UnityPatchBuilder(artifacts, new UnityProjectBootstrap(), path.join(root, "scratch")),
  );
  return { artifacts, journal, repository, controls, executor, workflow };
};

describe("UnityBatchWorkflow", () => {
  it("bounds parallel child execution and isolates a failed Work", async () => {
    const root = await temporaryRoot();
    const parentRunId = RunIdSchema.parse(randomUUID());
    const setup = await fixture(root);
    await setup.repository.create(parentRunId);

    const result = await setup.workflow.run(
      parentRunId,
      config(root, [
        { id: "work-a", task: "pass-a" },
        { id: "work-b", task: "fail" },
        { id: "work-c", task: "pass-c" },
      ]),
    );

    expect(setup.executor.maximumActive).toBe(2);
    expect(result.status).toBe("failed");
    expect(result.summary).toEqual({ total: 3, completed: 2, failed: 1, cancelled: 0 });
    expect(result.works.filter((work) => work.patch !== undefined)).toHaveLength(2);
    const replay = await setup.journal.replay(parentRunId);
    expect(replay.status).toBe("terminal");
    expect(replay.status === "terminal" ? replay.terminal.schemaVersion : 0).toBe(4);
    if (replay.status !== "terminal") throw new Error("missing terminal replay");
    const start = replay.events[0];
    if (
      start?.schemaVersion !== 4 ||
      start.type !== "workflow.started" ||
      start.payload.mode !== "unity-batch-v1"
    ) {
      throw new Error("missing batch start");
    }
    const digest = start.payload.config.contentDigest.slice("sha256:".length);
    await writeFile(
      path.join(root, parentRunId, "blobs", "sha256", digest.slice(0, 2), digest.slice(2)),
      "damaged",
      "utf8",
    );
    expect((await setup.workflow.inspect(parentRunId)).status).toBe("failed");
  });

  it("runs cleanup recovery before dispatching any previously unstarted Work", async () => {
    const root = await temporaryRoot();
    const parentRunId = RunIdSchema.parse(randomUUID());
    const setup = await fixture(root, "needs-cleanup");
    await setup.repository.create(parentRunId);
    const batch = UnityBatchConfigV1Schema.parse({
      ...config(root, [
        { id: "work-a", task: "needs-cleanup" },
        { id: "work-b", task: "must-not-start" },
      ]),
      maxParallelWorks: 1,
    });

    const first = await setup.workflow.run(parentRunId, batch);
    expect(first.status).toBe("cleanup-pending");
    expect(setup.executor.runCalls).toEqual(["needs-cleanup"]);

    const resumed = await setup.workflow.resume(parentRunId);
    expect(resumed.status).toBe("cleanup-pending");
    expect(setup.executor.resumeCalls).toHaveLength(1);
    expect(setup.executor.runCalls).toEqual(["needs-cleanup"]);
  });

  it("recovers registration after a crash between deterministic child registrations", async () => {
    const root = await temporaryRoot();
    const parentRunId = RunIdSchema.parse(randomUUID());
    const setup = await fixture(root);
    await setup.repository.create(parentRunId);
    let registrations = 0;
    const interruptedJournal: VersionedOrchestrationJournal = {
      append: async (runId, event) => {
        if (event.schemaVersion === 4 && event.type === "work.registered") {
          registrations += 1;
          if (registrations === 2) {
            throw new HoneyBeeCoreError("journal.write-failed", "simulated parent crash");
          }
        }
        await setup.journal.append(runId, event);
      },
      replay: (runId) => setup.journal.replay(runId),
    };
    const interrupted = new UnityBatchWorkflow(
      root,
      setup.artifacts,
      interruptedJournal,
      setup.repository,
      setup.controls,
      setup.controls,
      setup.executor,
      new BatchLocalUnityResourceCoordinator(),
      new UnityPatchBuilder(
        setup.artifacts,
        new UnityProjectBootstrap(),
        path.join(root, "scratch"),
      ),
    );
    const batch = config(root, [
      { id: "work-a", task: "pass-a" },
      { id: "work-b", task: "pass-b" },
    ]);

    await expect(interrupted.run(parentRunId, batch)).rejects.toMatchObject({
      code: "journal.write-failed",
    });
    const active = await setup.journal.replay(parentRunId);
    expect(active.status).toBe("active");
    expect(
      active.status === "active"
        ? active.events.filter((event) => event.type === "work.registered")
        : [],
    ).toHaveLength(1);

    const resumed = await setup.workflow.resume(parentRunId);
    expect(resumed.status).toBe("completed");
    expect(setup.executor.runCalls.sort()).toEqual(["pass-a", "pass-b"]);
  });

  it("polls and preserves an accepted parent cancellation while children are active", async () => {
    const root = await temporaryRoot();
    const parentRunId = RunIdSchema.parse(randomUUID());
    const setup = await fixture(root, undefined, 250);
    await setup.repository.create(parentRunId);
    const execution = setup.workflow.run(
      parentRunId,
      config(root, [
        { id: "work-a", task: "pass-a" },
        { id: "work-b", task: "pass-b" },
      ]),
    );
    await vi.waitFor(() => expect(setup.executor.active).toBe(2));
    await setup.controls.submit({
      requestId: EventIdSchema.parse(randomUUID()),
      runId: parentRunId,
      action: "cancel",
      timestamp: new Date().toISOString(),
    });

    const result = await execution;
    expect(result.status).toBe("cancelled");
    expect(result.summary).toEqual({ total: 2, completed: 2, failed: 0, cancelled: 0 });
    const replay = await setup.journal.replay(parentRunId);
    expect(replay.status).toBe("terminal");
    expect(replay.status === "terminal" ? replay.terminal.type : "").toBe("workflow.cancelled");
  });

  it("replays an accepted cancellation after a crash before workflow.cancelling", async () => {
    const root = await temporaryRoot();
    const parentRunId = RunIdSchema.parse(randomUUID());
    const setup = await fixture(root);
    await setup.repository.create(parentRunId);
    await setup.controls.submit({
      requestId: EventIdSchema.parse(randomUUID()),
      runId: parentRunId,
      action: "cancel",
      timestamp: new Date().toISOString(),
    });
    let interruptedOnce = false;
    const interruptedJournal: VersionedOrchestrationJournal = {
      append: async (runId, event) => {
        if (!interruptedOnce && event.schemaVersion === 4 && event.type === "workflow.cancelling") {
          interruptedOnce = true;
          throw new HoneyBeeCoreError("journal.write-failed", "simulated parent crash");
        }
        await setup.journal.append(runId, event);
      },
      replay: (runId) => setup.journal.replay(runId),
    };
    const interrupted = new UnityBatchWorkflow(
      root,
      setup.artifacts,
      interruptedJournal,
      setup.repository,
      setup.controls,
      setup.controls,
      setup.executor,
      new BatchLocalUnityResourceCoordinator(),
      new UnityPatchBuilder(
        setup.artifacts,
        new UnityProjectBootstrap(),
        path.join(root, "scratch"),
      ),
    );
    const batch = config(root, [
      { id: "work-a", task: "pass-a" },
      { id: "work-b", task: "pass-b" },
    ]);

    await expect(interrupted.run(parentRunId, batch)).rejects.toMatchObject({
      code: "journal.write-failed",
    });
    const active = await setup.journal.replay(parentRunId);
    expect(active.status).toBe("active");
    expect(active.status === "active" ? active.events.at(-1)?.type : "").toBe("control.accepted");

    const resumed = await setup.workflow.resume(parentRunId);
    expect(resumed.status).toBe("cancelled");
    expect(resumed.summary.cancelled).toBe(2);
    expect(setup.executor.runCalls).toEqual([]);
    expect(await setup.controls.pending(parentRunId)).toEqual([]);
  });
});
