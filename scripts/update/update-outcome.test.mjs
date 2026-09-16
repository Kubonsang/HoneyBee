import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { sha256 } from "./release-manifest.mjs";
import { readUpdateOutcome, trackActivationJob } from "./update-outcome.mjs";
import { combinedUpdateIdentity } from "./combined-update.mjs";

for (const terminal of ["Committed", "RolledBack"])
  test(`interrupted combined job displays recovered ${terminal} from its bound journal`, async () => {
    const f = await fixture();
    const identity = {
      manifestSha256: sha256("release"),
      sourcePointerSha256: sha256(f.source),
      serviceTransactionSha256: sha256("service"),
    };
    const id = combinedUpdateIdentity(identity),
      directory = path.join(f.root, "update/combined", id);
    await mkdir(directory, { recursive: true });
    await mkdir(path.join(f.root, "update/combined-contexts"));
    await writeFile(
      path.join(f.root, "update/combined-contexts", id + ".json"),
      JSON.stringify({
        identity,
        sourcePointer: globalThis.Buffer.from(f.source).toString("base64"),
        targetPointer: globalThis.Buffer.from(f.target).toString("base64"),
      }),
    );
    const binding = {
      schemaVersion: 1,
      requestSha256: f.receipt.requestSha256,
      identitySha256: id,
    };
    await writeFile(path.join(f.job, "combined-transaction.json"), JSON.stringify(binding));
    await unlink(path.join(f.job, "result.json"));
    const states =
      terminal === "Committed"
        ? ["Prepared", "ServiceReady", "AppSelected", "DesktopReady", "Committing", "Committed"]
        : ["Prepared", "RollingBack", "RolledBack"];
    let previous = id;
    for (const [index, state] of states.entries()) {
      const bytes = JSON.stringify({
        schemaVersion: 1,
        identitySha256: id,
        previousSha256: previous,
        state,
      });
      await writeFile(path.join(directory, String(index + 1).padStart(2, "0") + ".json"), bytes);
      previous = sha256(bytes);
    }
    await writeFile(
      path.join(f.root, "current.json"),
      terminal === "Committed" ? f.target : f.source,
    );
    assert.equal(
      (await readUpdateOutcome(f.root)).state,
      terminal === "Committed" ? "Updated" : "RolledBack",
    );
    binding.requestSha256 = sha256("other job");
    await writeFile(path.join(f.job, "combined-transaction.json"), JSON.stringify(binding));
    assert.equal((await readUpdateOutcome(f.root)).state, "Unresolved");
  });

async function fixture(state = "Committed") {
  const base = path.resolve("output/update-outcome-tests");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "case-"));
  const job = path.join(root, "update/jobs/job-ABC"),
    transaction = path.join(root, "update/activations/activation-ABC");
  await mkdir(job, { recursive: true });
  await mkdir(transaction, { recursive: true });
  const source = JSON.stringify({
    schemaVersion: 1,
    generation: 1,
    activeVersion: "0.1.0-beta.11",
    manifestSha256: sha256("source"),
  });
  const target = JSON.stringify({
    schemaVersion: 1,
    generation: 2,
    activeVersion: "0.1.0-beta.12",
    manifestSha256: sha256("target"),
  });
  const intent = JSON.stringify({
    schemaVersion: 1,
    kind: "app-pointer-v1",
    sourcePointerSha256: sha256(source),
    targetPointerSha256: sha256(target),
  });
  for (const [name, bytes] of [
    ["source.json", source],
    ["target.json", target],
    ["intent.json", intent],
  ])
    await writeFile(path.join(transaction, name), bytes);
  for (const name of state === "Committed"
    ? ["Switching", "Switched", "Committed"]
    : ["Switching", "Switched", "RollingBack", "RolledBack"])
    await writeFile(
      path.join(transaction, name + ".state.json"),
      JSON.stringify({ schemaVersion: 1, state: name, intentSha256: sha256(intent) }),
    );
  const request = JSON.stringify({
    schemaVersion: 1,
    operation: "activate",
    sourcePointerSha256: sha256(source),
  });
  await writeFile(path.join(job, "request.json"), request);
  const receipt = {
    schemaVersion: 1,
    passed: true,
    requestSha256: sha256(request),
    result: { state, restart: "Ready", transactionDirectory: transaction },
  };
  await writeFile(path.join(job, "result.json"), JSON.stringify(receipt));
  await writeFile(path.join(root, "current.json"), state === "Committed" ? target : source);
  await trackActivationJob(root, { name: "job-ABC", sha256: sha256(request) });
  return { root, job, transaction, source, target, receipt };
}
for (const state of ["Committed", "RolledBack"])
  test(`${state} requires terminal journal and exact current pointer`, async () => {
    const f = await fixture(state),
      before = await readFile(path.join(f.root, "current.json"));
    const result = await readUpdateOutcome(f.root);
    assert.equal(result.state, state === "Committed" ? "Updated" : "RolledBack");
    assert.deepEqual(await readFile(path.join(f.root, "current.json")), before);
  });
for (const failure of [
  "missing-result",
  "request-changed",
  "result-binding",
  "missing-terminal",
  "pointer-changed",
  "conflicting-terminal",
  "outside-journal",
])
  test(`outcome ${failure} never claims success`, async () => {
    const f = await fixture();
    if (failure === "missing-result") await unlink(path.join(f.job, "result.json"));
    if (failure === "request-changed") await writeFile(path.join(f.job, "request.json"), "{}");
    if (failure === "result-binding") {
      f.receipt.requestSha256 = sha256("different");
      await writeFile(path.join(f.job, "result.json"), JSON.stringify(f.receipt));
    }
    if (failure === "missing-terminal")
      await unlink(path.join(f.transaction, "Committed.state.json"));
    if (failure === "pointer-changed") await writeFile(path.join(f.root, "current.json"), f.source);
    if (failure === "conflicting-terminal")
      await writeFile(
        path.join(f.transaction, "RolledBack.state.json"),
        JSON.stringify({
          schemaVersion: 1,
          state: "RolledBack",
          intentSha256: sha256(await readFile(path.join(f.transaction, "intent.json"))),
        }),
      );
    if (failure === "outside-journal") {
      f.receipt.result.transactionDirectory = f.root;
      await writeFile(path.join(f.job, "result.json"), JSON.stringify(f.receipt));
    }
    assert.equal((await readUpdateOutcome(f.root)).state, "Unresolved");
  });
test("restart failure is displayed as failure while preserving a committed pointer", async () => {
  const f = await fixture();
  f.receipt.result.restart = "Failed";
  await writeFile(path.join(f.job, "result.json"), JSON.stringify(f.receipt));
  assert.equal((await readUpdateOutcome(f.root)).state, "Failed");
  assert.equal(await readFile(path.join(f.root, "current.json"), "utf8"), f.target);
});
test("no marker means no outcome; a late result can resolve without replay", async () => {
  const f = await fixture();
  const result = await readFile(path.join(f.job, "result.json"));
  await unlink(path.join(f.job, "result.json"));
  assert.equal((await readUpdateOutcome(f.root)).state, "Unresolved");
  await writeFile(path.join(f.job, "result.json"), result);
  assert.equal((await readUpdateOutcome(f.root)).state, "Updated");
  await unlink(path.join(f.root, "update/latest-activation.json"));
  assert.equal(await readUpdateOutcome(f.root), undefined);
});
