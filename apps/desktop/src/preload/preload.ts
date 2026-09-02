import { contextBridge, ipcRenderer } from "electron";

import {
  DesktopGitDiffV1Schema,
  DesktopIpcChannels,
  DesktopProjectV1Schema,
  DesktopPtySessionV1Schema,
  DesktopPtySnapshotV1Schema,
  DesktopWorkspaceV1Schema,
  type HoneyBeeDesktopApi,
} from "../shared/ipc.js";

const api: HoneyBeeDesktopApi = {
  projects: async () =>
    DesktopProjectV1Schema.array().parse(await ipcRenderer.invoke(DesktopIpcChannels.projects)),
  workspaces: async (request) =>
    DesktopWorkspaceV1Schema.array().parse(
      await ipcRenderer.invoke(DesktopIpcChannels.workspaces, request),
    ),
  createWorkspace: async (request) =>
    DesktopWorkspaceV1Schema.parse(
      await ipcRenderer.invoke(DesktopIpcChannels.workspaceCreate, request),
    ),
  repairWorkspace: async (request) =>
    DesktopWorkspaceV1Schema.parse(
      await ipcRenderer.invoke(DesktopIpcChannels.workspaceRepair, request),
    ),
  removeWorkspace: async (request) =>
    Boolean(await ipcRenderer.invoke(DesktopIpcChannels.workspaceRemove, request)),
  gitDiff: async (request) =>
    DesktopGitDiffV1Schema.parse(await ipcRenderer.invoke(DesktopIpcChannels.gitDiff, request)),
  createPty: async (request) =>
    DesktopPtySessionV1Schema.parse(
      await ipcRenderer.invoke(DesktopIpcChannels.ptyCreate, request),
    ),
  ptySnapshot: async (request) =>
    DesktopPtySnapshotV1Schema.parse(
      await ipcRenderer.invoke(DesktopIpcChannels.ptySnapshot, request),
    ),
  writePty: async (request) =>
    Boolean(await ipcRenderer.invoke(DesktopIpcChannels.ptyWrite, request)),
  resizePty: async (request) =>
    Boolean(await ipcRenderer.invoke(DesktopIpcChannels.ptyResize, request)),
  closePty: async (request) =>
    Boolean(await ipcRenderer.invoke(DesktopIpcChannels.ptyClose, request)),
};

contextBridge.exposeInMainWorld("honeybee", Object.freeze(api));
