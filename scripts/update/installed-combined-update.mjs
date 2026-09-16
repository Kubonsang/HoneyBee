import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import process from "node:process";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { open } from "node:fs/promises";
import path from "node:path";
import { readBounded } from "./prepare-release.mjs";
import { sha256 } from "./release-manifest.mjs";
import { combinedUpdateIdentity } from "./combined-update.mjs";
import { requireCombinedClients } from "./combined-admission.mjs";
import {
  createDesktopUpdateTransport,
  createSetupDesktopUpdateTransport,
} from "./desktop-session.mjs";
import { withDesktopUpdateLifecycle } from "./desktop-update-lifecycle.mjs";
import { checkVersionHealth } from "./version-health.mjs";
import {
  createCombinedApplicationSelection,
  persistCombinedApplicationContext,
  validateCombinedApplicationContext,
} from "./combined-application.mjs";
import { runNativeCombinedUpdate } from "./native-service-update.mjs";
import {
  resolveRecoverySource,
  verifyRecoverySourceFiles,
  recoveryInventoryBytes,
} from "./recovery-source.mjs";

export function createCombinedReleaseAuthorization(root, runtime, context) {
  const { source, target } = validateCombinedApplicationContext(context);
  const authorize = async (directory) => {
    assert.equal(path.dirname(path.resolve(directory)), path.join(root, "versions"));
    const version = path.basename(directory);
    const pointer = version === source.activeVersion ? source : target;
    assert.equal(pointer.activeVersion, version, "Unrelated combined release");
    const approved = await resolveRecoverySource({ installationRoot: root, runtime, pointer });
    await verifyRecoverySourceFiles(root, approved);
    return true;
  };
  return authorize;
}

// A reviewed external Setup/maintenance runner may use the authenticated target
// to fix an old migrator. No arbitrary executable path or trust override is accepted.
// Persist the selection so that the same runner can resume after interruption.
export async function resolveCombinedCoordinator(root, context, verifyRelease) {
  const { source, target } = validateCombinedApplicationContext(context);
  const pointer = context.nativeCoordinator === "target" ? target : source;
  const directory = path.join(path.resolve(root), "versions", pointer.activeVersion);
  await verifyRelease(directory);
  return path.join(directory, "tools/honeybee-workspace-storage-host.exe");
}

/** User-side composition: existing Desktop shutdown/activity, real service-only
 * UAC, protected native migration, isolated renderer readiness and existing Doctor.
 * No ordinary Desktop starts until the outer lifecycle releases exclusive activity. */
