import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import {
  verifyOpticalPredecessor,
  verifyQuiescePredecessor,
  verifyBackupPredecessor,
  verifyCompressionPredecessor,
  verifyActivityPredecessor,
} from "./topology-optical-predecessor.mjs";

async function fixture(t) {
  const bundle = await mkdtemp(path.join(os.tmpdir(), "hb-optical-predecessor-"));
  t.after(() => rm(bundle, { recursive: true, force: true }));
  const installationRoot = path.join(bundle, "installed");
  const args = {
    bundle,
    installationRoot,
    before: { projectId: "original", registrySha256: "original" },
    dataset: { dirtyFiles: true },
    sourcePointerSha256: "a".repeat(64),
    originalInputsSha256: "b".repeat(64),
  };
  const transactionDirectory = path.join(
    installationRoot,
    "update/combined",
    "6c55ec2fe97e259bca01e40d60a7496ace9cc43b380ae895f2d2785e86f5e9b6",
  );
  const record = {
    schemaVersion: 1,
    state: "RolledBack",
    preserved: true,
    doctor: { ready: true },
    acceptancePromoted: false,
    publicationAllowed: false,
    originalInputsSha256: args.originalInputsSha256,
    bridgeManifestSha256: "d824146588cd80b4e99a33f5b05e5702a89340481fb82a75af8668043191e6d9",
    before: args.before,
    dataset: args.dataset,
    current: { activeVersion: "0.1.0-beta.11" },
    result: { state: "RolledBack", reason: "Incorrect function.", transactionDirectory },
  };
  const file = path.join(bundle, "Transitions/topology1/Execution/PreparationRetry/result.json");
  await mkdir(path.dirname(file), { recursive: true });
  const save = () => writeFile(file, JSON.stringify(record));
  await save();
  return { args, record, file, save, transactionDirectory };
}

test("quiesce transition requires its own reviewed beta.19 rollback", async (t) => {
  const f = await fixture(t);
  const file = path.join(f.args.bundle, "Transitions/topology2/Execution/result.json");
  await mkdir(path.dirname(file), { recursive: true });
  const record = globalThis.structuredClone(f.record);
  record.bridgeManifestSha256 = "9fc02181af8ea32ce4190f0a74e5d7f4121ff145a4f8828e2896a838b6fd258f";
  record.result.reason = "The specified network resource or device is no longer available.";
  record.result.transactionDirectory = path.join(
    f.args.installationRoot,
    "update/combined",
    "059ba7a6e18a488ccc3eea96ed2f9e53be18361f478a9fe32d15ce5c22f1d629",
  );
  await writeFile(file, JSON.stringify(record));
  let calls = 0;
  const dependencies = {
    readOutcome: async (options) => {
      calls++;
      assert.equal(options.transactionDirectory, record.result.transactionDirectory);
      return { state: "RolledBack", version: "0.1.0-beta.11" };
    },
  };
  await verifyQuiescePredecessor(f.args, dependencies);
  assert.equal(calls, 1);
  record.result.reason = "Incorrect function.";
  await writeFile(file, JSON.stringify(record));
  await assert.rejects(verifyQuiescePredecessor(f.args, dependencies));
  assert.equal(calls, 1);
});

test("backup transition requires its own reviewed beta.20 rollback", async (t) => {
  const f = await fixture(t);
  const file = path.join(f.args.bundle, "Transitions/topology3/Execution/result.json");
  await mkdir(path.dirname(file), { recursive: true });
  const record = globalThis.structuredClone(f.record);
  record.bridgeManifestSha256 = "4a769bd45f101b5bf7a5489c6460096e2a118e37ae96af4999d445375b361287";
  record.result.reason = "store entry has unsupported NTFS attributes";
  record.result.transactionDirectory = path.join(
    f.args.installationRoot,
    "update/combined",
    "ec7a06a0bfe48ba53a70e46c2cbcb093be10590ccf18e0245387ee23a650cdb0",
  );
  await writeFile(file, JSON.stringify(record));
  let calls = 0;
  const dependencies = {
    readOutcome: async (options) => {
      calls++;
      assert.equal(options.transactionDirectory, record.result.transactionDirectory);
      return { state: "RolledBack", version: "0.1.0-beta.11" };
    },
  };
  await verifyBackupPredecessor(f.args, dependencies);
  assert.equal(calls, 1);
  record.result.reason = "Incorrect function.";
  await writeFile(file, JSON.stringify(record));
  await assert.rejects(verifyBackupPredecessor(f.args, dependencies));
  assert.equal(calls, 1);
});

