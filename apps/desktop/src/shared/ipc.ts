import { z } from "zod";

import {
  ArtifactViewV1Schema,
  DoctorReportV1Schema,
  EditorPoolSnapshotV1Schema,
  EditorRegistryViewV1Schema,
  PatchActionV1Schema,
  PatchControlResultV1Schema,
  RunControlResultV1Schema,
  RunDetailV1Schema,
  RunSummaryV1Schema,
  RuntimeInfoV1Schema,
  StartUnityWorkV1Schema,
  StartUnityWorksResultV1Schema,
  VerifiedPatchViewV1Schema,
  type ArtifactViewV1,
  type DoctorReportV1,
  type EditorPoolSnapshotV1,
  type EditorRegistryViewV1,
  type PatchControlResultV1,
  type RunControlResultV1,
  type RunDetailV1,
  type RuntimeInfoV1,
  type StartUnityWorksResultV1,
  type VerifiedPatchViewV1,
} from "@honeybee/control-plane-contracts";

export const DesktopProjectProfileV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    profileId: z.string().uuid(),
    label: z.string().trim().min(1).max(120),
    projectPath: z.string().min(1),
    batchConfigPath: z.string().min(1),
    configLabel: z.string().trim().min(1).max(120),
    lastOpenedAt: z.string().datetime(),
  })
  .strict();
export type DesktopProjectProfileV1 = z.infer<typeof DesktopProjectProfileV1Schema>;

const Sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const SemanticVersionSchema = z
  .string()
  .regex(
    /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u,
  );
export const ManagedComponentIdSchema = z.enum(["workspace-storage", "testplay"]);
export type ManagedComponentId = z.infer<typeof ManagedComponentIdSchema>;

export const ComponentPayloadV1Schema = z
  .object({
    role: z.enum(["client", "host", "cli", "bridge-overlay"]),
    source: z.enum(["bundled", "download"]),
    fileName: z.string().min(1).max(255),
    url: z.string().url().startsWith("https://github.com/Kubonsang/").optional(),
    byteLength: z.number().int().positive(),
    sha256: Sha256HexSchema,
    archive: z.enum(["none", "zip"]).default("none"),
  })
  .strict()
  .superRefine((payload, context) => {
    if ((payload.source === "download") !== (payload.url !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["url"],
        message: "Downloaded payloads require one fixed GitHub URL; bundled payloads forbid it.",
      });
    }
  });
export type ComponentPayloadV1 = z.infer<typeof ComponentPayloadV1Schema>;

export const ComponentReleaseV1Schema = z
  .object({
    componentId: ManagedComponentIdSchema,
    version: SemanticVersionSchema,
    honeybeeVersion: SemanticVersionSchema,
    platform: z.literal("win32"),
    architecture: z.literal("x64"),
    protocolVersion: z.literal(3).optional(),
    bridgeOverlayDigest: Sha256HexSchema.optional(),
    payloads: z.array(ComponentPayloadV1Schema).min(1).max(4),
  })
  .strict()
  .superRefine((release, context) => {
    const roles = new Set(release.payloads.map((payload) => payload.role));
    const expected =
      release.componentId === "workspace-storage"
        ? (["client", "host"] as const)
        : (["cli", "bridge-overlay"] as const);
    if (roles.size !== expected.length || expected.some((role) => !roles.has(role))) {
      context.addIssue({
        code: "custom",
        path: ["payloads"],
        message: "The " + release.componentId + " release payload set is incomplete.",
      });
    }
    if (
      release.componentId === "testplay" &&
      (release.protocolVersion !== 3 || release.bridgeOverlayDigest === undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["protocolVersion"],
        message: "TestPlay releases require protocol 3 and an exact Bridge overlay digest.",
      });
    }
  });
export type ComponentReleaseV1 = z.infer<typeof ComponentReleaseV1Schema>;

