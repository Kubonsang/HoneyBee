import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { HoneyBeeWorkspaceCore, type WorkspaceViewV1 } from "@honeybee/core";
import { app, BrowserWindow, ipcMain, Menu } from "electron";

import {
  DesktopGitDiffRequestV1Schema,
  DesktopIpcChannels,
  DesktopProjectRequestV1Schema,
  DesktopPtyCreateRequestV1Schema,
  DesktopPtyResizeRequestV1Schema,
  DesktopPtySessionRequestV1Schema,
  DesktopPtySnapshotRequestV1Schema,
  DesktopPtyWriteRequestV1Schema,
  DesktopWorkspaceCreateRequestV1Schema,
  DesktopWorkspaceRequestV1Schema,
} from "../shared/ipc.js";
import { DesktopPtySessionManager } from "./pty-session-manager.js";

const execFileAsync = promisify(execFile);
const core = new HoneyBeeWorkspaceCore();
const ptySessions = new DesktopPtySessionManager();
const smokeMode = process.env.HONEYBEE_DESKTOP_SMOKE === "desktop-smoke-v1";
const smokeResultPath = process.env.HONEYBEE_DESKTOP_SMOKE_RESULT;
const MAX_DIFF_BYTES = 1024 * 1024;
let mainWindow: BrowserWindow | undefined;

if (smokeMode) app.disableHardwareAcceleration();

const writeSmokeStage = async (stage: string): Promise<void> => {
  if (smokeResultPath === undefined) return;
  const target = path.resolve(smokeResultPath);
  const relative = path.relative(path.resolve(tmpdir()), target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return;
  await writeFile(target, `${JSON.stringify({ stage })}\n`, "utf8");
};

const projectView = (project: Awaited<ReturnType<HoneyBeeWorkspaceCore["cacheStatus"]>>) => ({
  projectId: project.projectId,
  label: project.label,
  unityProjectPath: project.unityProjectPath,
  workspaceRoot: project.workspaceRoot,
  cacheState: project.cache === undefined ? ("missing" as const) : ("ready" as const),
});

const workspaceView = (workspace: WorkspaceViewV1) => ({
  workspaceId: workspace.workspaceId,
  projectId: workspace.projectId,
  name: workspace.name,
  workspacePath: workspace.workspacePath,
  state: workspace.state,
  available: workspace.available,
  branch: workspace.branch,
  baseCommit: workspace.baseCommit,
  git: workspace.git ?? null,
});

const workspaceFor = async (projectId: string, workspaceId: string): Promise<WorkspaceViewV1> => {
  const workspace = await core.workspaceStatus(workspaceId, projectId);
  if (workspace.projectId !== projectId) throw new Error("Workspace project identity mismatch.");
  return workspace;
};

const normalizedDiffPath = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined;
  const portable = value.replaceAll("\\", "/");
  const normalized = path.posix.normalize(portable);
  if (
    value.includes("\0") ||
    path.posix.isAbsolute(normalized) ||
    path.win32.isAbsolute(value) ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    throw new Error("Diff path must stay inside the Workspace.");
  }
  return normalized;
};

