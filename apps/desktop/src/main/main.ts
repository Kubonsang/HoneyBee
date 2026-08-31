import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { StepIdSchema } from "@honeybee/orchestration-contracts";
import {
  AgentSessionProcessRunner,
  DesktopWorkScheduler,
  HoneyBeeRuntimeFacade,
} from "honeybee-cli/runtime";

import {
  DesktopArtifactRequestV1Schema,
  DesktopAgentIdRequestV1Schema,
  DesktopAgentUpsertRequestV1Schema,
  DesktopAgentApprovalListV1Schema,
  DesktopAgentApprovalResponseV1Schema,
  DesktopBootstrapV2Schema,
  DesktopCloneRunDraftRequestV1Schema,
  DesktopComponentInstallRequestV1Schema,
  DesktopDoctorRequestV1Schema,
  DesktopDeveloperSettingsUpdateV1Schema,
  DesktopDogfoodFinalizeRequestV1Schema,
  DesktopDogfoodOpenEvidenceRequestV1Schema,
  DesktopDogfoodStartRequestV1Schema,
  DesktopIpcChannels,
  DesktopPatchControlRequestV1Schema,
  DesktopPatchRequestV1Schema,
  DesktopProfileIdRequestV1Schema,
  DesktopProjectAddRequestV2Schema,
  DesktopProjectAgentPreferenceRequestV1Schema,
  DesktopProjectDiscoveryV1Schema,
  DesktopProjectProfileV1Schema,
  DesktopProjectProfileSchema,
  DesktopRunRequestV1Schema,
  DesktopRuntimeSnapshotV1Schema,
  DesktopStartRequestV2Schema,
  DesktopTerminalSnapshotRequestV1Schema,
  DesktopSetupDiscoveryRequestV1Schema,
  DesktopSetupIdRequestV1Schema,
  DesktopSetupPathRequestV1Schema,
  type ProjectComponentLockV1,
} from "../shared/ipc.js";
import { DesktopComponentManager, readCompatibilityManifest } from "./component-manager.js";
import { DesktopAgentManager } from "./agent-manager.js";
import { DesktopAgentApprovalBroker } from "./agent-approval-broker.js";
import { DesktopDogfoodController } from "./desktop-dogfood.js";
import { DesktopSettingsStore } from "./settings.js";
import { DesktopTerminalBroker } from "./terminal-broker.js";
import { cloneRunDraftFromConfig } from "./run-draft.js";
import {
  DesktopSetupCoordinator,
  ResolvedDesktopSetupDraftV1Schema,
  discoverDesktopSetup,
  installBundledWorkspaceStorage,
  materializeImportedManagedProfile,
  upgradeManagedProfileV2,
  validateManagedEnvironment,
  runCommand,
} from "./setup.js";

