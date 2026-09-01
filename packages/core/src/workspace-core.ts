import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, cp, lstat, mkdir, rename, rm, stat, symlink, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { WorkspaceRegistryStore } from "./workspace-registry.js";
import { WindowsTerminalLauncher, WindowsWorkspaceStorage } from "./workspace-storage.js";
import {
  WorkspaceCoreError,
  type ProjectRecordV1,
  type StorageLease,
  type WorkspaceRecordV1,
  type WorkspaceStoragePort,
  type WorkspaceTool,
  type WorkspaceToolLauncher,
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
  const relative = path.relative(path.resolve(rootValue), path.resolve(candidateValue));
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

export interface HoneyBeeWorkspaceCoreOptions {
  readonly dataRoot?: string;
  readonly storage?: WorkspaceStoragePort;
  readonly launcher?: WorkspaceToolLauncher;
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
  readonly #launcher: WorkspaceToolLauncher;
  readonly #transactionsRoot: string;

  public constructor(options: HoneyBeeWorkspaceCoreOptions = {}) {
    const dataRoot = path.resolve(options.dataRoot ?? defaultDataRoot());
    this.#registry = new WorkspaceRegistryStore(dataRoot);
    this.#storage = options.storage ?? new WindowsWorkspaceStorage();
    this.#launcher = options.launcher ?? new WindowsTerminalLauncher();
    this.#transactionsRoot = path.join(dataRoot, "transactions");
  }

  public get registryPath(): string {
    return this.#registry.path;
  }

  public async initProject(input: ProjectInitInput): Promise<ProjectRecordV1> {
    const unityProjectPath = requireAbsolute(input.unityProjectPath, "Unity project path");
    const workspaceRoot = requireAbsolute(input.workspaceRoot, "Workspace root");
    const storageCommand = requireAbsolute(input.storageCommand, "workspace-storage command");
    await this.#assertUnityProject(unityProjectPath);
    await access(storageCommand);
    const repositoryRoot = path.resolve(
      await this.#git(unityProjectPath, ["rev-parse", "--show-toplevel"]),
    );
    if (!contains(repositoryRoot, unityProjectPath)) {
      throw new WorkspaceCoreError(
        "project.outside-repository",
        "The Unity project must be inside its Git repository.",
      );
    }
    if (contains(repositoryRoot, workspaceRoot) || contains(workspaceRoot, repositoryRoot)) {
      throw new WorkspaceCoreError(
        "workspace-root.overlaps-repository",
        "The Workspace root must be outside the source repository.",
      );
    }
    await mkdir(workspaceRoot, { recursive: true });
    const registry = await this.#registry.read();
    const existing = registry.projects.find(
      (project) => pathKey(project.unityProjectPath) === pathKey(unityProjectPath),
    );
    const record: ProjectRecordV1 = {
      schemaVersion: 1,
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

  public async listProjects(): Promise<readonly ProjectRecordV1[]> {
    return (await this.#registry.read()).projects;
  }

  public async prepareCache(projectReference?: string): Promise<ProjectRecordV1> {
    const project = await this.#project(projectReference);
    const library = path.join(project.unityProjectPath, "Library");
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
          kind: "honeybee-full-project-v1",
          seedCommit,
          unityRelativePath: project.unityRelativePath.replaceAll("\\", "/"),
          refreshId: randomUUID(),
        }),
      )
      .digest("hex");
    const build = await this.#storage.beginParent(project.storageCommand, parentId);
    let committed = build;
    if (build.transactionId !== undefined && build.stagingPath !== undefined) {
      const archive = path.join(this.#transactionsRoot, `${build.transactionId}.tar`);
      try {
        await mkdir(this.#transactionsRoot, { recursive: true });
        await this.#git(project.repositoryRoot, [
          "archive",
          "--format=tar",
          `--output=${archive}`,
          seedCommit,
        ]);
        await this.#command(
          "tar.exe",
          ["-xf", archive, "-C", build.stagingPath],
          project.repositoryRoot,
        );
        const targetLibrary = path.join(build.stagingPath, project.unityRelativePath, "Library");
        await mkdir(path.dirname(targetLibrary), { recursive: true });
        await cp(library, targetLibrary, {
          recursive: true,
          force: false,
          errorOnExist: true,
          preserveTimestamps: true,
        });
        committed = await this.#storage.commitParent(project.storageCommand, build.transactionId);
      } catch (error) {
        await this.#storage
          .abortParent(project.storageCommand, build.transactionId)
          .catch(() => undefined);
        throw error;
      } finally {
        await unlink(archive).catch(() => undefined);
      }
    }
    const prepared: ProjectRecordV1 = {
      ...project,
      cache: {
        parentId: committed.parentId ?? parentId,
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

  public async createWorkspace(input: WorkspaceCreateInput): Promise<WorkspaceViewV1> {
    const project = await this.#project(input.project);
    if (project.cache === undefined) {
      throw new WorkspaceCoreError(
        "cache.not-prepared",
        "Run honeybee cache prepare before creating a Workspace.",
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
    const lease = await this.#storage.acquire(project.storageCommand, {
      consumerId,
      workspaceId: storageWorkspaceId,
      parentId: project.cache.parentId,
      clientPid: process.pid,
    });
    const createdAt = now();
    let record: WorkspaceRecordV1 = {
      schemaVersion: 1,
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
    try {
      await symlink(lease.mountPath, workspacePath, "junction");
      await this.#registerWorktree(project, record, input.existingBranch === true);
      await this.#storage.retain(lease.leaseId);
      const attached = await this.#storage.attachRetained(consumerId, storageWorkspaceId);
      record = {
        ...record,
        storageWorkspacePath: attached.workspacePath,
        mountPath: attached.mountPath,
        leaseId: attached.leaseId,
        state: "ready",
        updatedAt: now(),
      };
      await this.#registry.putWorkspace(record);
      return this.#view(record);
    } catch (error) {
      await this.#cleanupFailedCreation(project, record).catch(() => undefined);
      await this.#registry.removeWorkspace(record.workspaceId).catch(() => undefined);
      throw error;
    }
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
    let lease: StorageLease | undefined;
    if (!(await this.#exists(record.mountPath))) {
      lease = await this.#storage.attachRetained(record.consumerId, record.storageWorkspaceId);
    }
    const mountPath = lease?.mountPath ?? record.mountPath;
    if (!(await this.#exists(record.workspacePath))) {
      await symlink(mountPath, record.workspacePath, "junction");
    }
    const project = await this.#project(record.projectId);
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

  public async removeWorkspace(reference: string, projectReference?: string): Promise<void> {
    let record = await this.#workspace(reference, projectReference);
    const project = await this.#project(record.projectId);
    const view = await this.#view(record);
    if (!view.available || view.git === undefined) {
      await this.repairWorkspace(reference, projectReference);
      record = await this.#workspace(reference, projectReference);
    } else if (view.git.dirty) {
      throw new WorkspaceCoreError(
        "workspace.dirty",
        "Commit or discard every tracked and untracked change before removing the Workspace.",
      );
    }
    const refreshed = await this.#view(record);
    if (refreshed.git?.dirty === true) {
      throw new WorkspaceCoreError("workspace.dirty", "The Workspace contains changes.");
    }
    record = { ...record, state: "removing", updatedAt: now() };
    await this.#registry.putWorkspace(record);
    const temporary = path.join(this.#transactionsRoot, `remove-${record.workspaceId}`);
    await mkdir(temporary, { recursive: false });
    try {
      await rename(path.join(record.workspacePath, ".git"), path.join(temporary, ".git"));
      await this.#git(project.repositoryRoot, ["worktree", "repair", temporary]);
      await this.#storage.removeRetained(record.consumerId);
      await unlink(record.workspacePath).catch(() => undefined);
      await this.#git(project.repositoryRoot, ["worktree", "remove", "--force", temporary]);
      await this.#registry.removeWorkspace(record.workspaceId);
    } catch (error) {
      const pointer = path.join(temporary, ".git");
      if ((await this.#exists(pointer)) && (await this.#exists(record.workspacePath))) {
        await rename(pointer, path.join(record.workspacePath, ".git")).catch(() => undefined);
        await this.#git(project.repositoryRoot, ["worktree", "repair", record.workspacePath]).catch(
          () => undefined,
        );
      }
      await this.#registry.putWorkspace({
        ...record,
        state: "cleanup-pending",
        updatedAt: now(),
      });
      throw error;
    } finally {
      await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  public async setTool(tool: WorkspaceTool, executable: string): Promise<void> {
    const resolved = requireAbsolute(executable, `${tool} executable`);
    await access(resolved);
    await this.#registry.setTool(tool, resolved);
  }

  public async launchWorkspace(
    reference: string,
    tool: WorkspaceTool,
    args: readonly string[] = [],
    projectReference?: string,
  ): Promise<void> {
    const repaired = await this.repairWorkspace(reference, projectReference);
    const project = await this.#project(repaired.projectId);
    const registry = await this.#registry.read();
    const configured = registry.tools[tool];
    const executable =
      configured ??
      ({ codex: "codex", claude: "claude", shell: "powershell.exe", unity: undefined } as const)[
        tool
      ];
    if (executable === undefined) {
      throw new WorkspaceCoreError(
        "tool.not-configured",
        `Configure ${tool} with honeybee config tool set before launching it.`,
      );
    }
    const launchArgs =
      tool === "unity"
        ? ["-projectPath", path.join(repaired.workspacePath, project.unityRelativePath), ...args]
        : tool === "shell" && args.length === 0
          ? ["-NoExit"]
          : [...args];
    await this.#launcher.launch(executable, launchArgs, repaired.workspacePath);
  }

  async #registerWorktree(
    project: ProjectRecordV1,
    record: WorkspaceRecordV1,
    existingBranch: boolean,
  ): Promise<void> {
    const temporary = path.join(this.#transactionsRoot, `add-${record.workspaceId}`);
    await mkdir(this.#transactionsRoot, { recursive: true });
    const args = existingBranch
      ? ["worktree", "add", "--no-checkout", temporary, record.branch]
      : ["worktree", "add", "--no-checkout", "-b", record.branch, temporary, record.baseCommit];
    await this.#git(project.repositoryRoot, args);
    try {
      await rename(path.join(temporary, ".git"), path.join(record.workspacePath, ".git"));
      await rm(temporary, { recursive: true, force: true });
      await this.#git(project.repositoryRoot, ["worktree", "repair", record.workspacePath]);
      await this.#git(record.workspacePath, ["reset", "--hard", `refs/heads/${record.branch}`]);
    } catch (error) {
      await this.#git(project.repositoryRoot, ["worktree", "remove", "--force", temporary]).catch(
        () => undefined,
      );
      throw error;
    }
  }

  async #cleanupFailedCreation(project: ProjectRecordV1, record: WorkspaceRecordV1): Promise<void> {
    await this.#git(project.repositoryRoot, [
      "worktree",
      "remove",
      "--force",
      record.workspacePath,
    ]).catch(() => undefined);
    await unlink(record.workspacePath).catch(() => undefined);
    await this.#storage.retain(record.leaseId).catch(() => undefined);
    await this.#storage.removeRetained(record.consumerId).catch(() => undefined);
  }

  async #view(record: WorkspaceRecordV1): Promise<WorkspaceViewV1> {
    if (!(await this.#exists(record.workspacePath))) {
      return { ...record, available: false, state: "repair-required" };
    }
    try {
      const branch = await this.#git(record.workspacePath, ["branch", "--show-current"]);
      const head = await this.#commit(record.workspacePath, "HEAD");
      const status = await this.#git(record.workspacePath, [
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
      ]);
      const changes = status.length === 0 ? [] : status.split(/\r?\n/u).filter(Boolean);
      return {
        ...record,
        available: true,
        git: { branch, head, dirty: changes.length > 0, changes },
      };
    } catch {
      return { ...record, available: false, state: "repair-required" };
    }
  }

  async #project(reference?: string): Promise<ProjectRecordV1> {
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
    if (matches.length === 1) return matches[0] as ProjectRecordV1;
    if (registry.projects.length === 1) return registry.projects[0] as ProjectRecordV1;
    throw new WorkspaceCoreError(
      "project.ambiguous",
      "Use --project because the current directory does not identify one project.",
    );
  }

  async #workspace(reference: string, projectReference?: string): Promise<WorkspaceRecordV1> {
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
    return matches[0] as WorkspaceRecordV1;
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

  async #command(command: string, args: readonly string[], cwd: string): Promise<string> {
    const result = await runCommand(command, args, cwd);
    if (result.exitCode !== 0) {
      throw new WorkspaceCoreError(
        command === "git.exe" ? "git.command-failed" : "command.failed",
        result.stderr.trim() || `${command} failed with exit code ${result.exitCode}.`,
      );
    }
    return result.stdout.trim();
  }

  #git(cwd: string, args: readonly string[]): Promise<string> {
    return this.#command("git.exe", args, cwd);
  }

  #gitResult(cwd: string, args: readonly string[]): Promise<CommandResult> {
    return runCommand("git.exe", args, cwd);
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
