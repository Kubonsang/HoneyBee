import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  access,
  cp,
  lstat,
  mkdir,
  readlink,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  unlink,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { WorkspaceRegistryStore } from "./workspace-registry.js";
import { WindowsWorkspaceStorage } from "./workspace-storage.js";
import { runWorkspaceDoctor, type WorkspaceDoctorOptions } from "./workspace-doctor.js";
import {
  WORKSPACE_REGISTRY_SCHEMA_VERSION,
  WorkspaceCoreError,
  type ProjectRecordV2,
  type StorageLease,
  type StorageParentBuild,
  type WorkspaceRecordV2,
  type WorkspaceRemoveResultV1,
  type WorkspaceRemovalReceiptV1,
  type WorkspaceStoragePort,
  type WorkspaceViewV1,
} from "./workspace-types.js";

const GIT_TIMEOUT_MS = 120_000;
const MAX_GIT_OUTPUT = 16 * 1024 * 1024;
const WORKSPACE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

const runCommand = (
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<CommandResult> =>
  new Promise((resolve) => {
    execFile(
      command,
      [...args],
      {
        cwd,
        encoding: "utf8",
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: MAX_GIT_OUTPUT,
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ stdout, stderr, exitCode: 0 });
          return;
        }
        const exitCode = typeof error.code === "number" ? error.code : 1;
        resolve({ stdout, stderr: stderr.length > 0 ? stderr : error.message, exitCode });
      },
    );
  });

const pathKey = (value: string): string => {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
};

