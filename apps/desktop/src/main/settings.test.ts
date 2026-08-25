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
    expect(JSON.parse(await readFile(path.join(root, "settings-v2.json"), "utf8"))).toEqual({
      schemaVersion: 2,
      profiles: [newer, older],
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
});
