import { describe, expect, it } from "vitest";

import {
  DesktopArtifactRequestV1Schema,
  DesktopPatchControlRequestV1Schema,
  DesktopRunRequestV1Schema,
  DesktopRuntimeSnapshotV1Schema,
  DesktopSetupDiscoveryRequestV1Schema,
  DesktopSetupDraftV1Schema,
  DesktopStartRequestV1Schema,
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

  it("keeps Setup requests strict at every renderer boundary", () => {
    expect(
      DesktopSetupDiscoveryRequestV1Schema.safeParse({
        schemaVersion: 1,
        projectPath: "C:\\Project",
        typo: true,
      }).success,
    ).toBe(false);

    const draft = {
      schemaVersion: 1,
      label: "Game",
      projectPath: "C:\\Project",
      unityPath: "C:\\Unity\\Unity.exe",
      testplayPath: "C:\\Tools\\testplay.exe",
      workspaceStoragePath: "C:\\Tools\\unity-workspace-storage.exe",
      workspaceRoot: "C:\\Workspaces",
      bridgeOverlayPath: "C:\\Tools\\com.testplay.bridge",
      agent: { command: "C:\\Tools\\opencode.exe" },
      editorCapacity: 2,
    } as const;
    expect(DesktopSetupDraftV1Schema.safeParse(draft).success).toBe(true);
    expect(
      DesktopSetupDraftV1Schema.safeParse({
        schemaVersion: 1,
        label: "Agent only",
        projectPath: "C:\\Project",
        unityPath: "C:\\Unity\\Unity.exe",
        workspaceStoragePath: "C:\\HoneyBee\\unity-workspace-storage.exe",
        workspaceRoot: "C:\\Workspaces",
        agent: { command: "C:\\Tools\\opencode.exe" },
        editorCapacity: 1,
      }).success,
    ).toBe(true);
    expect(
      DesktopSetupDraftV1Schema.safeParse({
        ...draft,
        bridgeOverlayPath: undefined,
      }).success,
    ).toBe(false);
    expect(
      DesktopSetupDraftV1Schema.safeParse({
        ...draft,
        agent: { ...draft.agent, env: { SECRET: "not-allowed" } },
      }).success,
    ).toBe(false);
    expect(DesktopSetupDraftV1Schema.safeParse({ ...draft, assetsDigest: "ignored" }).success).toBe(
      false,
    );
  });
});