const contains = (rootValue: string, candidateValue: string): boolean => {
  const relative = path.relative(pathKey(rootValue), pathKey(candidateValue));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

const defaultDataRoot = (): string => {
  const base = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
  return path.join(base, "HoneyBee", "workspace-core");
};

const requireAbsolute = (value: string, label: string): string => {
  if (!path.isAbsolute(value)) {
    throw new WorkspaceCoreError("path.not-absolute", `${label} must be an absolute path.`);
  }
  return path.resolve(value);
};

const now = (): string => new Date().toISOString();

const errorCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;

const libraryBusyError = (error: unknown): boolean =>
  ["EACCES", "EBUSY", "EPERM"].includes(errorCode(error) ?? "");

export interface HoneyBeeWorkspaceCoreOptions {
  readonly dataRoot?: string;
  readonly storage?: WorkspaceStoragePort;
}

export interface ProjectInitInput {
  readonly unityProjectPath: string;
  readonly workspaceRoot: string;
  readonly storageCommand: string;
  readonly label?: string;
}

export interface WorkspaceCreateInput {
  readonly project?: string;
  readonly name: string;
  readonly branch: string;
  readonly base?: string;
  readonly existingBranch?: boolean;
}

export class HoneyBeeWorkspaceCore {
  readonly #registry: WorkspaceRegistryStore;
  readonly #storage: WorkspaceStoragePort;

  public constructor(options: HoneyBeeWorkspaceCoreOptions = {}) {
    const dataRoot = path.resolve(options.dataRoot ?? defaultDataRoot());
    this.#registry = new WorkspaceRegistryStore(dataRoot);
    this.#storage = options.storage ?? new WindowsWorkspaceStorage();
  }

  public get registryPath(): string {
    return this.#registry.path;
  }

  public async initProject(input: ProjectInitInput): Promise<ProjectRecordV2> {
    const requestedProjectPath = requireAbsolute(input.unityProjectPath, "Unity project path");
    const unityProjectPath = await realpath(requestedProjectPath).catch((error: unknown) => {
      throw new WorkspaceCoreError(
        "project.not-found",
        `Unity project was not found: ${requestedProjectPath}`,
        { cause: error },
      );
    });
    await this.#assertUnityProject(unityProjectPath);
    const repositoryRoot = await realpath(
      path.resolve(await this.#git(unityProjectPath, ["rev-parse", "--show-toplevel"])),
    );
    if (!contains(repositoryRoot, unityProjectPath)) {
      throw new WorkspaceCoreError(
        "project.outside-repository",
        "The Unity project must be inside its Git repository.",
      );
    }
    const requestedWorkspaceRoot = requireAbsolute(input.workspaceRoot, "Workspace root");
    if (
      contains(repositoryRoot, requestedWorkspaceRoot) ||
      contains(requestedWorkspaceRoot, repositoryRoot)
    ) {
      throw new WorkspaceCoreError(
        "workspace-root.overlaps-repository",
        "The Workspace root must be outside the source repository.",
      );
    }
    await mkdir(requestedWorkspaceRoot, { recursive: true }).catch((error: unknown) => {
      throw new WorkspaceCoreError(
        "workspace-root.inaccessible",
        `Workspace root could not be created: ${requestedWorkspaceRoot}`,
        { cause: error },
      );
    });
    const workspaceRoot = await realpath(requestedWorkspaceRoot);
    const storageCommandPath = requireAbsolute(input.storageCommand, "workspace-storage command");
    await access(storageCommandPath).catch((error: unknown) => {
      throw new WorkspaceCoreError(
        "storage.command-not-found",
        `workspace-storage executable was not found: ${storageCommandPath}`,
        { cause: error },
      );
    });
    const storageCommand = await realpath(storageCommandPath);
    if (contains(repositoryRoot, workspaceRoot) || contains(workspaceRoot, repositoryRoot)) {
      throw new WorkspaceCoreError(
        "workspace-root.overlaps-repository",
        "The Workspace root must be outside the source repository.",
      );
    }
    const registry = await this.#registry.read();
    const existing = registry.projects.find(
      (project) => pathKey(project.unityProjectPath) === pathKey(unityProjectPath),
    );
    const record: ProjectRecordV2 = {
      schemaVersion: WORKSPACE_REGISTRY_SCHEMA_VERSION,
      projectId: existing?.projectId ?? randomUUID(),
      label: input.label?.trim() || path.basename(unityProjectPath),
      unityProjectPath,
      repositoryRoot,
      unityRelativePath: path.relative(repositoryRoot, unityProjectPath),
      workspaceRoot,
      storageCommand,
      createdAt: existing?.createdAt ?? now(),
      ...(existing?.cache === undefined ? {} : { cache: existing.cache }),
    };
    await this.#registry.putProject(record);
    return record;
  }

  public async listProjects(): Promise<readonly ProjectRecordV2[]> {
    return (await this.#registry.read()).projects;
  }

  public async doctor(options: WorkspaceDoctorOptions = {}) {
    return runWorkspaceDoctor(this.#registry, this.#storage, options, (workspace) =>
      this.#view(workspace),
    );
  }

  public async prepareCache(projectReference?: string): Promise<ProjectRecordV2> {
    const project = await this.#project(projectReference);
    const library = path.join(project.unityProjectPath, "Library");
    if (await this.#exists(path.join(project.unityProjectPath, "Temp", "UnityLockfile"))) {
      throw new WorkspaceCoreError(
        "cache.library-in-use",
        "The source Unity project appears to be open.",
        {
          remediation: [
            "Close every Unity Editor using the source project, then run cache prepare again.",
          ],
        },
      );
    }
    const libraryInfo = await stat(library).catch(() => undefined);
    if (libraryInfo?.isDirectory() !== true) {
      throw new WorkspaceCoreError(
        "cache.library-missing",
        "Open the source project in Unity once, close Unity, then run cache prepare again.",
      );
    }
    const ignored = await this.#gitResult(project.repositoryRoot, [
      "check-ignore",
      "--quiet",
      "--",
      path.relative(project.repositoryRoot, library),
    ]);
    if (ignored.exitCode !== 0) {
      throw new WorkspaceCoreError(
        "cache.library-not-ignored",
        "Unity Library must be ignored by Git before preparing a parent VHDX.",
      );
    }
    const submodules = await this.#git(project.repositoryRoot, [
      "submodule",
      "status",
      "--recursive",
    ]);
    if (submodules.trim().length > 0) {
      throw new WorkspaceCoreError(
        "project.submodules-unsupported",
        "Git submodules are not supported by Workspace Core v1.",
      );
    }
    const seedCommit = await this.#commit(project.repositoryRoot, "HEAD");
    const parentId = createHash("sha256")
      .update(
        JSON.stringify({
          schemaVersion: 1,
          kind: "honeybee-library-only-v1",
          seedCommit,
          unityRelativePath: project.unityRelativePath.replaceAll("\\", "/"),
          refreshId: randomUUID(),
        }),
      )
      .digest("hex");
    const build = await this.#storage.beginParent(project.storageCommand, parentId);
    if (build.transactionId === undefined || build.stagingPath === undefined) {
      if (build.transactionId !== undefined) {
        await this.#storage
          .abortParent(project.storageCommand, build.transactionId)
          .catch((abortError: unknown) => {
            throw new WorkspaceCoreError(
              "storage.operation-failed",
              "Workspace storage returned an incomplete parent build and could not confirm cleanup.",
              { cause: abortError },
            );
          });
      }
      throw new WorkspaceCoreError(
        "storage.operation-failed",
        "Workspace storage returned an incomplete parent build.",
      );
    }
    let committed: StorageParentBuild;
    try {
      for (const entry of await readdir(library)) {
        await cp(path.join(library, entry), path.join(build.stagingPath, entry), {
          recursive: true,
          force: false,
          errorOnExist: true,
          preserveTimestamps: true,
        });
      }
      committed = await this.#storage.commitParent(project.storageCommand, build.transactionId);
    } catch (error) {
      const abortError = await this.#storage
        .abortParent(project.storageCommand, build.transactionId)
        .then(() => undefined)
        .catch((candidate: unknown) => candidate);
      if (abortError !== undefined) {
        throw new WorkspaceCoreError(
          "storage.operation-failed",
          "Cache preparation failed and workspace storage could not confirm parent cleanup.",
          { cause: new AggregateError([error, abortError]) },
        );
      }
      if (libraryBusyError(error)) {
        throw new WorkspaceCoreError(
          "cache.library-in-use",
          "The source Library could not be copied because Unity or another process is using it.",
          {
            cause: error,
            remediation: [
              "Close Unity and any process using the source Library, then run cache prepare again.",
            ],
          },
        );
      }
      throw error;
    }
    if (committed.parentId !== parentId) {
      throw new WorkspaceCoreError(
        "storage.operation-failed",
        "Workspace storage committed an unexpected Library parent identity.",
      );
    }
    const prepared: ProjectRecordV2 = {
      ...project,
      cache: {
        kind: "library-only-v1",
        parentId: committed.parentId,
        seedCommit,
        preparedAt: now(),
        ...(committed.allocatedBytes === undefined
          ? {}
          : { allocatedBytes: committed.allocatedBytes }),
      },
    };
    await this.#registry.putProject(prepared);
    return prepared;
  }

  public async cacheStatus(projectReference?: string): Promise<ProjectRecordV2> {
    return this.#project(projectReference);
  }

  public async createWorkspace(input: WorkspaceCreateInput): Promise<WorkspaceViewV1> {
    const project = await this.#project(input.project);
    if (project.cache === undefined) {
      throw new WorkspaceCoreError(
        "cache.not-prepared",
        "Run honeybee cache prepare before creating a Workspace.",
      );
    }
    if (project.cache.kind !== "library-only-v1") {
      throw new WorkspaceCoreError(
        "cache.layout-incompatible",
        "The cached parent predates Library-only Workspaces; run cache prepare again.",
      );
    }
    if (!WORKSPACE_NAME.test(input.name)) {
      throw new WorkspaceCoreError(
        "workspace.invalid-name",
        "Workspace names may contain letters, numbers, dot, underscore, and dash.",
      );
    }
    await this.#git(project.repositoryRoot, ["check-ref-format", "--branch", input.branch]);
    const registry = await this.#registry.read();
    if (
      registry.workspaces.some(
        (workspace) => workspace.projectId === project.projectId && workspace.name === input.name,
      )
    ) {
      throw new WorkspaceCoreError("workspace.exists", `Workspace ${input.name} already exists.`);
    }
    const branchRef = `refs/heads/${input.branch}`;
    if (input.existingBranch === true) {
      await this.#commit(project.repositoryRoot, branchRef);
      if (await this.#branchCheckedOut(project.repositoryRoot, branchRef)) {
        throw new WorkspaceCoreError(
          "git.branch-in-use",
          `Branch ${input.branch} is already checked out in another worktree.`,
        );
      }
    } else if (await this.#refExists(project.repositoryRoot, branchRef)) {
      throw new WorkspaceCoreError(
        "git.branch-exists",
        `Branch ${input.branch} already exists; use workspace attach instead.`,
      );
    }
    const baseCommit = await this.#commit(
      project.repositoryRoot,
      input.existingBranch === true ? branchRef : (input.base ?? "HEAD"),
    );
    const workspaceId = randomUUID();
    const storageWorkspaceId = `hb-work-${workspaceId}`;
    const consumerId = `hb-workspace-${workspaceId}`;
    const workspacePath = path.join(project.workspaceRoot, input.name);
    if (!contains(project.workspaceRoot, workspacePath)) {
      throw new WorkspaceCoreError("workspace.path-invalid", "Workspace escaped its root.");
    }
    if (await this.#exists(workspacePath)) {
      throw new WorkspaceCoreError("workspace.path-exists", `${workspacePath} already exists.`);
    }
    const worktreeArgs =
      input.existingBranch === true
        ? ["worktree", "add", workspacePath, input.branch]
        : ["worktree", "add", "-b", input.branch, workspacePath, baseCommit];
    await this.#git(project.repositoryRoot, worktreeArgs);
    let record: WorkspaceRecordV2 | undefined;
    try {
      const lease = await this.#storage.acquire(project.storageCommand, {
        consumerId,
        workspaceId: storageWorkspaceId,
        parentId: project.cache.parentId,
        clientPid: process.pid,
      });
      const createdAt = now();
      record = {
        schemaVersion: WORKSPACE_REGISTRY_SCHEMA_VERSION,
        layout: "git-worktree-library-cow-v1",
        workspaceId,
        projectId: project.projectId,
        name: input.name,
        workspacePath,
        storageWorkspaceId,
        storageWorkspacePath: lease.workspacePath,
        mountPath: lease.mountPath,
        consumerId,
        leaseId: lease.leaseId,
        parentId: project.cache.parentId,
        branch: input.branch,
        baseCommit,
        state: "provisioning",
        createdAt,
        updatedAt: createdAt,
      };
      await this.#registry.putWorkspace(record);
      const workspaceLibrary = path.join(workspacePath, project.unityRelativePath, "Library");
      await symlink(lease.mountPath, workspaceLibrary, "junction");
      await this.#storage.retain(project.storageCommand, lease.leaseId);
      const attached = await this.#storage.attachRetained(
        project.storageCommand,
        consumerId,
        storageWorkspaceId,
      );
      record = {
        ...record,
        storageWorkspacePath: attached.workspacePath,
        mountPath: attached.mountPath,
        leaseId: attached.leaseId,
        state: "ready",
        updatedAt: now(),
      };
      const registeredHead = await this.#commit(workspacePath, "HEAD");
      const registeredBranch = await this.#git(workspacePath, ["branch", "--show-current"]);
      const status = await this.#git(workspacePath, [
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
      ]);
      if (
        registeredHead !== baseCommit ||
        registeredBranch !== input.branch ||
        status.length !== 0
      ) {
        throw new WorkspaceCoreError(
          "git.registration-invalid",
          "The Git worktree did not match its requested clean branch and commit.",
        );
      }
      await this.#registry.putWorkspace(record);
      return this.#view(record);
    } catch (error) {
      if (record === undefined) {
        try {
          await this.#git(project.repositoryRoot, ["worktree", "remove", workspacePath]);
        } catch (cleanupError) {
          throw new WorkspaceCoreError(
            "workspace.create-cleanup-pending",
            `Workspace creation failed and ${workspacePath} was preserved because Git could not remove it safely.`,
            { cause: new AggregateError([error, cleanupError]) },
          );
        }
      } else {
        const cleanupErrors: unknown[] = [];
        await this.#registry
          .putWorkspace({ ...record, state: "cleanup-pending", updatedAt: now() })
          .catch((cleanupError: unknown) => cleanupErrors.push(cleanupError));
        await this.#storage
          .retain(project.storageCommand, record.leaseId)
          .catch((cleanupError: unknown) => cleanupErrors.push(cleanupError));
        try {
          await this.removeWorkspace(record.workspaceId, project.projectId);
          cleanupErrors.length = 0;
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
        if (cleanupErrors.length > 0) {
          throw new WorkspaceCoreError(
            "workspace.create-cleanup-pending",
            "Workspace creation failed and safe cleanup is pending; retry workspace remove.",
            { cause: new AggregateError([error, ...cleanupErrors]) },
          );
        }
      }
      throw error;
    }
  }

  public async attachWorkspace(
    input: Omit<WorkspaceCreateInput, "existingBranch" | "base">,
  ): Promise<WorkspaceViewV1> {
    return this.createWorkspace({ ...input, existingBranch: true });
  }

  public async listWorkspaces(projectReference?: string): Promise<readonly WorkspaceViewV1[]> {
    const registry = await this.#registry.read();
    const project =
      projectReference === undefined ? undefined : await this.#project(projectReference);
    return Promise.all(
      registry.workspaces
        .filter((workspace) => project === undefined || workspace.projectId === project.projectId)
        .map((workspace) => this.#view(workspace)),
    );
  }

  public async workspaceStatus(
    reference: string,
    projectReference?: string,
  ): Promise<WorkspaceViewV1> {
    return this.#view(await this.#workspace(reference, projectReference));
  }

  public async repairWorkspace(
    reference: string,
    projectReference?: string,
  ): Promise<WorkspaceViewV1> {
    let record = await this.#workspace(reference, projectReference);
    const project = await this.#project(record.projectId);
    if (record.state === "removing" || record.state === "cleanup-pending") {
      throw new WorkspaceCoreError(
        "workspace.cleanup-pending",
        `Workspace "${record.name}" has incomplete cleanup.`,
        { remediation: [`Run honeybee workspace remove "${record.name}" again.`] },
      );
    }
    if (record.layout !== "git-worktree-library-cow-v1") {
      throw new WorkspaceCoreError(
        "workspace.layout-unsupported",
        "This pre-adoption Full-project Workspace cannot be repaired by Library-only Core.",
      );
    }
    if (!(await this.#exists(record.workspacePath))) {
      throw new WorkspaceCoreError(
        "workspace.worktree-missing",
        "The Git worktree directory is missing and cannot be reconstructed safely.",
      );
    }
    const workspaceLibrary = path.join(record.workspacePath, project.unityRelativePath, "Library");
    if (!contains(record.workspacePath, workspaceLibrary)) {
      throw new WorkspaceCoreError(
        "workspace.library-path-invalid",
        "Workspace Library path escaped its Git worktree.",
      );
    }
    const libraryEntry = await lstat(workspaceLibrary).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    if (libraryEntry !== undefined && !libraryEntry.isSymbolicLink()) {
      throw new WorkspaceCoreError(
        "workspace.library-not-junction",
        "Workspace Library exists but is not the retained storage junction.",
      );
    }
    if (
      libraryEntry !== undefined &&
      !(await this.#libraryJunctionReferences(workspaceLibrary, record.mountPath))
    ) {
      throw new WorkspaceCoreError(
        "workspace.library-target-invalid",
        "Workspace Library points to a different target and was not changed.",
      );
    }
    let lease: StorageLease | undefined;
    const mountAvailable = await stat(record.mountPath)
      .then(() => true)
      .catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      });
    if (!mountAvailable) {
      lease = await this.#storage.attachRetained(
        project.storageCommand,
        record.consumerId,
        record.storageWorkspaceId,
      );
    }
    const mountPath = lease?.mountPath ?? record.mountPath;
    await this.#ensureLibraryJunction(workspaceLibrary, mountPath);
    await this.#git(project.repositoryRoot, ["worktree", "repair", record.workspacePath]);
    await this.#git(record.workspacePath, ["status", "--porcelain=v1"]);
    record = {
      ...record,
      ...(lease === undefined
        ? {}
        : {
            leaseId: lease.leaseId,
            mountPath: lease.mountPath,
            storageWorkspacePath: lease.workspacePath,
          }),
      state: "ready",
      updatedAt: now(),
    };
    await this.#registry.putWorkspace(record);
    return this.#view(record);
  }

  public async removeWorkspace(
    reference: string,
    projectReference?: string,
  ): Promise<WorkspaceRemoveResultV1> {
    let record: WorkspaceRecordV2;
    try {
      record = await this.#workspace(reference, projectReference);
    } catch (error) {
      if (!(error instanceof WorkspaceCoreError) || error.code !== "workspace.not-found") {
        throw error;
      }
      const receipt = await this.#removalReceipt(reference, projectReference);
      if (receipt === undefined) throw error;
      return {
        workspaceId: receipt.workspaceId,
        projectId: receipt.projectId,
        name: receipt.name,
        branch: receipt.branch,
        alreadyRemoved: true,
      };
    }
    const project = await this.#project(record.projectId);
    const resumed = record.state === "removing" || record.state === "cleanup-pending";
    let cleanupStarted = resumed;
    let removalPrepared = false;
    let removalCommitStarted = false;
    const removalTransactionId = `removal-${record.workspaceId}`;
    if (record.layout !== "git-worktree-library-cow-v1") {
      throw new WorkspaceCoreError(
        "workspace.layout-unsupported",
        "This pre-adoption Full-project Workspace must be removed with the Core version that created it.",
      );
    }
    try {
      let workspaceLibrary: string | undefined;
      const workspaceExists = await this.#exists(record.workspacePath);
      if (workspaceExists) {
        const view = await this.#view(record);
        if (view.git === undefined) {
          throw new WorkspaceCoreError(
            "workspace.repair-required",
            `Workspace "${record.name}" cannot be identified as a safe Git worktree.`,
            { remediation: [`Run honeybee workspace repair "${record.name}" first.`] },
          );
        } else if (view.git.dirty) {
          throw new WorkspaceCoreError(
            "workspace.dirty",
            `Workspace "${record.name}" contains uncommitted changes.`,
            {
              remediation: [
                "Commit or discard them before removing the Workspace.",
                `git -C "${record.workspacePath}" status`,
              ],
            },
          );
        }
        workspaceLibrary = path.join(record.workspacePath, project.unityRelativePath, "Library");
        await this.#validateLibraryJunction(
          record.workspacePath,
          workspaceLibrary,
          record.mountPath,
        );
        const refreshed = await this.#view(record);
        if (refreshed.git?.dirty === true) {
          throw new WorkspaceCoreError("workspace.dirty", "The Workspace contains changes.");
        }
        await this.#validateLibraryJunction(
          record.workspacePath,
          workspaceLibrary,
          record.mountPath,
        );
      } else {
        const registeredBranch = await this.#registeredWorktreeBranch(
          project.repositoryRoot,
          record.workspacePath,
        );
        if (registeredBranch !== undefined && registeredBranch !== record.branch) {
          throw new WorkspaceCoreError(
            "workspace.repair-required",
            "The missing Workspace path is registered to a different Git branch.",
          );
        }
      }

      let storageAlreadyRemoved = false;
      let preparationState: "prepared" | "committed" | undefined;
      try {
        const preparation = await this.#storage.prepareRetainedRemoval(
          project.storageCommand,
          record.consumerId,
          record.storageWorkspaceId,
          removalTransactionId,
        );
        if (preparation.state !== "prepared" && preparation.state !== "committed") {
          throw new WorkspaceCoreError(
            "storage.invalid-response",
            "Workspace storage returned an invalid removal preparation state.",
          );
        }
        preparationState = preparation.state;
        removalPrepared = preparation.state === "prepared";
      } catch (error) {
        const retainedMissing =
          error instanceof WorkspaceCoreError &&
          (error.code === "retained-not-found" ||
            error.code === "storage.retained-not-found" ||
            error.upstreamCode === "retained-not-found");
        if (retainedMissing) {
          storageAlreadyRemoved = true;
        } else if (
          error instanceof WorkspaceCoreError &&
          (error.code === "workspace.in-use" || error.upstreamCode === "retained-in-use")
        ) {
          throw new WorkspaceCoreError(
            "workspace.in-use",
            `Workspace "${record.name}" Library is still in use.`,
            {
              cause: error,
              remediation: [
                "Close Unity, IDE, terminal, and AI CLI processes using this Workspace.",
                `Run honeybee workspace remove "${record.name}" again.`,
              ],
              ...(error.upstreamCode === undefined ? {} : { upstreamCode: error.upstreamCode }),
            },
          );
        } else {
          throw error;
        }
      }

      try {
        record = { ...record, state: "removing", updatedAt: now() };
        await this.#registry.putWorkspace(record);
      } catch (error) {
        if (removalPrepared) {
          try {
            await this.#storage.abortRetainedRemoval(
              project.storageCommand,
              record.consumerId,
              removalTransactionId,
            );
          } catch (abortError) {
            removalPrepared = false;
            throw new WorkspaceCoreError(
              "storage.operation-failed",
              "Workspace removal did not start, and storage could not confirm reservation cleanup.",
              {
                cause: new AggregateError([error, abortError]),
                remediation: [`Run honeybee workspace remove "${record.name}" again.`],
              },
            );
          }
          removalPrepared = false;
        }
        throw error;
      }
      cleanupStarted = true;
      if (workspaceExists) {
        await this.#removeLibraryJunction(
          record.workspacePath,
          workspaceLibrary as string,
          record.mountPath,
        );
        await this.#git(project.repositoryRoot, ["worktree", "remove", record.workspacePath]);
      } else if (
        (await this.#registeredWorktreeBranch(project.repositoryRoot, record.workspacePath)) !==
        undefined
      ) {
        await this.#git(project.repositoryRoot, [
          "worktree",
          "remove",
          "--force",
          record.workspacePath,
        ]);
      }

      if (!storageAlreadyRemoved && preparationState !== "committed") {
        removalCommitStarted = true;
        await this.#storage.commitRetainedRemoval(
          project.storageCommand,
          record.consumerId,
          removalTransactionId,
        );
        removalPrepared = false;
      }
      await this.#registry.completeWorkspaceRemoval(record);
      return {
        workspaceId: record.workspaceId,
        projectId: record.projectId,
        name: record.name,
        branch: record.branch,
        alreadyRemoved: false,
      };
    } catch (error) {
      let failure: unknown = error;
      if (removalPrepared && !removalCommitStarted) {
        try {
          await this.#storage.abortRetainedRemoval(
            project.storageCommand,
            record.consumerId,
            removalTransactionId,
          );
          removalPrepared = false;
        } catch (abortError) {
          failure = new WorkspaceCoreError(
            "workspace.cleanup-pending",
            `Workspace "${record.name}" cleanup is incomplete, and storage could not confirm reservation cleanup.`,
            {
              cause: new AggregateError([error, abortError]),
              remediation: [`Run honeybee workspace remove "${record.name}" again.`],
            },
          );
        }
      }
      if (cleanupStarted) {
        await this.#registry.putWorkspace({
          ...record,
          state: "cleanup-pending",
          updatedAt: now(),
        });
      }
      throw failure;
    }
  }

  async #removeLibraryJunction(
    workspacePath: string,
    workspaceLibrary: string,
    expectedMountPath: string,
  ): Promise<void> {
    const entry = await this.#validateLibraryJunction(
      workspacePath,
      workspaceLibrary,
      expectedMountPath,
    );
    if (entry === undefined) return;
    try {
      await unlink(workspaceLibrary);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
      await rm(workspaceLibrary, { recursive: true, force: true });
    }
  }

  async #validateLibraryJunction(
    workspacePath: string,
    workspaceLibrary: string,
    expectedMountPath: string,
  ): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
    if (!contains(workspacePath, workspaceLibrary)) {
      throw new WorkspaceCoreError(
        "workspace.library-path-invalid",
        "Workspace Library path escaped its Git worktree.",
      );
    }
    const entry = await lstat(workspaceLibrary).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    if (entry === undefined) return;
    if (!entry.isSymbolicLink()) {
      throw new WorkspaceCoreError(
        "workspace.library-not-junction",
        "Workspace Library exists but is not a HoneyBee-owned junction.",
      );
    }
    if (!(await this.#libraryJunctionReferences(workspaceLibrary, expectedMountPath))) {
      throw new WorkspaceCoreError(
        "workspace.library-target-invalid",
        "Workspace Library junction does not reference HoneyBee retained storage.",
      );
    }
    return entry;
  }

  async #libraryJunctionReferences(workspaceLibrary: string, mountPath: string): Promise<boolean> {
    try {
      const target = await readlink(workspaceLibrary);
      return pathKey(path.resolve(path.dirname(workspaceLibrary), target)) === pathKey(mountPath);
    } catch {
      return false;
    }
  }

  async #libraryJunctionMatches(workspaceLibrary: string, mountPath: string): Promise<boolean> {
    try {
      const entry = await lstat(workspaceLibrary);
      if (
        !entry.isSymbolicLink() ||
        !(await this.#libraryJunctionReferences(workspaceLibrary, mountPath))
      ) {
        return false;
      }
      const [libraryTarget, storageTarget] = await Promise.all([
        realpath(workspaceLibrary),
        realpath(mountPath),
      ]);
      return pathKey(libraryTarget) === pathKey(storageTarget);
    } catch {
      return false;
    }
  }

  async #ensureLibraryJunction(workspaceLibrary: string, mountPath: string): Promise<void> {
    const entry = await lstat(workspaceLibrary).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    if (entry !== undefined && !entry.isSymbolicLink()) {
      throw new WorkspaceCoreError(
        "workspace.library-not-junction",
        "Workspace Library exists but is not the retained storage junction.",
      );
    }
    if (entry !== undefined && !(await this.#libraryJunctionMatches(workspaceLibrary, mountPath))) {
      throw new WorkspaceCoreError(
        "workspace.library-target-invalid",
        "Workspace Library points to a different target and was not changed.",
      );
    }
    if (!(await this.#exists(workspaceLibrary))) {
      await symlink(mountPath, workspaceLibrary, "junction");
    }
    if (!(await this.#libraryJunctionMatches(workspaceLibrary, mountPath))) {
      throw new WorkspaceCoreError(
        "workspace.library-target-invalid",
        "Workspace Library does not resolve to the retained storage mount.",
      );
    }
  }

  async #view(record: WorkspaceRecordV2): Promise<WorkspaceViewV1> {
    if (!(await this.#exists(record.workspacePath))) {
      return {
        ...record,
        available: false,
        libraryConnected: false,
        state:
          record.state === "removing" || record.state === "cleanup-pending"
            ? record.state
            : "repair-required",
      };
    }
    let git: WorkspaceViewV1["git"];
    try {
      const branch = await this.#git(record.workspacePath, ["branch", "--show-current"]);
      const head = await this.#commit(record.workspacePath, "HEAD");
      const status = await this.#git(record.workspacePath, [
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
      ]);
      const changes = status.length === 0 ? [] : status.split(/\r?\n/u).filter(Boolean);
      git = { branch, head, dirty: changes.length > 0, changes };
    } catch {
      git = undefined;
    }
    let libraryConnected = false;
    if (record.layout === "git-worktree-library-cow-v1") {
      const project = await this.#project(record.projectId);
      const workspaceLibrary = path.join(
        record.workspacePath,
        project.unityRelativePath,
        "Library",
      );
      libraryConnected = await this.#libraryJunctionMatches(workspaceLibrary, record.mountPath);
    }
    const available = git !== undefined && libraryConnected;
    const state =
      record.state === "removing" || record.state === "cleanup-pending"
        ? record.state
        : available
          ? record.state
          : ("repair-required" as const);
    return {
      ...record,
      available,
      libraryConnected,
      state,
      ...(git === undefined ? {} : { git }),
    };
  }

  async #removalReceipt(
    reference: string,
    projectReference?: string,
  ): Promise<WorkspaceRemovalReceiptV1 | undefined> {
    const registry = await this.#registry.read();
    const project =
      projectReference === undefined ? undefined : await this.#project(projectReference);
    const matches = registry.removalReceipts
      .filter(
        (receipt) =>
          (receipt.workspaceId === reference || receipt.name === reference) &&
          (project === undefined || receipt.projectId === project.projectId),
      )
      .sort((left, right) => right.removedAt.localeCompare(left.removedAt));
    if (matches.length === 0) return undefined;
    if (
      project === undefined &&
      new Set(matches.map((receipt) => receipt.projectId)).size > 1 &&
      matches.every((receipt) => receipt.workspaceId !== reference)
    ) {
      throw new WorkspaceCoreError(
        "workspace.ambiguous",
        `Removed Workspace ${reference} could not be resolved uniquely; use --project.`,
      );
    }
    return matches[0];
  }

  async #registeredWorktreeBranch(
    repositoryRoot: string,
    workspacePath: string,
  ): Promise<string | undefined> {
    const records = (await this.#git(repositoryRoot, ["worktree", "list", "--porcelain"]))
      .split(/\r?\n\r?\n/u)
      .map((entry) => entry.split(/\r?\n/u));
    for (const lines of records) {
      const worktree = lines.find((line) => line.startsWith("worktree "))?.slice(9);
      if (worktree === undefined || pathKey(worktree) !== pathKey(workspacePath)) continue;
      return lines
        .find((line) => line.startsWith("branch refs/heads/"))
        ?.slice("branch refs/heads/".length);
    }
    return undefined;
  }

  async #project(reference?: string): Promise<ProjectRecordV2> {
    const registry = await this.#registry.read();
    if (registry.projects.length === 0) {
      throw new WorkspaceCoreError("project.not-found", "No HoneyBee project is registered.");
    }
    if (reference !== undefined) {
      const key = pathKey(reference);
      const project = registry.projects.find(
        (item) =>
          item.projectId === reference ||
          pathKey(item.unityProjectPath) === key ||
          pathKey(item.repositoryRoot) === key,
      );
      if (project !== undefined) return project;
      throw new WorkspaceCoreError("project.not-found", `Project ${reference} was not found.`);
    }
    const cwd = process.cwd();
    const matches = registry.projects.filter(
      (item) =>
        contains(item.repositoryRoot, cwd) ||
        registry.workspaces.some(
          (workspace) =>
            workspace.projectId === item.projectId && contains(workspace.workspacePath, cwd),
        ),
    );
    if (matches.length === 1) return matches[0] as ProjectRecordV2;
    if (registry.projects.length === 1) return registry.projects[0] as ProjectRecordV2;
    throw new WorkspaceCoreError(
      "project.ambiguous",
      "Use --project because the current directory does not identify one project.",
    );
  }

  async #workspace(reference: string, projectReference?: string): Promise<WorkspaceRecordV2> {
    const registry = await this.#registry.read();
    const project =
      projectReference === undefined ? undefined : await this.#project(projectReference);
    const matches = registry.workspaces.filter(
      (workspace) =>
        (workspace.workspaceId === reference || workspace.name === reference) &&
        (project === undefined || workspace.projectId === project.projectId),
    );
    if (matches.length !== 1) {
      throw new WorkspaceCoreError(
        matches.length === 0 ? "workspace.not-found" : "workspace.ambiguous",
        `Workspace ${reference} could not be resolved uniquely.`,
      );
    }
    return matches[0] as WorkspaceRecordV2;
  }

  async #assertUnityProject(projectPath: string): Promise<void> {
    for (const directory of ["Assets", "Packages", "ProjectSettings"]) {
      const info = await stat(path.join(projectPath, directory)).catch(() => undefined);
      if (info?.isDirectory() !== true) {
        throw new WorkspaceCoreError(
          "project.invalid-unity",
          `${projectPath} is missing the Unity ${directory} directory.`,
        );
      }
    }
  }

  async #command(
    command: string,
    args: readonly string[],
    cwd: string,
    trim = true,
  ): Promise<string> {
    const result = await runCommand(command, args, cwd);
    if (result.exitCode !== 0) {
      throw new WorkspaceCoreError(
        command === "git.exe" ? "git.command-failed" : "command.failed",
        result.stderr.trim() || `${command} failed with exit code ${result.exitCode}.`,
      );
    }
    return trim ? result.stdout.trim() : result.stdout.replace(/\r?\n$/u, "");
  }

  async #git(cwd: string, args: readonly string[]): Promise<string> {
    return this.#command("git.exe", await this.#gitArguments(cwd, args), cwd, args[0] !== "status");
  }

  async #gitResult(cwd: string, args: readonly string[]): Promise<CommandResult> {
    return runCommand("git.exe", await this.#gitArguments(cwd, args), cwd);
  }

  async #gitArguments(cwd: string, args: readonly string[]): Promise<readonly string[]> {
    const physicalCwd = await realpath(cwd).catch(() => path.resolve(cwd));
    const safeDirectory = physicalCwd.replaceAll("\\", "/");
    return ["-c", `safe.directory=${safeDirectory}`, ...args];
  }

  async #commit(cwd: string, reference: string): Promise<string> {
    return this.#git(cwd, ["rev-parse", "--verify", `${reference}^{commit}`]);
  }

  async #refExists(cwd: string, reference: string): Promise<boolean> {
    return (
      (await this.#gitResult(cwd, ["show-ref", "--verify", "--quiet", reference])).exitCode === 0
    );
  }

  async #branchCheckedOut(cwd: string, branchRef: string): Promise<boolean> {
    return (await this.#git(cwd, ["worktree", "list", "--porcelain"]))
      .split(/\r?\n/u)
      .some((line) => line === `branch ${branchRef}`);
  }

  async #exists(candidate: string): Promise<boolean> {
    try {
      await lstat(candidate);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
}
