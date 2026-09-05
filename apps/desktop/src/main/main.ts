import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { HoneyBeeWorkspaceCore, type ProjectRecordV2, type WorkspaceViewV1 } from "@honeybee/core";
import { app, BrowserWindow, dialog, ipcMain, Menu } from "electron";

import {
  DesktopCloneRequestV1Schema,
  DesktopExternalLaunchRequestV1Schema,
  DesktopFolderPickerRequestV1Schema,
  DesktopGitDiffRequestV1Schema,
  DesktopIpcChannels,
  DesktopProjectPathRequestV1Schema,
  DesktopProjectRequestV1Schema,
  DesktopProjectSetupRequestV1Schema,
  DesktopProjectUnityLaunchRequestV1Schema,
  DesktopPtyCreateRequestV1Schema,
  DesktopPtyResizeRequestV1Schema,
  DesktopPtySessionRequestV1Schema,
  DesktopPtySnapshotRequestV1Schema,
  DesktopPtyWriteRequestV1Schema,
  DesktopWindowActionRequestV1Schema,
  DesktopWorkspaceCreateRequestV1Schema,
  DesktopWorkspaceRequestV1Schema,
  type DesktopProjectV2,
  type DesktopWorkspaceV2,
} from "../shared/ipc.js";
import { readDiff } from "./git-diff.js";
import { verifyWorkbench } from "./workbench-smoke.js";
import { setupBlockers } from "../shared/setup-checks.js";
import compatibility from "../../resources/component-compatibility-v1.json" with { type: "json" };
import { desktopError, DesktopMainError } from "./desktop-errors.js";
import { launchExternalTool, resolveExternalTool } from "./external-tools.js";
import {
  cloneUnityProject,
  discoverProjectCandidates,
  inspectUnityProject,
  readUnityVersion,
} from "./project-onboarding.js";
import { DesktopPtySessionManager } from "./pty-session-manager.js";

const core = new HoneyBeeWorkspaceCore();
const ptySessions = new DesktopPtySessionManager();
const smokeMode = process.env.HONEYBEE_DESKTOP_SMOKE === "desktop-smoke-v2";
const captureDirectory = process.env.HONEYBEE_DESKTOP_CAPTURE_DIR;
const captureMode = captureDirectory !== undefined;
const fixtureMode = smokeMode || captureMode;
const captureWidth = Number(process.env.HONEYBEE_DESKTOP_CAPTURE_WIDTH ?? 1280);
const captureHeight = Number(process.env.HONEYBEE_DESKTOP_CAPTURE_HEIGHT ?? 820);
const smokeResultPath = process.env.HONEYBEE_DESKTOP_SMOKE_RESULT;
let mainWindow: BrowserWindow | undefined;
let smokeTerminalRoot: string | undefined;

const smokeProject: DesktopProjectV2 = {
  projectId: "smoke-project",
  label: "GKF_",
  unityProjectPath: "C:\\Unity\\GKF_",
  unityRelativePath: "",
  workspaceRoot: "D:\\HoneyBee\\GKF_",
  cacheState: "ready",
  unityVersion: "6000.0.42f1",
};
let smokeWorkspaces: DesktopWorkspaceV2[] = [
  {
    workspaceId: "smoke-combat",
    projectId: smokeProject.projectId,
    name: "combat",
    workspacePath: "D:\\HoneyBee\\GKF_\\combat",
    state: "ready",
    available: true,
    libraryConnected: true,
    branch: "main",
    baseCommit: "a1b2c3d4",
    git: { branch: "main", head: "a1b2c3d4", dirty: false, changes: [] },
  },
  {
    workspaceId: "smoke-ui",
    projectId: smokeProject.projectId,
    name: "ui",
    workspacePath: "D:\\HoneyBee\\GKF_\\ui",
    state: "ready",
    available: true,
    libraryConnected: true,
    branch: "develop",
    baseCommit: "b2c3d4e5",
    git: {
      branch: "develop",
      head: "b2c3d4e5",
      dirty: true,
      changes: [" M Assets/UI/Hud.prefab", "?? Assets/UI/Hud.prefab.meta"],
    },
  },
  {
    workspaceId: "smoke-enemy",
    projectId: smokeProject.projectId,
    name: "enemy-ai",
    workspacePath: "D:\\HoneyBee\\GKF_\\enemy-ai",
    state: "repair-required",
    available: false,
    libraryConnected: false,
    branch: "feature/ai",
    baseCommit: "c3d4e5f6",
    git: { branch: "feature/ai", head: "c3d4e5f6", dirty: false, changes: [] },
  },
];

