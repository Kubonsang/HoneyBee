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

import { afterEach, describe, expect, it, vi } from "vitest";

import { HoneyBeeWorkspaceCore } from "./workspace-core.js";
import { WorkspaceRegistryStore } from "./workspace-registry.js";
import type { StorageLease, StorageParentBuild, WorkspaceStoragePort } from "./workspace-types.js";
import { WorkspaceCoreError } from "./workspace-types.js";

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
  readonly #removals = new Map<
    string,
    { transactionId: string; state: "prepared" | "committed" }
  >();
  public loseNextRemoveResponse = false;
  public failNextAttach = false;
  public failNextAcquire = false;
  public failNextCommitParent = false;
  public incompleteNextParent = false;
  public failNextRetain = false;
  public failNextRemove = false;
  public failNextPrepare = false;
  public inUseNextPrepare = false;
  public failNextAbort = false;
  public readonly removalEvents: string[] = [];
  public readonly abortedTransactions: string[] = [];
  public afterAcquire?: (lease: StorageLease) => Promise<void>;
  public afterPrepare: (() => Promise<void>) | undefined;

  public constructor(root: string) {
    this.#root = root;
  }

  public async beginParent(_command: string, key: string): Promise<StorageParentBuild> {
    const transactionId = `transaction-${key.slice(0, 12)}`;
    const stagingPath = path.join(this.#root, "parents", transactionId);
    await mkdir(stagingPath, { recursive: true });
    this.#transactions.set(transactionId, { key, path: stagingPath });
    if (this.incompleteNextParent) {
      this.incompleteNextParent = false;
      return { transactionId };
    }
    return { transactionId, stagingPath };
  }

  public async commitParent(_command: string, transactionId: string): Promise<StorageParentBuild> {
    if (this.failNextCommitParent) {
      this.failNextCommitParent = false;
      throw new WorkspaceCoreError("storage.operation-failed", "simulated parent commit failure");
    }
    const transaction = this.#transactions.get(transactionId);
    if (transaction === undefined) throw new Error("missing transaction");
    this.#parents.set(transaction.key, transaction.path);
    return { parentId: transaction.key, allocatedBytes: 4096 };
  }

  public async abortParent(_command: string, transactionId: string): Promise<void> {
    const transaction = this.#transactions.get(transactionId);
    if (transaction !== undefined) await rm(transaction.path, { recursive: true, force: true });
    this.#transactions.delete(transactionId);
    this.abortedTransactions.push(transactionId);
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
    if (this.failNextAcquire) {
      this.failNextAcquire = false;
      throw new WorkspaceCoreError("storage.operation-failed", "simulated acquire failure");
    }
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
    await this.afterAcquire?.(lease);
    return lease;
  }

  public async retain(_command: string, _leaseId: string): Promise<void> {
    if (this.failNextRetain) {
      this.failNextRetain = false;
      throw new WorkspaceCoreError("storage.operation-failed", "simulated retain failure");
    }
  }

  public async attachRetained(
    _command: string,
    consumerId: string,
    _workspaceId: string,
  ): Promise<StorageLease> {
    if (this.failNextAttach) {
      this.failNextAttach = false;
      throw new WorkspaceCoreError("storage.attach-failed", "simulated attach failure");
    }
    const lease = this.#leases.get(consumerId);
    if (lease === undefined) throw new Error("missing retained lease");
    return lease;
  }

  public async prepareRetainedRemoval(
    _command: string,
    consumerId: string,
    _workspaceId: string,
    transactionId: string,
  ) {
    this.removalEvents.push(`prepare:${consumerId}:${transactionId}`);
    if (this.inUseNextPrepare) {
      this.inUseNextPrepare = false;
      throw new WorkspaceCoreError("workspace.in-use", "simulated busy Library", {
        upstreamCode: "retained-in-use",
      });
    }
    if (this.failNextPrepare) {
      this.failNextPrepare = false;
      throw new WorkspaceCoreError("storage.operation-failed", "simulated prepare failure");
    }
    const lease = this.#leases.get(consumerId);
    const removal = this.#removals.get(consumerId);
    if (lease === undefined) {
      if (removal?.transactionId === transactionId && removal.state === "committed") {
        return { transactionId, runId: consumerId, state: "committed" as const };
      }
      throw new WorkspaceCoreError("retained-not-found", "missing retained lease");
    }
    if (removal !== undefined && removal.transactionId !== transactionId) {
      throw new WorkspaceCoreError("storage.operation-failed", "simulated removal conflict", {
        upstreamCode: "removal-transaction-conflict",
      });
    }
    this.#removals.set(consumerId, { transactionId, state: "prepared" });
    await this.afterPrepare?.();
    return {
      transactionId,
      runId: consumerId,
      leaseId: lease.leaseId,
      state: "prepared" as const,
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    };
  }

  public async commitRetainedRemoval(_command: string, consumerId: string, transactionId: string) {
    this.removalEvents.push(`commit:${consumerId}:${transactionId}`);
    if (this.failNextRemove) {
      this.failNextRemove = false;
      throw new WorkspaceCoreError("storage.operation-failed", "simulated remove failure");
    }
    const lease = this.#leases.get(consumerId);
    if (lease === undefined) {
      const completed = this.#removals.get(consumerId);
      if (completed?.transactionId === transactionId && completed.state === "committed") {
        return { transactionId, runId: consumerId, state: "committed" as const };
      }
      throw new WorkspaceCoreError("retained-not-found", "missing retained lease");
    }
    const removal = this.#removals.get(consumerId);
    if (removal?.transactionId !== transactionId || removal.state !== "prepared") {
      throw new WorkspaceCoreError("storage.operation-failed", "removal was not prepared", {
        upstreamCode: "removal-not-prepared",
      });
    }
    await rm(lease.workspacePath, { recursive: true, force: true });
    this.#leases.delete(consumerId);
    this.#removals.set(consumerId, { transactionId, state: "committed" });
    if (this.loseNextRemoveResponse) {
      this.loseNextRemoveResponse = false;
      throw new WorkspaceCoreError("storage.response-lost", "response was lost");
    }
    return {
      transactionId,
      runId: consumerId,
      leaseId: lease.leaseId,
      state: "committed" as const,
    };
  }

  public async abortRetainedRemoval(_command: string, consumerId: string, transactionId: string) {
    this.removalEvents.push(`abort:${consumerId}:${transactionId}`);
    if (this.failNextAbort) {
      this.failNextAbort = false;
      throw new WorkspaceCoreError("storage.operation-failed", "simulated abort failure");
    }
    const removal = this.#removals.get(consumerId);
    if (removal?.transactionId === transactionId && removal.state === "prepared") {
      this.#removals.delete(consumerId);
    }
    return { transactionId, runId: consumerId, state: "aborted" as const };
  }

  public async dropRetained(consumerId: string): Promise<void> {
    const lease = this.#leases.get(consumerId);
    if (lease !== undefined) await rm(lease.workspacePath, { recursive: true, force: true });
    this.#leases.delete(consumerId);
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
  const storage = new FakeStorage(path.join(root, "provider"));
  const core = new HoneyBeeWorkspaceCore({
    dataRoot: path.join(root, "registry"),
    storage,
  });
  const project = await core.initProject({
    unityProjectPath: sourceAlias,
    workspaceRoot,
    storageCommand: process.execPath,
  });
  await core.prepareCache(project.projectId);
  return { root, source, workspaceRoot, core, project, storage };
};

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5 })),
  );
});

