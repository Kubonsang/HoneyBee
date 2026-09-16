import { createHash } from "node:crypto";

import {
  storageToolPair,
  validateStorageTools,
  type WorkspaceToolResolver,
} from "./workspace-tool-resolution.js";
import {
  WorkspaceCoreError,
  type ProjectRecordV2,
  type ResolvedStorageTools,
  type WorkspaceStoragePort,
} from "./workspace-types.js";

export interface StorageAdoptionPlan {
  readonly projectId: string;
  readonly projectDigest: string;
  readonly installationRoot: string;
  readonly status: "ready" | "already-adopted" | "blocked";
  readonly reason?: string;
}

export const inspectCompatibleStorage = async (
  storage: WorkspaceStoragePort,
  tools: ResolvedStorageTools,
) => {
  const state = await storage.diagnose?.(tools);
  if (
    state === undefined ||
    !state.serviceExists ||
    state.serviceState !== "running" ||
    !state.receiptExists ||
    !state.receiptValid ||
    !state.executableExists ||
    !state.executableDigestMatches ||
    !state.userMatches ||
    !state.workspaceRootAccessible ||
    state.componentVersion !== tools.expectedComponentVersion
  ) {
    throw new WorkspaceCoreError(
      "storage.installation-not-ready",
      "The installed service does not match this HoneyBee installation. Run Doctor before adopting or using managed tools.",
    );
  }
  const status = await storage.status?.(tools);
  if (
    status === undefined ||
    !Number.isSafeInteger(status.parentCount) ||
    status.parentCount < 0 ||
    status.manualRecoveryRequired !== false
  ) {
    throw new WorkspaceCoreError(
      "storage.installation-not-ready",
      "Workspace storage is unavailable or requires recovery. Run Doctor before adopting or using managed tools.",
    );
  }
  return { diagnostic: state, status };
};

export const requireCompatibleStorage = async (
  storage: WorkspaceStoragePort,
  tools: ResolvedStorageTools,
): Promise<void> => {
  await inspectCompatibleStorage(storage, tools);
};

export const planStorageAdoption = async (
  project: ProjectRecordV2,
  resolver: WorkspaceToolResolver,
  storage: WorkspaceStoragePort,
): Promise<StorageAdoptionPlan> => {
  const tools = resolver.resolve();
  if (resolver.installationRoot === undefined || tools?.provenance !== "managed") {
    throw new WorkspaceCoreError(
      "installation.required",
      "Run this command from an assembled HoneyBee installation.",
    );
  }
  const base = {
    projectId: project.projectId,
    projectDigest: createHash("sha256").update(JSON.stringify(project)).digest("hex"),
    installationRoot: resolver.installationRoot,
  };
  try {
    await validateStorageTools(tools);
    await requireCompatibleStorage(storage, tools);
    if (project.storageBinding !== undefined) {
      resolver.resolveProject(project);
      return { ...base, status: "already-adopted" };
    }
    const legacy = storageToolPair(project.storageCommand);
    await validateStorageTools({
      ...tools,
      clientCommand: legacy.clientCommand,
      controlCommand: legacy.controlCommand,
    });
    return { ...base, status: "ready" };
  } catch (error) {
    return {
      ...base,
      status: "blocked",
      reason: error instanceof Error ? error.message : "Storage adoption could not be verified.",
    };
  }
};
