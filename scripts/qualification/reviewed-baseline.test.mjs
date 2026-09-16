import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { readReviewedBaseline, assertReviewedRepair } from "./reviewed-baseline.mjs";

test("reviewed Repair admits only pinned registry bytes and one exact timestamp; data and bindings stay strict", () => {
  const before = {
    schemaVersion: 1,
    registrySha256: "9fc408def4aa791d8ff4886c56004a221ec40af419d076b44a6578ef09a59b04",
    workspaces: [
      {
        workspaceId: "8934fa61-ed64-4851-8535-261ce5109487",
        updatedAt: "2026-09-14T15:04:06.552Z",
        leaseId: "preserved",
        mountPath: "original",
      },
    ],
    repositories: [{ head: "original", files: { dirty: "same" } }],
  };
  const after = globalThis.structuredClone(before);
  after.registrySha256 = "02570755a84eb636281e984160d10606878be5037ea725f096959e0731da503a";
  after.workspaces[0].updatedAt = "2026-09-16T03:50:57.510Z";
  const review = "preserved-20260916T035057";
  assertReviewedRepair(before, after, review);
  assert.equal(before.workspaces[0].updatedAt, "2026-09-14T15:04:06.552Z");
  for (const mutate of [
    (x) => (x.registrySha256 = "other"),
    (x) => (x.workspaces[0].updatedAt = "later"),
    (x) => (x.workspaces[0].leaseId = "other"),
    (x) => (x.workspaces[0].mountPath = "other"),
    (x) => (x.repositories[0].head = "other"),
    (x) => (x.repositories[0].files.dirty = "lost"),
  ]) {
    const changed = globalThis.structuredClone(after);
    mutate(changed);
    assert.throws(() => assertReviewedRepair(before, changed, review));
  }
  assert.throws(() => assertReviewedRepair(before, after, "unreviewed"));
});
const specification = {
  kind: "committed-populated-beta22",
  transaction: "8a79bcbce67c3e19da9e718536dccb6259dd17de54efac491c5c03b5d079b707",
  evidence:
    "C:\\HoneyBeeQA\\final-integrated-20260914\\Transitions\\topology6\\Execution\\result.json",
};
for (const scenario of [
  "valid",
  "rollback",
  "dirty-change",
  "wrong-manifest",
  "nonterminal-journal",
])
  test("reviewed baseline " + scenario, async () => {
    const installationRoot = path.resolve("output/reviewed-baseline-test");
    const before = { schemaVersion: 1, project: "preserved" };
    const record = {
      state: "Committed",
      preserved: true,
      doctor: { ready: true },
      bridgeManifestSha256: "5212d7056e87a948efd001c61fc6daf735b4ca9023fa086aa4561f6a5e083afb",
      current: { activeVersion: "0.1.0-beta.22" },
      result: {
        transactionDirectory: path.join(
          installationRoot,
          "update/combined",
          specification.transaction,
        ),
      },
      dataset: { projectId: "test" },
      before,
    };
    if (scenario === "rollback") record.state = "RolledBack";
    if (scenario === "wrong-manifest") record.bridgeManifestSha256 = "a".repeat(64);
    const hooks = {
      read: async () => JSON.stringify(record),
      snapshot: async () =>
        scenario === "dirty-change" ? { ...before, project: "changed" } : before,
      outcome: async () => ({
        state: scenario === "nonterminal-journal" ? "AppSelected" : "Committed",
        version: "0.1.0-beta.22",
      }),
    };
    if (scenario !== "valid")
      await assert.rejects(readReviewedBaseline({ installationRoot, specification }, hooks));
    else {
      const result = await readReviewedBaseline({ installationRoot, specification }, hooks);
      assert.equal(result.freshSetup, false);
      assert.equal(result.reused, true);
    }
  });
