import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createFinalAcceptance } from "../qualification/final-acceptance.mjs";
import {
  beta32DeliveryApproval as approval,
  beta35DeliveryApproval,
  publicDeliveryAdmission,
  beta36DeliveryApprovalId,
  beta37DeliveryApprovalId,
  beta38DeliveryApprovalId,
  beta39DeliveryApprovalId,
  deliveryCompletionPolicy,
  requiresWingetManifest,
  validateOperatorDeliveryApproval,
  validateBeta36Approval,
  loadDeliveryApproval,
} from "./beta32-delivery-approval.mjs";
import { assertDistributionActionAllowed } from "./distribution-policy.mjs";

const policy = { releaseMode: "unsigned-beta" };
const beta36 = {
  schemaVersion: 1,
  id: beta36DeliveryApprovalId,
  version: "0.1.0-beta.36",
  sourceCommit: "c".repeat(40),
  setupSha256: approval.setupSha256,
  manifestSha256: approval.manifestSha256,
  wingetManifestSha256: "d".repeat(64),
};

test("beta.39 delivery requires its own unchanged approval and source", async () => {
  const record = { ...beta36, id: beta39DeliveryApprovalId, version: "0.1.0-beta.39" };
  const root = await mkdtemp(path.join(tmpdir(), "hb-beta39-"));
  const file = path.join(root, "approval.json");
  const bytes = JSON.stringify(record);
  await writeFile(file, bytes);
  const options = {
    deliveryApproval: record.id,
    deliveryApprovalPath: file,
    deliveryApprovalSha256: createHash("sha256").update(bytes).digest("hex"),
    releaseCommit: record.sourceCommit,
  };
  assert.deepEqual(await loadDeliveryApproval(options), record);
  await assert.rejects(loadDeliveryApproval({ ...options, releaseCommit: "e".repeat(40) }));
  await assert.rejects(
    loadDeliveryApproval({ ...options, deliveryApproval: beta38DeliveryApprovalId }),
  );
  for (const change of [
    { version: "0.1.0-beta.38" },
    { setupSha256: "" },
    { manifestSha256: "" },
    { wingetManifestSha256: "" },
  ])
    assert.throws(() =>
      validateOperatorDeliveryApproval({ ...record, ...change }, record.sourceCommit),
    );
  await writeFile(file, bytes + " ");
  await assert.rejects(loadDeliveryApproval(options), /changed/u);
});

test("beta.38 ordering requires its own frozen source and artifact approval", async () => {
  const record = { ...beta36, id: beta38DeliveryApprovalId, version: "0.1.0-beta.38" };
  const root = await mkdtemp(path.join(tmpdir(), "hb-beta38-"));
  const file = path.join(root, "approval.json");
  const bytes = JSON.stringify(record);
  await writeFile(file, bytes);
  const options = {
    deliveryApproval: record.id,
    deliveryApprovalPath: file,
    deliveryApprovalSha256: createHash("sha256").update(bytes).digest("hex"),
    releaseCommit: record.sourceCommit,
  };
  assert.deepEqual(await loadDeliveryApproval(options), record);
  assert.deepEqual(deliveryCompletionPolicy(record, record.sourceCommit), {
    includeWingetManifest: true,
    requireUnifiedVerification: true,
  });
  assert.throws(() => deliveryCompletionPolicy(record, "e".repeat(40)));
  assert.equal(
    publicDeliveryAdmission(policy, fixture(), record.version, record.id, record)
      .publicDeliveryVerificationAllowed,
    true,
  );
  await assert.rejects(loadDeliveryApproval({ ...options, releaseCommit: "e".repeat(40) }));
  await assert.rejects(
    loadDeliveryApproval({ ...options, deliveryApproval: beta37DeliveryApprovalId }),
  );
  for (const change of [
    { version: "0.1.0-beta.37" },
    { version: "0.1.0-beta.39" },
    { setupSha256: "" },
    { manifestSha256: "" },
    { wingetManifestSha256: "" },
    { id: "beta39-public-delivery-20261102", version: "0.1.0-beta.39" },
  ])
    assert.throws(() =>
      validateOperatorDeliveryApproval({ ...record, ...change }, record.sourceCommit),
    );
  const incomplete = fixture();
  incomplete.gates[5].status = "pending";
  assert.throws(() =>
    publicDeliveryAdmission(policy, incomplete, record.version, record.id, record),
  );
  await writeFile(file, bytes + " ");
  await assert.rejects(loadDeliveryApproval(options), /changed/u);
});

