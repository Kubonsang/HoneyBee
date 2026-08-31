import { z } from "zod";

import {
  AgentAdapterV1Schema,
  AgentLaunchTrustV1Schema,
  type AgentLaunchTrustV1,
} from "@honeybee/orchestration-contracts";

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
export const SetupCommandSchema = z
  .object({
    command: z.string().trim().min(1),
    args: z.array(z.string()).optional(),
    cwd: z.string().min(1).optional(),
  })
  .strict();
export type SetupCommand = z.infer<typeof SetupCommandSchema>;

export const DesktopAgentProviderV1Schema = z.enum(["codex", "claude", "opencode", "custom"]);
export type DesktopAgentProviderV1 = z.infer<typeof DesktopAgentProviderV1Schema>;

export const DesktopAgentProfileV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    agentId: z.string().uuid(),
    displayName: z.string().trim().min(1).max(120),
    provider: DesktopAgentProviderV1Schema,
    command: SetupCommandSchema,
    trust: AgentLaunchTrustV1Schema.optional(),
    adapter: AgentAdapterV1Schema,
    enabled: z.boolean(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((profile, context) => {
    if (
      (profile.adapter === "codex-app-server-v1" && profile.provider !== "codex") ||
      (profile.adapter === "opencode-acp-v1" && profile.provider !== "opencode") ||
      (profile.provider === "claude" && profile.adapter !== "stdio-framed-v2")
    ) {
      context.addIssue({
        code: "custom",
        path: ["adapter"],
        message: "The selected Agent provider does not support this adapter.",
      });
    }
  });
export type DesktopAgentProfileV1 = z.infer<typeof DesktopAgentProfileV1Schema>;
export type { AgentLaunchTrustV1 };

export const DesktopAgentStatusV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    agentId: z.string().uuid(),
    status: z.enum([
      "ready",
      "not-installed",
      "authentication-required",
      "unsupported-version",
      "protocol-incompatible",
      "probe-failed",
      "trust-required",
      "trust-changed",
      "disabled",
    ]),
    checkedAt: z.string().datetime(),
    version: z.string().trim().min(1).max(200).optional(),
    summary: z.string().trim().min(1).max(500),
  })
  .strict();
export type DesktopAgentStatusV1 = z.infer<typeof DesktopAgentStatusV1Schema>;

export const DesktopAgentUpsertRequestV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    agentId: z.string().uuid().optional(),
    displayName: z.string().trim().min(1).max(120),
    provider: DesktopAgentProviderV1Schema,
    adapter: AgentAdapterV1Schema.default("stdio-framed-v2"),
    command: SetupCommandSchema,
    payloadPaths: z.array(z.string().min(1)).max(15).optional(),
    enabled: z.boolean().default(true),
  })
  .strict();
export type DesktopAgentUpsertRequestV1 = z.input<typeof DesktopAgentUpsertRequestV1Schema>;

export const DesktopAgentIdRequestV1Schema = z
  .object({ schemaVersion: z.literal(1), agentId: z.string().uuid() })
  .strict();
export type DesktopAgentIdRequestV1 = z.infer<typeof DesktopAgentIdRequestV1Schema>;

export const DesktopAgentConnectResultV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    agentId: z.string().uuid(),
    launched: z.boolean(),
    message: z.string().min(1).max(500),
  })
  .strict();
export type DesktopAgentConnectResultV1 = z.infer<typeof DesktopAgentConnectResultV1Schema>;

export const DesktopPendingAgentApprovalV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    approvalId: z.string().uuid(),
    runId: z.string().uuid(),
    stepId: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u),
    kind: z.enum(["command", "file-change", "permissions", "unknown"]),
    summary: z.string().trim().min(1).max(500),
    requestedAt: z.string().datetime(),
  })
  .strict();
export type DesktopPendingAgentApprovalV1 = z.infer<typeof DesktopPendingAgentApprovalV1Schema>;

export const DesktopAgentApprovalListV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    approvals: z.array(DesktopPendingAgentApprovalV1Schema),
  })
  .strict();
export type DesktopAgentApprovalListV1 = z.infer<typeof DesktopAgentApprovalListV1Schema>;

export const DesktopAgentApprovalResponseV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    approvalId: z.string().uuid(),
    decision: z.enum(["allow-once", "deny"]),
  })
  .strict();
