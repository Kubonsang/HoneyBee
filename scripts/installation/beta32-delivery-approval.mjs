import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import { readBounded } from "../update/prepare-release.mjs";
import { summarizeFinalAcceptance } from "../qualification/final-acceptance.mjs";

// User approved this publication order on 2026-09-16. This is deliberately
// candidate-specific, not a general switch for publishing incomplete releases.
export const beta32DeliveryApproval = Object.freeze({
  id: "beta32-public-delivery-20260916",
  version: "0.1.0-beta.32",
  setupSha256: "8b4dc6b513e2a0190b1d429284070fbf1cc3df08e2877804fba6b22153a5b56e",
  manifestSha256: "43fdd39e04c0d4a34bd5b0b92ead99e5044e2d41df82548621acd79741f2a9d3",
});

// User approved continuing beta.35 public delivery verification on 2026-09-17.
export const beta35DeliveryApproval = Object.freeze({
  id: "beta35-public-delivery-20260917",
  version: "0.1.0-beta.35",
  setupSha256: "643a944173291018a9d2a357f7edf52874f874dfd644f01e9b1b60ace2c40c04",
  manifestSha256: "5d895f4e603c423ea99e3387e61f2e2fa02dd54a7f9436a9be7b68e8179c7df4",
  wingetManifestSha256: "a47da7ade1f3e9b1c66e839340a04c212ce6d9af74f5841fb72a8d29187fa9c3",
});

export const beta36DeliveryApprovalId = "beta36-public-delivery-20260920";

// The user approved this version's ordering, not an unbound future release.
// An operator freezes this record after artifact construction; it is not embedded
// in source, which would create a source-commit/artifact-hash cycle.
export function validateBeta36Approval(record, sourceCommit) {
  assert.equal(record?.schemaVersion, 1, "Delivery approval schema required");
  assert.equal(record.id, beta36DeliveryApprovalId);
  assert.equal(record.version, "0.1.0-beta.36");
  assert(/^[a-f0-9]{40}$/u.test(sourceCommit ?? ""), "Approval source commit required");
  assert.equal(record.sourceCommit, sourceCommit, "Approval source differs");
  for (const key of ["setupSha256", "manifestSha256", "wingetManifestSha256"])
    assert(/^[a-f0-9]{64}$/u.test(record[key] ?? ""), `Approval ${key} required`);
  return record;
}

export async function loadDeliveryApproval(options) {
  if (options.deliveryApproval === undefined) return undefined;
  const legacy = [beta32DeliveryApproval, beta35DeliveryApproval].find(
    (item) => item.id === options.deliveryApproval,
  );
  if (legacy) return legacy;
  assert.equal(options.deliveryApproval, beta36DeliveryApprovalId, "Unknown delivery approval");
  assert(path.isAbsolute(options.deliveryApprovalPath ?? ""), "Absolute approval path required");
  assert(/^[a-f0-9]{64}$/u.test(options.deliveryApprovalSha256 ?? ""), "Approval digest required");
  const bytes = await readBounded(options.deliveryApprovalPath, 64 * 1024);
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    options.deliveryApprovalSha256,
    "Delivery approval changed",
  );
  return validateBeta36Approval(JSON.parse(bytes), options.releaseCommit);
}

export function publicDeliveryAdmission(policy, acceptance, version, approval, record) {
  if (approval === undefined) return { publicDeliveryVerificationAllowed: false };
  acceptance = summarizeFinalAcceptance(acceptance);
  const pinned =
    approval === beta36DeliveryApprovalId
      ? validateBeta36Approval(record, record?.sourceCommit)
      : [beta32DeliveryApproval, beta35DeliveryApproval].find((item) => item.id === approval);
  assert(pinned, "Unknown delivery approval");
  assert.equal(policy.releaseMode, "unsigned-beta");
  assert.equal(version, pinned.version);
  const candidate = {
    setupSha256: pinned.setupSha256,
    manifestSha256: pinned.manifestSha256,
  };
  assert.deepEqual(acceptance.candidate, candidate, "Delivery approval candidate differs");
  const pending = new Set(["discovery-download", "signed-setup-winget"]);
  for (const gate of acceptance.gates) {
    assert.deepEqual(gate.candidate, candidate, `${gate.id}: candidate differs`);
    assert.equal(gate.scope, "final", `${gate.id}: final coverage required`);
    if (!pending.has(gate.id)) {
      assert.equal(gate.status, "passed", `${gate.id}: unresolved acceptance`);
      continue;
    }
    assert.equal(gate.status, "partial", `${gate.id}: expected pending delivery check`);
    assert.equal(gate.prePublication?.status, "passed", `${gate.id}: prepublication coverage`);
    assert(
      Array.isArray(gate.prePublication.evidence) &&
        gate.prePublication.evidence.length > 0 &&
        gate.prePublication.evidence.every((item) => typeof item === "string" && item.trim()),
      `${gate.id}: prepublication evidence required`,
    );
    if (gate.id === "discovery-download") assert.equal(gate.publicDelivery, "pending");
    else {
      assert.equal(gate.authenticode, "deferred");
      assert.equal(gate.wingetLocal, "pending");
      assert.equal(gate.wingetManifestValidation, "passed");
    }
  }
  return {
    publicDeliveryVerificationAllowed: true,
    deliveryApproval: approval,
    releaseCompleted: false,
    remainingPublicChecks: [...pending],
  };
}
