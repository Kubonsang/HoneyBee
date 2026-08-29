import { describe, expect, it } from "vitest";

import {
  DesktopArtifactRequestV1Schema,
  DesktopDeveloperSettingsV1Schema,
  DesktopClonedRunDraftV1Schema,
  DesktopCloneRunDraftRequestV1Schema,
  DesktopDogfoodFinalizeRequestV1Schema,
  DesktopDogfoodStartRequestV1Schema,
  DesktopPatchControlRequestV1Schema,
  DesktopProjectAddRequestV1Schema,
  DesktopProjectAddRequestV2Schema,
  DesktopRunRequestV1Schema,
  DesktopRuntimeSnapshotV1Schema,
  DesktopSetupDiscoveryRequestV1Schema,
  DesktopStartRequestV1Schema,
  DesktopStartRequestV2Schema,
  HoneyBeeCompatibilityManifestV1Schema,
} from "./ipc.js";

describe("Desktop IPC contracts", () => {
  it("rejects unknown renderer fields and accepts Agent-only Work", () => {
    const request = {
      schemaVersion: 1,
      profileId: "00000000-0000-4000-8000-000000000001",
      maxParallelWorks: 1,
      works: [
        {
          id: "work-1",
          task: "Change the scene",
          priority: "validation",
          capabilities: [{ id: "compile", kind: "compile" }],
          prompt: "unexpected",
        },
      ],
    };

    expect(DesktopStartRequestV1Schema.safeParse(request).success).toBe(false);
    expect(
      DesktopStartRequestV1Schema.safeParse({
        schemaVersion: 1,
        profileId: request.profileId,
        maxParallelWorks: 1,
        works: [
          {
            id: "work-1",
            task: "Change the scene",
            priority: "validation",
            capabilities: [],
          },
        ],
      }).success,
    ).toBe(true);
  });

  it("validates Run and Artifact identifiers before they cross IPC", () => {
    const runId = "00000000-0000-4000-8000-000000000001";
    const artifactId = "00000000-0000-4000-8000-000000000002";

    expect(DesktopRunRequestV1Schema.safeParse({ schemaVersion: 1, runId }).success).toBe(true);
    expect(
      DesktopRunRequestV1Schema.safeParse({ schemaVersion: 1, runId, rawPath: ".." }).success,
    ).toBe(false);
    expect(DesktopRunRequestV1Schema.safeParse({ schemaVersion: 1, runId: ".." }).success).toBe(
      false,
    );
    expect(
      DesktopArtifactRequestV1Schema.safeParse({ schemaVersion: 1, runId, artifactId }).success,
    ).toBe(true);
    expect(
      DesktopPatchControlRequestV1Schema.safeParse({
        schemaVersion: 1,
        runId,
        patchArtifactId: artifactId,
        action: "apply",
      }).success,
    ).toBe(true);
    expect(
      DesktopPatchControlRequestV1Schema.safeParse({
        schemaVersion: 1,
        runId,
        patchArtifactId: artifactId,
        action: "delete",
      }).success,
    ).toBe(false);
    expect(DesktopCloneRunDraftRequestV1Schema.safeParse({ schemaVersion: 1, runId }).success).toBe(
      true,
    );
    expect(
      DesktopCloneRunDraftRequestV1Schema.safeParse({
        schemaVersion: 1,
        runId,
        autoStart: true,
      }).success,
    ).toBe(false);
  });

  it("keeps cloned Run drafts explicit about unavailable Agents", () => {
    const value = {
      schemaVersion: 1,
      sourceRunId: "00000000-0000-4000-8000-000000000001",
      profileId: "00000000-0000-4000-8000-000000000002",
      defaultAgentId: null,
      maxParallelWorks: 1,
      works: [
        {
          id: "work-1",
          task: "Fix player movement jitter",
          priority: "validation",
          compile: true,
          warmTest: true,
          filter: "Smoke",
          agentId: null,
          agentLabel: "retired-agent.exe",
        },
      ],
    };
    expect(DesktopClonedRunDraftV1Schema.safeParse(value).success).toBe(true);
    expect(
      DesktopClonedRunDraftV1Schema.safeParse({
        ...value,
        works: [{ ...value.works[0], autoStart: true }],
      }).success,
    ).toBe(false);
  });

  it("requires a global default Agent and permits a per-Work override", () => {
    const defaultAgentId = "00000000-0000-4000-8000-000000000010";
    const overrideAgentId = "00000000-0000-4000-8000-000000000011";
    expect(
      DesktopStartRequestV2Schema.safeParse({
        schemaVersion: 2,
        profileId: "00000000-0000-4000-8000-000000000001",
        defaultAgentId,
        maxParallelWorks: 2,
        works: [
          { id: "work-a", task: "A", priority: "interactive", capabilities: [] },
          {
            id: "work-b",
            task: "B",
            priority: "background",
            capabilities: [],
            agentId: overrideAgentId,
          },
        ],
      }).success,
    ).toBe(true);
  });

  it("keeps runtime snapshots strict at nested resource boundaries", () => {
    const snapshot = {
      schemaVersion: 1,
      observedAt: new Date(0).toISOString(),
      runs: [],
      editors: { schemaVersion: 1, editors: [] },
      pool: {
        schemaVersion: 1,
        poolId: "unity-editor",
        capacity: 1,
        active: [],
        queued: [],
      },
    };

    expect(DesktopRuntimeSnapshotV1Schema.safeParse(snapshot).success).toBe(true);
    expect(
      DesktopRuntimeSnapshotV1Schema.safeParse({
        ...snapshot,
        pool: { ...snapshot.pool, ownerPid: 1234 },
      }).success,
    ).toBe(false);
  });

  it("keeps Add Project strict and never accepts storage configuration from the renderer", () => {
    expect(
      DesktopSetupDiscoveryRequestV1Schema.safeParse({
        schemaVersion: 1,
        projectPath: "C:\\Project",
        typo: true,
      }).success,
    ).toBe(false);

    const request = {
      schemaVersion: 1,
      projectPath: "C:\\Project",
      unityPath: "C:\\Unity\\Unity.exe",
      agent: { command: "C:\\Tools\\opencode.exe" },
    } as const;
    expect(DesktopProjectAddRequestV1Schema.safeParse(request).success).toBe(true);
    expect(
      DesktopProjectAddRequestV1Schema.safeParse({ ...request, workspaceRoot: "C:\\Workspaces" })
        .success,
    ).toBe(false);
    expect(
      DesktopProjectAddRequestV1Schema.safeParse({
        ...request,
        workspaceStorageVersion: "1.0.0",
      }).success,
    ).toBe(false);
    expect(
      DesktopProjectAddRequestV2Schema.safeParse({
        schemaVersion: 2,
        projectPath: request.projectPath,
        unityPath: request.unityPath,
        preferredAgentId: "00000000-0000-4000-8000-000000000010",
      }).success,
    ).toBe(true);
    expect(
      DesktopProjectAddRequestV1Schema.safeParse({
        ...request,
        agent: { ...request.agent, env: { SECRET: "not-allowed" } },
      }).success,
    ).toBe(false);
  });

  it("accepts only fixed Component Manager IDs and releases", () => {
    const payloads = [
      {
        role: "client",
        source: "bundled",
        fileName: "client.exe",
        byteLength: 1,
        sha256: "a".repeat(64),
        archive: "none",
      },
      {
        role: "host",
        source: "bundled",
        fileName: "host.exe",
        byteLength: 1,
        sha256: "b".repeat(64),
        archive: "none",
      },
    ];
    const manifest = {
      schemaVersion: 1,
      honeybeeVersion: "0.6.0",
      workspaceStorage: [
        {
          componentId: "workspace-storage",
          version: "1.0.0",
          honeybeeVersion: "0.6.0",
          platform: "win32",
          architecture: "x64",
          payloads,
        },
      ],
      testplay: [],
    };
    expect(HoneyBeeCompatibilityManifestV1Schema.safeParse(manifest).success).toBe(true);
    expect(
      HoneyBeeCompatibilityManifestV1Schema.safeParse({
        ...manifest,
        marketplace: "https://untrusted.example",
      }).success,
    ).toBe(false);
  });

  it("keeps Developer and dogfood session controls strict", () => {
    const profileId = "00000000-0000-4000-8000-000000000001";
    const sessionId = "00000000-0000-4000-8000-000000000002";
    expect(
      DesktopDeveloperSettingsV1Schema.safeParse({
        schemaVersion: 1,
        dogfoodMetricsEnabled: true,
      }).success,
    ).toBe(true);
    expect(
      DesktopDeveloperSettingsV1Schema.safeParse({
        schemaVersion: 1,
        dogfoodMetricsEnabled: true,
        automaticUpload: true,
      }).success,
    ).toBe(false);
    expect(
      DesktopDogfoodStartRequestV1Schema.safeParse({ schemaVersion: 1, profileId }).success,
    ).toBe(true);
    expect(
      DesktopDogfoodFinalizeRequestV1Schema.safeParse({ schemaVersion: 1, sessionId }).success,
    ).toBe(true);
    expect(
      DesktopDogfoodFinalizeRequestV1Schema.safeParse({
        schemaVersion: 1,
        sessionId,
        evidencePath: "C:\\outside",
      }).success,
    ).toBe(false);
  });
});
