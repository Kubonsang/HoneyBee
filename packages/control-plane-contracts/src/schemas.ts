import { z } from "zod";

import {
  ArtifactRefSchema,
  FailureMetadataSchema,
  ResourceIdSchema,
  RunIdSchema,
  StepIdSchema,
  UnityCapabilitySchema,
  UnityEditorObservationV1Schema,
  UnityEditorSlotIdSchema,
  UnityWorkPrioritySchema,
} from "@honeybee/orchestration-contracts";

const IsoDateSchema = z.string().datetime();

export const RuntimeInfoV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    apiVersion: z.literal(1),
    runtimeVersion: z.string().min(1),
    stateRoot: z.string().min(1),
  })
  .strict();
export type RuntimeInfoV1 = z.infer<typeof RuntimeInfoV1Schema>;

export const RuntimeProjectProfileV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    projectPath: z.string().min(1),
    batchConfigPath: z.string().min(1),
    agentProbe: z
      .object({
        command: z.string().min(1),
        args: z.array(z.string()).max(32).optional(),
        cwd: z.string().min(1).optional(),
        timeoutMs: z.number().int().positive().max(30_000).default(5_000),
      })
      .strict()
      .optional(),
  })
  .strict();
export type RuntimeProjectProfileV1 = z.infer<typeof RuntimeProjectProfileV1Schema>;

export const DoctorCheckV1Schema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9.-]{0,63}$/u),
    label: z.string().min(1).max(120),
    status: z.enum(["pass", "warning", "fail"]),
    code: z.string().regex(/^[a-z][a-z0-9.-]{0,127}$/u),
    summary: z.string().min(1).max(512),
    target: z.string().min(1).max(2048).optional(),
    version: z.string().min(1).max(128).optional(),
    expectedDigest: z
      .string()
      .regex(/^[0-9a-f]{64}$/u)
      .optional(),
    actualDigest: z
      .string()
      .regex(/^[0-9a-f]{64}$/u)
      .optional(),
  })
  .strict();
export type DoctorCheckV1 = z.infer<typeof DoctorCheckV1Schema>;

export const DoctorReportV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    checkedAt: IsoDateSchema,
    projectPath: z.string().min(1),
    ok: z.boolean(),
    checks: z.array(DoctorCheckV1Schema),
  })
  .strict();
export type DoctorReportV1 = z.infer<typeof DoctorReportV1Schema>;

export const RunActionV1Schema = z.enum(["resume", "cancel"]);
export type RunActionV1 = z.infer<typeof RunActionV1Schema>;

export const RunSummaryV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    runId: RunIdSchema,
    journalSchemaVersion: z.number().int().min(1).max(5).optional(),
    mode: z.string().min(1).max(64),
    status: z.string().min(1).max(64),
    phase: z.string().min(1).max(120),
    startedAt: IsoDateSchema.optional(),
    updatedAt: IsoDateSchema.optional(),
    terminal: z.boolean(),
    executorPresent: z.boolean(),
    projectPath: z.string().min(1).optional(),
    parentRunId: RunIdSchema.optional(),
    workId: StepIdSchema.optional(),
    priority: UnityWorkPrioritySchema.optional(),
    assignedEditor: UnityEditorSlotIdSchema.optional(),
    allowedActions: z.array(RunActionV1Schema),
  })
  .strict();
export type RunSummaryV1 = z.infer<typeof RunSummaryV1Schema>;

export const RunEventViewV1Schema = z
  .object({
    sequence: z.number().int().positive(),
    timestamp: IsoDateSchema,
    type: z.string().min(1).max(128),
    stepId: StepIdSchema.optional(),
    summary: z.string().min(1).max(512),
    artifacts: z.array(ArtifactRefSchema),
  })
  .strict();
export type RunEventViewV1 = z.infer<typeof RunEventViewV1Schema>;

export const RunDetailV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    summary: RunSummaryV1Schema,
    events: z.array(RunEventViewV1Schema),
    artifacts: z.array(ArtifactRefSchema),
    failure: FailureMetadataSchema.optional(),
    message: z.string().min(1).max(512).optional(),
  })
  .strict();
export type RunDetailV1 = z.infer<typeof RunDetailV1Schema>;

const PoolTicketV1Schema = z
  .object({
    requestId: z.string().uuid(),
    ownerRunId: RunIdSchema,
    ownerWorkId: StepIdSchema,
    priority: UnityWorkPrioritySchema,
    ticket: z.number().int().positive(),
  })
  .strict();