test("completion verification remains mandatory for all supported operator versions", () => {
  for (const [id, version] of [
    [beta36DeliveryApprovalId, "0.1.0-beta.36"],
    [beta37DeliveryApprovalId, "0.1.0-beta.37"],
    [beta38DeliveryApprovalId, "0.1.0-beta.38"],
    [beta39DeliveryApprovalId, "0.1.0-beta.39"],
  ]) {
    const record = { ...beta36, id, version };
    assert.equal(requiresWingetManifest(version), true);
    assert.deepEqual(deliveryCompletionPolicy(record, record.sourceCommit), {
      includeWingetManifest: true,
      requireUnifiedVerification: true,
    });
  }
  assert.deepEqual(deliveryCompletionPolicy(beta35DeliveryApproval), {
    includeWingetManifest: true,
    requireUnifiedVerification: false,
  });
  assert.throws(() => deliveryCompletionPolicy({ ...beta36, id: "unknown" }, beta36.sourceCommit));
});

test("WinGet publication requirement does not disappear without an approval record", () => {
  for (const version of [
    "0.1.0-beta.35",
    "0.1.0-beta.36",
    "0.1.0-beta.37",
    "0.1.0-beta.38",
    "0.1.0-beta.39",
  ])
    assert.equal(requiresWingetManifest(version), true);
  assert.equal(requiresWingetManifest("0.1.0-beta.32"), false);
  assert.equal(requiresWingetManifest("0.1.0-beta.40"), false);
});

test("beta.37 requires its own approval and rejects stale version, source and artifact pins", async () => {
  const record = { ...beta36, id: beta37DeliveryApprovalId, version: "0.1.0-beta.37" };
  const root = await mkdtemp(path.join(tmpdir(), "hb-beta37-"));
  const file = path.join(root, "approval.json");
  const bytes = JSON.stringify(record);
  await writeFile(file, bytes);
  const options = {
    deliveryApproval: record.id,
    deliveryApprovalPath: file,
    deliveryApprovalSha256: createHash("sha256").update(bytes).digest("hex"),
    releaseCommit: record.sourceCommit,
  };
  assert.deepEqual(await loadDeliveryApproval(options), record);
  await assert.rejects(loadDeliveryApproval({ ...options, deliveryApproval: beta36.id }));
  await assert.rejects(loadDeliveryApproval({ ...options, releaseCommit: "e".repeat(40) }));
  assert.equal(
    publicDeliveryAdmission(policy, fixture(), record.version, record.id, record)
      .publicDeliveryVerificationAllowed,
    true,
  );
  assert.throws(() =>
    publicDeliveryAdmission(policy, fixture(), record.version, record.id, beta36),
  );
  assert.throws(() =>
    publicDeliveryAdmission(policy, fixture(), record.version, beta36.id, record),
  );
  for (const change of [
    { version: beta36.version },
    { setupSha256: "" },
    { manifestSha256: "" },
    { wingetManifestSha256: "" },
    { sourceCommit: "" },
    { schemaVersion: 2 },
  ])
    assert.throws(() =>
      validateOperatorDeliveryApproval({ ...record, ...change }, record.sourceCommit),
    );
  assert.throws(() =>
    publicDeliveryAdmission(policy, fixture(), record.version, record.id, {
      ...record,
      setupSha256: "a".repeat(64),
    }),
  );
  for (const index of [0, 8, 12, 14]) {
    const incomplete = fixture();
    incomplete.gates[index].status = "pending";
    assert.throws(() =>
      publicDeliveryAdmission(policy, incomplete, record.version, record.id, record),
    );
  }
  await writeFile(file, bytes + " ");
  await assert.rejects(loadDeliveryApproval(options), /changed/);
});

