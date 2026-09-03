import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, unlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  WORKSPACE_REGISTRY_SCHEMA_VERSION,
  WorkspaceCoreError,
  type ProjectCacheV2,
  type ProjectRecordV2,
  type WorkspaceRecordV2,
  type WorkspaceRemovalReceiptV1,
  type WorkspaceRegistryV2,
  type WorkspaceState,
} from "./workspace-types.js";

const REGISTRY_LOCK_TIMEOUT_MS = 30_000;
const REGISTRY_LOCK_POLL_MS = 25;
const PROCESS_IDENTITY_TIMEOUT_MS = 15_000;
const PROJECT_CACHE_KIND = "library-only-v1" as const;
const WORKSPACE_LAYOUT = "git-worktree-library-cow-v1" as const;
const WORKSPACE_STATES = new Set<WorkspaceState>([
  "provisioning",
  "ready",
  "repair-required",
  "removing",
  "cleanup-pending",
]);

type JsonObject = Record<string, unknown>;

interface RegistryLeaseOwner {
  readonly identity: string;
  readonly leaseId?: string;
  readonly pid?: number;
  readonly processIdentity?: string;
}

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const emptyRegistry = (): WorkspaceRegistryV2 => ({
  schemaVersion: WORKSPACE_REGISTRY_SCHEMA_VERSION,
  projects: [],
  workspaces: [],
  removalReceipts: [],
});

const isRecord = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const string = (value: unknown, label: string): string => {
  if (typeof value !== "string" || value.length === 0) {
    throw new WorkspaceCoreError("registry.invalid", `${label} is invalid.`);
  }
  return value;
};

const absolutePath = (value: unknown, label: string): string => {
  const parsed = string(value, label);
  if (!path.isAbsolute(parsed)) {
    throw new WorkspaceCoreError("registry.invalid", `${label} must be absolute.`);
  }
  return path.resolve(parsed);
};

const timestamp = (value: unknown, label: string): string => {
  const parsed = string(value, label);
  if (!Number.isFinite(Date.parse(parsed))) {
    throw new WorkspaceCoreError("registry.invalid", `${label} is invalid.`);
  }
  return parsed;
};

const optionalBytes = (value: unknown, label: string): number | undefined => {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new WorkspaceCoreError("registry.invalid", `${label} is invalid.`);
  }
  return value as number;
};

const parseCache = (value: unknown): ProjectCacheV2 | undefined => {
  if (value === undefined) return undefined;
  if (!isRecord(value) || value.kind !== PROJECT_CACHE_KIND) {
    throw new WorkspaceCoreError(
      "registry.layout-unsupported",
      "The registered cache is not a Library-only parent.",
    );
  }
  const allocatedBytes = optionalBytes(value.allocatedBytes, "cache.allocatedBytes");
  return {
    kind: PROJECT_CACHE_KIND,
    parentId: string(value.parentId, "cache.parentId"),
    seedCommit: string(value.seedCommit, "cache.seedCommit"),
    preparedAt: timestamp(value.preparedAt, "cache.preparedAt"),
    ...(allocatedBytes === undefined ? {} : { allocatedBytes }),
  };
};

const parseProject = (value: unknown): ProjectRecordV2 => {
  if (!isRecord(value) || (value.schemaVersion !== 1 && value.schemaVersion !== 2)) {
    throw new WorkspaceCoreError("registry.invalid", "A project record is invalid.");
  }
  const cache = parseCache(value.cache);
  return {
    schemaVersion: WORKSPACE_REGISTRY_SCHEMA_VERSION,
    projectId: string(value.projectId, "project.projectId"),
    label: string(value.label, "project.label"),
    unityProjectPath: absolutePath(value.unityProjectPath, "project.unityProjectPath"),
    repositoryRoot: absolutePath(value.repositoryRoot, "project.repositoryRoot"),
    unityRelativePath: typeof value.unityRelativePath === "string" ? value.unityRelativePath : "",
    workspaceRoot: absolutePath(value.workspaceRoot, "project.workspaceRoot"),
    storageCommand: absolutePath(value.storageCommand, "project.storageCommand"),
    createdAt: timestamp(value.createdAt, "project.createdAt"),
    ...(cache === undefined ? {} : { cache }),
  };
};

