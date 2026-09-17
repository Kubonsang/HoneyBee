import assert from "node:assert/strict";
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

export function publicDeliveryAdmission(policy, acceptance, version, approval) {
  if (approval === undefined) return { publicDeliveryVerificationAllowed: false };
  acceptance = summarizeFinalAcceptance(acceptance);
  const pinned = [beta32DeliveryApproval, beta35DeliveryApproval].find(
    (item) => item.id === approval,
  );
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
