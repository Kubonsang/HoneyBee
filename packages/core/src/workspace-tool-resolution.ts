import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import {
  WorkspaceCoreError,
  type ResolvedStorageTools,
  type StorageCommand,
  type StorageToolSelection,
  type ProjectRecordV2,
} from "./workspace-types.js";

export interface StorageToolResolutionOptions {
  readonly managed?: StorageToolSelection;
  readonly explicit?: StorageToolSelection;
  readonly installationRoot?: string;
}

/** Path resolution only: Doctor must be able to report missing/damaged payloads. */
export const storageToolPair = (
  command: StorageCommand,
  controlOverride = process.env.HONEYBEE_WORKSPACE_STORAGE_CONTROL,
): ResolvedStorageTools =>
  typeof command === "string"
    ? Object.freeze({
        provenance: "legacy" as const,
        clientCommand: command,
        controlCommand:
          controlOverride === undefined
            ? path.join(path.dirname(path.resolve(command)), "honeybee-workspace-storage-host.exe")
            : path.resolve(controlOverride),
      })
    : command;

export class WorkspaceToolResolver {
  readonly #selection: ResolvedStorageTools | undefined;
  readonly #controlOverride: string | undefined;
  public readonly installationRoot: string | undefined;

  public constructor(options: StorageToolResolutionOptions = {}) {
    this.installationRoot = options.installationRoot;
    if (
      this.installationRoot !== undefined &&
      (!path.isAbsolute(this.installationRoot) || options.managed === undefined)
    ) {
      throw new WorkspaceCoreError(
        "storage.tools-invalid",
        "An installation requires an absolute root and managed tools.",
      );
    }
    const selected = options.managed ?? options.explicit;
    this.#selection =
      selected === undefined
        ? undefined
        : Object.freeze({
            ...selected,
            provenance: options.managed === undefined ? "explicit" : "managed",
          });
    const controlOverride = process.env.HONEYBEE_WORKSPACE_STORAGE_CONTROL;
    this.#controlOverride =
      controlOverride === undefined ? undefined : path.resolve(controlOverride);
  }

  public resolve(legacyCommand: string): ResolvedStorageTools;
  public resolve(legacyCommand?: string): ResolvedStorageTools | undefined;
  public resolve(legacyCommand?: string): ResolvedStorageTools | undefined {
    if (this.#selection !== undefined) return this.#selection;
    if (legacyCommand === undefined) return undefined;
    // Pass the captured value directly; do not consult a later environment change.
    return Object.freeze({
      provenance: "legacy",
      clientCommand: legacyCommand,
      controlCommand:
        this.#controlOverride ??
        path.join(path.dirname(path.resolve(legacyCommand)), "honeybee-workspace-storage-host.exe"),
    });
  }

  public resolveProject(project: ProjectRecordV2): ResolvedStorageTools {
    if (project.storageBinding !== undefined) {
      if (
        this.installationRoot === undefined ||
        path.resolve(project.storageBinding.installationRoot).toLowerCase() !==
          path.resolve(this.installationRoot).toLowerCase()
      ) {
        throw new WorkspaceCoreError(
          "storage.installation-mismatch",
          "This project belongs to another HoneyBee installation. Launch its stable entry point.",
        );
      }
      return this.resolve(project.storageCommand);
    }
    if (this.installationRoot === undefined) return this.resolve(project.storageCommand);
    return storageToolPair(
      project.storageCommand,
      this.#controlOverride ??
        path.join(
          path.dirname(path.resolve(project.storageCommand)),
          "honeybee-workspace-storage-host.exe",
        ),
    );
  }
}

/** Validate an opted-in selection before storage-dependent Core mutations. No fallback. */
export const validateStorageTools = async (tools: ResolvedStorageTools): Promise<void> => {
  if (tools.provenance === "legacy") return;
  if (
    tools.provenance === "managed" &&
    (!tools.expectedComponentVersion || !tools.expectedClientSha256 || !tools.expectedControlSha256)
  ) {
    throw new WorkspaceCoreError(
      "storage.tools-invalid",
      "Managed storage tools require an exact component version and both payload hashes.",
    );
  }
  for (const [command, expected, missingCode] of [
    [tools.clientCommand, tools.expectedClientSha256, "storage.command-not-found"],
    [tools.controlCommand, tools.expectedControlSha256, "storage.control-command-missing"],
  ] as const) {
    if (
      !path.isAbsolute(command) ||
      (expected !== undefined && !/^[0-9a-f]{64}$/u.test(expected))
    ) {
      throw new WorkspaceCoreError(
        "storage.tools-invalid",
        "Storage tool paths or hashes are invalid.",
      );
    }
    const info = await stat(command).catch(() => undefined);
    if (info?.isFile() !== true) {
      throw new WorkspaceCoreError(missingCode, `Storage executable is missing: ${command}`);
    }
    if (expected !== undefined) {
      const actual = createHash("sha256")
        .update(await readFile(command))
        .digest("hex");
      if (actual !== expected) {
        throw new WorkspaceCoreError(
          "storage.package-integrity",
          `Storage executable does not match its selected payload: ${command}`,
        );
      }
    }
  }
};