const parseWorkspace = (value: unknown): WorkspaceRecordV2 => {
  if (!isRecord(value) || (value.schemaVersion !== 1 && value.schemaVersion !== 2)) {
    throw new WorkspaceCoreError("registry.invalid", "A Workspace record is invalid.");
  }
  if (value.layout !== WORKSPACE_LAYOUT) {
    throw new WorkspaceCoreError(
      "registry.layout-unsupported",
      "A pre-adoption Full-project Workspace cannot be loaded by Workspace Core v0.7.",
    );
  }
  if (typeof value.state !== "string" || !WORKSPACE_STATES.has(value.state as WorkspaceState)) {
    throw new WorkspaceCoreError("registry.invalid", "workspace.state is invalid.");
  }
  return {
    schemaVersion: WORKSPACE_REGISTRY_SCHEMA_VERSION,
    layout: WORKSPACE_LAYOUT,
    workspaceId: string(value.workspaceId, "workspace.workspaceId"),
    projectId: string(value.projectId, "workspace.projectId"),
    name: string(value.name, "workspace.name"),
    workspacePath: absolutePath(value.workspacePath, "workspace.workspacePath"),
    storageWorkspaceId: string(value.storageWorkspaceId, "workspace.storageWorkspaceId"),
    storageWorkspacePath: absolutePath(
      value.storageWorkspacePath,
      "workspace.storageWorkspacePath",
    ),
    mountPath: absolutePath(value.mountPath, "workspace.mountPath"),
    consumerId: string(value.consumerId, "workspace.consumerId"),
    leaseId: string(value.leaseId, "workspace.leaseId"),
    parentId: string(value.parentId, "workspace.parentId"),
    branch: string(value.branch, "workspace.branch"),
    baseCommit: string(value.baseCommit, "workspace.baseCommit"),
    state: value.state as WorkspaceState,
    createdAt: timestamp(value.createdAt, "workspace.createdAt"),
    updatedAt: timestamp(value.updatedAt, "workspace.updatedAt"),
  };
};

const parseRemovalReceipt = (value: unknown): WorkspaceRemovalReceiptV1 => {
  if (!isRecord(value)) {
    throw new WorkspaceCoreError("registry.invalid", "A Workspace removal receipt is invalid.");
  }
  return {
    workspaceId: string(value.workspaceId, "removalReceipt.workspaceId"),
    projectId: string(value.projectId, "removalReceipt.projectId"),
    name: string(value.name, "removalReceipt.name"),
    branch: string(value.branch, "removalReceipt.branch"),
    removedAt: timestamp(value.removedAt, "removalReceipt.removedAt"),
  };
};