export type DesktopAgentApprovalResponseV1 = z.infer<typeof DesktopAgentApprovalResponseV1Schema>;

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

export const DesktopBootstrapV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    runtime: RuntimeInfoV1Schema,
    profiles: z.array(DesktopProjectProfileSchema),
    agents: z.array(DesktopAgentProfileV1Schema),
    agentStatuses: z.array(DesktopAgentStatusV1Schema),
    preferredAgentIds: z.record(z.string().uuid(), z.string().uuid()),
    lastUsedAgentId: z.string().uuid().optional(),
  })
  .strict();
export type DesktopBootstrapV2 = z.infer<typeof DesktopBootstrapV2Schema>;

export const DesktopProjectCatalogEntryV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    projectPath: z.string().min(1),
    label: z.string().trim().min(1).max(120),
    source: z.enum(["managed", "unity-hub"]),
    profileId: z.string().uuid().optional(),
    projectVersion: z.string().trim().min(1).max(120).optional(),
    lastOpenedAt: z.string().datetime().optional(),
  })
  .strict()
  .superRefine((entry, context) => {
    if (entry.source === "managed" && entry.profileId === undefined) {
      context.addIssue({
        code: "custom",
        path: ["profileId"],
        message: "Managed catalog entries require a project profile ID.",
      });
    }
  });
export type DesktopProjectCatalogEntryV1 = z.infer<typeof DesktopProjectCatalogEntryV1Schema>;

export const DesktopProjectCatalogV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    observedAt: z.string().datetime(),
    projects: z.array(DesktopProjectCatalogEntryV1Schema).max(200),
  })
  .strict();
export type DesktopProjectCatalogV1 = z.infer<typeof DesktopProjectCatalogV1Schema>;

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

export const DesktopProjectDiscoveryV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    projectPath: z.string().min(1),
    projectVersion: z.string().min(1).optional(),
    unity: z.array(SetupCandidateV1Schema),
    agents: z.array(SetupCandidateV1Schema),
  })
  .strict();
export type DesktopProjectDiscoveryV1 = z.infer<typeof DesktopProjectDiscoveryV1Schema>;

export const DesktopProjectAddRequestV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    projectPath: z.string().min(1),
    unityPath: z.string().min(1),
    agent: SetupCommandSchema,
    testplayVersion: SemanticVersionSchema.optional(),
  })
  .strict();
export type DesktopProjectAddRequestV1 = z.infer<typeof DesktopProjectAddRequestV1Schema>;

export const DesktopProjectAddRequestV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    projectPath: z.string().min(1),
    unityPath: z.string().min(1),
    preferredAgentId: z.string().uuid(),
    testplayVersion: SemanticVersionSchema.optional(),
  })
  .strict();
export type DesktopProjectAddRequestV2 = z.infer<typeof DesktopProjectAddRequestV2Schema>;

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
    kind: z.enum(["project", "unity", "agent", "profile-import", "profile-export"]),
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

export const DesktopStartRequestV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    profileId: z.string().uuid(),
    defaultAgentId: z.string().uuid(),
    maxParallelWorks: z.number().int().positive().max(32),
    works: z
      .array(StartUnityWorkV1Schema.extend({ agentId: z.string().uuid().optional() }).strict())
      .min(1)
      .max(32),
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
export type DesktopStartRequestV2 = z.infer<typeof DesktopStartRequestV2Schema>;

export const DesktopCloneRunDraftRequestV1Schema = z
  .object({ schemaVersion: z.literal(1), runId: z.string().uuid() })
  .strict();
export type DesktopCloneRunDraftRequestV1 = z.infer<typeof DesktopCloneRunDraftRequestV1Schema>;

export const DesktopClonedWorkDraftV1Schema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u),
    task: z.string().trim().min(1),
    priority: z.enum(["interactive", "validation", "background"]),
    compile: z.boolean(),
    warmTest: z.boolean(),
    filter: z.string(),
    agentId: z.string().uuid().nullable(),
    agentLabel: z.string().trim().min(1).max(200),
  })
  .strict();
export type DesktopClonedWorkDraftV1 = z.infer<typeof DesktopClonedWorkDraftV1Schema>;

