import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  ArtifactIdSchema,
  ArtifactRefSchema,
  FileArtifactStore,
  FileOrchestrationJournal,
  FileRunControl,
  FileRunRepository,
  RunIdSchema,
  UnityBatchConfigV4Schema,
  type UnityWorkConfigV2,
} from "@honeybee/core";
import { afterEach, describe, expect, it } from "vitest";

import { UnityProjectBootstrap } from "./unity-adapters.js";
import { UnityEditorBatchWorkflow, type UnityEditorWorkExecutor } from "./unity-editor-batch.js";
import { FileUnityEditorPoolCoordinator } from "./unity-editor-pool.js";
import type { UnityWorkV5Execution } from "./unity-editor-transaction.js";
import { UnityPatchBuilder } from "./unity-patch.js";

const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

const temporaryRoot = async () => {
  const root = await mkdtemp(path.join(tmpdir(), "honeybee-editor-batch-"));
  roots.push(root);
  return root;
};

const config = () =>
  UnityBatchConfigV4Schema.parse({
    schemaVersion: 4,
    mode: "unity-batch",
    resourceScope: "global-editor-pool-v2",
    maxParallelWorks: 2,
    transaction: {
      schemaVersion: 1,
      sourceProjectPath: "source",
      workspaceStorage: {
        command: { command: "storage" },
        contractCommit: "575c3b37896cd3dfa37a4705477837cc52ec6132",
        binarySha256: "b".repeat(64),
        workspaceRoot: "workspaces",
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
      agent: { command: { command: "agent" }, harness: "stdio-framed-v2" },
      testplay: {
        command: { command: "testplay" },
        unityPath: "Unity",
        platform: "edit_mode",
        timeoutMs: 1000,
      },
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
    bridgeProtocolVersion: 3,
    works: [
      {
        id: "work-a",
        task: "A",
        priority: "interactive",
        capabilities: [{ id: "compile-a", kind: "compile" }],
        agent: { command: { command: "agent-a" }, harness: "stdio-framed-v2" },
      },
      {
        id: "work-b",
        task: "B",
        priority: "background",
        capabilities: [{ id: "test-b", kind: "warm-test", filter: "Smoke" }],
        agent: { command: { command: "agent-b" }, harness: "stdio-framed-v2" },
      },
    ],
  });

describe("UnityEditorBatchWorkflow", () => {
  it("forwards config-owned priority/capabilities while bounding parallel child Works", async () => {
    const root = await temporaryRoot();
    const runId = RunIdSchema.parse(randomUUID());
    const repository = new FileRunRepository(root);
    await repository.create(runId);
    const artifacts = new FileArtifactStore(root);
    const journal = new FileOrchestrationJournal(root);
    const controls = new FileRunControl(root);
    let active = 0;
    let maximum = 0;
    const observed: Array<
      Readonly<{ config: UnityWorkConfigV2; execution: UnityWorkV5Execution }>
    > = [];
    const executor: UnityEditorWorkExecutor = {
      run: async (childRunId, _task, childConfig, execution) => {
        active += 1;
        maximum = Math.max(maximum, active);
        observed.push({ config: childConfig, execution });
        await new Promise((resolve) => setTimeout(resolve, 50));
        active -= 1;
        return {
          runId: childRunId,
          status: "completed",
          patch: ArtifactRefSchema.parse({
            artifactId: ArtifactIdSchema.parse(randomUUID()),
            kind: "unity-verified-patch",
            mediaType: "application/vnd.honeybee.unity-patch+json",
            byteLength: 2,
            contentDigest: `sha256:${"a".repeat(64)}`,
          }),
        };
      },
      resume: async () => {
        throw new Error("unexpected resume");
      },
    };
    const pool = new FileUnityEditorPoolCoordinator(root);
    const workflow = new UnityEditorBatchWorkflow(
      root,
      artifacts,
      journal,
      repository,
      controls,
      controls,
      executor,
      pool,
      new UnityPatchBuilder(artifacts, new UnityProjectBootstrap(), path.join(root, ".patch")),
    );
    const result = await workflow.run(runId, config());
    expect(result.status).toBe("completed");
    expect(maximum).toBe(2);
    expect(observed.map((value) => value.execution.priority).sort()).toEqual([
      "background",
      "interactive",
    ]);
    expect(observed.map((value) => value.config.capabilities[0]?.kind).sort()).toEqual([
      "compile",
      "warm-test",
    ]);
    expect(observed.map((value) => value.config.agent.command.command).sort()).toEqual([
      "agent-a",
      "agent-b",
    ]);
    expect((await journal.replay(runId)).status).toBe("terminal");
  });
});
