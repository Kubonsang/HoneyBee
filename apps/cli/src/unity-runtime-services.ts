import path from "node:path";

import {
  FileArtifactStore,
  FileRunRepository,
  StepIdSchema,
  type FileRunControl,
  type UnityBatchConfigV3,
  type UnityWorkspaceStorageV1,
  type UnityWorkspaceStorageV2,
  type UnityWorkConfigV2,
  type VersionedOrchestrationJournal,
} from "@honeybee/core";

import {
  TestPlayCliAdapter,
  UnityAgentProcessRunner,
  UnityProjectBootstrap,
  UnityWorkspaceStorageCliAdapter,
} from "./unity-adapters.js";
import { FileWarmBridgeBindingResolver } from "./unity-bridge-binding.js";
import { UnityEditorBatchWorkflow } from "./unity-editor-batch.js";
import { SystemUnityEditorLauncher } from "./unity-editor-launcher.js";
import { FileUnityEditorPoolCoordinator } from "./unity-editor-pool.js";
import { FileOsUnityEditorRegistry } from "./unity-editor-registry.js";
import {
  UnityEditorWorkTransaction,
  type UnityWorkV5Execution,
} from "./unity-editor-transaction.js";
import { physicalPathsOverlap } from "./path-safety.js";
import { UnityPatchBuilder } from "./unity-patch.js";

const storageAdapter = (
  storage: UnityWorkspaceStorageV1 | UnityWorkspaceStorageV2,
): UnityWorkspaceStorageCliAdapter =>
  "schemaVersion" in storage
    ? new UnityWorkspaceStorageCliAdapter(
        storage.command,
        storage.provider,
        storage.binarySha256,
        2,
      )
    : new UnityWorkspaceStorageCliAdapter(
        storage.command,
        storage.parentKey.provider,
        storage.binarySha256,
      );

export const assertUnityPathsDisjoint = async (
  root: string,
  config: Readonly<{
    sourceProjectPath: string;
    workspaceStorage: Readonly<{ workspaceRoot: string }>;
  }>,
): Promise<void> => {
  const [stateAndSource, stateAndWorkspace, sourceAndWorkspace] = await Promise.all([
    physicalPathsOverlap(root, config.sourceProjectPath),
    physicalPathsOverlap(root, config.workspaceStorage.workspaceRoot),
    physicalPathsOverlap(config.sourceProjectPath, config.workspaceStorage.workspaceRoot),
  ]);
  if (stateAndSource || stateAndWorkspace || sourceAndWorkspace) {
    throw new Error(
      "HoneyBee Run state, sourceProjectPath, and workspaceStorage.workspaceRoot must be disjoint.",
    );
  }
};

export const createUnityEditorTransactionServices = (
  root: string,
  config: UnityWorkConfigV2,
  journal: VersionedOrchestrationJournal,
  controls: FileRunControl,
): Readonly<{ transaction: UnityEditorWorkTransaction; execution: UnityWorkV5Execution }> => {
  const artifacts = new FileArtifactStore(root);
  const bootstrap = new UnityProjectBootstrap();
  const pool = new FileUnityEditorPoolCoordinator(root);
  const patchBuilder = new UnityPatchBuilder(
    artifacts,
    bootstrap,
    path.join(root, ".patch-verification"),
  );
  return {
    transaction: new UnityEditorWorkTransaction(
      root,
      new UnityAgentProcessRunner(),
      artifacts,
      journal,
      controls,
      bootstrap,
      storageAdapter(config.workspaceStorage),
      config.testplay === undefined ? undefined : new TestPlayCliAdapter(config.testplay),
      new SystemUnityEditorLauncher(root),
      new FileOsUnityEditorRegistry(root),
      new FileWarmBridgeBindingResolver(),
    ),
    execution: {
      workId: StepIdSchema.parse("unity-work"),
      poolId: config.editorPool.id,
      priority: config.priority,
      capabilities: config.capabilities,
      pool,
      patchBuilder,
    },
  };
};

export const createUnityEditorBatchWorkflow = (
  root: string,
  config: UnityBatchConfigV3,
  journal: VersionedOrchestrationJournal,
  controls: FileRunControl,
): UnityEditorBatchWorkflow => {
  const artifacts = new FileArtifactStore(root);
  const bootstrap = new UnityProjectBootstrap();
  const pool = new FileUnityEditorPoolCoordinator(root);
  const patchBuilder = new UnityPatchBuilder(
    artifacts,
    bootstrap,
    path.join(root, ".patch-verification"),
  );
  const transaction = new UnityEditorWorkTransaction(
    root,
    new UnityAgentProcessRunner(),
    artifacts,
    journal,
    controls,
    bootstrap,
    storageAdapter(config.transaction.workspaceStorage),
    config.transaction.testplay === undefined
      ? undefined
      : new TestPlayCliAdapter(config.transaction.testplay),
    new SystemUnityEditorLauncher(root),
    new FileOsUnityEditorRegistry(root),
    new FileWarmBridgeBindingResolver(),
  );
  return new UnityEditorBatchWorkflow(
    root,
    artifacts,
    journal,
    new FileRunRepository(root),
    controls,
    controls,
    transaction,
    pool,
    patchBuilder,
  );
};