export const DesktopClonedRunDraftV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    sourceRunId: z.string().uuid(),
    profileId: z.string().uuid(),
    defaultAgentId: z.string().uuid().nullable(),
    maxParallelWorks: z.number().int().positive().max(32),
    works: z.array(DesktopClonedWorkDraftV1Schema).min(1).max(32),
  })
  .strict();
export type DesktopClonedRunDraftV1 = z.infer<typeof DesktopClonedRunDraftV1Schema>;

export const DesktopProjectAgentPreferenceRequestV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    profileId: z.string().uuid(),
    agentId: z.string().uuid(),
  })
  .strict();

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

export const DesktopTerminalModeV1Schema = z.enum(["readable", "raw"]);
export type DesktopTerminalModeV1 = z.infer<typeof DesktopTerminalModeV1Schema>;

export const DesktopTerminalSnapshotRequestV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    runId: z.string().uuid(),
    afterCursor: z.number().int().nonnegative(),
    mode: DesktopTerminalModeV1Schema,
  })
  .strict();
export type DesktopTerminalSnapshotRequestV1 = z.infer<
  typeof DesktopTerminalSnapshotRequestV1Schema
>;

export const DesktopTerminalEntryV1Schema = z
  .object({
    cursor: z.number().int().positive(),
    runId: z.string().uuid(),
    stepId: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u),
    timestamp: z.string().datetime(),
    channel: z.enum(["system", "assistant", "tool", "approval", "stderr", "raw"]),
    mode: DesktopTerminalModeV1Schema,
    text: z.string().max(16_384),
    direction: z.enum(["provider", "honeybee"]).optional(),
  })
  .strict();
export type DesktopTerminalEntryV1 = z.infer<typeof DesktopTerminalEntryV1Schema>;

export const DesktopTerminalSnapshotV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    instanceId: z.string().uuid(),
    cursor: z.number().int().nonnegative(),
    state: z.enum(["running", "completed", "unavailable"]),
    entries: z.array(DesktopTerminalEntryV1Schema).max(5_000),
    truncated: z.boolean(),
    rawAvailable: z.boolean(),
  })
  .strict();
export type DesktopTerminalSnapshotV1 = z.infer<typeof DesktopTerminalSnapshotV1Schema>;

const DesktopRelativePathV1Schema = z
  .string()
  .max(1_024)
  .refine((value) => !value.includes("\\0"), "Paths cannot contain NUL bytes.");

export const DesktopProjectTreeRequestV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    profileId: z.string().uuid(),
    relativePath: DesktopRelativePathV1Schema,
  })
  .strict();
export type DesktopProjectTreeRequestV1 = z.infer<typeof DesktopProjectTreeRequestV1Schema>;

export const DesktopProjectTreeEntryV1Schema = z
  .object({
    name: z.string().min(1).max(255),
    relativePath: z.string().min(1).max(1_024),
    kind: z.enum(["file", "directory"]),
    byteLength: z.number().int().nonnegative().optional(),
  })
  .strict();
export type DesktopProjectTreeEntryV1 = z.infer<typeof DesktopProjectTreeEntryV1Schema>;

export const DesktopProjectTreeV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    relativePath: DesktopRelativePathV1Schema,
    entries: z.array(DesktopProjectTreeEntryV1Schema).max(1_000),
    truncated: z.boolean(),
  })
  .strict();
export type DesktopProjectTreeV1 = z.infer<typeof DesktopProjectTreeV1Schema>;

export const DesktopProjectFileRequestV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    profileId: z.string().uuid(),
    relativePath: DesktopRelativePathV1Schema.min(1),
  })
  .strict();
export type DesktopProjectFileRequestV1 = z.infer<typeof DesktopProjectFileRequestV1Schema>;

export const DesktopProjectFileV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    relativePath: z.string().min(1).max(1_024),
    encoding: z.literal("utf8"),
    content: z.string().max(1_048_576),
    byteLength: z.number().int().nonnegative(),
    truncated: z.boolean(),
    language: z.string().min(1).max(32),
  })
  .strict();
export type DesktopProjectFileV1 = z.infer<typeof DesktopProjectFileV1Schema>;

export const DesktopProjectSearchRequestV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    profileId: z.string().uuid(),
    query: z.string().trim().min(1).max(120),
    maxResults: z.number().int().min(1).max(200).default(100),
  })
  .strict();
