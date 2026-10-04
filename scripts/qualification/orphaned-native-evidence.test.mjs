import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { orphanedNativeCases, verifyOrphanedNativeEvidence } from "./orphaned-native-evidence.mjs";

test("orphaned native evidence rejects stale source, synthetic storage, omitted cases and changed logs", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "hb-orphan-evidence-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = { commit: "a".repeat(40), inventorySha256: "b".repeat(64) };
  const candidate = { setupSha256: "c".repeat(64), manifestSha256: "d".repeat(64) };
  const receipt = {
    schemaVersion: 1,
    ok: true,
    source,
    candidate,
    environment: { kind: "physical-host", computer: "test-host", filesystem: "NTFS" },
    originalRestored: true,
    originalServiceRunning: true,
    protectedDataPreserved: true,
    branchesPreserved: true,
    pendingTransactions: 0,
    storageComponent: "0.0.0+cfa606fd4143.hb16",
    cases: [],
  };
  for (const client of ["cli", "desktop"])
    for (const name of orphanedNativeCases) {
      const log = client + "-" + name + ".log";
      const bytes = client + ":" + name;
      await writeFile(path.join(directory, log), bytes);
      receipt.cases.push({
        client,
        name,
        passed: true,
        realRetainedStorage: true,
        branchPreserved: true,
        log: { path: log, sha256: createHash("sha256").update(bytes).digest("hex") },
      });
    }
  const options = { source, candidate, computer: "test-host", directory, outputRoot: directory };
  assert.equal((await verifyOrphanedNativeEvidence(receipt, options)).length, 14);
  for (const mutate of [
    (r) => {
      r.source.commit = "e".repeat(40);
    },
    (r) => {
      r.candidate.setupSha256 = "f".repeat(64);
    },
    (r) => {
      r.originalRestored = false;
    },
    (r) => {
      r.pendingTransactions = 1;
    },
    (r) => {
      r.cases.pop();
    },
    (r) => {
      r.cases[0] = r.cases[1];
    },
    (r) => {
      r.cases[0].realRetainedStorage = false;
    },
    (r) => {
      r.cases[0].passed = false;
    },
    (r) => {
      r.cases[0].log = r.cases[1].log;
    },
    (r) => {
      r.storageComponent = "hb12";
    },
  ]) {
    const changed = globalThis.structuredClone(receipt);
    mutate(changed);
    await assert.rejects(verifyOrphanedNativeEvidence(changed, options));
  }
  await writeFile(path.join(directory, receipt.cases[0].log.path), "changed");
  await assert.rejects(verifyOrphanedNativeEvidence(receipt, options), /log changed/);
});
