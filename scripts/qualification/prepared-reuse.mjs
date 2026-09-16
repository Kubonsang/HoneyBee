import assert from "node:assert/strict";
import path from "node:path";
import { readdir } from "node:fs/promises";
import { readBounded } from "../update/prepare-release.mjs";
import { sha256 } from "../update/release-manifest.mjs";
import { authenticateStagedRelease } from "../update/authenticated-preparation.mjs";
import { verifyPublishedVersion } from "../update/publish-version.mjs";
import { revalidateUpdatePlan } from "../update/update-plan.mjs";
import { prepareSetupUpgrade } from "../update/setup-upgrade.mjs";

const optional = async (file) => {
  try {
    return JSON.parse(await readBounded(file));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
};
export function matchesPreparation(request, receipt, sourceHash, step) {
  return (
    request?.operation === "prepare" &&
    receipt?.passed === true &&
    request.sourcePointerSha256 === sourceHash &&
    request.manifestSha256 === step.manifestSha256 &&
    receipt.result?.version === step.to
  );
}

// Fixed matrix cases intentionally revisit one candidate. Reuse only its proven
// preparation, never adopt an arbitrary existing versions directory.
export async function prepareMatrixUpdate(
  { installationRoot, bundle, step },
  {
    prepare = prepareSetupUpgrade,
    authenticate = authenticateStagedRelease,
    revalidate = revalidateUpdatePlan,
    verify = verifyPublishedVersion,
  } = {},
) {
  assert(step.serviceUpdate === undefined || typeof step.serviceUpdate === "boolean");
  const serviceUpdate = step.name === "service" || step.serviceUpdate === true;
  const root = path.resolve(installationRoot);
  const pointer = await readBounded(path.join(root, "current.json"));
  assert.equal(JSON.parse(pointer).activeVersion, step.from);
  const sourceHash = sha256(pointer);
  const jobs = path.join(root, "update/jobs");
  const names = await readdir(jobs).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  assert(names.length <= 1000, "QA job bound exceeded");
  const matches = [];
  for (const name of names.sort()) {
    assert(/^job-[A-Za-z0-9]+$/u.test(name));
    const request = await optional(path.join(jobs, name, "request.json"));
    const receipt = await optional(path.join(jobs, name, "result.json"));
    if (matchesPreparation(request, receipt, sourceHash, step))
      matches.push({ name, request, receipt });
  }
  assert(matches.length <= 1, "Ambiguous successful preparations; retain all evidence");
  if (!matches.length)
    return prepare({
      installationRoot: root,
      mediaDirectory: path.join(bundle, "updates", step.name),
      expectedVersion: step.to,
      allowServiceUpdate: serviceUpdate,
    });
  const { name, request, receipt } = matches[0];
  const digest = sha256(await readBounded(path.join(jobs, name, "request.json")));
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.requestSha256, digest);
  const prepared = receipt.result;
  assert.equal(prepared.state, "ReadyForActivation");
  assert.equal(prepared.activationAllowed, false);
  assert.equal(prepared.sourcePointerSha256, sourceHash);
  assert.equal(prepared.manifestSha256, step.manifestSha256);
  assert(/^stage-[A-Za-z0-9]+$/u.test(request.stage));
  const trust = await optional(path.join(root, "recovery/v1/update-trust.json"));
  const authenticated = await authenticate({
    installationRoot: root,
    stageAttempt: path.join(root, "update", request.stage),
    expectedManifestSha256: step.manifestSha256,
    trustedPublicKeys: trust.publicKeys,
  });
  assert.equal(authenticated.manifest.version, step.to);
  const options = {
    installationRoot: root,
    planPath: prepared.planPath,
    planSha256: prepared.planSha256,
    publicationDirectory: prepared.publicationDirectory,
    sourcePointerSha256: sourceHash,
  };
  const plan = JSON.parse(await readBounded(prepared.planPath));
  assert.equal(plan.manifestSha256, step.manifestSha256);
  assert.equal(plan.stageAttempt, request.stage);
  assert.equal(plan.identity.targetVersion, step.to);
  await revalidate(options);
  await verify({ ...options, allowServiceCandidate: serviceUpdate });
  assert.deepEqual(await readBounded(path.join(root, "current.json")), pointer);
  return { installationRoot: root, preparation: { name, sha256: digest } };
}

export async function priorControllerNonce(priorRoot) {
  if (!priorRoot) return undefined;
  const match = /^(.*-attempt-)(\d{3})$/u.exec(path.basename(priorRoot));
  assert(match, "Invalid prior QA attempt");
  for (let i = Number(match[2]); i >= 0; i--) {
    const attempt = path.join(path.dirname(priorRoot), match[1] + String(i).padStart(3, "0"));
    const config = await optional(path.join(attempt, "worker.json"));
    if (!config) continue;
    const failure = await optional(path.join(attempt, "failed.json"));
    if (
      /launch-native-fault\.ps1/u.test(failure?.error ?? "") &&
      /The operation was canceled by the user/u.test(failure.error) &&
      !(await optional(path.join(attempt, "native-ready.json")))
    )
      continue;
    assert(/^[a-f0-9]{64}$/u.test(config.nonce));
    return config.nonce;
  }
}
