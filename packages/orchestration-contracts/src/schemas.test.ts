import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  AgentInputEnvelopeV1Schema,
  AgentInputEnvelopeV2Schema,
  AgentResponseEnvelopeV1Schema,
  ArtifactRefSchema,
  OrchestrationEventV4Schema,
  OrchestrationEventV5Schema,
  OrchestrationEventV3Schema,
  RunIdSchema,
  StepIdSchema,
  UnityPatchManifestV1Schema,
  UnityPatchManifestV2Schema,
  UnityBatchConfigV1Schema,
  UnityBatchConfigV2Schema,
  UnityBatchConfigV3Schema,
  UnityEditorObservationV1Schema,
  UnityWorkConfigV2Schema,
  UnityGlobalResourceEventV1Schema,
  WorkflowConfigV2Schema,
  WorkflowConfigV3Schema,
  type ArtifactKind,
  type ArtifactMediaType,
} from "./schemas.js";

const artifact = (kind: "task" | "step-content") =>
  ArtifactRefSchema.parse({
    artifactId: randomUUID(),
    kind,
    mediaType: "text/plain; charset=utf-8",
    byteLength: 4,
    contentDigest: `sha256:${"a".repeat(64)}`,
  });

const artifactOf = (kind: ArtifactKind, mediaType: ArtifactMediaType) =>
  ArtifactRefSchema.parse({
    artifactId: randomUUID(),
    kind,
    mediaType,
    byteLength: 4,
    contentDigest: `sha256:${"b".repeat(64)}`,
  });

