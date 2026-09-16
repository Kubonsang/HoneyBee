import assert from "node:assert/strict";
import path from "node:path";
import { readBounded } from "../update/prepare-release.mjs";
import { readCombinedOutcome } from "../update/combined-update.mjs";

// The previous attempt is retained. This admits a NEW candidate, never replays
// the old activation job, and never treats a saved result as machine authority.
export function verifyOpticalPredecessor(options, dependencies) {
  return verifyReviewedPredecessor(options, dependencies, {
    resultPath: "Transitions/topology1/Execution/PreparationRetry/result.json",
    transaction: "6c55ec2fe97e259bca01e40d60a7496ace9cc43b380ae895f2d2785e86f5e9b6",
    manifest: "d824146588cd80b4e99a33f5b05e5702a89340481fb82a75af8668043191e6d9",
    reason: "Incorrect function.",
  });
}

export function verifyQuiescePredecessor(options, dependencies) {
  return verifyReviewedPredecessor(options, dependencies, {
    resultPath: "Transitions/topology2/Execution/result.json",
    transaction: "059ba7a6e18a488ccc3eea96ed2f9e53be18361f478a9fe32d15ce5c22f1d629",
    manifest: "9fc02181af8ea32ce4190f0a74e5d7f4121ff145a4f8828e2896a838b6fd258f",
    reason: "The specified network resource or device is no longer available.",
  });
}

export function verifyBackupPredecessor(options, dependencies) {
  return verifyReviewedPredecessor(options, dependencies, {
    resultPath: "Transitions/topology3/Execution/result.json",
    transaction: "ec7a06a0bfe48ba53a70e46c2cbcb093be10590ccf18e0245387ee23a650cdb0",
    manifest: "4a769bd45f101b5bf7a5489c6460096e2a118e37ae96af4999d445375b361287",
    reason: "store entry has unsupported NTFS attributes",
  });
}

export function verifyCompressionPredecessor(options, dependencies) {
  return verifyReviewedPredecessor(options, dependencies, {
    resultPath: "Transitions/topology4/Execution/result.json",
    transaction: "4e76687a86ba4a9763b0e37bb651a5828b2248189b49dc5ba6a4f76b59cb2b2c",
    manifest: "fd1e6a6b5be5712a45e024e5dbd561665770b34bff3871beb6493a667d290d2a",
    reason:
      'before store backup: inventory store entry "C:\\\\ProgramData\\\\UnityWorkspaceStorage\\\\S-1-5-21-4199076252-3622841657-4011401391-1001\\\\children\\\\lease-43d0116a8935f0e309d631b1488da3b2.bee\\\\data": store entry has unsupported NTFS attributes: attributes=0x00002810 unsupported=0x00000800 expectedDirectory=true',
  });
}

export function verifyActivityPredecessor(options, dependencies) {
  return verifyReviewedPredecessor(options, dependencies, {
    resultPath: "Transitions/topology5/Execution/result.json",
    transaction: "dc4e70bf74fbd3b507c4e8a5e591c5e049f4f32fcbb977193e1707050440d076",
    manifest: "5212d7056e87a948efd001c61fc6daf735b4ca9023fa086aa4561f6a5e083afb",
    reason: "Validation Desktop readiness timed out",
  });
}

async function verifyReviewedPredecessor(
  { bundle, installationRoot, before, dataset, sourcePointerSha256, originalInputsSha256 },
  { readOutcome = readCombinedOutcome } = {},
  reviewed,
) {
  const previous = JSON.parse(
    await readBounded(path.join(bundle, reviewed.resultPath), 8 * 1024 * 1024),
  );
  const transactionDirectory = path.join(installationRoot, "update/combined", reviewed.transaction);
  assert.equal(previous.schemaVersion, 1);
  assert.equal(previous.state, "RolledBack");
  assert.equal(previous.preserved, true);
  assert.equal(previous.doctor.ready, true);
  assert.equal(previous.acceptancePromoted, false);
  assert.equal(previous.publicationAllowed, false);
  assert.equal(previous.originalInputsSha256, originalInputsSha256);
  assert.equal(previous.bridgeManifestSha256, reviewed.manifest);
  assert.deepEqual(previous.before, before);
  assert.deepEqual(previous.dataset, dataset);
  assert.equal(previous.result.state, "RolledBack");
  assert.equal(previous.result.reason, reviewed.reason);
  assert.equal(path.resolve(previous.result.transactionDirectory), transactionDirectory);
  assert.equal(previous.current.activeVersion, "0.1.0-beta.11");
  const outcome = await readOutcome({
    installationRoot,
    transactionDirectory,
    sourcePointerSha256,
  });
  assert.deepEqual(outcome, { state: "RolledBack", version: "0.1.0-beta.11" });
  return { transactionDirectory, state: outcome.state };
}
