import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { HoneyBeeWorkspaceCore } from "./workspace-core.js";
import type { StorageLease, StorageParentBuild, WorkspaceStoragePort } from "./workspace-types.js";

const roots: string[] = [];

class DoctorStorage implements WorkspaceStoragePort {
  public userMatches = true;

  public async beginParent(): Promise<StorageParentBuild> {
    throw new Error("not used");
  }
  public async commitParent(): Promise<StorageParentBuild> {
    throw new Error("not used");
  }
  public async abortParent(): Promise<void> {
    throw new Error("not used");
  }
  public async acquire(): Promise<StorageLease> {
    throw new Error("not used");
  }
  public async retain(): Promise<void> {
    throw new Error("not used");
  }
  public async attachRetained(): Promise<StorageLease> {
    throw new Error("not used");
  }
  public async removeRetained(): Promise<void> {
    throw new Error("not used");
  }
  public async diagnose() {
    return {
      serviceExists: true,
      serviceState: "running",
      receiptExists: true,
      receiptValid: true,
      componentVersion: "test",
      workspaceRoot: "C:\\storage",
      workspaceRootAccessible: true,
      executableExists: true,
      executableDigestMatches: true,
      userMatches: this.userMatches,
    };
  }
  public async status() {
    return { parentCount: 0, manualRecoveryRequired: false };
  }
}

const tools = async (root: string): Promise<string> => {
  const directory = path.join(root, "tools");
  await mkdir(directory);
  const client = path.join(directory, "unity-workspace-storage.exe");
  const control = path.join(directory, "honeybee-workspace-storage-host.exe");
  await Promise.all([writeFile(client, "test", "utf8"), writeFile(control, "test", "utf8")]);
  return client;
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Workspace doctor", () => {
  it("returns a read-only warning report for an unconfigured but healthy machine", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "honeybee-doctor-"));
    roots.push(root);
    const storage = new DoctorStorage();
    const core = new HoneyBeeWorkspaceCore({ dataRoot: path.join(root, "registry"), storage });

    const report = await core.doctor({ storageCommand: await tools(root) });

    expect(report.ready).toBe(true);
    expect(report.checks).toContainEqual(
      expect.objectContaining({ code: "projects.registered", status: "warning" }),
    );
    expect(report.checks).toContainEqual(
      expect.objectContaining({ code: "storage.service", status: "pass" }),
    );
  });

  it("does not mutate a registered project while reporting setup warnings", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "honeybee-doctor-"));
    roots.push(root);
    const source = path.join(root, "source");
    for (const directory of ["Assets", "Packages", "ProjectSettings"]) {
      await mkdir(path.join(source, directory), { recursive: true });
    }
    await writeFile(path.join(source, "Assets", "Marker.txt"), "marker\n", "utf8");
    const { execFile } = await import("node:child_process");
    await new Promise<void>((resolve, reject) =>
      execFile("git.exe", ["init", "-b", "main", source], { windowsHide: true }, (error) =>
        error === null ? resolve() : reject(error),
      ),
    );
    const storage = new DoctorStorage();
    const core = new HoneyBeeWorkspaceCore({ dataRoot: path.join(root, "registry"), storage });
    const storageCommand = await tools(root);
    await core.initProject({
      unityProjectPath: source,
      workspaceRoot: path.join(root, "workspaces"),
      storageCommand,
    });
    const before = await readFile(core.registryPath, "utf8");

    const report = await core.doctor({ storageCommand });

    expect(report.ready).toBe(true);
    expect(report.checks).toContainEqual(
      expect.objectContaining({ code: "cache.prepared", status: "warning" }),
    );
    expect(await readFile(core.registryPath, "utf8")).toBe(before);
  });

  it("fails readiness when the install receipt belongs to another user", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "honeybee-doctor-"));
    roots.push(root);
    const storage = new DoctorStorage();
    storage.userMatches = false;
    const core = new HoneyBeeWorkspaceCore({ dataRoot: path.join(root, "registry"), storage });

    const report = await core.doctor({ storageCommand: await tools(root) });

    expect(report.ready).toBe(false);
    expect(report.checks).toContainEqual(
      expect.objectContaining({ code: "storage.install-receipt", status: "fail" }),
    );
  });
});