export type DesktopProjectSearchRequestV1 = z.infer<typeof DesktopProjectSearchRequestV1Schema>;

export const DesktopProjectSearchV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    query: z.string().min(1).max(120),
    matches: z.array(DesktopProjectTreeEntryV1Schema).max(200),
    truncated: z.boolean(),
  })
  .strict();
export type DesktopProjectSearchV1 = z.infer<typeof DesktopProjectSearchV1Schema>;

export const DesktopPtyKindV1Schema = z.enum(["agent", "shell"]);
export type DesktopPtyKindV1 = z.infer<typeof DesktopPtyKindV1Schema>;

export const DesktopPtyCreateRequestV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    profileId: z.string().uuid(),
    kind: DesktopPtyKindV1Schema,
    agentId: z.string().uuid().optional(),
    columns: z.number().int().min(20).max(500),
    rows: z.number().int().min(5).max(200),
  })
  .strict()
  .superRefine((request, context) => {
    if ((request.kind === "agent") !== (request.agentId !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["agentId"],
        message: "Agent PTYs require one Agent; shell PTYs forbid Agent IDs.",
      });
    }
  });
export type DesktopPtyCreateRequestV1 = z.infer<typeof DesktopPtyCreateRequestV1Schema>;

export const DesktopPtySessionRequestV1Schema = z
  .object({ schemaVersion: z.literal(1), sessionId: z.string().uuid() })
  .strict();
export type DesktopPtySessionRequestV1 = z.infer<typeof DesktopPtySessionRequestV1Schema>;

export const DesktopPtySnapshotRequestV1Schema = DesktopPtySessionRequestV1Schema.extend({
  afterCursor: z.number().int().nonnegative(),
}).strict();
export type DesktopPtySnapshotRequestV1 = z.infer<typeof DesktopPtySnapshotRequestV1Schema>;

export const DesktopPtyWriteRequestV1Schema = DesktopPtySessionRequestV1Schema.extend({
  data: z.string().min(1).max(65_536),
}).strict();
export type DesktopPtyWriteRequestV1 = z.infer<typeof DesktopPtyWriteRequestV1Schema>;

export const DesktopPtyResizeRequestV1Schema = DesktopPtySessionRequestV1Schema.extend({
  columns: z.number().int().min(20).max(500),
  rows: z.number().int().min(5).max(200),
}).strict();
export type DesktopPtyResizeRequestV1 = z.infer<typeof DesktopPtyResizeRequestV1Schema>;

export const DesktopPtySessionV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    sessionId: z.string().uuid(),
    profileId: z.string().uuid(),
    kind: DesktopPtyKindV1Schema,
    label: z.string().min(1).max(120),
    state: z.enum(["running", "exited"]),
    exitCode: z.number().int().nullable().optional(),
    createdAt: z.string().datetime(),
  })
  .strict();
export type DesktopPtySessionV1 = z.infer<typeof DesktopPtySessionV1Schema>;

export const DesktopPtyChunkV1Schema = z
  .object({ cursor: z.number().int().positive(), data: z.string().max(65_536) })
  .strict();

export const DesktopPtySnapshotV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    session: DesktopPtySessionV1Schema,
    cursor: z.number().int().nonnegative(),
    chunks: z.array(DesktopPtyChunkV1Schema).max(1_000),
    truncated: z.boolean(),
  })
  .strict();
export type DesktopPtySnapshotV1 = z.infer<typeof DesktopPtySnapshotV1Schema>;

export const DesktopGitSnapshotRequestV1Schema = z
  .object({ schemaVersion: z.literal(1), profileId: z.string().uuid() })
  .strict();
export type DesktopGitSnapshotRequestV1 = z.infer<typeof DesktopGitSnapshotRequestV1Schema>;

export const DesktopGitRunRequestV1Schema = DesktopGitSnapshotRequestV1Schema.extend({
  runId: z.string().uuid(),
}).strict();
export type DesktopGitRunRequestV1 = z.infer<typeof DesktopGitRunRequestV1Schema>;

export const DesktopGitWorktreeV1Schema = z
  .object({
    path: z.string().min(1),
    branch: z.string().min(1).max(255),
    head: z.string().regex(/^[0-9a-f]{40,64}$/u),
    kind: z.enum(["source", "integration", "work", "other"]),
    runId: z.string().uuid().optional(),
    status: z.enum(["clean", "dirty", "conflict"]),
  })
  .strict();