export const HoneyBeeCompatibilityManifestV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    honeybeeVersion: SemanticVersionSchema,
    workspaceStorage: z.array(ComponentReleaseV1Schema).min(1),
    testplay: z.array(ComponentReleaseV1Schema),
  })
  .strict()
  .superRefine((manifest, context) => {
    for (const [group, releases] of [
      ["workspaceStorage", manifest.workspaceStorage],
      ["testplay", manifest.testplay],
    ] as const) {
      const expected = group === "workspaceStorage" ? "workspace-storage" : "testplay";
      const versions = new Set<string>();
      for (const [index, release] of releases.entries()) {
        if (
          release.componentId !== expected ||
          release.honeybeeVersion !== manifest.honeybeeVersion
        ) {
          context.addIssue({
            code: "custom",
            path: [group, index],
            message: "Compatibility manifest component or HoneyBee version mismatch.",
          });
        }
        if (versions.has(release.version)) {
          context.addIssue({
            code: "custom",
            path: [group, index, "version"],
            message: "Compatibility manifest versions must be unique.",
          });
        }
        versions.add(release.version);
      }
    }
  });
export type HoneyBeeCompatibilityManifestV1 = z.infer<typeof HoneyBeeCompatibilityManifestV1Schema>;

export const InstalledComponentFileV1Schema = z
  .object({
    role: ComponentPayloadV1Schema.shape.role,
    path: z.string().min(1),
    kind: z.enum(["file", "tree"]),
    byteLength: z.number().int().nonnegative(),
    sha256: Sha256HexSchema,
  })
  .strict();

export const InstalledComponentReceiptV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    componentId: ManagedComponentIdSchema,
    version: SemanticVersionSchema,
    manifestDigest: Sha256HexSchema,
    installedAt: z.string().datetime(),
    files: z.array(InstalledComponentFileV1Schema).min(2).max(4),
  })
  .strict();
export type InstalledComponentReceiptV1 = z.infer<typeof InstalledComponentReceiptV1Schema>;

export const ProjectComponentLockV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    componentId: ManagedComponentIdSchema,
    version: SemanticVersionSchema,
    receiptDigest: Sha256HexSchema,
    files: z.array(InstalledComponentFileV1Schema).min(2).max(4),
  })
  .strict();
export type ProjectComponentLockV1 = z.infer<typeof ProjectComponentLockV1Schema>;

export const ActiveWorkspaceStorageV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    version: SemanticVersionSchema,
    receiptDigest: Sha256HexSchema,
    workspaceRoot: z.string().min(1),
    activatedAt: z.string().datetime(),
  })
  .strict();
export type ActiveWorkspaceStorageV1 = z.infer<typeof ActiveWorkspaceStorageV1Schema>;

export const ComponentManagerSnapshotV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    manifestDigest: Sha256HexSchema,
    releases: z.array(ComponentReleaseV1Schema),
    installed: z.array(InstalledComponentReceiptV1Schema),
    activeWorkspaceStorage: ActiveWorkspaceStorageV1Schema.optional(),
  })
  .strict();
export type ComponentManagerSnapshotV1 = z.infer<typeof ComponentManagerSnapshotV1Schema>;
const SetupCommandSchema = z
  .object({
    command: z.string().trim().min(1),
    args: z.array(z.string()).optional(),
    cwd: z.string().min(1).optional(),
  })
  .strict();

