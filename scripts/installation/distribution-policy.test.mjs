import assert from "node:assert/strict";
import test from "node:test";
import {
  assertDistributionActionAllowed,
  distributionPolicy,
  distributionReadiness,
} from "./distribution-policy.mjs";
import {
  createFinalAcceptance,
  summarizeFinalAcceptance,
} from "../qualification/final-acceptance.mjs";

const manifest = { version: "0.1.0-beta.12", channel: "beta" };
const candidate = { setupSha256: "a".repeat(64), manifestSha256: "b".repeat(64) };
const unsigned = { releaseMode: "unsigned-beta" };
test("verified drafts can be staged without granting public release readiness", () => {
  const review = { artifactsVerified: true, unsignedBetaReady: false, signedReleaseReady: false };
  assert.doesNotThrow(() => assertDistributionActionAllowed(review, "stage"));
  assert.throws(() => assertDistributionActionAllowed(review, "publish"), /unresolved/);
  assert.equal(review.unsignedBetaReady, false);
});
test("both actions require verified artifacts and a recognized action", () => {
  for (const action of ["stage", "publish"])
    assert.throws(() => assertDistributionActionAllowed({ unsignedBetaReady: true }, action));
  assert.throws(() => assertDistributionActionAllowed({ artifactsVerified: true }, "force"));
});
test("publish requires an explicit boolean readiness decision", () => {
  assert.doesNotThrow(() =>
    assertDistributionActionAllowed(
      { artifactsVerified: true, unsignedBetaReady: true },
      "publish",
    ),
  );
  assert.doesNotThrow(() =>
    assertDistributionActionAllowed(
      { artifactsVerified: true, signedReleaseReady: true },
      "publish",
    ),
  );
  assert.throws(() =>
    assertDistributionActionAllowed(
      { artifactsVerified: true, unsignedBetaReady: "true" },
      "publish",
    ),
  );
});
const readyInput = () => {
  const input = createFinalAcceptance(candidate);
  for (const gate of input.gates)
    Object.assign(gate, {
      status: "passed",
      scope: "final",
      candidate,
      evidence: ["fixture-qualified"],
    });
  Object.assign(input.gates.at(-1), {
    status: "partial",
    authenticode: "deferred",
    wingetLocal: "passed",
  });
  return input;
};

test("default distribution requires a real certificate pin; beta opt-in is explicit", () => {
  assert.throws(() => distributionPolicy({}, manifest), /certificate pin/);
  const signed = distributionPolicy({ publisherThumbprint: "c".repeat(40) }, manifest);
  assert.equal(signed.releaseMode, "signed");
  assert.equal(signed.publisherThumbprint, "C".repeat(40));
  assert.equal(distributionPolicy(unsigned, manifest).authenticode, "not-signed");
  assert.throws(() =>
    distributionPolicy({ ...unsigned, publisherThumbprint: "c".repeat(40) }, manifest),
  );
  assert.throws(() => distributionPolicy({ releaseMode: "skip" }, manifest));
});

test("unsigned beta cannot admit stable channels or stable versions", () => {
  assert.throws(() => distributionPolicy(unsigned, { ...manifest, channel: "stable" }));
  assert.throws(() => distributionPolicy(unsigned, { ...manifest, version: "0.1.0" }));
});

test("only the certificate exception permits beta readiness; full readiness remains false", () => {
  const acceptance = summarizeFinalAcceptance(readyInput());
  const result = distributionReadiness(distributionPolicy(unsigned, manifest), acceptance);
  assert.equal(result.unsignedBetaReady, true);
  assert.equal(result.signedReleaseReady, false);
  assert.equal(result.prereleaseRequired, true);
  assert.equal(acceptance.ready, false);
  const signed = distributionPolicy({ publisherThumbprint: "c".repeat(40) }, manifest);
  assert.equal(distributionReadiness(signed, acceptance).signedReleaseReady, false);
});

test("missing final coverage or another incomplete gate blocks beta publication", () => {
  for (const mutation of [
    (input) => {
      input.gates[0].status = "partial";
    },
    (input) => {
      input.gates[8].status = "failed";
    },
    (input) => {
      delete input.gates.at(-1).wingetLocal;
    },
    (input) => {
      delete input.gates.at(-1).authenticode;
    },
    (input) => {
      input.gates.at(-1).candidate = { ...candidate, setupSha256: "c".repeat(64) };
    },
    (input) => {
      input.gates.at(-1).scope = "fixture";
    },
  ]) {
    const input = readyInput();
    mutation(input);
    const result = distributionReadiness(
      distributionPolicy(unsigned, manifest),
      summarizeFinalAcceptance(input),
    );
    assert.equal(result.unsignedBetaReady, false);
  }
});
