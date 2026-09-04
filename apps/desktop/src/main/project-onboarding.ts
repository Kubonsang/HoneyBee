import { execFile } from "node:child_process";
import { access, lstat, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type { ProjectRecordV2 } from "@honeybee/core";

import {
  isSafeGitRemote,
  type DesktopCloneResultV1,
  type DesktopProjectCandidateV1,
  type DesktopProjectInspectionV1,
} from "../shared/ipc.js";
import { DesktopMainError } from "./desktop-errors.js";

const execFileAsync = promisify(execFile);

const exists = async (target: string): Promise<boolean> =>
  lstat(target)
    .then(() => true)
    .catch(() => false);
const directory = async (target: string): Promise<boolean> =>
  stat(target)
    .then((item) => item.isDirectory())
    .catch(() => false);
const key = (value: string): string => path.resolve(value).toLocaleLowerCase("en-US");

export const readUnityVersion = async (projectPath: string): Promise<string | null> => {
  const contents = await readFile(
    path.join(projectPath, "ProjectSettings", "ProjectVersion.txt"),
    "utf8",
  ).catch(() => undefined);
  return /^m_EditorVersion:\s*(\S+)\s*$/mu.exec(contents ?? "")?.[1] ?? null;
};

const unityLayout = async (projectPath: string): Promise<boolean> =>
  (
    await Promise.all(
      ["Assets", "Packages", "ProjectSettings"].map((entry) =>
        directory(path.join(projectPath, entry)),
      ),
    )
  ).every(Boolean);

interface UnityHubFile {
  readonly schema_version?: unknown;
  readonly data?: unknown;
}

export const readUnityHubProjects = async (
  hubFile: string,
): Promise<readonly { label: string; path: string; unityVersion: string | null }[]> => {
  const raw: unknown = JSON.parse(await readFile(hubFile, "utf8"));
  if (
    typeof raw !== "object" ||
    raw === null ||
    typeof (raw as UnityHubFile).data !== "object" ||
    (raw as UnityHubFile).data === null
  )
    return [];
  const results: { label: string; path: string; unityVersion: string | null }[] = [];
  for (const [candidatePath, candidate] of Object.entries(
    (raw as { data: Record<string, unknown> }).data,
  )) {
    if (typeof candidate !== "object" || candidate === null) continue;
    const item = candidate as Record<string, unknown>;
    const resolvedPath =
      typeof item.path === "string" && item.path.length > 0 ? item.path : candidatePath;
    if (!path.isAbsolute(resolvedPath)) continue;
    results.push({
      label:
        typeof item.title === "string" && item.title.length > 0
          ? item.title
          : path.basename(resolvedPath),
      path: path.resolve(resolvedPath),
      unityVersion:
        typeof item.version === "string" && item.version.length > 0 ? item.version : null,
    });
  }
  return results;
};

export const discoverProjectCandidates = async (
  registered: readonly ProjectRecordV2[],
  hubFile: string | undefined,
): Promise<readonly DesktopProjectCandidateV1[]> => {
  const merged = new Map<string, DesktopProjectCandidateV1>();
  for (const project of registered) {
    const available = await exists(project.unityProjectPath);
    const valid = available && (await unityLayout(project.unityProjectPath));
    merged.set(key(project.unityProjectPath), {
      source: "honeybee",
      label: project.label,
      path: project.unityProjectPath,
      unityVersion: await readUnityVersion(project.unityProjectPath),
      registeredProjectId: project.projectId,
      setupState: !available ? "unavailable" : valid ? "ready" : "invalid",
    });
  }
  const hubProjects =
    hubFile === undefined ? [] : await readUnityHubProjects(hubFile).catch(() => []);
  for (const project of hubProjects) {
    const identity = key(project.path);
    if (merged.has(identity)) continue;
    const available = await exists(project.path);
    merged.set(identity, {
      source: "unity-hub",
      label: project.label,
      path: project.path,
      unityVersion: project.unityVersion ?? (await readUnityVersion(project.path)),
      registeredProjectId: null,
      setupState: !available
        ? "unavailable"
        : (await unityLayout(project.path))
          ? "setup-required"
          : "invalid",
    });
  }
  return [...merged.values()].sort((left, right) => left.label.localeCompare(right.label));
};

const gitRoot = async (projectPath: string): Promise<string | null> => {
  try {
    const result = await execFileAsync("git.exe", ["rev-parse", "--show-toplevel"], {
      cwd: projectPath,
      encoding: "utf8",
      timeout: 15_000,
      windowsHide: true,
    });
    return path.resolve(result.stdout.trim());
  } catch {
    return null;
  }
};

export const inspectUnityProject = async (
  requestedPath: string,
  registered: readonly ProjectRecordV2[],
): Promise<DesktopProjectInspectionV1> => {
  const projectPath = path.resolve(requestedPath);
  const project = registered.find((item) => key(item.unityProjectPath) === key(projectPath));
  const layoutValid = await unityLayout(projectPath);
  const repositoryRoot = layoutValid ? await gitRoot(projectPath) : null;
  const libraryPresent = await directory(path.join(projectPath, "Library"));
  let libraryIgnored = false;
  if (repositoryRoot !== null && libraryPresent) {
    libraryIgnored = await execFileAsync(
      "git.exe",
      [
        "-c",
        `safe.directory=${repositoryRoot.replaceAll("\\", "/")}`,
        "check-ignore",
        "--quiet",
        "--",
        path.relative(repositoryRoot, path.join(projectPath, "Library")),
      ],
      {
        cwd: repositoryRoot,
        timeout: 15_000,
        windowsHide: true,
      },
    )
      .then(() => true)
      .catch(() => false);
  }
  const base = repositoryRoot ?? projectPath;
  const checks = [
    {
      code: "project.unity-layout",
      status: layoutValid ? ("pass" as const) : ("fail" as const),
      message: layoutValid
        ? "Assets, Packages, and ProjectSettings are present."
        : "This folder is not a valid Unity project.",
      remediation: layoutValid
        ? []
        : ["Choose a folder containing Assets, Packages, and ProjectSettings."],
    },
    {
      code: "project.git-repository",
      status: repositoryRoot === null ? ("fail" as const) : ("pass" as const),
      message:
        repositoryRoot === null
          ? "The Unity project is not inside a Git repository."
          : `Git repository: ${repositoryRoot}`,
      remediation:
        repositoryRoot === null
          ? ["Initialize or clone the project as a Git repository first."]
          : [],
    },
    {
      code: "cache.source-library",
      status: libraryPresent ? ("pass" as const) : ("warning" as const),
      message: libraryPresent
        ? "The source Library is present."
        : "Open the source project in Unity once to generate Library.",
      remediation: libraryPresent
        ? []
        : ["Open this source project in its exact Unity editor, close Unity, then check again."],
    },
    {
      code: "cache.library-ignored",
      status: libraryIgnored ? ("pass" as const) : ("warning" as const),
      message: libraryIgnored ? "Library is ignored by Git." : "Library is not ignored by Git.",
      remediation: libraryIgnored
        ? []
        : ["Add Library/ to the repository .gitignore, then check again."],
    },
  ];
  return {
    label: project?.label ?? path.basename(projectPath),
    path: projectPath,
    repositoryRoot,
    defaultWorkspaceRoot:
      project?.workspaceRoot ?? path.join(path.dirname(base), `${path.basename(base)}-workspaces`),
    unityVersion: await readUnityVersion(projectPath),
    registeredProjectId: project?.projectId ?? null,
    readyForSetup: layoutValid && repositoryRoot !== null && libraryPresent && libraryIgnored,
    checks,
  };
};

export type CloneExecutor = (
  command: string,
  args: readonly string[],
  options: Readonly<{ cwd: string; shell: false }>,
) => Promise<void>;

const defaultCloneExecutor: CloneExecutor = async (command, args, options) => {
  await execFileAsync(command, [...args], {
    ...options,
    encoding: "utf8",
    timeout: 30 * 60_000,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "1" },
  });
};

