import { execFile } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { HoneyBeeWorkspaceCore } from "./workspace-core.js";
import type {
  StorageLease,
  StorageParentBuild,
  WorkspaceStoragePort,
  WorkspaceToolLauncher,
} from "./workspace-types.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

const git = async (cwd: string, ...args: string[]): Promise<string> =>
  (
    await execFileAsync("git.exe", args, {
      cwd,
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    })
  ).stdout.trim();

class FakeStorage implements WorkspaceStoragePort {
  readonly #root: string;
  readonly #parents = new Map<string, string>();
  readonly #transactions = new Map<string, { key: string; path: string }>();
  readonly #leases = new Map<string, StorageLease & { consumerId: string; workspaceId: string }>();
  public beforeRemoveRetained: (() => Promise<void>) | undefined;

  public constructor(root: string) {
    this.#root = root;
  }

  public async beginParent(_command: string, key: string): Promise<StorageParentBuild> {
    const transactionId = `transaction-${key.slice(0, 12)}`;
    const stagingPath = path.join(this.#root, "parents", transactionId);
    await mkdir(stagingPath, { recursive: true });
    this.#transactions.set(transactionId, { key, path: stagingPath });
    return { transactionId, stagingPath };
  }

  public async commitParent(_command: string, transactionId: string): Promise<StorageParentBuild> {
    const transaction = this.#transactions.get(transactionId);
    if (transaction === undefined) throw new Error("missing transaction");
    this.#parents.set(transaction.key, transaction.path);
    return { parentId: transaction.key, allocatedBytes: 4096 };
  }

  public async abortParent(_command: string, transactionId: string): Promise<void> {
    const transaction = this.#transactions.get(transactionId);
    if (transaction !== undefined) await rm(transaction.path, { recursive: true, force: true });
  }

  public async acquire(
    _command: string,
    input: Readonly<{
      consumerId: string;
      workspaceId: string;
      parentId: string;
      clientPid: number;
    }>,
  ): Promise<StorageLease> {
    const parent = this.#parents.get(input.parentId);
    if (parent === undefined) throw new Error("missing parent");
    const workspacePath = path.join(this.#root, "storage", input.workspaceId);
    const mountPath = path.join(workspacePath, "Library");
    await mkdir(workspacePath, { recursive: true });
    await cp(parent, mountPath, { recursive: true });
    const lease = {
      leaseId: `lease-${input.workspaceId}`,
      workspacePath,
      mountPath,
      consumerId: input.consumerId,
      workspaceId: input.workspaceId,
    };
    this.#leases.set(input.consumerId, lease);
    return lease;
  }

  public async retain(_command: string, _leaseId: string): Promise<void> {}

  public async attachRetained(
    _command: string,
    consumerId: string,
    _workspaceId: string,
  ): Promise<StorageLease> {
    const lease = this.#leases.get(consumerId);
    if (lease === undefined) throw new Error("missing retained lease");
    return lease;
  }

  public async removeRetained(_command: string, consumerId: string): Promise<void> {
    await this.beforeRemoveRetained?.();
    const lease = this.#leases.get(consumerId);
    if (lease === undefined) throw new Error("missing retained lease");
    await rm(lease.workspacePath, { recursive: true, force: true });
    this.#leases.delete(consumerId);
  }
}

class FakeLauncher implements WorkspaceToolLauncher {
  public launchRequest: { executable: string; args: readonly string[]; cwd: string } | undefined;

  public async launch(executable: string, args: readonly string[], cwd: string): Promise<void> {
    this.launchRequest = { executable, args, cwd };
  }
}

const fixture = async () => {
  const root = await mkdtemp(path.join(tmpdir(), "honeybee-workspace-core-"));
  roots.push(root);
  const source = path.join(root, "source");
  const workspaceRoot = path.join(root, "workspaces");
  for (const directory of ["Assets", "Packages", "ProjectSettings", "Library"]) {
    await mkdir(path.join(source, directory), { recursive: true });
  }
  await Promise.all([
    writeFile(path.join(source, ".gitignore"), "/Library/\n", "utf8"),
    writeFile(path.join(source, "Assets", "Player.cs"), "class Player {}\n", "utf8"),
    writeFile(path.join(source, "Assets", "Gradient17сg.mat"), "unicode path\n", "utf8"),
    writeFile(path.join(source, "Packages", "manifest.json"), "{}\n", "utf8"),
    writeFile(
      path.join(source, "ProjectSettings", "ProjectVersion.txt"),
      "m_EditorVersion: test\n",
      "utf8",
    ),
    writeFile(path.join(source, "Library", "ArtifactDB"), "shared-cache\n", "utf8"),
  ]);
  await git(source, "init", "-b", "main");
  await git(source, "config", "core.autocrlf", "false");
  await git(source, "add", ".");
  await git(
    source,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    "initial",
  );
  const sourceAlias = path.join(root, "source-alias");
  await symlink(source, sourceAlias, process.platform === "win32" ? "junction" : "dir");
  const launcher = new FakeLauncher();
  const storage = new FakeStorage(path.join(root, "provider"));
  const core = new HoneyBeeWorkspaceCore({
    dataRoot: path.join(root, "registry"),
    storage,
    launcher,
  });
  const project = await core.initProject({
    unityProjectPath: sourceAlias,
    workspaceRoot,
    storageCommand: process.execPath,
  });
  await core.prepareCache(project.projectId);
  return { root, source, workspaceRoot, core, project, launcher, storage };
};

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5 })),
  );
});

