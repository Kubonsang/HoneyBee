import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

  public async retain(_leaseId: string): Promise<void> {}

  public async attachRetained(consumerId: string, _workspaceId: string): Promise<StorageLease> {
    const lease = this.#leases.get(consumerId);
    if (lease === undefined) throw new Error("missing retained lease");
    return lease;
  }

  public async removeRetained(consumerId: string): Promise<void> {
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
  const launcher = new FakeLauncher();
  const core = new HoneyBeeWorkspaceCore({
    dataRoot: path.join(root, "registry"),
    storage: new FakeStorage(path.join(root, "provider")),
    launcher,
  });
  const project = await core.initProject({
    unityProjectPath: source,
    workspaceRoot,
    storageCommand: process.execPath,
  });
  await core.prepareCache(project.projectId);
  return { root, source, workspaceRoot, core, project, launcher };
};

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5 })),
  );
});

describe("HoneyBeeWorkspaceCore", () => {
  it("mounts a full-project child as a real worktree and preserves its branch on removal", async () => {
    const { source, core, project } = await fixture();
    await writeFile(path.join(source, "Assets", "SourceOnly.cs"), "dirty\n", "utf8");

    const created = await core.createWorkspace({
      project: project.projectId,
      name: "combat",
      branch: "feature/combat",
      base: "main",
    });

    expect(created.available).toBe(true);
    expect(created.git).toMatchObject({ branch: "feature/combat", dirty: false });
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
    const { source, core, project, launcher } = await fixture();
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

    await writeFile(path.join(created.workspacePath, "Assets", "Dirty.cs"), "dirty\n", "utf8");
    await expect(core.removeWorkspace(created.workspaceId)).rejects.toMatchObject({
      code: "workspace.dirty",
    });
  }, 30_000);
});