const parseRegistry = (value: unknown): WorkspaceRegistryV2 => {
  if (
    !isRecord(value) ||
    (value.schemaVersion !== 1 && value.schemaVersion !== WORKSPACE_REGISTRY_SCHEMA_VERSION) ||
    !Array.isArray(value.projects) ||
    !Array.isArray(value.workspaces)
  ) {
    throw new WorkspaceCoreError(
      "registry.invalid",
      "The HoneyBee Workspace registry is invalid or uses an unsupported schema.",
    );
  }
  const projects = value.projects.map(parseProject);
  const workspaces = value.workspaces.map(parseWorkspace);
  const removalReceipts =
    value.removalReceipts === undefined
      ? []
      : Array.isArray(value.removalReceipts)
        ? value.removalReceipts.map(parseRemovalReceipt)
        : (() => {
            throw new WorkspaceCoreError(
              "registry.invalid",
              "Workspace removal receipts are invalid.",
            );
          })();
  if (new Set(projects.map((item) => item.projectId)).size !== projects.length) {
    throw new WorkspaceCoreError("registry.invalid", "Project IDs must be unique.");
  }
  if (new Set(workspaces.map((item) => item.workspaceId)).size !== workspaces.length) {
    throw new WorkspaceCoreError("registry.invalid", "Workspace IDs must be unique.");
  }
  const projectIds = new Set(projects.map((item) => item.projectId));
  if (workspaces.some((item) => !projectIds.has(item.projectId))) {
    throw new WorkspaceCoreError("registry.invalid", "A Workspace references a missing project.");
  }
  return {
    schemaVersion: WORKSPACE_REGISTRY_SCHEMA_VERSION,
    projects,
    workspaces,
    removalReceipts,
  };
};

const errorCode = (error: unknown): string | undefined =>
  isRecord(error) && typeof error.code === "string" ? error.code : undefined;

const contentionError = (error: unknown): boolean =>
  ["EEXIST", "ENOTEMPTY", "EPERM", "EACCES", "ENOENT"].includes(errorCode(error) ?? "");

const processExists = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
};

const execFileAsync = promisify(execFile);

const processIdentity = async (pid: number): Promise<string | undefined> => {
  if (!processExists(pid)) return undefined;
  try {
    if (process.platform === "win32") {
      const command =
        `$process = Get-Process -Id ${pid} -ErrorAction Stop; ` +
        "[Console]::Out.Write($process.StartTime.ToUniversalTime().Ticks)";
      const { stdout } = await execFileAsync(
        "powershell.exe",
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
        { encoding: "utf8", timeout: PROCESS_IDENTITY_TIMEOUT_MS, windowsHide: true },
      );
      const ticks = stdout.trim();
      return /^\d+$/u.test(ticks) ? `win32:${ticks}` : undefined;
    }
    if (process.platform === "linux") {
      const [bootId, stat] = await Promise.all([
        readFile("/proc/sys/kernel/random/boot_id", "utf8"),
        readFile(`/proc/${pid}/stat`, "utf8"),
      ]);
      const commandEnd = stat.lastIndexOf(")");
      const startTicks = stat
        .slice(commandEnd + 1)
        .trim()
        .split(/\s+/u)[19];
      return commandEnd >= 0 && startTicks !== undefined
        ? `linux:${bootId.trim()}:${startTicks}`
        : undefined;
    }
    const { stdout } = await execFileAsync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 5_000,
      windowsHide: true,
    });
    const startedAt = stdout.trim().replace(/\s+/gu, " ");
    return startedAt.length === 0 ? undefined : `${process.platform}:${startedAt}`;
  } catch {
    return undefined;
  }
};

class RegistryLock {
  readonly #root: string;

  public constructor(root: string) {
    this.#root = path.resolve(root, ".workspace-registry-lock-v2");
  }

