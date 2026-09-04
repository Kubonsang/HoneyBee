import { z } from "zod";

export const DesktopErrorV1Schema = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1),
    remediation: z.array(z.string().min(1)).max(16),
  })
  .strict();
export type DesktopErrorV1 = z.infer<typeof DesktopErrorV1Schema>;

export const DesktopResultSchema = <T extends z.ZodType>(value: T) =>
  z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), value }).strict(),
    z.object({ ok: z.literal(false), error: DesktopErrorV1Schema }).strict(),
  ]);

export const DesktopProjectV2Schema = z
  .object({
    projectId: z.string().min(1),
    label: z.string().min(1),
    unityProjectPath: z.string().min(1),
    unityRelativePath: z.string(),
    workspaceRoot: z.string().min(1),
    cacheState: z.enum(["missing", "ready"]),
    unityVersion: z.string().nullable(),
  })
  .strict();
export type DesktopProjectV2 = z.infer<typeof DesktopProjectV2Schema>;

export const DesktopProjectCandidateV1Schema = z
  .object({
    source: z.enum(["unity-hub", "honeybee", "folder", "clone"]),
    label: z.string().min(1),
    path: z.string().min(1),
    unityVersion: z.string().nullable(),
    registeredProjectId: z.string().min(1).nullable(),
    setupState: z.enum(["ready", "setup-required", "invalid", "unavailable"]),
  })
  .strict();
export type DesktopProjectCandidateV1 = z.infer<typeof DesktopProjectCandidateV1Schema>;

export const DesktopSetupCheckV1Schema = z
  .object({
    code: z.string().min(1),
    status: z.enum(["pass", "warning", "fail"]),
    message: z.string().min(1),
    remediation: z.array(z.string().min(1)).max(16),
  })
  .strict();

export const DesktopProjectInspectionV1Schema = z
  .object({
    label: z.string().min(1),
    path: z.string().min(1),
    repositoryRoot: z.string().nullable(),
    defaultWorkspaceRoot: z.string().min(1),
    unityVersion: z.string().nullable(),
    registeredProjectId: z.string().min(1).nullable(),
    readyForSetup: z.boolean(),
    checks: z.array(DesktopSetupCheckV1Schema),
  })
  .strict();
export type DesktopProjectInspectionV1 = z.infer<typeof DesktopProjectInspectionV1Schema>;

export const DesktopDoctorReportV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    ready: z.boolean(),
    summary: z
      .object({ pass: z.number().int(), warning: z.number().int(), fail: z.number().int() })
      .strict(),
    checks: z.array(
      z
        .object({
          code: z.string(),
          status: z.enum(["pass", "warning", "fail"]),
          message: z.string(),
          subject: z.string().optional(),
          remediation: z.array(z.string()).optional(),
        })
        .strict(),
    ),
  })
  .strict();
export type DesktopDoctorReportV1 = z.infer<typeof DesktopDoctorReportV1Schema>;

export const DesktopGitStatusV1Schema = z
  .object({
    branch: z.string(),
    head: z.string(),
    dirty: z.boolean(),
    changes: z.array(z.string()).max(10_000),
  })
  .strict();

export const DesktopWorkspaceV2Schema = z
  .object({
    workspaceId: z.string().min(1),
    projectId: z.string().min(1),
    name: z.string().min(1),
    workspacePath: z.string().min(1),
    state: z.enum(["provisioning", "ready", "repair-required", "removing", "cleanup-pending"]),
    available: z.boolean(),
    libraryConnected: z.boolean(),
    branch: z.string().min(1),
    baseCommit: z.string().min(1),
    git: DesktopGitStatusV1Schema.nullable(),
  })
  .strict();
export type DesktopWorkspaceV2 = z.infer<typeof DesktopWorkspaceV2Schema>;

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

export const DesktopProjectPathRequestV1Schema = z.object({ path: z.string().min(1) }).strict();
export const DesktopProjectSetupRequestV1Schema = z
  .object({
    path: z.string().min(1),
    workspaceRoot: z.string().min(1),
    label: z.string().min(1).max(128).optional(),
  })
  .strict();
export type DesktopProjectSetupRequestV1 = z.infer<typeof DesktopProjectSetupRequestV1Schema>;
export const DesktopFolderPickerRequestV1Schema = z
  .object({
    kind: z.enum(["unity-project", "workspace-root", "clone-destination"]),
    defaultPath: z.string().min(1).optional(),
    childName: z
      .string()
      .min(1)
      .max(255)
      .refine(
        (value) =>
          !/[<>:"/\\|?*]/u.test(value) &&
          [...value].every((character) => character.charCodeAt(0) >= 32),
      )
      .refine((value) => value !== "." && value !== ".." && !/[. ]$/u.test(value))
      .optional(),
  })
  .strict();

export const isSafeGitRemote = (value: string): boolean => {
  if (/^git@[^/:\s]+:[^\s]+$/u.test(value)) return true;
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === "https:" || parsed.protocol === "ssh:") &&
      parsed.username.length === 0 &&
      parsed.password.length === 0
    );
  } catch {
    return false;
  }
};
export const DesktopCloneRequestV1Schema = z
  .object({
    url: z
      .string()
      .min(1)
      .max(2_048)
      .refine(isSafeGitRemote, "Use an HTTPS or SSH Git URL without embedded credentials."),
    destination: z.string().min(1).max(4_096),
  })
  .strict();
