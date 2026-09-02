import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { WorkspaceRegistryStore } from "./workspace-registry.js";
import type { ProjectRecordV2, WorkspaceRecordV2 } from "./workspace-types.js";

const roots: string[] = [];

const project: ProjectRecordV2 = {
  schemaVersion: 2,
  projectId: "project",
  label: "Project",
  unityProjectPath: "C:\\project",
  repositoryRoot: "C:\\project",
  unityRelativePath: ".",
  workspaceRoot: "C:\\workspaces",
  storageCommand: "C:\\tools\\storage.exe",
  createdAt: "2026-09-02T00:00:00.000Z",
};

const workspace = (index: number): WorkspaceRecordV2 => ({
  schemaVersion: 2,
  layout: "git-worktree-library-cow-v1",
  workspaceId: `workspace-${index}`,
  projectId: "project",
  name: `work-${index}`,
  workspacePath: path.join("C:\\workspaces", String(index)),
  storageWorkspaceId: `storage-${index}`,
  storageWorkspacePath: path.join("C:\\storage", String(index)),
  mountPath: path.join("C:\\storage", String(index), "Library"),
  consumerId: `consumer-${index}`,
  leaseId: `lease-${index}`,
  parentId: "parent",
  branch: `work/${index}`,
  baseCommit: "a".repeat(40),
  state: "ready",
  createdAt: "2026-09-02T00:00:00.000Z",
  updatedAt: "2026-09-02T00:00:00.000Z",
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("WorkspaceRegistryStore", () => {
  it("serializes concurrent read-modify-write updates across store instances", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "honeybee-workspace-registry-"));
    roots.push(root);
    const stores = Array.from({ length: 12 }, () => new WorkspaceRegistryStore(root));
    await stores[0]?.putProject(project);

    await Promise.all(stores.map((store, index) => store.putWorkspace(workspace(index))));

    const registry = await stores[0]?.read();
    expect(registry?.workspaces).toHaveLength(stores.length);
    expect(new Set(registry?.workspaces.map((item) => item.workspaceId))).toEqual(
      new Set(stores.map((_, index) => `workspace-${index}`)),
    );
  }, 30_000);

  it("migrates compatible Library-only v1 data without overwriting the rollback file", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "honeybee-workspace-registry-"));
    roots.push(root);
    const legacyPath = path.join(root, "workspace-registry-v1.json");
    const legacy = JSON.stringify({
      schemaVersion: 1,
      projects: [
        {
          ...project,
          schemaVersion: 1,
          cache: {
            kind: "library-only-v1",
            parentId: "parent",
            seedCommit: "a".repeat(40),
            preparedAt: "2026-09-02T00:00:00.000Z",
          },
        },
      ],
      workspaces: [{ ...workspace(1), schemaVersion: 1 }],
      tools: { codex: { command: "removed" } },
    });
    await writeFile(legacyPath, legacy, "utf8");
    const store = new WorkspaceRegistryStore(root);

    const migrated = await store.read();
    expect(migrated.schemaVersion).toBe(2);
    expect(migrated.projects[0]?.schemaVersion).toBe(2);
    expect(migrated.workspaces[0]?.schemaVersion).toBe(2);
    expect(migrated).not.toHaveProperty("tools");

    await store.putWorkspace(workspace(2));
    expect(await readFile(legacyPath, "utf8")).toBe(legacy);
    const persisted = JSON.parse(await readFile(store.path, "utf8")) as { schemaVersion: number };
    expect(persisted.schemaVersion).toBe(2);
  });

  it("rejects Full-project v1 records instead of guessing their ownership", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "honeybee-workspace-registry-"));
    roots.push(root);
    await writeFile(
      path.join(root, "workspace-registry-v1.json"),
      JSON.stringify({
        schemaVersion: 1,
        projects: [{ ...project, schemaVersion: 1 }],
        workspaces: [{ ...workspace(1), schemaVersion: 1, layout: "full-project-cow-v1" }],
      }),
      "utf8",
    );

    await expect(new WorkspaceRegistryStore(root).read()).rejects.toMatchObject({
      code: "registry.layout-unsupported",
    });
  });
});
