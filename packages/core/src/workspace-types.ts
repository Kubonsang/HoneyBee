export const WORKSPACE_REGISTRY_SCHEMA_VERSION = 2 as const;

export type WorkspaceState =
  "provisioning" | "ready" | "repair-required" | "removing" | "cleanup-pending";

export interface ProjectCacheV2 {
  readonly kind: "library-only-v1";
  readonly parentId: string;
  readonly seedCommit: string;
  readonly preparedAt: string;
  readonly allocatedBytes?: number;
}

export interface ProjectRecordV2 {
  readonly schemaVersion: 2;
  readonly projectId: string;
  readonly label: string;
  readonly unityProjectPath: string;
  readonly repositoryRoot: string;
  readonly unityRelativePath: string;
  readonly workspaceRoot: string;
  readonly storageCommand: string;
  readonly createdAt: string;
  readonly cache?: ProjectCacheV2;
}

export interface WorkspaceRecordV2 {
  readonly schemaVersion: 2;
  readonly layout: "git-worktree-library-cow-v1";
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

export interface WorkspaceRemovalReceiptV1 {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly name: string;
  readonly branch: string;
  readonly removedAt: string;
}

export interface WorkspaceRegistryV2 {
  readonly schemaVersion: 2;
  readonly projects: readonly ProjectRecordV2[];
  readonly workspaces: readonly WorkspaceRecordV2[];
  readonly removalReceipts: readonly WorkspaceRemovalReceiptV1[];
}

export interface WorkspaceGitStatusV1 {
  readonly branch: string;
  readonly head: string;
  readonly dirty: boolean;
  readonly changes: readonly string[];
}

export interface WorkspaceViewV1 extends WorkspaceRecordV2 {
  readonly available: boolean;
  readonly git?: WorkspaceGitStatusV1;
  /** Internal presentation aid. Existing CLI/Desktop JSON DTOs deliberately omit it. */
  readonly libraryConnected: boolean;
}

export interface WorkspaceRemoveResultV1 {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly name: string;
  readonly branch: string;
  readonly alreadyRemoved: boolean;
}

export type DoctorCheckStatusV1 = "pass" | "warning" | "fail";

export interface DoctorCheckV1 {
  readonly code: string;
  readonly status: DoctorCheckStatusV1;
  readonly message: string;
  readonly subject?: string;
  readonly remediation?: readonly string[];
}

export interface DoctorReportV1 {
  readonly schemaVersion: 1;
  readonly ready: boolean;
  readonly summary: Readonly<{ pass: number; warning: number; fail: number }>;
  readonly checks: readonly DoctorCheckV1[];
}

export interface StorageDiagnosticV1 {
  readonly serviceExists: boolean;
  readonly serviceState?: string;
  readonly receiptExists: boolean;
  readonly receiptValid: boolean;
  readonly componentVersion?: string;
  readonly workspaceRoot?: string;
  readonly workspaceRootAccessible: boolean;
  readonly executableExists: boolean;
  readonly executableDigestMatches: boolean;
  readonly userMatches: boolean;
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

export interface StorageRemovalPreparation {
  readonly transactionId: string;
  readonly runId: string;
  readonly leaseId?: string;
  readonly state: "prepared" | "committed" | "aborted";
  readonly expiresAt?: string;
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
  retain(command: string, leaseId: string): Promise<void>;
  attachRetained(command: string, consumerId: string, workspaceId: string): Promise<StorageLease>;
  prepareRetainedRemoval(
    command: string,
    consumerId: string,
    workspaceId: string,
    transactionId: string,
  ): Promise<StorageRemovalPreparation>;
  commitRetainedRemoval(
    command: string,
    consumerId: string,
    transactionId: string,
  ): Promise<StorageRemovalPreparation>;
  abortRetainedRemoval(
    command: string,
    consumerId: string,
    transactionId: string,
  ): Promise<StorageRemovalPreparation>;
  diagnose?(command: string): Promise<StorageDiagnosticV1>;
  status?(
    command: string,
  ): Promise<Readonly<{ parentCount: number; manualRecoveryRequired: boolean }>>;
}

export interface WorkspaceCoreErrorOptions extends ErrorOptions {
  readonly remediation?: readonly string[];
  readonly upstreamCode?: string;
}

export class WorkspaceCoreError extends Error {
  public readonly code: string;
  public readonly remediation: readonly string[];
  public readonly upstreamCode: string | undefined;

  public constructor(code: string, message: string, options?: WorkspaceCoreErrorOptions) {
    super(message, options);
    this.name = "WorkspaceCoreError";
    this.code = code;
    this.remediation = options?.remediation ?? [];
    this.upstreamCode = options?.upstreamCode;
  }
}
