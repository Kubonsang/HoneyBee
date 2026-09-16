import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import { readBounded } from "./prepare-release.mjs";
import { plainDirectory } from "./stage-release.mjs";
import { authenticateReleaseManifest } from "./release-authentication.mjs";
import { stageAuthenticatedRelease } from "./authenticated-release.mjs";
import { resolveRecoverySource, verifyRecoverySourceFiles } from "./recovery-source.mjs";
import { dispatchPreparation, dispatchActivation } from "./dispatch-preparation.mjs";
import { sha256 } from "./release-manifest.mjs";

/** Keep the initially installed bootstrapper while repairing a later approved
 * application. Both the original infrastructure receipt and native runtime pin
 * must match; this function never repairs or replaces infrastructure. */
export async function authorizeMatchingSetup(
  { installationRoot, sourceInstallation, verifyActive = true },
  { run = promisify(execFile) } = {},
) {
  const root = path.resolve(installationRoot),
    runtime = path.join(root, "recovery/v1");
  const original = JSON.parse(
    await readBounded(path.join(root, ".setup-pending/prepared.json"), 8 * 1024 * 1024),
  );
  assert.equal(original.schemaVersion, 1);
  for (const name of ["HoneyBeeLauncher.exe", "bin/honeybee.exe"])
    assert.equal(
      sha256(await readBounded(path.join(root, name), 8 * 1024 * 1024)),
      original.inventory[name],
      "Original bootstrapper or shim requires matching Setup repair",
    );
  const checked = JSON.parse(
    (
      await run(path.join(root, "HoneyBeeLauncher.exe"), ["--verify-recovery-runtime"], {
        windowsHide: true,
        timeout: 30000,
        maxBuffer: 65536,
      })
    ).stdout,
  );
  assert.equal(checked.schemaVersion, 1);
  assert.equal(
    sha256(await readBounded(path.join(runtime, "manifest.json"))),
    checked.recoveryManifestSha256,
  );
  const pointerBytes = await readBounded(path.join(root, "current.json")),
    pointer = JSON.parse(pointerBytes);
  const supplied = JSON.parse(await readBounded(path.join(sourceInstallation, "current.json")));
  assert.equal(
    supplied.activeVersion,
    pointer.activeVersion,
    "Repair Setup version differs from active version",
  );
  assert.equal(
    supplied.manifestSha256,
    pointer.manifestSha256,
    "Repair Setup launch identity differs",
  );
  const approved = await resolveRecoverySource({ installationRoot: root, runtime, pointer });
  await verifyRecoverySourceFiles(sourceInstallation, approved);
  if (verifyActive) await verifyRecoverySourceFiles(root, approved);
  assert.deepEqual(await readBounded(path.join(root, "current.json")), pointerBytes);
  return { runtime };
}

/** Local media is transport only: installed trust, release admission and the
 * ordinary pinned worker still authenticate and execute every update step. */
export async function createEmbeddedReleaseTransport(directory, trustedPublicKeys) {
  directory = path.resolve(directory);
  await plainDirectory(directory);
  const bytes = await readBounded(path.join(directory, "release.json"), 65536);
  const signature = await readBounded(path.join(directory, "release.sig.json"), 4096);
  const authenticated = authenticateReleaseManifest(bytes, signature, trustedPublicKeys);
  const artifact = authenticated.manifest.packages.application;
  const base = new globalThis.URL(".", artifact.url);
  const manifestUrl = new globalThis.URL("release.json", base).href;
  const signatureUrl = new globalThis.URL("release.sig.json", base).href;
  assert(![manifestUrl, signatureUrl].includes(artifact.url), "Package URL collides with metadata");
  const archive = path.join(directory, "application.zip");
  const info = await lstat(archive);
  assert(
    info.isFile() && !info.isSymbolicLink() && info.size === artifact.size,
    "Embedded application archive is missing or has the wrong size",
  );
  return {
    authenticated,
    manifestUrl,
    signatureUrl,
    fetchImpl: async (url) => {
      if (url === manifestUrl) return new globalThis.Response(bytes);
      if (url === signatureUrl) return new globalThis.Response(signature);
      assert.equal(url, artifact.url, "Setup requested an unrelated package");
      return new globalThis.Response(Readable.toWeb(createReadStream(archive)), {
        headers: { "content-length": String(info.size) },
      });
    },
  };
}

export async function prepareSetupUpgrade({
  installationRoot,
  mediaDirectory,
  expectedVersion,
  allowServiceUpdate,
}) {
  const root = path.resolve(installationRoot),
    runtime = path.join(root, "recovery/v1");
  await plainDirectory(root);
  const pointerBytes = await readBounded(path.join(root, "current.json"));
  const pointer = JSON.parse(pointerBytes);
  const capabilities = JSON.parse(
    (
      await promisify(execFile)(
        path.join(root, "HoneyBeeLauncher.exe"),
        ["--installation-capabilities"],
        { windowsHide: true, timeout: 15000, maxBuffer: 65536 },
      )
    ).stdout,
  );
  assert(
    capabilities.schemaVersion === 1 && capabilities.setupActivation === 1,
    "Installed bootstrapper does not support Setup upgrades; existing installation preserved",
  );
  const approved = await resolveRecoverySource({ installationRoot: root, runtime, pointer });
  await verifyRecoverySourceFiles(root, approved);
  const trust = JSON.parse(await readBounded(path.join(runtime, "update-trust.json")));
  assert.equal(trust.schemaVersion, 1);
  const media = await createEmbeddedReleaseTransport(mediaDirectory, trust.publicKeys);
  assert.equal(
    media.authenticated.manifest.version,
    expectedVersion,
    "Setup and update media versions differ",
  );
  if (media.authenticated.manifest.components.storage.migration.kind === "service-replacement")
    assert.equal(allowServiceUpdate, true, "Service update requires interactive Setup");
  const installation = JSON.parse(
    await readBounded(path.join(root, "versions", pointer.activeVersion, "installation.json")),
  );
  const staged = await stageAuthenticatedRelease({
    installationRoot: root,
    ...media,
    trustedPublicKeys: trust.publicKeys,
    source: {
      currentVersion: pointer.activeVersion,
      bootstrapperVersion: trust.bootstrapperVersion,
      channel: trust.channel,
      storageComponentVersion: installation.componentVersion,
    },
    signal: globalThis.AbortSignal.timeout(30 * 60 * 1000),
  });
  assert.deepEqual(
    await readBounded(path.join(root, "current.json")),
    pointerBytes,
    "Active source changed",
  );
  const preparation = await dispatchPreparation({ installationRoot: root, stage: staged });
  return { installationRoot: root, preparation };
}

export async function upgradeFromSetup(options) {
  const { installationRoot: root, preparation } = await prepareSetupUpgrade(options);
  const state = await dispatchActivation({
    installationRoot: root,
    preparation,
    setupActivation: true,
  });
  return {
    schemaVersion: 1,
    installed: true,
    ready: state === "Committed",
    state,
    evidence: path.join(root, "update/jobs"),
    restarted: state !== "Cancelled",
  };
}
