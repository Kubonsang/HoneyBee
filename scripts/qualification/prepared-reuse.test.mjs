import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { mkdir, mkdtemp, writeFile, readFile } from "node:fs/promises";
import { sha256 } from "../update/release-manifest.mjs";
import { prepareMatrixUpdate, priorControllerNonce } from "./prepared-reuse.mjs";

test("named topology bridge explicitly admits service preparation and reuse", async () => {
  const f = await fixture();
  f.options.step.name = "topology-bridge";
  f.options.step.serviceUpdate = true;
  f.deps.verify = async (options) => assert.equal(options.allowServiceCandidate, true);
  await prepareMatrixUpdate(f.options, f.deps);
  f.options.step.manifestSha256 = sha256("new manifest");
  f.deps.prepare = async (options) => {
    assert.equal(options.allowServiceUpdate, true);
    assert.equal(options.mediaDirectory, path.join(f.root, "updates/topology-bridge"));
    return "prepared";
  };
  assert.equal(await prepareMatrixUpdate(f.options, f.deps), "prepared");
  delete f.options.step.serviceUpdate;
  f.deps.prepare = async (options) => assert.equal(options.allowServiceUpdate, false);
  await prepareMatrixUpdate(f.options, f.deps);
});
async function fixture() {
  const base = path.resolve("output/prepared-reuse-tests");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "case-"));
  const pointer = JSON.stringify({ activeVersion: "11" });
  await writeFile(path.join(root, "current.json"), pointer);
  await mkdir(path.join(root, "update/jobs/job-Good"), { recursive: true });
  await mkdir(path.join(root, "recovery/v1"), { recursive: true });
  await writeFile(path.join(root, "recovery/v1/update-trust.json"), '{"publicKeys":{}}');
  const step = { name: "service", from: "11", to: "12", manifestSha256: sha256("manifest") };
  const request = JSON.stringify({
    operation: "prepare",
    sourcePointerSha256: sha256(pointer),
    manifestSha256: step.manifestSha256,
    stage: "stage-Valid",
  });
  await writeFile(path.join(root, "update/jobs/job-Good/request.json"), request);
  const planPath = path.join(root, "update/plan.json");
  await writeFile(
    planPath,
    JSON.stringify({
      manifestSha256: step.manifestSha256,
      stageAttempt: "stage-Valid",
      identity: { targetVersion: "12" },
    }),
  );
  const receipt = {
    schemaVersion: 1,
    passed: true,
    requestSha256: sha256(request),
    result: {
      version: "12",
      state: "ReadyForActivation",
      activationAllowed: false,
      sourcePointerSha256: sha256(pointer),
      manifestSha256: step.manifestSha256,
      planPath,
    },
  };
  const receiptPath = path.join(root, "update/jobs/job-Good/result.json");
  await writeFile(receiptPath, JSON.stringify(receipt));
  const calls = [];
  const deps = {
    prepare: async () => {
      throw Error("must not prepare again");
    },
    authenticate: async () => {
      calls.push("authenticate");
      return { manifest: { version: "12" } };
    },
    revalidate: async () => calls.push("revalidate"),
    verify: async () => calls.push("verify"),
  };
  return {
    options: { installationRoot: root, bundle: root, step },
    root,
    receipt,
    receiptPath,
    deps,
    calls,
  };
}
test("reuse authenticates and revalidates before returning original preparation without modifying it", async () => {
  const f = await fixture();
  const before = await readFile(f.receiptPath);
  const result = await prepareMatrixUpdate(f.options, f.deps);
  assert.equal(result.preparation.name, "job-Good");
  assert.deepEqual(f.calls, ["authenticate", "revalidate", "verify"]);
  assert.deepEqual(await readFile(f.receiptPath), before);
});
test("altered receipt binding refuses reuse before verification or mutation", async () => {
  const f = await fixture();
  f.receipt.requestSha256 = sha256("changed");
  await writeFile(f.receiptPath, JSON.stringify(f.receipt));
  await assert.rejects(prepareMatrixUpdate(f.options, f.deps));
  assert.deepEqual(f.calls, []);
});
test("signature, source and published-file rejection never falls back to overwriting", async () => {
  for (const name of ["authenticate", "revalidate", "verify"]) {
    const f = await fixture();
    f.deps[name] = async () => {
      throw Error(name + " rejected");
    };
    await assert.rejects(prepareMatrixUpdate(f.options, f.deps), new RegExp(name + " rejected"));
  }
});
test("retry finds original controller nonce across a preparation-only failed attempt", async () => {
  const f = await fixture();
  const prior = path.join(f.root, "kill-service-backup-verified-attempt-001");
  const first = path.join(f.root, "kill-service-backup-verified-attempt-000");
  await mkdir(prior);
  await mkdir(first);
  await writeFile(path.join(first, "worker.json"), JSON.stringify({ nonce: "a".repeat(64) }));
  assert.equal(await priorControllerNonce(prior), "a".repeat(64));
  await writeFile(path.join(prior, "worker.json"), JSON.stringify({ nonce: "b".repeat(64) }));
  await writeFile(
    path.join(prior, "failed.json"),
    JSON.stringify({ error: "launch-native-fault.ps1: The operation was canceled by the user." }),
  );
  assert.equal(await priorControllerNonce(prior), "a".repeat(64));
  await writeFile(path.join(prior, "native-ready.json"), "{}");
  assert.equal(await priorControllerNonce(prior), "b".repeat(64));
});
