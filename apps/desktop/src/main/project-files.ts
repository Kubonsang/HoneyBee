import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";

import {
  DesktopProjectFileV1Schema,
  DesktopProjectSearchV1Schema,
  DesktopProjectTreeV1Schema,
  type DesktopProjectFileV1,
  type DesktopProjectSearchV1,
  type DesktopProjectTreeEntryV1,
  type DesktopProjectTreeV1,
} from "../shared/ipc.js";

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_DIRECTORY_ENTRIES = 1_000;
const MAX_SEARCH_RESULTS = 200;
const MAX_SEARCH_VISITS = 20_000;
const MAX_SEARCH_DEPTH = 16;
const DENIED_DIRECTORIES = new Set([
  ".git",
  ".testplay",
  "library",
  "logs",
  "obj",
  "temp",
  "userSettings".toLowerCase(),
]);

const error = (code: string, message: string): Error => Object.assign(new Error(message), { code });

const normalizedRelativePath = (value: string): string => {
  if (path.isAbsolute(value) || /^[A-Za-z]:/u.test(value)) {
    throw error("desktop.project-path-invalid", "Absolute project paths are forbidden.");
  }
  const segments = value.split(/[\\/]/u).filter((segment) => segment.length > 0);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw error("desktop.project-path-invalid", "Project path traversal is forbidden.");
  }
  return segments.join("/");
};

const pathKey = (value: string): string =>
  process.platform === "win32" ? value.toLowerCase() : value;

const ensureInside = (root: string, target: string): void => {
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw error("desktop.project-path-invalid", "Project path escaped its profile root.");
  }
};

const scopedPath = async (
  projectPath: string,
  relativePath: string,
  expected: "file" | "directory",
): Promise<{ readonly root: string; readonly target: string; readonly relativePath: string }> => {
  const normalized = normalizedRelativePath(relativePath);
  const root = path.resolve(projectPath);
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw error("desktop.project-root-invalid", "The project root is not a regular directory.");
  }
  const target = path.resolve(root, ...normalized.split("/").filter(Boolean));
  ensureInside(root, target);
  let cursor = root;
  for (const segment of normalized.split("/").filter(Boolean)) {
    cursor = path.join(cursor, segment);
    const stat = await lstat(cursor);
    if (stat.isSymbolicLink()) {
      throw error("desktop.project-symlink-forbidden", "Project symlink traversal is forbidden.");
    }
  }
  const [resolvedRoot, resolvedTarget, targetStat] = await Promise.all([
    realpath(root),
    realpath(target),
    lstat(target),
  ]);
  ensureInside(pathKey(resolvedRoot), pathKey(resolvedTarget));
  if (
    (expected === "file" && !targetStat.isFile()) ||
    (expected === "directory" && !targetStat.isDirectory())
  ) {
    throw error(
      "desktop.project-entry-invalid",
      `The requested project ${expected} is unavailable.`,
    );
  }
  return { root, target, relativePath: normalized };
};

const isDeniedDirectory = (name: string): boolean => DENIED_DIRECTORIES.has(name.toLowerCase());

const entryFrom = async (
  root: string,
  parentRelativePath: string,
  name: string,
): Promise<DesktopProjectTreeEntryV1 | undefined> => {
  if (name.length > 255) return undefined;
  const relativePath = [parentRelativePath, name].filter(Boolean).join("/");
  const target = path.join(root, ...relativePath.split("/"));
  const stat = await lstat(target);
  if (stat.isSymbolicLink()) return undefined;
  if (stat.isDirectory()) {
    if (isDeniedDirectory(name)) return undefined;
    return { name, relativePath, kind: "directory" };
  }
  if (!stat.isFile()) return undefined;
  return { name, relativePath, kind: "file", byteLength: stat.size };
};

