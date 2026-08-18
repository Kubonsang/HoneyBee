import { contextBridge, ipcRenderer } from "electron";

import {
  DesktopDoctorRequestV1Schema,
  DesktopIpcChannels,
  DesktopIpcResponseSchemas,
  DesktopProfileIdRequestV1Schema,
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
};

contextBridge.exposeInMainWorld("honeybee", Object.freeze(api));