let mainWindow: BrowserWindow | undefined;
const terminalWindows = new Map<string, BrowserWindow>();
const smokeResultPath = process.env.HONEYBEE_DESKTOP_SMOKE_RESULT;
const smokeMode = process.env.HONEYBEE_DESKTOP_SMOKE === "desktop-smoke-v1";
if (smokeMode) app.disableHardwareAcceleration();
const writeSmokeStage = async (stage: string): Promise<void> => {
  if (smokeResultPath === undefined) return;
  const target = path.resolve(smokeResultPath);
  const relative = path.relative(path.resolve(tmpdir()), target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return;
  await writeFile(target, JSON.stringify({ stage }) + "\n", "utf8");
};
const userData = app.getPath("userData");
const bundledToolsRoot = app.isPackaged
  ? path.join(process.resourcesPath, "win32-x64")
  : path.join(app.getAppPath(), ".tools", "win32-x64");
const bundledWorkspaceStoragePath = path.join(bundledToolsRoot, "unity-workspace-storage.exe");
const compatibilityManifestPath = app.isPackaged
  ? path.join(process.resourcesPath, "component-compatibility-v1.json")
  : path.join(app.getAppPath(), "resources", "component-compatibility-v1.json");
const activeWorkspaceStorageHostPath = path.join(
  process.env.ProgramData ?? "C:\\ProgramData",
  "UnityWorkspaceStorage",
  "broker",
  "unity-workspace-storage-host.exe",
);
const settings = new DesktopSettingsStore(userData);
const setup = new DesktopSetupCoordinator(
  path.join(userData, "setups"),
  async (profile, preferredAgentId) => {
    await settings.upsertProfile(profile);
    if (preferredAgentId !== undefined)
      await settings.setPreferredAgent(profile.profileId, preferredAgentId);
  },
);
const agentManager = new DesktopAgentManager(settings);
const agentApprovalBroker = new DesktopAgentApprovalBroker();
const desktopWorkScheduler = new DesktopWorkScheduler(4);
const terminalBroker = new DesktopTerminalBroker();
const runtime = new HoneyBeeRuntimeFacade({
  stateRoot: path.join(userData, "runtime", "runs"),
  agentRunner: new AgentSessionProcessRunner(undefined, {
    scheduler: desktopWorkScheduler,
    approval: agentApprovalBroker,
    trace: terminalBroker,
  }),
});
const dogfood = new DesktopDogfoodController(userData, runtime.info().stateRoot);
const components = new DesktopComponentManager(
  path.join(userData, "components"),
  bundledToolsRoot,
  await readCompatibilityManifest(compatibilityManifestPath),
  undefined,
  undefined,
  activeWorkspaceStorageHostPath,
);
await components.ensureBundledWorkspaceStorage();

const profileKey = (value: string): string => {
  const normalized = path.resolve(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
};

const showOpenDialog = (options: Electron.OpenDialogOptions) =>
  mainWindow === undefined
    ? dialog.showOpenDialog(options)
    : dialog.showOpenDialog(mainWindow, options);

const showSaveDialog = (options: Electron.SaveDialogOptions) =>
  mainWindow === undefined
    ? dialog.showSaveDialog(options)
    : dialog.showSaveDialog(mainWindow, options);

const profileFor = async (profileId: string) => {
  const profile = (await settings.listProfiles()).find(
    (candidate) => candidate.profileId === profileId,
  );
  if (profile === undefined)
    throw Object.assign(new Error("Project profile was not found."), {
      code: "desktop.profile-not-found",
    });
  return profile;
};

const validateProfile = async (profile: Awaited<ReturnType<typeof profileFor>>) => {
  try {
    if (profile.schemaVersion === 2 || profile.schemaVersion === 3) {
      await validateManagedEnvironment(profile);
    }
    if (profile.schemaVersion === 3) {
      await components.assertLock(profile.environment.storage.component);
      await components.assertWorkspaceStorageActive(profile.environment.storage.component);
      if (profile.environment.testplay !== undefined) {
        await components.assertLock(profile.environment.testplay);
      }
    }
  } catch (error) {
    throw Object.assign(
      new Error(
        "The managed project environment is no longer compatible with this HoneyBee build.",
        {
          cause: error,
        },
      ),
      { code: "managed.profile-invalid" },
    );
  }
  return profile;
};

const componentFile = (
  lock: ProjectComponentLockV1,
  role: ProjectComponentLockV1["files"][number]["role"],
): ProjectComponentLockV1["files"][number] => {
  const matches = lock.files.filter((file) => file.role === role);
  if (matches.length !== 1) throw new Error("Component lock role is missing or ambiguous.");
  return matches[0] as ProjectComponentLockV1["files"][number];
};

const assertStorageSwitchSafe = async (): Promise<void> => {
  const runs = await runtime.listRuns();
  if (
    runs.some(
      (run) => !run.terminal || run.status === "cleanup-pending" || run.status === "indeterminate",
    )
  ) {
    throw new Error("workspace-storage cannot switch while a Run is active or requires recovery.");
  }
};

const hiddenWorkspaceRoot = (): string => {
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData === undefined || !path.isAbsolute(localAppData)) {
    throw Object.assign(new Error("LOCALAPPDATA is unavailable."), {
      code: "workspace-storage.local-app-data-unavailable",
    });
  }
  return path.join(localAppData, "HoneyBee", "Workspaces");
};

let storageProvisioning:
  | Promise<{
      readonly lock: ProjectComponentLockV1;
      readonly workspaceRoot: string;
    }>
  | undefined;

const verifyStorageBroker = async (clientPath: string): Promise<void> => {
  const result = await runCommand(
    clientPath,
    ["workspace", "status", "--schema", "2", "--request-id", `desktop-${randomUUID()}`],
    { cwd: path.dirname(clientPath), timeoutMs: 30_000 },
  );
  let response: unknown;
  try {
    response = JSON.parse(result.stdout);
  } catch {
    response = undefined;
  }
  if (
    result.exitCode !== 0 ||
    result.signal !== null ||
    typeof response !== "object" ||
    response === null ||
    !("ok" in response) ||
    response.ok !== true ||
    !("schemaVersion" in response) ||
    response.schemaVersion !== 2
  ) {
    throw Object.assign(new Error("Unity Workspace Storage broker did not answer schema 2."), {
      code: "workspace-storage.broker-unavailable",
    });
  }
};

const provisionWorkspaceStorage = async (): Promise<{
  readonly lock: ProjectComponentLockV1;
  readonly workspaceRoot: string;
}> => {
  if (storageProvisioning !== undefined) return storageProvisioning;
  storageProvisioning = (async () => {
    const snapshot = await components.snapshot();
    const supportedActive =
      snapshot.activeWorkspaceStorage === undefined
        ? undefined
        : components
            .releases("workspace-storage")
            .find((release) => release.version === snapshot.activeWorkspaceStorage?.version);
    const release = supportedActive ?? components.releases("workspace-storage")[0];
    if (release === undefined) {
      throw Object.assign(new Error("No workspace-storage release is approved."), {
        code: "workspace-storage.release-unavailable",
      });
    }
    if (
      snapshot.activeWorkspaceStorage !== undefined &&
      snapshot.activeWorkspaceStorage.version !== release.version
    ) {
      await assertStorageSwitchSafe();
    }
    await components.installWorkspaceStorage(release.version);
    const lock = await components.lock("workspace-storage", release.version);
    const workspaceRoot = hiddenWorkspaceRoot();
    await installBundledWorkspaceStorage(
      componentFile(lock, "host").path,
      workspaceRoot,
      release.version,
      snapshot.activeWorkspaceStorage !== undefined,
    );
    await components.activateWorkspaceStorage(release.version, workspaceRoot);
    await verifyStorageBroker(componentFile(lock, "client").path);
    await components.assertWorkspaceStorageActive(lock);
    return { lock, workspaceRoot };
  })()
    .catch((error: unknown) => {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        throw Object.assign(new Error("The bundled workspace-storage payload is missing."), {
          code: "workspace-storage.payload-missing",
        });
      }
      throw error;
    })
    .finally(() => {
      storageProvisioning = undefined;
    });
  return storageProvisioning;
};

const agentFor = async (agentId: string) => {
  const agent = await settings.agent(agentId);
  if (agent === undefined || !agent.enabled)
    throw new Error("Agent profile was not found or is disabled.");
  return agent;
};

const requireReadyAgent = async (agentId: string) => {
  const agent = await agentFor(agentId);
  const status = await agentManager.probe(agent);
  if (status.status !== "ready") throw new Error(status.summary);
  if (agent.trust === undefined) throw new Error("Agent trust approval is required.");
  return agent;
};

const bootstrap = async () => {
  await agentManager.ensureDetected();
  const snapshot = await settings.snapshot();
  const agentStatuses = await Promise.all(
    snapshot.agents.map((agent) => agentManager.probe(agent)),
  );
  return DesktopBootstrapV2Schema.parse({
    schemaVersion: 2,
    runtime: runtime.info(),
    profiles: [...snapshot.profiles].sort((left, right) =>
      right.lastOpenedAt.localeCompare(left.lastOpenedAt),
    ),
    agents: snapshot.agents,
    agentStatuses,
    preferredAgentIds: snapshot.preferredAgentIds,
    ...(snapshot.lastUsedAgentId === undefined
      ? {}
      : { lastUsedAgentId: snapshot.lastUsedAgentId }),
  });
};

