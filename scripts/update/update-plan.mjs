import assert from "node:assert/strict";
import { open } from "node:fs/promises";
import path from "node:path";
import { observeUpdateSource } from "./observe-source.mjs";
import { prepareRelease, readBounded, validatePreparedPayload } from "./prepare-release.mjs";
import { plainDirectory } from "./stage-release.mjs";
import { sha256, parseReleaseManifest, admitRelease } from "./release-manifest.mjs";

const child = (root, name, prefix) => {
  assert(
    typeof name === "string" && new RegExp(`^${prefix}-[A-Za-z0-9]+$`, "u").test(name),
    "Invalid update attempt name",
  );
  return path.join(root, "update", name);
};
const binding = (observation) => {
  assert(
    ["app-only-candidate", "migration-required"].includes(observation.status) &&
      observation.activationAllowed === false,
    "Source preflight blocked",
  );
  for (const name of ["sourceEvidenceSha256", "sourcePointerSha256", "manifestSha256"])
    assert(/^[a-f0-9]{64}$/u.test(observation[name]), "Incomplete source binding");
  assert(
    Number.isSafeInteger(observation.parentCount) && observation.parentCount >= 0,
    "Incomplete storage observation",
  );
  return {
    status: observation.status,
    sourceVersion: observation.sourceVersion,
    targetVersion: observation.targetVersion,
    sourceComponentVersion: observation.sourceComponentVersion,
    sourceEvidenceSha256: observation.sourceEvidenceSha256,
    sourcePointerSha256: observation.sourcePointerSha256,
    manifestSha256: observation.manifestSha256,
    parentCount: observation.parentCount,
  };
};
/** Creates a pinned, non-executable plan from a NEW verified extraction, never an arbitrary Prepared marker. */
export const createUpdatePlan = async (
  { installationRoot, stageAttempt, manifestSha256, bootstrapperVersion, channel },
  { observe = observeUpdateSource } = {},
) => {
  const root = path.resolve(installationRoot);
  const stage = child(root, path.basename(stageAttempt), "stage");
  assert.equal(path.resolve(stageAttempt), stage, "Stage outside update root");
  await plainDirectory(stage);
  const request = {
    installationRoot: root,
    manifestPath: path.join(stage, "release.json"),
    manifestSha256,
    bootstrapperVersion,
    channel,
  };
  const first = await observe(request),
    identity = binding(first);
  const source = {
    currentVersion: first.sourceVersion,
    bootstrapperVersion,
    channel,
    storageComponentVersion: first.sourceComponentVersion,
  };
  const prepared = await prepareRelease({
    installationRoot: root,
    stageAttempt: stage,
    manifestSha256,
    source,
  });
  const attempt = path.dirname(path.dirname(prepared.directory));
  const inventoryBytes = await readBounded(path.join(attempt, "inventory.json"), 8 * 1024 * 1024);
  const second = await observe(request);
  assert.deepEqual(binding(second), identity, "Source changed during plan creation");
  assert.equal(
    sha256(await readBounded(path.join(root, "current.json"))),
    identity.sourcePointerSha256,
    "Current pointer changed",
  );
  const plan = {
    schemaVersion: 1,
    state: "Planned",
    activationAllowed: false,
    stageAttempt: path.basename(stage),
    prepareAttempt: path.basename(attempt),
    manifestSha256,
    source,
    identity,
    inventorySha256: sha256(inventoryBytes),
    launchManifestSha256: prepared.launchManifestSha256,
    remainingGates: second.remainingGates,
  };
  const bytes = JSON.stringify(plan, null, 2) + "\n";
  const planPath = path.join(attempt, "plan.json");
  const file = await open(planPath, "wx");
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
  return { planPath, planSha256: sha256(bytes), state: "Planned", activationAllowed: false };
};

export const revalidateUpdatePlan = async (
  { installationRoot, planPath, planSha256 },
  { observe = observeUpdateSource } = {},
) => {
  const root = path.resolve(installationRoot);
  const planBytes = await readBounded(planPath);
  assert(
    /^[a-f0-9]{64}$/u.test(planSha256) && sha256(planBytes) === planSha256,
    "Plan SHA-256 mismatch",
  );
  const plan = JSON.parse(planBytes);
  assert(
    plan.schemaVersion === 1 && plan.state === "Planned" && plan.activationAllowed === false,
    "Unsupported plan",
  );
  const attempt = child(root, plan.prepareAttempt, "prepare");
  assert.equal(
    path.resolve(planPath),
    path.join(attempt, "plan.json"),
    "Plan outside preparation attempt",
  );
  await plainDirectory(attempt);
  const stage = child(root, plan.stageAttempt, "stage");
  await plainDirectory(stage);
  const manifest = parseReleaseManifest(
    await readBounded(path.join(stage, "release.json")),
    plan.manifestSha256,
  );
  admitRelease(manifest, plan.source);
  const request = {
    installationRoot: root,
    manifestPath: path.join(stage, "release.json"),
    manifestSha256: plan.manifestSha256,
    bootstrapperVersion: plan.source.bootstrapperVersion,
    channel: plan.source.channel,
  };
  assert.deepEqual(binding(await observe(request)), plan.identity, "Source plan is stale");
  const inventoryBytes = await readBounded(path.join(attempt, "inventory.json"), 8 * 1024 * 1024);
  assert.equal(sha256(inventoryBytes), plan.inventorySha256, "Prepared inventory changed");
  const inventory = JSON.parse(inventoryBytes);
  assert.equal(inventory.schemaVersion, 1);
  const directory = path.join(attempt, "versions", manifest.version);
  const metadata = await validatePreparedPayload(directory, inventory.files, manifest);
  assert.equal(metadata.launchManifestSha256, plan.launchManifestSha256, "Launch manifest changed");
  assert.deepEqual(
    binding(await observe(request)),
    plan.identity,
    "Source changed during revalidation",
  );
  assert.equal(
    sha256(await readBounded(path.join(root, "current.json"))),
    plan.identity.sourcePointerSha256,
    "Current pointer changed",
  );
  return {
    schemaVersion: 1,
    state: "Revalidated",
    planSha256,
    directory,
    activationAllowed: false,
    remainingGates: plan.remainingGates,
  };
};
