export const WORKSPACE_REGISTRY_SCHEMA_VERSION = 1 as const;

export type WorkspaceState =
  "provisioning" | "ready" | "repair-required" | "removing" | "cleanup-pending";

export type WorkspaceTool = "codex" | "claude" | "unity" | "shell";

export interface ProjectCacheV1 {
  readonly parentId: string;
  readonly seedCommit: string;
  readonly preparedAt: string;
  readonly allocatedBytes?: number;
}

export interface ProjectRecordV1 {
  readonly schemaVersion: 1;
  readonly projectId: string;
  readonly label: string;
  readonly unityProjectPath: string;
  readonly repositoryRoot: string;
  readonly unityRelativePath: string;
  readonly workspaceRoot: string;
  readonly storageCommand: string;
  readonly createdAt: string;
  readonly cache?: ProjectCacheV1;
}

export interface WorkspaceRecordV1 {
  readonly schemaVersion: 1;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly name: string;
  readonly workspacePath: string;
  readonly storageWorkspaceId: string;
  readonly storageWorkspacePath: string;
  readonly mountPath: string;
  readonly consumerId: string;
  readonly leaseId: string;
  readonly parentId: string;
  readonly branch: string;
  readonly baseCommit: string;
  readonly state: WorkspaceState;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WorkspaceRegistryV1 {
  readonly schemaVersion: 1;
  readonly projects: readonly ProjectRecordV1[];
  readonly workspaces: readonly WorkspaceRecordV1[];
  readonly tools: Readonly<Partial<Record<WorkspaceTool, string>>>;
}

export interface WorkspaceGitStatusV1 {
  readonly branch: string;
  readonly head: string;
  readonly dirty: boolean;
  readonly changes: readonly string[];
}

export interface WorkspaceViewV1 extends WorkspaceRecordV1 {
  readonly available: boolean;
  readonly git?: WorkspaceGitStatusV1;
}

export interface StorageParentBuild {
  readonly transactionId?: string;
  readonly stagingPath?: string;
  readonly parentId?: string;
  readonly allocatedBytes?: number;
}

export interface StorageLease {
  readonly leaseId: string;
  readonly workspacePath: string;
  readonly mountPath: string;
  readonly allocatedBytes?: number;
}

export interface WorkspaceStoragePort {
  beginParent(command: string, compatibilityKey: string): Promise<StorageParentBuild>;
  commitParent(command: string, transactionId: string): Promise<StorageParentBuild>;
  abortParent(command: string, transactionId: string): Promise<void>;
  acquire(
    command: string,
    input: Readonly<{
      consumerId: string;
      workspaceId: string;
      parentId: string;
      clientPid: number;
    }>,
  ): Promise<StorageLease>;
  retain(leaseId: string): Promise<void>;
  attachRetained(consumerId: string, workspaceId: string): Promise<StorageLease>;
  removeRetained(consumerId: string): Promise<void>;
}

export interface WorkspaceToolLauncher {
  launch(executable: string, args: readonly string[], cwd: string): Promise<void>;
}

export class WorkspaceCoreError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorkspaceCoreError";
    this.code = code;
  }
}