describe("HoneyBeeWorkspaceCore", () => {
  it("preserves the first unstaged status column and quoted Unicode paths", async () => {
    const { core } = await fixture();
    const created = await core.createWorkspace({
      name: "status-paths",
      branch: "feature/status-paths",
    });
    await writeFile(path.join(created.workspacePath, "Assets", "Player.cs"), "changed\n");
    const status = await core.workspaceStatus(created.workspaceId);
    expect(status.git?.changes).toEqual([" M Assets/Player.cs"]);
    const { parseGitStatusLine } = await import("./git-status.js");
    await writeFile(path.join(created.workspacePath, "Assets", "한글 파일.cs"), "new\n");
    const changed = await core.workspaceStatus(created.workspaceId);
    expect(changed.git?.changes.map(parseGitStatusLine)).toContainEqual({
      status: "??",
      path: "Assets/한글 파일.cs",
      untracked: true,
    });
  }, 30_000);
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

  it("fails busy removal before changing registry, junction, worktree, or branch", async () => {
    const { source, core, storage } = await fixture();
    const created = await core.createWorkspace({
      name: "busy-library",
      branch: "feature/busy-library",
    });
    const registryBefore = await readFile(core.registryPath, "utf8");
    const targetBefore = await realpath(path.join(created.workspacePath, "Library"));
    storage.inUseNextPrepare = true;

    await expect(core.removeWorkspace(created.workspaceId)).rejects.toMatchObject({
      code: "workspace.in-use",
      remediation: expect.arrayContaining([
        expect.stringContaining("Close Unity"),
        expect.stringContaining("workspace remove"),
      ]),
    });

    expect(await readFile(core.registryPath, "utf8")).toBe(registryBefore);
    expect(await realpath(path.join(created.workspacePath, "Library"))).toBe(targetBefore);
    expect(await git(source, "worktree", "list", "--porcelain")).toContain(
      created.workspacePath.replaceAll("\\", "/"),
    );
    expect(await git(source, "rev-parse", "refs/heads/feature/busy-library")).toBe(
      created.baseCommit,
    );
    expect((await core.workspaceStatus(created.workspaceId)).state).toBe("ready");
  }, 30_000);

  it("aborts the storage reservation when the removing registry write fails", async () => {
    const { core, storage } = await fixture();
    const created = await core.createWorkspace({
      name: "remove-registry-failure",
      branch: "feature/remove-registry-failure",
    });
    const spy = vi
      .spyOn(WorkspaceRegistryStore.prototype, "putWorkspace")
      .mockRejectedValueOnce(new WorkspaceCoreError("registry.lock-failed", "simulated"));

    await expect(core.removeWorkspace(created.workspaceId)).rejects.toMatchObject({
      code: "registry.lock-failed",
    });
    spy.mockRestore();

    expect(storage.removalEvents.map((event) => event.split(":")[0])).toEqual(["prepare", "abort"]);
    expect((await core.workspaceStatus(created.workspaceId)).state).toBe("ready");
    await expect(
      readFile(path.join(created.workspacePath, "Library", "ArtifactDB"), "utf8"),
    ).resolves.toBe("shared-cache\n");
  }, 30_000);

  it("aborts after a post-preflight Git failure and retries from cleanup-pending", async () => {
    const { source, core, storage } = await fixture();
    const created = await core.createWorkspace({
      name: "late-dirty",
      branch: "feature/late-dirty",
    });
    const lateFile = path.join(created.workspacePath, "Assets", "Late.cs");
    storage.afterPrepare = async () => writeFile(lateFile, "class Late {}\n", "utf8");

    await expect(core.removeWorkspace(created.workspaceId)).rejects.toMatchObject({
      code: "git.command-failed",
    });
    expect(storage.removalEvents.map((event) => event.split(":")[0])).toEqual(["prepare", "abort"]);
    expect((await core.workspaceStatus(created.workspaceId)).state).toBe("cleanup-pending");
    await expect(readFile(lateFile, "utf8")).resolves.toBe("class Late {}\n");
    expect(await git(source, "rev-parse", "refs/heads/feature/late-dirty")).toBe(
      created.baseCommit,
    );

    storage.afterPrepare = undefined;
    await rm(lateFile);
    await core.removeWorkspace(created.workspaceId);
    expect(storage.removalEvents.map((event) => event.split(":")[0])).toEqual([
      "prepare",
      "abort",
      "prepare",
      "commit",
    ]);
  }, 30_000);

  it("keeps an abort failure retryable from cleanup-pending", async () => {
    const { core, storage } = await fixture();
    const created = await core.createWorkspace({
      name: "abort-failure",
      branch: "feature/abort-failure",
    });
    const lateFile = path.join(created.workspacePath, "Assets", "Late.cs");
    storage.afterPrepare = async () => writeFile(lateFile, "class Late {}\n", "utf8");
    storage.failNextAbort = true;

    await expect(core.removeWorkspace(created.workspaceId)).rejects.toMatchObject({
      code: "workspace.cleanup-pending",
      remediation: expect.arrayContaining([expect.stringContaining("workspace remove")]),
    });
    expect((await core.workspaceStatus(created.workspaceId)).state).toBe("cleanup-pending");
    await expect(readFile(lateFile, "utf8")).resolves.toBe("class Late {}\n");

    storage.afterPrepare = undefined;
    await rm(lateFile);
    await expect(core.removeWorkspace(created.workspaceId)).resolves.toMatchObject({
      alreadyRemoved: false,
    });
    expect(storage.removalEvents.map((event) => event.split(":")[0])).toEqual([
      "prepare",
      "abort",
      "prepare",
      "commit",
    ]);
  }, 30_000);

  it("attaches an existing branch, repairs its Library, and refuses dirty removal", async () => {
    const { root, source, core, project } = await fixture();
    await git(source, "branch", "feature/existing");
    const created = await core.createWorkspace({
      project: project.projectId,
      name: "existing",
      branch: "feature/existing",
      existingBranch: true,
    });
    const workspaceLibrary = path.join(created.workspacePath, "Library");
    await unlink(workspaceLibrary);
    await mkdir(workspaceLibrary);
    await writeFile(path.join(workspaceLibrary, "user-data.txt"), "preserve\n", "utf8");
    await expect(core.repairWorkspace(created.workspaceId)).rejects.toMatchObject({
      code: "workspace.library-not-junction",
    });
    await expect(core.removeWorkspace(created.workspaceId)).rejects.toMatchObject({
      code: "workspace.library-not-junction",
    });
    expect(await readFile(path.join(workspaceLibrary, "user-data.txt"), "utf8")).toBe("preserve\n");

    await rm(workspaceLibrary, { recursive: true, force: true });
    const wrongTarget = path.join(root, "wrong-library");
    await mkdir(wrongTarget);
    await symlink(wrongTarget, workspaceLibrary, "junction");
    await expect(core.removeWorkspace(created.workspaceId)).rejects.toMatchObject({
      code: "workspace.library-target-invalid",
    });
    expect(await realpath(workspaceLibrary)).toBe(await realpath(wrongTarget));
    await expect(core.repairWorkspace(created.workspaceId)).rejects.toMatchObject({
      code: "workspace.library-target-invalid",
    });
    expect(await realpath(workspaceLibrary)).toBe(await realpath(wrongTarget));
    await unlink(workspaceLibrary);
    const repaired = await core.repairWorkspace(created.workspaceId);
    expect(await realpath(workspaceLibrary)).toBe(await realpath(repaired.mountPath));

    await writeFile(path.join(created.workspacePath, "Assets", "Dirty.cs"), "dirty\n", "utf8");
    await expect(core.removeWorkspace(created.workspaceId)).rejects.toMatchObject({
      code: "workspace.dirty",
    });
    expect((await core.workspaceStatus(created.workspaceId)).state).toBe("ready");
  }, 30_000);

  it("resumes cleanup after a retained-child removal response is lost", async () => {
    const { source, core, project, storage } = await fixture();
    const created = await core.createWorkspace({
      project: project.projectId,
      name: "late-write",
      branch: "feature/late-write",
      base: "main",
    });
    storage.loseNextRemoveResponse = true;

    await expect(core.removeWorkspace(created.workspaceId)).rejects.toMatchObject({
      code: "storage.response-lost",
    });
    const retried = await core.removeWorkspace(created.workspaceId);
    expect(retried.alreadyRemoved).toBe(false);
    const repeated = await core.removeWorkspace(created.workspaceId);
    expect(repeated).toMatchObject({
      workspaceId: created.workspaceId,
      branch: "feature/late-write",
      alreadyRemoved: true,
    });
    expect(await core.listWorkspaces()).toEqual([]);
    expect(await git(source, "rev-parse", "refs/heads/feature/late-write")).toBe(
      created.baseCommit,
    );
  }, 30_000);

  it("closes registered storage and worktree state when creation fails", async () => {
    const { source, core, project, storage } = await fixture();
    storage.failNextAttach = true;

    await expect(
      core.createWorkspace({
        project: project.projectId,
        name: "failed-create",
        branch: "feature/failed-create",
      }),
    ).rejects.toMatchObject({ code: "storage.attach-failed" });
    expect(await core.listWorkspaces()).toEqual([]);
    expect(await git(source, "worktree", "list", "--porcelain")).not.toContain("failed-create");
    expect(await git(source, "rev-parse", "refs/heads/feature/failed-create")).toMatch(
      /^[0-9a-f]{40}$/u,
    );
  }, 30_000);

  it("keeps existing Workspaces on their parent when cache prepare refreshes the source", async () => {
    const { source, core, project } = await fixture();
    const first = await core.createWorkspace({
      project: project.projectId,
      name: "first",
      branch: "feature/first-cache",
    });
    await writeFile(path.join(source, "Library", "ArtifactDB"), "refreshed-cache\n", "utf8");
    const refreshedProject = await core.prepareCache(project.projectId);
    const second = await core.createWorkspace({
      project: project.projectId,
      name: "second",
      branch: "feature/second-cache",
    });
    expect(refreshedProject.cache?.parentId).not.toBe(first.parentId);
    expect(await readFile(path.join(first.workspacePath, "Library", "ArtifactDB"), "utf8")).toBe(
      "shared-cache\n",
    );
    expect(await readFile(path.join(second.workspacePath, "Library", "ArtifactDB"), "utf8")).toBe(
      "refreshed-cache\n",
    );
  }, 30_000);

  it("refuses cache prepare while the source Unity lock is present", async () => {
    const { source, core, project } = await fixture();
    const originalParent = (await core.cacheStatus(project.projectId)).cache?.parentId;
    await mkdir(path.join(source, "Temp"), { recursive: true });
    await writeFile(path.join(source, "Temp", "UnityLockfile"), "locked\n", "utf8");
    await expect(core.prepareCache(project.projectId)).rejects.toMatchObject({
      code: "cache.library-in-use",
    });
    expect((await core.cacheStatus(project.projectId)).cache?.parentId).toBe(originalParent);
  }, 30_000);

  it("aborts incomplete and failed cache parent transactions without replacing the cache", async () => {
    const { core, project, storage } = await fixture();
    const baseline = await core.cacheStatus(project.projectId);
    storage.incompleteNextParent = true;
    await expect(core.prepareCache(project.projectId)).rejects.toMatchObject({
      code: "storage.operation-failed",
    });
    storage.failNextCommitParent = true;
    await expect(core.prepareCache(project.projectId)).rejects.toMatchObject({
      code: "storage.operation-failed",
    });
    expect(storage.abortedTransactions).toHaveLength(2);
    expect((await core.cacheStatus(project.projectId)).cache).toEqual(baseline.cache);
  }, 30_000);

  it.each([
    ["acquire", (storage: FakeStorage) => (storage.failNextAcquire = true)],
    ["retain", (storage: FakeStorage) => (storage.failNextRetain = true)],
    ["attach", (storage: FakeStorage) => (storage.failNextAttach = true)],
  ])(
    "preserves the branch and closes owned state after %s failure",
    async (_stage, fail) => {
      const { source, core, project, storage } = await fixture();
      fail(storage);
      await expect(
        core.createWorkspace({
          project: project.projectId,
          name: `failed-${_stage}`,
          branch: `feature/failed-${_stage}`,
        }),
      ).rejects.toBeDefined();
      expect(await core.listWorkspaces()).toEqual([]);
      expect(await git(source, "rev-parse", `refs/heads/feature/failed-${_stage}`)).toMatch(
        /^[0-9a-f]{40}$/u,
      );
    },
    30_000,
  );

  it("recovers when the provisioning registry write fails after storage acquire", async () => {
    const { source, core, project } = await fixture();
    const spy = vi
      .spyOn(WorkspaceRegistryStore.prototype, "putWorkspace")
      .mockRejectedValueOnce(new WorkspaceCoreError("registry.lock-failed", "simulated"));
    await expect(
      core.createWorkspace({
        project: project.projectId,
        name: "registry-failure",
        branch: "feature/registry-failure",
      }),
    ).rejects.toMatchObject({ code: "registry.lock-failed" });
    spy.mockRestore();
    expect(await core.listWorkspaces()).toEqual([]);
    expect(await git(source, "rev-parse", "refs/heads/feature/registry-failure")).toMatch(
      /^[0-9a-f]{40}$/u,
    );
  }, 30_000);

  it("leaves cleanup-pending when create compensation cannot remove retained storage", async () => {
    const { core, project, storage } = await fixture();
    storage.failNextAttach = true;
    storage.failNextRemove = true;
    await expect(
      core.createWorkspace({
        project: project.projectId,
        name: "pending-create",
        branch: "feature/pending-create",
      }),
    ).rejects.toMatchObject({ code: "workspace.create-cleanup-pending" });
    const [pending] = await core.listWorkspaces(project.projectId);
    expect(pending?.state).toBe("cleanup-pending");
    await core.removeWorkspace("pending-create", project.projectId);
    expect(await core.listWorkspaces(project.projectId)).toEqual([]);
  }, 30_000);

  it("completes remove when retained storage was already removed", async () => {
    const { source, core, project, storage } = await fixture();
    const created = await core.createWorkspace({
      project: project.projectId,
      name: "storage-missing",
      branch: "feature/storage-missing",
    });
    await storage.dropRetained(created.consumerId);
    const removed = await core.removeWorkspace(created.workspaceId);
    expect(removed.alreadyRemoved).toBe(false);
    expect(await git(source, "rev-parse", "refs/heads/feature/storage-missing")).toBe(
      created.baseCommit,
    );
  }, 30_000);

  it("preserves an unexpected Library directory when junction creation fails", async () => {
    const { source, workspaceRoot, core, project, storage } = await fixture();
    const library = path.join(workspaceRoot, "junction-failure", "Library");
    storage.afterAcquire = async () => {
      await mkdir(library, { recursive: true });
      await writeFile(path.join(library, "user-data.txt"), "preserve\n", "utf8");
    };
    await expect(
      core.createWorkspace({
        project: project.projectId,
        name: "junction-failure",
        branch: "feature/junction-failure",
      }),
    ).rejects.toMatchObject({ code: "workspace.create-cleanup-pending" });
    expect(await readFile(path.join(library, "user-data.txt"), "utf8")).toBe("preserve\n");
    expect((await core.workspaceStatus("junction-failure")).state).toBe("cleanup-pending");
    await rm(library, { recursive: true, force: true });
    await core.removeWorkspace("junction-failure");
    expect(await git(source, "rev-parse", "refs/heads/feature/junction-failure")).toMatch(
      /^[0-9a-f]{40}$/u,
    );
  }, 30_000);

  it("compensates safely when the final ready registry write fails", async () => {
    const { source, core, project } = await fixture();
    const original = WorkspaceRegistryStore.prototype.putWorkspace;
    let writes = 0;
    const spy = vi
      .spyOn(WorkspaceRegistryStore.prototype, "putWorkspace")
      .mockImplementation(function (this: WorkspaceRegistryStore, record) {
        writes += 1;
        return writes === 2
          ? Promise.reject(new WorkspaceCoreError("registry.lock-failed", "simulated"))
          : original.call(this, record);
      });
    await expect(
      core.createWorkspace({
        project: project.projectId,
        name: "ready-write-failure",
        branch: "feature/ready-write-failure",
      }),
    ).rejects.toMatchObject({ code: "registry.lock-failed" });
    spy.mockRestore();
    expect(await core.listWorkspaces()).toEqual([]);
    expect(await git(source, "rev-parse", "refs/heads/feature/ready-write-failure")).toMatch(
      /^[0-9a-f]{40}$/u,
    );
  }, 30_000);

  it("removes clean owned state when the Library junction is already missing", async () => {
    const { source, core, project } = await fixture();
    const created = await core.createWorkspace({
      project: project.projectId,
      name: "missing-library",
      branch: "feature/missing-library",
    });
    await unlink(path.join(created.workspacePath, "Library"));
    await core.removeWorkspace(created.workspaceId);
    expect(await git(source, "rev-parse", "refs/heads/feature/missing-library")).toBe(
      created.baseCommit,
    );
  }, 30_000);

  it("removes exact stale Git metadata after the clean worktree directory is gone", async () => {
    const { source, core, project } = await fixture();
    const created = await core.createWorkspace({
      project: project.projectId,
      name: "missing-worktree",
      branch: "feature/missing-worktree",
    });
    await rm(created.workspacePath, { recursive: true, force: true });
    const removed = await core.removeWorkspace(created.workspaceId);
    expect(removed.alreadyRemoved).toBe(false);
    expect(await git(source, "worktree", "list", "--porcelain")).not.toContain(
      created.workspacePath,
    );
    expect(await git(source, "rev-parse", "refs/heads/feature/missing-worktree")).toBe(
      created.baseCommit,
    );
  }, 30_000);
});
