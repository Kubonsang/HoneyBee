import assert from "node:assert/strict";
import path from "node:path";
import {
  readInstalledStorage,
  WorkspaceToolResolver,
  WindowsWorkspaceStorage,
  planStorageUpdate,
} from "../../packages/core/dist/index.js";
import { plainDirectory } from "./stage-release.mjs";
import { readBounded } from "./prepare-release.mjs";
import {
  parseReleaseManifest,
  admitRelease,
  compareVersions,
  sha256,
} from "./release-manifest.mjs";

export const observeUpdateSource = async ({
  installationRoot,
  manifestPath,
  manifestSha256,
  bootstrapperVersion,
  channel,
}) => {
  const root = path.resolve(installationRoot);
  await plainDirectory(root);
  const pointerBytes = await readBounded(path.join(root, "current.json"));
  const pointer = JSON.parse(pointerBytes);
  assert.equal(pointer.schemaVersion, 1);
  compareVersions(pointer.activeVersion, "0.0.0");
  const release = path.join(root, "versions", pointer.activeVersion);
  await plainDirectory(release);
  assert.equal(
    sha256(await readBounded(path.join(release, "launch.json"))),
    pointer.manifestSha256,
    "Active launch manifest mismatch",
  );
  const options = await readInstalledStorage(release);
  const tools = new WorkspaceToolResolver(options).resolve();
  assert(tools?.provenance === "managed", "Managed installation required");
  const manifest = parseReleaseManifest(await readBounded(manifestPath), manifestSha256);
  admitRelease(manifest, {
    currentVersion: pointer.activeVersion,
    bootstrapperVersion,
    channel,
    storageComponentVersion: tools.expectedComponentVersion,
  });
  const plan = await planStorageUpdate(
    new WindowsWorkspaceStorage(),
    tools,
    manifest.components.storage,
  );
  assert.deepEqual(
    await readBounded(path.join(root, "current.json")),
    pointerBytes,
    "Active version changed during preflight",
  );
  return {
    ...plan,
    observedAt: new Date().toISOString(),
    sourceVersion: pointer.activeVersion,
    targetVersion: manifest.version,
    manifestSha256,
    sourcePointerSha256: sha256(pointerBytes),
  };
};
