import { z } from "zod";

import {
  DoctorReportV1Schema,
  RuntimeInfoV1Schema,
  StartUnityWorkV1Schema,
  StartUnityWorksResultV1Schema,
  type DoctorReportV1,
  type RuntimeInfoV1,
  type StartUnityWorksResultV1,
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

export const DesktopIpcChannels = {
  bootstrap: "desktop.bootstrap.v1",
  chooseProfile: "desktop.profile.choose.v1",
  removeProfile: "desktop.profile.remove.v1",
  doctor: "desktop.doctor.v1",
  startWorks: "desktop.works.start.v1",
} as const;

export interface HoneyBeeDesktopApi {
  bootstrap(): Promise<DesktopBootstrapV1>;
  chooseProfile(): Promise<DesktopProjectProfileV1 | null>;
  removeProfile(request: DesktopProfileIdRequestV1): Promise<DesktopBootstrapV1>;
  doctor(request: DesktopDoctorRequestV1): Promise<DoctorReportV1>;
  startWorks(request: DesktopStartRequestV1): Promise<StartUnityWorksResultV1>;
}

export const DesktopIpcResponseSchemas = {
  bootstrap: DesktopBootstrapV1Schema,
  chooseProfile: DesktopProjectProfileV1Schema.nullable(),
  removeProfile: DesktopBootstrapV1Schema,
  doctor: DoctorReportV1Schema,
  startWorks: StartUnityWorksResultV1Schema,
} as const;

export type DesktopRuntimeInfo = RuntimeInfoV1;