export type DesktopGitWorktreeV1 = z.infer<typeof DesktopGitWorktreeV1Schema>;

export const DesktopGitSnapshotV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    available: z.boolean(),
    projectPath: z.string().min(1),
    repositoryRoot: z.string().min(1).optional(),
    currentBranch: z.string().min(1).max(255).optional(),
    worktrees: z.array(DesktopGitWorktreeV1Schema).max(128),
    message: z.string().min(1).max(512).optional(),
  })
  .strict();
export type DesktopGitSnapshotV1 = z.infer<typeof DesktopGitSnapshotV1Schema>;

export const DesktopGitActionResultV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    disposition: z.enum(["materialized", "merged", "integrated", "conflict", "already-complete"]),
    branch: z.string().min(1).max(255),
    integrationBranch: z.string().min(1).max(255),
    conflictPaths: z.array(z.string().min(1).max(4_096)),
    snapshot: DesktopGitSnapshotV1Schema,
  })
  .strict();
export type DesktopGitActionResultV1 = z.infer<typeof DesktopGitActionResultV1Schema>;

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

export const DesktopDeveloperSettingsV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    dogfoodMetricsEnabled: z.boolean(),
    rawAgentProtocolEnabled: z.boolean(),
  })
  .strict();
export type DesktopDeveloperSettingsV1 = z.infer<typeof DesktopDeveloperSettingsV1Schema>;

export const DesktopPreferencesV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    density: z.enum(["comfortable", "compact"]),
    terminalFontSize: z.number().int().min(10).max(18),
    fileExplorerWidth: z.number().int().min(220).max(420),
    workbenchDefault: z.enum(["files", "agent", "shell", "work"]),
    reducedMotion: z.boolean(),
  })
  .strict();
export type DesktopPreferencesV1 = z.infer<typeof DesktopPreferencesV1Schema>;

export const DesktopDeveloperSettingsUpdateV1Schema = DesktopDeveloperSettingsV1Schema;

export const DesktopDogfoodStartRequestV1Schema = z
  .object({ schemaVersion: z.literal(1), profileId: z.string().uuid() })
  .strict();

export const DesktopDogfoodFinalizeRequestV1Schema = z
  .object({ schemaVersion: z.literal(1), sessionId: z.string().uuid() })
  .strict();

export const DesktopDogfoodOpenEvidenceRequestV1Schema = DesktopDogfoodFinalizeRequestV1Schema;

export const DesktopDogfoodSummaryV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    verdict: z.enum(["incomplete", "passed", "failed"]),
    sessionWallClockMs: z.number().int().nonnegative().nullable(),
    workCount: z.number().int().nonnegative(),
    completedWorks: z.number().int().nonnegative(),
    failedWorks: z.number().int().nonnegative(),
    changedFiles: z.number().int().nonnegative(),
    testCount: z.number().int().nonnegative(),
    agentOverlapMs: z.number().int().nonnegative(),
    maxConcurrentAgents: z.number().int().nonnegative(),
    residualTotal: z.number().int().nonnegative(),
    issueCount: z.number().int().nonnegative(),
  })
  .strict();
export type DesktopDogfoodSummaryV1 = z.infer<typeof DesktopDogfoodSummaryV1Schema>;

export const DesktopDogfoodSessionV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    sessionId: z.string().uuid(),
    profileId: z.string().uuid(),
    projectLabel: z.string().min(1).max(120),
    startedAt: z.string().datetime(),
    stoppedAt: z.string().datetime().optional(),
    evidencePath: z.string().min(1),
    workCount: z.number().int().nonnegative(),
    summary: DesktopDogfoodSummaryV1Schema.optional(),
  })
  .strict();
export type DesktopDogfoodSessionV1 = z.infer<typeof DesktopDogfoodSessionV1Schema>;

export const DesktopDogfoodStatusV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    enabled: z.boolean(),
    state: z.enum(["idle", "recording", "incomplete", "passed", "failed"]),
    observedAt: z.string().datetime(),
    session: DesktopDogfoodSessionV1Schema.optional(),
  })
  .strict();
export type DesktopDogfoodStatusV1 = z.infer<typeof DesktopDogfoodStatusV1Schema>;

