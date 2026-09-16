import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, open, readdir, rename } from "node:fs/promises";
import path from "node:path";
import { withInstallationUpdateLock } from "./installation-lock.mjs";
import { plainDirectory } from "./stage-release.mjs";
import { readBounded } from "./prepare-release.mjs";
import { revalidateUpdatePlan } from "./update-plan.mjs";

const transitions = {
  Created: ["Validating", "Failed", "Abandoned"],
  Validating: ["Validated", "Failed", "Recovering", "Abandoned"],
  Failed: ["Recovering", "Abandoned"],
  Recovering: ["Validating", "Failed", "Recovering", "Abandoned"],
  Validated: [],
  Abandoned: [],
};
export const readValidationJournal = async (directory) => {
  await plainDirectory(directory);
  const names = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
  assert(names.length <= 100, "Transaction journal limit exceeded");
  const records = [];
  for (const name of names) {
    assert(/^\d{3}-[A-Za-z]+\.json$/u.test(name), "Unexpected journal record");
    const record = JSON.parse(await readBounded(path.join(directory, name)));
    assert.equal(
      name,
      `${String(records.length + 1).padStart(3, "0")}-${record.state}.json`,
      "Journal sequence mismatch",
    );
    assert(
      record.schemaVersion === 1 && record.activationAllowed === false,
      "Invalid transaction record",
    );
    if (records.length === 0) assert.equal(record.state, "Created");
    else {
      assert(
        transitions[records.at(-1).state]?.includes(record.state),
        "Invalid transaction transition",
      );
      assert.equal(record.planSha256, records[0].planSha256);
      assert.equal(record.planPath, records[0].planPath);
    }
    records.push(record);
  }
  return records;
};
/** Serializes and journals validation only. No app/service commit is implemented. */
export const runUpdateTransaction = async (
  options,
  { observe, checkpoint = async () => {} } = {},
) =>
  withInstallationUpdateLock(options.installationRoot, async ({ assertHeld }) => {
    const root = path.resolve(options.installationRoot),
      parent = path.join(root, "update/transactions");
    try {
      await mkdir(parent);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    await plainDirectory(parent);
    assert(/^[a-f0-9]{64}$/u.test(options.planSha256), "Plan pin required");
    const planPath = path.resolve(options.planPath);
    const candidate = options.transactionDirectory && path.resolve(options.transactionDirectory);
    assert(options.abandon !== true || candidate, "Abandon requires an existing transaction");
    if (candidate)
      assert(
        path.dirname(candidate) === parent && /^txn-[A-Za-z0-9]+$/u.test(path.basename(candidate)),
        "Transaction outside installation",
      );
    for (const name of await readdir(parent)) {
      assert(/^txn-[A-Za-z0-9]+$/u.test(name), "Unknown transaction entry");
      const existing = path.join(parent, name);
      const records = await readValidationJournal(existing);
      if (existing !== candidate)
        assert(
          ["Validated", "Abandoned"].includes(records.at(-1)?.state),
          "Interrupted transaction must be recovered first",
        );
    }
    const directory = candidate ?? (await mkdtemp(path.join(parent, "txn-")));
    const records = await readValidationJournal(directory);
    const append = async (state) => {
      assertHeld();
      assert(records.length < 100, "Transaction journal limit exceeded");
      const record = {
        schemaVersion: 1,
        state,
        activationAllowed: false,
        planPath,
        planSha256: options.planSha256,
      };
      const name = `${String(records.length + 1).padStart(3, "0")}-${state}.json`;
      const temporary = path.join(directory, `${name}.${randomUUID()}.partial`);
      const file = await open(temporary, "wx");
      try {
        await file.writeFile(JSON.stringify(record) + "\n");
        await file.sync();
      } finally {
        await file.close();
      }
      assertHeld();
      await rename(temporary, path.join(directory, name));
      records.push(record);
    };
    if (records.length) {
      assert.equal(records[0].planPath, planPath, "Recovery plan path mismatch");
      assert.equal(records[0].planSha256, options.planSha256, "Recovery plan pin mismatch");
      assert(
        !["Validated", "Abandoned"].includes(records.at(-1).state),
        "Transaction already validated",
      );
      if (options.abandon === true) {
        await append("Abandoned");
        return { state: "Abandoned", transactionDirectory: directory, activationAllowed: false };
      }
      // No mutating operation exists before validation; an interrupted Created is safe to revalidate directly.
      if (records.at(-1).state !== "Created") await append("Recovering");
    } else {
      await append("Created");
      if (options.abandon === true) {
        await append("Abandoned");
        return { state: "Abandoned", transactionDirectory: directory, activationAllowed: false };
      }
    }
    try {
      await checkpoint("created", directory);
      await append("Validating");
      await checkpoint("validating", directory);
      const result = await revalidateUpdatePlan(options, observe ? { observe } : undefined);
      await checkpoint("validated", directory);
      await append("Validated");
      return {
        ...result,
        transactionDirectory: directory,
        state: "Validated",
        activationAllowed: false,
      };
    } catch (error) {
      try {
        await append("Failed");
      } catch {
        /* The incomplete transaction remains recovery-required. */
      }
      throw new Error(`Update transaction stopped; recover ${directory}`, { cause: error });
    }
  });
