import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { HoneyBeeRuntimeFacade } from "honeybee-cli/runtime";

import {
  DesktopArtifactRequestV1Schema,
  DesktopBootstrapV1Schema,
  DesktopDoctorRequestV1Schema,
  DesktopIpcChannels,
  DesktopPatchControlRequestV1Schema,
  DesktopPatchRequestV1Schema,
  DesktopProfileIdRequestV1Schema,
  DesktopProjectProfileV1Schema,
  DesktopProjectProfileV2Schema,
  DesktopRunRequestV1Schema,
  DesktopRuntimeSnapshotV1Schema,
  DesktopStartRequestV1Schema,
  DesktopSetupDiscoveryRequestV1Schema,
  DesktopSetupDraftV1Schema,
  DesktopSetupIdRequestV1Schema,
  DesktopSetupInstallStorageRequestV1Schema,
  DesktopSetupInstallStorageResultV1Schema,
  DesktopSetupPathRequestV1Schema,
} from "../shared/ipc.js";
import { DesktopSettingsStore } from "./settings.js";
import {
  DesktopSetupCoordinator,
  discoverDesktopSetup,
  installBundledWorkspaceStorage,
  materializeImportedManagedProfile,
  validateManagedEnvironment,
} from "./setup.js";

let mainWindow: BrowserWindow | undefined;
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
const bundledWorkspaceStorageHostPath = path.join(
  bundledToolsRoot,
  "honeybee-workspace-storage-host.exe",
);
const settings = new DesktopSettingsStore(userData);
const setup = new DesktopSetupCoordinator(path.join(userData, "setups"), (profile) =>
  settings.upsertProfile(profile),
);
const runtime = new HoneyBeeRuntimeFacade({
  stateRoot: path.join(userData, "runtime", "runs"),
});

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
  if (profile === undefined) throw new Error("Project profile was not found.");
  return profile;
};

const validateProfile = async (profile: Awaited<ReturnType<typeof profileFor>>) => {
  if (profile.schemaVersion === 2) await validateManagedEnvironment(profile);
  return profile;
};

const bootstrap = async () =>
  DesktopBootstrapV1Schema.parse({
    schemaVersion: 1,
    runtime: runtime.info(),
    profiles: await settings.listProfiles(),
  });

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
      throw new Error(`HoneyBee operation failed (${code}).`, { cause: error });
    }
  };

const registerIpc = (): void => {
  ipcMain.handle(
    DesktopIpcChannels.bootstrap,
    safeHandler(async () => bootstrap()),
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
    DesktopIpcChannels.setupDiscover,
    safeHandler(async (requestValue: unknown) => {
      const request = DesktopSetupDiscoveryRequestV1Schema.parse(requestValue);
      return discoverDesktopSetup(request.projectPath, bundledWorkspaceStoragePath);
    }),
  );
  ipcMain.handle(
    DesktopIpcChannels.setupStart,
    safeHandler(async (requestValue: unknown) => {
      const request = DesktopSetupDraftV1Schema.parse(requestValue);
      return setup.start({
        ...request,
        workspaceStoragePath: bundledWorkspaceStoragePath,
      });
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
    DesktopIpcChannels.setupInstallStorage,
    safeHandler(async (requestValue: unknown) => {
      const request = DesktopSetupInstallStorageRequestV1Schema.parse(requestValue);
      await installBundledWorkspaceStorage(bundledWorkspaceStorageHostPath, request.workspaceRoot);
      return DesktopSetupInstallStorageResultV1Schema.parse({
        schemaVersion: 1,
        installed: true,
        message: "HoneyBee workspace storage was installed for the current user.",
      });
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
      const imported = DesktopProjectProfileV2Schema.parse(
        JSON.parse(await readFile(selectedPath, "utf8")),
      );
      const profile = await materializeImportedManagedProfile(
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
      const profile = DesktopProjectProfileV2Schema.parse(await profileFor(request.profileId));
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
      const report = await runtime.doctor({
        schemaVersion: 1,
        projectPath: profile.projectPath,
        batchConfigPath: profile.batchConfigPath,
      });
      if (profile.schemaVersion !== 2) return report;
      try {
        await validateManagedEnvironment(profile);
        return {
          ...report,
          checks: [
            ...report.checks,
            {
              id: "managed.compatibility",
              label: "Managed environment",
              status: "pass" as const,
              code: "managed.pin-valid",
              summary: "Compatibility inputs and pinned local tools still match.",
              target: profile.environment.workspaceStorage.compatibilityKey,
            },
          ],
        };
      } catch {
        return {
          ...report,
          ok: false,
          checks: [
            ...report.checks,
            {
              id: "managed.compatibility",
              label: "Managed environment",
              status: "fail" as const,
              code: "managed.pin-invalid",
              summary:
                "Packages, required settings, Bridge, Unity, or a pinned tool changed. Run Setup Center again.",
              target: profile.environment.workspaceStorage.compatibilityKey,
            },
          ],
        };
      }
    }),
  );
  ipcMain.handle(
    DesktopIpcChannels.startWorks,
    safeHandler(async (requestValue: unknown) => {
      const request = DesktopStartRequestV1Schema.parse(requestValue);
      const profile = await validateProfile(await profileFor(request.profileId));
      return runtime.startUnityWorks({
        schemaVersion: 1,
        projectPath: profile.projectPath,
        batchConfigPath: profile.batchConfigPath,
        maxParallelWorks: request.maxParallelWorks,
        works: request.works,
      });
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

const createWindow = async (): Promise<void> => {
  const preload = fileURLToPath(
    new URL(/* @vite-ignore */ "../../preload/preload.cjs", import.meta.url),
  );
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 980,
    minHeight: 680,
    backgroundColor: "#090d10",
    show: false,
    title: "HoneyBee",
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  if (!smokeMode) mainWindow.once("ready-to-show", () => mainWindow?.show());
  await writeSmokeStage("window-created");
  const developmentUrl = process.env.HONEYBEE_DESKTOP_DEV_URL;
  if (
    developmentUrl !== undefined &&
    /^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?(?:\/|$)/u.test(developmentUrl)
  ) {
    await mainWindow.loadURL(developmentUrl);
  } else {
    await mainWindow.loadFile(
      fileURLToPath(new URL(/* @vite-ignore */ "../../renderer/index.html", import.meta.url)),
    );
  }
  await writeSmokeStage("renderer-loaded");
  if (smokeMode) {
    try {
      const script = [
        "new Promise((resolve, reject) => {",
        "  const deadline = Date.now() + 5000;",
        "  const inspect = async () => {",
        "    try {",
        "      const api = window.honeybee;",
        "      const ready = document.body.textContent?.includes('Command Center') === true;",
        "      if (api !== undefined && ready) {",
        "        const bootstrap = await api.bootstrap();",
        "        resolve({",
        "          apiVersion: bootstrap.runtime.apiVersion,",
        "          schemaVersion: bootstrap.schemaVersion,",
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
        "apiVersion" in result &&
        result.apiVersion === 1 &&
        "schemaVersion" in result &&
        result.schemaVersion === 1 &&
        "rendererReady" in result &&
        result.rendererReady === true;
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