export const DesktopIpcChannels = {
  bootstrap: "desktop.bootstrap.v1",
  projectCatalog: "desktop.project-catalog.v1",
  chooseProfile: "desktop.profile.choose.v1",
  chooseSetupPath: "desktop.setup.path.choose.v1",
  projectDiscover: "desktop.project.discover.v1",
  projectAdd: "desktop.project.add.v1",
  setupStatus: "desktop.setup.status.v1",
  setupResume: "desktop.setup.resume.v1",
  setupCancel: "desktop.setup.cancel.v1",
  componentsSnapshot: "desktop.components.snapshot.v1",
  componentInstall: "desktop.components.install.v1",
  setupImport: "desktop.setup.import.v1",
  setupExport: "desktop.setup.export.v1",
  removeProfile: "desktop.profile.remove.v1",
  doctor: "desktop.doctor.v1",
  startWorks: "desktop.works.start.v1",
  cloneRunDraft: "desktop.run.clone-draft.v1",
  runtimeSnapshot: "desktop.runtime.snapshot.v1",
  runDetail: "desktop.run.detail.v1",
  terminalSnapshot: "desktop.terminal.snapshot.v1",
  terminalWindowOpen: "desktop.terminal.window.open.v1",
  projectTree: "desktop.project.tree.v1",
  projectFileRead: "desktop.project.file.read.v1",
  projectSearch: "desktop.project.search.v1",
  ptyCreate: "desktop.pty.create.v1",
  ptySnapshot: "desktop.pty.snapshot.v1",
  ptyWrite: "desktop.pty.write.v1",
  ptyResize: "desktop.pty.resize.v1",
  ptyClose: "desktop.pty.close.v1",
  gitSnapshot: "desktop.git.snapshot.v1",
  gitMaterializeRun: "desktop.git.materialize-run.v1",
  gitMergeRun: "desktop.git.merge-run.v1",
  gitFinalizeIntegration: "desktop.git.finalize-integration.v1",
  artifactRead: "desktop.artifact.read.v1",
  runResume: "desktop.run.resume.v1",
  runCancel: "desktop.run.cancel.v1",
  patchView: "desktop.patch.view.v1",
  patchControl: "desktop.patch.control.v1",
  agentsUpsert: "desktop.agents.upsert.v1",
  agentsRemove: "desktop.agents.remove.v1",
  agentsProbe: "desktop.agents.probe.v1",
  agentsConnect: "desktop.agents.connect.v1",
  agentApprovalsList: "desktop.agent-approvals.list.v1",
  agentApprovalRespond: "desktop.agent-approvals.respond.v1",
  projectAgentPreference: "desktop.project.agent-preference.v1",
  developerSettingsGet: "desktop.developer-settings.get.v1",
  developerSettingsUpdate: "desktop.developer-settings.update.v1",
  preferencesGet: "desktop.preferences.get.v1",
  preferencesUpdate: "desktop.preferences.update.v1",
  dogfoodStatus: "desktop.dogfood.status.v1",
  dogfoodStart: "desktop.dogfood.start.v1",
  dogfoodFinalize: "desktop.dogfood.finalize.v1",
  dogfoodOpenEvidence: "desktop.dogfood.open-evidence.v1",
} as const;

