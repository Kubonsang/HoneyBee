import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { DesktopProjectProfile } from "../shared/ipc.js";
import { readProjectCatalog } from "./project-catalog.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const unityProject = async (root: string, name: string): Promise<string> => {
  const project = path.join(root, name);
  await Promise.all(
    ["Assets", "Packages", "ProjectSettings"].map((directory) =>
      mkdir(path.join(project, directory), { recursive: true }),
    ),
  );
  await writeFile(
    path.join(project, "ProjectSettings", "ProjectVersion.txt"),
    "m_EditorVersion: 6000.3.10f1\n",
    "utf8",
  );
  return project;
};

describe("readProjectCatalog", () => {
  it("combines Unity Hub projects with managed profiles and lets managed metadata win", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "honeybee-project-catalog-"));
    roots.push(root);
    const managedPath = await unityProject(root, "ManagedGame");
    const hubOnlyPath = await unityProject(root, "HubGame");
    await mkdir(path.join(root, "UnityHub"));
    await writeFile(
      path.join(root, "UnityHub", "projects-v1.json"),
      JSON.stringify({ data: { [managedPath]: {}, [hubOnlyPath]: {} } }),
      "utf8",
    );
    const managed = {
      schemaVersion: 1,
      profileId: "11111111-1111-4111-8111-111111111111",
      label: "Managed Label",
      projectPath: managedPath,
      batchConfigPath: path.join(root, "batch.json"),
      configLabel: "Managed",
      lastOpenedAt: "2026-08-31T00:00:00.000Z",
    } satisfies DesktopProjectProfile;

    const catalog = await readProjectCatalog(root, [managed]);
    expect(catalog.projects).toHaveLength(2);
    expect(catalog.projects[0]).toMatchObject({
      projectPath: managedPath,
      label: "Managed Label",
      source: "managed",
      profileId: managed.profileId,
      projectVersion: "6000.3.10f1",
    });
    expect(catalog.projects[1]).toMatchObject({ projectPath: hubOnlyPath, source: "unity-hub" });
  });
});