export async function activateInstalledCombinedUpdate({
  installationRoot,
  runtime,
  options,
  plan,
  sourceBytes,
  release,
  nativeCoordinator,
}) {
  assert(nativeCoordinator === undefined || nativeCoordinator === "target");
  const root = path.resolve(installationRoot);
  const source = JSON.parse(sourceBytes);
  assert.equal(plan.identity.status, "migration-required");
  assert.equal(release.manifest.components.storage.migration.kind, "service-replacement");
  assert.equal(sha256(sourceBytes), plan.identity.sourcePointerSha256);
  const target = {
    schemaVersion: 1,
    generation: source.generation + 1,
    activeVersion: release.manifest.version,
    manifestSha256: release.manifest.recovery.launchManifestSha256,
  };
  const targetBytes = Buffer.from(JSON.stringify(target) + "\n");
  const identity = {
    manifestSha256: release.manifestSha256,
    sourcePointerSha256: sha256(sourceBytes),
    serviceTransactionSha256: randomBytes(32).toString("hex"),
  };
  const context = {
    schemaVersion: 1,
    identity,
    identitySha256: combinedUpdateIdentity(identity),
    sourcePointer: sourceBytes.toString("base64"),
    targetPointer: targetBytes.toString("base64"),
    launcherSha256: options.launcherSha256,
    ...(nativeCoordinator ? { nativeCoordinator } : {}),
  };
  const verifyRelease = createCombinedReleaseAuthorization(root, runtime, context);
  const sourceDirectory = path.join(root, "versions", source.activeVersion),
    targetDirectory = path.join(root, "versions", target.activeVersion);
  const clients = { sourceDirectory, targetDirectory, launcherSha256: options.launcherSha256 };
  await requireCombinedClients({ installationRoot: root, ...clients }, verifyRelease);
  const companion = await resolveCombinedCoordinator(root, context, verifyRelease);
  const capabilities = JSON.parse(
    (
      await promisify(execFile)(companion, ["install-capabilities"], {
        windowsHide: true,
        timeout: 15000,
        maxBuffer: 65536,
      })
    ).stdout,
  );
  assert(
    capabilities.schemaVersion === 1 && capabilities.serviceUpdateSession === 1,
    "Installed service companion requires a bootstrapper upgrade",
  );
  await persistCombinedApplicationContext(root, context);
  if (options.activationJob) {
    const { directory, requestSha256 } = options.activationJob;
    assert.equal(path.dirname(path.resolve(directory)), path.join(root, "update/jobs"));
    assert(/^job-[A-Za-z0-9]+$/u.test(path.basename(directory)));
    assert.equal(sha256(await readBounded(path.join(directory, "request.json"))), requestSha256);
    const file = await open(path.join(directory, "combined-transaction.json"), "wx");
    try {
      await file.writeFile(
        JSON.stringify({ schemaVersion: 1, requestSha256, identitySha256: context.identitySha256 }),
      );
      await file.sync();
    } finally {
      await file.close();
    }
  }
  const stage = path.join(root, "update", plan.stageAttempt);
  const inventory = JSON.parse(
    await readBounded(path.join(path.dirname(options.planPath), "inventory.json"), 8 * 1024 * 1024),
  );
  const inventoryBytes = recoveryInventoryBytes(inventory.files);
  assert.equal(sha256(inventoryBytes), release.manifest.recovery.inventorySha256);
  const manifestBytes = await readBounded(path.join(stage, "release.json"));
  assert.equal(sha256(manifestBytes), identity.manifestSha256);
  const native = {
    executable: companion,
    admission: {
      schemaVersion: 1,
      transactionSha256: identity.serviceTransactionSha256,
      ownerPid: process.pid,
      applicationRoot: root,
      sourcePointer: context.sourcePointer,
      targetPointer: context.targetPointer,
      sourceObservationSha256: plan.identity.sourceEvidenceSha256,
      source: {
        AppVersion: source.activeVersion,
        BootstrapperVersion: plan.source.bootstrapperVersion,
        ComponentVersion: plan.identity.sourceComponentVersion,
        Channel: plan.source.channel,
      },
      executable: path.join(targetDirectory, "tools/honeybee-workspace-storage-host.exe"),
      manifest: manifestBytes.toString("base64"),
      signature: (await readBounded(path.join(stage, "release.sig.json"), 4096)).toString("base64"),
      inventory: inventoryBytes.toString("base64"),
    },
  };
  const transport = await (
    options.setupActivation === true
      ? createSetupDesktopUpdateTransport
      : createDesktopUpdateTransport
  )({
    installationRoot: root,
    descriptor: options.desktopDescriptor,
  });
  return withDesktopUpdateLifecycle(
    options,
    {
      ...transport,
      authorizeRestart: async ({ state, pointerSha256 }) => {
        const expected = state === "Committed" ? targetBytes : sourceBytes;
        assert.equal(pointerSha256, sha256(expected));
        return verifyRelease(state === "Committed" ? targetDirectory : sourceDirectory);
      },
    },
    async (activity) =>
      runCombinedApplicationTransaction({
        root,
        runtime,
        context,
        native,
        clients,
        verifyRelease,
        activity,
      }),
  );
}

export async function runCombinedApplicationTransaction({
  root,
  runtime,
  context,
  native,
  clients,
  verifyRelease,
  activity,
  recover = false,
}) {
  const { source, target } = validateCombinedApplicationContext(context);
  verifyRelease ??= createCombinedReleaseAuthorization(root, runtime, context);
  clients ??= {
    sourceDirectory: path.join(root, "versions", source.activeVersion),
    targetDirectory: path.join(root, "versions", target.activeVersion),
    launcherSha256: context.launcherSha256,
  };
  native ??= {
    executable: await resolveCombinedCoordinator(root, context, verifyRelease),
  };
  const health = async (which) => {
    const pointer = which === "target" ? target : source;
    activity.assertHeld();
    return checkVersionHealth(
      {
        installationRoot: root,
        version: pointer.activeVersion,
        launchManifestSha256: pointer.manifestSha256,
      },
      { authorize: () => verifyRelease(path.join(root, "versions", pointer.activeVersion)) },
    );
  };
  const result = await runNativeCombinedUpdate(
    {
      installationRoot: root,
      identity: context.identity,
      native,
      clients,
      recover,
      validation: {
        version: target.activeVersion,
        targetPointerSha256: sha256(Buffer.from(context.targetPointer, "base64")),
      },
    },
    {
      ...createCombinedApplicationSelection(root, context, {
        assertHeld: activity.assertExclusive,
        verifyRelease,
      }),
      health,
      verifyRelease,
      admit: async () => {
        activity.assertHeld();
        assert.equal(
          sha256(await readBounded(path.join(root, "HoneyBeeLauncher.exe"), 8 * 1024 * 1024)),
          context.launcherSha256,
        );
        await verifyRelease(clients.sourceDirectory);
        if (!recover) await verifyRelease(clients.targetDirectory);
        return true;
      },
      assertQuiescent: activity.assertExclusive,
      setValidationActivityMode: activity.setMode,
      restartSource: async () => {},
      restartTarget: async () => {},
    },
  );
  return { ...result, kind: "combined", transactionDirectory: result.directory };
}