const safeHandler =
  <Arguments extends readonly unknown[], Result>(
    operation: (...args: Arguments) => Promise<Result>,
  ) =>
  async (_event: Electron.IpcMainInvokeEvent, ...args: Arguments): Promise<Result> => {
    try {
      return await operation(...args);
    } catch (error) {
      const code =
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        typeof error.code === "string"
          ? error.code
          : "desktop.operation-failed";
      const publicMessages: Readonly<Record<string, string>> = {
        "desktop.profile-not-found":
          "The selected project profile was replaced or removed. Refresh the project list.",
        "desktop.clone-profile-not-found":
          "The original project profile is no longer available. Add the project again before cloning this Run.",
        "desktop.clone-unavailable":
          "This Run does not contain a supported task and configuration that can be cloned safely.",
        "dogfood.disabled": "Enable Dogfood Metrics in Settings before recording.",
        "dogfood.doctor-failed": "Doctor and the selected Agent must be ready before recording.",
        "dogfood.evidence-path-unsafe": "The recorded Evidence path is outside HoneyBee user data.",
        "dogfood.recording-active": "Stop and finalize the active dogfood recording first.",
        "dogfood.session-not-found": "The dogfood recording could not be found.",
        "dogfood.state-invalid": "The local dogfood session descriptor is invalid or unreadable.",
        "managed.profile-invalid":
          "This project's managed environment is outdated or changed. Add the same project again to run Setup.",
        "workspace-storage.service-conflict":
          "Another Unity Workspace Storage service exists without HoneyBee's machine receipt.",
        "workspace-storage.install-failed":
          "Windows permission was denied, cancelled, or the storage service could not be installed.",
        "workspace-storage.payload-missing":
          "This HoneyBee installation is missing its bundled workspace-storage payload.",
        "workspace-storage.receipt-invalid":
          "The storage service did not publish a valid machine receipt.",
        "workspace-storage.receipt-mismatch":
          "The installed storage service does not match this HoneyBee build.",
        "workspace-storage.broker-unavailable":
          "The storage service was installed but did not become ready.",
      };
      const message = publicMessages[code] ?? "The operation could not be completed.";
      throw new Error(`HoneyBee operation failed (${code}): ${message}`, { cause: error });
    }
  };

type TerminalRunList = Awaited<ReturnType<HoneyBeeRuntimeFacade["listRuns"]>>;
let terminalRunListCache: { expiresAt: number; runs: TerminalRunList } | undefined;
let terminalRunListPending: Promise<TerminalRunList> | undefined;

const listTerminalRuns = async (): Promise<TerminalRunList> => {
  const cached = terminalRunListCache;
  if (cached !== undefined && cached.expiresAt > Date.now()) return cached.runs;
  terminalRunListPending ??= runtime.listRuns().then((runs) => {
    terminalRunListCache = { expiresAt: Date.now() + 500, runs };
    return runs;
  });
  try {
    return await terminalRunListPending;
  } finally {
    terminalRunListPending = undefined;
  }
};

const terminalRunContext = async (runId: string) => {
  const runs = await listTerminalRuns();
  let selected = runs.find((run) => run.runId === runId);
  if (selected === undefined) {
    selected = (await runtime.getRunDetail(runId)).summary;
  }
  const targets = [selected, ...runs.filter((run) => run.parentRunId === selected.runId)];
  for (const target of targets) {
    if (
      !target.terminal ||
      terminalBroker.hasEntries(target.runId) ||
      terminalBroker.hasReplayed(target.runId)
    ) {
      continue;
    }
    const detail = await runtime.getRunDetail(target.runId);
    const transcript = detail.artifacts.find(
      (artifact) => artifact.kind === "agent-session-transcript",
    );
    if (transcript === undefined) {
      terminalBroker.markReplayAttempted(target.runId);
      continue;
    }
    const view = await runtime.readReferencedArtifact(target.runId, transcript.artifactId);
    if (view.encoding !== "utf8") {
      terminalBroker.markReplayAttempted(target.runId);
      continue;
    }
    terminalBroker.replayTranscript(
      target.runId,
      target.workId ?? StepIdSchema.parse("agent"),
      view.content,
      target.updatedAt ?? new Date().toISOString(),
    );
  }
  const hasEntries = targets.some((target) => terminalBroker.hasEntries(target.runId));
  return {
    runIds: targets.map((target) => target.runId),
    state: targets.some((target) => !target.terminal)
      ? ("running" as const)
      : hasEntries
        ? ("completed" as const)
        : ("unavailable" as const),
  };
};