export const ManagedUnityEnvironmentV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    environmentId: z.string().uuid(),
    projectPath: z.string().min(1),
    unity: z
      .object({ path: z.string().min(1), version: z.string().min(1), sha256: Sha256HexSchema })
      .strict(),
    testplay: z
      .object({ path: z.string().min(1), sha256: Sha256HexSchema })
      .strict()
      .optional(),
    workspaceStorage: z
      .object({
        path: z.string().min(1),
        sha256: Sha256HexSchema,
        workspaceRoot: z.string().min(1),
        provider: z.string().min(1).max(64),
        parentId: z.string().min(1).max(128),
        compatibilityKey: Sha256HexSchema,
      })
      .strict(),
    agent: SetupCommandSchema,
    bridgeOverlay: z
      .object({
        packageName: z.literal("com.testplay.bridge"),
        sourcePath: z.string().min(1),
        digest: Sha256HexSchema,
      })
      .strict()
      .optional(),
    editorPool: z
      .object({ id: z.literal("unity-editor"), capacity: z.number().int().min(1).max(8) })
      .strict(),
    compatibilityInputs: z
      .object({
        schemaVersion: z.literal(1),
        unityVersion: z.string().min(1),
        unityExecutableSha256: Sha256HexSchema,
        packagesManifestSha256: Sha256HexSchema,
        packagesLockSha256: z.union([Sha256HexSchema, z.literal("missing")]),
        projectSettingsManifestSha256: Sha256HexSchema,
        buildTarget: z.literal("StandaloneWindows64"),
        scriptingBackend: z.string().min(1),
        bridgeOverlayDigest: Sha256HexSchema.optional(),
        bridgeProtocolVersion: z.literal(3).optional(),
      })
      .strict(),
    configuredAt: z.string().datetime(),
  })
  .strict()
  .superRefine((environment, context) => {
    if ((environment.testplay === undefined) !== (environment.bridgeOverlay === undefined)) {
      context.addIssue({
        code: "custom",
        path: environment.testplay === undefined ? ["testplay"] : ["bridgeOverlay"],
        message: "TestPlay and its Bridge overlay must be configured together.",
      });
    }
    if (
      (environment.compatibilityInputs.bridgeOverlayDigest === undefined) !==
      (environment.compatibilityInputs.bridgeProtocolVersion === undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["compatibilityInputs"],
        message: "Bridge compatibility digest and protocol version must be configured together.",
      });
    }
    if (
      (environment.bridgeOverlay === undefined) !==
      (environment.compatibilityInputs.bridgeOverlayDigest === undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["compatibilityInputs", "bridgeOverlayDigest"],
        message: "Bridge compatibility inputs must match the configured Bridge overlay.",
      });
    }
  });
export type ManagedUnityEnvironmentV1 = z.infer<typeof ManagedUnityEnvironmentV1Schema>;

const WorkspaceStorageComponentLockV1Schema = ProjectComponentLockV1Schema.refine(
  (lock) => lock.componentId === "workspace-storage",
  "Workspace storage lock must use the workspace-storage component ID.",
);
const TestPlayComponentLockV1Schema = ProjectComponentLockV1Schema.refine(
  (lock) => lock.componentId === "testplay",
  "TestPlay lock must use the testplay component ID.",
);

export const ManagedUnityEnvironmentV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    environmentId: z.string().uuid(),
    projectPath: z.string().min(1),
    unity: z
      .object({ path: z.string().min(1), version: z.string().min(1), sha256: Sha256HexSchema })
      .strict(),
    storage: z
      .object({
        component: WorkspaceStorageComponentLockV1Schema,
        workspaceRoot: z.string().min(1),
        provider: z.string().min(1).max(64),
        parentId: z.string().min(1).max(128),
        compatibilityKey: Sha256HexSchema,
      })
      .strict(),
    testplay: TestPlayComponentLockV1Schema.optional(),
    agent: SetupCommandSchema,
    editorPool: z
      .object({ id: z.literal("unity-editor"), capacity: z.number().int().min(1).max(8) })
      .strict(),
    compatibilityInputs: z
      .object({
        schemaVersion: z.literal(1),
        unityVersion: z.string().min(1),
        unityExecutableSha256: Sha256HexSchema,
        packagesManifestSha256: Sha256HexSchema,
        packagesLockSha256: z.union([Sha256HexSchema, z.literal("missing")]),
        projectSettingsManifestSha256: Sha256HexSchema,
        buildTarget: z.literal("StandaloneWindows64"),
        scriptingBackend: z.string().min(1),
        bridgeOverlayDigest: Sha256HexSchema.optional(),
        bridgeProtocolVersion: z.literal(3).optional(),
      })
      .strict(),
    configuredAt: z.string().datetime(),
  })
  .strict()
  .superRefine((environment, context) => {
    const bridge = environment.testplay?.files.find((file) => file.role === "bridge-overlay");
    if ((environment.testplay === undefined) !== (bridge === undefined)) {
      context.addIssue({
        code: "custom",
        path: ["testplay", "files"],
        message: "A TestPlay lock requires exactly one Bridge overlay.",
      });
    }
    if (
      (environment.testplay === undefined) !==
      (environment.compatibilityInputs.bridgeOverlayDigest === undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["compatibilityInputs", "bridgeOverlayDigest"],
        message: "Bridge compatibility inputs must match the TestPlay component lock.",
      });
    }
    if (
      bridge !== undefined &&
      bridge.sha256 !== environment.compatibilityInputs.bridgeOverlayDigest
    ) {
      context.addIssue({
        code: "custom",
        path: ["testplay", "files"],
        message: "The locked Bridge digest must match the compatibility key input.",
      });
    }
  });