const languageFor = (filePath: string): string => {
  const extension = path.extname(filePath).toLowerCase();
  return (
    (
      {
        ".asmdef": "json",
        ".cs": "csharp",
        ".css": "css",
        ".html": "html",
        ".js": "javascript",
        ".json": "json",
        ".md": "markdown",
        ".shader": "hlsl",
        ".ts": "typescript",
        ".tsx": "typescriptreact",
        ".uxml": "xml",
        ".uss": "css",
        ".xml": "xml",
        ".yaml": "yaml",
        ".yml": "yaml",
      } as Readonly<Record<string, string>>
    )[extension] ?? "plaintext"
  );
};

export class DesktopProjectFiles {
  public async tree(projectPath: string, relativePath: string): Promise<DesktopProjectTreeV1> {
    const scope = await scopedPath(projectPath, relativePath, "directory");
    const names = await readdir(scope.target);
    const truncated = names.length > MAX_DIRECTORY_ENTRIES;
    const entries = (
      await Promise.all(
        names
          .sort((left, right) => left.localeCompare(right, undefined, { sensitivity: "base" }))
          .slice(0, MAX_DIRECTORY_ENTRIES)
          .map((name) => entryFrom(scope.root, scope.relativePath, name)),
      )
    )
      .filter((entry): entry is DesktopProjectTreeEntryV1 => entry !== undefined)
      .sort((left, right) => {
        if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
        return left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
      });
    return DesktopProjectTreeV1Schema.parse({
      schemaVersion: 1,
      relativePath: scope.relativePath,
      entries,
      truncated,
    });
  }

  public async read(projectPath: string, relativePath: string): Promise<DesktopProjectFileV1> {
    const scope = await scopedPath(projectPath, relativePath, "file");
    const handle = await open(scope.target, "r");
    try {
      const stat = await handle.stat();
      const requested = Math.min(stat.size, MAX_FILE_BYTES) + (stat.size > MAX_FILE_BYTES ? 0 : 1);
      const buffer = Buffer.alloc(requested);
      const { bytesRead } = await handle.read(buffer, 0, requested, 0);
      const contentBuffer = buffer.subarray(0, Math.min(bytesRead, MAX_FILE_BYTES));
      if (contentBuffer.includes(0)) {
        throw error("desktop.project-file-binary", "Binary project files cannot be opened here.");
      }
      return DesktopProjectFileV1Schema.parse({
        schemaVersion: 1,
        relativePath: scope.relativePath,
        encoding: "utf8",
        content: contentBuffer.toString("utf8"),
        byteLength: stat.size,
        truncated: stat.size > MAX_FILE_BYTES,
        language: languageFor(scope.relativePath),
      });
    } finally {
      await handle.close();
    }
  }

  public async search(
    projectPath: string,
    query: string,
    requestedMaxResults: number,
  ): Promise<DesktopProjectSearchV1> {
    const rootScope = await scopedPath(projectPath, "", "directory");
    const needle = query.toLocaleLowerCase();
    const limit = Math.min(requestedMaxResults, MAX_SEARCH_RESULTS);
    const matches: DesktopProjectTreeEntryV1[] = [];
    const queue: Array<{ relativePath: string; depth: number }> = [{ relativePath: "", depth: 0 }];
    let visits = 0;
    let truncated = false;
    while (queue.length > 0 && matches.length < limit && visits < MAX_SEARCH_VISITS) {
      const current = queue.shift();
      if (current === undefined) break;
      const names = await readdir(
        path.join(rootScope.root, ...current.relativePath.split("/").filter(Boolean)),
      );
      for (const name of names) {
        visits += 1;
        if (visits >= MAX_SEARCH_VISITS) {
          truncated = true;
          break;
        }
        const entry = await entryFrom(rootScope.root, current.relativePath, name);
        if (entry === undefined) continue;
        if (entry.relativePath.toLocaleLowerCase().includes(needle)) matches.push(entry);
        if (matches.length >= limit) {
          truncated = true;
          break;
        }
        if (entry.kind === "directory" && current.depth < MAX_SEARCH_DEPTH) {
          queue.push({ relativePath: entry.relativePath, depth: current.depth + 1 });
        }
      }
    }
    if (queue.length > 0) truncated = true;
    return DesktopProjectSearchV1Schema.parse({
      schemaVersion: 1,
      query,
      matches,
      truncated,
    });
  }
}