test("compression transition requires its own reviewed beta.21 rollback", async (t) => {
  const f = await fixture(t);
  const file = path.join(f.args.bundle, "Transitions/topology4/Execution/result.json");
  await mkdir(path.dirname(file), { recursive: true });
  const record = globalThis.structuredClone(f.record);
  record.bridgeManifestSha256 = "fd1e6a6b5be5712a45e024e5dbd561665770b34bff3871beb6493a667d290d2a";
  record.result.reason =
    'before store backup: inventory store entry "C:\\\\ProgramData\\\\UnityWorkspaceStorage\\\\S-1-5-21-4199076252-3622841657-4011401391-1001\\\\children\\\\lease-43d0116a8935f0e309d631b1488da3b2.bee\\\\data": store entry has unsupported NTFS attributes: attributes=0x00002810 unsupported=0x00000800 expectedDirectory=true';
  record.result.transactionDirectory = path.join(
    f.args.installationRoot,
    "update/combined",
    "4e76687a86ba4a9763b0e37bb651a5828b2248189b49dc5ba6a4f76b59cb2b2c",
  );
  await writeFile(file, JSON.stringify(record));
  let calls = 0;
  const dependencies = {
    readOutcome: async (options) => {
      calls++;
      assert.equal(options.transactionDirectory, record.result.transactionDirectory);
      return { state: "RolledBack", version: "0.1.0-beta.11" };
    },
  };
  await verifyCompressionPredecessor(f.args, dependencies);
  assert.equal(calls, 1);
  record.result.reason = "Incorrect function.";
  await writeFile(file, JSON.stringify(record));
  await assert.rejects(verifyCompressionPredecessor(f.args, dependencies));
  assert.equal(calls, 1);
});

test("activity transition requires its own reviewed beta.22 rollback", async (t) => {
  const f = await fixture(t);
  const file = path.join(f.args.bundle, "Transitions/topology5/Execution/result.json");
  await mkdir(path.dirname(file), { recursive: true });
  const record = globalThis.structuredClone(f.record);
  record.bridgeManifestSha256 = "5212d7056e87a948efd001c61fc6daf735b4ca9023fa086aa4561f6a5e083afb";
  record.result.reason = "Validation Desktop readiness timed out";
  record.result.transactionDirectory = path.join(
    f.args.installationRoot,
    "update/combined",
    "dc4e70bf74fbd3b507c4e8a5e591c5e049f4f32fcbb977193e1707050440d076",
  );
  await writeFile(file, JSON.stringify(record));
  let calls = 0;
  const dependencies = {
    readOutcome: async (options) => {
      calls++;
      assert.equal(options.transactionDirectory, record.result.transactionDirectory);
      return { state: "RolledBack", version: "0.1.0-beta.11" };
    },
  };
  await verifyActivityPredecessor(f.args, dependencies);
  assert.equal(calls, 1);
  record.result.reason = "Incorrect function.";
  await writeFile(file, JSON.stringify(record));
  await assert.rejects(verifyActivityPredecessor(f.args, dependencies));
  assert.equal(calls, 1);
});

test("optical transition verifies the actual terminal journal and preserves prior evidence", async (t) => {
  const f = await fixture(t),
    before = await readFile(f.file);
  let called = false;
  await verifyOpticalPredecessor(f.args, {
    readOutcome: async (options) => {
      called = true;
      assert.deepEqual(options, {
        installationRoot: f.args.installationRoot,
        transactionDirectory: f.transactionDirectory,
        sourcePointerSha256: f.args.sourcePointerSha256,
      });
      return { state: "RolledBack", version: "0.1.0-beta.11" };
    },
  });
  assert(called);
  assert.deepEqual(await readFile(f.file), before);
});

for (const [name, change] of [
  [
    "different failure",
    (r) => {
      r.result.reason = "access denied";
    },
  ],
  [
    "different transaction",
    (r) => {
      r.result.transactionDirectory = path.dirname(r.result.transactionDirectory);
    },
  ],
  [
    "changed preserved dataset",
    (r) => {
      r.dataset = { dirtyFiles: false };
    },
  ],
  [
    "unsuccessful Doctor",
    (r) => {
      r.doctor.ready = false;
    },
  ],
])
  test("optical transition refuses " + name, async (t) => {
    const f = await fixture(t);
    change(f.record);
    await f.save();
    let called = false;
    await assert.rejects(
      verifyOpticalPredecessor(f.args, {
        readOutcome: async () => {
          called = true;
        },
      }),
    );
    assert.equal(called, false);
  });

test("saved rollback cannot authorize a nonterminal or changed journal", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    verifyOpticalPredecessor(f.args, {
      readOutcome: async () => {
        throw new Error("journal changed");
      },
    }),
    /journal changed/,
  );
  await assert.rejects(
    verifyOpticalPredecessor(f.args, {
      readOutcome: async () => ({ state: "Committed", version: "0.1.0-beta.15" }),
    }),
  );
});