export type ManagedUnityEnvironmentV2 = z.infer<typeof ManagedUnityEnvironmentV2Schema>;

export const DesktopProjectProfileV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    profileId: z.string().uuid(),
    label: z.string().trim().min(1).max(120),
    projectPath: z.string().min(1),
    batchConfigPath: z.string().min(1),
    configLabel: z.string().trim().min(1).max(120),
    lastOpenedAt: z.string().datetime(),
    environment: ManagedUnityEnvironmentV1Schema,
  })
  .strict();
export type DesktopProjectProfileV2 = z.infer<typeof DesktopProjectProfileV2Schema>;
export const DesktopProjectProfileV3Schema = z
  .object({
    schemaVersion: z.literal(3),
    profileId: z.string().uuid(),
    label: z.string().trim().min(1).max(120),
    projectPath: z.string().min(1),
    batchConfigPath: z.string().min(1),
    configLabel: z.string().trim().min(1).max(120),
    lastOpenedAt: z.string().datetime(),
    environment: ManagedUnityEnvironmentV2Schema,
  })
  .strict();
export type DesktopProjectProfileV3 = z.infer<typeof DesktopProjectProfileV3Schema>;
export const DesktopProjectProfileSchema = z.discriminatedUnion("schemaVersion", [
  DesktopProjectProfileV1Schema,
  DesktopProjectProfileV2Schema,
  DesktopProjectProfileV3Schema,
]);
export type DesktopProjectProfile = z.infer<typeof DesktopProjectProfileSchema>;

export const DesktopBootstrapV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    runtime: RuntimeInfoV1Schema,
    profiles: z.array(DesktopProjectProfileSchema),
  })
  .strict();
export type DesktopBootstrapV1 = z.infer<typeof DesktopBootstrapV1Schema>;

export const SetupCandidateV1Schema = z
  .object({
    path: z.string().min(1),
    label: z.string().min(1),
    version: z.string().min(1).optional(),
    source: z.enum(["environment", "path", "unity-hub", "project", "manual"]),
  })
  .strict();

export const DesktopSetupDiscoveryRequestV1Schema = z
  .object({ schemaVersion: z.literal(1), projectPath: z.string().min(1) })
  .strict();
export const DesktopSetupDiscoveryV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    projectPath: z.string().min(1),
    projectVersion: z.string().min(1).optional(),
    unity: z.array(SetupCandidateV1Schema),
    testplay: z.array(SetupCandidateV1Schema),
    workspaceStorage: z.array(SetupCandidateV1Schema),
    agents: z.array(SetupCandidateV1Schema),
    bridgeOverlays: z.array(SetupCandidateV1Schema),
    suggestedWorkspaceRoot: z.string().min(1),
  })
  .strict();
export type DesktopSetupDiscoveryV1 = z.infer<typeof DesktopSetupDiscoveryV1Schema>;

