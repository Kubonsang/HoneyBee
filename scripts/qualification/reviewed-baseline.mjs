import assert from "node:assert/strict";
import path from "node:path";
import { readBounded } from "../update/prepare-release.mjs";
import { readCombinedOutcome } from "../update/combined-update.mjs";
import { assertPreserved, snapshotRegisteredProject } from "./preservation.mjs";

// Explicit handoff from the populated, successful beta.22 QA transition. This
// reuses its dataset; it is never evidence that a new Setup was freshly installed.
export function assertReviewedRepair(before, current, review) {
  assert.equal(review, "preserved-20260916T035057");
  assert.equal(
    before.registrySha256,
    "9fc408def4aa791d8ff4886c56004a221ec40af419d076b44a6578ef09a59b04",
  );
  assert.equal(
    current.registrySha256,
    "02570755a84eb636281e984160d10606878be5037ea725f096959e0731da503a",
  );
  const expected = globalThis.structuredClone(before);
  const workspaces = expected.workspaces.filter(
    (w) => w.workspaceId === "8934fa61-ed64-4851-8535-261ce5109487",
  );
  assert.equal(workspaces.length, 1);
  assert.equal(workspaces[0].updatedAt, "2026-09-14T15:04:06.552Z");
  workspaces[0].updatedAt = "2026-09-16T03:50:57.510Z";
  expected.registrySha256 = current.registrySha256;
  assertPreserved(expected, current);
  return {
    review,
    beforeRegistrySha256: before.registrySha256,
    afterRegistrySha256: current.registrySha256,
  };
}

export async function readReviewedBaseline(
  { installationRoot, specification, repairReview },
  hooks = {},
) {
  assert.equal(specification.kind, "committed-populated-beta22");
  assert.equal(
    specification.transaction,
    "8a79bcbce67c3e19da9e718536dccb6259dd17de54efac491c5c03b5d079b707",
  );
  assert.equal(
    specification.evidence,
    "C:\\HoneyBeeQA\\final-integrated-20260914\\Transitions\\topology6\\Execution\\result.json",
  );
  const read = hooks.read ?? readBounded;
  const record = JSON.parse(await read(specification.evidence, 8 * 1024 * 1024));
  assert.equal(record.state, "Committed");
  assert.equal(record.preserved, true);
  assert.equal(record.doctor.ready, true);
  assert.equal(
    record.bridgeManifestSha256,
    "5212d7056e87a948efd001c61fc6daf735b4ca9023fa086aa4561f6a5e083afb",
  );
  assert.equal(record.current.activeVersion, "0.1.0-beta.22");
  const directory = path.join(installationRoot, "update/combined", specification.transaction);
  assert.equal(path.resolve(record.result.transactionDirectory), directory);
  const outcome = await (hooks.outcome ?? readCombinedOutcome)({
    installationRoot,
    transactionDirectory: directory,
    sourcePointerSha256: "16d3c33362da615fb60131f2099881f1f41f53e65bf7836954ff0483cd47b708",
  });
  assert.deepEqual(outcome, { state: "Committed", version: "0.1.0-beta.22" });
  const current = await (hooks.snapshot ?? snapshotRegisteredProject)({
    installationRoot,
    projectId: record.dataset.projectId,
  });
  let reviewedRepair;
  if (repairReview) reviewedRepair = assertReviewedRepair(record.before, current, repairReview);
  else assertPreserved(record.before, current);
  return {
    dataset: record.dataset,
    before: current,
    reused: true,
    freshSetup: false,
    evidence: specification.evidence,
    ...(reviewedRepair ? { reviewedRepair } : {}),
  };
}
