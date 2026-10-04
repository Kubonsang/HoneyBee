import assert from "node:assert/strict";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { digestFile } from "./release-verification.mjs";

export const orphanedNativeCases = Object.freeze([
  "empty",
  "missing",
  "lock-retry-idempotent",
  "residual-file",
  "residual-directory",
  "junction",
  "ownership-mismatch",
]);

export async function verifyOrphanedNativeEvidence(
  receipt,
  { source, candidate, computer, directory, outputRoot },
) {
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.ok, true);
  assert.deepEqual(receipt.source, source, "Orphaned cleanup source mismatch");
  assert.deepEqual(receipt.candidate, candidate, "Orphaned cleanup candidate mismatch");
  assert.deepEqual(receipt.environment, { kind: "physical-host", computer, filesystem: "NTFS" });
  for (const key of [
    "originalRestored",
    "originalServiceRunning",
    "protectedDataPreserved",
    "branchesPreserved",
  ])
    assert.equal(receipt[key], true, `Orphaned cleanup ${key} required`);
  assert.equal(receipt.pendingTransactions, 0);
  assert.equal(receipt.storageComponent, "0.0.0+cfa606fd4143.hb16");
  assert.equal(receipt.cases?.length, orphanedNativeCases.length * 2);
  const files = [];
  const seen = new Set();
  const root = (await realpath(outputRoot)) + path.sep;
  for (const client of ["cli", "desktop"])
    for (const name of orphanedNativeCases) {
      const cases = receipt.cases.filter((c) => c.client === client && c.name === name);
      assert.equal(cases.length, 1, `Missing or duplicate ${client}:${name}`);
      const item = cases[0];
      assert.equal(item.passed, true);
      assert.equal(item.realRetainedStorage, true, "Synthetic storage is not native evidence");
      assert.equal(item.branchPreserved, true);
      assert.equal(typeof item.log?.path, "string");
      assert(/^[a-f0-9]{64}$/u.test(item.log.sha256 ?? ""));
      const file = path.resolve(directory, item.log.path);
      assert((await lstat(file)).isFile());
      const physical = await realpath(file);
      assert(physical.startsWith(root), "Native log escapes owned output");
      assert(!seen.has(physical), "Native case logs must be distinct");
      seen.add(physical);
      assert.equal(await digestFile(file), item.log.sha256, "Native case log changed");
      files.push(file);
    }
  return files;
}