  public async acquire(): Promise<{ release(): Promise<void> }> {
    const ownerIdentity = await processIdentity(process.pid);
    if (ownerIdentity === undefined) {
      throw new WorkspaceCoreError(
        "registry.lock-failed",
        "Could not establish the registry writer process identity.",
      );
    }
    const leaseId = randomUUID();
    const active = path.join(this.#root, "active");
    const candidate = path.join(this.#root, "candidates", leaseId);
    const staleRoot = path.join(this.#root, "stale");
    const released = path.join(this.#root, "released", leaseId);
    await Promise.all(
      [path.dirname(candidate), staleRoot, path.dirname(released)].map((directory) =>
        mkdir(directory, { recursive: true }),
      ),
    );
    await mkdir(candidate);
    const owner = await open(path.join(candidate, "owner.json"), "wx");
    try {
      await owner.writeFile(
        `${JSON.stringify({ schemaVersion: 1, leaseId, pid: process.pid, processIdentity: ownerIdentity })}\n`,
        "utf8",
      );
      await owner.sync();
    } finally {
      await owner.close();
    }
    let acquired = false;
    try {
      for (let attempt = 0; attempt < 16; attempt += 1) {
        try {
          await rename(candidate, active);
          acquired = true;
          let done = false;
          return {
            release: async () => {
              if (done) return;
              const current = await this.#read(active);
              if (current?.leaseId !== leaseId) {
                done = true;
                return;
              }
              for (let releaseAttempt = 0; releaseAttempt < 16; releaseAttempt += 1) {
                try {
                  await rename(active, released);
                  done = true;
                  await rm(released, { recursive: true, force: true });
                  return;
                } catch (error) {
                  if (errorCode(error) === "ENOENT") {
                    done = true;
                    return;
                  }
                  if (!contentionError(error) || releaseAttempt === 15) {
                    throw new WorkspaceCoreError(
                      "registry.lock-failed",
                      "Could not release the Workspace registry lock.",
                      { cause: error },
                    );
                  }
                  await delay(REGISTRY_LOCK_POLL_MS * (releaseAttempt + 1));
                }
              }
            },
          };
        } catch (error) {
          if (!contentionError(error)) throw error;
        }
        const current = await this.#read(active);
        if (current === undefined) continue;
        if (await this.#active(current)) {
          throw new WorkspaceCoreError(
            "registry.lock-contended",
            "Another process is updating the Workspace registry.",
          );
        }
        await rename(active, path.join(staleRoot, `${Date.now()}-${current.identity}`)).catch(
          (error: unknown) => {
            if (!contentionError(error)) throw error;
          },
        );
      }
      throw new WorkspaceCoreError("registry.lock-failed", "Could not acquire the registry lock.");
    } finally {
      if (!acquired) await rm(candidate, { recursive: true, force: true });
    }
  }

  async #read(active: string): Promise<RegistryLeaseOwner | undefined> {
    try {
      const raw = await readFile(path.join(active, "owner.json"), "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (isRecord(parsed)) {
        const leaseId = typeof parsed.leaseId === "string" ? parsed.leaseId : undefined;
        const pid =
          Number.isSafeInteger(parsed.pid) && (parsed.pid as number) > 0
            ? (parsed.pid as number)
            : undefined;
        const identity =
          typeof parsed.processIdentity === "string" ? parsed.processIdentity : undefined;
        if (leaseId !== undefined) {
          return {
            identity: leaseId,
            leaseId,
            ...(pid === undefined ? {} : { pid }),
            ...(identity === undefined ? {} : { processIdentity: identity }),
          };
        }
      }
      return { identity: createHash("sha256").update(raw).digest("hex") };
    } catch (error) {
      if (errorCode(error) === "ENOENT") return undefined;
      throw new WorkspaceCoreError("registry.lock-failed", "Could not inspect the registry lock.");
    }
  }

  async #active(owner: RegistryLeaseOwner): Promise<boolean> {
    if (owner.pid === undefined) return false;
    const observed = await processIdentity(owner.pid);
    if (observed === undefined) return processExists(owner.pid);
    return owner.processIdentity === undefined || owner.processIdentity === observed;
  }
}

export class WorkspaceRegistryStore {
  readonly #registryPath: string;
  readonly #legacyPath: string;
  readonly #lock: RegistryLock;

  public constructor(dataRoot: string) {
    const resolvedRoot = path.resolve(dataRoot);
    this.#registryPath = path.join(resolvedRoot, "workspace-registry-v2.json");
    this.#legacyPath = path.join(resolvedRoot, "workspace-registry-v1.json");
    this.#lock = new RegistryLock(resolvedRoot);
  }

  public get path(): string {
    return this.#registryPath;
  }

  public async read(): Promise<WorkspaceRegistryV2> {
    try {
      return parseRegistry(JSON.parse(await readFile(this.#registryPath, "utf8")));
    } catch (error) {
      if (errorCode(error) !== "ENOENT") {
        if (error instanceof WorkspaceCoreError) throw error;
        throw new WorkspaceCoreError("registry.invalid", "Could not read the Workspace registry.", {
          cause: error,
        });
      }
    }
    try {
      return parseRegistry(JSON.parse(await readFile(this.#legacyPath, "utf8")));
    } catch (error) {
      if (errorCode(error) === "ENOENT") return emptyRegistry();
      if (error instanceof WorkspaceCoreError) throw error;
      throw new WorkspaceCoreError("registry.invalid", "Could not read the legacy registry.", {
        cause: error,
      });
    }
  }

  async #write(value: WorkspaceRegistryV2): Promise<void> {
    const registry = parseRegistry(value);
    await mkdir(path.dirname(this.#registryPath), { recursive: true });
    const temporary = `${this.#registryPath}.tmp-${randomUUID()}`;
    const handle = await open(temporary, "wx");
    try {
      await handle.writeFile(`${JSON.stringify(registry, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporary, this.#registryPath);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  public async update(
    change: (current: WorkspaceRegistryV2) => WorkspaceRegistryV2,
  ): Promise<WorkspaceRegistryV2> {
    const deadline = Date.now() + REGISTRY_LOCK_TIMEOUT_MS;
    for (;;) {
      try {
        const lease = await this.#lock.acquire();
        try {
          const next = change(await this.read());
          await this.#write(next);
          return next;
        } finally {
          await lease.release();
        }
      } catch (error) {
        if (
          error instanceof WorkspaceCoreError &&
          error.code === "registry.lock-contended" &&
          Date.now() < deadline
        ) {
          await delay(REGISTRY_LOCK_POLL_MS);
          continue;
        }
        if (error instanceof WorkspaceCoreError) throw error;
        throw new WorkspaceCoreError("registry.lock-failed", "Could not update the registry.", {
          cause: error,
        });
      }
    }
  }

  public async putProject(project: ProjectRecordV2): Promise<void> {
    await this.update((current) => ({
      ...current,
      projects: [
        ...current.projects.filter((item) => item.projectId !== project.projectId),
        project,
      ],
    }));
  }

  public async putWorkspace(workspace: WorkspaceRecordV2): Promise<void> {
    await this.update((current) => ({
      ...current,
      workspaces: [
        ...current.workspaces.filter((item) => item.workspaceId !== workspace.workspaceId),
        workspace,
      ],
    }));
  }

  public async removeWorkspace(workspaceId: string): Promise<void> {
    await this.update((current) => ({
      ...current,
      workspaces: current.workspaces.filter((item) => item.workspaceId !== workspaceId),
    }));
  }

  public async completeWorkspaceRemoval(
    workspace: WorkspaceRecordV2,
  ): Promise<WorkspaceRemovalReceiptV1> {
    const receipt: WorkspaceRemovalReceiptV1 = {
      workspaceId: workspace.workspaceId,
      projectId: workspace.projectId,
      name: workspace.name,
      branch: workspace.branch,
      removedAt: new Date().toISOString(),
    };
    await this.update((current) => {
      const otherProjects = current.removalReceipts.filter(
        (item) => item.projectId !== workspace.projectId,
      );
      const projectReceipts = [
        ...current.removalReceipts.filter(
          (item) =>
            item.projectId === workspace.projectId && item.workspaceId !== workspace.workspaceId,
        ),
        receipt,
      ]
        .sort((left, right) => right.removedAt.localeCompare(left.removedAt))
        .slice(0, 256);
      return {
        ...current,
        workspaces: current.workspaces.filter((item) => item.workspaceId !== workspace.workspaceId),
        removalReceipts: [...otherProjects, ...projectReceipts],
      };
    });
    return receipt;
  }
}
