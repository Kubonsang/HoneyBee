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

export const DesktopBootstrapV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    runtime: RuntimeInfoV1Schema,
    profiles: z.array(DesktopProjectProfileV1Schema),
  })
  .strict();
export type DesktopBootstrapV1 = z.infer<typeof DesktopBootstrapV1Schema>;

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

export const DesktopIpcChannels = {
  bootstrap: "desktop.bootstrap.v1",
  chooseProfile: "desktop.profile.choose.v1",
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
  chooseProfile(): Promise<DesktopProjectProfileV1 | null>;
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
  chooseProfile: DesktopProjectProfileV1Schema.nullable(),
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
