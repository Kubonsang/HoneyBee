import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { loadUnityBatchConfig, loadUnityWorkConfig, loadWorkflowConfig } from "./config.js";

const withConfig = async (value: unknown, run: (path: string) => Promise<void>): Promise<void> => {
  const directory = await mkdtemp(path.join(tmpdir(), "honeybee-config-"));
  const configPath = path.join(directory, "agents.json");
  await writeFile(configPath, JSON.stringify(value), "utf8");
  try {
    await run(configPath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

describe("loadWorkflowConfig", () => {
  it("maps schemaVersion 1 producer/reviewer config to a canonical v3 linear DAG", async () => {
    const previous = process.env.HONEYBEE_TEST_APPDATA;
    process.env.HONEYBEE_TEST_APPDATA = "C:\\Agent Home";
    try {
      await withConfig(
        {
          schemaVersion: 1,
          producer: { command: "codex" },
          reviewer: {
            command: "${HONEYBEE_TEST_APPDATA}\\npm\\opencode.exe",
            cwd: ".",
          },
        },
        async (configPath) => {
          const config = await loadWorkflowConfig(configPath);
          expect(config.schemaVersion).toBe(3);
          expect(config.harnesses).toEqual([
            { id: "stdio", kind: "stdio-framed-v1", protocolVersion: 1 },
          ]);
          expect(config.steps.map((step) => step.id)).toEqual(["producer", "reviewer"]);
          expect(config.agents[1]?.command).toBe("C:\\Agent Home\\npm\\opencode.exe");
          expect(config.agents[1]?.cwd).toBe(path.dirname(configPath));
          expect(config.steps[1]).toMatchObject({ needs: ["producer"] });
          expect(config.outputs).toEqual({
            result: { from: { stepId: "reviewer", output: "content" } },
          });
        },
      );
    } finally {
      if (previous === undefined) delete process.env.HONEYBEE_TEST_APPDATA;
      else process.env.HONEYBEE_TEST_APPDATA = previous;
    }
  });

  it("strictly validates v2 step IDs and duplicates", async () => {
    await withConfig(
      {
        schemaVersion: 2,
        steps: [
          { id: "same", agent: { command: "a" } },
          { id: "same", agent: { command: "b" } },
        ],
      },
      async (configPath) => expect(loadWorkflowConfig(configPath)).rejects.toThrow("Duplicate"),
    );
    await withConfig(
      {
        schemaVersion: 2,
        steps: [
          { id: "Bad", agent: { command: "a" } },
          { id: "good", agent: { command: "b" } },
        ],
      },
      async (configPath) => expect(loadWorkflowConfig(configPath)).rejects.toThrow("Invalid"),
    );
  });

  it.each([
    [
      "root",
      {
        schemaVersion: 2,
        unexpected: true,
        steps: [
          { id: "first", agent: { command: "a" } },
          { id: "second", agent: { command: "b" } },
        ],
      },
    ],
    [
      "step",
      {
        schemaVersion: 2,
        steps: [
          { id: "first", agent: { command: "a" }, unexpected: true },
          { id: "second", agent: { command: "b" } },
        ],
      },
    ],
    [
      "agent",
      {
        schemaVersion: 2,
        steps: [
          { id: "first", agent: { command: "a", unexpected: true } },
          { id: "second", agent: { command: "b" } },
        ],
      },
    ],
  ] as const)("rejects unknown v2 %s fields before normalization", async (_scope, candidate) => {
    await withConfig(candidate, async (configPath) =>
      expect(loadWorkflowConfig(configPath)).rejects.toThrow("Invalid schemaVersion 2 config"),
    );
  });

  it("loads strict v3 Agent/Harness registries and rejects nested unknown fields", async () => {
    const candidate = {
      schemaVersion: 3,
      agents: [{ id: "worker", command: "agent", cwd: "." }],
      harnesses: [{ id: "stdio", kind: "stdio-framed-v2", protocolVersion: 2 }],
      steps: [
        {
          id: "worker",
          type: "agent",
          agentRef: "worker",
          harnessRef: "stdio",
          outputs: { content: { mediaType: "text/plain; charset=utf-8" } },
        },
      ],
      maxParallelism: 2,
    };
    await withConfig(candidate, async (configPath) => {
      const loaded = await loadWorkflowConfig(configPath);
      expect(loaded.schemaVersion).toBe(3);
      expect(loaded.agents[0]?.cwd).toBe(path.dirname(configPath));
      expect(loaded.maxParallelism).toBe(2);
    });
    await withConfig(
      { ...candidate, steps: [{ ...candidate.steps[0], typo: true }] },
      async (configPath) =>
        expect(loadWorkflowConfig(configPath)).rejects.toThrow("Invalid schemaVersion 3 config"),
    );
  });
});

describe("loadUnityWorkConfig", () => {
  const candidate = (directory: string) => ({
    schemaVersion: 1,
    sourceProjectPath: path.join(directory, "source"),
    workspaceStorage: {
      command: { command: process.execPath },
      contractCommit: "575c3b37896cd3dfa37a4705477837cc52ec6132",
      binarySha256: "0".repeat(64),
      workspaceRoot: path.join(directory, "workspaces"),
      parentKey: {
        schemaVersion: 2,
        digest: "a".repeat(64),
        libraryKey: {
          schemaVersion: "1",
          digest: "b".repeat(64),
          unityVersion: "6000.0.0f1",
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
        virtualBytes: 1073741824,
        blockBytes: 2097152,
        sectorBytes: 4096,
      },
    },
    agent: {
      command: { command: "opencode" },
      harness: "stdio-framed-v2",
    },
    testplay: {
      command: { command: "testplay" },
      unityPath: path.join(directory, "Unity.exe"),
      platform: "edit_mode",
      timeoutMs: 300000,
    },
  });

  it("loads exactly one strict Unity Agent transaction config", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "honeybee-unity-config-"));
    try {
      await withConfig(candidate(directory), async (configPath) => {
        const config = await loadUnityWorkConfig(configPath);
        expect(config.agent.harness).toBe("stdio-framed-v2");
        expect(config.workspaceStorage.parentKey.provider).toBe("vhdx-differencing");
        expect(config.sourceProjectPath).toBe(path.join(directory, "source"));
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects unknown fields and relative transaction paths", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "honeybee-unity-config-"));
    try {
      await withConfig(
        { ...candidate(directory), scheduler: { maxParallelism: 2 } },
        async (configPath) =>
          expect(loadUnityWorkConfig(configPath)).rejects.toThrow("Invalid Unity work"),
      );
      await withConfig(
        { ...candidate(directory), sourceProjectPath: "relative-project" },
        async (configPath) =>
          expect(loadUnityWorkConfig(configPath)).rejects.toThrow("absolute path"),
      );
      for (const command of [
        { command: process.execPath, args: ["storage.mjs"] },
        { command: process.execPath, env: { NODE_OPTIONS: "--require=storage.cjs" } },
      ]) {
        const withUnpinnedStorage = candidate(directory);
        await withConfig(
          {
            ...withUnpinnedStorage,
            workspaceStorage: { ...withUnpinnedStorage.workspaceStorage, command },
          },
          async (configPath) => expect(loadUnityWorkConfig(configPath)).rejects.toThrow(/pinned/u),
        );
      }
      const withLocalPackages = candidate(directory);
      await withConfig(
        {
          ...withLocalPackages,
          workspaceStorage: {
            ...withLocalPackages.workspaceStorage,
            parentKey: {
              ...withLocalPackages.workspaceStorage.parentKey,
              localPackagesDigest: "1".repeat(64),
            },
          },
        },
        async (configPath) =>
          expect(loadUnityWorkConfig(configPath)).rejects.toThrow(
            "does not stage external local packages",
          ),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects overlapping source and broker workspace roots", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "honeybee-unity-config-"));
    try {
      const config = candidate(directory);
      await withConfig(
        {
          ...config,
          workspaceStorage: {
            ...config.workspaceStorage,
            workspaceRoot: path.join(config.sourceProjectPath, ".workspaces"),
          },
        },
        async (configPath) =>
          expect(loadUnityWorkConfig(configPath)).rejects.toThrow("must be disjoint"),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects physical overlap hidden behind a directory link", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "honeybee-unity-config-link-"));
    try {
      const config = candidate(directory);
      const physicalWorkspace = path.join(config.sourceProjectPath, ".workspaces");
      const workspaceAlias = path.join(directory, "workspace-alias");
      await mkdir(physicalWorkspace, { recursive: true });
      await symlink(
        physicalWorkspace,
        workspaceAlias,
        process.platform === "win32" ? "junction" : "dir",
      );
      await withConfig(
        {
          ...config,
          workspaceStorage: {
            ...config.workspaceStorage,
            workspaceRoot: workspaceAlias,
          },
        },
        async (configPath) =>
          expect(loadUnityWorkConfig(configPath)).rejects.toThrow("must be disjoint"),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("loads a strict Unity batch and rejects duplicate or unknown resource references", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "honeybee-unity-batch-config-"));
    const batch = {
      schemaVersion: 1,
      mode: "unity-batch",
      maxParallelWorks: 2,
      transaction: candidate(directory),
      resources: [{ id: "unity-editor", capacity: 1 }],
      works: [
        { id: "work-a", task: "A", resourceRef: "unity-editor" },
        { id: "work-b", task: "B", resourceRef: "unity-editor" },
      ],
    } as const;
    try {
      await withConfig(batch, async (configPath) => {
        const config = await loadUnityBatchConfig(configPath);
        expect(config.works.map((work) => work.id)).toEqual(["work-a", "work-b"]);
        expect(config.transaction.sourceProjectPath).toBe(path.join(directory, "source"));
      });
      await withConfig(
        { ...batch, schemaVersion: 2, resourceScope: "global-file-v1" },
        async (configPath) => {
          const config = await loadUnityBatchConfig(configPath);
          expect(config.schemaVersion).toBe(2);
          expect("resourceScope" in config ? config.resourceScope : undefined).toBe(
            "global-file-v1",
          );
          expect(config.transaction.sourceProjectPath).toBe(path.join(directory, "source"));
        },
      );
      await withConfig({ ...batch, schemaVersion: 2 }, async (configPath) =>
        expect(loadUnityBatchConfig(configPath)).rejects.toThrow("Invalid Unity batch"),
      );
      await withConfig({ ...batch, typo: true }, async (configPath) =>
        expect(loadUnityBatchConfig(configPath)).rejects.toThrow("Invalid Unity batch"),
      );
      await withConfig(
        {
          ...batch,
          works: [batch.works[0], { id: "work-b", task: "B", resourceRef: "missing" }],
        },
        async (configPath) =>
          expect(loadUnityBatchConfig(configPath)).rejects.toThrow("Unknown resource reference"),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