const registerIpc = (): void => {
  ipcMain.handle(
    DesktopIpcChannels.bootstrap,
    safeHandler(async () => bootstrap()),
  );
  ipcMain.handle(
    DesktopIpcChannels.developerSettingsGet,
    safeHandler(async () => settings.developerSettings()),
  );
  ipcMain.handle(
    DesktopIpcChannels.developerSettingsUpdate,
    safeHandler(async (requestValue: unknown) => {
      const request = DesktopDeveloperSettingsUpdateV1Schema.parse(requestValue);
      const status = await dogfood.status(true);
      if (!request.dogfoodMetricsEnabled && status.state === "recording") {
        throw Object.assign(
          new Error("Stop and finalize the active dogfood recording before disabling it."),
          { code: "dogfood.recording-active" },
        );
      }
      return settings.updateDeveloperSettings(request);
    }),
  );
  ipcMain.handle(
    DesktopIpcChannels.dogfoodStatus,
    safeHandler(async () =>
      dogfood.status((await settings.developerSettings()).dogfoodMetricsEnabled),
    ),
  );
  ipcMain.handle(
    DesktopIpcChannels.dogfoodStart,
    safeHandler(async (requestValue: unknown) => {
      const request = DesktopDogfoodStartRequestV1Schema.parse(requestValue);
      const developer = await settings.developerSettings();
      if (!developer.dogfoodMetricsEnabled)
        throw Object.assign(new Error("Dogfood Metrics is disabled."), {
          code: "dogfood.disabled",
        });
      const profile = await validateProfile(await profileFor(request.profileId));
      const report = await runtime.doctor({
        schemaVersion: 1,
        projectPath: profile.projectPath,
        batchConfigPath: profile.batchConfigPath,
      });
      const snapshot = await settings.snapshot();
      const preferredAgentId =
        snapshot.preferredAgentIds[profile.profileId] ?? snapshot.lastUsedAgentId;
      const agentReady =
        preferredAgentId !== undefined &&
        (await agentManager.probe(await agentFor(preferredAgentId))).status === "ready";
      return dogfood.start({
        profileId: profile.profileId,
        projectLabel: profile.label,
        projectPath: profile.projectPath,
        configPath: profile.batchConfigPath,
        doctorPassed: report.ok && agentReady,
      });
    }),
  );
  ipcMain.handle(
    DesktopIpcChannels.dogfoodFinalize,
    safeHandler(async (requestValue: unknown) => {
      const request = DesktopDogfoodFinalizeRequestV1Schema.parse(requestValue);
      const status = await dogfood.status(true);
      if (status.session?.sessionId !== request.sessionId)
        throw Object.assign(new Error("Dogfood session was not found."), {
          code: "dogfood.session-not-found",
        });
      const target = await dogfood.finalizationTarget(request.sessionId);
      const [runs, editors, pool] = await Promise.all([
        runtime.listRuns({ projectPath: target.projectPath }),
        runtime.listEditors(),
        runtime.inspectEditorPoolForConfig(target.configPath),
      ]);
      return dogfood.finalize({
        sessionId: request.sessionId,
        observation: { runs, editors: editors.editors, pool },
      });
    }),
  );
  ipcMain.handle(
    DesktopIpcChannels.dogfoodOpenEvidence,
    safeHandler(async (requestValue: unknown) => {
      const request = DesktopDogfoodOpenEvidenceRequestV1Schema.parse(requestValue);
      const target = await dogfood.evidencePath(request.sessionId);
      return (await shell.openPath(target)) === "";
    }),
  );
  ipcMain.handle(
    DesktopIpcChannels.chooseProfile,
    safeHandler(async () => {
      const project = await showOpenDialog({
        title: "Choose a Unity project",
        properties: ["openDirectory"],
      });
      const projectPath = project.filePaths[0];
      if (project.canceled || projectPath === undefined) return null;
      const config = await showOpenDialog({
        title: "Choose the HoneyBee v0.6 batch config",
        defaultPath: projectPath,
        properties: ["openFile"],
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      const batchConfigPath = config.filePaths[0];
      if (config.canceled || batchConfigPath === undefined) return null;
      const existing = (await settings.listProfiles()).find(
        (candidate) =>
          profileKey(candidate.projectPath) === profileKey(projectPath) &&
          profileKey(candidate.batchConfigPath) === profileKey(batchConfigPath),
      );
      const profile = DesktopProjectProfileV1Schema.parse({
        schemaVersion: 1,
        profileId: existing?.profileId ?? randomUUID(),
        label: path.basename(projectPath),
        projectPath: path.resolve(projectPath),
        batchConfigPath: path.resolve(batchConfigPath),
        configLabel: path.basename(batchConfigPath, path.extname(batchConfigPath)),
        lastOpenedAt: new Date().toISOString(),
      });
      await settings.upsertProfile(profile);
      return profile;
    }),
  );
  ipcMain.handle(
    DesktopIpcChannels.chooseSetupPath,
    safeHandler(async (requestValue: unknown) => {
      const request = DesktopSetupPathRequestV1Schema.parse(requestValue);
      const directory = ["project", "workspace-root", "bridge-overlay"].includes(request.kind);
      const result = await showOpenDialog({
        title: `Choose ${request.kind.replaceAll("-", " ")}`,
        properties: [directory ? "openDirectory" : "openFile"],
        ...(directory
          ? {}
          : {
              filters:
                request.kind === "profile-import"
                  ? [{ name: "HoneyBee environment", extensions: ["json"] }]
                  : process.platform === "win32"
                    ? [
                        {
                          name: "Executable",
                          extensions: request.kind === "agent" ? ["exe", "cmd", "bat"] : ["exe"],
                        },
                      ]
                    : [],
            }),
      });
      return result.canceled ? null : (result.filePaths[0] ?? null);
    }),
  );
  ipcMain.handle(
    DesktopIpcChannels.projectDiscover,
    safeHandler(async (requestValue: unknown) => {
      const request = DesktopSetupDiscoveryRequestV1Schema.parse(requestValue);
      const discovery = await discoverDesktopSetup(
        request.projectPath,
        bundledWorkspaceStoragePath,
      );
      return DesktopProjectDiscoveryV1Schema.parse({
        schemaVersion: 1,
        projectPath: discovery.projectPath,
        ...(discovery.projectVersion === undefined
          ? {}
          : { projectVersion: discovery.projectVersion }),
        unity: discovery.unity,
        agents: discovery.agents,
      });
    }),
  );
  ipcMain.handle(
    DesktopIpcChannels.projectAdd,
    safeHandler(async (requestValue: unknown) => {
      const request = DesktopProjectAddRequestV2Schema.parse(requestValue);
      const agent = await requireReadyAgent(request.preferredAgentId);
      const storage = await provisionWorkspaceStorage();
      const testplay =
        request.testplayVersion === undefined
          ? undefined
          : await components.lock("testplay", request.testplayVersion);
      return setup.start(
        ResolvedDesktopSetupDraftV1Schema.parse({
          schemaVersion: 1,
          label: path.basename(path.resolve(request.projectPath)),
          projectPath: request.projectPath,
          unityPath: request.unityPath,
          workspaceStoragePath: componentFile(storage.lock, "client").path,
          workspaceRoot: storage.workspaceRoot,
          ...(testplay === undefined
            ? {}
            : {
                testplayPath: componentFile(testplay, "cli").path,
                bridgeOverlayPath: componentFile(testplay, "bridge-overlay").path,
              }),
          agent: agent.command,
          preferredAgentId: agent.agentId,
          editorCapacity: 2,
          componentLocks: {
            workspaceStorage: storage.lock,
            ...(testplay === undefined ? {} : { testplay }),
          },
        }),
      );
    }),
  );
  ipcMain.handle(
    DesktopIpcChannels.setupStatus,
    safeHandler(async (requestValue: unknown) => {
      const request = DesktopSetupIdRequestV1Schema.parse(requestValue);
      return setup.status(request.setupId);
    }),
  );
  ipcMain.handle(
    DesktopIpcChannels.setupResume,
    safeHandler(async (requestValue: unknown) => {
      const request = DesktopSetupIdRequestV1Schema.parse(requestValue);
      return setup.resume(request.setupId);
    }),
  );
  ipcMain.handle(
    DesktopIpcChannels.setupCancel,
    safeHandler(async (requestValue: unknown) => {
      const request = DesktopSetupIdRequestV1Schema.parse(requestValue);
      return setup.cancel(request.setupId);
    }),
  );
  ipcMain.handle(
    DesktopIpcChannels.componentsSnapshot,
    safeHandler(async () => components.snapshot()),
  );
  ipcMain.handle(
    DesktopIpcChannels.componentInstall,
    safeHandler(async (requestValue: unknown) => {
      const request = DesktopComponentInstallRequestV1Schema.parse(requestValue);
      return components.installTestPlay(request.version, request.approved);
    }),
  );
  ipcMain.handle(
    DesktopIpcChannels.setupImport,
    safeHandler(async () => {
      const selected = await showOpenDialog({
        title: "Import a HoneyBee managed environment",
        properties: ["openFile"],
        filters: [{ name: "HoneyBee environment", extensions: ["json"] }],
      });
      const selectedPath = selected.filePaths[0];
      if (selected.canceled || selectedPath === undefined) return null;
      const imported = DesktopProjectProfileSchema.parse(
        JSON.parse(await readFile(selectedPath, "utf8")),
      );
      if (imported.schemaVersion === 1) {
        throw new Error("Legacy path-only profiles cannot be imported as managed environments.");
      }
      let profile;
      if (imported.schemaVersion === 2) {
        const approvedStorage = components
          .releases("workspace-storage")
          .find((release) =>
            release.payloads.some(
              (payload) =>
                payload.role === "client" &&
                payload.sha256 === imported.environment.workspaceStorage.sha256,
            ),
          );
        if (approvedStorage !== undefined) {
          await components.installWorkspaceStorage(approvedStorage.version);
          const storageLock = await components.lock("workspace-storage", approvedStorage.version);
          const snapshot = await components.snapshot();
          const installedTestplay =
            imported.environment.testplay === undefined
              ? undefined
              : snapshot.installed.find(
                  (receipt) =>
                    receipt.componentId === "testplay" &&
                    receipt.files.some(
                      (file) =>
                        file.role === "cli" &&
                        file.sha256 === imported.environment.testplay?.sha256,
                    ) &&
                    receipt.files.some(
                      (file) =>
                        file.role === "bridge-overlay" &&
                        file.sha256 === imported.environment.bridgeOverlay?.digest,
                    ),
                );
          if (imported.environment.testplay === undefined || installedTestplay !== undefined) {
            profile = await upgradeManagedProfileV2(
              path.join(userData, "managed-environments"),
              imported,
              storageLock,
              installedTestplay === undefined
                ? undefined
                : await components.lock("testplay", installedTestplay.version),
            );
          }
        }
      }
      profile ??= await materializeImportedManagedProfile(
        path.join(userData, "managed-environments"),
        imported,
      );
      await settings.upsertProfile(profile);
      return profile;
    }),
  );
  ipcMain.handle(
    DesktopIpcChannels.setupExport,
    safeHandler(async (requestValue: unknown) => {
      const request = DesktopProfileIdRequestV1Schema.parse(requestValue);
      const profile = DesktopProjectProfileSchema.parse(await profileFor(request.profileId));
      if (profile.schemaVersion === 1) {
        throw new Error("Legacy path-only profiles cannot be exported as managed environments.");
      }
      const selected = await showSaveDialog({
        title: "Export HoneyBee managed environment",
        defaultPath: `${profile.label.replaceAll(/[^A-Za-z0-9._-]/gu, "-")}.honeybee.json`,
        filters: [{ name: "HoneyBee environment", extensions: ["json"] }],
      });
      if (selected.canceled || selected.filePath === undefined) return false;
      await writeFile(selected.filePath, JSON.stringify(profile, null, 2) + "\n", "utf8");
      return true;
    }),
  );
  ipcMain.handle(
    DesktopIpcChannels.removeProfile,
    safeHandler(async (requestValue: unknown) => {
      const request = DesktopProfileIdRequestV1Schema.parse(requestValue);
      await settings.removeProfile(request.profileId);
      return bootstrap();
    }),
  );
  ipcMain.handle(
    DesktopIpcChannels.doctor,
    safeHandler(async (requestValue: unknown) => {
      const request = DesktopDoctorRequestV1Schema.parse(requestValue);
      const profile = await profileFor(request.profileId);
      const runtimeReport = await runtime.doctor({
        schemaVersion: 1,
        projectPath: profile.projectPath,
        batchConfigPath: profile.batchConfigPath,
      });
      const settingsSnapshot = await settings.snapshot();
      const preferredAgentId =
        settingsSnapshot.preferredAgentIds[profile.profileId] ?? settingsSnapshot.lastUsedAgentId;
      const agentStatus =
        preferredAgentId === undefined
          ? undefined
          : await agentManager.probe(await agentFor(preferredAgentId));
      const report = {
        ...runtimeReport,
        checks: [
          ...runtimeReport.checks.filter((check) => !check.id.startsWith("agent.")),
          {
            id: "agent.library",
            label: "Preferred Agent",
            status:
              agentStatus?.status === "ready"
                ? ("pass" as const)
                : agentStatus === undefined
                  ? ("fail" as const)
                  : ("fail" as const),
            code: agentStatus?.status ?? "agent.not-selected",
            summary: agentStatus?.summary ?? "Choose a connected Agent for this project.",
            ...(agentStatus?.version === undefined ? {} : { version: agentStatus.version }),
          },
        ],
      };
      const normalizedReport = {
        ...report,
        ok: !report.checks.some((check) => check.status === "fail"),
      };
      if (profile.schemaVersion !== 2 && profile.schemaVersion !== 3) return normalizedReport;
      try {
        await validateProfile(profile);
        const componentSummary =
          profile.schemaVersion === 3
            ? "workspace-storage " +
              profile.environment.storage.component.version +
              (profile.environment.testplay === undefined
                ? "; TestPlay not installed (compile/warm-test not run)"
                : "; TestPlay " + profile.environment.testplay.version)
            : "Legacy managed paths remain pinned.";
        return {
          ...normalizedReport,
          checks: [
            ...normalizedReport.checks,
            {
              id: "managed.compatibility",
              label: "Managed environment",
              status: "pass" as const,
              code: "managed.pin-valid",
              summary: "Compatibility inputs and exact component locks still match.",
              target:
                profile.environment.schemaVersion === 1
                  ? profile.environment.workspaceStorage.compatibilityKey
                  : profile.environment.storage.compatibilityKey,
            },
            {
              id: "managed.components",
              label: "Managed components",
              status: profile.schemaVersion === 3 ? ("pass" as const) : ("warning" as const),
              code:
                profile.schemaVersion === 3
                  ? "managed.components-locked"
                  : "managed.components-legacy",
              summary: componentSummary,
            },
          ],
        };
      } catch {
        return {
          ...normalizedReport,
          ok: false,
          checks: [
            ...normalizedReport.checks,
            {
              id: "managed.compatibility",
              label: "Managed environment",
              status: "fail" as const,
              code: "managed.pin-invalid",
              summary:
                "Packages, required settings, Bridge, Unity, or a pinned tool changed. Run Setup Center again.",
              target:
                profile.environment.schemaVersion === 1
                  ? profile.environment.workspaceStorage.compatibilityKey
                  : profile.environment.storage.compatibilityKey,
            },
          ],
        };
      }
    }),
  );
  ipcMain.handle(
    DesktopIpcChannels.startWorks,
    safeHandler(async (requestValue: unknown) => {
      const request = DesktopStartRequestV2Schema.parse(requestValue);
      const profile = await validateProfile(await profileFor(request.profileId));
      const resolvedAgents = new Map<string, Awaited<ReturnType<typeof requireReadyAgent>>>();
      for (const agentId of new Set([
        request.defaultAgentId,
        ...request.works.flatMap((work) => (work.agentId === undefined ? [] : [work.agentId])),
      ])) {
        resolvedAgents.set(agentId, await requireReadyAgent(agentId));
      }
      await settings.setPreferredAgent(profile.profileId, request.defaultAgentId);
      await settings.markAgentUsed(request.defaultAgentId);
      const result = await runtime.startUnityWorks({
        schemaVersion: 2,
        projectPath: profile.projectPath,
        batchConfigPath: profile.batchConfigPath,
        maxParallelWorks: request.maxParallelWorks,
        works: request.works.map(({ agentId, ...work }) => {
          const selectedId = agentId ?? request.defaultAgentId;
          const agent = resolvedAgents.get(selectedId);
          if (agent === undefined) throw new Error("Agent profile resolution failed.");
          return {
            ...work,
            agent: {
              command: agent.command,
              trust: agent.trust,
              harness: "stdio-framed-v2" as const,
              adapter: agent.adapter,
            },
          };
        }),
      });
      await dogfood
        .recordParentRun(profile.profileId, result.runId, request.works.length)
        .catch(() => undefined);
      return result;
    }),
  );
  ipcMain.handle(
    DesktopIpcChannels.cloneRunDraft,
    safeHandler(async (requestValue: unknown) => {
      const request = DesktopCloneRunDraftRequestV1Schema.parse(requestValue);
      const [detail, settingsSnapshot] = await Promise.all([
        runtime.getRunDetail(request.runId),
        settings.snapshot(),
      ]);
      const configRef = detail.artifacts.find((artifact) => artifact.kind === "workflow-config");
      if (configRef === undefined) {
        throw Object.assign(new Error("The Run config Artifact is unavailable."), {
          code: "desktop.clone-unavailable",
        });
      }
      const configView = await runtime.readReferencedArtifact(request.runId, configRef.artifactId);
      if (configView.encoding !== "utf8") {
        throw Object.assign(new Error("The Run config Artifact is not readable JSON."), {
          code: "desktop.clone-unavailable",
        });
      }
      const taskRef = detail.artifacts.find((artifact) => artifact.kind === "task");
      const taskView =
        taskRef === undefined
          ? undefined
          : await runtime.readReferencedArtifact(request.runId, taskRef.artifactId);
      const projectPath = detail.summary.projectPath;
      const profile =
        projectPath === undefined
          ? undefined
          : settingsSnapshot.profiles.find(
              (candidate) => profileKey(candidate.projectPath) === profileKey(projectPath),
            );
      if (profile === undefined) {
        throw Object.assign(new Error("The original project profile is unavailable."), {
          code: "desktop.clone-profile-not-found",
        });
      }
      let config: unknown;
      try {
        config = JSON.parse(configView.content) as unknown;
      } catch {
        throw Object.assign(new Error("The Run config Artifact is invalid JSON."), {
          code: "desktop.clone-unavailable",
        });
      }
      return cloneRunDraftFromConfig({
        sourceRunId: request.runId,
        profileId: profile.profileId,
        preferredAgentId: settingsSnapshot.preferredAgentIds[profile.profileId],
        agents: settingsSnapshot.agents,
        config,
        ...(taskView?.encoding === "utf8" ? { task: taskView.content } : {}),
        ...(detail.summary.workId === undefined ? {} : { workId: detail.summary.workId }),
      });
    }),
  );
  ipcMain.handle(
    DesktopIpcChannels.agentsUpsert,
    safeHandler(async (requestValue: unknown) => {
      await agentManager.upsert(DesktopAgentUpsertRequestV1Schema.parse(requestValue));
      return bootstrap();
    }),
  );
  ipcMain.handle(
    DesktopIpcChannels.agentsRemove,
    safeHandler(async (requestValue: unknown) => {
      const request = DesktopAgentIdRequestV1Schema.parse(requestValue);
      await settings.removeAgent(request.agentId);
      return bootstrap();
    }),
  );
  ipcMain.handle(
    DesktopIpcChannels.agentsProbe,
    safeHandler(async (requestValue: unknown) => {
      const request = DesktopAgentIdRequestV1Schema.parse(requestValue);
      return agentManager.probe(await agentFor(request.agentId));
    }),
  );
  ipcMain.handle(
    DesktopIpcChannels.agentsConnect,
    safeHandler(async (requestValue: unknown) => {
      const request = DesktopAgentIdRequestV1Schema.parse(requestValue);
      return agentManager.connect(await agentFor(request.agentId));
    }),
  );
  ipcMain.handle(
    DesktopIpcChannels.agentApprovalsList,
    safeHandler(async () =>
      DesktopAgentApprovalListV1Schema.parse({
        schemaVersion: 1,
        approvals: agentApprovalBroker.pending(),
      }),
    ),
  );
  ipcMain.handle(
    DesktopIpcChannels.agentApprovalRespond,
    safeHandler(async (requestValue: unknown) => {
      const request = DesktopAgentApprovalResponseV1Schema.parse(requestValue);
      agentApprovalBroker.respond(request.approvalId, request.decision);
      return DesktopAgentApprovalListV1Schema.parse({
        schemaVersion: 1,
        approvals: agentApprovalBroker.pending(),
      });
    }),
  );
  ipcMain.handle(
    DesktopIpcChannels.projectAgentPreference,
    safeHandler(async (requestValue: unknown) => {
      const request = DesktopProjectAgentPreferenceRequestV1Schema.parse(requestValue);
      await settings.setPreferredAgent(request.profileId, request.agentId);
      return bootstrap();
    }),
  );
  ipcMain.handle(
    DesktopIpcChannels.runtimeSnapshot,
    safeHandler(async (requestValue: unknown) => {
      const request = DesktopProfileIdRequestV1Schema.parse(requestValue);
      const profile = await profileFor(request.profileId);
      const [runs, editors, pool] = await Promise.all([
        runtime.listRuns({ projectPath: profile.projectPath }),
        runtime.listEditors(),
        runtime.inspectEditorPoolForConfig(profile.batchConfigPath),
      ]);
      return DesktopRuntimeSnapshotV1Schema.parse({
        schemaVersion: 1,
        observedAt: new Date().toISOString(),
        runs,
        editors,
        pool,
      });
    }),
  );
  ipcMain.handle(
    DesktopIpcChannels.runDetail,
    safeHandler(async (requestValue: unknown) => {
      const request = DesktopRunRequestV1Schema.parse(requestValue);
      return runtime.getRunDetail(request.runId);
    }),
  );
  ipcMain.handle(
    DesktopIpcChannels.terminalSnapshot,
    safeHandler(async (requestValue: unknown) => {
      const request = DesktopTerminalSnapshotRequestV1Schema.parse(requestValue);
      const [context, developer] = await Promise.all([
        terminalRunContext(request.runId),
        settings.developerSettings(),
      ]);
      return terminalBroker.snapshot({
        ...context,
        scopeKey: request.runId,
        afterCursor: request.afterCursor,
        mode: request.mode,
        rawEnabled: developer.rawAgentProtocolEnabled,
      });
    }),
  );
  ipcMain.handle(
    DesktopIpcChannels.terminalWindowOpen,
    safeHandler(async (requestValue: unknown) => {
      const request = DesktopRunRequestV1Schema.parse(requestValue);
      await runtime.getRunDetail(request.runId);
      await openTerminalWindow(request.runId);
      return true;
    }),
  );
  ipcMain.handle(
    DesktopIpcChannels.artifactRead,
    safeHandler(async (requestValue: unknown) => {
      const request = DesktopArtifactRequestV1Schema.parse(requestValue);
      return runtime.readReferencedArtifact(request.runId, request.artifactId);
    }),
  );
  ipcMain.handle(
    DesktopIpcChannels.runResume,
    safeHandler(async (requestValue: unknown) => {
      const request = DesktopRunRequestV1Schema.parse(requestValue);
      return runtime.resume(request.runId);
    }),
  );
  ipcMain.handle(
    DesktopIpcChannels.runCancel,
    safeHandler(async (requestValue: unknown) => {
      const request = DesktopRunRequestV1Schema.parse(requestValue);
      return runtime.cancel(request.runId);
    }),
  );
  ipcMain.handle(
    DesktopIpcChannels.patchView,
    safeHandler(async (requestValue: unknown) => {
      const request = DesktopPatchRequestV1Schema.parse(requestValue);
      return runtime.getVerifiedPatch(request.runId, request.patchArtifactId);
    }),
  );
  ipcMain.handle(
    DesktopIpcChannels.patchControl,
    safeHandler(async (requestValue: unknown) => {
      const request = DesktopPatchControlRequestV1Schema.parse(requestValue);
      return runtime.controlVerifiedPatch(request.runId, request.patchArtifactId, request.action);
    }),
  );
};

const desktopPreloadPath = (): string =>
  fileURLToPath(new URL(/* @vite-ignore */ "../../preload/preload.cjs", import.meta.url));

const loadRenderer = async (
  window: BrowserWindow,
  query: Readonly<Record<string, string>> = {},
): Promise<void> => {
  const developmentUrl = process.env.HONEYBEE_DESKTOP_DEV_URL;
  if (
    developmentUrl !== undefined &&
    /^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?(?:\/|$)/u.test(developmentUrl)
  ) {
    const target = new URL(developmentUrl);
    for (const [key, value] of Object.entries(query)) target.searchParams.set(key, value);
    await window.loadURL(target.toString());
    return;
  }
  await window.loadFile(
    fileURLToPath(new URL(/* @vite-ignore */ "../../renderer/index.html", import.meta.url)),
    { query: { ...query } },
  );
};

const openTerminalWindow = async (runId: string): Promise<void> => {
  const existing = terminalWindows.get(runId);
  if (existing !== undefined && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore();
    existing.show();
    existing.focus();
    return;
  }
  const terminalWindow = new BrowserWindow({
    width: 980,
    height: 640,
    minWidth: 680,
    minHeight: 420,
    backgroundColor: "#070b0e",
    show: false,
    title: `HoneyBee Terminal · ${runId.slice(0, 8)}`,
    ...(mainWindow === undefined ? {} : { parent: mainWindow }),
    webPreferences: {
      preload: desktopPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  terminalWindows.set(runId, terminalWindow);
  terminalWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  terminalWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  terminalWindow.once("ready-to-show", () => terminalWindow.show());
  terminalWindow.once("closed", () => terminalWindows.delete(runId));
  await loadRenderer(terminalWindow, { view: "terminal", runId });
};

const createWindow = async (): Promise<void> => {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 980,
    minHeight: 680,
    backgroundColor: "#090d10",
    show: false,
    title: "HoneyBee",
    webPreferences: {
      preload: desktopPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  if (!smokeMode) mainWindow.once("ready-to-show", () => mainWindow?.show());
  await writeSmokeStage("window-created");
  await loadRenderer(mainWindow);
  await writeSmokeStage("renderer-loaded");
  if (smokeMode) {
    try {
      const script = [
        "new Promise((resolve, reject) => {",
        "  const deadline = Date.now() + 5000;",
        "  const inspect = async () => {",
        "    try {",
        "      const api = window.honeybee;",
        "      const ready = document.querySelector('.desktop-app .brand-lockup') !== null && document.querySelector('.app-main') !== null;",
        "      if (api !== undefined && ready) {",
        "        const components = await api.components();",
        "        const developerBefore = await api.developerSettings();",
        "        const developerEnabled = await api.updateDeveloperSettings({ schemaVersion: 1, dogfoodMetricsEnabled: true, rawAgentProtocolEnabled: false });",
        "        const dogfood = await api.dogfoodStatus();",
        "        await api.updateDeveloperSettings({ schemaVersion: 1, dogfoodMetricsEnabled: false, rawAgentProtocolEnabled: false });",
        "        resolve({",
        "          componentSchemaVersion: components.schemaVersion,",
        "          developerDefaultOff: developerBefore.dogfoodMetricsEnabled === false,",
        "          developerToggleOn: developerEnabled.dogfoodMetricsEnabled === true,",
        "          dogfoodIdle: dogfood.enabled === true && dogfood.state === 'idle',",
        "          rendererReady: ready",
        "        });",
        "        return;",
        "      }",
        "      if (Date.now() >= deadline) {",
        "        const body = (document.body.textContent ?? '').slice(0, 300);",
        "        reject(new Error('renderer timeout; api=' + (api !== undefined) + '; body=' + body));",
        "        return;",
        "      }",
        "      setTimeout(() => void inspect(), 50);",
        "    } catch (error) { reject(error); }",
        "  };",
        "  void inspect();",
        "})",
      ].join("\n");
      const result = (await mainWindow.webContents.executeJavaScript(script)) as unknown;
      const valid =
        typeof result === "object" &&
        result !== null &&
        "componentSchemaVersion" in result &&
        result.componentSchemaVersion === 1 &&
        "rendererReady" in result &&
        result.rendererReady === true &&
        "developerDefaultOff" in result &&
        result.developerDefaultOff === true &&
        "developerToggleOn" in result &&
        result.developerToggleOn === true &&
        "dogfoodIdle" in result &&
        result.dogfoodIdle === true;
      if (!valid) throw new Error("invalid smoke result");
      await writeSmokeStage("passed");
      process.stdout.write("HONEYBEE_DESKTOP_SMOKE_OK\n");
      mainWindow.destroy();
      app.exit(0);
    } catch (error) {
      await writeSmokeStage("failed");
      process.stderr.write(
        "HoneyBee Desktop smoke failed.\n" +
          (error instanceof Error ? (error.stack ?? error.message) : String(error)) +
          "\n",
      );
      mainWindow.destroy();
      app.exit(1);
    }
  }
};

const startDesktop = async (): Promise<void> => {
  await writeSmokeStage("module-loaded");
  await app.whenReady();
  await writeSmokeStage("app-ready");
  registerIpc();
  await createWindow();
};

const ownsDesktopInstance = app.requestSingleInstanceLock();
if (!ownsDesktopInstance) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow?.isMinimized() === true) mainWindow.restore();
    mainWindow?.show();
    mainWindow?.focus();
  });
  void startDesktop().catch(async () => {
    await writeSmokeStage("failed").catch(() => undefined);
    process.stderr.write("HoneyBee Desktop failed to start.\n");
    app.exit(1);
  });
}

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow();
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
