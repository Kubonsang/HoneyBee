import { describe, expect, it } from "vitest";

import type { DesktopAgentProfileV1 } from "../shared/ipc.js";
import { cloneRunDraftFromConfig } from "./run-draft.js";

const agentId = "11111111-1111-4111-8111-111111111111";
const profileId = "22222222-2222-4222-8222-222222222222";
const runId = "33333333-3333-4333-8333-333333333333";

const agent: DesktopAgentProfileV1 = {
  schemaVersion: 1,
  agentId,
  displayName: "OpenCode",
  provider: "opencode",
  command: { command: "C:\\Tools\\opencode.exe", args: ["run", "--pure"] },
  adapter: "stdio-framed-v2",
  enabled: true,
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
};

const config = {
  schemaVersion: 2,
  sourceProjectPath: "C:\\Unity\\Fixture",
  workspaceStorage: {
    command: { command: "C:\\Tools\\storage.exe" },
    contractCommit: "575c3b37896cd3dfa37a4705477837cc52ec6132",
    binarySha256: "0".repeat(64),
    workspaceRoot: "D:\\HoneyBee",
    parentKey: {
      schemaVersion: 2,
      digest: "1".repeat(64),
      libraryKey: {
        schemaVersion: "1",
        digest: "2".repeat(64),
        unityVersion: "6000.0.0f1",
        unityExecutableSha256: "3".repeat(64),
        manifestSha256: "4".repeat(64),
        packagesLockSha256: "missing",
        projectSettingsSha256: "5".repeat(64),
        buildTarget: "windows/amd64",
        scriptingBackend: "Mono",
        projectIdentitySha256: "6".repeat(64),
      },
      provider: "vhdx-differencing",
      filesystem: "NTFS",
      virtualBytes: 68_719_476_736,
      blockBytes: 2_097_152,
      sectorBytes: 4096,
    },
  },
  agent: {
    command: agent.command,
    harness: "stdio-framed-v2",
    adapter: "stdio-framed-v2",
  },
  testplay: {
    command: { command: "C:\\Tools\\testplay.exe" },
    unityPath: "C:\\Unity\\Unity.exe",
    platform: "edit_mode",
    timeoutMs: 600_000,
    bridgeProtocolVersion: 3,
  },
  editorPool: {
    id: "unity-editors",
    capacity: 2,
    registrationTimeoutMs: 30_000,
    activationTimeoutMs: 120_000,
    bridgeReadyTimeoutMs: 120_000,
    capabilityTimeoutMs: 600_000,
    shutdownTimeoutMs: 120_000,
  },
  priority: "validation",
  capabilities: [
    { id: "compile", kind: "compile" },
    { id: "warm-test", kind: "warm-test", filter: "Smoke" },
  ],
};

describe("Run draft cloning", () => {
  it("restores a single Work without starting it", () => {
    expect(
      cloneRunDraftFromConfig({
        sourceRunId: runId,
        profileId,
        preferredAgentId: agentId,
        agents: [agent],
        config,
        task: "Fix player movement jitter",
        workId: "movement-jitter",
      }),
    ).toMatchObject({
      schemaVersion: 1,
      sourceRunId: runId,
      profileId,
      defaultAgentId: agentId,
      maxParallelWorks: 1,
      works: [
        {
          id: "movement-jitter",
          task: "Fix player movement jitter",
          priority: "validation",
          compile: true,
          warmTest: true,
          filter: "Smoke",
          agentId,
          agentLabel: "OpenCode",
        },
      ],
    });
  });

  it("marks a missing Agent explicitly instead of silently substituting one", () => {
    const draft = cloneRunDraftFromConfig({
      sourceRunId: runId,
      profileId,
      agents: [],
      config,
      task: "Fix player movement jitter",
    });
    expect(draft.defaultAgentId).toBeNull();
    expect(draft.works[0]).toMatchObject({
      agentId: null,
      agentLabel: "C:\\Tools\\opencode.exe",
    });
  });
});
