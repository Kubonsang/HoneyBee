import { describe, expect, it } from "vitest";

import { UnityBatchConfigV3Schema, UnityBatchConfigV4Schema } from "@honeybee/core";

import { prepareDirectUnityBatchConfig } from "./direct-unity-config.js";

const batch = () =>
  UnityBatchConfigV3Schema.parse({
    schemaVersion: 3,
    mode: "unity-batch",
    resourceScope: "global-editor-pool-v2",
    maxParallelWorks: 2,
    transaction: {
      schemaVersion: 1,
      sourceProjectPath: "C:\\UnityProject",
      workspaceStorage: {
        command: { command: process.execPath },
        contractCommit: "575c3b37896cd3dfa37a4705477837cc52ec6132",
        binarySha256: "b".repeat(64),
        workspaceRoot: "C:\\HoneyBeeWorkspaces",
        parentKey: {
          schemaVersion: 2,
          digest: "c".repeat(64),
          libraryKey: {
            schemaVersion: "1",
            digest: "d".repeat(64),
            unityVersion: "6000.0.0f1",
            unityExecutableSha256: "e".repeat(64),
            manifestSha256: "f".repeat(64),
            packagesLockSha256: "missing",
            projectSettingsSha256: "1".repeat(64),
            buildTarget: "windows/amd64",
            scriptingBackend: "Mono",
            projectIdentitySha256: "2".repeat(64),
          },
          provider: "vhdx-differencing",
          filesystem: "NTFS",
          virtualBytes: 1_073_741_824,
          blockBytes: 2_097_152,
          sectorBytes: 4096,
        },
      },
      agent: {
        command: { command: process.execPath },
        harness: "stdio-framed-v2",
      },
    },
    editorPool: {
      id: "unity-editor-pool",
      capacity: 1,
      registrationTimeoutMs: 1000,
      activationTimeoutMs: 1000,
      bridgeReadyTimeoutMs: 1000,
      capabilityTimeoutMs: 1000,
      shutdownTimeoutMs: 1000,
    },
    works: [
      { id: "work-a", task: "A", priority: "interactive", capabilities: [] },
      { id: "work-b", task: "B", priority: "background", capabilities: [] },
    ],
  });

describe("direct Unity config preparation", () => {
  it("pins a v3 transaction Agent without leaking runtime-only fields into the strict schema", async () => {
    const prepared = await prepareDirectUnityBatchConfig(batch());
    expect(prepared.transaction.agent.trust).toBeDefined();
    expect("adapter" in prepared.transaction.agent).toBe(false);
    expect(UnityBatchConfigV3Schema.safeParse(prepared).success).toBe(true);
  });

  it("pins both the fallback and per-Work Agents in v4", async () => {
    const base = batch();
    const prepared = await prepareDirectUnityBatchConfig(
      UnityBatchConfigV4Schema.parse({
        ...base,
        schemaVersion: 4,
        works: base.works.map((work) => ({
          ...work,
          agent: { command: { command: process.execPath }, harness: "stdio-framed-v2" },
        })),
      }),
    );
    expect(prepared.transaction.agent.trust).toBeDefined();
    expect(prepared.works.every((work) => work.agent.trust !== undefined)).toBe(true);
  });
});
