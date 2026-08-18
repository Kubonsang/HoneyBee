import { describe, expect, it } from "vitest";

import {
  DesktopArtifactRequestV1Schema,
  DesktopRunRequestV1Schema,
  DesktopRuntimeSnapshotV1Schema,
  DesktopStartRequestV1Schema,
} from "./ipc.js";

describe("Desktop IPC contracts", () => {
  it("rejects unknown renderer fields and invalid capability selections", () => {
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
    ).toBe(false);
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
});
