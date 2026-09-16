import assert from "node:assert/strict";
import path from "node:path";
import { readBounded } from "../update/prepare-release.mjs";
import { authenticateReleaseManifest } from "../update/release-authentication.mjs";
import { admitRelease, sha256 } from "../update/release-manifest.mjs";
import { recoveryInventoryBytes } from "../update/recovery-source.mjs";
import { digestDistributionFile } from "../installation/prepare-distribution.mjs";
import { fixedAcceptanceGates } from "./final-acceptance.mjs";

/** Freeze existing acceptance inputs without running a VM or granting passes.
 * A same-code QA service pair is kept explicitly separate from historical
 * upgrade compatibility and the public release manifest. */
export async function createFinalInputs({
  distribution,
  baselineSetup,
  reviewedBaseline,
  servicePair,
  consecutive,
  trustedPublicKeys,
}) {
  assert(
    servicePair.signed === true &&
      servicePair.executed === false &&
      servicePair.qualificationOnly === true,
  );
  assert(servicePair.historicalMigrationQualified === false);
  assert.equal(servicePair.sourceKind, "instrumented-qa-baseline");
  const artifacts = [];
  const add = async (source, destination) => {
    assert(!artifacts.some((a) => a.destination === destination));
    const digest = await digestDistributionFile(source);
    artifacts.push({ source: path.resolve(source), destination, ...digest });
    return digest;
  };
  const authenticate = async (directory) =>
    authenticateReleaseManifest(
      await readBounded(path.join(directory, "release.json")),
      await readBounded(path.join(directory, "release.sig.json"), 4096),
      trustedPublicKeys,
    );
  const production = await authenticate(distribution.directory);
  const setup = await add(
    path.join(distribution.directory, "HoneyBeeSetup.exe"),
    "HoneyBeeSetup.exe",
  );
  assert.deepEqual(setup, distribution.setup);
  assert.equal(production.manifestSha256, distribution.manifestSha256);
  await add(path.join(distribution.directory, "release.json"), "production/release.json");
  await add(path.join(distribution.directory, "release.sig.json"), "production/release.sig.json");
  assert(
    Boolean(baselineSetup) !== Boolean(reviewedBaseline),
    "Choose fresh Setup or an explicit reviewed baseline",
  );
  if (reviewedBaseline) assert.equal(reviewedBaseline.kind, "committed-populated-beta22");
  const baseline = baselineSetup
    ? await add(baselineSetup, "HoneyBeeSetup-qualification-baseline.exe")
    : null;
  const migration = await authenticate(servicePair.directory);
  assert.equal(migration.manifestSha256, servicePair.qualificationManifestSha256);
  assert.equal(servicePair.productionManifestSha256, production.manifestSha256);
  const expected = globalThis.structuredClone(production.manifest);
  expected.minimumSourceVersion = servicePair.source.version;
  expected.components.storage.migration = {
    kind: "service-replacement",
    supportedSourceVersions: [servicePair.source.componentVersion],
  };
  assert.deepEqual(
    migration.manifest,
    expected,
    "QA variant changed more than source/migration admission",
  );
  assert.equal(
    migration.manifest.components.storage.componentVersion,
    servicePair.target.componentVersion,
  );
  assert.notEqual(servicePair.source.host.sha256, servicePair.target.host.sha256);
  const sequence = [
    {
      directory: servicePair.directory,
      from: servicePair.source.version,
      sourceComponent: servicePair.source.componentVersion,
      name: "service",
    },
    ...consecutive.appUpdates.map((item, index) => ({
      directory: item.directory,
      from: index === 0 ? production.manifest.version : consecutive.appUpdates[index - 1].version,
      sourceComponent: servicePair.target.componentVersion,
      name: `app-${index + 1}`,
    })),
  ];
  assert.equal(sequence.length, 3, "Exactly one service transition and two app updates required");
  const updates = [];
  for (const step of sequence) {
    const auth = await authenticate(step.directory);
    admitRelease(auth.manifest, {
      currentVersion: step.from,
      bootstrapperVersion: "1.0.0",
      channel: "beta",
      storageComponentVersion: step.sourceComponent,
    });
    if (step.name !== "service")
      assert.equal(auth.manifest.components.storage.migration.kind, "none");
    const inventory = JSON.parse(
      await readBounded(path.join(step.directory, "inventory.json"), 8 * 1024 * 1024),
    );
    assert.equal(
      sha256(recoveryInventoryBytes(inventory.files)),
      auth.manifest.recovery.inventorySha256,
    );
    assert.equal(
      inventory.files["tools/honeybee-workspace-storage-host.exe"].sha256,
      servicePair.target.host.sha256,
    );
    const archive = await add(
      path.join(step.directory, "application.zip"),
      `updates/${step.name}/application.zip`,
    );
    assert.deepEqual(archive, {
      size: auth.manifest.packages.application.size,
      sha256: auth.manifest.packages.application.sha256,
    });
    for (const name of ["release.json", "release.sig.json", "inventory.json"])
      await add(path.join(step.directory, name), `updates/${step.name}/${name}`);
    updates.push({
      name: step.name,
      from: step.from,
      to: auth.manifest.version,
      manifestSha256: auth.manifestSha256,
      packageSha256: archive.sha256,
    });
  }
  return {
    schemaVersion: 1,
    qualificationOnly: true,
    candidate: { setupSha256: setup.sha256, manifestSha256: production.manifestSha256 },
    baselineSetup: baseline,
    ...(reviewedBaseline ? { reviewedBaseline } : {}),
    servicePair: {
      source: servicePair.source,
      target: servicePair.target,
      sourceKind: servicePair.sourceKind,
      historicalMigrationQualified: false,
    },
    updates,
    artifacts,
    fixedGates: [...fixedAcceptanceGates],
    data: {
      readyWorkspaces: 1,
      requireRegisteredProject: true,
      requireKoreanAndSpacedPath: true,
      requireDirtyTrackedFile: true,
      requireUntrackedFile: true,
    },
    interruptions: {
      process: [
        "app-prepared",
        "app-selected",
        "app-validated",
        "service-backup-verified",
        "service-stopped",
        "service-replaced",
        "service-validated",
      ],
      reboot: ["app-selected", "service-replaced"],
      powerOff: ["service-replaced"],
    },
    deliveryReady: false,
    runner: null,
    executed: false,
    publicationAllowed: false,
  };
}
