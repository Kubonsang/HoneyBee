import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

import {
  DesktopProjectCatalogV1Schema,
  type DesktopProjectCatalogEntryV1,
  type DesktopProjectCatalogV1,
  type DesktopProjectProfile,
} from "../shared/ipc.js";

const MAX_REGISTRY_BYTES = 2 * 1024 * 1024;
const MAX_CANDIDATES = 500;
const MAX_DEPTH = 5;
const UNITY_DIRECTORIES = ["Assets", "Packages", "ProjectSettings"] as const;

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const collectAbsolutePaths = (value: unknown, depth: number, candidates: Set<string>): void => {
  if (depth > MAX_DEPTH || candidates.size >= MAX_CANDIDATES) return;
  if (typeof value === "string") {
    if (path.isAbsolute(value)) candidates.add(path.resolve(value));
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectAbsolutePaths(item, depth + 1, candidates);
    return;
  }
  const object = record(value);
  if (object === undefined) return;
  for (const [key, nested] of Object.entries(object)) {
    if (path.isAbsolute(key)) candidates.add(path.resolve(key));
    collectAbsolutePaths(nested, depth + 1, candidates);
  }
};

const projectVersion = async (projectPath: string): Promise<string | undefined> => {
  try {
    const content = await readFile(
      path.join(projectPath, "ProjectSettings", "ProjectVersion.txt"),
      "utf8",
    );
    return /^m_EditorVersion:\s*(.+)$/mu.exec(content)?.[1]?.trim();
  } catch {
    return undefined;
  }
};

const isUnityProject = async (projectPath: string): Promise<boolean> => {
  try {
    const root = await lstat(projectPath);
    if (!root.isDirectory() || root.isSymbolicLink()) return false;
    for (const directory of UNITY_DIRECTORIES) {
      const entry = await lstat(path.join(projectPath, directory));
      if (!entry.isDirectory() || entry.isSymbolicLink()) return false;
    }
    return true;
  } catch {
    return false;
  }
};

const readUnityHubPaths = async (appDataPath: string): Promise<readonly string[]> => {
  const registryPath = path.join(appDataPath, "UnityHub", "projects-v1.json");
  try {
    const entry = await lstat(registryPath);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.size > MAX_REGISTRY_BYTES) return [];
    const parsed = JSON.parse(await readFile(registryPath, "utf8")) as unknown;
    const candidates = new Set<string>();
    collectAbsolutePaths(parsed, 0, candidates);
    const valid: string[] = [];
    for (const candidate of candidates) {
      if (await isUnityProject(candidate)) valid.push(candidate);
    }
    return valid;
  } catch {
    return [];
  }
};

const pathKey = (value: string): string =>
  process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);

export const readProjectCatalog = async (
  appDataPath: string,
  profiles: readonly DesktopProjectProfile[],
): Promise<DesktopProjectCatalogV1> => {
  const projects = new Map<string, DesktopProjectCatalogEntryV1>();
  for (const projectPath of await readUnityHubPaths(appDataPath)) {
    projects.set(pathKey(projectPath), {
      schemaVersion: 1,
      projectPath,
      label: path.basename(projectPath),
      source: "unity-hub",
      ...((await projectVersion(projectPath)) === undefined
        ? {}
        : { projectVersion: await projectVersion(projectPath) }),
    });
  }
  for (const profile of profiles) {
    projects.set(pathKey(profile.projectPath), {
      schemaVersion: 1,
      projectPath: profile.projectPath,
      label: profile.label,
      source: "managed",
      profileId: profile.profileId,
      lastOpenedAt: profile.lastOpenedAt,
      ...((await projectVersion(profile.projectPath)) === undefined
        ? {}
        : { projectVersion: await projectVersion(profile.projectPath) }),
    });
  }
  return DesktopProjectCatalogV1Schema.parse({
    schemaVersion: 1,
    observedAt: new Date().toISOString(),
    projects: [...projects.values()].sort((left, right) => {
      const recent = (right.lastOpenedAt ?? "").localeCompare(left.lastOpenedAt ?? "");
      return recent === 0 ? left.label.localeCompare(right.label) : recent;
    }),
  });
};
