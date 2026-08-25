import { describe, expect, it } from "vitest";

import {
  DesktopArtifactRequestV1Schema,
  DesktopPatchControlRequestV1Schema,
  DesktopProjectAddRequestV1Schema,
  DesktopRunRequestV1Schema,
  DesktopRuntimeSnapshotV1Schema,
  DesktopSetupDiscoveryRequestV1Schema,
  DesktopStartRequestV1Schema,
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
});
