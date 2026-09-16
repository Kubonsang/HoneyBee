import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { mkdirSync, lstatSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { discoverRelease } from "../../../../scripts/update/release-discovery.mjs";
import { stageAuthenticatedRelease } from "../../../../scripts/update/authenticated-release.mjs";
import { DesktopUpdateCheck } from "./update-check.js";
import { readUpdateOutcome } from "../../../../scripts/update/update-outcome.mjs";
import {
  dispatchPreparation,
  dispatchActivation,
} from "../../../../scripts/update/dispatch-preparation.mjs";
import updateTrust from "../../resources/update-trust-v1.json" with { type: "json" };
import { setTimeout as delay } from "node:timers/promises";

import {
  HoneyBeeWorkspaceCore,
  readInstalledStorage,
  acquireInstalledActivity,
  type InstalledActivityLease,
  type ProjectRecordV2,
  type WorkspaceViewV1,
} from "@honeybee/core";
import { app, BrowserWindow, dialog, ipcMain, Menu } from "electron";

import {
  DesktopBaseRefsRequestV1Schema,
  DesktopBaseHistoryRequestV1Schema,
  DesktopBaseResolveRequestV1Schema,
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
import { verifyWorkspaceFeedback } from "./workspace-feedback-smoke.js";
import { verifyWorkbench } from "./workbench-smoke.js";
import { verifyWorkspaceBasePicker } from "./workspace-base-smoke.js";
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
import { DesktopActivityDrain } from "./activity-drain.js";
import { openDesktopUpdateSession } from "./update-session.js";
import { DesktopUpdateShutdown } from "./update-shutdown.js";

const validationArguments = process.argv.filter((value) =>
  value.startsWith("--honeybee-update-validation="),
);
assert(validationArguments.length <= 1, "Duplicate update validation request");
const updateValidationId = validationArguments[0]?.slice("--honeybee-update-validation=".length);
if (updateValidationId !== undefined) {
  assert(/^[a-f0-9]{64}$/u.test(updateValidationId), "Invalid update validation identity");
  // A candidate must not read/write the ordinary Desktop profile while being
  // evaluated. This is a restricted launch mode, not update authorization.
  // Replayed dispatches share Electron's single-instance lock, even before the
  // first process has published its update session descriptor.
  const profileIdentity = createHash("sha256")
    .update(JSON.stringify([process.execPath.toLowerCase(), updateValidationId]))
    .digest("hex");
  const profile = path.join(tmpdir(), `honeybee-update-validation-${profileIdentity}`);
  mkdirSync(profile, { recursive: true });
  assert(lstatSync(profile).isDirectory() && !lstatSync(profile).isSymbolicLink());
  assert.equal(realpathSync(profile).toLowerCase(), path.resolve(profile).toLowerCase());
  app.setPath("userData", profile);
}
let validationRendererReady = false;

let installedStorageCommand: string | undefined;
let core = new HoneyBeeWorkspaceCore({
  usageCommand: app.isPackaged
    ? path.join(process.resourcesPath, "win32-x64", "honeybee-usage.exe")
    : path.join(app.getAppPath(), ".tools", "win32-x64", "honeybee-usage.exe"),
});
const ptySessions = new DesktopPtySessionManager();
let activityLease: InstalledActivityLease | undefined;
let updateSession: Awaited<ReturnType<typeof openDesktopUpdateSession>> | undefined;
const activityDrain = new DesktopActivityDrain(() =>
  setImmediate(() => {
    if (!activityDrain.isClosing) return;
    if (updateShutdown.pending) updateShutdown.drained();
    else app.quit();
  }),
);
const updateShutdown = new DesktopUpdateShutdown(activityDrain, () => confirmTerminalQuit());
const activityHandle: typeof ipcMain.handle = (channel, listener) => {
  ipcMain.handle(channel, async (event, ...args: unknown[]) => {
    if (updateValidationId !== undefined)
      return {
        ok: false as const,
        error: {
          code: "update.validation-mode",
          message: "HoneyBee is validating an update.",
          remediation: [],
        },
      };
    activityLease?.assertHeld();
    return activityDrain.run(() => listener(event, ...args));
  });
};
const smokeMode = process.env.HONEYBEE_DESKTOP_SMOKE === "desktop-smoke-v2";
const sessionSmokeMode = smokeMode && process.env.HONEYBEE_DESKTOP_SESSION_SMOKE === "session-v1";
const lifecycleSmokeMode =
  smokeMode && process.env.HONEYBEE_DESKTOP_LIFECYCLE_SMOKE === "lifecycle-v1";
let lifecycleConsent = false;
let lifecyclePrompts = 0;
const captureDirectory = process.env.HONEYBEE_DESKTOP_CAPTURE_DIR;
const captureMode = captureDirectory !== undefined;
const fixtureMode = smokeMode || captureMode;
const captureWidth = Number(process.env.HONEYBEE_DESKTOP_CAPTURE_WIDTH ?? 1280);
const captureHeight = Number(process.env.HONEYBEE_DESKTOP_CAPTURE_HEIGHT ?? 820);
const smokeResultPath = process.env.HONEYBEE_DESKTOP_SMOKE_RESULT;
let mainWindow: BrowserWindow | undefined;
let smokeTerminalRoot: string | undefined;
let smokeRefreshFailure = false;
let smokeLaunchFailure = false;
let smokeBaseRefsFailure = true;

const smokeProject: DesktopProjectV2 = {
  projectId: "smoke-project",
  label: "GKF_",
  unityProjectPath: "C:\\Unity\\GKF_",
  unityRelativePath: "",
  workspaceRoot: "D:\\HoneyBee\\GKF_",
  cacheState: "ready",
  unityVersion: "6000.0.42f1",
};
const smokeBaseCommits = [
  {
    commit: "a".repeat(40),
    subject: "Update combat balance",
    author: "Alex",
    authoredAt: "2026-09-09T10:00:00+09:00",
  },
  {
    commit: "b".repeat(40),
    subject: "전투 씬 추가",
    author: "민수",
    authoredAt: "2026-09-08T10:00:00+09:00",
  },
];
const pendingBaseQueries = new Map<string, Promise<unknown>>();
const shareBaseQuery = <T>(key: string, query: () => Promise<T>): Promise<T> => {
  const pending = pendingBaseQueries.get(key);
  if (pending !== undefined) return pending as Promise<T>;
  const result = query().finally(() => pendingBaseQueries.delete(key));
  pendingBaseQueries.set(key, result);
  return result;
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
      changes: [
        " M Assets/UI/Hud.prefab",
        "?? Assets/UI/Hud.prefab.meta",
        " M ProjectSettings/ShaderGraphSettings.asset",
      ],
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
  installedStorageCommand ??
  (app.isPackaged
    ? path.join(process.resourcesPath, "win32-x64", "unity-workspace-storage.exe")
    : path.join(app.getAppPath(), ".tools", "win32-x64", "unity-workspace-storage.exe"));
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

const updateCheck = new DesktopUpdateCheck({
  restore: async () =>
    app.isPackaged && !fixtureMode
      ? readUpdateOutcome(path.resolve(process.resourcesPath, "../../../.."))
      : undefined,
  trustedPublicKeys: updateTrust.schemaVersion === 1 ? updateTrust.publicKeys : [],
  source: async () => {
    if (!app.isPackaged || fixtureMode) return undefined;
    const releaseRoot = path.resolve(process.resourcesPath, "../..");
    const storage = await readInstalledStorage(releaseRoot);
    const component = storage?.managed?.expectedComponentVersion;
    if (component === undefined) return undefined;
    assert(updateTrust.channel === "beta" || updateTrust.channel === "stable");
    return {
      currentVersion: path.basename(releaseRoot),
      bootstrapperVersion: updateTrust.bootstrapperVersion,
      channel: updateTrust.channel,
      storageComponentVersion: component,
    };
  },
  discover: discoverRelease,
  stage: stageAuthenticatedRelease,
  prepare: dispatchPreparation,
  apply: async (preparation) => {
    assert(updateSession, "Managed Desktop update session required");
    return dispatchActivation({
      installationRoot: path.resolve(process.resourcesPath, "../../../.."),
      preparation,
      desktopDescriptor: updateSession.descriptor,
    });
  },
  installationRoot: () => path.resolve(process.resourcesPath, "../../../.."),
  recordError: (error) =>
    process.stderr.write(
      `Update check failed: ${error instanceof Error ? error.message : "unknown error"}\n`,
    ),
});
const registerIpc = (): void => {
  for (const [channel, action] of [
    [DesktopIpcChannels.updateStatus, () => updateCheck.refresh()],
    [DesktopIpcChannels.updateCheck, () => updateCheck.check()],
    [DesktopIpcChannels.updateCancel, () => updateCheck.cancel()],
    [DesktopIpcChannels.updateDownload, () => updateCheck.download()],
    [DesktopIpcChannels.updateApply, () => updateCheck.apply()],
  ] as const) {
    activityHandle(
      channel,
      handler((value, event) => {
        const window = mainWindow;
        assert(window !== undefined && event.sender === window.webContents);
        assert(
          event.senderFrame === window.webContents.mainFrame,
          "Update request must originate in the main frame",
        );
        assert(value === undefined, "Update requests accept no external configuration");
        return action();
      }),
    );
  }
  activityHandle(
    DesktopIpcChannels.projects,
    handler(async () => {
      if (fixtureMode)
        return smokeMode
          ? [smokeProject, { ...smokeProject, projectId: "smoke-other", label: "Other project" }]
          : [smokeProject];
      return Promise.all(
        [...(await core.listProjects())]
          .sort((a, b) => a.label.localeCompare(b.label))
          .map(projectView),
      );
    }),
  );
  activityHandle(
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
          ...(smokeMode
            ? [
                {
                  source: "honeybee" as const,
                  label: "Other project",
                  path: "C:\\Unity\\Other",
                  unityVersion: smokeProject.unityVersion,
                  registeredProjectId: "smoke-other",
                  setupState: "ready" as const,
                },
              ]
            : []),
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
  activityHandle(
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
  activityHandle(
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
  activityHandle(
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
  activityHandle(
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
  activityHandle(
    DesktopIpcChannels.cachePrepare,
    handler(async (value) => {
      const request = DesktopProjectRequestV1Schema.parse(value);
      if (fixtureMode) return smokeProject;
      return projectView(await core.prepareCache(request.projectId));
    }),
  );
  activityHandle(
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
  activityHandle(
    DesktopIpcChannels.workspaces,
    handler(async (value) => {
      const request = DesktopProjectRequestV1Schema.parse(value);
      if (smokeMode && smokeRefreshFailure)
        throw new DesktopMainError("desktop.status-test-failed", "Simulated status read failure.");
      if (fixtureMode)
        return smokeWorkspaces.filter((item) => item.projectId === request.projectId);
      return [...(await core.listWorkspaces(request.projectId))]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(workspaceView);
    }),
  );
  activityHandle(
    DesktopIpcChannels.workspaceUsage,
    handler(async (value) => {
      const request = DesktopWorkspaceRequestV1Schema.parse(value);
      if (fixtureMode)
        return {
          schemaVersion: 1 as const,
          measuredAt: new Date().toISOString(),
          knownAllocatedBytes: 1_200_000_000,
          complete: false,
          entries: [
            {
              id: "files",
              kind: "files",
              scope: "workspace",
              workspaceId: request.workspaceId,
              logicalBytes: 20_000_000,
              allocatedBytes: 21_000_000,
              fileCount: 352,
              omittedLinks: 0,
              complete: true,
              errors: [],
            },
            {
              id: "child",
              kind: "child-vhdx",
              scope: "workspace",
              workspaceId: request.workspaceId,
              logicalBytes: null,
              allocatedBytes: null,
              fileCount: 0,
              omittedLinks: 0,
              complete: false,
              errors: ["Fixture: unavailable storage identity"],
            },
            {
              id: "shared",
              kind: "testplay-shared",
              scope: "shared",
              logicalBytes: 1_170_000_000,
              allocatedBytes: 1_179_000_000,
              fileCount: 100,
              omittedLinks: 0,
              complete: true,
              errors: [],
            },
          ],
        };
      return core.workspaceUsage(request.workspaceId, request.projectId);
    }),
  );
  activityHandle(
    DesktopIpcChannels.workspaceBaseRefs,
    handler(async (value) => {
      const request = DesktopBaseRefsRequestV1Schema.parse(value);
      if (smokeMode && smokeBaseRefsFailure) {
        smokeBaseRefsFailure = false;
        throw new DesktopMainError(
          "git.base-query-failed",
          "Simulated first reference query failure.",
        );
      }
      if (fixtureMode)
        return {
          head: smokeBaseCommits[0],
          currentBranch: "main",
          refs: [
            { reference: "refs/heads/main", label: "main", kind: "branch" },
            { reference: "refs/heads/history-smoke", label: "history-smoke", kind: "branch" },
          ],
          nextOffset: null,
        };
      return shareBaseQuery(`refs:${JSON.stringify(request)}`, () =>
        core.workspaceBaseRefs(request.projectId, request.offset),
      );
    }),
  );
  activityHandle(
    DesktopIpcChannels.workspaceBaseHistory,
    handler(async (value) => {
      const request = DesktopBaseHistoryRequestV1Schema.parse(value);
      if (fixtureMode && request.reference === "refs/heads/history-smoke") {
        await new Promise((resolve) => setTimeout(resolve, 350));
        return {
          tip: smokeBaseCommits[1]?.commit,
          commits: [smokeBaseCommits[1]],
          nextOffset: null,
        };
      }
      if (fixtureMode)
        return {
          tip: smokeBaseCommits[0]?.commit,
          commits: request.offset === 0 ? smokeBaseCommits : [],
          nextOffset: null,
        };
      return shareBaseQuery(`history:${JSON.stringify(request)}`, () =>
        core.workspaceBaseHistory(request.projectId, request.reference, request.offset),
      );
    }),
  );
  activityHandle(
    DesktopIpcChannels.workspaceBaseResolve,
    handler(async (value) => {
      const request = DesktopBaseResolveRequestV1Schema.parse(value);
      if (fixtureMode) {
        const commit = smokeBaseCommits.find((item) => item.commit === request.reference);
        if (commit === undefined)
          throw new DesktopMainError("git.invalid-base", "Choose a valid branch, tag, or commit.");
        return commit;
      }
      return shareBaseQuery(`resolve:${JSON.stringify(request)}`, () =>
        core.resolveWorkspaceBase(request.projectId, request.reference),
      );
    }),
  );
  activityHandle(
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
          git: {
            branch: request.branch,
            head: request.base ?? "a1b2c3d4",
            dirty: false,
            changes: [],
          },
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
  activityHandle(
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
  activityHandle(
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
  activityHandle(
    DesktopIpcChannels.externalLaunch,
    handler(async (value) => {
      const request = DesktopExternalLaunchRequestV1Schema.parse(value);
      if (smokeMode && smokeLaunchFailure) {
        await new Promise((resolve) => setTimeout(resolve, 300));
        throw new DesktopMainError("workspace.in-use", "Simulated late tool failure.");
      }
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
  activityHandle(
    DesktopIpcChannels.projectUnityLaunch,
    handler(async (value) => {
      const request = DesktopProjectUnityLaunchRequestV1Schema.parse(value);
      if (fixtureMode) return true;
      await launchExternalTool(await resolveExternalTool("unity", request.path), request.path);
      return true;
    }),
  );
  activityHandle(
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
  activityHandle(
    DesktopIpcChannels.gitDiff,
    handler(async (value) => {
      const request = DesktopGitDiffRequestV1Schema.parse(value);
      if (smokeMode)
        await new Promise((resolve) => setTimeout(resolve, request.path === undefined ? 20 : 250));
      if (fixtureMode)
        return {
          workspaceId: request.workspaceId,
          ...(request.path === undefined ? {} : { path: request.path }),
          content: request.path?.endsWith(".meta")
            ? "fileFormatVersion: 2\nguid: smoke-preview\n"
            : smokeMode && request.path?.startsWith("ProjectSettings/")
              ? "diff --git a/ProjectSettings/ShaderGraphSettings.asset b/ProjectSettings/ShaderGraphSettings.asset\n@@ -0,0 +1,800 @@\n" +
                Array.from({ length: 800 }, (_, index) => `+setting_${index}: true\n`).join("")
              : request.workspaceId === "smoke-combat"
                ? ""
                : "diff --git a/Assets/UI/Hud.prefab b/Assets/UI/Hud.prefab\n--- a/Assets/UI/Hud.prefab\n+++ b/Assets/UI/Hud.prefab\n@@ -1,2 +1,3 @@\n Hud:\n-  scale: 1\n+  scale: 2\n+  visible: true\n",
          kind: request.path?.endsWith(".meta") ? "untracked" : "patch",
          truncated: false,
        };
      return readDiff(await workspaceFor(request.projectId, request.workspaceId), request.path);
    }),
  );
  activityHandle(
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
  activityHandle(
    DesktopIpcChannels.ptyList,
    handler(() => ptySessions.list()),
  );
  activityHandle(
    DesktopIpcChannels.ptySnapshot,
    handler((value) => {
      const request = DesktopPtySnapshotRequestV1Schema.parse(value);
      return ptySessions.snapshot(request.sessionId, request.afterCursor);
    }),
  );
  activityHandle(
    DesktopIpcChannels.ptyWrite,
    handler((value) => {
      const request = DesktopPtyWriteRequestV1Schema.parse(value);
      return ptySessions.write(request.sessionId, request.data);
    }),
  );
  activityHandle(
    DesktopIpcChannels.ptyResize,
    handler((value) => {
      const request = DesktopPtyResizeRequestV1Schema.parse(value);
      return ptySessions.resize(request.sessionId, request.columns, request.rows);
    }),
  );
  activityHandle(
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
    await window.webContents.executeJavaScript(
      "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))",
    );
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
  await waitFor("[data-testid='base-summary']");
  await capture("02-create-dialog");
  await click("[data-testid='workspace-dialog'] header .icon-button");
  await waitFor("[data-testid='workspace-workbench']");
  await capture("01-workbench");
  await click(".workspace-row:nth-child(2)");
  await waitFor(".diff-line.added");
  await capture("07-changes-review");
  await click("[data-testid='usage-tab']");
  await click(".usage-toolbar button");
  await waitFor(".usage-panel tbody tr");
  await capture("08-storage-usage");
  await click(".workspace-row:first-child");
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
  await window.webContents.executeJavaScript(
    "document.querySelector('.update-check > button').click()",
  );
  await waitFor(".update-check-panel");
  assert.equal(
    await window.webContents.executeJavaScript(
      "window.honeybee.updateStatus().then(value => value.state)",
    ),
    "Unavailable",
  );
  await capture("09-update-check");
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
      backgroundThrottling: !fixtureMode,
      preload: desktopPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.on("close", (event) => {
    if (!requestDesktopQuit()) event.preventDefault();
  });
  mainWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  if (!fixtureMode && updateValidationId === undefined)
    mainWindow.once("ready-to-show", () => mainWindow?.show());
  await writeSmokeStage("window-created");
  await loadRenderer(mainWindow);
  if (updateValidationId !== undefined) {
    validationRendererReady =
      (await mainWindow.webContents.executeJavaScript(
        `new Promise((resolve) => { const deadline = Date.now() + 15000; const inspect = () => { if (document.querySelector('.app-shell')) return resolve(true); if (Date.now() >= deadline) return resolve(false); setTimeout(inspect, 50); }; inspect(); })`,
      )) === true;
    assert(validationRendererReady, "Candidate renderer did not initialize");
    return;
  }
  await writeSmokeStage("renderer-loaded");
  if (sessionSmokeMode) return;
  if (lifecycleSmokeMode) {
    assert(activityLease, "Lifecycle qualification requires managed activity participation");
    assert(smokeTerminalRoot);
    ptySessions.create("lifecycle", "test-only", smokeTerminalRoot, 80, 24, true);
    let finish: () => void = () => {};
    const pending = activityDrain.run(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    mainWindow.close();
    assert(!mainWindow.isDestroyed());
    assert.equal(lifecyclePrompts, 0, "Terminal consent preceded work drain");
    await assert.rejects(
      activityDrain.run(() => undefined),
      /closing/u,
    );
    finish();
    await pending;
    const deadline = Date.now() + 10000;
    while (lifecyclePrompts === 0 && Date.now() < deadline) await delay(25);
    assert.equal(lifecyclePrompts, 1);
    assert(!mainWindow.isDestroyed());
    assert.equal(ptySessions.list().filter((session) => session.state === "running").length, 1);
    activityLease.assertHeld();
    await activityDrain.run(() => undefined);
    await writeSmokeStage("lifecycle-cancelled");
    assert(smokeResultPath);
    const continuePath = `${smokeResultPath}.continue`;
    const continuationDeadline = Date.now() + 60000;
    let continued = false;
    while (Date.now() < continuationDeadline) {
      try {
        await access(continuePath);
        continued = true;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await delay(50);
    }
    assert(continued, "Lifecycle controller did not acknowledge cancellation check");
    lifecycleConsent = true;
    await writeSmokeStage("lifecycle-passed");
    app.quit();
    return;
  }
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
        `new Promise((resolve, reject) => { const deadline = Date.now() + 8000; const inspect = async () => { try { if (window.honeybee && document.querySelector('.app-shell')) { const projects = await window.honeybee.projects(); resolve({ ready: true, projects: projects.length === 2 }); return; } if (Date.now() >= deadline) throw new Error('renderer timeout'); setTimeout(() => void inspect(), 50); } catch (error) { reject(error); } }; void inspect(); })`,
      )) as { ready?: boolean; projects?: boolean };
      if (result.ready !== true || result.projects !== true)
        throw new Error("invalid smoke result");
      try {
        await verifyWorkspaceBasePicker(mainWindow);
        await verifyWorkbench(mainWindow);
        const original = structuredClone(smokeWorkspaces);
        await verifyWorkspaceFeedback(mainWindow, (scenario) => {
          smokeRefreshFailure = scenario === "refresh-failed";
          smokeLaunchFailure = scenario === "late-error";
          smokeWorkspaces = structuredClone(original).map((workspace) => {
            if (workspace.workspaceId !== "smoke-combat") return workspace;
            if (scenario === "unknown") return { ...workspace, git: null };
            if (scenario === "cleanup")
              return { ...workspace, git: null, state: "cleanup-pending", available: false };
            if (scenario === "repair")
              return { ...workspace, state: "repair-required", available: false };
            return workspace;
          });
        });
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
  assert(
    updateValidationId === undefined || (app.isPackaged && !fixtureMode),
    "Validation requires a managed production Desktop",
  );
  await writeSmokeStage("module-loaded");
  if (app.isPackaged)
    activityLease = await acquireInstalledActivity(
      path.resolve(process.resourcesPath, "../.."),
      updateValidationId,
    );
  const storageTools = app.isPackaged
    ? await readInstalledStorage(path.resolve(process.resourcesPath, "../.."))
    : undefined;
  if (storageTools !== undefined) {
    installedStorageCommand = storageTools.managed?.clientCommand;
    core = new HoneyBeeWorkspaceCore({
      storageTools,
      usageCommand: path.join(process.resourcesPath, "win32-x64", "honeybee-usage.exe"),
    });
  }
  await app.whenReady();
  await writeSmokeStage("app-ready");
  Menu.setApplicationMenu(null);
  if (smokeMode)
    smokeTerminalRoot = await mkdtemp(path.join(tmpdir(), "honeybee-desktop-terminal-"));
  registerIpc();
  await createWindow();
  if (activityLease !== undefined && (!fixtureMode || sessionSmokeMode)) {
    const releaseRoot = path.resolve(process.resourcesPath, "../..");
    updateSession = await openDesktopUpdateSession({
      root: path.resolve(releaseRoot, "../.."),
      version: path.basename(releaseRoot),
      ...(updateValidationId === undefined ? {} : { validationId: updateValidationId }),
      isReady: () =>
        activityLease !== undefined &&
        !activityLease.signal.aborted &&
        mainWindow !== undefined &&
        !mainWindow.isDestroyed() &&
        !mainWindow.webContents.isLoading() &&
        (updateValidationId === undefined || validationRendererReady),
      shutdown: (signal) => updateShutdown.request(signal),
      quit: () => app.quit(),
    });
  }
};
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    if (updateValidationId !== undefined) return;
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
    if (lifecycleSmokeMode) {
      lifecyclePrompts++;
      return lifecycleConsent;
    }
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
const requestDesktopQuit = (): boolean => {
  if (!activityDrain.requestQuit()) {
    return false;
  }
  if (!confirmTerminalQuit()) {
    activityDrain.cancelQuit();
    return false;
  }
  return true;
};
app.on("before-quit", (event) => {
  if (!requestDesktopQuit()) event.preventDefault();
});
// Release only after quit is accepted; cancellation retains shared ownership.
app.on("will-quit", () => {
  updateCheck.dispose();
  void updateSession?.close();
  void activityLease?.release();
});
