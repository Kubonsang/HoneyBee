import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DesktopSettingsStore } from "./settings.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const temporaryRoot = async (): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), "honeybee-desktop-settings-"));
  roots.push(root);
  return root;
};

const profile = (lastOpenedAt: string, label: string) => ({
  schemaVersion: 1 as const,
  profileId: randomUUID(),
  label,
  projectPath: `C:/${label}`,
  batchConfigPath: `C:/${label}/batch.json`,
  configLabel: "batch",
  lastOpenedAt,
});

describe("DesktopSettingsStore", () => {
  it("persists bounded recent profiles with atomic JSON replacement", async () => {
    const root = await temporaryRoot();
    const store = new DesktopSettingsStore(root);
    const older = profile(new Date(1).toISOString(), "Older");
    const newer = profile(new Date(2).toISOString(), "Newer");

    expect(await store.listProfiles()).toEqual([]);
    await store.upsertProfile(older);
    await store.upsertProfile(newer);
    expect(await store.listProfiles()).toEqual([newer, older]);
    expect(JSON.parse(await readFile(path.join(root, "settings-v5.json"), "utf8"))).toEqual({
      schemaVersion: 5,
      profiles: [newer, older],
      agents: [],
      preferredAgentIds: {},
      developer: {
        schemaVersion: 1,
        dogfoodMetricsEnabled: false,
        rawAgentProtocolEnabled: false,
      },
    });

    await store.removeProfile(newer.profileId);
    expect(await store.listProfiles()).toEqual([older]);
  });

  it("fails closed on unknown settings fields", async () => {
    const root = await temporaryRoot();
    await writeFile(
      path.join(root, "settings-v2.json"),
      JSON.stringify({ schemaVersion: 2, profiles: [], typo: true }),
      "utf8",
    );
    await expect(new DesktopSettingsStore(root).listProfiles()).rejects.toThrow(
      "Desktop settings are invalid",
    );
  });

  it("reads existing settings v1 profiles without mutating the legacy file", async () => {
    const root = await temporaryRoot();
    const legacy = profile(new Date(3).toISOString(), "Legacy");
    await writeFile(
      path.join(root, "settings-v1.json"),
      JSON.stringify({ schemaVersion: 1, profiles: [legacy] }),
      "utf8",
    );
    expect(await new DesktopSettingsStore(root).listProfiles()).toEqual([legacy]);
    expect(JSON.parse(await readFile(path.join(root, "settings-v1.json"), "utf8"))).toEqual({
      schemaVersion: 1,
      profiles: [legacy],
    });
  });

  it("migrates settings v3 and persists developer toggles in settings v5", async () => {
    const root = await temporaryRoot();
    const legacy = profile(new Date(3).toISOString(), "V3");
    await writeFile(
      path.join(root, "settings-v3.json"),
      JSON.stringify({
        schemaVersion: 3,
        profiles: [legacy],
        agents: [],
        preferredAgentIds: {},
      }),
      "utf8",
    );
    const store = new DesktopSettingsStore(root);
    expect(await store.developerSettings()).toEqual({
      schemaVersion: 1,
      dogfoodMetricsEnabled: false,
      rawAgentProtocolEnabled: false,
    });
    await store.updateDeveloperSettings({
      schemaVersion: 1,
      dogfoodMetricsEnabled: true,
      rawAgentProtocolEnabled: true,
    });
    const persisted = JSON.parse(await readFile(path.join(root, "settings-v5.json"), "utf8"));
    expect(persisted.developer).toEqual({
      schemaVersion: 1,
      dogfoodMetricsEnabled: true,
      rawAgentProtocolEnabled: true,
    });
    expect(await store.listProfiles()).toEqual([legacy]);
  });

  it("migrates settings v4 with Raw Agent Protocol disabled", async () => {
    const root = await temporaryRoot();
    await writeFile(
      path.join(root, "settings-v4.json"),
      JSON.stringify({
        schemaVersion: 4,
        profiles: [],
        agents: [],
        preferredAgentIds: {},
        developer: { schemaVersion: 1, dogfoodMetricsEnabled: true },
      }),
      "utf8",
    );
    const store = new DesktopSettingsStore(root);
    expect(await store.developerSettings()).toEqual({
      schemaVersion: 1,
      dogfoodMetricsEnabled: true,
      rawAgentProtocolEnabled: false,
    });
  });

  it("keeps one managed environment per Unity project when Project Settings is reapplied", async () => {
    const root = await temporaryRoot();
    const store = new DesktopSettingsStore(root);
    const managed = (id: string, configuredAt: string) => ({
      schemaVersion: 3 as const,
      profileId: id,
      label: "Game",
      projectPath: "C:\\Game",
      batchConfigPath: `C:\\HoneyBee\\${id}.json`,
      configLabel: "Managed components",
      lastOpenedAt: configuredAt,
      environment: {
        schemaVersion: 2 as const,
        environmentId: id,
        projectPath: "C:\\Game",
        unity: { path: "C:\\Unity\\Unity.exe", version: "6000.0.1f1", sha256: "a".repeat(64) },
        storage: {
          component: {
            schemaVersion: 1 as const,
            componentId: "workspace-storage" as const,
            version: "1.0.0",
            receiptDigest: "b".repeat(64),
            files: [
              {
                role: "client" as const,
                path: "C:\\client.exe",
                kind: "file" as const,
                byteLength: 1,
                sha256: "c".repeat(64),
              },
              {
                role: "host" as const,
                path: "C:\\host.exe",
                kind: "file" as const,
                byteLength: 1,
                sha256: "d".repeat(64),
              },
            ],
          },
          workspaceRoot: "C:\\Workspaces",
          provider: "vhdx",
          parentId: "vhdx:parent",
          compatibilityKey: "e".repeat(64),
        },
        agent: { command: "opencode" },
        editorPool: { id: "unity-editor" as const, capacity: 2 },
        compatibilityInputs: {
          schemaVersion: 1 as const,
          unityVersion: "6000.0.1f1",
          unityExecutableSha256: "a".repeat(64),
          packagesManifestSha256: "f".repeat(64),
          packagesLockSha256: "missing" as const,
          projectSettingsManifestSha256: "1".repeat(64),
          buildTarget: "StandaloneWindows64" as const,
          scriptingBackend: "Mono2x",
        },
        configuredAt,
      },
    });
    const first = managed("00000000-0000-4000-8000-000000000011", new Date(4).toISOString());
    const second = managed("00000000-0000-4000-8000-000000000012", new Date(5).toISOString());
    await store.upsertProfile(first);
    await store.upsertProfile(second);
    expect(await store.listProfiles()).toEqual([second]);

    const legacyRoot = await temporaryRoot();
    await writeFile(
      path.join(legacyRoot, "settings-v2.json"),
      JSON.stringify({ schemaVersion: 2, profiles: [second] }),
      "utf8",
    );
    const migrated = await new DesktopSettingsStore(legacyRoot).snapshot();
    expect(migrated.agents).toHaveLength(1);
    expect(migrated.agents[0]).toMatchObject({
      provider: "opencode",
      command: { command: "opencode" },
    });
    expect(migrated.preferredAgentIds[second.profileId]).toBe(migrated.agents[0]?.agentId);
  });

  it("serializes concurrent mutations across stores for the same settings path", async () => {
    const root = await temporaryRoot();
    const profiles = new DesktopSettingsStore(root);
    const agents = new DesktopSettingsStore(root);
    const project = profile(new Date(6).toISOString(), "Concurrent");
    await Promise.all([
      profiles.upsertProfile(project),
      agents.upsertAgent({
        schemaVersion: 1,
        displayName: "Concurrent Agent",
        provider: "custom",
        command: { command: process.execPath },
        adapter: "stdio-framed-v2",
        enabled: true,
      }),
    ]);
    const snapshot = await new DesktopSettingsStore(root).snapshot();
    expect(snapshot.profiles).toEqual([project]);
    expect(snapshot.agents).toHaveLength(1);
    expect(snapshot.agents[0]?.displayName).toBe("Concurrent Agent");
  });

  it("continues processing settings mutations after a rejected operation", async () => {
    const root = await temporaryRoot();
    const store = new DesktopSettingsStore(root);
    await expect(store.setPreferredAgent(randomUUID(), randomUUID())).rejects.toThrow(
      "Project profile was not found",
    );
    const next = profile(new Date(7).toISOString(), "AfterFailure");
    await store.upsertProfile(next);
    await expect(store.listProfiles()).resolves.toEqual([next]);
  });
});