export const DesktopSetupDraftV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    label: z.string().trim().min(1).max(120),
    projectPath: z.string().min(1),
    unityPath: z.string().min(1),
    testplayPath: z.string().min(1).optional(),
    workspaceStoragePath: z.string().min(1),
    workspaceRoot: z.string().min(1),
    bridgeOverlayPath: z.string().min(1).optional(),
    agent: SetupCommandSchema,
    editorCapacity: z.number().int().min(1).max(8),
  })
  .strict()
  .superRefine((draft, context) => {
    if ((draft.testplayPath === undefined) !== (draft.bridgeOverlayPath === undefined)) {
      context.addIssue({
        code: "custom",
        path: draft.testplayPath === undefined ? ["testplayPath"] : ["bridgeOverlayPath"],
        message: "TestPlay and its Bridge overlay must be configured together.",
      });
    }
  });
export type DesktopSetupDraftV1 = z.infer<typeof DesktopSetupDraftV1Schema>;
export const DesktopSetupDraftV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    label: z.string().trim().min(1).max(120),
    projectPath: z.string().min(1),
    unityPath: z.string().min(1),
    workspaceStorageVersion: SemanticVersionSchema,
    workspaceRoot: z.string().min(1),
    testplayVersion: SemanticVersionSchema.optional(),
    agent: SetupCommandSchema,
    editorCapacity: z.number().int().min(1).max(8),
  })
  .strict();
export type DesktopSetupDraftV2 = z.infer<typeof DesktopSetupDraftV2Schema>;
export const DesktopSetupDraftSchema = z.discriminatedUnion("schemaVersion", [
  DesktopSetupDraftV1Schema,
  DesktopSetupDraftV2Schema,
]);
export type DesktopSetupDraft = z.infer<typeof DesktopSetupDraftSchema>;

export const DesktopSetupIdRequestV1Schema = z
  .object({ schemaVersion: z.literal(1), setupId: z.string().uuid() })
  .strict();
export const DesktopSetupInstallStorageRequestV1Schema = z
  .object({ schemaVersion: z.literal(1), workspaceRoot: z.string().min(1) })
  .strict();
export const DesktopSetupInstallStorageResultV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    installed: z.boolean(),
    message: z.string().min(1),
  })
  .strict();
export const DesktopSetupStatusV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    setupId: z.string().uuid(),
    state: z.enum(["running", "completed", "failed", "cancelled", "recovery-required"]),
    phase: z.string().min(1),
    message: z.string().min(1),
    profile: DesktopProjectProfileSchema.optional(),
  })
  .strict();
export type DesktopSetupStatusV1 = z.infer<typeof DesktopSetupStatusV1Schema>;

export const DesktopSetupPathRequestV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.enum([
      "project",
      "unity",
      "testplay",
      "workspace-storage",
      "workspace-root",
      "agent",
      "bridge-overlay",
      "profile-import",
      "profile-export",
    ]),
  })
  .strict();

export const DesktopProfileIdRequestV1Schema = z
  .object({ schemaVersion: z.literal(1), profileId: z.string().uuid() })
  .strict();
export type DesktopProfileIdRequestV1 = z.infer<typeof DesktopProfileIdRequestV1Schema>;

export const DesktopDoctorRequestV1Schema = DesktopProfileIdRequestV1Schema;
export type DesktopDoctorRequestV1 = z.infer<typeof DesktopDoctorRequestV1Schema>;

export const DesktopStartRequestV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    profileId: z.string().uuid(),
    maxParallelWorks: z.number().int().positive().max(32),
    works: z.array(StartUnityWorkV1Schema).min(1).max(32),
  })
  .strict()
  .superRefine((request, context) => {
    if (request.maxParallelWorks > request.works.length) {
      context.addIssue({
        code: "custom",
        path: ["maxParallelWorks"],
        message: "maxParallelWorks cannot exceed the number of Works.",
      });
    }
  });