const readDiff = async (workspace: WorkspaceViewV1, requestedPath?: string) => {
  const relativePath = normalizedDiffPath(requestedPath);
  const safeDirectory = workspace.workspacePath.replaceAll("\\", "/");
  const args = [
    "-c",
    `safe.directory=${safeDirectory}`,
    "diff",
    "--no-ext-diff",
    "--unified=3",
    "HEAD",
    "--",
    ...(relativePath === undefined ? [] : [relativePath]),
  ];
  const { stdout } = await execFileAsync("git.exe", args, {
    cwd: workspace.workspacePath,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 2 * MAX_DIFF_BYTES,
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  const bytes = Buffer.from(stdout, "utf8");
  const truncated = bytes.byteLength > MAX_DIFF_BYTES;
  return {
    workspaceId: workspace.workspaceId,
    ...(relativePath === undefined ? {} : { path: relativePath }),
    content: truncated ? bytes.subarray(0, MAX_DIFF_BYTES).toString("utf8") : stdout,
    truncated,
  };
};

const safeHandler =
  <T>(handler: (value: unknown) => Promise<T> | T) =>
  async (_event: Electron.IpcMainInvokeEvent, value?: unknown): Promise<T> =>
    handler(value);

const registerIpc = (): void => {
  ipcMain.handle(
    DesktopIpcChannels.projects,
    safeHandler(async () =>
      [...(await core.listProjects())]
        .sort((left, right) => left.label.localeCompare(right.label))
        .map(projectView),
    ),
  );
  ipcMain.handle(
    DesktopIpcChannels.workspaces,
    safeHandler(async (value) => {
      const request = DesktopProjectRequestV1Schema.parse(value);
      return [...(await core.listWorkspaces(request.projectId))]
        .sort((left, right) => left.name.localeCompare(right.name))
        .map(workspaceView);
    }),
  );
  ipcMain.handle(
    DesktopIpcChannels.workspaceCreate,
    safeHandler(async (value) => {
      const request = DesktopWorkspaceCreateRequestV1Schema.parse(value);
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
    safeHandler(async (value) => {
      const request = DesktopWorkspaceRequestV1Schema.parse(value);
      return workspaceView(await core.repairWorkspace(request.workspaceId, request.projectId));
    }),
  );
  ipcMain.handle(
    DesktopIpcChannels.workspaceRemove,
    safeHandler(async (value) => {
      const request = DesktopWorkspaceRequestV1Schema.parse(value);
      await core.removeWorkspace(request.workspaceId, request.projectId);
      return true;
    }),
  );
  ipcMain.handle(
    DesktopIpcChannels.gitDiff,
    safeHandler(async (value) => {
      const request = DesktopGitDiffRequestV1Schema.parse(value);
      return readDiff(await workspaceFor(request.projectId, request.workspaceId), request.path);
    }),
  );
  ipcMain.handle(
    DesktopIpcChannels.ptyCreate,
    safeHandler(async (value) => {
      const request = DesktopPtyCreateRequestV1Schema.parse(value);
      const workspace = await workspaceFor(request.projectId, request.workspaceId);
      if (!workspace.available) throw new Error("Repair the Workspace before opening a shell.");
      return ptySessions.create(
        workspace.workspaceId,
        workspace.workspacePath,
        request.columns,
        request.rows,
      );
    }),
  );
  ipcMain.handle(
    DesktopIpcChannels.ptySnapshot,
    safeHandler((value) => {
      const request = DesktopPtySnapshotRequestV1Schema.parse(value);
      return ptySessions.snapshot(request.sessionId, request.afterCursor);
    }),
  );
  ipcMain.handle(
    DesktopIpcChannels.ptyWrite,
    safeHandler((value) => {
      const request = DesktopPtyWriteRequestV1Schema.parse(value);
      return ptySessions.write(request.sessionId, request.data);
    }),
  );
  ipcMain.handle(
    DesktopIpcChannels.ptyResize,
    safeHandler((value) => {
      const request = DesktopPtyResizeRequestV1Schema.parse(value);
      return ptySessions.resize(request.sessionId, request.columns, request.rows);
    }),
  );
  ipcMain.handle(
    DesktopIpcChannels.ptyClose,
    safeHandler((value) => {
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

const createWindow = async (): Promise<void> => {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 620,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: "#111715",
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
      const result = (await mainWindow.webContents.executeJavaScript(
        `new Promise((resolve, reject) => {
          const deadline = Date.now() + 5000;
          const inspect = async () => {
            try {
              if (window.honeybee && document.querySelector('.app-shell')) {
                const projects = await window.honeybee.projects();
                resolve({ ready: true, projects: Array.isArray(projects) });
                return;
              }
              if (Date.now() >= deadline) throw new Error('renderer timeout');
              setTimeout(() => void inspect(), 50);
            } catch (error) { reject(error); }
          };
          void inspect();
        })`,
      )) as { ready?: boolean; projects?: boolean };
      if (result.ready !== true || result.projects !== true)
        throw new Error("invalid smoke result");
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
  registerIpc();
  await createWindow();
};

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
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
app.on("before-quit", () => ptySessions.closeAll());
