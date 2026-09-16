import assert from "node:assert/strict";

/** Draft delivery is reviewable before qualification finishes. Public release
 * still requires the original signed/explicit unsigned-beta acceptance decision. */
export function assertDistributionActionAllowed(review, action) {
  assert(["stage", "publish"].includes(action), "Unknown publication action");
  assert.equal(review.artifactsVerified, true, "Distribution artifacts are not verified");
  if (action === "publish")
    assert(
      review.unsignedBetaReady === true || review.signedReleaseReady === true,
      "Final acceptance has unresolved release gates",
    );
}

/** Explicit operator policy; never inferred from a failed signature check. */
export function distributionPolicy(options, manifest) {
  const releaseMode = options.releaseMode ?? "signed";
  assert(["signed", "unsigned-beta"].includes(releaseMode), "Unknown release mode");
  if (releaseMode === "unsigned-beta") {
    assert.equal(manifest.channel, "beta", "Unsigned distribution requires beta channel");
    assert(/^\d+\.\d+\.\d+-beta\.\d+$/u.test(manifest.version), "Beta version required");
    assert(!options.publisherThumbprint, "Unsigned beta cannot claim a publisher certificate");
    return { releaseMode, authenticode: "not-signed", publisherThumbprint: null };
  }
  assert(
    /^[a-fA-F0-9]{40}$/u.test(options.publisherThumbprint),
    "Publisher certificate pin required",
  );
  return {
    releaseMode,
    authenticode: "signed",
    publisherThumbprint: options.publisherThumbprint.toUpperCase(),
  };
}

/** This evaluates the fixed acceptance ledger, not the contents of its evidence. */
export function distributionReadiness(policy, acceptance) {
  const gate = acceptance.gates.find((item) => item.id === "signed-setup-winget");
  const unsignedBetaReady =
    policy.releaseMode === "unsigned-beta" &&
    acceptance.gates
      .filter((item) => item.id !== "signed-setup-winget")
      .every((item) => item.status === "passed") &&
    gate.status === "partial" &&
    gate.authenticode === "deferred" &&
    gate.wingetLocal === "passed" &&
    gate.scope === "final" &&
    gate.candidate?.setupSha256 === acceptance.candidate.setupSha256 &&
    gate.candidate?.manifestSha256 === acceptance.candidate.manifestSha256 &&
    gate.evidence.length > 0;
  return {
    signedReleaseReady: policy.releaseMode === "signed" && acceptance.ready,
    unsignedBetaReady,
    prereleaseRequired: policy.releaseMode === "unsigned-beta",
  };
}