export const cloneUnityProject = async (
  url: string,
  destination: string,
  execute: CloneExecutor = defaultCloneExecutor,
): Promise<DesktopCloneResultV1> => {
  if (!isSafeGitRemote(url))
    throw new DesktopMainError(
      "project.clone-url-invalid",
      "Use an HTTPS or SSH Git URL without embedded credentials.",
      ["Use Git Credential Manager or SSH for authentication."],
    );
  if (!path.isAbsolute(destination))
    throw new DesktopMainError(
      "project.clone-destination-invalid",
      "Clone destination must be an absolute path.",
      ["Choose a destination with the folder picker."],
    );
  const target = path.resolve(destination);
  if (await exists(target))
    throw new DesktopMainError(
      "project.clone-destination-exists",
      `Clone destination already exists: ${target}`,
      ["Choose a new empty path. HoneyBee will not overwrite existing files."],
    );
  await access(path.dirname(target)).catch((cause: unknown) => {
    throw new DesktopMainError(
      "project.clone-destination-invalid",
      `Clone destination parent is not accessible: ${path.dirname(target)}`,
      [],
      { cause },
    );
  });
  try {
    await execute("git.exe", ["clone", "--", url, target], {
      cwd: path.dirname(target),
      shell: false,
    });
  } catch (cause) {
    throw new DesktopMainError(
      "git.clone-failed",
      "Git clone failed. Any partial files were preserved for inspection.",
      [
        "Review Git authentication and network access, then choose how to handle the partial destination.",
      ],
      { cause },
    );
  }
  return {
    path: target,
    label: path.basename(target),
    unityVersion: await readUnityVersion(target),
  };
};