export type DesktopStartRequestV1 = z.infer<typeof DesktopStartRequestV1Schema>;

export const DesktopRuntimeSnapshotV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    observedAt: z.string().datetime(),
    runs: z.array(RunSummaryV1Schema),
    editors: EditorRegistryViewV1Schema,
    pool: EditorPoolSnapshotV1Schema,
  })
  .strict();
export type DesktopRuntimeSnapshotV1 = z.infer<typeof DesktopRuntimeSnapshotV1Schema>;

export const DesktopRunRequestV1Schema = z
  .object({ schemaVersion: z.literal(1), runId: z.string().uuid() })
  .strict();
export type DesktopRunRequestV1 = z.infer<typeof DesktopRunRequestV1Schema>;

export const DesktopArtifactRequestV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    runId: z.string().uuid(),
    artifactId: z.string().uuid(),
  })
  .strict();
export type DesktopArtifactRequestV1 = z.infer<typeof DesktopArtifactRequestV1Schema>;

export const DesktopPatchRequestV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    runId: z.string().uuid(),
    patchArtifactId: z.string().uuid(),
  })
  .strict();
export type DesktopPatchRequestV1 = z.infer<typeof DesktopPatchRequestV1Schema>;

export const DesktopPatchControlRequestV1Schema = DesktopPatchRequestV1Schema.extend({
  action: PatchActionV1Schema,
}).strict();
export type DesktopPatchControlRequestV1 = z.infer<typeof DesktopPatchControlRequestV1Schema>;

export const DesktopComponentInstallRequestV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    componentId: z.literal("testplay"),
    version: SemanticVersionSchema,
    approved: z.literal(true),
  })
  .strict();
export const DesktopStorageActivateRequestV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    version: SemanticVersionSchema,
    workspaceRoot: z.string().min(1),
    approved: z.literal(true),
  })
  .strict();

export const DesktopIpcChannels = {
  bootstrap: "desktop.bootstrap.v1",
  chooseProfile: "desktop.profile.choose.v1",
  chooseSetupPath: "desktop.setup.path.choose.v1",
  setupDiscover: "desktop.setup.discover.v1",
  setupStart: "desktop.setup.start.v1",
  setupStatus: "desktop.setup.status.v1",
  setupResume: "desktop.setup.resume.v1",
  setupCancel: "desktop.setup.cancel.v1",
  setupInstallStorage: "desktop.setup.storage.install.v1",
  componentsSnapshot: "desktop.components.snapshot.v1",
  componentInstall: "desktop.components.install.v1",
  storageActivate: "desktop.components.storage.activate.v1",
  setupImport: "desktop.setup.import.v1",
  setupExport: "desktop.setup.export.v1",
  removeProfile: "desktop.profile.remove.v1",
  doctor: "desktop.doctor.v1",
  startWorks: "desktop.works.start.v1",
  runtimeSnapshot: "desktop.runtime.snapshot.v1",
  runDetail: "desktop.run.detail.v1",
  artifactRead: "desktop.artifact.read.v1",
  runResume: "desktop.run.resume.v1",
  runCancel: "desktop.run.cancel.v1",
  patchView: "desktop.patch.view.v1",
  patchControl: "desktop.patch.control.v1",
} as const;

