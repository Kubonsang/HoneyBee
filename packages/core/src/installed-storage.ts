import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";

import { WorkspaceCoreError } from "./workspace-types.js";
import {
  validateStorageTools,
  type StorageToolResolutionOptions,
} from "./workspace-tool-resolution.js";

const readObject = async (target: string): Promise<Record<string, unknown>> => {
  const info = await lstat(target);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024)
    throw new Error("Invalid installation metadata file");
  const value: unknown = JSON.parse(await readFile(target, "utf8"));
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Invalid installation metadata");
  return value as Record<string, unknown>;
};

/** Discover from this process's version directory, never from a changing current.json. */
export const readInstalledStorage = async (
  releaseRoot: string,
): Promise<StorageToolResolutionOptions | undefined> => {
  if (path.basename(path.dirname(releaseRoot)).toLowerCase() !== "versions") return undefined;
  try {
    const root = path.resolve(releaseRoot);
    if ((await realpath(root)).toLowerCase() !== root.toLowerCase())
      throw new Error("Redirected release directory");
    const launch = await readObject(path.join(root, "launch.json"));
    const target = path.join(root, "installation.json");
    const metadata = await readObject(target);
    const digest = createHash("sha256")
      .update(await readFile(target))
      .digest("hex");
    if (
      launch.schemaVersion !== 1 ||
      launch.version !== path.basename(root) ||
      launch.installationSha256 !== digest ||
      metadata.schemaVersion !== 1 ||
      metadata.version !== path.basename(root)
    )
      throw new Error("Installation metadata identity mismatch");
    for (const key of ["componentVersion", "clientSha256", "controlSha256"] as const) {
      if (typeof metadata[key] !== "string") throw new Error(`Invalid ${key}`);
    }
    const clientCommand = path.join(root, "tools", "unity-workspace-storage.exe");
    const controlCommand = path.join(root, "tools", "honeybee-workspace-storage-host.exe");
    for (const command of [clientCommand, controlCommand]) {
      if ((await realpath(command)).toLowerCase() !== command.toLowerCase())
        throw new Error("Redirected storage tool");
    }
    const managed = {
      clientCommand,
      controlCommand,
      expectedComponentVersion: metadata.componentVersion as string,
      expectedClientSha256: metadata.clientSha256 as string,
      expectedControlSha256: metadata.controlSha256 as string,
    };
    await validateStorageTools({ ...managed, provenance: "managed" });
    return { installationRoot: path.dirname(path.dirname(root)), managed };
  } catch (cause) {
    throw new WorkspaceCoreError(
      "installation.invalid",
      "HoneyBee installation metadata or tools are invalid. The portable fallback was not used.",
      { cause },
    );
  }
};
