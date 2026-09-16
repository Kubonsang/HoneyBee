import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { readBounded } from "./prepare-release.mjs";
import { sha256 } from "./release-manifest.mjs";
import { authenticateStagedRelease } from "./authenticated-preparation.mjs";
import { revalidateUpdatePlan } from "./update-plan.mjs";
import { verifyPublishedVersion } from "./publish-version.mjs";
import {
  recoveryInventoryBytes,
  resolveRecoverySource,
  verifyRecoverySourceFiles,
} from "./recovery-source.mjs";
import { updateAndRestartDesktopWithDoctor } from "./desktop-session.mjs";
import { activateInstalledCombinedUpdate } from "./installed-combined-update.mjs";

export async function activateAuthenticatedUpdate(
  { installationRoot, runtime, request, activationJob },
  {
    observe,
    checkpoint,
    execute = updateAndRestartDesktopWithDoctor,
    activateCombined = activateInstalledCombinedUpdate,
  } = {},
) {
  const root = path.resolve(installationRoot);
  const job = path.join(root, "update/jobs", request.preparationJob);
  const priorBytes = await readBounded(path.join(job, "request.json"));
  assert.equal(sha256(priorBytes), request.preparationSha256);
  const prior = JSON.parse(priorBytes);
  assert.equal(prior.operation, "prepare");
  assert.equal(prior.sourcePointerSha256, request.sourcePointerSha256);
  const receipt = JSON.parse(await readBounded(path.join(job, "result.json")));
  assert(
    receipt.schemaVersion === 1 &&
      receipt.passed === true &&
      receipt.requestSha256 === request.preparationSha256,
  );
  const prepared = receipt.result;
  assert(prepared.state === "ReadyForActivation" && prepared.activationAllowed === false);
  assert.equal(prepared.sourcePointerSha256, request.sourcePointerSha256);
  assert.equal(prepared.manifestSha256, prior.manifestSha256);
  assert(/^stage-[A-Za-z0-9]+$/u.test(prior.stage));
  const sourceBytes = await readBounded(path.join(root, "current.json"));
  assert.equal(sha256(sourceBytes), request.sourcePointerSha256);
  const source = JSON.parse(sourceBytes);
  const trust = JSON.parse(await readBounded(path.join(runtime, "update-trust.json")));
  assert.equal(trust.schemaVersion, 1);
  const authOptions = {
    installationRoot: root,
    stageAttempt: path.join(root, "update", prior.stage),
    expectedManifestSha256: prior.manifestSha256,
    trustedPublicKeys: trust.publicKeys,
  };
  const options = {
    activationJob,
    installationRoot: root,
    planPath: prepared.planPath,
    planSha256: prepared.planSha256,
    publicationDirectory: prepared.publicationDirectory,
    sourcePointerSha256: request.sourcePointerSha256,
    launcherSha256: request.launcherSha256,
    ...(request.operation === "setup-activate"
      ? { setupActivation: true }
      : {
          desktopDescriptor: path.join(
            root,
            "update/desktop-sessions",
            request.desktopSession + ".json",
          ),
        }),
  };
  const planBytes = await readBounded(options.planPath);
  assert.equal(sha256(planBytes), options.planSha256);
  const plan = JSON.parse(planBytes);
  assert.equal(plan.manifestSha256, prior.manifestSha256);
  assert.equal(plan.stageAttempt, prior.stage);
  assert.equal(plan.source.bootstrapperVersion, trust.bootstrapperVersion);
  assert.equal(plan.source.channel, trust.channel);
  assert.equal(plan.identity.sourcePointerSha256, request.sourcePointerSha256);
  const target = {
    activeVersion: plan.identity.targetVersion,
    manifestSha256: plan.launchManifestSha256,
  };
  const authenticate = async () => {
    const release = await authenticateStagedRelease(authOptions);
    assert.equal(release.manifest.version, target.activeVersion);
    assert(
      ["none", "service-replacement"].includes(release.manifest.components.storage.migration.kind),
    );
    assert.equal(
      release.manifest.recovery?.launchManifestSha256,
      target.manifestSha256,
      "Target must support continuing recovery",
    );
    const inventory = JSON.parse(
      await readBounded(
        path.join(path.dirname(options.planPath), "inventory.json"),
        8 * 1024 * 1024,
      ),
    );
    assert.equal(
      sha256(recoveryInventoryBytes(inventory.files)),
      release.manifest.recovery.inventorySha256,
    );
    return release;
  };
  const authorize = async (pointer) => {
    const approved = await resolveRecoverySource({ installationRoot: root, runtime, pointer });
    await verifyRecoverySourceFiles(root, approved);
  };
  // Complete trust, source/service and publication checks before asking Desktop to quit.
  const authenticated = await authenticate();
  await authorize(source);
  await authorize(target);
  await revalidateUpdatePlan(options, observe ? { observe } : undefined);
  const serviceCandidate =
    authenticated.manifest.components.storage.migration.kind === "service-replacement";
  await verifyPublishedVersion({
    ...options,
    ...(serviceCandidate ? { allowServiceCandidate: true } : {}),
  });
  if (serviceCandidate)
    return activateCombined({
      installationRoot: root,
      runtime,
      options,
      plan,
      sourceBytes,
      release: authenticated,
    });
  const launcher = path.join(root, "HoneyBeeLauncher.exe");
  const restart = async () => {
    assert.equal(sha256(await readBounded(launcher, 8 * 1024 * 1024)), request.launcherSha256);
    await promisify(execFile)(launcher, [], { cwd: root, windowsHide: true, timeout: 15000 });
  };
  try {
    return await execute(options, {
      ...(checkpoint ? { checkpoint } : {}),
      ...(observe ? { observe } : {}),
      admit: async () => {
        await authenticate();
        await authorize(source);
        await authorize(target);
        return true;
      },
      authorizeHealth: async ({ version }) => {
        assert(version === source.activeVersion || version === target.activeVersion);
        await authenticate();
        await authorize(version === source.activeVersion ? source : target);
        return true;
      },
      authorizeRestart: async ({ state, pointerSha256 }) => {
        const bytes = await readBounded(path.join(root, "current.json"));
        assert.equal(sha256(bytes), pointerSha256);
        const pointer = JSON.parse(bytes),
          expected = state === "Committed" ? target : source;
        assert.equal(pointer.activeVersion, expected.activeVersion);
        assert.equal(pointer.manifestSha256, expected.manifestSha256);
        await authorize(expected);
        return true;
      },
    });
  } catch (error) {
    // Ordinary launcher owns interrupted-journal recovery. Never rewrite pointers here.
    try {
      const current = JSON.parse(await readBounded(path.join(root, "current.json")));
      assert([source.activeVersion, target.activeVersion].includes(current.activeVersion));
      await authorize(source);
      await restart();
    } catch (restartError) {
      error.restartError = restartError.message;
    }
    throw error;
  }
}