export interface HoneyBeeDesktopApi {
  bootstrap(): Promise<DesktopBootstrapV1>;
  chooseProfile(): Promise<DesktopProjectProfile | null>;
  chooseSetupPath(request: z.infer<typeof DesktopSetupPathRequestV1Schema>): Promise<string | null>;
  discoverSetup(
    request: z.infer<typeof DesktopSetupDiscoveryRequestV1Schema>,
  ): Promise<DesktopSetupDiscoveryV1>;
  startSetup(request: DesktopSetupDraft): Promise<DesktopSetupStatusV1>;
  setupStatus(
    request: z.infer<typeof DesktopSetupIdRequestV1Schema>,
  ): Promise<DesktopSetupStatusV1>;
  resumeSetup(
    request: z.infer<typeof DesktopSetupIdRequestV1Schema>,
  ): Promise<DesktopSetupStatusV1>;
  cancelSetup(
    request: z.infer<typeof DesktopSetupIdRequestV1Schema>,
  ): Promise<DesktopSetupStatusV1>;
  installSetupStorage(
    request: z.infer<typeof DesktopSetupInstallStorageRequestV1Schema>,
  ): Promise<z.infer<typeof DesktopSetupInstallStorageResultV1Schema>>;
  components(): Promise<ComponentManagerSnapshotV1>;
  installComponent(
    request: z.infer<typeof DesktopComponentInstallRequestV1Schema>,
  ): Promise<InstalledComponentReceiptV1>;
  activateStorage(
    request: z.infer<typeof DesktopStorageActivateRequestV1Schema>,
  ): Promise<ActiveWorkspaceStorageV1>;
  importSetup(): Promise<DesktopProjectProfile | null>;
  exportSetup(request: DesktopProfileIdRequestV1): Promise<boolean>;
  removeProfile(request: DesktopProfileIdRequestV1): Promise<DesktopBootstrapV1>;
  doctor(request: DesktopDoctorRequestV1): Promise<DoctorReportV1>;
  startWorks(request: DesktopStartRequestV1): Promise<StartUnityWorksResultV1>;
  runtimeSnapshot(request: DesktopProfileIdRequestV1): Promise<DesktopRuntimeSnapshotV1>;
  runDetail(request: DesktopRunRequestV1): Promise<RunDetailV1>;
  readArtifact(request: DesktopArtifactRequestV1): Promise<ArtifactViewV1>;
  resumeRun(request: DesktopRunRequestV1): Promise<RunControlResultV1>;
  cancelRun(request: DesktopRunRequestV1): Promise<RunControlResultV1>;
  getPatch(request: DesktopPatchRequestV1): Promise<VerifiedPatchViewV1>;
  controlPatch(request: DesktopPatchControlRequestV1): Promise<PatchControlResultV1>;
}

export const DesktopIpcResponseSchemas = {
  bootstrap: DesktopBootstrapV1Schema,
  chooseProfile: DesktopProjectProfileSchema.nullable(),
  chooseSetupPath: z.string().min(1).nullable(),
  setupDiscover: DesktopSetupDiscoveryV1Schema,
  setupStart: DesktopSetupStatusV1Schema,
  setupStatus: DesktopSetupStatusV1Schema,
  setupResume: DesktopSetupStatusV1Schema,
  setupCancel: DesktopSetupStatusV1Schema,
  setupInstallStorage: DesktopSetupInstallStorageResultV1Schema,
  componentsSnapshot: ComponentManagerSnapshotV1Schema,
  componentInstall: InstalledComponentReceiptV1Schema,
  storageActivate: ActiveWorkspaceStorageV1Schema,
  setupImport: DesktopProjectProfileSchema.nullable(),
  setupExport: z.boolean(),
  removeProfile: DesktopBootstrapV1Schema,
  doctor: DoctorReportV1Schema,
  startWorks: StartUnityWorksResultV1Schema,
  runtimeSnapshot: DesktopRuntimeSnapshotV1Schema,
  runDetail: RunDetailV1Schema,
  artifactRead: ArtifactViewV1Schema,
  runResume: RunControlResultV1Schema,
  runCancel: RunControlResultV1Schema,
  patchView: VerifiedPatchViewV1Schema,
  patchControl: PatchControlResultV1Schema,
} as const;

export type DesktopRuntimeInfo = RuntimeInfoV1;
export type DesktopRunDetail = RunDetailV1;
export type DesktopArtifactView = ArtifactViewV1;
export type DesktopEditorPoolSnapshot = EditorPoolSnapshotV1;
export type DesktopEditorRegistryView = EditorRegistryViewV1;
export type DesktopVerifiedPatchView = VerifiedPatchViewV1;