describe("orchestration contracts", () => {
  it("brands UUID run IDs and strictly validates step IDs", () => {
    expect(RunIdSchema.safeParse(randomUUID()).success).toBe(true);
    expect(RunIdSchema.safeParse("../escape").success).toBe(false);
    expect(StepIdSchema.safeParse("review_step-1").success).toBe(true);
    expect(StepIdSchema.safeParse("Review").success).toBe(false);
    expect(StepIdSchema.safeParse(`a${"b".repeat(64)}`).success).toBe(false);
  });

  it("scopes durable process drain markers to their started process kind", () => {
    const base = {
      schemaVersion: 3,
      eventId: randomUUID(),
      runId: randomUUID(),
      sequence: 1,
      timestamp: new Date(0).toISOString(),
      type: "process.drain-completed",
      payload: { process: "agent", startedEventId: randomUUID() },
    } as const;
    expect(OrchestrationEventV3Schema.safeParse(base).success).toBe(false);
    expect(OrchestrationEventV3Schema.safeParse({ ...base, stepId: "unity-agent" }).success).toBe(
      true,
    );
    expect(
      OrchestrationEventV3Schema.safeParse({
        ...base,
        stepId: undefined,
        payload: { ...base.payload, process: "testplay" },
      }).success,
    ).toBe(true);
  });

  it.each([
    ["agent.started", "agent", "unity-agent"],
    ["testplay.started", "testplay", undefined],
  ] as const)(
    "strictly validates deferred containment lifecycle for %s",
    (type, process, stepId) => {
      const runId = randomUUID();
      const startedEventId = randomUUID();
      const started = {
        schemaVersion: 3,
        eventId: startedEventId,
        runId,
        sequence: 1,
        timestamp: new Date(0).toISOString(),
        type,
        ...(stepId === undefined ? {} : { stepId }),
        payload: { pid: 42, containment: "deferred-v1" },
      } as const;
      expect(OrchestrationEventV3Schema.safeParse(started).success).toBe(true);
      expect(
        OrchestrationEventV3Schema.safeParse({
          ...started,
          payload: { ...started.payload, containment: "other" },
        }).success,
      ).toBe(false);
      expect(
        OrchestrationEventV3Schema.safeParse({
          ...started,
          eventId: randomUUID(),
          sequence: 2,
          type: "process.containment-registered",
          payload: { process, startedEventId },
        }).success,
      ).toBe(true);
    },
  );

  it("rejects duplicate workflow step IDs", () => {
    expect(
      WorkflowConfigV2Schema.safeParse({
        schemaVersion: 2,
        steps: [
          { id: "worker", agent: { command: "a" } },
          { id: "worker", agent: { command: "b" } },
        ],
      }).success,
    ).toBe(false);
  });

  it("validates correlated Agent input and response envelopes", () => {
    const runId = RunIdSchema.parse(randomUUID());
    const input = AgentInputEnvelopeV1Schema.parse({
      schemaVersion: 1,
      runId,
      step: { id: "review", index: 1, total: 2 },
      task: { artifact: artifact("task"), content: "task" },
      previous: { stepId: "produce", artifact: artifact("step-content"), content: "work" },
    });
    expect(input.step.id).toBe("review");
    expect(
      AgentResponseEnvelopeV1Schema.safeParse({
        schemaVersion: 1,
        runId,
        stepId: "review",
        status: "blocked",
        reason: "needs input",
      }).success,
    ).toBe(true);

    expect(
      AgentInputEnvelopeV2Schema.safeParse({
        schemaVersion: 2,
        runId,
        step: { id: "review", attempt: 1 },
        task: { artifact: artifact("task"), content: "task" },
        inputs: {},
        outputs: {
          summary: { mediaType: "text/plain; charset=utf-8" },
          report: { mediaType: "application/json" },
        },
      }).success,
    ).toBe(true);
    expect(
      AgentInputEnvelopeV2Schema.safeParse({
        schemaVersion: 2,
        runId,
        step: { id: "review", attempt: 1 },
        task: { artifact: artifact("task"), content: "task" },
        inputs: {},
        outputs: {},
      }).success,
    ).toBe(false);
  });

  it("limits protocol v1 harnesses to the legacy content contract", () => {
    const legacy = {
      schemaVersion: 3,
      agents: [{ id: "worker", command: "worker" }],
      harnesses: [{ id: "legacy", kind: "stdio-framed-v1", protocolVersion: 1 }],
      steps: [
        {
          id: "worker",
          type: "agent",
          agentRef: "worker",
          harnessRef: "legacy",
          outputs: { content: { mediaType: "text/plain; charset=utf-8" } },
        },
      ],
    } as const;
    expect(WorkflowConfigV3Schema.safeParse(legacy).success).toBe(true);
    expect(
      WorkflowConfigV3Schema.safeParse({
        ...legacy,
        steps: [
          {
            ...legacy.steps[0],
            outputs: { report: { mediaType: "application/json" } },
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      WorkflowConfigV3Schema.safeParse({
        ...legacy,
        agents: [
          { id: "source", command: "source" },
          { id: "worker", command: "worker" },
        ],
        harnesses: [
          { id: "modern", kind: "stdio-framed-v2", protocolVersion: 2 },
          ...legacy.harnesses,
        ],
        steps: [
          {
            id: "source",
            type: "agent",
            agentRef: "source",
            harnessRef: "modern",
            outputs: { content: { mediaType: "text/plain; charset=utf-8" } },
          },
          {
            ...legacy.steps[0],
            inputs: { previous: { from: { stepId: "source", output: "content" } } },
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("strictly validates v3 graph references, cycles, and JSON conditions", () => {
    const base = {
      schemaVersion: 3,
      agents: [
        { id: "source", command: "source" },
        { id: "next", command: "next" },
      ],
      harnesses: [{ id: "stdio", kind: "stdio-framed-v2", protocolVersion: 2 }],
      steps: [
        {
          id: "source",
          type: "agent",
          agentRef: "source",
          harnessRef: "stdio",
          outputs: { decision: { mediaType: "application/json" } },
        },
        {
          id: "next",
          type: "agent",
          agentRef: "next",
          harnessRef: "stdio",
          inputs: { source: { from: { stepId: "source", output: "decision" } } },
          when: {
            artifact: {
              stepId: "source",
              output: "decision",
              pointer: "/accepted",
              op: "eq",
              value: true,
            },
          },
          outputs: { content: { mediaType: "text/plain; charset=utf-8" } },
        },
      ],
    } as const;
    expect(WorkflowConfigV3Schema.safeParse(base).success).toBe(true);
    expect(
      WorkflowConfigV3Schema.safeParse({
        ...base,
        outputs: { result: { from: { stepId: "next", output: "content" } } },
      }).success,
    ).toBe(true);
    expect(
      WorkflowConfigV3Schema.safeParse({
        ...base,
        outputs: { result: { from: { stepId: "missing", output: "content" } } },
      }).success,
    ).toBe(false);
    expect(
      WorkflowConfigV3Schema.safeParse({
        ...base,
        outputs: { result: { from: { stepId: "next", output: "missing" } } },
      }).success,
    ).toBe(false);
    expect(WorkflowConfigV3Schema.safeParse({ ...base, unexpected: true }).success).toBe(false);
    expect(
      WorkflowConfigV3Schema.safeParse({
        ...base,
        steps: [
          { ...base.steps[0], needs: ["next"] },
          { ...base.steps[1], needs: ["source"] },
        ],
      }).success,
    ).toBe(false);
    expect(
      WorkflowConfigV3Schema.safeParse({
        ...base,
        steps: [
          { ...base.steps[0], outputs: { decision: { mediaType: "text/plain; charset=utf-8" } } },
          base.steps[1],
        ],
      }).success,
    ).toBe(false);
  });

  it("keeps verified patch manifests reference-only and path ordered", () => {
    const base = artifactOf("unity-source-manifest", "application/json");
    const result = artifactOf("unity-workspace-manifest", "application/json");
    const content = artifactOf("unity-patch-content", "application/octet-stream");
    const valid = {
      schemaVersion: 1,
      baseManifest: base,
      resultManifest: result,
      entries: [
        { path: "Assets/added.bin", operation: "add-or-modify", content },
        {
          path: "ProjectSettings/removed.asset",
          operation: "delete",
          baseContentDigest: `sha256:${"c".repeat(64)}`,
        },
      ],
    } as const;
    expect(UnityPatchManifestV1Schema.safeParse(valid).success).toBe(true);
    expect(
      UnityPatchManifestV1Schema.safeParse({
        ...valid,
        entries: [{ ...valid.entries[0], contentBase64: "AA==" }],
      }).success,
    ).toBe(false);
    expect(
      UnityPatchManifestV1Schema.safeParse({ ...valid, entries: [...valid.entries].reverse() })
        .success,
    ).toBe(false);
    expect(
      UnityPatchManifestV1Schema.safeParse({
        ...valid,
        entries: [{ ...valid.entries[0], path: "Assets/file.txt:stream" }],
      }).success,
    ).toBe(false);

    const v2 = {
      schemaVersion: 2,
      baseManifest: base,
      baseTreeManifest: result,
      resultManifest: result,
      entries: [
        { path: "Assets/added.bin", operation: "add", after: content },
        {
          path: "ProjectSettings/removed.asset",
          operation: "delete",
          baseContentDigest: content.contentDigest,
          before: content,
        },
      ],
    } as const;
    expect(UnityPatchManifestV2Schema.safeParse(v2).success).toBe(true);
    expect(
      UnityPatchManifestV2Schema.safeParse({
        ...v2,
        entries: [
          {
            ...v2.entries[1],
            baseContentDigest: "sha256:" + "d".repeat(64),
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      UnityPatchManifestV2Schema.safeParse({
        ...v2,
        entries: [{ ...v2.entries[0], contentBase64: "AA==" }],
      }).success,
    ).toBe(false);
  });

  it("uses schema v4 for both batch parents and resource-managed children", () => {
    const runId = randomUUID();
    const base = {
      schemaVersion: 4,
      eventId: randomUUID(),
      runId,
      sequence: 1,
      timestamp: new Date(0).toISOString(),
      type: "workflow.started",
    } as const;
    expect(
      OrchestrationEventV4Schema.safeParse({
        ...base,
        payload: {
          mode: "unity-batch-v1",
          config: artifactOf("workflow-config", "application/json"),
          workCount: 3,
          maxParallelWorks: 2,
          resourceScope: "batch-local-v1",
        },
      }).success,
    ).toBe(true);
    expect(
      OrchestrationEventV4Schema.safeParse({
        ...base,
        payload: {
          mode: "unity-work-v2",
          config: artifactOf("workflow-config", "application/json"),
          task: artifactOf("task", "text/plain; charset=utf-8"),
          linkage: {
            parentRunId: randomUUID(),
            workId: "work-a",
            resourceId: "unity-editor",
            resourceScope: "batch-local-v1",
          },
        },
      }).success,
    ).toBe(true);
    expect(
      OrchestrationEventV4Schema.safeParse({
        ...base,
        payload: {
          mode: "unity-work-v2",
          config: artifactOf("workflow-config", "application/json"),
          task: artifactOf("task", "text/plain; charset=utf-8"),
          linkage: {
            parentRunId: randomUUID(),
            workId: "work-a",
            resourceId: "unity-editor",
            resourceScope: "global-file-v1",
          },
        },
      }).success,
    ).toBe(true);
  });

  it("keeps batch v1 local and makes global coordination explicit in strict batch v2", () => {
    const transaction = {
      schemaVersion: 1,
      sourceProjectPath: "C:\\source",
      workspaceStorage: {
        command: { command: "storage" },
        contractCommit: "575c3b37896cd3dfa37a4705477837cc52ec6132",
        binarySha256: "b".repeat(64),
        workspaceRoot: "C:\\workspaces",
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
        unityPath: "C:\\Unity.exe",
        platform: "edit_mode",
        timeoutMs: 1000,
      },
    } as const;
    const common = {
      mode: "unity-batch",
      maxParallelWorks: 2,
      transaction,
      resources: [{ id: "unity-editor", capacity: 1 }],
      works: [
        { id: "work-a", task: "A", resourceRef: "unity-editor" },
        { id: "work-b", task: "B", resourceRef: "unity-editor" },
      ],
    } as const;
    expect(UnityBatchConfigV1Schema.safeParse({ schemaVersion: 1, ...common }).success).toBe(true);
    expect(
      UnityBatchConfigV2Schema.safeParse({
        schemaVersion: 2,
        resourceScope: "global-file-v1",
        ...common,
      }).success,
    ).toBe(true);
    expect(UnityBatchConfigV2Schema.safeParse({ schemaVersion: 2, ...common }).success).toBe(false);
    expect(
      UnityBatchConfigV2Schema.safeParse({
        schemaVersion: 2,
        resourceScope: "global-file-v1",
        typo: true,
        ...common,
      }).success,
    ).toBe(false);
  });

  it("strictly validates immutable global resource events", () => {
    const value = {
      schemaVersion: 1,
      eventId: randomUUID(),
      sequence: 1,
      timestamp: new Date(0).toISOString(),
      type: "resource.queued",
      resourceId: "unity-editor",
      requestId: randomUUID(),
      ownerRunId: randomUUID(),
      ticket: 1,
    } as const;
    expect(UnityGlobalResourceEventV1Schema.safeParse(value).success).toBe(true);
    expect(UnityGlobalResourceEventV1Schema.safeParse({ ...value, pid: 123 }).success).toBe(false);
  });

  it("strictly contracts v0.6 config-driven capabilities and schema v5 linkage", () => {
    const transaction = {
      schemaVersion: 1,
      sourceProjectPath: "C:\\source",
      workspaceStorage: {
        command: { command: "storage.exe" },
        contractCommit: "575c3b37896cd3dfa37a4705477837cc52ec6132",
        binarySha256: "b".repeat(64),
        workspaceRoot: "C:\\workspaces",
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
        unityPath: "C:\\Unity.exe",
        platform: "edit_mode",
        timeoutMs: 1000,
      },
    } as const;
    const editorPool = {
      id: "unity-editor-pool",
      capacity: 2,
      registrationTimeoutMs: 1000,
      activationTimeoutMs: 1000,
      bridgeReadyTimeoutMs: 1000,
      capabilityTimeoutMs: 1000,
      shutdownTimeoutMs: 1000,
    } as const;
    const config = {
      schemaVersion: 3,
      mode: "unity-batch",
      resourceScope: "global-editor-pool-v2",
      maxParallelWorks: 2,
      transaction,
      editorPool,
      bridgeProtocolVersion: 3,
      works: [
        {
          id: "work-a",
          task: "A",
          priority: "interactive",
          capabilities: [{ id: "compile-a", kind: "compile" }],
        },
        {
          id: "work-b",
          task: "B",
          priority: "background",
          capabilities: [{ id: "test-b", kind: "warm-test" }],
        },
      ],
    } as const;
    expect(UnityBatchConfigV3Schema.safeParse(config).success).toBe(true);
    expect(UnityBatchConfigV3Schema.safeParse({ ...config, typo: true }).success).toBe(false);
    expect(
      UnityBatchConfigV3Schema.safeParse({
        ...config,
        transaction: {
          ...transaction,
          workspaceStorage: {
            ...transaction.workspaceStorage,
            command: { command: "node", args: ["storage.js"] },
          },
        },
      }).success,
    ).toBe(false);
    expect(
      UnityBatchConfigV3Schema.safeParse({
        ...config,
        transaction: {
          ...transaction,
          testplay: { ...transaction.testplay, platform: "play_mode" },
        },
      }).success,
    ).toBe(false);
    expect(
      UnityBatchConfigV3Schema.safeParse({
        ...config,
        transaction: {
          ...transaction,
          testplay: { ...transaction.testplay, filter: "Smoke" },
        },
      }).success,
    ).toBe(false);

    const single = {
      ...transaction,
      schemaVersion: 2,
      testplay: { ...transaction.testplay, bridgeProtocolVersion: 3 },
      editorPool,
      priority: "validation",
      capabilities: [{ id: "compile", kind: "compile" }],
    } as const;
    expect(UnityWorkConfigV2Schema.safeParse(single).success).toBe(true);
    expect(
      UnityWorkConfigV2Schema.safeParse({
        ...single,
        capabilities: [
          { id: "compile", kind: "compile" },
          { id: "compile", kind: "compile" },
        ],
      }).success,
    ).toBe(false);

    expect(
      OrchestrationEventV5Schema.safeParse({
        schemaVersion: 5,
        eventId: randomUUID(),
        runId: randomUUID(),
        sequence: 1,
        timestamp: new Date(0).toISOString(),
        type: "workflow.started",
        payload: {
          mode: "unity-work-v3",
          config: artifactOf("workflow-config", "application/json"),
          task: artifactOf("task", "text/plain; charset=utf-8"),
          linkage: {
            workId: "work-a",
            poolId: "unity-editor-pool",
            priority: "interactive",
            capabilityCount: 1,
          },
        },
      }).success,
    ).toBe(true);
  });

  it("never gives user or path-unknown Editor observations ownership linkage", () => {
    const base = {
      schemaVersion: 1,
      editorId: randomUUID(),
      pid: 42,
      processIdentity: "win32:123",
      ownership: "unknown",
      state: "alive",
      pathObservation: "unavailable",
      observedAt: new Date(0).toISOString(),
    } as const;
    expect(UnityEditorObservationV1Schema.safeParse(base).success).toBe(true);
    expect(
      UnityEditorObservationV1Schema.safeParse({ ...base, ownerRunId: randomUUID() }).success,
    ).toBe(false);
    expect(
      UnityEditorObservationV1Schema.safeParse({
        ...base,
        ownership: "user",
        projectPath: "C:\\project",
        ownerWorkId: "work-a",
      }).success,
    ).toBe(false);
  });
});