export interface HoneyBeeDesktopApi {
  bootstrap(): Promise<DesktopBootstrapV2>;
  projectCatalog(): Promise<DesktopProjectCatalogV1>;
  chooseProfile(): Promise<DesktopProjectProfile | null>;
  chooseSetupPath(request: z.infer<typeof DesktopSetupPathRequestV1Schema>): Promise<string | null>;
  discoverProject(
    request: z.infer<typeof DesktopSetupDiscoveryRequestV1Schema>,
  ): Promise<DesktopProjectDiscoveryV1>;
  addProject(request: DesktopProjectAddRequestV2): Promise<DesktopSetupStatusV1>;
  setupStatus(
    request: z.infer<typeof DesktopSetupIdRequestV1Schema>,
  ): Promise<DesktopSetupStatusV1>;
  resumeSetup(
    request: z.infer<typeof DesktopSetupIdRequestV1Schema>,
  ): Promise<DesktopSetupStatusV1>;
  cancelSetup(
    request: z.infer<typeof DesktopSetupIdRequestV1Schema>,
  ): Promise<DesktopSetupStatusV1>;
  components(): Promise<ComponentManagerSnapshotV1>;
  installComponent(
    request: z.infer<typeof DesktopComponentInstallRequestV1Schema>,
  ): Promise<InstalledComponentReceiptV1>;
  importSetup(): Promise<DesktopProjectProfile | null>;
  exportSetup(request: DesktopProfileIdRequestV1): Promise<boolean>;
  removeProfile(request: DesktopProfileIdRequestV1): Promise<DesktopBootstrapV2>;
  doctor(request: DesktopDoctorRequestV1): Promise<DoctorReportV1>;
  startWorks(request: DesktopStartRequestV2): Promise<StartUnityWorksResultV1>;
  cloneRunDraft(request: DesktopCloneRunDraftRequestV1): Promise<DesktopClonedRunDraftV1>;
  runtimeSnapshot(request: DesktopProfileIdRequestV1): Promise<DesktopRuntimeSnapshotV1>;
  runDetail(request: DesktopRunRequestV1): Promise<RunDetailV1>;
  terminalSnapshot(request: DesktopTerminalSnapshotRequestV1): Promise<DesktopTerminalSnapshotV1>;
  openTerminalWindow(request: DesktopRunRequestV1): Promise<boolean>;
  projectTree(request: DesktopProjectTreeRequestV1): Promise<DesktopProjectTreeV1>;
  readProjectFile(request: DesktopProjectFileRequestV1): Promise<DesktopProjectFileV1>;
  searchProject(request: DesktopProjectSearchRequestV1): Promise<DesktopProjectSearchV1>;
  createPty(request: DesktopPtyCreateRequestV1): Promise<DesktopPtySessionV1>;
  ptySnapshot(request: DesktopPtySnapshotRequestV1): Promise<DesktopPtySnapshotV1>;
  writePty(request: DesktopPtyWriteRequestV1): Promise<boolean>;
  resizePty(request: DesktopPtyResizeRequestV1): Promise<boolean>;
  closePty(request: DesktopPtySessionRequestV1): Promise<boolean>;
  gitSnapshot(request: DesktopGitSnapshotRequestV1): Promise<DesktopGitSnapshotV1>;
  materializeRunWorktree(request: DesktopGitRunRequestV1): Promise<DesktopGitActionResultV1>;
  mergeRunWorktree(request: DesktopGitRunRequestV1): Promise<DesktopGitActionResultV1>;
  finalizeIntegration(request: DesktopGitRunRequestV1): Promise<DesktopGitActionResultV1>;
  readArtifact(request: DesktopArtifactRequestV1): Promise<ArtifactViewV1>;
  resumeRun(request: DesktopRunRequestV1): Promise<RunControlResultV1>;
  cancelRun(request: DesktopRunRequestV1): Promise<RunControlResultV1>;
  getPatch(request: DesktopPatchRequestV1): Promise<VerifiedPatchViewV1>;
  controlPatch(request: DesktopPatchControlRequestV1): Promise<PatchControlResultV1>;
  upsertAgent(request: DesktopAgentUpsertRequestV1): Promise<DesktopBootstrapV2>;
  removeAgent(request: DesktopAgentIdRequestV1): Promise<DesktopBootstrapV2>;
  probeAgent(request: DesktopAgentIdRequestV1): Promise<DesktopAgentStatusV1>;
  connectAgent(request: DesktopAgentIdRequestV1): Promise<DesktopAgentConnectResultV1>;
  listAgentApprovals(): Promise<DesktopAgentApprovalListV1>;
  respondAgentApproval(
    request: DesktopAgentApprovalResponseV1,
  ): Promise<DesktopAgentApprovalListV1>;
  setProjectAgentPreference(
    request: z.infer<typeof DesktopProjectAgentPreferenceRequestV1Schema>,
  ): Promise<DesktopBootstrapV2>;
  developerSettings(): Promise<DesktopDeveloperSettingsV1>;
  updateDeveloperSettings(request: DesktopDeveloperSettingsV1): Promise<DesktopDeveloperSettingsV1>;
  preferences(): Promise<DesktopPreferencesV1>;
  updatePreferences(request: DesktopPreferencesV1): Promise<DesktopPreferencesV1>;
  dogfoodStatus(): Promise<DesktopDogfoodStatusV1>;
  startDogfood(
    request: z.infer<typeof DesktopDogfoodStartRequestV1Schema>,
  ): Promise<DesktopDogfoodStatusV1>;
  finalizeDogfood(
    request: z.infer<typeof DesktopDogfoodFinalizeRequestV1Schema>,
  ): Promise<DesktopDogfoodStatusV1>;
  openDogfoodEvidence(
    request: z.infer<typeof DesktopDogfoodOpenEvidenceRequestV1Schema>,
  ): Promise<boolean>;
}