export const DesktopCloneResultV1Schema = z
  .object({
    path: z.string().min(1),
    label: z.string().min(1),
    unityVersion: z.string().nullable(),
  })
  .strict();
export type DesktopCloneResultV1 = z.infer<typeof DesktopCloneResultV1Schema>;

export const DesktopExternalLaunchRequestV1Schema = DesktopWorkspaceRequestV1Schema.extend({
  tool: z.enum(["cmd", "powershell", "vscode", "unity"]),
}).strict();
export const DesktopProjectUnityLaunchRequestV1Schema = z
  .object({ path: z.string().min(1) })
  .strict();
export const DesktopWindowActionRequestV1Schema = z
  .object({ action: z.enum(["minimize", "toggle-maximize", "close"]) })
  .strict();

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
  projects: "desktop.projects.v2",
  projectCandidates: "desktop.project-candidates.v2",
  projectInspect: "desktop.project.inspect.v2",
  projectSetup: "desktop.project.setup.v2",
  projectPickFolder: "desktop.project.pick-folder.v2",
  projectClone: "desktop.project.clone.v2",
  cachePrepare: "desktop.cache.prepare.v2",
  doctor: "desktop.doctor.v2",
  workspaces: "desktop.workspaces.v2",
  workspaceCreate: "desktop.workspace.create.v2",
  workspaceRepair: "desktop.workspace.repair.v2",
  workspaceRemove: "desktop.workspace.remove.v2",
  externalLaunch: "desktop.external.launch.v2",
  projectUnityLaunch: "desktop.project-unity.launch.v2",
  windowAction: "desktop.window.action.v2",
  gitDiff: "desktop.git.diff.v2",
  ptyCreate: "desktop.pty.create.v2",
  ptySnapshot: "desktop.pty.snapshot.v2",
  ptyWrite: "desktop.pty.write.v2",
  ptyResize: "desktop.pty.resize.v2",
  ptyClose: "desktop.pty.close.v2",
} as const;

export class DesktopApiError extends Error {
  public readonly code: string;
  public readonly remediation: readonly string[];
  public constructor(error: DesktopErrorV1) {
    super(error.message);
    this.name = "DesktopApiError";
    this.code = error.code;
    this.remediation = error.remediation;
  }
}

export interface HoneyBeeDesktopApi {
  projects(): Promise<readonly DesktopProjectV2[]>;
  projectCandidates(): Promise<readonly DesktopProjectCandidateV1[]>;
  inspectProject(
    request: z.infer<typeof DesktopProjectPathRequestV1Schema>,
  ): Promise<DesktopProjectInspectionV1>;
  pickFolder(request: z.infer<typeof DesktopFolderPickerRequestV1Schema>): Promise<string | null>;
  setupProject(request: DesktopProjectSetupRequestV1): Promise<DesktopProjectV2>;
  cloneProject(request: z.infer<typeof DesktopCloneRequestV1Schema>): Promise<DesktopCloneResultV1>;
  prepareCache(request: DesktopProjectRequestV1): Promise<DesktopProjectV2>;
  doctor(): Promise<DesktopDoctorReportV1>;
  workspaces(request: DesktopProjectRequestV1): Promise<readonly DesktopWorkspaceV2[]>;
  createWorkspace(request: DesktopWorkspaceCreateRequestV1): Promise<DesktopWorkspaceV2>;
  repairWorkspace(request: DesktopWorkspaceRequestV1): Promise<DesktopWorkspaceV2>;
  removeWorkspace(request: DesktopWorkspaceRequestV1): Promise<boolean>;
  launchExternal(request: z.infer<typeof DesktopExternalLaunchRequestV1Schema>): Promise<boolean>;
  launchProjectUnity(
    request: z.infer<typeof DesktopProjectUnityLaunchRequestV1Schema>,
  ): Promise<boolean>;
  windowAction(request: z.infer<typeof DesktopWindowActionRequestV1Schema>): Promise<boolean>;
  gitDiff(request: DesktopGitDiffRequestV1): Promise<DesktopGitDiffV1>;
  createPty(request: z.input<typeof DesktopPtyCreateRequestV1Schema>): Promise<DesktopPtySessionV1>;
  ptySnapshot(
    request: z.input<typeof DesktopPtySnapshotRequestV1Schema>,
  ): Promise<DesktopPtySnapshotV1>;
  writePty(request: z.infer<typeof DesktopPtyWriteRequestV1Schema>): Promise<boolean>;
  resizePty(request: z.infer<typeof DesktopPtyResizeRequestV1Schema>): Promise<boolean>;
  closePty(request: z.infer<typeof DesktopPtySessionRequestV1Schema>): Promise<boolean>;
}
