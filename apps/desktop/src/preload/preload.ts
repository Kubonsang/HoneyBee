import { contextBridge, ipcRenderer } from "electron";

import {
  DesktopArtifactRequestV1Schema,
  DesktopDoctorRequestV1Schema,
  DesktopIpcChannels,
  DesktopIpcResponseSchemas,
  DesktopProfileIdRequestV1Schema,
  DesktopRunRequestV1Schema,
  DesktopStartRequestV1Schema,
  type HoneyBeeDesktopApi,
} from "../shared/ipc.js";

const api: HoneyBeeDesktopApi = {
  bootstrap: async () =>
    DesktopIpcResponseSchemas.bootstrap.parse(
      await ipcRenderer.invoke(DesktopIpcChannels.bootstrap),
    ),
  chooseProfile: async () =>
    DesktopIpcResponseSchemas.chooseProfile.parse(
      await ipcRenderer.invoke(DesktopIpcChannels.chooseProfile),
    ),
  removeProfile: async (request) =>
    DesktopIpcResponseSchemas.removeProfile.parse(
      await ipcRenderer.invoke(
        DesktopIpcChannels.removeProfile,
        DesktopProfileIdRequestV1Schema.parse(request),
      ),
    ),
  doctor: async (request) =>
    DesktopIpcResponseSchemas.doctor.parse(
      await ipcRenderer.invoke(
        DesktopIpcChannels.doctor,
        DesktopDoctorRequestV1Schema.parse(request),
      ),
    ),
  startWorks: async (request) =>
    DesktopIpcResponseSchemas.startWorks.parse(
      await ipcRenderer.invoke(
        DesktopIpcChannels.startWorks,
        DesktopStartRequestV1Schema.parse(request),
      ),
    ),
  runtimeSnapshot: async (request) =>
    DesktopIpcResponseSchemas.runtimeSnapshot.parse(
      await ipcRenderer.invoke(
        DesktopIpcChannels.runtimeSnapshot,
        DesktopProfileIdRequestV1Schema.parse(request),
      ),
    ),
  runDetail: async (request) =>
    DesktopIpcResponseSchemas.runDetail.parse(
      await ipcRenderer.invoke(
        DesktopIpcChannels.runDetail,
        DesktopRunRequestV1Schema.parse(request),
      ),
    ),
  readArtifact: async (request) =>
    DesktopIpcResponseSchemas.artifactRead.parse(
      await ipcRenderer.invoke(
        DesktopIpcChannels.artifactRead,
        DesktopArtifactRequestV1Schema.parse(request),
      ),
    ),
  resumeRun: async (request) =>
    DesktopIpcResponseSchemas.runResume.parse(
      await ipcRenderer.invoke(
        DesktopIpcChannels.runResume,
        DesktopRunRequestV1Schema.parse(request),
      ),
    ),
  cancelRun: async (request) =>
    DesktopIpcResponseSchemas.runCancel.parse(
      await ipcRenderer.invoke(
        DesktopIpcChannels.runCancel,
        DesktopRunRequestV1Schema.parse(request),
      ),
    ),
};

contextBridge.exposeInMainWorld("honeybee", Object.freeze(api));
