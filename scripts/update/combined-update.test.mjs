import { windowsTest } from "../test-support/windows-test.mjs";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { combinedUpdateIdentity, runCombinedUpdate } from "./combined-update.mjs";
import { sha256 } from "./release-manifest.mjs";
import { assertCombinedAdmission } from "../../packages/core/dist/combined-admission.js";

const fixture = async (states) => {
  const base = path.resolve("output/combined-coordinator-tests");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "case-"));
  const identity = {
    manifestSha256: "a".repeat(64),
    sourcePointerSha256: "b".repeat(64),
    serviceTransactionSha256: "c".repeat(64),
  };
  const id = combinedUpdateIdentity(identity);
  const directory = path.join(root, "update/combined", id);
  await mkdir(directory, { recursive: true });
  let previous = id;
  for (const [index, state] of states.entries()) {
    const bytes = JSON.stringify({
      schemaVersion: 1,
      identitySha256: id,
      previousSha256: previous,
      state,
    });
    await writeFile(path.join(directory, `${String(index + 1).padStart(2, "0")}.json`), bytes);
    previous = sha256(bytes);
  }
  const calls = [];
  const hooks = {};
  for (const name of [
    "admit",
    "prepareService",
    "selectApplication",
    "validateDoctor",
    "commitPair",
    "stopValidationDesktop",
    "restoreService",
    "restoreApplication",
    "validateSource",
    "restartSource",
    "verifyCommitted",
    "assertQuiescent",
    "restartTarget",
    "verifyRelease",
  ])
    hooks[name] = async () => {
      calls.push(name);
      return true;
    };
  hooks.startValidationDesktop = async () => ({
    ready: true,
    mode: "update-validation",
    validationId: id,
  });
  return { root, id, directory, calls, hooks, options: { installationRoot: root, identity } };
};
const selected = ["Prepared", "ServiceReady", "AppSelected"];

windowsTest(
  "startup before commit restores source instead of adopting a dead coordinator",
  async () => {
    const f = await fixture(selected);
    const result = await runCombinedUpdate({ ...f.options, recover: true }, f.hooks);
    assert.equal(result.state, "RolledBack");
    assert(!f.calls.includes("prepareService") && !f.calls.includes("commitPair"));
  },
);

windowsTest("interrupted commit may roll back only after native abort authorization", async () => {
  for (const allowed of [true, false]) {
    const f = await fixture([...selected, "DesktopReady", "Committing"]);
    f.hooks.validateDoctor = async () => false;
    let authorized = false;
    f.hooks.authorizeUncommittedRollback = async () => {
      authorized = allowed;
      return allowed;
    };
    f.hooks.restoreApplication = async () => {
      assert(authorized);
      f.calls.push("restoreApplication");
    };
    const operation = runCombinedUpdate({ ...f.options, recover: true }, f.hooks);
    if (allowed) {
      assert.equal((await operation).state, "RolledBack");
      await assertCombinedAdmission(f.root);
    } else {
      await assert.rejects(operation);
      assert(!f.calls.includes("restoreApplication"));
      await assert.rejects(assertCombinedAdmission(f.root));
    }
  }
});

windowsTest(
  "combined rollback restores app selection before native service and remains blocked until healthy",
  async () => {
    const f = await fixture(selected);
    let sourceSelected = false;
    f.hooks.validateDoctor = async () => false;
    f.hooks.restoreApplication = async () => {
      await assert.rejects(assertCombinedAdmission(f.root));
      sourceSelected = true;
    };
    f.hooks.restoreService = async () => {
      assert(sourceSelected, "native source selection precondition");
      await assert.rejects(assertCombinedAdmission(f.root));
    };
    f.hooks.restartSource = async () => assertCombinedAdmission(f.root);
    assert.equal((await runCombinedUpdate(f.options, f.hooks)).state, "RolledBack");
  },
);

windowsTest(
  "interrupted service rollback preserves pending state and can replay source selection",
  async () => {
    const f = await fixture([...selected, "RollingBack"]);
    f.hooks.restoreService = async () => {
      throw new Error("injected restore interruption");
    };
    await assert.rejects(runCombinedUpdate(f.options, f.hooks), /restore interruption/);
    await assert.rejects(assertCombinedAdmission(f.root));
    assert(!f.calls.includes("restartSource"));
    f.hooks.restoreService = async () => true;
    assert.equal((await runCombinedUpdate(f.options, f.hooks)).state, "RolledBack");
    assert.equal(f.calls.filter((name) => name === "restoreApplication").length, 2);
  },
);

windowsTest(
  "uncertain protected commit retries forward without rollback; failed restart retains commit",
  async () => {
    const f = await fixture([...selected, "DesktopReady", "Committing"]);
    f.hooks.commitPair = async () => {
      throw new Error("commit outcome unknown");
    };
    await assert.rejects(runCombinedUpdate(f.options, f.hooks), /outcome unknown/);
    assert(!f.calls.includes("restoreService"));
    await assert.rejects(assertCombinedAdmission(f.root));
    f.hooks.commitPair = async () => true;
    f.hooks.restartTarget = async () => {
      throw new Error("restart unavailable");
    };
    const result = await runCombinedUpdate(f.options, f.hooks);
    assert.equal(result.state, "Committed");
    assert.equal(result.restart, "Failed");
    await assertCombinedAdmission(f.root);
    assert((await readdir(f.directory)).includes("06.json"));
  },
);
