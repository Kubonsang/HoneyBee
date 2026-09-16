import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, copyFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { readBounded } from "../update/prepare-release.mjs";
import { authenticateReleaseManifest } from "../update/release-authentication.mjs";
import { parseReleaseManifest, sha256, admitRelease } from "../update/release-manifest.mjs";
import {
  recoveryInventoryBytes,
  resolveRecoverySource,
  verifyRecoverySourceFiles,
} from "../update/recovery-source.mjs";
import { digestDistributionFile } from "../installation/prepare-distribution.mjs";

/** A real Windows service build used only to exercise replacement mechanics.
 * It is explicitly NOT evidence of migration from the published legacy hb12.
 * The target application bytes remain those of the reviewed distribution. */
export async function buildServicePair({
  sourceInstallation,
  targetInstallation,
  targetDistribution,
  trustedPublicKeys,
  outputRoot,
}) {
  const sourceRoot = path.resolve(sourceInstallation),
    targetRoot = path.resolve(targetInstallation);
  const sourcePointer = JSON.parse(await readBounded(path.join(sourceRoot, "current.json")));
  const targetPointer = JSON.parse(await readBounded(path.join(targetRoot, "current.json")));
  const sourceRuntime = path.join(sourceRoot, "recovery/v1");
  const approved = await resolveRecoverySource({
    installationRoot: sourceRoot,
    runtime: sourceRuntime,
    pointer: sourcePointer,
  });
  await verifyRecoverySourceFiles(sourceRoot, approved);
  const sourceRelease = path.join(sourceRoot, "versions", sourcePointer.activeVersion);
  const sourceMetadata = JSON.parse(
    await readBounded(path.join(sourceRelease, "installation.json")),
  );
  const sourceTools = JSON.parse(
    await readBounded(path.join(sourceRelease, "tools/manifest.json")),
  );
  assert(
    sourceTools.qualificationOnly === true &&
      sourceTools.historicalRelease === false &&
      sourceTools.qualificationBuild === "managed-maintenance-checkpoints-v1",
    "Explicit QA source build required",
  );
  assert.equal(sourceMetadata.componentVersion, sourceTools.workspaceStorageVersion);
  const sourceHost = path.join(sourceRelease, "tools/honeybee-workspace-storage-host.exe");
  const sourceHash = await digestDistributionFile(sourceHost);
  assert.equal(sourceHash.sha256, sourceMetadata.controlSha256);
  const capabilities = JSON.parse(
    (
      await promisify(execFile)(sourceHost, ["install-capabilities"], {
        windowsHide: true,
        timeout: 15000,
        maxBuffer: 65536,
      })
    ).stdout,
  );
  assert(
    capabilities.schemaVersion === 1 && capabilities.serviceUpdateSession === 1,
    "Source lacks managed service update protocol",
  );
  const original = authenticateReleaseManifest(
    await readBounded(path.join(targetDistribution, "release.json")),
    await readBounded(path.join(targetDistribution, "release.sig.json"), 4096),
    trustedPublicKeys,
  );
  const manifest = globalThis.structuredClone(original.manifest);
  assert.equal(manifest.version, targetPointer.activeVersion);
  assert.equal(manifest.recovery.launchManifestSha256, targetPointer.manifestSha256);
  const targetRelease = path.join(targetRoot, "versions", targetPointer.activeVersion);
  const targetMetadata = JSON.parse(
    await readBounded(path.join(targetRelease, "installation.json")),
  );
  const targetApproved = await resolveRecoverySource({
    installationRoot: targetRoot,
    runtime: path.join(targetRoot, "recovery/v1"),
    pointer: targetPointer,
  });
  await verifyRecoverySourceFiles(targetRoot, targetApproved);
  const files = {};
  for (const name of Object.keys(targetApproved.files)) {
    const entry = await digestDistributionFile(path.join(targetRelease, name));
    assert.equal(entry.sha256, targetApproved.files[name]);
    files[name] = entry;
  }
  assert.equal(sha256(recoveryInventoryBytes(files)), manifest.recovery.inventorySha256);
  assert.equal(targetMetadata.componentVersion, manifest.components.storage.componentVersion);
  const targetHash = files["tools/honeybee-workspace-storage-host.exe"];
  assert.equal(targetHash.sha256, targetMetadata.controlSha256);
  assert.notEqual(
    sourceMetadata.componentVersion,
    targetMetadata.componentVersion,
    "Different service component identities required",
  );
  assert.notEqual(sourceHash.sha256, targetHash.sha256, "Different actual service builds required");
  const artifact = manifest.packages.application;
  assert.deepEqual(await digestDistributionFile(path.join(targetDistribution, "application.zip")), {
    size: artifact.size,
    sha256: artifact.sha256,
  });
  manifest.minimumSourceVersion = sourcePointer.activeVersion;
  manifest.components.storage.migration = {
    kind: "service-replacement",
    supportedSourceVersions: [sourceMetadata.componentVersion],
  };
  const trust = JSON.parse(await readBounded(path.join(sourceRuntime, "update-trust.json")));
  const bytes = globalThis.Buffer.from(JSON.stringify(manifest, null, 2) + "\n");
  parseReleaseManifest(bytes, sha256(bytes));
  admitRelease(manifest, {
    currentVersion: sourcePointer.activeVersion,
    bootstrapperVersion: trust.bootstrapperVersion,
    channel: trust.channel,
    storageComponentVersion: sourceMetadata.componentVersion,
  });
  await mkdir(outputRoot, { recursive: true });
  const directory = await mkdtemp(path.join(path.resolve(outputRoot), "service-pair-"));
  await copyFile(
    path.join(targetDistribution, "application.zip"),
    path.join(directory, "application.zip"),
  );
  assert.deepEqual(await digestDistributionFile(path.join(directory, "application.zip")), {
    size: artifact.size,
    sha256: artifact.sha256,
  });
  await writeFile(path.join(directory, "inventory.json"), recoveryInventoryBytes(files), {
    flag: "wx",
  });
  await writeFile(path.join(directory, "release.json"), bytes, { flag: "wx" });
  const pair = {
    schemaVersion: 1,
    qualificationOnly: true,
    historicalMigrationQualified: false,
    sourceKind: "instrumented-qa-baseline",
    sourceInstallation: sourceRoot,
    targetInstallation: targetRoot,
    source: {
      version: sourcePointer.activeVersion,
      componentVersion: sourceMetadata.componentVersion,
      host: sourceHash,
    },
    target: {
      version: targetPointer.activeVersion,
      componentVersion: targetMetadata.componentVersion,
      host: targetHash,
    },
    productionManifestSha256: original.manifestSha256,
    qualificationManifestSha256: sha256(bytes),
    packageSha256: artifact.sha256,
    directory,
    signed: false,
    executed: false,
  };
  await writeFile(path.join(directory, "pair.json"), JSON.stringify(pair, null, 2) + "\n", {
    flag: "wx",
  });
  return pair;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  assert(process.argv.length === 3, "Usage: build-service-pair.mjs <pair-config.json>");
  process.stdout.write(
    JSON.stringify(
      await buildServicePair(JSON.parse(await readBounded(process.argv[2]))),
      null,
      2,
    ) + "\n",
  );
}
