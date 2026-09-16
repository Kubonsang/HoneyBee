import assert from "node:assert/strict";
import { open } from "node:fs/promises";
import path from "node:path";
import { authenticateReleaseManifest } from "./release-authentication.mjs";
import { readBounded } from "./prepare-release.mjs";
import { plainDirectory } from "./stage-release.mjs";
import { observeUpdateSource } from "./observe-source.mjs";
import { createUpdatePlan } from "./update-plan.mjs";
import { publishPreparedVersion } from "./publish-version.mjs";
import { sha256 } from "./release-manifest.mjs";
import { persistRecoverySource } from "./recovery-source.mjs";

export const authenticateStagedRelease = async ({
  installationRoot,
  stageAttempt,
  expectedManifestSha256,
  trustedPublicKeys,
}) => {
  const root = path.resolve(installationRoot);
  const stage = path.resolve(stageAttempt);
  assert.equal(path.dirname(stage), path.join(root, "update"), "Stage outside installation");
  assert(/^stage-[A-Za-z0-9]+$/u.test(path.basename(stage)), "Invalid stage directory");
  await plainDirectory(stage);
  const authenticated = authenticateReleaseManifest(
    await readBounded(path.join(stage, "release.json")),
    await readBounded(path.join(stage, "release.sig.json"), 4096),
    trustedPublicKeys,
  );
  assert.equal(authenticated.manifestSha256, expectedManifestSha256, "Staged offer changed");
  return authenticated;
};

/** Prepare/publish inactive files only. Never quits Desktop or changes current.json. */
export const prepareAuthenticatedUpdate = async (
  options,
  { observe = observeUpdateSource, plan = createUpdatePlan, publish = publishPreparedVersion } = {},
) => {
  options = { ...options, trustedPublicKeys: [...options.trustedPublicKeys] };
  const root = path.resolve(options.installationRoot);
  const stage = path.resolve(options.stageAttempt);
  const authenticated = await authenticateStagedRelease(options);
  const serviceCandidate =
    authenticated.manifest.components.storage.migration.kind === "service-replacement";
  const request = {
    installationRoot: root,
    manifestPath: path.join(stage, "release.json"),
    manifestSha256: authenticated.manifestSha256,
    bootstrapperVersion: options.bootstrapperVersion,
    channel: options.channel,
  };
  const admit = async (value) => {
    assert.deepEqual(value, request, "Unexpected preflight request");
    await authenticateStagedRelease(options);
    const observation = await observe(value);
    assert(
      observation.status === (serviceCandidate ? "migration-required" : "app-only-candidate") &&
        observation.activationAllowed === false,
      "Compatible source required",
    );
    return observation;
  };
  await admit(request);
  const prepared = await plan(
    {
      installationRoot: root,
      stageAttempt: stage,
      manifestSha256: authenticated.manifestSha256,
      bootstrapperVersion: options.bootstrapperVersion,
      channel: options.channel,
    },
    { observe: admit },
  );
  const planBytes = await readBounded(prepared.planPath);
  assert.equal(sha256(planBytes), prepared.planSha256, "Prepared plan changed");
  const identity = JSON.parse(planBytes);
  assert.equal(identity.manifestSha256, authenticated.manifestSha256);
  assert.equal(identity.identity.targetVersion, authenticated.manifest.version);
  await admit(request);
  const publication = await publish(
    {
      installationRoot: root,
      planPath: prepared.planPath,
      planSha256: prepared.planSha256,
      ...(serviceCandidate ? { allowServiceCandidate: true } : {}),
    },
    { observe: admit },
  );
  await admit(request);
  await persistRecoverySource({
    installationRoot: root,
    authenticated,
    inventoryBytes: await readBounded(
      path.join(path.dirname(prepared.planPath), "inventory.json"),
      8 * 1024 * 1024,
    ),
  });
  const result = {
    schemaVersion: 1,
    state: "ReadyForActivation",
    activationAllowed: false,
    version: authenticated.manifest.version,
    manifestSha256: authenticated.manifestSha256,
    signerKeyId: authenticated.signerKeyId,
    stageAttempt: stage,
    planPath: prepared.planPath,
    planSha256: prepared.planSha256,
    publicationDirectory: publication.publicationDirectory,
    sourcePointerSha256: identity.identity.sourcePointerSha256,
  };
  const receipt = await open(
    path.join(path.dirname(prepared.planPath), "authenticated-preparation.json"),
    "wx",
  );
  try {
    await receipt.writeFile(JSON.stringify(result, null, 2) + "\n");
    await receipt.sync();
  } finally {
    await receipt.close();
  }
  return result;
};
