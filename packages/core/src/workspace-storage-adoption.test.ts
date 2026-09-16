import { createHash } from "node:crypto";
import type * as FsPromises from "node:fs/promises";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HoneyBeeWorkspaceCore } from "./workspace-core.js";
import { WorkspaceRegistryStore } from "./workspace-registry.js";
import { WorkspaceToolResolver } from "./workspace-tool-resolution.js";
import type { ProjectRecordV2, WorkspaceStoragePort } from "./workspace-types.js";

const faults = vi.hoisted(() => ({ backup: false, publish: false }));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof FsPromises>();
  return {
    ...actual,
    open: (...args: Parameters<typeof actual.open>) => {
      if (faults.backup && String(args[0]).includes("before-adoption"))
        throw Object.assign(new Error("simulated backup failure"), { code: "EACCES" });
      return actual.open(...args);
    },
    rename: (...args: Parameters<typeof actual.rename>) => {
      if (faults.publish && String(args[0]).includes("workspace-registry-v2.json.tmp-"))
        throw Object.assign(new Error("simulated publish failure"), { code: "EPERM" });
      return actual.rename(...args);
    },
  };
});

const roots: string[] = [];
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
afterEach(async () => {
  faults.backup = false;
  faults.publish = false;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const fixture = async () => {
  const root = await mkdtemp(path.join(tmpdir(), "honeybee-adoption-"));
  roots.push(root);
  const dataRoot = path.join(root, "data");
  const registry = new WorkspaceRegistryStore(dataRoot);
  for (const directory of ["old", "next"]) {
    await mkdir(path.join(root, directory));
    await writeFile(path.join(root, directory, "unity-workspace-storage.exe"), "client");
    await writeFile(path.join(root, directory, "honeybee-workspace-storage-host.exe"), "host");
  }
  const project: ProjectRecordV2 = {
    schemaVersion: 2,
    projectId: "project",
    label: "game",
    unityProjectPath: root,
    repositoryRoot: root,
    unityRelativePath: "",
    workspaceRoot: path.join(root, "workspaces"),
    storageCommand: path.join(root, "old/unity-workspace-storage.exe"),
    createdAt: "2026-09-10T00:00:00.000Z",
    cache: {
      kind: "library-only-v1",
      parentId: "parent",
      seedCommit: "commit",
      preparedAt: "2026-09-10T00:00:00.000Z",
    },
  };
  await registry.putProject(project);
  const diagnose = vi.fn(async () => ({
    serviceExists: true,
    serviceState: "running",
    receiptExists: true,
    receiptValid: true,
    executableExists: true,
    executableDigestMatches: true,
    userMatches: true,
    workspaceRootAccessible: true,
    componentVersion: "test",
  }));
  const storage = {
    diagnose,
    status: async () => ({ parentCount: 0, manualRecoveryRequired: false }),
  } as unknown as WorkspaceStoragePort;
  const options = {
    installationRoot: path.join(root, "installation"),
    managed: {
      clientCommand: path.join(root, "next/unity-workspace-storage.exe"),
      controlCommand: path.join(root, "next/honeybee-workspace-storage-host.exe"),
      expectedComponentVersion: "test",
      expectedClientSha256: hash("client"),
      expectedControlSha256: hash("host"),
    },
  };
  const core = new HoneyBeeWorkspaceCore({ dataRoot, storage, storageTools: options });
  return { root, dataRoot, registry, core, options, project, diagnose };
};

describe("managed storage adoption", { timeout: 30_000 }, () => {
  it("backs up exact registry bytes and preserves the old path, cache, workspaces and other projects", async () => {
    const { registry, core, project, options, dataRoot, root } = await fixture();
    await registry.putWorkspace({
      schemaVersion: 2,
      layout: "git-worktree-library-cow-v1",
      workspaceId: "retained",
      projectId: project.projectId,
      name: "retained",
      workspacePath: path.join(root, "workspaces/retained"),
      storageWorkspaceId: "storage-retained",
      storageWorkspacePath: path.join(root, "storage/retained"),
      mountPath: path.join(root, "storage/retained/Library"),
      consumerId: "consumer",
      leaseId: "lease",
      parentId: "parent",
      branch: "feature/retained",
      baseCommit: "commit",
      state: "repair-required",
      createdAt: project.createdAt,
      updatedAt: project.createdAt,
    });
    await registry.putProject({
      ...project,
      projectId: "custom",
      label: "custom",
      storageCommand: path.join(dataRoot, "custom.exe"),
    });
    const before = await readFile(registry.path, "utf8");
    const plan = await core.planProjectStorageAdoption(project.projectId);
    expect(plan.status).toBe("ready");
    expect(await readFile(registry.path, "utf8")).toBe(before);
    const adopted = await core.adoptProjectStorage(project.projectId, plan.projectDigest);
    expect(adopted.status).toBe("adopted");
    expect(await readFile(adopted.backupPath as string, "utf8")).toBe(before);
    const current = await registry.read();
    expect(current.workspaces).toEqual(JSON.parse(before).workspaces);
    expect(current.removalReceipts).toEqual(JSON.parse(before).removalReceipts);
    expect(current.projects[0]).toEqual({
      ...project,
      storageBinding: { kind: "managed-v1", installationRoot: options.installationRoot },
    });
    expect(current.projects[1]).toEqual(JSON.parse(before).projects[1]);
    const resolver = new WorkspaceToolResolver(options);
    expect(resolver.resolveProject(current.projects[0] as ProjectRecordV2).clientCommand).toBe(
      options.managed.clientCommand,
    );
    expect(resolver.resolveProject(current.projects[1] as ProjectRecordV2).clientCommand).toBe(
      path.join(dataRoot, "custom.exe"),
    );
    const after = await readFile(registry.path, "utf8");
    await rm(project.storageCommand);
    const retry = await core.planProjectStorageAdoption(project.projectId);
    expect((await core.adoptProjectStorage(project.projectId, retry.projectDigest)).status).toBe(
      "already-adopted",
    );
    expect(await readFile(registry.path, "utf8")).toBe(after);
    expect(
      (await readdir(dataRoot)).filter((name) => name.includes("before-adoption")),
    ).toHaveLength(1);
  });

  it("refuses custom or missing tool bytes and revalidates after preview", async () => {
    const { core, registry, project, dataRoot } = await fixture();
    const before = await readFile(registry.path, "utf8");
    const plan = await core.planProjectStorageAdoption(project.projectId);
    await writeFile(project.storageCommand, "custom");
    await expect(
      core.adoptProjectStorage(project.projectId, plan.projectDigest),
    ).rejects.toMatchObject({ code: "project.adoption-blocked" });
    await rm(project.storageCommand);
    expect((await core.planProjectStorageAdoption(project.projectId)).status).toBe("blocked");
    expect(await readFile(registry.path, "utf8")).toBe(before);
    expect(
      (await readdir(dataRoot)).filter((name) => name.includes("before-adoption")),
    ).toHaveLength(0);
  });

  it("rejects stale plans under the registry lock without losing concurrent edits", async () => {
    const { core, registry, project, options, dataRoot } = await fixture();
    const plan = await core.planProjectStorageAdoption(project.projectId);
    await registry.putProject({ ...project, label: "changed" });
    await expect(
      registry.adoptStorageBinding(project.projectId, plan.projectDigest, options.installationRoot),
    ).rejects.toMatchObject({ code: "project.adoption-stale" });
    await expect(
      core.adoptProjectStorage(project.projectId, plan.projectDigest),
    ).rejects.toMatchObject({ code: "project.adoption-stale" });
    expect((await registry.read()).projects[0]?.label).toBe("changed");
    expect(
      (await readdir(dataRoot)).filter((name) => name.includes("before-adoption")),
    ).toHaveLength(0);
  });

  it("blocks service mismatches and bindings to other installations", async () => {
    const { core, registry, project, options, diagnose } = await fixture();
    diagnose.mockImplementation(async () => ({
      serviceExists: true,
      serviceState: "running",
      receiptExists: true,
      receiptValid: true,
      executableExists: true,
      executableDigestMatches: true,
      userMatches: false,
      workspaceRootAccessible: true,
      componentVersion: "old",
    }));
    expect((await core.planProjectStorageAdoption(project.projectId)).status).toBe("blocked");
    const bound = {
      ...project,
      storageBinding: { kind: "managed-v1" as const, installationRoot: options.installationRoot },
    };
    await registry.putProject(bound);
    await expect(core.prepareCache(project.projectId)).rejects.toMatchObject({
      code: "storage.installation-not-ready",
    });
    expect(() => new WorkspaceToolResolver().resolveProject(bound)).toThrow(
      /another HoneyBee installation/,
    );
  });

  it.each(["backup", "publish"] as const)(
    "preserves the original registry when %s fails and permits a retry",
    async (fault) => {
      const { core, registry, project, dataRoot } = await fixture();
      const plan = await core.planProjectStorageAdoption(project.projectId);
      const before = await readFile(registry.path, "utf8");
      faults[fault] = true;
      await expect(
        core.adoptProjectStorage(project.projectId, plan.projectDigest),
      ).rejects.toMatchObject({ code: "registry.lock-failed" });
      faults[fault] = false;
      expect(await readFile(registry.path, "utf8")).toBe(before);
      const backups = (await readdir(dataRoot)).filter((name) => name.includes("before-adoption"));
      expect(backups).toHaveLength(fault === "backup" ? 0 : 1);
      for (const backup of backups)
        expect(await readFile(path.join(dataRoot, backup), "utf8")).toBe(before);
      expect((await core.adoptProjectStorage(project.projectId, plan.projectDigest)).status).toBe(
        "adopted",
      );
    },
  );
});
