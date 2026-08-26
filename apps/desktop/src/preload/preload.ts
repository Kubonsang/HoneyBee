import { contextBridge, ipcRenderer } from "electron";

import {
  DesktopArtifactRequestV1Schema,
  DesktopAgentIdRequestV1Schema,
  DesktopAgentUpsertRequestV1Schema,
  DesktopAgentApprovalResponseV1Schema,
  DesktopComponentInstallRequestV1Schema,
  DesktopDoctorRequestV1Schema,
  DesktopIpcChannels,
  DesktopIpcResponseSchemas,
  DesktopPatchControlRequestV1Schema,
  DesktopPatchRequestV1Schema,
  DesktopProfileIdRequestV1Schema,
  DesktopProjectAddRequestV2Schema,
  DesktopProjectAgentPreferenceRequestV1Schema,
  DesktopRunRequestV1Schema,
  DesktopStartRequestV2Schema,
  DesktopSetupDiscoveryRequestV1Schema,
  DesktopSetupIdRequestV1Schema,
  DesktopSetupPathRequestV1Schema,
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
  chooseSetupPath: async (request) =>
    DesktopIpcResponseSchemas.chooseSetupPath.parse(
      await ipcRenderer.invoke(
        DesktopIpcChannels.chooseSetupPath,
        DesktopSetupPathRequestV1Schema.parse(request),
      ),
    ),
  discoverProject: async (request) =>
    DesktopIpcResponseSchemas.projectDiscover.parse(
      await ipcRenderer.invoke(
        DesktopIpcChannels.projectDiscover,
        DesktopSetupDiscoveryRequestV1Schema.parse(request),
      ),
    ),
  addProject: async (request) =>
    DesktopIpcResponseSchemas.projectAdd.parse(
      await ipcRenderer.invoke(
        DesktopIpcChannels.projectAdd,
        DesktopProjectAddRequestV2Schema.parse(request),
      ),
    ),
  setupStatus: async (request) =>
    DesktopIpcResponseSchemas.setupStatus.parse(
      await ipcRenderer.invoke(
        DesktopIpcChannels.setupStatus,
        DesktopSetupIdRequestV1Schema.parse(request),
      ),
    ),
  resumeSetup: async (request) =>
    DesktopIpcResponseSchemas.setupResume.parse(
      await ipcRenderer.invoke(
        DesktopIpcChannels.setupResume,
        DesktopSetupIdRequestV1Schema.parse(request),
      ),
    ),
  cancelSetup: async (request) =>
    DesktopIpcResponseSchemas.setupCancel.parse(
      await ipcRenderer.invoke(
        DesktopIpcChannels.setupCancel,
        DesktopSetupIdRequestV1Schema.parse(request),
      ),
    ),
  components: async () =>
    DesktopIpcResponseSchemas.componentsSnapshot.parse(
      await ipcRenderer.invoke(DesktopIpcChannels.componentsSnapshot),
    ),
  installComponent: async (request) =>
    DesktopIpcResponseSchemas.componentInstall.parse(
      await ipcRenderer.invoke(
        DesktopIpcChannels.componentInstall,
        DesktopComponentInstallRequestV1Schema.parse(request),
      ),
    ),
  importSetup: async () =>
    DesktopIpcResponseSchemas.setupImport.parse(
      await ipcRenderer.invoke(DesktopIpcChannels.setupImport),
    ),
  exportSetup: async (request) =>
    DesktopIpcResponseSchemas.setupExport.parse(
      await ipcRenderer.invoke(
        DesktopIpcChannels.setupExport,
        DesktopProfileIdRequestV1Schema.parse(request),
      ),
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
        DesktopStartRequestV2Schema.parse(request),
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
  getPatch: async (request) =>
    DesktopIpcResponseSchemas.patchView.parse(
      await ipcRenderer.invoke(
        DesktopIpcChannels.patchView,
        DesktopPatchRequestV1Schema.parse(request),
      ),
    ),
  controlPatch: async (request) =>
    DesktopIpcResponseSchemas.patchControl.parse(
      await ipcRenderer.invoke(
        DesktopIpcChannels.patchControl,
        DesktopPatchControlRequestV1Schema.parse(request),
      ),
    ),
  upsertAgent: async (request) =>
    DesktopIpcResponseSchemas.agentsUpsert.parse(
      await ipcRenderer.invoke(
        DesktopIpcChannels.agentsUpsert,
        DesktopAgentUpsertRequestV1Schema.parse(request),
      ),
    ),
  removeAgent: async (request) =>
    DesktopIpcResponseSchemas.agentsRemove.parse(
      await ipcRenderer.invoke(
        DesktopIpcChannels.agentsRemove,
        DesktopAgentIdRequestV1Schema.parse(request),
      ),
    ),
  probeAgent: async (request) =>
    DesktopIpcResponseSchemas.agentsProbe.parse(
      await ipcRenderer.invoke(
        DesktopIpcChannels.agentsProbe,
        DesktopAgentIdRequestV1Schema.parse(request),
      ),
    ),
  connectAgent: async (request) =>
    DesktopIpcResponseSchemas.agentsConnect.parse(
      await ipcRenderer.invoke(
        DesktopIpcChannels.agentsConnect,
        DesktopAgentIdRequestV1Schema.parse(request),
      ),
    ),
  listAgentApprovals: async () =>
    DesktopIpcResponseSchemas.agentApprovalsList.parse(
      await ipcRenderer.invoke(DesktopIpcChannels.agentApprovalsList),
    ),
  respondAgentApproval: async (request) =>
    DesktopIpcResponseSchemas.agentApprovalRespond.parse(
      await ipcRenderer.invoke(
        DesktopIpcChannels.agentApprovalRespond,
        DesktopAgentApprovalResponseV1Schema.parse(request),
      ),
    ),
  setProjectAgentPreference: async (request) =>
    DesktopIpcResponseSchemas.projectAgentPreference.parse(
      await ipcRenderer.invoke(
        DesktopIpcChannels.projectAgentPreference,
        DesktopProjectAgentPreferenceRequestV1Schema.parse(request),
      ),
    ),
};

contextBridge.exposeInMainWorld("honeybee", Object.freeze(api));