describe("HoneyBeeWorkspaceCore", () => {
  it("mounts a Library-only child in a real Git worktree and preserves its branch on removal", async () => {
    const { source, core, project } = await fixture();
    await writeFile(path.join(source, "Assets", "SourceOnly.cs"), "dirty\n", "utf8");

    const created = await core.createWorkspace({
      project: project.projectId,
      name: "combat",
      branch: "feature/combat",
      base: "main",
    });

    expect(created.available).toBe(true);
    expect(created.layout).toBe("git-worktree-library-cow-v1");
    expect(created.git).toMatchObject({ branch: "feature/combat", dirty: false });
    expect(
      await import("node:fs/promises").then(({ readFile }) =>
        readFile(path.join(created.workspacePath, "Assets", "Gradient17сg.mat"), "utf8"),
      ),
    ).toBe("unicode path\n");
    expect(
      await import("node:fs/promises").then(({ readFile }) =>
        readFile(path.join(created.workspacePath, "Library", "ArtifactDB"), "utf8"),
      ),
    ).toBe("shared-cache\n");
    await expect(
      import("node:fs/promises").then(({ access }) =>
        access(path.join(created.mountPath, "Assets")),
      ),
    ).rejects.toBeDefined();
    await expect(
      import("node:fs/promises").then(({ access }) =>
        access(path.join(created.workspacePath, "Assets", "SourceOnly.cs")),
      ),
    ).rejects.toBeDefined();
    expect(await git(source, "worktree", "list", "--porcelain")).toContain(
      "branch refs/heads/feature/combat",
    );

    await writeFile(path.join(created.workspacePath, "Assets", "Combat.cs"), "class Combat {}\n");
    await git(created.workspacePath, "add", "Assets/Combat.cs");
    await git(
      created.workspacePath,
      "-c",
      "user.name=Agent",
      "-c",
      "user.email=agent@example.invalid",
      "commit",
      "-m",
      "add combat",
    );
    const branchHead = await git(created.workspacePath, "rev-parse", "HEAD");
    expect(await git(source, "rev-parse", "refs/heads/feature/combat")).toBe(branchHead);

    await core.removeWorkspace(created.workspaceId);
    expect(await git(source, "rev-parse", "refs/heads/feature/combat")).toBe(branchHead);
    expect(await git(source, "worktree", "list", "--porcelain")).not.toContain(
      created.workspacePath,
    );
  }, 30_000);

  it("attaches an existing branch, refuses dirty removal, and launches from the workspace", async () => {
    const { root, source, core, project, launcher } = await fixture();
    await git(source, "branch", "feature/existing");
    const created = await core.createWorkspace({
      project: project.projectId,
      name: "existing",
      branch: "feature/existing",
      existingBranch: true,
    });
    await core.launchWorkspace(created.workspaceId, "codex", ["--help"]);
    expect(launcher.launchRequest).toEqual({
      executable: "codex",
      args: ["--help"],
      cwd: created.workspacePath,
    });

    const workspaceLibrary = path.join(created.workspacePath, "Library");
    await unlink(workspaceLibrary);
    await mkdir(workspaceLibrary);
    await writeFile(path.join(workspaceLibrary, "user-data.txt"), "preserve\n", "utf8");
    await expect(core.repairWorkspace(created.workspaceId)).rejects.toMatchObject({
      code: "workspace.library-not-junction",
    });
    expect(await readFile(path.join(workspaceLibrary, "user-data.txt"), "utf8")).toBe("preserve\n");

    await rm(workspaceLibrary, { recursive: true, force: true });
    const wrongTarget = path.join(root, "wrong-library");
    await mkdir(wrongTarget);
    await symlink(wrongTarget, workspaceLibrary, "junction");
    const repaired = await core.repairWorkspace(created.workspaceId);
    expect(await realpath(workspaceLibrary)).toBe(await realpath(repaired.mountPath));

    await writeFile(path.join(created.workspacePath, "Assets", "Dirty.cs"), "dirty\n", "utf8");
    await expect(core.removeWorkspace(created.workspaceId)).rejects.toMatchObject({
      code: "workspace.dirty",
    });
  }, 30_000);

  it("preserves a file written after the final status check during removal", async () => {
    const { source, core, project, storage } = await fixture();
    const created = await core.createWorkspace({
      project: project.projectId,
      name: "late-write",
      branch: "feature/late-write",
      base: "main",
    });
    const lateFile = path.join(created.workspacePath, "Assets", "Late.cs");
    storage.beforeRemoveRetained = () => writeFile(lateFile, "class Late {}\n", "utf8");

    await expect(core.removeWorkspace(created.workspaceId)).rejects.toMatchObject({
      code: "git.command-failed",
    });

    expect(await readFile(lateFile, "utf8")).toBe("class Late {}\n");
    expect(await git(source, "worktree", "list", "--porcelain")).toContain(
      created.workspacePath.replaceAll("\\", "/"),
    );
  }, 30_000);
});