export const DesktopIpcResponseSchemas = {
  bootstrap: DesktopBootstrapV2Schema,
  projectCatalog: DesktopProjectCatalogV1Schema,
  chooseProfile: DesktopProjectProfileSchema.nullable(),
  chooseSetupPath: z.string().min(1).nullable(),
  projectDiscover: DesktopProjectDiscoveryV1Schema,
  projectAdd: DesktopSetupStatusV1Schema,
  setupStatus: DesktopSetupStatusV1Schema,
  setupResume: DesktopSetupStatusV1Schema,
  setupCancel: DesktopSetupStatusV1Schema,
  componentsSnapshot: ComponentManagerSnapshotV1Schema,
  componentInstall: InstalledComponentReceiptV1Schema,
  setupImport: DesktopProjectProfileSchema.nullable(),
  setupExport: z.boolean(),
  removeProfile: DesktopBootstrapV2Schema,
  doctor: DoctorReportV1Schema,
  startWorks: StartUnityWorksResultV1Schema,
  cloneRunDraft: DesktopClonedRunDraftV1Schema,
  runtimeSnapshot: DesktopRuntimeSnapshotV1Schema,
  runDetail: RunDetailV1Schema,
  terminalSnapshot: DesktopTerminalSnapshotV1Schema,
  terminalWindowOpen: z.boolean(),
  projectTree: DesktopProjectTreeV1Schema,
  projectFileRead: DesktopProjectFileV1Schema,
  projectSearch: DesktopProjectSearchV1Schema,
  ptyCreate: DesktopPtySessionV1Schema,
  ptySnapshot: DesktopPtySnapshotV1Schema,
  ptyWrite: z.boolean(),
  ptyResize: z.boolean(),
  ptyClose: z.boolean(),
  gitSnapshot: DesktopGitSnapshotV1Schema,
  gitMaterializeRun: DesktopGitActionResultV1Schema,
  gitMergeRun: DesktopGitActionResultV1Schema,
  gitFinalizeIntegration: DesktopGitActionResultV1Schema,
  artifactRead: ArtifactViewV1Schema,
  runResume: RunControlResultV1Schema,
  runCancel: RunControlResultV1Schema,
  patchView: VerifiedPatchViewV1Schema,
  patchControl: PatchControlResultV1Schema,
  agentsUpsert: DesktopBootstrapV2Schema,
  agentsRemove: DesktopBootstrapV2Schema,
  agentsProbe: DesktopAgentStatusV1Schema,
  agentsConnect: DesktopAgentConnectResultV1Schema,
  agentApprovalsList: DesktopAgentApprovalListV1Schema,
  agentApprovalRespond: DesktopAgentApprovalListV1Schema,
  projectAgentPreference: DesktopBootstrapV2Schema,
  developerSettingsGet: DesktopDeveloperSettingsV1Schema,
  developerSettingsUpdate: DesktopDeveloperSettingsV1Schema,
  preferencesGet: DesktopPreferencesV1Schema,
  preferencesUpdate: DesktopPreferencesV1Schema,
  dogfoodStatus: DesktopDogfoodStatusV1Schema,
  dogfoodStart: DesktopDogfoodStatusV1Schema,
  dogfoodFinalize: DesktopDogfoodStatusV1Schema,
  dogfoodOpenEvidence: z.boolean(),
} as const;

export type DesktopRuntimeInfo = RuntimeInfoV1;
export type DesktopRunDetail = RunDetailV1;
export type DesktopArtifactView = ArtifactViewV1;
export type DesktopEditorPoolSnapshot = EditorPoolSnapshotV1;
export type DesktopEditorRegistryView = EditorRegistryViewV1;
export type DesktopVerifiedPatchView = VerifiedPatchViewV1;
