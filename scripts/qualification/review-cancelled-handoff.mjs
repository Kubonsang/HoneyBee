import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFile, readdir, lstat } from "node:fs/promises";
import path from "node:path";
import { sha256 } from "../update/release-manifest.mjs";
import { combinedUpdateIdentity, readCombinedOutcome } from "../update/combined-update.mjs";
import { plainDirectory } from "../update/stage-release.mjs";

// A cancelled elevation precedes native admission and the combined journal.
// Retain its context and job; a new authenticated job performs the handoff.
export async function reviewCancelledHandoff(root, inputs) {
  const json = async (file) => JSON.parse(await readFile(file, "utf8"));
  const absent = async (file) => {
    try {
      await lstat(file);
      return false;
    } catch (error) {
      if (error.code === "ENOENT") return true;
      throw error;
    }
  };
  const current = await readFile(path.join(root, "current.json"));
  assert.equal(JSON.parse(current).activeVersion, inputs.servicePair.source.version);
  const contexts = path.join(root, "update/combined-contexts");
  await plainDirectory(contexts);
  const candidates = [];
  for (const name of await readdir(contexts)) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
    const context = await json(path.join(contexts, name));
    const id = combinedUpdateIdentity(context.identity);
    assert.equal(name, id + ".json");
    const directory = path.join(root, "update/combined", id);
    if (!(await absent(directory))) {
      // No unfinished service transaction may be bypassed.
      await readCombinedOutcome({
        installationRoot: root,
        transactionDirectory: directory,
        sourcePointerSha256: context.identity.sourcePointerSha256,
      });
      continue;
    }
    assert.equal(context.identity.sourcePointerSha256, sha256(current));
    assert.deepEqual(Buffer.from(context.sourcePointer, "base64"), current);
    assert.equal(context.identity.manifestSha256, inputs.updates[0].manifestSha256);
    assert.equal(
      JSON.parse(Buffer.from(context.targetPointer, "base64")).activeVersion,
      inputs.servicePair.target.version,
    );
    assert(
      await absent(
        path.join(root, "update/service-contexts", context.identity.serviceTransactionSha256),
      ),
      "Native service admission exists; cancellation-only resume refused",
    );
    candidates.push(id);
  }
  assert.equal(candidates.length, 1, "Expected exactly one cancelled pre-admission handoff");
  const jobs = path.join(root, "update/jobs");
  await plainDirectory(jobs);
  const matches = [];
  for (const name of await readdir(jobs)) {
    if (!/^job-[A-Za-z0-9]+$/.test(name)) continue;
    const receiptPath = path.join(jobs, name, "combined-transaction.json");
    if (await absent(receiptPath)) continue;
    const receipt = await json(receiptPath);
    if (receipt.identitySha256 !== candidates[0]) continue;
    const request = await readFile(path.join(jobs, name, "request.json"));
    assert.equal(sha256(request), receipt.requestSha256);
    assert.equal(JSON.parse(request).sourcePointerSha256, sha256(current));
    matches.push(name);
  }
  assert.equal(matches.length, 1);
  return {
    schemaVersion: 1,
    cancelledBeforeAdmission: true,
    identitySha256: candidates[0],
    job: matches[0],
    sourcePointerSha256: sha256(current),
  };
}