test("beta.36 requires an explicit hash-pinned operator record and matching source", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "hb-beta36-"));
  const file = path.join(root, "approval.json");
  const bytes = JSON.stringify(beta36);
  await writeFile(file, bytes);
  const options = {
    deliveryApproval: beta36DeliveryApprovalId,
    deliveryApprovalPath: file,
    deliveryApprovalSha256: createHash("sha256").update(bytes).digest("hex"),
    releaseCommit: beta36.sourceCommit,
  };
  assert.deepEqual(await loadDeliveryApproval(options), beta36);
  await assert.rejects(loadDeliveryApproval({ ...options, releaseCommit: "e".repeat(40) }));
  await assert.rejects(loadDeliveryApproval({ ...options, deliveryApprovalSha256: undefined }));
  await writeFile(file, bytes + " ");
  await assert.rejects(loadDeliveryApproval(options), /changed/);
});
test("beta.36 ordering neither covers another version nor permits missing pins", () => {
  assert.equal(
    publicDeliveryAdmission(policy, fixture(), beta36.version, beta36.id, beta36)
      .publicDeliveryVerificationAllowed,
    true,
  );
  assert.throws(() => publicDeliveryAdmission(policy, fixture(), beta36.version, beta36.id));
  for (const change of [
    { version: "0.1.0-beta.37" },
    { schemaVersion: 2 },
    { setupSha256: "" },
    { manifestSha256: "" },
    { wingetManifestSha256: "" },
    { sourceCommit: "" },
  ])
    assert.throws(() => validateBeta36Approval({ ...beta36, ...change }, beta36.sourceCommit));
  assert.throws(() =>
    publicDeliveryAdmission(policy, fixture(), beta36.version, beta36.id, {
      ...beta36,
      setupSha256: "f".repeat(64),
    }),
  );
});
function fixture() {
  const candidate = { setupSha256: approval.setupSha256, manifestSha256: approval.manifestSha256 };
  const input = createFinalAcceptance(candidate);
  for (const gate of input.gates)
    Object.assign(gate, {
      status: "passed",
      scope: "final",
      candidate,
      evidence: ["reviewed-case"],
    });
  for (const gate of input.gates.filter((g) =>
    ["discovery-download", "signed-setup-winget"].includes(g.id),
  ))
    Object.assign(gate, {
      status: "partial",
      prePublication: { status: "passed", evidence: ["reviewed-prerequisites"] },
    });
  Object.assign(input.gates[3], { publicDelivery: "pending" });
  Object.assign(input.gates[15], {
    authenticode: "deferred",
    wingetLocal: "pending",
    wingetManifestValidation: "passed",
  });
  return input;
}
const admit = (input) => publicDeliveryAdmission(policy, input, approval.version, approval.id);
test("beta.35 approval is explicit and cannot authorize another candidate", () => {
  const pinned = beta35DeliveryApproval;
  const input = fixture();
  input.candidate = { setupSha256: pinned.setupSha256, manifestSha256: pinned.manifestSha256 };
  for (const gate of input.gates) gate.candidate = input.candidate;
  assert.equal(
    publicDeliveryAdmission(policy, input, pinned.version, pinned.id)
      .publicDeliveryVerificationAllowed,
    true,
  );
  assert.throws(() => publicDeliveryAdmission(policy, input, pinned.version, approval.id));
  assert.throws(() => publicDeliveryAdmission(policy, fixture(), approval.version, pinned.id));
  input.gates[8].status = "failed";
  assert.throws(() => publicDeliveryAdmission(policy, input, pinned.version, pinned.id));
});
test("candidate-specific public verification does not grant acceptance or ordinary publication", () => {
  const input = fixture();
  const before = globalThis.structuredClone(input);
  const review = { artifactsVerified: true, ...admit(input) };
  assertDistributionActionAllowed(review, "publish-for-verification");
  assert.throws(() => assertDistributionActionAllowed(review, "publish"));
  assert.equal(review.releaseCompleted, false);
  assert.deepEqual(input, before);
});
test("no implicit approval, different candidate, channel mode or version", () => {
  assert.equal(
    publicDeliveryAdmission(policy, fixture(), approval.version).publicDeliveryVerificationAllowed,
    false,
  );
  for (const args of [
    [policy, fixture(), approval.version, "other"],
    [policy, fixture(), "0.1.0", approval.id],
    [{ releaseMode: "signed" }, fixture(), approval.version, approval.id],
    [
      policy,
      {
        ...fixture(),
        candidate: { setupSha256: "a".repeat(64), manifestSha256: approval.manifestSha256 },
      },
      approval.version,
      approval.id,
    ],
  ])
    assert.throws(() => publicDeliveryAdmission(...args));
});
test("every other gate must pass; omission and duplicate gate cannot admit", () => {
  for (let index = 0; index < 16; index++) {
    if ([3, 15].includes(index)) continue;
    for (const status of ["pending", "partial", "failed", "blocked"]) {
      const input = fixture();
      input.gates[index].status = status;
      assert.throws(() => admit(input));
    }
  }
  const short = fixture();
  short.gates.pop();
  assert.throws(() => admit(short));
  const duplicate = fixture();
  duplicate.gates[0] = duplicate.gates[1];
  assert.throws(() => admit(duplicate));
});
test("both deferred gates need final candidate-bound prepublication evidence", () => {
  for (const index of [3, 15]) {
    for (const change of [
      (g) => {
        g.status = "failed";
      },
      (g) => {
        g.scope = "historical";
      },
      (g) => {
        g.candidate = { ...g.candidate, setupSha256: "c".repeat(64) };
      },
      (g) => {
        delete g.prePublication;
      },
      (g) => {
        g.prePublication.evidence = [];
      },
      (g) => {
        g.prePublication.status = "pending";
      },
    ]) {
      const input = fixture();
      change(input.gates[index]);
      assert.throws(() => admit(input));
    }
  }
  const input = fixture();
  input.gates[15].wingetManifestValidation = "pending";
  assert.throws(() => admit(input));
});