export const EditorPoolSnapshotV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    poolId: ResourceIdSchema,
    capacity: z.number().int().min(1).max(32),
    active: z.array(
      PoolTicketV1Schema.extend({
        leaseId: z.string().uuid(),
        slotId: UnityEditorSlotIdSchema,
      }).strict(),
    ),
    queued: z.array(PoolTicketV1Schema),
  })
  .strict();
export type EditorPoolSnapshotV1 = z.infer<typeof EditorPoolSnapshotV1Schema>;

export const ArtifactViewV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    runId: RunIdSchema,
    artifact: ArtifactRefSchema,
    encoding: z.enum(["utf8", "base64"]),
    content: z.string(),
  })
  .strict();
export type ArtifactViewV1 = z.infer<typeof ArtifactViewV1Schema>;

export const PatchActionV1Schema = z.enum(["apply", "reject"]);
export type PatchActionV1 = z.infer<typeof PatchActionV1Schema>;

const PatchFileContentV1Schema = z
  .object({
    contentDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    byteLength: z.number().int().nonnegative(),
    format: z.enum(["text", "binary", "unavailable"]),
    text: z.string().max(524_288).optional(),
    truncated: z.boolean(),
  })
  .strict();

export const PatchFileViewV1Schema = z
  .object({
    path: z.string().min(1).max(4096),
    operation: z.enum(["add", "modify", "delete"]),
    before: PatchFileContentV1Schema.optional(),
    after: PatchFileContentV1Schema.optional(),
  })
  .strict();
export type PatchFileViewV1 = z.infer<typeof PatchFileViewV1Schema>;

export const VerifiedPatchViewV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    runId: RunIdSchema,
    patch: ArtifactRefSchema,
    manifestVersion: z.union([z.literal(1), z.literal(2)]),
    sourceProjectPath: z.string().min(1),
    sourceState: z.enum(["clean", "result", "drift", "unavailable"]),
    disposition: z.enum([
      "pending",
      "applying",
      "committing",
      "rolling-back",
      "applied",
      "rejected",
      "conflict",
      "indeterminate",
    ]),
    conflictPaths: z.array(z.string().min(1).max(4096)),
    files: z.array(PatchFileViewV1Schema),
    allowedActions: z.array(PatchActionV1Schema),
    message: z.string().min(1).max(512).optional(),
  })
  .strict();
export type VerifiedPatchViewV1 = z.infer<typeof VerifiedPatchViewV1Schema>;

export const PatchControlResultV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    runId: RunIdSchema,
    patchArtifactId: z.string().uuid(),
    action: PatchActionV1Schema,
    disposition: z.enum(["applied", "rejected", "conflict", "indeterminate"]),
    conflictPaths: z.array(z.string().min(1).max(4096)),
  })
  .strict();
export type PatchControlResultV1 = z.infer<typeof PatchControlResultV1Schema>;

export const StartUnityWorkV1Schema = z
  .object({
    id: StepIdSchema,
    task: z.string().trim().min(1).max(100_000),
    priority: UnityWorkPrioritySchema,
    capabilities: z.array(UnityCapabilitySchema).max(16),
  })
  .strict();

export const StartUnityWorksRequestV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    batchConfigPath: z.string().min(1),
    projectPath: z.string().min(1),
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
    const ids = new Set<string>();
    for (const [index, work] of request.works.entries()) {
      if (ids.has(work.id)) {
        context.addIssue({
          code: "custom",
          path: ["works", index, "id"],
          message: `Duplicate Work id: ${work.id}`,
        });
      }
      ids.add(work.id);
    }
  });
export type StartUnityWorksRequestV1 = z.infer<typeof StartUnityWorksRequestV1Schema>;

export const StartUnityWorksResultV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    runId: RunIdSchema,
    status: z.string().min(1).max(64),
    journalPath: z.string().min(1),
  })
  .strict();
export type StartUnityWorksResultV1 = z.infer<typeof StartUnityWorksResultV1Schema>;

export const RunControlResultV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    runId: RunIdSchema,
    action: z.enum(["resume", "cancel"]),
    disposition: z.enum(["started", "queued", "queued-awaiting-executor"]),
    executorPresent: z.boolean(),
    requiresResume: z.boolean(),
    requestId: z.string().uuid().optional(),
  })
  .strict();
export type RunControlResultV1 = z.infer<typeof RunControlResultV1Schema>;

export const EditorRegistryViewV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    editors: z.array(UnityEditorObservationV1Schema),
  })
  .strict();
export type EditorRegistryViewV1 = z.infer<typeof EditorRegistryViewV1Schema>;
