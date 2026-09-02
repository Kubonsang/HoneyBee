import { z } from "zod";

export const DesktopProjectV1Schema = z
  .object({
    projectId: z.string().min(1),
    label: z.string().min(1),
    unityProjectPath: z.string().min(1),
    workspaceRoot: z.string().min(1),
    cacheState: z.enum(["missing", "ready"]),
  })
  .strict();
export type DesktopProjectV1 = z.infer<typeof DesktopProjectV1Schema>;

export const DesktopGitStatusV1Schema = z
  .object({
    branch: z.string(),
    head: z.string(),
    dirty: z.boolean(),
    changes: z.array(z.string()).max(10_000),
  })
  .strict();

export const DesktopWorkspaceV1Schema = z
  .object({
    workspaceId: z.string().min(1),
    projectId: z.string().min(1),
    name: z.string().min(1),
    workspacePath: z.string().min(1),
    state: z.enum(["provisioning", "ready", "repair-required", "removing", "cleanup-pending"]),
    available: z.boolean(),
    branch: z.string().min(1),
    baseCommit: z.string().min(1),
    git: DesktopGitStatusV1Schema.nullable(),
  })
  .strict();
export type DesktopWorkspaceV1 = z.infer<typeof DesktopWorkspaceV1Schema>;

export const DesktopProjectRequestV1Schema = z.object({ projectId: z.string().min(1) }).strict();
export type DesktopProjectRequestV1 = z.infer<typeof DesktopProjectRequestV1Schema>;

export const DesktopWorkspaceRequestV1Schema = z
  .object({ projectId: z.string().min(1), workspaceId: z.string().min(1) })
  .strict();
export type DesktopWorkspaceRequestV1 = z.infer<typeof DesktopWorkspaceRequestV1Schema>;

export const DesktopWorkspaceCreateRequestV1Schema = z
  .object({
    projectId: z.string().min(1),
    name: z.string().min(1).max(64),
    branch: z.string().min(1).max(255),
    base: z.string().min(1).max(255).optional(),
    existingBranch: z.boolean().default(false),
  })
  .strict();
export type DesktopWorkspaceCreateRequestV1 = z.infer<typeof DesktopWorkspaceCreateRequestV1Schema>;

export const DesktopGitDiffRequestV1Schema = DesktopWorkspaceRequestV1Schema.extend({
  path: z.string().min(1).max(4_096).optional(),
}).strict();
export type DesktopGitDiffRequestV1 = z.infer<typeof DesktopGitDiffRequestV1Schema>;

export const DesktopGitDiffV1Schema = z
  .object({
    workspaceId: z.string().min(1),
    path: z.string().optional(),
    content: z.string(),
    truncated: z.boolean(),
  })
  .strict();
export type DesktopGitDiffV1 = z.infer<typeof DesktopGitDiffV1Schema>;

export const DesktopPtyCreateRequestV1Schema = DesktopWorkspaceRequestV1Schema.extend({
  columns: z.number().int().min(20).max(400).default(120),
  rows: z.number().int().min(5).max(200).default(30),
}).strict();
export const DesktopPtySessionRequestV1Schema = z.object({ sessionId: z.string().uuid() }).strict();
export const DesktopPtySnapshotRequestV1Schema = DesktopPtySessionRequestV1Schema.extend({
  afterCursor: z.number().int().nonnegative().default(0),
}).strict();
export const DesktopPtyWriteRequestV1Schema = DesktopPtySessionRequestV1Schema.extend({
  data: z.string().max(64 * 1024),
}).strict();
export const DesktopPtyResizeRequestV1Schema = DesktopPtySessionRequestV1Schema.extend({
  columns: z.number().int().min(20).max(400),
  rows: z.number().int().min(5).max(200),
}).strict();

export const DesktopPtySessionV1Schema = z
  .object({
    sessionId: z.string().uuid(),
    workspaceId: z.string().min(1),
    cwd: z.string().min(1),
    state: z.enum(["running", "exited"]),
    exitCode: z.number().int().nullable(),
  })
  .strict();
export type DesktopPtySessionV1 = z.infer<typeof DesktopPtySessionV1Schema>;

export const DesktopPtySnapshotV1Schema = z
  .object({
    session: DesktopPtySessionV1Schema,
    cursor: z.number().int().nonnegative(),
    chunks: z.array(z.object({ cursor: z.number().int().positive(), data: z.string() }).strict()),
    truncated: z.boolean(),
  })
  .strict();
export type DesktopPtySnapshotV1 = z.infer<typeof DesktopPtySnapshotV1Schema>;

export const DesktopIpcChannels = {
  projects: "desktop.projects.v1",
  workspaces: "desktop.workspaces.v1",
  workspaceCreate: "desktop.workspace.create.v1",
  workspaceRepair: "desktop.workspace.repair.v1",
  workspaceRemove: "desktop.workspace.remove.v1",
  gitDiff: "desktop.git.diff.v1",
  ptyCreate: "desktop.pty.create.v1",
  ptySnapshot: "desktop.pty.snapshot.v1",
  ptyWrite: "desktop.pty.write.v1",
  ptyResize: "desktop.pty.resize.v1",
  ptyClose: "desktop.pty.close.v1",
} as const;

export interface HoneyBeeDesktopApi {
  projects(): Promise<readonly DesktopProjectV1[]>;
  workspaces(request: DesktopProjectRequestV1): Promise<readonly DesktopWorkspaceV1[]>;
  createWorkspace(request: DesktopWorkspaceCreateRequestV1): Promise<DesktopWorkspaceV1>;
  repairWorkspace(request: DesktopWorkspaceRequestV1): Promise<DesktopWorkspaceV1>;
  removeWorkspace(request: DesktopWorkspaceRequestV1): Promise<boolean>;
  gitDiff(request: DesktopGitDiffRequestV1): Promise<DesktopGitDiffV1>;
  createPty(request: z.input<typeof DesktopPtyCreateRequestV1Schema>): Promise<DesktopPtySessionV1>;
  ptySnapshot(
    request: z.input<typeof DesktopPtySnapshotRequestV1Schema>,
  ): Promise<DesktopPtySnapshotV1>;
  writePty(request: z.infer<typeof DesktopPtyWriteRequestV1Schema>): Promise<boolean>;
  resizePty(request: z.infer<typeof DesktopPtyResizeRequestV1Schema>): Promise<boolean>;
  closePty(request: z.infer<typeof DesktopPtySessionRequestV1Schema>): Promise<boolean>;
}
