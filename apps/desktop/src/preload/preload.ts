import { contextBridge, ipcRenderer } from "electron";

import {
  DesktopArtifactRequestV1Schema,
  DesktopAgentIdRequestV1Schema,
  DesktopAgentUpsertRequestV1Schema,
  DesktopAgentApprovalResponseV1Schema,
  DesktopComponentInstallRequestV1Schema,
  DesktopCloneRunDraftRequestV1Schema,
  DesktopDoctorRequestV1Schema,
  DesktopDeveloperSettingsUpdateV1Schema,
  DesktopDogfoodFinalizeRequestV1Schema,
  DesktopDogfoodOpenEvidenceRequestV1Schema,
  DesktopDogfoodStartRequestV1Schema,
  DesktopGitRunRequestV1Schema,
  DesktopGitSnapshotRequestV1Schema,
  DesktopIpcChannels,
  DesktopIpcResponseSchemas,
  DesktopPatchControlRequestV1Schema,
  DesktopPatchRequestV1Schema,
  DesktopPreferencesV1Schema,
  DesktopProjectFileRequestV1Schema,
  DesktopProjectSearchRequestV1Schema,
  DesktopProjectTreeRequestV1Schema,
  DesktopProfileIdRequestV1Schema,
  DesktopProjectAddRequestV2Schema,
  DesktopProjectAgentPreferenceRequestV1Schema,
  DesktopRunRequestV1Schema,
  DesktopPtyCreateRequestV1Schema,
  DesktopPtyResizeRequestV1Schema,
  DesktopPtySessionRequestV1Schema,
  DesktopPtySnapshotRequestV1Schema,
  DesktopPtyWriteRequestV1Schema,
  DesktopStartRequestV2Schema,
  DesktopTerminalSnapshotRequestV1Schema,
  DesktopWorkspaceCreateRequestV1Schema,
  DesktopWorkspaceOpenRequestV1Schema,
  DesktopWorkspacePublishRequestV1Schema,
  DesktopWorkspaceRequestV1Schema,
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
  projectCatalog: async () =>
    DesktopIpcResponseSchemas.projectCatalog.parse(
      await ipcRenderer.invoke(DesktopIpcChannels.projectCatalog),
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
  cloneRunDraft: async (request) =>
    DesktopIpcResponseSchemas.cloneRunDraft.parse(
      await ipcRenderer.invoke(
        DesktopIpcChannels.cloneRunDraft,
        DesktopCloneRunDraftRequestV1Schema.parse(request),
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
  terminalSnapshot: async (request) =>
    DesktopIpcResponseSchemas.terminalSnapshot.parse(
      await ipcRenderer.invoke(
        DesktopIpcChannels.terminalSnapshot,
        DesktopTerminalSnapshotRequestV1Schema.parse(request),
      ),
    ),
  openTerminalWindow: async (request) =>
    DesktopIpcResponseSchemas.terminalWindowOpen.parse(
      await ipcRenderer.invoke(
        DesktopIpcChannels.terminalWindowOpen,
        DesktopRunRequestV1Schema.parse(request),
      ),
    ),
  projectTree: async (request) =>
    DesktopIpcResponseSchemas.projectTree.parse(
      await ipcRenderer.invoke(
        DesktopIpcChannels.projectTree,
        DesktopProjectTreeRequestV1Schema.parse(request),
      ),
    ),
  readProjectFile: async (request) =>
    DesktopIpcResponseSchemas.projectFileRead.parse(
      await ipcRenderer.invoke(
        DesktopIpcChannels.projectFileRead,
        DesktopProjectFileRequestV1Schema.parse(request),
      ),
    ),
  searchProject: async (request) =>
    DesktopIpcResponseSchemas.projectSearch.parse(
      await ipcRenderer.invoke(
        DesktopIpcChannels.projectSearch,
        DesktopProjectSearchRequestV1Schema.parse(request),
      ),
    ),
  createPty: async (request) =>
    DesktopIpcResponseSchemas.ptyCreate.parse(
      await ipcRenderer.invoke(
        DesktopIpcChannels.ptyCreate,
        DesktopPtyCreateRequestV1Schema.parse(request),
      ),
    ),
  ptySnapshot: async (request) =>
    DesktopIpcResponseSchemas.ptySnapshot.parse(
      await ipcRenderer.invoke(
        DesktopIpcChannels.ptySnapshot,
        DesktopPtySnapshotRequestV1Schema.parse(request),
      ),
    ),
  writePty: async (request) =>
    DesktopIpcResponseSchemas.ptyWrite.parse(
      await ipcRenderer.invoke(
        DesktopIpcChannels.ptyWrite,
        DesktopPtyWriteRequestV1Schema.parse(request),
      ),
    ),
  resizePty: async (request) =>
    DesktopIpcResponseSchemas.ptyResize.parse(
      await ipcRenderer.invoke(
        DesktopIpcChannels.ptyResize,
        DesktopPtyResizeRequestV1Schema.parse(request),
      ),
    ),
  closePty: async (request) =>
    DesktopIpcResponseSchemas.ptyClose.parse(
      await ipcRenderer.invoke(
        DesktopIpcChannels.ptyClose,
        DesktopPtySessionRequestV1Schema.parse(request),
      ),
    ),
  gitSnapshot: async (request) =>
    DesktopIpcResponseSchemas.gitSnapshot.parse(
      await ipcRenderer.invoke(
        DesktopIpcChannels.gitSnapshot,
        DesktopGitSnapshotRequestV1Schema.parse(request),
      ),
    ),
  materializeRunWorktree: async (request) =>
    DesktopIpcResponseSchemas.gitMaterializeRun.parse(
      await ipcRenderer.invoke(
        DesktopIpcChannels.gitMaterializeRun,
        DesktopGitRunRequestV1Schema.parse(request),
      ),
    ),
  mergeRunWorktree: async (request) =>
    DesktopIpcResponseSchemas.gitMergeRun.parse(
      await ipcRenderer.invoke(
        DesktopIpcChannels.gitMergeRun,
        DesktopGitRunRequestV1Schema.parse(request),
      ),
    ),
  finalizeIntegration: async (request) =>
    DesktopIpcResponseSchemas.gitFinalizeIntegration.parse(
      await ipcRenderer.invoke(
        DesktopIpcChannels.gitFinalizeIntegration,
        DesktopGitRunRequestV1Schema.parse(request),
      ),
    ),
  workspaceSnapshot: async (request) =>
    DesktopIpcResponseSchemas.workspaceSnapshot.parse(
      await ipcRenderer.invoke(
        DesktopIpcChannels.workspaceSnapshot,
        DesktopProfileIdRequestV1Schema.parse(request),
      ),
    ),
  createWorkspace: async (request) =>
    DesktopIpcResponseSchemas.workspaceCreate.parse(
      await ipcRenderer.invoke(
        DesktopIpcChannels.workspaceCreate,
        DesktopWorkspaceCreateRequestV1Schema.parse(request),
      ),
    ),
  openWorkspace: async (request) =>
    DesktopIpcResponseSchemas.workspaceOpen.parse(
      await ipcRenderer.invoke(
        DesktopIpcChannels.workspaceOpen,
        DesktopWorkspaceOpenRequestV1Schema.parse(request),
      ),
    ),
  publishWorkspace: async (request) =>
    DesktopIpcResponseSchemas.workspacePublish.parse(
      await ipcRenderer.invoke(
        DesktopIpcChannels.workspacePublish,
        DesktopWorkspacePublishRequestV1Schema.parse(request),
      ),
    ),
  deleteWorkspace: async (request) =>
    DesktopIpcResponseSchemas.workspaceDelete.parse(
      await ipcRenderer.invoke(
        DesktopIpcChannels.workspaceDelete,
        DesktopWorkspaceRequestV1Schema.parse(request),
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
  developerSettings: async () =>
    DesktopIpcResponseSchemas.developerSettingsGet.parse(
      await ipcRenderer.invoke(DesktopIpcChannels.developerSettingsGet),
    ),
  updateDeveloperSettings: async (request) =>
    DesktopIpcResponseSchemas.developerSettingsUpdate.parse(
      await ipcRenderer.invoke(
        DesktopIpcChannels.developerSettingsUpdate,
        DesktopDeveloperSettingsUpdateV1Schema.parse(request),
      ),
    ),
  preferences: async () =>
    DesktopIpcResponseSchemas.preferencesGet.parse(
      await ipcRenderer.invoke(DesktopIpcChannels.preferencesGet),
    ),
  updatePreferences: async (request) =>
    DesktopIpcResponseSchemas.preferencesUpdate.parse(
      await ipcRenderer.invoke(
        DesktopIpcChannels.preferencesUpdate,
        DesktopPreferencesV1Schema.parse(request),
      ),
    ),
  dogfoodStatus: async () =>
    DesktopIpcResponseSchemas.dogfoodStatus.parse(
      await ipcRenderer.invoke(DesktopIpcChannels.dogfoodStatus),
    ),
  startDogfood: async (request) =>
    DesktopIpcResponseSchemas.dogfoodStart.parse(
      await ipcRenderer.invoke(
        DesktopIpcChannels.dogfoodStart,
        DesktopDogfoodStartRequestV1Schema.parse(request),
      ),
    ),
  finalizeDogfood: async (request) =>
    DesktopIpcResponseSchemas.dogfoodFinalize.parse(
      await ipcRenderer.invoke(
        DesktopIpcChannels.dogfoodFinalize,
        DesktopDogfoodFinalizeRequestV1Schema.parse(request),
      ),
    ),
  openDogfoodEvidence: async (request) =>
    DesktopIpcResponseSchemas.dogfoodOpenEvidence.parse(
      await ipcRenderer.invoke(
        DesktopIpcChannels.dogfoodOpenEvidence,
        DesktopDogfoodOpenEvidenceRequestV1Schema.parse(request),
      ),
    ),
};

contextBridge.exposeInMainWorld("honeybee", Object.freeze(api));
