import { contextBridge, ipcRenderer } from "electron";
import { z } from "zod";

import {
  DesktopCloneResultV1Schema,
  DesktopDoctorReportV1Schema,
  DesktopGitDiffV1Schema,
  DesktopIpcChannels,
  DesktopProjectCandidateV1Schema,
  DesktopProjectInspectionV1Schema,
  DesktopProjectV2Schema,
  DesktopPtySessionV1Schema,
  DesktopPtySnapshotV1Schema,
  DesktopResultSchema,
  DesktopWorkspaceV2Schema,
  type HoneyBeeDesktopApi,
} from "../shared/ipc.js";

const invoke = async <T>(channel: string, schema: z.ZodType<T>, request?: unknown): Promise<T> => {
  const result = DesktopResultSchema(schema).parse(await ipcRenderer.invoke(channel, request));
  if (!result.ok) throw new Error(JSON.stringify({ honeybeeError: result.error }));
  return result.value;
};

const api: HoneyBeeDesktopApi = {
  projects: () => invoke(DesktopIpcChannels.projects, DesktopProjectV2Schema.array()),
  projectCandidates: () =>
    invoke(DesktopIpcChannels.projectCandidates, DesktopProjectCandidateV1Schema.array()),
  inspectProject: (request) =>
    invoke(DesktopIpcChannels.projectInspect, DesktopProjectInspectionV1Schema, request),
  pickFolder: (request) =>
    invoke(DesktopIpcChannels.projectPickFolder, z.string().nullable(), request),
  setupProject: (request) =>
    invoke(DesktopIpcChannels.projectSetup, DesktopProjectV2Schema, request),
  cloneProject: (request) =>
    invoke(DesktopIpcChannels.projectClone, DesktopCloneResultV1Schema, request),
  prepareCache: (request) =>
    invoke(DesktopIpcChannels.cachePrepare, DesktopProjectV2Schema, request),
  doctor: () => invoke(DesktopIpcChannels.doctor, DesktopDoctorReportV1Schema),
  workspaces: (request) =>
    invoke(DesktopIpcChannels.workspaces, DesktopWorkspaceV2Schema.array(), request),
  createWorkspace: (request) =>
    invoke(DesktopIpcChannels.workspaceCreate, DesktopWorkspaceV2Schema, request),
  repairWorkspace: (request) =>
    invoke(DesktopIpcChannels.workspaceRepair, DesktopWorkspaceV2Schema, request),
  removeWorkspace: (request) => invoke(DesktopIpcChannels.workspaceRemove, z.boolean(), request),
  launchExternal: (request) => invoke(DesktopIpcChannels.externalLaunch, z.boolean(), request),
  launchProjectUnity: (request) =>
    invoke(DesktopIpcChannels.projectUnityLaunch, z.boolean(), request),
  windowAction: (request) => invoke(DesktopIpcChannels.windowAction, z.boolean(), request),
  gitDiff: (request) => invoke(DesktopIpcChannels.gitDiff, DesktopGitDiffV1Schema, request),
  createPty: (request) => invoke(DesktopIpcChannels.ptyCreate, DesktopPtySessionV1Schema, request),
  listPtys: () => invoke(DesktopIpcChannels.ptyList, DesktopPtySessionV1Schema.array()),
  ptySnapshot: (request) =>
    invoke(DesktopIpcChannels.ptySnapshot, DesktopPtySnapshotV1Schema, request),
  writePty: (request) => invoke(DesktopIpcChannels.ptyWrite, z.boolean(), request),
  resizePty: (request) => invoke(DesktopIpcChannels.ptyResize, z.boolean(), request),
  closePty: (request) => invoke(DesktopIpcChannels.ptyClose, z.boolean(), request),
};

contextBridge.exposeInMainWorld("honeybee", Object.freeze(api));