if (fixtureMode) app.disableHardwareAcceleration();

const writeSmokeStage = async (stage: string): Promise<void> => {
  if (smokeResultPath === undefined) return;
  const target = path.resolve(smokeResultPath);
  const relative = path.relative(path.resolve(tmpdir()), target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return;
  await writeFile(target, `${JSON.stringify({ stage })}\n`, "utf8");
};

const packagedStoragePath = (): string =>
  app.isPackaged
    ? path.join(process.resourcesPath, "win32-x64", "unity-workspace-storage.exe")
    : path.join(app.getAppPath(), ".tools", "win32-x64", "unity-workspace-storage.exe");
const desktopDoctor = () => {
  const approved = compatibility.workspaceStorage[0];
  return core.doctor({
    storageCommand: packagedStoragePath(),
    ...(approved === undefined
      ? {}
      : {
          expectedComponentVersion: approved.version,
          expectedClientSha256:
            approved.payloads.find((item) => item.role === "client")?.sha256 ?? "",
          expectedControlSha256:
            approved.payloads.find((item) => item.role === "host")?.sha256 ?? "",
        }),
  });
};
const storageCommand = async (): Promise<string> => {
  const target = packagedStoragePath();
  await access(target).catch((cause: unknown) => {
    throw new DesktopMainError(
      "storage.command-not-found",
      `workspace-storage executable was not found: ${target}`,
      ["Run the packaged HoneyBee Desktop build or prepare the pinned storage tools."],
      { cause },
    );
  });
  return target;
};

const projectView = async (project: ProjectRecordV2): Promise<DesktopProjectV2> => ({
  projectId: project.projectId,
  label: project.label,
  unityProjectPath: project.unityProjectPath,
  unityRelativePath: project.unityRelativePath,
  workspaceRoot: project.workspaceRoot,
  cacheState: project.cache === undefined ? "missing" : "ready",
  unityVersion: await readUnityVersion(project.unityProjectPath),
});

const workspaceView = (workspace: WorkspaceViewV1): DesktopWorkspaceV2 => ({
  workspaceId: workspace.workspaceId,
  projectId: workspace.projectId,
  name: workspace.name,
  workspacePath: workspace.workspacePath,
  state: workspace.state,
  available: workspace.available,
  libraryConnected: workspace.libraryConnected,
  branch: workspace.branch,
  baseCommit: workspace.baseCommit,
  git:
    workspace.git === undefined ? null : { ...workspace.git, changes: [...workspace.git.changes] },
});

const workspaceFor = async (projectId: string, workspaceId: string): Promise<WorkspaceViewV1> => {
  const workspace = await core.workspaceStatus(workspaceId, projectId);
  if (workspace.projectId !== projectId)
    throw new DesktopMainError(
      "workspace.project-mismatch",
      "Workspace project identity mismatch.",
    );
  return workspace;
};

const handler =
  <T>(operation: (value: unknown, event: Electron.IpcMainInvokeEvent) => Promise<T> | T) =>
  async (event: Electron.IpcMainInvokeEvent, value?: unknown) => {
    try {
      return { ok: true as const, value: await operation(value, event) };
    } catch (reason) {
      return { ok: false as const, error: desktopError(reason) };
    }
  };

const registerIpc = (): void => {
  ipcMain.handle(
    DesktopIpcChannels.projects,
    handler(async () => {
      if (fixtureMode) return [smokeProject];
      return Promise.all(
        [...(await core.listProjects())]
          .sort((a, b) => a.label.localeCompare(b.label))
          .map(projectView),
      );
    }),
  );
  ipcMain.handle(
    DesktopIpcChannels.projectCandidates,
    handler(async () => {
      if (fixtureMode)
        return [
          {
            source: "honeybee" as const,
            label: "GKF_",
            path: smokeProject.unityProjectPath,
            unityVersion: smokeProject.unityVersion,
            registeredProjectId: smokeProject.projectId,
            setupState: "ready" as const,
          },
          {
            source: "unity-hub" as const,
            label: "NetRPG",
            path: "C:\\Unity\\NetRPG",
            unityVersion: "6000.0.42f1",
            registeredProjectId: null,
            setupState: "setup-required" as const,
          },
        ];
      const hubFile =
        process.env.APPDATA === undefined
          ? undefined
          : path.join(process.env.APPDATA, "UnityHub", "projects-v1.json");
      return discoverProjectCandidates(await core.listProjects(), hubFile);
    }),
  );
  ipcMain.handle(
    DesktopIpcChannels.projectInspect,
    handler(async (value) => {
      const request = DesktopProjectPathRequestV1Schema.parse(value);
      if (fixtureMode)
        return {
          label: path.basename(request.path),
          path: request.path,
          repositoryRoot: request.path,
          defaultWorkspaceRoot: `${request.path}-workspaces`,
          unityVersion: "6000.0.42f1",
          registeredProjectId: null,
          readyForSetup: true,
          checks: [
            {
              code: "project.unity-layout",
              status: "pass" as const,
              message: "Unity project layout is valid.",
              remediation: [],
            },
            {
              code: "cache.source-library",
              status: "pass" as const,
              message: "The source Library is present.",
              remediation: [],
            },
            {
              code: "cache.library-ignored",
              status: "pass" as const,
              message: "Library is ignored by Git.",
              remediation: [],
            },
          ],
        };
      return inspectUnityProject(request.path, await core.listProjects());
    }),
  );
  ipcMain.handle(
    DesktopIpcChannels.projectPickFolder,
    handler(async (value) => {
      const request = DesktopFolderPickerRequestV1Schema.parse(value);
      if (fixtureMode)
        return request.kind === "workspace-root"
          ? "D:\\HoneyBee\\NetRPG"
          : request.kind === "clone-destination"
            ? `C:\\Unity\\${request.childName ?? "Game"}`
            : "C:\\Unity\\NetRPG";
      if (mainWindow === undefined)
        throw new DesktopMainError(
          "desktop.window-unavailable",
          "The Desktop window is unavailable.",
        );
      const result = await dialog.showOpenDialog(mainWindow, {
        title:
          request.kind === "unity-project"
            ? "Select Unity project"
            : request.kind === "workspace-root"
              ? "Select Workspace root"
              : "Select clone parent folder",
        ...(request.defaultPath === undefined ? {} : { defaultPath: request.defaultPath }),
        properties: [
          "openDirectory",
          ...(request.kind === "clone-destination" ? ["createDirectory" as const] : []),
        ],
      });
      const selected = result.canceled ? null : (result.filePaths[0] ?? null);
      return selected !== null &&
        request.kind === "clone-destination" &&
        request.childName !== undefined
        ? path.join(selected, request.childName)
        : selected;
    }),
  );
  ipcMain.handle(
    DesktopIpcChannels.projectClone,
    handler(async (value) => {
      const request = DesktopCloneRequestV1Schema.parse(value);
      if (fixtureMode)
        return {
          path: request.destination,
          label: path.basename(request.destination),
          unityVersion: "6000.0.42f1",
        };
      return cloneUnityProject(request.url, request.destination);
    }),
  );
  ipcMain.handle(
    DesktopIpcChannels.projectSetup,
    handler(async (value) => {
      const request = DesktopProjectSetupRequestV1Schema.parse(value);
      if (fixtureMode)
        return {
          ...smokeProject,
          projectId: "smoke-setup",
          label: request.label ?? path.basename(request.path),
          unityProjectPath: request.path,
          workspaceRoot: request.workspaceRoot,
        };
      const inspection = await inspectUnityProject(request.path, await core.listProjects());
      if (!inspection.readyForSetup)
        throw new DesktopMainError(
          "project.setup-blocked",
          "Project setup checks have not passed.",
          inspection.checks
            .filter((item) => item.status !== "pass")
            .flatMap((item) => item.remediation),
        );
      const command = await storageCommand();
      const report = await desktopDoctor();
      const blockers = setupBlockers(report.checks);
      if (blockers.length > 0)
        throw new DesktopMainError(
          "project.setup-blocked",
          blockers.map((item) => item.message).join(" "),
          blockers.flatMap((item) => item.remediation ?? []),
        );
      const project = await core.initProject({
        unityProjectPath: request.path,
        workspaceRoot: request.workspaceRoot,
        storageCommand: command,
        ...(request.label === undefined ? {} : { label: request.label }),
      });
      return projectView(await core.prepareCache(project.projectId));
    }),
  );
  ipcMain.handle(
    DesktopIpcChannels.cachePrepare,
    handler(async (value) => {
      const request = DesktopProjectRequestV1Schema.parse(value);
      if (fixtureMode) return smokeProject;
      return projectView(await core.prepareCache(request.projectId));
    }),
  );
  ipcMain.handle(
    DesktopIpcChannels.doctor,
    handler(async () =>
      fixtureMode
        ? {
            schemaVersion: 1 as const,
            ready: true,
            summary: { pass: 3, warning: 0, fail: 0 },
            checks: [
              {
                code: "storage.command",
                status: "pass" as const,
                message: "workspace-storage executable is present.",
              },
              {
                code: "storage.service",
                status: "pass" as const,
                message: "UnityWorkspaceStorage service is running.",
              },
              {
                code: "storage.install-receipt",
                status: "pass" as const,
                message: "Storage install receipt is valid.",
              },
            ],
          }
        : desktopDoctor(),
    ),
  );
  ipcMain.handle(
    DesktopIpcChannels.workspaces,
    handler(async (value) => {
      const request = DesktopProjectRequestV1Schema.parse(value);
      if (fixtureMode)
        return smokeWorkspaces.filter((item) => item.projectId === request.projectId);
      return [...(await core.listWorkspaces(request.projectId))]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(workspaceView);
    }),
  );
  ipcMain.handle(
    DesktopIpcChannels.workspaceCreate,
    handler(async (value) => {
      const request = DesktopWorkspaceCreateRequestV1Schema.parse(value);
      if (fixtureMode) {
        const created: DesktopWorkspaceV2 = {
          workspaceId: `smoke-${request.name}`,
          projectId: request.projectId,
          name: request.name,
          workspacePath: `${smokeProject.workspaceRoot}\\${request.name}`,
          state: "ready",
          available: true,
          libraryConnected: true,
          branch: request.branch,
          baseCommit: request.base ?? "a1b2c3d4",
          git: { branch: request.branch, head: "a1b2c3d4", dirty: false, changes: [] },
        };
        smokeWorkspaces = [...smokeWorkspaces, created];
        return created;
      }
      const workspace = request.existingBranch
        ? await core.attachWorkspace({
            project: request.projectId,
            name: request.name,
            branch: request.branch,
          })
        : await core.createWorkspace({
            project: request.projectId,
            name: request.name,
            branch: request.branch,
            ...(request.base === undefined ? {} : { base: request.base }),
          });
      return workspaceView(workspace);
    }),
  );
  ipcMain.handle(
    DesktopIpcChannels.workspaceRepair,
    handler(async (value) => {
      const request = DesktopWorkspaceRequestV1Schema.parse(value);
      if (fixtureMode) {
        smokeWorkspaces = smokeWorkspaces.map((item) =>
          item.workspaceId === request.workspaceId
            ? { ...item, state: "ready", available: true, libraryConnected: true }
            : item,
        );
        const repaired = smokeWorkspaces.find((item) => item.workspaceId === request.workspaceId);
        if (repaired === undefined)
          throw new DesktopMainError("workspace.not-found", "Workspace was not found.");
        return repaired;
      }
      return workspaceView(await core.repairWorkspace(request.workspaceId, request.projectId));
    }),
  );
  ipcMain.handle(
    DesktopIpcChannels.workspaceRemove,
    handler(async (value) => {
      const request = DesktopWorkspaceRequestV1Schema.parse(value);
      await ptySessions.withWorkspaceRemoval(request.projectId, request.workspaceId, async () => {
        if (fixtureMode) {
          smokeWorkspaces = smokeWorkspaces.filter(
            (item) => item.workspaceId !== request.workspaceId,
          );
          return;
        }
        await core.removeWorkspace(request.workspaceId, request.projectId);
      });
      return true;
    }),
  );
  ipcMain.handle(
    DesktopIpcChannels.externalLaunch,
    handler(async (value) => {
      const request = DesktopExternalLaunchRequestV1Schema.parse(value);
      if (fixtureMode) return true;
      const workspace = await workspaceFor(request.projectId, request.workspaceId);
      if (!workspace.available || workspace.state !== "ready")
        throw new DesktopMainError(
          "workspace.repair-required",
          "Repair this Workspace before opening an external tool.",
          [`Run honeybee workspace repair "${workspace.name}".`],
        );
      const project = await core.cacheStatus(request.projectId);
      const toolPath =
        request.tool === "unity"
          ? path.join(workspace.workspacePath, project.unityRelativePath)
          : workspace.workspacePath;
      await launchExternalTool(
        await resolveExternalTool(request.tool, toolPath),
        workspace.workspacePath,
      );
      return true;
    }),
  );
  ipcMain.handle(
    DesktopIpcChannels.projectUnityLaunch,
    handler(async (value) => {
      const request = DesktopProjectUnityLaunchRequestV1Schema.parse(value);
      if (fixtureMode) return true;
      await launchExternalTool(await resolveExternalTool("unity", request.path), request.path);
      return true;
    }),
  );
  ipcMain.handle(
    DesktopIpcChannels.windowAction,
    handler((value, event) => {
      const request = DesktopWindowActionRequestV1Schema.parse(value);
      const window = BrowserWindow.fromWebContents(event.sender);
      if (window === null)
        throw new DesktopMainError(
          "desktop.window-unavailable",
          "The Desktop window is unavailable.",
        );
      if (request.action === "minimize") window.minimize();
      else if (request.action === "toggle-maximize") {
        if (window.isMaximized()) window.unmaximize();
        else window.maximize();
      } else window.close();
      return true;
    }),
  );
  ipcMain.handle(
    DesktopIpcChannels.gitDiff,
    handler(async (value) => {
      const request = DesktopGitDiffRequestV1Schema.parse(value);
      if (smokeMode)
        await new Promise((resolve) => setTimeout(resolve, request.path === undefined ? 20 : 250));
      if (fixtureMode)
        return {
          workspaceId: request.workspaceId,
          ...(request.path === undefined ? {} : { path: request.path }),
          content:
            request.path === undefined
              ? "diff --git a/Assets/UI/Hud.prefab b/Assets/UI/Hud.prefab\n+smoke change"
              : "+smoke change",
          truncated: false,
        };
      return readDiff(await workspaceFor(request.projectId, request.workspaceId), request.path);
    }),
  );
  ipcMain.handle(
    DesktopIpcChannels.ptyCreate,
    handler(async (value) => {
      const request = DesktopPtyCreateRequestV1Schema.parse(value);
      if (smokeMode && smokeTerminalRoot !== undefined) {
        const workspace = smokeWorkspaces.find(
          (item) =>
            item.projectId === request.projectId && item.workspaceId === request.workspaceId,
        );
        if (workspace === undefined || workspace.state !== "ready")
          throw new DesktopMainError("workspace.repair-required", "Workspace is unavailable.");
        return ptySessions.create(
          request.projectId,
          request.workspaceId,
          smokeTerminalRoot,
          request.columns,
          request.rows,
        );
      }
      if (fixtureMode)
        throw new DesktopMainError(
          "desktop.smoke-terminal-disabled",
          "PTY creation is disabled in visual capture mode.",
        );
      const workspace = await workspaceFor(request.projectId, request.workspaceId);
      if (!workspace.available || workspace.state !== "ready")
        throw new DesktopMainError(
          "workspace.repair-required",
          "Repair the Workspace before opening a shell.",
        );
      return ptySessions.create(
        request.projectId,
        workspace.workspaceId,
        workspace.workspacePath,
        request.columns,
        request.rows,
      );
    }),
  );
  ipcMain.handle(
    DesktopIpcChannels.ptyList,
    handler(() => ptySessions.list()),
  );
  ipcMain.handle(
    DesktopIpcChannels.ptySnapshot,
    handler((value) => {
      const request = DesktopPtySnapshotRequestV1Schema.parse(value);
      return ptySessions.snapshot(request.sessionId, request.afterCursor);
    }),
  );
  ipcMain.handle(
    DesktopIpcChannels.ptyWrite,
    handler((value) => {
      const request = DesktopPtyWriteRequestV1Schema.parse(value);
      return ptySessions.write(request.sessionId, request.data);
    }),
  );
  ipcMain.handle(
    DesktopIpcChannels.ptyResize,
    handler((value) => {
      const request = DesktopPtyResizeRequestV1Schema.parse(value);
      return ptySessions.resize(request.sessionId, request.columns, request.rows);
    }),
  );
  ipcMain.handle(
    DesktopIpcChannels.ptyClose,
    handler((value) => {
      const request = DesktopPtySessionRequestV1Schema.parse(value);
      return ptySessions.close(request.sessionId);
    }),
  );
};

const desktopPreloadPath = (): string =>
  fileURLToPath(new URL(/* @vite-ignore */ "../../preload/preload.cjs", import.meta.url));
const loadRenderer = async (window: BrowserWindow): Promise<void> => {
  const developmentUrl = process.env.HONEYBEE_DESKTOP_DEV_URL;
  if (
    developmentUrl !== undefined &&
    /^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?(?:\/|$)/u.test(developmentUrl)
  ) {
    await window.loadURL(developmentUrl);
    return;
  }
  await window.loadFile(
    fileURLToPath(new URL(/* @vite-ignore */ "../../renderer/index.html", import.meta.url)),
  );
};

const captureVisualFixture = async (window: BrowserWindow, directory: string): Promise<void> => {
  const target = path.resolve(directory);
  await mkdir(target, { recursive: true });
  const waitFor = async (selector: string): Promise<void> => {
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      if (
        await window.webContents.executeJavaScript(
          `Boolean(document.querySelector(${JSON.stringify(selector)}))`,
        )
      ) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Visual fixture timed out: ${selector}`);
  };
  const capture = async (name: string): Promise<void> => {
    await writeFile(
      path.join(target, `${name}.png`),
      (await window.webContents.capturePage()).toPNG(),
    );
  };
  const click = async (selector: string): Promise<void> => {
    await window.webContents.executeJavaScript(
      `document.querySelector(${JSON.stringify(selector)})?.click()`,
    );
  };
  await waitFor("[data-testid='workspace-workbench']");
  await click("[data-testid='new-workspace']");
  await waitFor("[data-testid='workspace-dialog']");
  await capture("02-create-dialog");
  await click("[data-testid='workspace-dialog'] header .icon-button");
  await waitFor("[data-testid='workspace-workbench']");
  await capture("01-workbench");
  await click(".breadcrumb-project");
  await waitFor("[data-testid='project-picker']");
  await capture("03-project-picker");
  await click("[data-testid='project-picker'] .project-row:last-child");
  await waitFor("[data-testid='project-setup']");
  await capture("04-project-setup");
  await click(".back-button");
  await waitFor("[data-testid='project-picker']");
  await click(".back-button");
  await waitFor("[data-testid='project-home']");
  await capture("05-project-home");
  await click(".locale-button");
  await capture("06-language-toggle");
};

const createWindow = async (): Promise<void> => {
  mainWindow = new BrowserWindow({
    width: captureMode ? captureWidth : 1280,
    height: captureMode ? captureHeight : 820,
    minWidth: 900,
    minHeight: 620,
    show: false,
    frame: false,
    autoHideMenuBar: true,
    backgroundColor: "#090c0e",
    icon: app.isPackaged
      ? path.join(process.resourcesPath, "honeybee.png")
      : path.join(app.getAppPath(), "resources", "brand", "honeybee.png"),
    webPreferences: {
      preload: desktopPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.on("close", (event) => {
    if (!confirmTerminalQuit()) event.preventDefault();
  });
  mainWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  if (!fixtureMode) mainWindow.once("ready-to-show", () => mainWindow?.show());
  await writeSmokeStage("window-created");
  await loadRenderer(mainWindow);
  await writeSmokeStage("renderer-loaded");
  if (captureMode && captureDirectory !== undefined) {
    try {
      await captureVisualFixture(mainWindow, captureDirectory);
      process.stdout.write(`HONEYBEE_DESKTOP_CAPTURE_OK ${captureDirectory}\n`);
      mainWindow.destroy();
      app.exit(0);
    } catch (error) {
      process.stderr.write(
        `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
      );
      mainWindow.destroy();
      app.exit(1);
    }
    return;
  }
  if (smokeMode) {
    try {
      const result = (await mainWindow.webContents.executeJavaScript(
        `new Promise((resolve, reject) => { const deadline = Date.now() + 8000; const inspect = async () => { try { if (window.honeybee && document.querySelector('.app-shell')) { const projects = await window.honeybee.projects(); resolve({ ready: true, projects: projects.length === 1 }); return; } if (Date.now() >= deadline) throw new Error('renderer timeout'); setTimeout(() => void inspect(), 50); } catch (error) { reject(error); } }; void inspect(); })`,
      )) as { ready?: boolean; projects?: boolean };
      if (result.ready !== true || result.projects !== true)
        throw new Error("invalid smoke result");
      try {
        await verifyWorkbench(mainWindow);
      } finally {
        ptySessions.closeAll();
        if (smokeTerminalRoot !== undefined)
          await rm(smokeTerminalRoot, {
            recursive: true,
            force: true,
            maxRetries: 10,
            retryDelay: 100,
          });
      }
      await writeSmokeStage("passed");
      process.stdout.write("HONEYBEE_DESKTOP_SMOKE_OK\n");
      mainWindow.destroy();
      app.exit(0);
    } catch (error) {
      await writeSmokeStage("failed");
      process.stderr.write(
        `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
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
  Menu.setApplicationMenu(null);
  if (smokeMode)
    smokeTerminalRoot = await mkdtemp(path.join(tmpdir(), "honeybee-desktop-terminal-"));
  registerIpc();
  await createWindow();
};
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    if (mainWindow?.isMinimized() === true) mainWindow.restore();
    mainWindow?.show();
    mainWindow?.focus();
  });
  void startDesktop().catch(async (error: unknown) => {
    await writeSmokeStage("failed").catch(() => undefined);
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    app.exit(1);
  });
}
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow();
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
const confirmTerminalQuit = (): boolean =>
  ptySessions.requestQuit((running) => {
    const korean = app.getLocale().startsWith("ko");
    const response = dialog.showMessageBoxSync({
      type: "question",
      title: "HoneyBee",
      message: korean
        ? `실행 중인 터미널 ${running.length}개를 종료하고 앱을 닫을까요?`
        : `Close the app and its ${running.length} running terminals?`,
      detail: running.map((session) => session.cwd).join("\n"),
      buttons: korean ? ["취소", "터미널 종료 후 앱 닫기"] : ["Cancel", "Close terminals and quit"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    return response === 1;
  });
app.on("before-quit", (event) => {
  if (!confirmTerminalQuit()) event.preventDefault();
});
